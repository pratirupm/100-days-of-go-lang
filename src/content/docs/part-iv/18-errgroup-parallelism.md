---
title: Running work in parallel
description: Run a job over every task with a fixed crew of helpers — stop at the first error, and stop when the caller cancels.
sidebar:
  order: 18
---

The store can add, complete, list, count, and summarize tasks — one task at a time. What it can't do is *act on many tasks at once*. Soon the app will work through batches: a file of tasks arriving one by one, each needing the same treatment. That work wants a fixed crew, not a thousand helpers.

The tempting answer is one helper per task: a thousand tasks, a thousand goroutines. That's a trap. Thousands of live goroutines cost memory, and the machine spends more time switching between them than working. The calm version has a name — **bounded parallelism** — which in everyday words means a fixed number of helpers, not one per task.

Think of a kitchen. You don't hire one cook per dish; you keep a crew of four and hand each cook the next dish as they finish the last. The work still gets done side by side, and the crew never grows past four. That is what we'll build: `Process`, which applies a job to every task in the store with at most a set number of jobs running at once.

The first failure — a job that returns an error, or a caller who cancels — stops new work from being handed out and comes back as the answer. The engine underneath is a small library named `errgroup`, and it will be the first dependency the app's real code adds beyond Go's own standard library.

## A fixed crew and a pile of work

The whole contract is one function:

```go
func Process(ctx context.Context, s Store, limit int, fn func(task.Task) error) error
```

Read it as four choices and one answer. `ctx` is the caller's context — the same first parameter every store method takes, so a canceled batch can stop. `s` is the store to read the tasks from. `limit` is the crew size: at most that many jobs run at once. `fn` is the job itself, a function that takes one task and returns an error, so the caller decides what "do this task" means. The answer is the first error, wrapped so `errors.Is` finds the original.

`Process` keeps four promises:

- every task is handed to `fn` exactly once, unless the batch stops early;
- no more than `limit` calls are running at any moment;
- the first error — from `fn` or from `ctx` — stops new work and is returned wrapped with the name `process tasks`;
- `limit < 1` is not an error and not "no limit": it means `GOMAXPROCS`, the number of CPUs Go is set up to use.

Cancellation stops new work from being handed out; it does not interrupt a call that is already running. A job that should give up early can watch the same context the caller passed in — that's a decision for the job, not for `Process`.

The tests come first, as always. Five of them, one for each promise.

## Write the tests first

Create `internal/store/batch_test.go`. It opens with the package, its imports, and a helper that seeds a store with numbered tasks:

<!-- verify: internal/store/batch_test.go at=parallel-stats -->
```go title="internal/store/batch_test.go"
package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)

// batchTasks returns n untitled tasks, for seeding a store for Process tests.
func batchTasks(n int) []task.Task {
	tasks := make([]task.Task, n)
	for i := range tasks {
		tasks[i] = task.Task{Title: fmt.Sprintf("task %02d", i+1)}
	}
	return tasks
}
```

The imports are the tools the rest of the suite uses, plus `errors`, `slices`, and `sync/atomic`. `batchTasks` builds tasks titled `task 01`, `task 02`, and so on, so a test can talk about "task 1" and know the id it means.

The first test pins the main promise: every task is visited exactly once.

<!-- verify: internal/store/batch_test.go at=parallel-stats -->
```go title="internal/store/batch_test.go"
func TestProcess_VisitsEveryTaskOnce(t *testing.T) {
	t.Parallel()

	const (
		tasks = 20
		limit = 4
	)
	s := mustStore(t, batchTasks(tasks)...)

	var (
		mu      sync.Mutex
		visited []int
	)
	err := Process(context.Background(), s, limit, func(t task.Task) error {
		mu.Lock()
		defer mu.Unlock()
		visited = append(visited, t.ID)
		return nil
	})
	require.NoError(t, err)

	slices.Sort(visited)
	want := make([]int, tasks)
	for i := range want {
		want[i] = i + 1
	}
	assert.Equal(t, want, visited, "every task visited exactly once")
}
```

`fn` runs from several helpers at once, so the `visited` slice is shared state: the mutex makes each append safe. The test sorts before comparing, because which helper visits which task is the scheduler's business — the set of visited tasks is the contract.

Proving the limit needs care. A test that sleeps and hopes fails on a busy machine, so this one uses signals instead.

<!-- verify: internal/store/batch_test.go at=parallel-stats -->
```go title="internal/store/batch_test.go"
	// The buffer holds every start signal, so fn never blocks sending one;
	// the gate the limit has to hold is on the release side.
	started := make(chan struct{}, tasks)
	release := make(chan struct{})

	// Process blocks until every in-flight fn has returned, so it runs in a
	// goroutine of its own and the test drives it through the gates.
	done := make(chan error, 1)
	go func() {
		done <- Process(context.Background(), s, limit, func(task.Task) error {
			started <- struct{}{}
			<-release
			return nil
		})
	}()

	for range limit {
		<-started
	}
	select {
	case <-started:
		t.Fatal("more than limit calls started before any release")
	default:
	}
```

Every call announces itself on `started` and then parks on `release`, so nothing moves until the test allows it. With `limit` at 2 and two calls parked, a third call cannot start — `Process` is blocked waiting for a free slot. The `select` checks for a third start without waiting: if one had happened, its signal would already be sitting in the buffered channel. Then the release opens the way for everyone:

<!-- verify: internal/store/batch_test.go at=parallel-stats -->
```go title="internal/store/batch_test.go"
	close(release)
	require.NoError(t, <-done)

	// The remaining tasks ran once the release unblocked the parked calls,
	// and every send happened before Process returned, so draining the
	// buffer now is deterministic.
	assert.Len(t, started, tasks-limit, "every held-back call ran after the release")
```

The parked calls finish, the remaining tasks run, and the final count is exact: every signal was sent before `Process` returned, so the test can drain the channel and know the number.

## The first error, and the door

The next test pins fail-fast: the first error stops the batch, and no further task runs.

<!-- verify: internal/store/batch_test.go at=parallel-stats -->
```go title="internal/store/batch_test.go"
func TestProcess_FirstErrorStopsScheduling(t *testing.T) {
	t.Parallel()

	errBoom := errors.New("boom")
	s := mustStore(t, batchTasks(3)...)

	var (
		mu    sync.Mutex
		calls []int
	)
	err := Process(context.Background(), s, 1, func(t task.Task) error {
		mu.Lock()
		calls = append(calls, t.ID)
		mu.Unlock()
		if t.ID == 1 {
			return errBoom
		}
		return nil
	})

	require.ErrorIs(t, err, errBoom)
	assert.Equal(t, []int{1}, calls, "the first error stops the next call")
}
```

`limit` is 1, so the batch is a line, not a crowd: the next call cannot start before the previous one has returned. Task 1 returns `errBoom`, the group cancels itself, and the check in front of the next call turns task 2 away. The test asserts both halves — the error comes back and `errors.Is` still finds `errBoom` inside it, and only task 1 ran.

An error is not the only way to stop. A caller who cancels should stop the batch too, and a context that is already done should stop it before any work at all.

<!-- verify: internal/store/batch_test.go at=parallel-stats -->
```go title="internal/store/batch_test.go"
func TestProcess_PreCanceledContextRunsNothing(t *testing.T) {
	t.Parallel()

	s := mustStore(t, batchTasks(3)...)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	var calls atomic.Int64
	err := Process(ctx, s, 2, func(task.Task) error {
		calls.Add(1)
		return nil
	})

	require.ErrorIs(t, err, context.Canceled)
	assert.Zero(t, calls.Load(), "a done context stops the batch before any call")
}
```

The check sits before `List`, so a canceled batch never touches the store, and `fn` is never called.

Last, the default. A `limit` below 1 means "use the machine's setting" — not an error, and not "unlimited".

<!-- verify: internal/store/batch_test.go at=parallel-stats -->
```go title="internal/store/batch_test.go"
func TestProcess_NonPositiveLimitUsesGOMAXPROCS(t *testing.T) {
	t.Parallel()

	for _, limit := range []int{0, -1} {
		t.Run(fmt.Sprintf("limit=%d", limit), func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, batchTasks(5)...)

			var (
				mu      sync.Mutex
				visited map[int]bool
			)
			visited = make(map[int]bool)
			err := Process(context.Background(), s, limit, func(t task.Task) error {
				mu.Lock()
				defer mu.Unlock()
				visited[t.ID] = true
				return nil
			})
			require.NoError(t, err)
			assert.Len(t, visited, 5, "every task ran under the default limit")
		})
	}
}
```

The test is a table over 0 and -1, and both subtests assert only that all five tasks ran. How many calls overlapped depends on the machine's `GOMAXPROCS`, and the test refuses to pin that; the limit test above is where the bound is proven.

## Watch them fail

Run the suite:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/store [todo/internal/store.test]
internal/store/batch_test.go:47:9: undefined: Process
internal/store/batch_test.go:90:11: undefined: Process
internal/store/batch_test.go:132:9: undefined: Process
internal/store/batch_test.go:160:9: undefined: Process
internal/store/batch_test.go:188:11: undefined: Process
ok  	todo/cmd/todo	0.003s
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	0.003s
FAIL
```

Five complaints, one per test: every one says `undefined: Process`, because the function the tests call does not exist yet. The store's test binary cannot build; the other packages compile and pass.

:::tip
Your line numbers will differ from the transcript — the file you typed has its own comments and spacing. The error text is the part that matters.
:::

## Make it pass

Now the code. Create `internal/store/batch.go`, starting with the package and its imports:

<!-- verify: internal/store/batch.go at=parallel-stats -->
```go title="internal/store/batch.go"
package store

import (
	"context"
	"fmt"
	"runtime"

	"golang.org/x/sync/errgroup"

	"todo/internal/task"
)
```

The last import is the new one: `errgroup` — the library the batch rides on, and the first import in the app's real code that is not part of Go's standard library or the project itself.

`Process` starts like every store method: check the context first, so a done context stops before any work happens. Then it turns a small limit into the machine's default and takes one snapshot of the task list.

<!-- verify: internal/store/batch.go at=parallel-stats -->
```go title="internal/store/batch.go"
// Process applies fn to every task in the store, running at most limit
// functions concurrently. The first error — from fn or from ctx — stops new
// work from being scheduled and is returned wrapped so errors.Is finds it.
// limit < 1 means GOMAXPROCS.
//
// ...
func Process(ctx context.Context, s Store, limit int, fn func(task.Task) error) error {
	if err := ctxErr(ctx, "process tasks"); err != nil {
		return err
	}
	if limit < 1 {
		limit = runtime.GOMAXPROCS(0)
	}

	tasks, err := s.List(ctx)
	if err != nil {
		return err
	}
```

`runtime.GOMAXPROCS(0)` reads how many CPUs Go is set up to use, without changing anything — asking with 0 is the query form. A small limit cannot mean "unlimited", because that would break the promise of a bound, and it cannot be passed through either: a group with a limit of 0 refuses to start any call. One `List` snapshot before any helper starts means the batch works on one consistent instant; a task added while the batch runs is not part of this batch.

The engine is the group. A **group** from `errgroup` runs functions in goroutines with three pieces of bookkeeping done for you: it bounds how many run at once, it cancels a shared context when the first one fails, and it collects the first error. Its whole surface is a handful of calls:

- `errgroup.WithContext(ctx)` builds the group and a context derived from `ctx`. The group cancels that context itself, the first time a job returns an error.
- `SetLimit(n)` sets the crew size.
- `Go(f)` hands one job to the group. If the crew is full, `Go` waits for a slot before starting it.
- `Wait()` blocks until every started job has returned, then gives back the first error.

Here is the group, the limit, and the scheduling loop:

<!-- verify: internal/store/batch.go at=parallel-stats -->
```go title="internal/store/batch.go"
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(limit)

schedule:
	for _, t := range tasks {
		// The done check before each task is what stops scheduling: once
		// the group's context is canceled — by the first fn error or by
		// ctx itself — no further task is handed to the group. g.Go
		// blocks while limit calls are in flight, so this loop cannot
		// outrun its workers; it parks inside Go until one frees a slot.
		select {
		case <-gctx.Done():
			break schedule
		default:
		}
```

The loop hands tasks over one at a time. Before each hand-off it looks at the group's context: once the context is canceled — by the first failing job or by the caller's context — the loop breaks and stops handing out work. And because `Go` waits when the crew is full, the loop can never race ahead of its helpers: it parks inside `Go` until a slot frees.

One check would almost be enough. Almost: between the loop's check and the moment a helper actually starts, another helper can fail and cancel the group — and the loop's check has already passed. So the job wrapper checks again, right before `fn`.

<!-- verify: internal/store/batch.go at=parallel-stats -->
```go title="internal/store/batch.go"
		g.Go(func() error {
			// The loop's check races the first error — it may have just
			// passed when a worker canceled the group — so the
			// authoritative check runs here, before fn is invoked, where
			// a cancellation that happened before this worker started
			// cannot be missed. That ordering is what lets the fail-fast
			// test assert the next call never runs instead of racing it.
			select {
			case <-gctx.Done():
				return context.Cause(gctx)
			default:
			}
			return fn(t)
		})
	}
```

The check runs after the helper holds its slot and before `fn` is called, where a cancellation that happened before the helper started cannot be missed. The loop's check is the stop signal; this one is the door. The error it returns is `context.Cause(gctx)`, so a caller's own cancellation reason survives the trip.

The tail collects the result.

<!-- verify: internal/store/batch.go at=parallel-stats -->
```go title="internal/store/batch.go"
	// Wait returns the first error — the value the group stored, so
	// errors.Is finds sentinels from fn and causes from ctx — and blocks
	// until every in-flight call has returned, which is why the break
	// above is safe: no worker outlives Process. A live ctx with no error
	// yields nil; a ctx that turned done without any call recording it is
	// reported here like any other cancellation.
	err = g.Wait()
	if err == nil {
		return ctxErr(ctx, "process tasks")
	}
	return fmt.Errorf("process tasks: %w", err)
}
```

`Wait` returns the first error — the same value a failing job returned, so `errors.Is` finds it — and it blocks until every call in flight has returned, which is why stopping early never leaves a helper behind. On the success path there is one more check: a context can turn done without any job recording it, so `Process` asks `ctxErr` once more before returning nil. Otherwise the error comes back wrapped with the operation name, `process tasks`.

## Add the dependency

`batch.go` imports `errgroup`, but the module isn't part of the project yet. Add the import first — as the file above does — so the `go` command has a reason to keep it, then run:

```bash
$ go get golang.org/x/sync@latest
```

```text
go: added golang.org/x/sync v0.24.0
```

One line, and the dependency is recorded in `go.mod`:

<!-- verify: go.mod at=parallel-stats -->
```text title="go.mod"
require (
	github.com/gkampitakis/go-snaps v0.5.23
	github.com/google/go-cmp v0.7.0
	github.com/stretchr/testify v1.12.1
	golang.org/x/sync v0.24.0
)
```

The `go` command also writes two matching lines into `go.sum`, the file that pins the exact bytes of every dependency. This is the first module the app's real code imports: the testing tools appear only in test files, and the rest of the app is part of this project. `errgroup` comes from a separate module maintained by the Go team, and it needs the same Go version this project already runs.

## Run it again

With the code in place, run the new tests:

```bash
$ go test -v -count=1 -run TestProcess ./internal/store
```

```text
=== RUN   TestProcess_VisitsEveryTaskOnce
=== PAUSE TestProcess_VisitsEveryTaskOnce
=== RUN   TestProcess_LimitBoundsConcurrency
=== PAUSE TestProcess_LimitBoundsConcurrency
=== RUN   TestProcess_FirstErrorStopsScheduling
=== PAUSE TestProcess_FirstErrorStopsScheduling
...
--- PASS: TestProcess_VisitsEveryTaskOnce (0.00s)
--- PASS: TestProcess_FirstErrorStopsScheduling (0.00s)
--- PASS: TestProcess_PreCanceledContextRunsNothing (0.00s)
--- PASS: TestProcess_NonPositiveLimitUsesGOMAXPROCS (0.00s)
    --- PASS: TestProcess_NonPositiveLimitUsesGOMAXPROCS/limit=0 (0.00s)
    --- PASS: TestProcess_NonPositiveLimitUsesGOMAXPROCS/limit=-1 (0.00s)
--- PASS: TestProcess_LimitBoundsConcurrency (0.00s)
PASS
ok  	todo/internal/store	0.003s
```

Five tests and two subtests, every one at 0.00s — nothing in them waits on anything but the code under test. The `...` hides the interleaving that `t.Parallel` produces; the `--- PASS` lines name all seven results.

Then the whole suite, and two stress runs — because "passes once" is weak evidence for code that runs things at the same time:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.005s
ok  	todo/internal/store	0.015s
ok  	todo/internal/task	0.004s
```

```bash
$ go test -count=200 -run TestProcess ./internal/store
```

```text
ok  	todo/internal/store	0.032s
```

```bash
$ go test -race -count=50 -run TestProcess ./internal/store
```

```text
ok  	todo/internal/store	1.081s
```

Deterministic: the tests order events with channels, so a busy machine changes how long they take, not what they assert. And clean under the detector: the only shared state `fn` touches is locked, and everything else moves through the group's own bookkeeping.

## If something went wrong

**The second call runs anyway, once in tens of thousands of tries.** This is the failure the second check exists for. Delete the check inside the job wrapper and keep only the loop's check, and the fail-fast test passes almost every time: the window between the loop's check and the helper's start is a few instructions long. Run it enough times and it fails:

```bash
$ go test -count=200000 -failfast -run TestProcess_FirstErrorStopsScheduling ./internal/store
```

```text
--- FAIL: TestProcess_FirstErrorStopsScheduling (0.00s)
    batch_test.go:143:
        	Error Trace:	…/internal/store/batch_test.go:143
        	Error:      	Not equal:
        	            	expected: []int{1}
        	            	actual  : []int{1, 2}
        	            	…
        	Test:       	TestProcess_FirstErrorStopsScheduling
        	Messages:   	the first error stops the next call
FAIL
FAIL	todo/internal/store	0.003s
FAIL
```

Expected `[]int{1}`, got `[]int{1, 2}`: task 2 ran after task 1 had already failed. What happened: the loop's check saw a live context and moved on, then blocked in `Go` waiting for the crew's only slot; the failing call canceled the group and released the slot; the loop's next hand-off started anyway. Fix: the second check inside the wrapper, in front of `fn`, after the slot is held — the shape in `batch.go`. A failure that needs tens of thousands of runs is telling you a safety property is gone, not that the test is unfair.

**Two helpers writing to the same slice.** `fn` runs from several helpers at once — that's the point — so anything `fn` shares needs a lock or a hand-off, like the counting pool's partials. An `fn` that appends to a shared slice without a lock makes the race detector open the run with:

<!-- transcripts: authored -->
```text
==================
WARNING: DATA RACE
Read at 0x00c000016180 by goroutine 10:
  todo/internal/store.TestProcess_RaceProbe.func1()
      /tmp/…/internal/store/raceprobe_test.go:17 +0x38
  todo/internal/store.Process.func1()
      /tmp/…/internal/store/batch.go:63 +0x14f
  golang.org/x/sync/errgroup.(*Group).Go.func1()
      …/go/pkg/mod/golang.org/x/sync@v0.24.0/errgroup/errgroup.go:93 +0x86

Previous write at 0x00c000016180 by goroutine 12:
  todo/internal/store.TestProcess_RaceProbe.func1()
      /tmp/…/internal/store/raceprobe_test.go:17 +0xad
==================
```

Both accesses are the same append, called from two helpers with nothing ordering them. Fix: guard the shared value with a mutex, use an atomic for a single number, or let each call build its own result and merge them after `Process` returns. The visit test locks its `visited` slice for exactly this reason.

**The crew size disappears.** If `SetLimit` is missing, `Go` never waits: the loop hands every task to a goroutine and the ceiling becomes whatever the scheduler feels like. The limit test catches it — though not on the first run, because with no bound a third start is possible but not guaranteed to happen before the test's check. Run it enough times and:

```text
--- FAIL: TestProcess_LimitBoundsConcurrency (0.00s)
    batch_test.go:102: more than limit calls started before any release
FAIL
FAIL	todo/internal/store	0.003s
FAIL
```

Fix: `SetLimit` once, before the first `Go`. Never after a `Go` has started — changing the limit while helpers are active makes the library panic:

```text
panic: errgroup: modify limit while 1 goroutines in the group are still active
…
```

That is why `Process` sets the limit once, before any helper exists.

**Only the first error comes back.** `Wait` returns one error: the first one recorded. A later failure is dropped, by design — the group stores one error, once. A small experiment shows it: two calls, the second released by the first's cancellation, so the order is fixed.

```go
	g, gctx := errgroup.WithContext(context.Background())
	g.Go(func() error { return errFirst })
	g.Go(func() error { <-gctx.Done(); return errSecond })
	err := g.Wait()
```

```text
err: first
errors.Is(err, errFirst):  true
errors.Is(err, errSecond): false
```

Fix: decide which contract you want. To stop at the first problem, `Process` is already right. To hear about everything, collect failures in `fn` yourself — guard the collection — and join them with `errors.Join` at the end, the best-effort policy `CompleteAll` uses.

<details>
<summary>Going deeper: the race the second check closes</summary>

One check in the loop looks correct, and it is correct 199,994 times out of 200,000. A small experiment outside the app measured the two shapes — three tasks, a crew of one, task 1 failing, 200,000 runs each:

```text
outer-only: [1 2]=199994
outer-only: [1]=6
both: [1]=200000
```

The keys are the call sequences `fn` saw; the counts are runs. The one-check shape ran the second call in 199,994 runs. The shipped shape never did, because the library orders the events that close the window: the failing call records the error and cancels the group, then releases its slot; the loop wakes and starts the next helper; the helper's first statement reads the context. Cancel, release, start, check — the cancellation is always first. That is why the fail-fast test can say "the next call never ran" instead of racing it.

</details>

<details>
<summary>Going deeper: why the counting pool keeps its four helpers</summary>

`Stats` still folds its snapshot with the same four helpers it has always had, and that is on purpose. The batch runner needs its error channel, its cancellation, and its stop signal because a job can fail; a `Stats` fold cannot fail per piece — every task contributes and nothing errors — so all of that machinery would be dead weight there. The four is not a speed claim either: counting a slice in memory is fast, and the fixed count is a teaching constant, the measure-first habit applied. When `Stats` runs against a store that does disk or network work, the pieces can wait and fail, and the shape to reach for is the one `Process` just built: a size from the caller, and the first error wins.

</details>

<details>
<summary>Going deeper: what errgroup is, and what it leaves out</summary>

Under its name, `errgroup` is a `WaitGroup`, a shared error slot, and a cancellation, packaged together — the pieces the counting pool used, with the first-error bookkeeping done once, correctly. Writing it by hand is a semaphore channel, a `context.WithCancel`, and a mutex-guarded first error, and every line of that is a place to get the race wrong. Three things the group deliberately does not do: it does not recover panics, it does not join errors, and it does not retry. Those are the caller's decisions, not group mechanics. When the bound is all you need and you already have error plumbing of your own, the smaller tool is `golang.org/x/sync/semaphore`. The references: [errgroup](https://pkg.go.dev/golang.org/x/sync/errgroup) and [semaphore](https://pkg.go.dev/golang.org/x/sync/semaphore).

</details>

<details>
<summary>Going deeper: why these tests never sleep</summary>

Every test in this chapter orders its events with channels, and none reads a clock. A test that sleeps would guess how long "long enough" is: too short and it fails on a busy machine, too long and the suite crawls. The limit test's check is sound because a third start is *impossible* while the first two calls are parked, not merely late — there is nothing to wait for. The fail-fast test needs no signal at all: a crew of one is its ordering. The pre-canceled test checks a state that is already fixed before any helper exists. Where a clock cannot answer the question, the tests arrange for the question to have one answer.

</details>

Next, the tasks leave the store as JSON — and this batch runner will be waiting to carry them back in.
