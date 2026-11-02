---
title: "Day 81 — Events on a log"
description: "Publish task changes to a Kafka topic with a stable key, then read the message back and explain the order the log guarantees. — Day 81 of 100 Days of Go Lang."
sidebar:
  order: 81
chapter: 68
style: production
---

**About 3 hours** · Part XIV, day 3 of 6.

**You'll be able to:**

- publish task changes to a Kafka topic with a stable key;
- read the offsets and explain what order the topic guarantees.

---

The activity service accepts events over POST. That works until the feed needs
every change, including the ones that happen while the service is down. A
queue decouples the writer from the reader: the producer appends an event and
moves on; the service reads at its own pace.

**Kafka** is a distributed log. A **topic** is an append-only sequence of
records, split into **partitions**. A record has a key, a value, and an
offset. The key decides the partition, and a partition keeps its records in
order. That is the whole ordering guarantee: order within a partition, not
across the topic.

Today we publish task events to a topic and read one back. The producer is a
small command, not yet a hook in the API's task handlers; the outbox lesson
names the step that connects them.

## The event

The event is the same shape the service already uses: id, task, kind, title,
time. The producer and consumer share the JSON contract:

<!-- verify: internal/events/events.go at=kafka-producer -->
```go title="internal/events/events.go"
type Event struct {
	ID     string    `json:"id"`
	TaskID string    `json:"task_id"`
	Kind   string    `json:"kind"`
	Title  string    `json:"title"`
	At     time.Time `json:"at"`
}
```

The field names are the contract. A consumer in another language reads the
same JSON; it does not import the Go struct. Changing a name is a compatibility
decision, not a refactor.

## The producer

The writer is one Kafka writer per topic:

<!-- verify: internal/events/events.go at=kafka-producer -->
```go title="internal/events/events.go"
func NewProducer(brokers []string, topic string) *Producer {
	return &Producer{writer: &kafka.Writer{
		Addr:                   kafka.TCP(brokers...),
		Topic:                  topic,
		Balancer:               &kafka.Hash{},
		AllowAutoTopicCreation: true,
		RequiredAcks:           kafka.RequireAll,
	}}
}
```

`Hash` hashes the message key to a partition. The task id is the key, so every
change to one task lands on the same partition and keeps its relative order.
A random balancer would spread the same task's events across partitions and
lose that order.

`RequireAll` waits for every in-sync replica before acknowledging. It is slower
than `RequireOne` and safer on a replicated topic. In this single-broker lab
the in-sync set is just the leader, so the setting is a rehearsal for a
replicated deployment, not a second copy on this machine.

`AllowAutoTopicCreation` is convenient in development and dangerous in
production: a typo in the topic name creates a new topic instead of failing.
The production producer should leave it off and create the topic explicitly.

Publishing marshals the event and writes it with the task id as the key:

<!-- verify: internal/events/events.go at=kafka-producer -->
```go title="internal/events/events.go"
func (p *Producer) Publish(ctx context.Context, e Event) error {
	body, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("publish event: %w", err)
	}
	if err := p.writer.WriteMessages(ctx, kafka.Message{Key: []byte(e.TaskID), Value: body}); err != nil {
		return fmt.Errorf("publish event: %w", err)
	}
	return nil
}
```

The context is the caller's deadline. A publish that cannot reach the broker
returns an error; the caller decides whether to retry or fail the request.

The same producer is wired into the API behind `TODO_KAFKA_BROKERS`: the task
handlers publish `created`, `updated`, `completed`, and `deleted` after a
successful store write. A publish failure is logged, not returned, because the
task is already committed; the outbox is the next step for making the pair
atomic. The CLI below stays useful as a manual publisher and a diagnostic.

The event is not transactional with the task write yet; the next lesson adds
the consumer, and the one after that makes the pair safe.

## The topic

A topic has a name and a partition count. Create it once:

```bash
$ podman exec todo-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server todo-kafka:9092 --list
__consumer_offsets
todo.events
```

`__consumer_offsets` is Kafka's own bookkeeping topic; `todo.events` is ours.
The lab topic has one partition. A partition is the unit of parallelism: a
consumer group can have at most one consumer per partition, so a topic with
three partitions would allow three readers. One partition is enough for the
single consumer here.

The broker is a container with two listeners: one for clients on the host, one
for clients inside the Docker network. The host publishes on `19092`; the
container uses `todo-kafka:9092`. That is why the producer's broker flag and
the console consumer's bootstrap server differ.

## Publish

Publish one event:

```bash
$ go run ./cmd/todo-event -brokers 127.0.0.1:19092 -topic todo.events -id evt-k2 -task t-k2 -kind created -title "publish the event"
published evt-k2 to todo.events
```

Read it back from the beginning:

```bash
$ podman exec todo-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server todo-kafka:9092 --topic todo.events --from-beginning --max-messages 1 --timeout-ms 10000
{"id":"evt-k2","task_id":"t-k2","kind":"created","title":"publish the event","at":"2026-10-31T09:45:44.747498153Z"}
Processed a total of 1 messages
```

The console consumer is a diagnostic tool, not the service. It reads the same
topic the service will read, with its own group id. `--from-beginning` starts at
offset zero; without it, a new group starts at the end.

## What the log guarantees

The log keeps every record until its retention policy removes it. A consumer
can start at the beginning, at the end, or at a committed offset. Reading does
not remove the record; many consumers can read the same topic independently.

Order is per partition. Two events for the same task share a key, so they share
a partition and keep their order. Two events for different tasks may be on
different partitions and may be observed in either order. A consumer that
needs a global order must use one partition, or carry a sequence number and
sort.

Delivery is at-least-once by default: a consumer may see a record twice after a
rebalance or a crash. The consumer's job is to make a repeated event harmless —
the idempotency lesson.

## The idempotent producer

Kafka's producer has an idempotence mode: it attaches a producer id and a
sequence number, and the broker rejects a retried batch that it has already
written. That closes the duplicate-write window inside one producer session.
It does not make the application's side effects idempotent, and it does not
survive a new producer id after a restart.

The setting is worth turning on for any producer that retries. It is not a
substitute for the consumer's idempotency key, because the consumer sees the
record after the broker, and a consumer restart can replay a record the
producer wrote once. The two mechanisms cover different halves of the path.

The other producer setting is `RequiredAcks`. `RequireAll` waits for the
in-sync replicas; `RequireOne` waits for the leader. The first survives a
leader failure without losing the record; the second is faster and can lose
the last write. For a task event, the first is the right default.

## If something went wrong

- **`Unknown Topic Or Partition`** — the topic does not exist or the broker
  metadata is stale. Create it explicitly and retry; auto-creation is not
  guaranteed by every broker configuration.
- **`Connection to node ... could not be established`** — the advertised
  listener points at a host the client cannot reach. Inside a container, the
  advertised name must resolve from that container.
- **`context deadline exceeded`** — the broker is down or the write waited for
  an in-sync replica that never arrived. Check the broker logs and the
  replication factor.
- **The console consumer sees nothing** — it started at the end. Use
  `--from-beginning`, or check the group's committed offset.

<details>
<summary>Going deeper: why the key is the task id</summary>

Kafka's ordering is a partition property. The producer's balancer decides the
partition; `Hash` uses the key. A key of task id means all events for one task
are ordered relative to each other. A key of event id would spread them, and a
consumer could see "completed" before "created."

The cost is a hot partition: one very busy task sends all its events to one
partition. For a todo app, that is unlikely. For a global counter, it is a
design problem; the fix is a compound key or a different partitioning scheme.
The ordering requirement and the load distribution pull against each other,
and the key is where the choice is written.

</details>

The producer writes events now. Next a consumer group reads them into the
activity service, and replay becomes a command rather than a restore.

<div class="day-tracker" data-day="81"></div>
