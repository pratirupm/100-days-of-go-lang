---
title: "Day 82 — Consumers and replay"
description: "Consume the topic in a group, rebuild the read model, and reset the group so the log replays without duplicating rows. — Day 82 of 100 Days of Go Lang."
sidebar:
  order: 82
chapter: 69
style: production
---

**About 3 hours** · Part XIV, day 4 of 6.

**You'll be able to:**

- consume the topic in a group and rebuild the read model;
- reset the group and replay the log without duplicating rows.

---

The producer writes events into the log. A **consumer** reads them. The log
does not delete a record when it is read; the consumer keeps an **offset**,
and the group keeps that offset so a restart can continue where it stopped.

That is the property that makes replay possible: the log is the history, and
the offset is the bookmark. Move the bookmark back and the consumer sees the
history again. The service must make that harmless.

Today the activity service consumes the topic in a group, and an event id
makes a repeated record a no-op.

## The consumer

The consumer is a Kafka reader with a group id:

<!-- verify: internal/events/consumer.go at=kafka-consumer -->
```go title="internal/events/consumer.go"
func NewConsumer(brokers []string, topic, group string) *Consumer {
	return &Consumer{reader: kafka.NewReader(kafka.ReaderConfig{
		Brokers:  brokers,
		Topic:    topic,
		GroupID:  group,
		MinBytes: 1,
		MaxBytes: 10e6,
	})}
}
```

`GroupID` is what lets two service instances share the partitions. Kafka
assigns each partition to one member of the group; if one member dies, the
group rebalances and another takes its partitions. Two groups with different
ids each get the whole topic, which is how a second read model would subscribe
without stealing the first one's work.

`Run` fetches one record at a time, decodes it, calls the handler, and commits
the offset only after the handler succeeds:

<!-- verify: internal/events/consumer.go at=kafka-consumer -->
```go title="internal/events/consumer.go"
func (c *Consumer) Run(ctx context.Context, handle func(Event) error) error {
	for {
		msg, err := c.reader.FetchMessage(ctx)
		if err != nil {
			return err
		}
		var e Event
		if err := json.Unmarshal(msg.Value, &e); err != nil {
			return fmt.Errorf("decode event at offset %d: %w", msg.Offset, err)
		}
		if err := handle(e); err != nil {
			return err
		}
		if err := c.reader.CommitMessages(ctx, msg); err != nil {
			return fmt.Errorf("commit offset %d: %w", msg.Offset, err)
		}
	}
}
```

The order is deliberate. If the process crashes after the handler but before
the commit, the record is delivered again on restart. That is
**at-least-once**. If the commit came first, a crash would lose the record;
that is at-most-once, and it is the wrong default for a task feed.

At-least-once means the handler must be idempotent. The activity store keys
events by their id:

<!-- verify: internal/activity/activity.go at=kafka-consumer -->
```go title="internal/activity/activity.go"
// Add appends an event unless its id has already been seen. It reports
// whether the event was new, which is what makes a replayed record harmless.
func (s *Store) Add(e Event) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen[e.ID] {
		return false
	}
	s.seen[e.ID] = true
	s.events = append(s.events, e)
	return true
}
```

The `seen` map is the idempotency key. A replayed event returns false and the
feed does not grow. A real store would use a database uniqueness constraint or
a Redis set; the map is the same idea in memory.

## Start the service with the topic

The activity service takes the brokers, topic, and group:

```bash
$ go run ./cmd/todo-activity -listen 127.0.0.1:18089 -grpc 127.0.0.1:19091 -kafka 127.0.0.1:19092
2026/10/31 15:16:39 INFO activity gRPC listening addr=127.0.0.1:19091
2026/10/31 15:16:39 INFO activity listening addr=127.0.0.1:18089
```

Publish the same event twice:

```bash
$ go run ./cmd/todo-event -brokers 127.0.0.1:19092 -topic todo.events -id evt-k3 -task t-k3 -kind created -title "consume the event"
published evt-k3 to todo.events
$ go run ./cmd/todo-event -brokers 127.0.0.1:19092 -topic todo.events -id evt-k3 -task t-k3 -kind created -title "consume the event"
published evt-k3 to todo.events
```

Read the feed:

```bash
$ curl -sS http://127.0.0.1:18089/activity
[{"id":"evt-k3","task_id":"t-k3","kind":"created","title":"consume the event","at":"2026-10-31T09:46:41.581348685Z"},{"id":"evt-k2","task_id":"t-k2","kind":"created","title":"publish the event","at":"2026-10-31T09:45:44.747498153Z"}]
```

`evt-k3` appears once. The second publish was consumed; the store refused it
because the id was already seen. `evt-k2` was published before the service
started and was replayed from offset zero.

## Replay

Stop the service and reset the group to the beginning:

```bash
$ podman exec todo-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server todo-kafka:9092 --group activity --topic todo.events --reset-offsets --to-earliest --execute
GROUP                          TOPIC                          PARTITION  NEW-OFFSET
activity                       todo.events                    0          0
```

The group must have no active members; Kafka refuses to move an offset a
running consumer is using. Describe it:

```bash
$ podman exec todo-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server todo-kafka:9092 --group activity --describe

Consumer group 'activity' has no active members.

GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG             CONSUMER-ID     HOST            CLIENT-ID
activity        todo.events     0          0               3               3               -               -               -
```

`CURRENT-OFFSET 0` and `LOG-END-OFFSET 3` mean the next read starts at the
beginning and three records are waiting. Start the service again and it
replays them. Because the store is in memory, it starts empty; the replay
rebuilds the feed. In a persistent store, the `seen` check would suppress the
duplicates.

That is the recovery shape: the log is the source of truth, the read model is
a projection, and a rebuild is a reset plus a replay. It is also how a new
read model is added without touching the writer.

## Rebalances

A consumer group rebalances when a member joins, leaves, or is considered
dead. During the rebalance, partitions move and some consumers stop fetching.
A handler that takes longer than the session timeout can be evicted mid-record;
the record is redelivered to another member, and the idempotency key makes the
repeat safe.

The timeout is a trade: a short one detects a dead consumer quickly and
rebalances a slow one too often; a long one tolerates a slow handler and
delays recovery. The handler should be fast, or the work should be handed to a
queue with its own acknowledgment.

The consumer commits after the handler, so a crash between the two is a
redelivery. That is the at-least-once contract. A handler that writes to a
database should make the write and the offset commit in one transaction if it
can; if it cannot, the idempotency key is the fallback.

## If something went wrong

- **The consumer starts at the end** — the group has a committed offset. Use
  `--reset-offsets --to-earliest` while the group is inactive.
- **`Group coordinator not available`** — the broker is still starting or the
  group metadata is not ready. Wait and retry.
- **`CommitFailedError`** — the group rebalanced while the handler was
  running. The record will be redelivered; the idempotency check makes that
  safe.
- **A malformed record stops the consumer** — the decoder returns an error
  and the offset is not committed, so the same record blocks progress. Send
  malformed records to a dead-letter topic or skip them with a logged
  decision; do not commit silently.

<details>
<summary>Going deeper: exactly once is a transaction, not a setting</summary>

Kafka can do exactly-once between Kafka topics with transactions, but the
activity service writes to its own store. A transaction across Kafka and
PostgreSQL is a distributed transaction, and the usual answer is the
**outbox**: write the event to a table in the same database transaction as the
task, then a relay publishes it. The consumer is still idempotent, because a
relay can publish twice.

The book's stack is at-least-once with idempotent consumers. That is simpler
and honest. "Exactly once" in a distributed system is a property of the whole
path, not a flag on the producer.

</details>

The feed can rebuild from the log now. Next we put a cache in front of the
read and make the repeat cheaper.

<div class="day-tracker" data-day="82"></div>
