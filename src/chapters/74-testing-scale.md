---
title: Testing the system
day: 88
time: "3 hours"
description: Pin the read-model contract, run it under the race detector, and name the failure drills a release needs.
sidebar:
  order: 74
---

The store has a conformance suite. The activity service has a different
contract: the shape of an event, the order of the feed, and the rule that a
replayed id does not create a second row. Those are the tests that catch a
boundary change before a consumer does.

A **contract test** names the promise at an edge. It is not a test of the
implementation; it is a test of what the other side is allowed to assume. When
the promise changes, the test changes, and the change is visible.

Today we pin the activity contract and run it under the race detector.

## The tests

The first test pins order and the limit:

<!-- verify: internal/activity/activity_test.go at=testing-scale -->
```go title="internal/activity/activity_test.go"
func TestListNewestFirstAndLimit(t *testing.T) {
	s := activity.NewStore()
	base := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	for i, id := range []string{"a", "b", "c"} {
		require.True(t, s.Add(activity.Event{ID: id, TaskID: "t", Kind: "created", At: base.Add(time.Duration(i) * time.Minute)}))
	}
	got := s.List(2)
	require.Len(t, got, 2)
	require.Equal(t, "c", got[0].ID)
	require.Equal(t, "b", got[1].ID)
}
```

The second pins idempotency:

<!-- verify: internal/activity/activity_test.go at=testing-scale -->
```go title="internal/activity/activity_test.go"
func TestAddDeduplicatesByID(t *testing.T) {
	s := activity.NewStore()
	e := activity.Event{ID: "same", TaskID: "t", Kind: "created"}
	require.True(t, s.Add(e))
	require.False(t, s.Add(e), "a replayed event is not new")
	require.Len(t, s.List(0), 1)
}
```

The third pins the JSON shape:

<!-- verify: internal/activity/activity_test.go at=testing-scale -->
```go title="internal/activity/activity_test.go"
func TestJSONContract(t *testing.T) {
	e := activity.Event{ID: "evt-1", TaskID: "t-1", Kind: "completed", Title: "ship", At: time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)}
	body, err := json.Marshal(e)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"evt-1","task_id":"t-1","kind":"completed","title":"ship","at":"2026-10-31T12:00:00Z"}`, string(body))
}
```

The JSON test is the one a consumer in another language relies on. It is not
testing that Go can marshal a struct; it is testing that the field names and
the time format are what the contract says.

## Run under the race detector

```bash
$ go test -race -count=1 -v ./internal/activity
=== RUN   TestListNewestFirstAndLimit
--- PASS: TestListNewestFirstAndLimit (0.00s)
=== RUN   TestAddDeduplicatesByID
--- PASS: TestAddDeduplicatesByID (0.00s)
=== RUN   TestJSONContract
--- PASS: TestJSONContract (0.00s)
PASS
ok  	todo/internal/activity	1.013s
```

The race detector is not a proof of correctness. It finds races the test
actually exercises. A concurrent `Add` and `List` under `-race` is a better
test than the sequential ones above, and the store's mutex is what it would
check. The suite is the start; the detector is the second opinion.

## The layers

A distributed system needs tests at three layers:

1. **Unit** — the store's dedupe, the retry policy's stop conditions, the
   event's JSON. Fast, deterministic, run on every change.
2. **Contract** — the gRPC messages, the HTTP payloads, the database
   conformance suite. They catch a boundary change that a unit test inside one
   side cannot see.
3. **System** — a real broker, a real database, a real service, a load test,
   a failure drill. Slow, environment-dependent, run before a release.

The book has all three. The unit and contract tests run with `go test`; the
PostgreSQL suite runs when `TODO_POSTGRES_DSN` is set; the load driver runs
against a seeded database; the Kafka drill runs against the container.

## Failure drills

A test asserts a known outcome. A **drill** asks what happens when a dependency
disappears:

- Stop Kafka while the consumer is running. Does the service stay up? Does it
  reconnect? Does the feed show a gap?
- Stop Redis. Does the feed fall back to the store, or return 500?
- Stop PostgreSQL while the server uses the DSN. Does `/ready` fail?
- Kill the service mid-batch. Does it redeliver, and does the idempotency check
  hold?

The drill is not a unit test because the failure is in the environment, not
the code. It is the only way to know whether the retry policy, the readiness
probe, and the dead-letter path work together.

## Test data is part of the test

A contract test with three hand-written rows proves the shape, not the scale.
The conformance suite seeds through the store; the load test seeds ten
thousand rows; the failure drill uses the real broker. Each layer needs data
that looks like the layer below it.

The dangerous test data is the fixture that is too clean. A task with no labels,
a user with no sessions, an event with a zero time — those are the edge cases
the production data will contain. The suite should include them on purpose,
not wait for a customer to find them.

The other rule is isolation. A test that writes to a shared database leaves a
row for the next test; a test that reads a shared topic consumes a record
another test expected. Each suite owns its database, topic, or namespace, and
cleans it up. The cleanup is part of the test.

## The fast layers run first

The unit and contract tests run in seconds; the PostgreSQL suite needs a
database; the Kafka drill needs a broker; the load test needs a seeded table.
The order is the feedback loop: fast tests on every save, slow tests before a
merge, the full drill before a release.

A slow test that runs on every save gets skipped. A fast test that catches a
real boundary break earns its place. The suite is designed around that budget,
not around the ideal coverage number.

## Flaky tests are a bug

A test that fails once in twenty runs is not a nuisance; it is a signal that
the test depends on timing, order, or a shared resource. The fix is to remove
the dependency, not to retry the test until it passes.

The common causes are a sleep that is too short, a port that is already in use,
a database row left by another test, and a goroutine that outlives the test.
The race detector finds some of them; the rest need isolation and deterministic
time. A flaky suite trains the team to ignore red, which is the opposite of
what a check is for.

## If something went wrong

- **The race detector reports a race** — the test found real concurrency. Fix
  the lock, not the test.
- **The contract test fails after a field rename** — that is the test doing
  its job. Update the consumer and the contract together, or keep the old
  field.
- **The system test passes locally and fails in CI** — the environment is part
  of the test. Pin the broker and database versions, and give the test a
  timeout.
- **A drill finds a hang** — the deadline is missing. Every network call
  needs a context with a timeout; a hang is worse than an error.

<details>
<summary>Going deeper: tests are a budget</summary>

Every test has a cost: the time to run, the environment to maintain, and the
false failures to triage. A slow system test that fails once a week gets
ignored; a fast contract test that fails on a real change gets fixed.

The budget is spent where the risk is. The store's conformance suite is worth
its cost because a swap is a production decision. The JSON contract is cheap
and catches a breaking change. The full failure drill is expensive and runs
before a release, not on every push.

</details>

The system is tested at its edges. The last lesson is the threat model those
edges create.
