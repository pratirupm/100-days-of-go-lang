---
title: Goroutines and channels
description: Compute the store's task summary across four helpers running at once — and prove the answer matches a plain one-at-a-time count.
sidebar:
  order: 14
---

Tasks can be listed, filtered by status or label, and sorted by due date. What
the app can't do is summarize: how many tasks there are, how many are done, how
many are still pending, and which labels show up how often. That summary is
`Stats`.

This is the first time our code does several things at once. We'll split the
counting across four helpers that run side by side — goroutines — and each
helper will hand its partial counts back through a channel. Done well,
concurrency isn't about speed but ownership: every helper counts its own slice
and hands the result over.

The safety net is a plain version that counts one task at a time, and the tests
require the helpers' answer to match it exactly. If the two ever disagree, the
plain one is right.

## A job and a helper

A cook working alone does everything in order: chop the onions, then stir the
pot, then wash up. Add one helper and the picture changes — while the helper
chops, the cook stirs, and two jobs are in progress at once.

A **goroutine** is Go's helper: a piece of work that runs alongside the rest of
the program instead of after it. The `go` keyword hands a function call to Go's
scheduler and moves straight on, and the call keeps running while `main`
continues. Here is a whole program with three helpers:

```go title="main.go"
package main

import (
	"fmt"
	"sync"
)

func main() {
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fmt.Println(i)
		}()
	}
	wg.Wait()
}
```

The `WaitGroup` holds `main` until all three helpers have finished: `Add(1)`
before each `go`, `Done` when a helper is finished, `Wait` for the end. Without
it, `main` would exit before the helpers ran. One run of the program printed:

```text
1
0
2
```

The order is the point: Go's scheduler decided when each helper ran, so the
next run may come out differently. Nothing had to decide who goes first,
because the helpers share nothing.

## The hand-off

A busy kitchen has a pass-through window: the cook sets a finished plate on the
ledge, and the server takes it. Once the plate is through, only the server owns
it.

A **channel** is that ledge in Go: a typed pipe for values. `make(chan string)`
builds one that carries strings, `ch <- v` sends a value, and `<-ch` receives
one. This program has a helper say one thing, and `main` wait for it:

```go
messages := make(chan string)
go func() {
	messages <- "the dishes are done"
}()
fmt.Println("helper says:", <-messages)
```

Read the last line: `main` cannot finish it until the helper has sent. The
channel is the only thing the two goroutines touch, and the value travels
through it — the sender is done with it the moment the receiver has it. Go
calls this *sharing memory by communicating*.

A channel also has an end. `close(messages)` means no more values are coming,
and ranging over a channel — `for v := range messages` — receives until it is
closed and empty; the pool uses exactly that to know when the counting is done.
A channel can also hold a few values before anyone receives:
`make(chan string, 3)`. Ours holds four, one per helper.

## Write the test first

The summary has a contract. `Total` is how many tasks are in the store. `Done`
counts only tasks whose status is `StatusDone`; every other status, known or
not, is `Pending`. `ByTag` counts how many tasks carry each label, matching the
store's `CountByTag`: at most once per label per task, and never nil.

Create `internal/store/stats_test.go`. It has three parts: an oracle, a
generator for a large set, and the tests. First, the oracle:

<!-- verify: internal/store/stats_test.go at=goroutines -->
```go title="internal/store/stats_test.go"
package store

import (
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)

// statsSequential computes Stats one task at a time, with no concurrency: the
// oracle the worker pool's merged result must equal exactly. The point of the
// chapter is that the concurrent answer must be the deterministic one; when
// the two disagree, this is the one to trust.
func statsSequential(tasks []task.Task) Stats {
	stats := Stats{ByTag: make(map[string]int)}
	for _, t := range tasks {
		stats.Total++
		if t.Status == task.StatusDone {
			stats.Done++
		}
		// CountByTag counts a task at most once per tag, even when the task
		// repeats it, so ByTag must do the same.
		seen := make(map[string]bool, len(t.Tags))
		for _, tag := range t.Tags {
			if seen[tag] {
				continue
			}
			seen[tag] = true
			stats.ByTag[tag]++
		}
	}
	stats.Pending = stats.Total - stats.Done
	return stats
}
```

One pass, one task at a time — deliberately boring, because it is the
definition of correct. `seen` counts a task at most once per label, exactly as
`CountByTag` does.

Next, the generator that builds the large set:

<!-- verify: internal/store/stats_test.go at=goroutines -->
```go title="internal/store/stats_test.go"
// statsSeed is the fixed seed of the large deterministic set. Nothing in the
// tests may fall back on an unseeded generator: every run must build the same
// tasks, so a failure is reproducible and the oracle comparison means
// something.
const statsSeed = 14

// statsTasks builds n tasks from the fixed seed: the statuses mix Todo, Done,
// and values outside the known set, and the tags overlap from a small pool,
// with repeats inside a task.
func statsTasks(n int) []task.Task {
	rng := rand.New(rand.NewPCG(statsSeed, 0)) // #nosec G404 -- deterministic test data, never a security source
	statuses := []task.Status{task.StatusTodo, task.StatusDone, task.Status("Blocked")}
	tags := []string{"go", "book", "urgent", "home", "work"}
	tasks := make([]task.Task, n)
	for i := range tasks {
		t := task.Task{
			Title:  fmt.Sprintf("task-%04d", i),
			Status: statuses[rng.IntN(len(statuses))],
		}
		if rng.IntN(4) != 0 {
			for range 1 + rng.IntN(3) {
				t.Tags = append(t.Tags, tags[rng.IntN(len(tags))])
			}
		}
		tasks[i] = t
	}
	return tasks
}
```

1001 is one more than 4 × 250 on purpose: split across four helpers, the last
chunk is short, and the merged answer must still come out exact. The seed is
fixed so every run builds the same tasks. The `#nosec G404` note tells the
linter this random call must be predictable.

## The tests that pin the answer

The first test is a table of six shapes and one runner:

<!-- verify: internal/store/stats_test.go at=goroutines -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_Stats_MatchesOracle(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		tasks []task.Task
	}{
		{
			name: "empty store",
		},
		{
			name: "one task",
			tasks: []task.Task{
				{Title: "write tests", Status: task.StatusTodo, Tags: []string{"go"}},
			},
		},
...
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, tt.tasks...)

			want := statsSequential(s.List())
			got := s.Stats()
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("Stats() mismatch against the sequential oracle (-want +got):\n%s", diff)
			}
		})
	}
}
```

The two cases shown are the pattern; the `...` hides four more shapes — fewer
tasks than helpers, an exact multiple, out-of-set statuses, and overlapping
labels — written the same way. The runner does the real work: `want` comes
from the oracle, `got` from the pool, and `cmp.Diff` reports any difference.

The large set gets its own test, with guards the oracle cannot provide:

<!-- verify: internal/store/stats_test.go at=goroutines -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_Stats_LargeSetMatchesOracle(t *testing.T) {
	t.Parallel()

	// 1001 is deliberately one more than 4*250: the split is uneven and the
	// last chunk is short, which the merged result must still absorb exactly.
	s := mustStore(t, statsTasks(1001)...)

	// The set must exercise every fold; if a future seed change made it
	// boring, the equality check below would quietly weaken.
	want := statsSequential(s.List())
	require.Positive(t, want.Done, "the fixed seed must produce completed tasks")
	require.Positive(t, want.Pending, "the fixed seed must produce pending tasks")
	require.Greater(t, len(want.ByTag), 1, "the fixed seed must produce overlapping tags")

	got := s.Stats()
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Stats() mismatch against the sequential oracle (-want +got):\n%s", diff)
	}
}
```

The three `require` lines are anti-boredom insurance: the seed must keep
producing completed tasks, pending tasks, and more than one label, or the
equality check would quietly weaken.

The next two tests pin the numbers the oracle cannot defend alone — it could
share a misunderstanding with the implementation:

<!-- verify: internal/store/stats_test.go at=goroutines -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_Stats_OutOfSetStatusesCountAsPending(t *testing.T) {
	t.Parallel()

	s := mustStore(t,
		task.Task{Title: "write tests", Status: task.StatusTodo},
		task.Task{Title: "review code", Status: task.StatusDone},
		task.Task{Title: "read spec", Status: task.Status("Blocked")},
		task.Task{Title: "drop it", Status: task.Status("Cancelled")},
	)

	// Only StatusDone counts as done; anything else — known or not — is
	// pending, so the numbers are pinned literally here, not only against
	// the oracle.
	got := s.Stats()
	assert.Equal(t, Stats{Total: 4, Done: 1, Pending: 3, ByTag: map[string]int{}}, got)
}

func TestMemoryStore_Stats_OverlappingTags(t *testing.T) {
	t.Parallel()

	s := mustStore(t,
		task.Task{Title: "write tests", Status: task.StatusTodo, Tags: []string{"go", "testing"}},
		task.Task{Title: "review code", Status: task.StatusDone, Tags: []string{"go", "review"}},
		task.Task{Title: "tag twice", Status: task.StatusTodo, Tags: []string{"go", "go", "testing"}},
		task.Task{Title: "no tags", Status: task.StatusTodo},
		task.Task{Title: "one tag", Status: task.StatusDone, Tags: []string{"review"}},
	)

	got := s.Stats()
	assert.Equal(t, Stats{
		Total:   5,
		Done:    2,
		Pending: 3,
		ByTag:   map[string]int{"go": 3, "testing": 2, "review": 2},
	}, got)
	// Stats.ByTag is defined to match CountByTag, so the store's own
	// aggregate is a second oracle for it.
	assert.Equal(t, s.CountByTag(), got.ByTag)
}
```

Only `StatusDone` counts as done, so four tasks with four different statuses
are exactly `Total: 4, Done: 1, Pending: 3`. A repeated label counts once per
task: `"go": 3` across the three tasks that carry it, checked against
`CountByTag` as a second opinion.

One last promise: an empty store returns an empty map, not a nil one:

<!-- verify: internal/store/stats_test.go at=goroutines -->
```go title="internal/store/stats_test.go"
func TestMemoryStore_Stats_ByTagNonNilWhenEmpty(t *testing.T) {
	t.Parallel()

	t.Run("empty store", func(t *testing.T) {
		t.Parallel()

		got := NewMemoryStore().Stats()
		require.NotNil(t, got.ByTag, "ByTag is non-nil even when empty, matching CountByTag")
		assert.Equal(t, Stats{ByTag: map[string]int{}}, got)
	})

	t.Run("tasks without tags", func(t *testing.T) {
		t.Parallel()

		s := mustStore(t,
			task.Task{Title: "write tests", Status: task.StatusTodo},
			task.Task{Title: "review code", Status: task.StatusDone},
		)
		got := s.Stats()
		require.NotNil(t, got.ByTag, "ByTag is non-nil even when empty, matching CountByTag")
		assert.Equal(t, Stats{Total: 2, Done: 1, Pending: 1, ByTag: map[string]int{}}, got)
	})
}
```

A nil map and an empty map are different values, and `cmp.Diff` can tell them
apart. The second subtest repeats the checks over two tasks with no labels.

Now run it:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/store [todo/internal/store.test]
internal/store/stats_test.go:19:41: undefined: Stats
internal/store/stats_test.go:96:26: undefined: statsWorkers
...
internal/store/stats_test.go:200:27: too many errors
ok  	todo/cmd/todo	0.003s
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	0.003s
FAIL
```

The store's test binary fails to build: it names `Stats`, `statsWorkers`, and
the `Stats` method before any of them exist. The compiler stops at ten errors
with `too many errors`; the other packages compile and pass in the same run.
Your line numbers will differ.

## Make it pass

Create `internal/store/stats.go` and start with the type, the worker count, and
the first half of the method:

<!-- verify: internal/store/stats.go at=goroutines -->
```go title="internal/store/stats.go"
package store

import (
	"sync"

	"todo/internal/task"
)

// Stats aggregates a snapshot of the store's tasks.
type Stats struct {
	// Total is the number of tasks in the snapshot.
	Total int
	// Done is the number of tasks whose status is StatusDone.
	Done int
	// Pending is Total - Done; statuses outside the known set are pending.
	Pending int
	// ByTag counts how many tasks carry each tag, matching CountByTag: a task
	// counts at most once per tag, and the map is non-nil even when empty.
	ByTag map[string]int
}

// statsWorkers is the fixed size of the pool Stats folds the snapshot with.
...
const statsWorkers = 4

// Stats computes the aggregate across a fixed pool of workers: the store is
// snapshotted, chunked, each chunk folded sequentially in its own goroutine,
...
func (s *MemoryStore) Stats() Stats {
	// Snapshot first: after List returns, the workers only ever read their
	// own copy, so no worker can observe the store changing under it.
	tasks := s.List()
	if len(tasks) == 0 {
		// Nothing to fold; the empty aggregate still carries a non-nil
		// ByTag, matching CountByTag.
		return Stats{ByTag: make(map[string]int)}
	}

	// At most statsWorkers workers, and never more than one per task. The
	// rounding-up division is the chunk math: the last chunk takes the
	// remainder, so no task is dropped when the split is uneven.
	workers := min(statsWorkers, len(tasks))
	chunkSize := (len(tasks) + workers - 1) / workers

	// The buffer lets every worker hand its partial off and finish without
	// waiting for the consumer to be scheduled.
	partials := make(chan Stats, workers)
```

`Stats` is a plain bundle of four fields: three whole numbers and a map from
label to count, built with `make` so it is never nil. `statsWorkers` fixes the
pool at four helpers.

`Stats()` snapshots first: `s.List()` hands back a copy, and the helpers only
read that copy, so a task added mid-count is not part of the answer. The empty
store returns early with a non-nil map. Then the chunk math:
`min(statsWorkers, len(tasks))` never asks for more helpers than tasks, and
`(len(tasks) + workers - 1) / workers` rounds up, so 1001 tasks over four
helpers split 251, 251, 251, and 248. Last, `partials` is the ledge: a channel
with room for one partial per helper.

Now the pool itself:

<!-- verify: internal/store/stats.go at=goroutines -->
```go title="internal/store/stats.go"
	var wg sync.WaitGroup
	for start := 0; start < len(tasks); start += chunkSize {
		chunk := tasks[start:min(start+chunkSize, len(tasks))]
		wg.Add(1)
		go func() {
			defer wg.Done()
			partials <- statsOf(chunk)
		}()
	}

	// One goroutine owns the join: it waits for every worker and then closes
	// the channel, which is the only completion signal the consumer needs.
	go func() {
		wg.Wait()
		close(partials)
	}()

	// The consumer owns the merge. Every worker counted into its own Stats
	// and its own map, so the workers share no mutable state; ownership of
	// each partial transfers through the channel.
	merged := Stats{ByTag: make(map[string]int)}
	for partial := range partials {
		merged.Total += partial.Total
		merged.Done += partial.Done
		merged.Pending += partial.Pending
		for tag, count := range partial.ByTag {
			merged.ByTag[tag] += count
		}
	}
	return merged
}
```

Read it in three pieces. The loop spawns one goroutine per chunk; `chunk` is
declared inside the loop, so each helper owns exactly one slice, and the chunks
do not overlap — "no shared state" is a fact about the code, not a hope. The
second goroutine waits for every helper and then closes the channel: that
`close` is the completion signal. And the range merges, ending when the channel
is closed and drained — no clock to check, no count to guess.

Ownership moves through the channel: a helper sends its own `Stats`, map
included, and never touches it again; the merger reads each partial while
folding it in. That removes the need for locks: partition the work, give each
piece one owner, move ownership once.

Last, the fold each helper runs over its own chunk:

<!-- verify: internal/store/stats.go at=goroutines -->
```go title="internal/store/stats.go"
// statsOf folds one chunk sequentially into a fresh Stats. The caller owns
// chunk and nothing here is shared with another worker; the returned ByTag is
// always non-nil.
func statsOf(tasks []task.Task) Stats {
	stats := Stats{Total: len(tasks), ByTag: make(map[string]int)}
	for _, t := range tasks {
		if t.Status == task.StatusDone {
			stats.Done++
		}
		// CountByTag counts a task at most once per tag, even when the task
		// repeats it.
		seen := make(map[string]bool, len(t.Tags))
		for _, tag := range t.Tags {
			if seen[tag] {
				continue
			}
			seen[tag] = true
			stats.ByTag[tag]++
		}
	}
	stats.Pending = stats.Total - stats.Done
	return stats
}
```

`statsOf` counts its chunk: total, done, labels — with the same `seen` trick as
the oracle — and then `Pending`. The returned map is always non-nil.

## Run it again

```bash
$ go test -run 'Stats' -v -count=1 ./internal/store
```

```text
...
--- PASS: TestMemoryStore_Stats_OverlappingTags (0.00s)
--- PASS: TestMemoryStore_Stats_MatchesOracle (0.00s)
    --- PASS: TestMemoryStore_Stats_MatchesOracle/empty_store (0.00s)
...
--- PASS: TestMemoryStore_Stats_LargeSetMatchesOracle (0.00s)
PASS
ok  	todo/internal/store	0.004s
```

Every test and subtest passes, each at 0.00s: the suite's only completion
signal is the pool's own close-and-range.

## Under the detector

A passing suite checks the answer; it cannot see the race itself. Two
unordered accesses can produce the right answer this run and the wrong one the
next, and the tests catch only the wrong one. The detector checks the
mechanism:

```bash
$ go test -race -count=1 ./internal/store
```

```text
ok  	todo/internal/store	1.020s
```

One second, and silence: the detector found no unsynchronized pair, because the
sharing was designed out rather than guarded. A clean run is evidence about
this run, not proof about the code — but the workers never touch the same
memory.

## If something went wrong

**Two helpers writing into the same summary.** The first draft most people
write counts into one shared `Stats`, with no partials:

```go
go func() {
	defer wg.Done()
	for _, t := range chunk {
		stats.Total++
		if t.Status == task.StatusDone {
			stats.Done++
		}
		for _, tag := range t.Tags {
			stats.ByTag[tag]++
		}
	}
}()
```

Every `++` is a read-modify-write: read the old number, add one, write it back.
Two helpers can read the same number and lose one increment. The detector opens
the run with:

<!-- transcripts: authored -->
```text
==================
WARNING: DATA RACE
Read at 0x00c0001369a0 by goroutine 26:
  todo/internal/store.(*MemoryStore).Stats.func1()
      /tmp/…/internal/store/stats.go:39 +0x184

Previous write at 0x00c0001369a0 by goroutine 25:
  todo/internal/store.(*MemoryStore).Stats.func1()
      /tmp/…/internal/store/stats.go:39 +0x199
...
==================
```

Both access sites are the same line — `stats.Total++` — hit by two helpers with
nothing ordering them. The map is worse: the runtime can find it mid-write and
end the process while the detector is still reporting:

```text
fatal error: concurrent map read and map write

goroutine 198 [running]:
...
FAIL	todo/internal/store	0.021s
FAIL
```

The fix is the design we shipped: one `Stats` per helper, handed over through
the channel, merged by the goroutine that ranges — no shared memory, nothing to
synchronize.

**`wg.Add(1)` in the wrong place.** Increment the counter inside the helper
instead of before the `go`:

```go
	for n := 1; n <= 4; n++ {
		go func() {
			wg.Add(1) // the counter race: Wait may already have seen zero
			defer wg.Done()
			partials <- n
		}()
	}
```

`Wait` can look at the counter before any helper has added to it: it sees zero
and returns, and the joiner closes the channel while a helper is still sending:

<!-- transcripts: authored -->
```text
panic: send on closed channel

goroutine 10 [running]:
main.main.func1()
	/tmp/…/addinside/main.go:15 +0xa5
created by main.main in goroutine 1
	/tmp/…/addinside/main.go:12 +0x98
```

The WaitGroup is not a counter you can fill in from anywhere: `Add` belongs
before `go`, so `Wait` cannot pass while a helper is unaccounted for.

**Forgetting `close`.** A pool whose joiner never closes the channel ranges
forever:

<!-- transcripts: authored -->
```text
fatal error: all goroutines are asleep - deadlock!

goroutine 1 [chan receive]:
main.main()
	/tmp/…/neverclose/main.go:12 +0xcd
exit status 2
```

`range` over a channel ends only when the channel is closed and drained.
Nothing closes this one, so the consumer blocks forever — and with every
goroutine blocked, the runtime ends the program. The goroutine that finishes
`wg.Wait()` calls `close`, after every helper has sent.

<details>
<summary>Going deeper: what a send actually promises</summary>

The detector's rule is called **happens-before**: a send is ordered before its
matching receive, `close` is ordered before the range that ends because of it,
and `wg.Wait()` returning is ordered after every `wg.Done()`. Those orderings
are why the merge can read a partial's map with no lock — the map was fully
built before the send. That is also why a clean detector run means something:
the ordering was built into the hand-off, not left to chance.

</details>

<details>
<summary>Going deeper: why four helpers, and why this isn't a speedup</summary>

Counting a list that already sits in memory is not slow work, and splitting it
four ways adds the cost of spawning helpers and handing partials over. The pool
is here because it is the safest place to learn the pattern: the work divides
cleanly, every piece is independent, and a plain sequential version checks the
whole answer. Later in the book the same pool learns to stop early, and a
separate batch runner, built for work that can fail, takes its size from the
caller.

</details>

<details>
<summary>Going deeper: the loop variable, and what Go changed</summary>

The first program's `i` deserves a second look: this exact loop used to be a
classic bug. Before Go 1.22, the `for` clause declared one `i` for the whole
loop, so all three closures captured it and printed the same final value:

```text
3
3
3
```

Since Go 1.22, each round declares its own `i`, so the numbers come out as
three distinct values in some order. The old workarounds are noise now.

</details>

The summary is done; next, the helpers learn to stop early when nobody is
waiting for the answer.
