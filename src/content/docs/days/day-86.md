---
title: "Day 86 — Retries, idempotency, ordering"
description: "Make every write safe to retry and every event safe to replay, then explain what exactly-once really costs. — Day 86 of 100 Days of Go Lang."
sidebar:
  order: 86
chapter: 72
style: production
---

**About 3 hours** · Part XV, day 1 of 4.

**You'll be able to:**

- make every write safe to retry and every event safe to replay;
- explain what “exactly once” really costs.

---

A network call can fail after the other side did the work. The client sees an
error; the server committed the row. Retrying is the only way to make progress,
and retrying is exactly what turns one write into two unless the operation is
**idempotent**.

Distributed systems are mostly this problem in different clothes: a timeout
that is not a failure, a message that arrives twice, an event that overtakes
another. The tools are retries with a policy, idempotency keys, and an
ordering guarantee that is stated instead of assumed.

Today we add the retry policy the services share and write down what it
promises.

## The policy

A retry needs a limit, a delay, and a way to stop. The package makes all three
explicit:

<!-- verify: internal/retry/retry.go at=distributed -->
```go title="internal/retry/retry.go"
func Do(ctx context.Context, attempts int, base, maxDelay time.Duration, fn func(context.Context) error) error {
	if attempts < 1 {
		return errors.New("retry: attempts must be at least 1")
	}
	var last error
	delay := base
	for i := 0; i < attempts; i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := fn(ctx)
		if err == nil {
			return nil
		}
		var permanent *permanentError
		if errors.As(err, &permanent) {
			return permanent.err
		}
		last = err
		if i == attempts-1 {
			break
		}
		if delay > maxDelay {
			delay = maxDelay
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
	}
	return fmt.Errorf("retry: %d attempts: %w", attempts, last)
}
```

The delay doubles from `base`, capped at `maxDelay`. The context wins over the
sleep: a canceled request stops before the next attempt. `Permanent` wraps an
error that must not be retried — a validation failure, a 404, a duplicate key
that means the write already happened.

The cap matters. Without it, a long outage turns into a retry storm that
arrives when the service recovers. With it, the retries are bounded and the
caller gets an error it can surface.

## What is safe to retry

A read is safe. A write is safe only if repeating it has the same effect as
doing it once:

- `INSERT ... ON CONFLICT DO NOTHING` is idempotent.
- A compare-and-swap update is idempotent when the caller re-reads after a
  conflict; the second write with the same version fails, which is a signal,
  not a duplicate.
- `INSERT` without a uniqueness constraint is not idempotent. Two retries make
  two rows.

The activity service's store keys events by id, so a duplicate event is
dropped. The task store's `Add` generates a fresh id on each call, so `Add`
itself is not idempotent; the caller must not retry it blindly. A retry of
`Add` after a timeout can create two tasks. The fix is an idempotency key from
the client: the API's write path would accept a key, store it with the task,
and return the first result for a repeated request.

## Ordering

Kafka orders records within a partition. The producer keys by task id, so one
task's events are ordered. Two tasks can be processed in either order, which
is fine for a feed.

A consumer that needs a global order has three options: one partition (no
parallelism), a sequence number and a reorder buffer, or a database that
enforces the order the query needs. The cheapest is usually to avoid needing
global order.

The activity feed is a projection. If an event arrives late, the feed shows it
late; the state is still eventually correct. A bank balance is not a
projection; it needs a stronger rule.

## Exactly once

Kafka can produce exactly-once between Kafka topics with transactions. The
activity service writes to its own store, so a transaction across Kafka and
the store is a distributed transaction.

The usual answer is the **outbox**:

1. In the same database transaction as the task write, insert an event row
   into an `outbox` table.
2. A relay reads unsent rows and publishes them to Kafka.
3. The relay marks the row sent; a crash can publish it twice.
4. The consumer is idempotent, so a duplicate is harmless.

That is at-least-once with idempotency, and it is what most systems mean by
"exactly once" in practice. The alternative — a two-phase commit across the
database and the broker — is slower, less available, and rarely worth it.

The book's stack stops at step 2 for now: the producer publishes, the consumer
deduplicates. The outbox is the next step when the task write and the event
must be atomic.

## The tests

The policy has three tests: a transient failure that succeeds on the third
try, a permanent error that stops immediately, and a canceled context that
stops before the second attempt.

```bash
$ go test -count=1 -v ./internal/retry
=== RUN   TestDoSucceedsAfterTransientFailures
--- PASS: TestDoSucceedsAfterTransientFailures (0.00s)
=== RUN   TestDoStopsOnPermanent
--- PASS: TestDoStopsOnPermanent (0.00s)
=== RUN   TestDoStopsWhenContextEnds
--- PASS: TestDoStopsWhenContextEnds (0.00s)
PASS
ok  	todo/internal/retry	0.005s
```

The tests use millisecond delays, so they are fast and deterministic. A test
that sleeps for the real backoff is a test that will be flaky on a busy
machine.

## The outbox table

The outbox is a table in the same database as the task. The task write and
the event insert share one transaction; either both commit or neither does. A
relay reads unsent rows, publishes them, and marks them sent.

The relay can crash after publishing and before marking, so the event is
published twice. The consumer's idempotency key makes the duplicate harmless.
The relay can also crash before publishing; the row is still unsent, and the
next pass picks it up. That is the at-least-once guarantee, made explicit.

The table needs an index on the unsent rows and a retention policy. A relay
that scans the whole table on every pass is a load test waiting to happen. A
row that is marked sent can be deleted after a window, or kept as an audit
trail with its own retention.

## If something went wrong

- **A retry created a duplicate** — the operation is not idempotent. Add a
  uniqueness constraint or an idempotency key; do not lower the retry count.
- **The retry storm made the outage worse** — add jitter and a circuit
  breaker. The cap bounds one caller, not the fleet.
- **A permanent error was retried** — wrap it with `retry.Permanent` at the
  point where the cause is known, not at the call site.
- **Events arrive out of order** — check the producer key and the partition
  count. Ordering is per partition; a random key gives no order.

<details>
<summary>Going deeper: the timeout is the hard part</summary>

A timeout tells the client that it did not receive an answer. It does not tell
the client whether the server did the work. That ambiguity is why an
idempotency key is better than a longer timeout: the key lets the server
recognize the repeat, regardless of which side timed out.

A retry with the same key is safe; a retry with a new key is a new request.
Generate the key at the edge, before the first attempt, and carry it through
every retry. Do not generate it inside the retry loop.

</details>

The policy is explicit now. Next we make the system observable enough to see
a retry, a duplicate, and a stalled consumer without reading three logs.

<div class="day-tracker" data-day="86"></div>
