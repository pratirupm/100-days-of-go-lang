---
title: select and timeouts
day: 18
time: "2.5 hours"
description: Teach the counting pool to give up early — wait on several channels at once, and stop a call when its deadline passes.
sidebar:
  order: 15
---

The counting pool we just built splits the store's tasks across four
workers and merges their partial answers. Every call runs to completion: the
pool never asks whether the caller still wants the answer.

That is fine while counting is fast. But a caller can have a budget — a web
request that must answer quickly, a command that should not hang. When the
budget runs out, the caller wants the count so far, not a longer wait.

Today the pool learns two tricks: how to stop when someone asks it to, and
how to stop itself when a **deadline** passes — a moment after which a call
stops waiting. The tool for both is `select`, a Go statement that waits on
several channels at once.

## Waiting on several channels at once

A `select` looks like a `switch`, but every case is a channel operation:

```go
select {
case task := <-work:
	fmt.Println("doing", task)
case <-done:
	fmt.Println("stopping")
}
```

`select` waits until one of its cases can proceed, runs that case, and moves
on. A receive can proceed when a value is waiting, and also when the channel
has been closed. If several cases can proceed at once, Go picks one at
random — deliberately, so no case gets a hidden priority.

The `default` case runs only when no other case can proceed, so a `select`
with a `default` is a check that never waits. And a receive from a **nil**
channel — a channel with no channel behind it — blocks forever, so a case on
a nil channel never becomes ready. That rule is the whole trick behind the
new `Stats`.

## Write the tests first

Open `internal/store/stats_test.go` and add `"time"` to the import block:

<!-- verify: internal/store/stats_test.go at=select -->
```go title="internal/store/stats_test.go"
import (
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)
```

`time` holds durations like `time.Hour` and `time.Second`. Now append five
tests, one corner each.

The first test pins the plain call.

<!-- verify: internal/store/stats_test.go at=select -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_StatsCancelable_NilCancelMatchesOracle(t *testing.T) {
	t.Parallel()

...
	s := mustStore(t, statsTasks(1001)...)
	want := statsSequential(s.List())

	got, err := s.StatsCancelable(nil)
	require.NoError(t, err, "a nil cancel channel never fires")
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("StatsCancelable(nil) mismatch against the sequential oracle (-want +got):\n%s", diff)
	}
}
```

With a nil cancel channel, `StatsCancelable` must equal the sequential oracle
exactly.

The second test cancels before the call starts.

<!-- verify: internal/store/stats_test.go at=select -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_StatsCancelable_PreCanceledReturnsEmptyAggregate(t *testing.T) {
	t.Parallel()

...
	s := mustStore(t, statsTasks(1001)...)

	cancel := make(chan struct{})
	close(cancel)

	got, err := s.StatsCancelable(cancel)
	require.ErrorIs(t, err, ErrStatsCanceled)
	require.NotNil(t, got.ByTag, "ByTag is non-nil on the canceled path too")
	assert.Equal(t, Stats{ByTag: map[string]int{}}, got)
}
```

It must return the empty aggregate and `ErrStatsCanceled`, with no worker
started.

The third test leaves the cancel channel open and never closes it.

<!-- verify: internal/store/stats_test.go at=select -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_StatsCancelable_OpenCancelMatchesOracle(t *testing.T) {
	t.Parallel()

...
	s := mustStore(t, statsTasks(1001)...)
	want := statsSequential(s.List())

	cancel := make(chan struct{}) // never closed; nothing to clean up

	got, err := s.StatsCancelable(cancel)
	require.NoError(t, err, "an open cancel channel must not cancel")
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("StatsCancelable(open cancel) mismatch against the sequential oracle (-want +got):\n%s", diff)
	}
}
```

The result must equal the oracle with no error.

The fourth test passes deadlines that have already passed, zero and
negative.

<!-- verify: internal/store/stats_test.go at=select -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_StatsWithin_NonPositiveDeadlineTimesOut(t *testing.T) {
	t.Parallel()

...
	tests := []struct {
		name string
		d    time.Duration
	}{
		{name: "zero", d: 0},
		{name: "negative", d: -time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, statsTasks(1001)...)

			got, err := s.StatsWithin(tt.d)
			require.ErrorIs(t, err, ErrStatsTimeout)
			require.NotNil(t, got.ByTag, "ByTag is non-nil on the timed-out path too")
			assert.Equal(t, Stats{ByTag: map[string]int{}}, got)
		})
	}
}
```

The call must not wait, and must report `ErrStatsTimeout`.

The fifth test passes an hour — a deadline no test run reaches.

<!-- verify: internal/store/stats_test.go at=select -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_StatsWithin_WithinDeadlineMatchesOracle(t *testing.T) {
	t.Parallel()

...
	s := mustStore(t, statsTasks(1001)...)
	want := statsSequential(s.List())

	got, err := s.StatsWithin(time.Hour)
	require.NoError(t, err, "an hour is beyond any test run's reach")
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("StatsWithin(time.Hour) mismatch against the sequential oracle (-want +got):\n%s", diff)
	}
}
```

The timer stays silent, and the result must equal the oracle.

All five sit on corners where the answer cannot depend on timing or on a
race.

## Watch the tests fail

Run the suite:

```bash
$ go test -count=1 ./...
# todo/internal/store [todo/internal/store.test]
internal/store/stats_test.go:237:16: s.StatsCancelable undefined (type *MemoryStore has no field or method StatsCancelable)
internal/store/stats_test.go:256:16: s.StatsCancelable undefined (type *MemoryStore has no field or method StatsCancelable)
internal/store/stats_test.go:257:26: undefined: ErrStatsCanceled
internal/store/stats_test.go:273:16: s.StatsCancelable undefined (type *MemoryStore has no field or method StatsCancelable)
internal/store/stats_test.go:302:18: s.StatsWithin undefined (type *MemoryStore has no field or method StatsWithin)
internal/store/stats_test.go:303:28: undefined: ErrStatsTimeout
internal/store/stats_test.go:320:16: s.StatsWithin undefined (type *MemoryStore has no field or method StatsWithin)
ok  	todo/cmd/todo	0.003s
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	0.004s
FAIL
```

Seven complaints, each naming a piece of the new API that does not exist
yet: the two methods and the two named errors. Only the store's test binary
fails to build; the other two packages compile and pass. Your line numbers
will differ — the file already holds the earlier tests.

## Teach the pool to stop

Open `internal/store/stats.go`. The imports need `errors` for the two named
failures and `time` for the deadline:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
import (
	"errors"
	"sync"
	"time"

	"todo/internal/task"
)
```

Add the two errors right after the `Stats` struct:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
// ErrStatsCanceled is returned when a Stats computation observes cancellation.
var ErrStatsCanceled = errors.New("stats canceled")

// ErrStatsTimeout is returned when a Stats computation outlives its deadline.
var ErrStatsTimeout = errors.New("stats timed out")
```

Each is a plain error value, matched with `errors.Is` like the store's
`ErrNotFound`: the first says the core saw cancellation, the second that a
call outlived its deadline. The `statsWorkers` constant keeps its value of
4.

Now the pool. Rename the function you already have to `StatsCancelable`,
change its signature to take a cancel channel, and open it with this fast
path:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
func (s *MemoryStore) StatsCancelable(cancel <-chan struct{}) (Stats, error) {
	// Cancellation that is already visible at entry must not lose a worker
	// to the race: the fast path returns before the snapshot. It is also
	// what keeps the pre-canceled test deterministic — select falls
	// through to default only when no case is ready, so a closed cancel
	// always wins here.
	select {
	case <-cancel:
		return Stats{ByTag: make(map[string]int)}, ErrStatsCanceled
	default:
	}
```

The function's doc comment should now say what it does: a nil cancel never
fires, an open cancel changes nothing, and a closed one returns the empty
aggregate with `ErrStatsCanceled`. If `cancel` is already closed, the receive
case is ready and `default` never fires: the call returns before the
snapshot, so no worker starts — which is what makes the pre-canceled test
deterministic.

The function returns two values now, so its other `return` statements change
too. The empty-store return, for example:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
	if len(tasks) == 0 {
		// Nothing to fold; the empty aggregate still carries a non-nil
		// ByTag, matching CountByTag.
		return Stats{ByTag: make(map[string]int)}, nil
	}
```

Next, the two places where the pool can wait. The first is the worker's send
— the only spot where a worker can block:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
			// The send is the worker's cancellation point: if the caller
			// gave up, drop the partial and exit instead of blocking on
			// a consumer that may already be gone. With a nil cancel the
			// cancel case is unreachable and the send behaves exactly
			// like the unconditional one did.
			select {
			case partials <- statsOf(chunk):
			case <-cancel:
				return
			}
```

The `select` offers the send and the cancel together: a worker whose caller
gave up drops its partial and exits instead of blocking on a consumer that
may be gone. With a nil cancel, this is exactly the plain send it replaces.

The second waiting point is the consumer's merge loop, which stops ranging
and offers the receive and the cancel together:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
	// The consumer owns the merge. Every worker counted into its own Stats
	// and its own map, so the workers share no mutable state; ownership of
	// each partial transfers through the channel. Receiving and cancelling
	// are offered together: whichever case is ready first wins, and when
	// both are ready select picks at random — the merge stays correct
	...
	merged := Stats{ByTag: make(map[string]int)}
	for {
		select {
		case <-cancel:
			// A canceled call returns what was merged so far, not a
			// zeroed value. Workers still folding observe the closed
			// cancel at their next send and exit; the joiner's close
			// then goes to nobody, which is legal.
			return merged, ErrStatsCanceled
```

When the cancel wins, the call returns the partial aggregate — what it has
merged so far — not a zeroed value. Workers still folding notice the closed
channel at their next send and exit; the joiner's close then goes to nobody,
which is legal.

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
		case partial, ok := <-partials:
			if !ok {
				return merged, nil
			}
			merged.Total += partial.Total
			merged.Done += partial.Done
			merged.Pending += partial.Pending
			for tag, count := range partial.ByTag {
				merged.ByTag[tag] += count
			}
		}
	}
}
```

When the receive wins, the merge is the code that was already there, now
inside the `select`; `ok` still reports when the joiner has closed the
channel.

Finally, the new `Stats()` sits in front of the cancellable core:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
// Stats computes the aggregate across a fixed pool of workers. It is
// StatsCancelable with a nil cancel channel: a receive from a nil channel
// blocks forever, so the cancel case in every select below is unreachable
// and the computation always runs to completion.
func (s *MemoryStore) Stats() Stats {
	stats, err := s.StatsCancelable(nil)
	if err != nil {
		// Unreachable: a nil cancel channel never fires, so the core can
		// never report cancellation through it. Panic rather than let a
		// partial aggregate pass as a complete one.
		panic("store: Stats() canceled with a nil cancel channel")
	}
	return stats
}
```

It calls the core with a nil cancel channel, which can never fire, so the
plain call runs as it always did. The panic covers a state the code cannot
produce: rather than let a partial aggregate pass for a complete one, it
stops loudly.

## A deadline for the call

Now the piece the chapter is for. `StatsWithin` takes how long the caller
will wait, and returns the aggregate or `ErrStatsTimeout`. Add it after
`StatsCancelable`:

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
// StatsWithin runs the aggregate with a deadline: it is StatsCancelable with
// a cancel channel that a time.Timer closes after d. The timer is the only
// cancellation source here, so cancellation surfaces as ErrStatsTimeout;
// d <= 0 does not wait, returning the empty aggregate with ErrStatsTimeout
// before a timer or a worker exists.
func (s *MemoryStore) StatsWithin(d time.Duration) (Stats, error) {
	if d <= 0 {
		return Stats{ByTag: make(map[string]int)}, ErrStatsTimeout
	}

	timer := time.NewTimer(d)
	// As of Go 1.23 a timer's channel is unbuffered and Stop leaves no
	// stale value behind, so there is nothing to drain: the old
	// `if !timer.Stop() { <-timer.C }` idiom would now block forever.
	defer timer.Stop()

	cancel := make(chan struct{})
	...
	done := make(chan struct{})
	defer close(done)
```

A duration of zero or less means the deadline has already passed, so the
call returns at once, before a timer or a worker exists. `time.NewTimer(d)`
is an alarm clock that fires once and sends a value on `timer.C`;
`defer timer.Stop()` disarms it, so a call that finishes in time never fires
it. And `done`, closed on return, is the watcher's second way out: the
watcher is the small goroutine below that waits on the timer, and without
`done` it waits forever — as the lab below shows.

<!-- verify: internal/store/stats.go at=select -->
```go title="internal/store/stats.go"
	// The watcher is the only writer of cancel: the timer firing means
	// the computation has outlived its deadline, so it closes cancel and
	// the core reports the partial aggregate as ErrStatsCanceled; the
	// call returning first means there is nothing left to cancel, so the
	// watcher just exits. Either way it does not outlive the call.
	go func() {
		select {
		case <-timer.C:
			close(cancel)
		case <-done:
		}
	}()

	stats, err := s.StatsCancelable(cancel)
	if err != nil {
		return stats, ErrStatsTimeout
	}
	return stats, nil
}
```

The watcher waits on two channels. If `timer.C` speaks first, the computation
outlived its deadline, so the watcher closes `cancel` and the core reports
the partial aggregate. If `done` speaks first, the call is returning and
there is nothing to cancel. Either way, the watcher exits.

Then the call runs through the core. The timer is the only thing that can
close `cancel` here, so a canceled result is by construction a deadline that
passed, and it surfaces as `ErrStatsTimeout`. The two `defer`s run in
reverse: `close(done)` happens before `timer.Stop()`, so the watcher wakes
through `done` while the timer is still armed. Every path out stops the
timer and closes `done`.

## Make it pass

Run the five new tests:

```bash
$ go test -run 'TestMemoryStore_StatsCancelable|TestMemoryStore_StatsWithin' -v -count=1 ./internal/store
…
--- PASS: TestMemoryStore_StatsCancelable_PreCanceledReturnsEmptyAggregate (0.00s)
--- PASS: TestMemoryStore_StatsWithin_WithinDeadlineMatchesOracle (0.00s)
--- PASS: TestMemoryStore_StatsCancelable_OpenCancelMatchesOracle (0.00s)
--- PASS: TestMemoryStore_StatsCancelable_NilCancelMatchesOracle (0.00s)
--- PASS: TestMemoryStore_StatsWithin_NonPositiveDeadlineTimesOut (0.00s)
    --- PASS: TestMemoryStore_StatsWithin_NonPositiveDeadlineTimesOut/zero (0.00s)
    --- PASS: TestMemoryStore_StatsWithin_NonPositiveDeadlineTimesOut/negative (0.00s)
PASS
ok  	todo/internal/store	0.005s
```

Five tests and two subtests, every one at 0.00s — they wait on nothing but
the code under test. (The `…` hides the pause-and-resume noise from the
parallel tests.) The whole suite:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.006s
ok  	todo/internal/task	0.003s
```

And under the race detector:

```bash
$ go test -race -count=1 ./internal/store
ok  	todo/internal/store	1.023s
```

One second and silence. The cancel signal travels between goroutines only as
a closed channel — an ordering guarantee, like every other hand-off in the
pool — so there is no unsynchronized pair to find.

## The watcher that never exits

The `done` channel looks optional. It is not, and the way to see that is to
measure. Make a throwaway copy of the app outside the project:

<!-- transcripts: authored -->
```bash
$ cp -r . ../ch15-lab
$ cd ../ch15-lab
```

In the copy, drop the `done` channel and its `defer`, and rewrite the
watcher without its second case:

```go
	cancel := make(chan struct{})

	// LEAK DEMO: the done channel is gone, so this watcher can only exit
	// if the timer fires — and the defer timer.Stop() above guarantees a
	// timer whose deadline the call outlived never fires.
	go func() {
		<-timer.C
		close(cancel)
	}()
```

Then add a lab-only test file, `leakprobe_test.go`, that counts goroutines
around a hundred calls. The pause on each side lets every goroutine that
intends to exit exit; a real leak cannot be waited away.

```go
func TestStatsWithinGoroutineProbe(t *testing.T) {
	s := mustStore(t, statsTasks(1000)...)

	before := runtime.NumGoroutine()
	const calls = 100
	for range calls {
		if _, err := s.StatsWithin(time.Hour); err != nil {
			t.Fatalf("call: %v", err)
		}
	}
	// Give every goroutine that intends to exit a chance to exit; a real
	// leak cannot be waited away.
	time.Sleep(100 * time.Millisecond)
	after := runtime.NumGoroutine()

	t.Logf("goroutines before=%d after=%d delta=%d over %d calls", before, after, after-before, calls)
}
```

The file needs `runtime` and `time` in its imports. Run it:

```bash
$ go test -v -run TestStatsWithinGoroutineProbe -count=1 ./internal/store
=== RUN   TestStatsWithinGoroutineProbe
    leakprobe_test.go:24: goroutines before=2 after=102 delta=100 over 100 calls
--- PASS: TestStatsWithinGoroutineProbe (0.11s)
PASS
ok  	todo/internal/store	0.116s
```

A hundred calls left a hundred extra goroutines. The pause cannot rescue
them: `timer.Stop()` disarmed every timer, so each watcher's `<-timer.C`
waits forever — not for an hour. The leak is permanent, not slow.

Now copy your app's `internal/store/stats.go` over the lab's copy and run
the identical probe:

<!-- transcripts: authored -->
```bash
$ cp ../todo/internal/store/stats.go internal/store/stats.go
$ go test -v -run TestStatsWithinGoroutineProbe -count=1 ./internal/store
=== RUN   TestStatsWithinGoroutineProbe
    leakprobe_test.go:24: goroutines before=2 after=2 delta=0 over 100 calls
--- PASS: TestStatsWithinGoroutineProbe (0.11s)
PASS
ok  	todo/internal/store	0.115s
```

One `case <-done:` is the difference between a hundred parked goroutines and
none. The fixed watchers take their `done` case and exit, because
`StatsWithin` closes `done` on return.

Delete the lab:

<!-- transcripts: authored -->
```bash
$ cd ..
$ rm -rf ch15-lab
```

The lab was never part of the app.

## If something went wrong

**The probe still reports `delta=100` after you added the watcher.** The
watcher needs both cases, `case <-timer.C:` and `case <-done:`, and
`StatsWithin` must close `done` on return with `defer close(done)`. With only
`timer.C`, the watcher's one exit is an alarm that `defer timer.Stop()`
guarantees will never ring. Add the case and the defer, and the delta goes to
zero.

**A test fails only sometimes, with a line about timing.** You wrote a test
that times a deadline — one that calls `StatsWithin(time.Nanosecond)` a
thousand times and complains when a call finishes before the timer fires.
Run it a few times and it fails, then passes, from the same binary:

<!-- transcripts: authored -->
```text
=== RUN   TestStatsWithinOneNanosecond
    flaky_test.go:23: completed=2 of 1000 calls; a timing assertion that fails here and passes on the next run
--- FAIL: TestStatsWithinOneNanosecond (0.05s)
…
--- PASS: TestStatsWithinOneNanosecond (0.05s)
FAIL
FAIL	todo/internal/store	0.281s
FAIL
```

The fold takes tens of microseconds and the deadline is one nanosecond, so
which side finishes first is the scheduler's business. A failure from that
race says nothing about the code. Test only the corners where the outcome
cannot depend on the scheduler: a nil cancel, an already-closed cancel, a
deadline already past, and a deadline that cannot arrive.

**The same call reports different results from one run to the next.** Once
`cancel` is closed while the merge runs, both cases can be ready at once —
the cancel, and a partial waiting to be received. Go picks at random, so one
call may return `ErrStatsCanceled` with the partial aggregate and the next no
error with the complete one; both are correct. The fix is in the tests, not
the code: never assert on the middle. The doc comment states that contract,
and the suite stays on the deterministic corners.

<details>
<summary>Going deeper: when two cases are ready, Go flips a coin</summary>

`select` picks a ready case at random, and it makes a fresh choice every time
— deliberately, so a program cannot grow an accidental priority nobody wrote
down. A short program shows the split: one channel always has a value
waiting, one is closed.

```go
buf := make(chan int, 1)
closed := make(chan struct{})
close(closed)

var partial, cancel int
for range 1000 {
	select {
	case <-buf:
		partial++
	case <-closed:
		cancel++
	}
	select {
	case buf <- 1: // refill if empty: both cases are ready next turn
	default:
	}
}
fmt.Printf("partial=%d cancel=%d\n", partial, cancel)
```

Three runs gave `partial=499 cancel=501`, then `partial=483 cancel=517`, then
`partial=505 cancel=495` — near half and half, never the same split twice.
That is why the tests never cancel in the middle: a test racing the coin
would fail for reasons that say nothing about the code.

</details>

<details>
<summary>Going deeper: timers, and the drain that would block</summary>

Before Go 1.23, a stopped timer's channel could still hold a stale value, so
the safe way to stop one was a dance: `if !timer.Stop() { <-timer.C }`.
Since Go 1.23 the channel is unbuffered, and the `time` package says so
directly:

```text
// For a chan-based timer created with NewTimer(d), as of Go 1.23,
// any receive from t.C after Stop has returned is guaranteed to block
// rather than receive a stale time value from before the Stop;
// if the program has not received from t.C already and the timer is
// running, Stop is guaranteed to return true.
// Before Go 1.23, the only safe way to use Stop was insert an extra
// <-t.C if Stop returned false to drain a potential stale value.
```

So the old dance would now block forever. The same release notes say the
garbage collector can now recover unreferenced timers, so `Stop` is no longer
needed for memory either — but it is still what this chapter needs it for:
the guarantee that a timer whose deadline the call outlived never fires.

</details>

Next, Go's own cancellation toolkit takes the timer, the watcher, and the
`done` channel off our hands — and the five tests you just wrote stay
passing, untouched.
