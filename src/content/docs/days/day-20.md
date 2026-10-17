---
title: "Day 20 — Mutexes and atomics"
sidebar:
  order: 20
chapter: 17
---

**About 3 hours** · Part IV, day 4 of 5.

**You'll be able to:**

- guard shared state with a read-write lock and count with atomics;
- explain what a lock’s happens-before promise buys.

---

Every store call so far has happened one after another: a method starts, runs,
and finishes before the next begins. That was easy while one goroutine did all
the calling.

The store is the app's shared piece, and shared is what it becomes now. Our
tests will hammer one store from eight goroutines; the web API later will do
the same. Two goroutines touching the same value with no rule about who goes
first is the race the detector reported when our counting helpers shared one
summary — and this time we cannot design the sharing out: the store is one
list, and every caller needs the same one.

So we give it a rule. A lock makes goroutines take turns at the shared values;
a smaller tool counts the store's calls with no lock at all. By the end, eight
goroutines can add, list, count, and complete at once, and the detector stays
quiet.

## The race, in plain words

A **data race** is two goroutines using the same value at the same time, with
nothing deciding who goes first, and at least one of them writing. The
dangerous part is what that means: the program's behavior is undefined. The
same code can produce the right answer a thousand runs and lose a task on the
next.

`Add` writes two values — `s.nextID` and `s.tasks` — and `Complete` rewrites a
status. Run two of those at once and each write is a chance to overwrite
another goroutine's work. The `++` shows why: two goroutines can read the same
number, add one, and write it back, and one increment is lost.

The fix is to stop the overlap. A **mutex** — short for mutual exclusion,
"one at a time" — is a lock a goroutine takes before touching shared values
and releases when it is done. `sync.Mutex` is the plain version.

Our store is read-heavy: seven of its nine methods only read, and two readers
overlapping is harmless. `sync.RWMutex` is the lock for that shape — a
read-write lock: any number of readers may hold it together, while a writer
takes it alone, and once a writer is waiting for its turn, new readers wait
behind it. One field on the store: writers take it for writing, readers for
reading.

## Write the tests that hammer the store

The lock is the fix, but the tests come first. The first two compile against
the store as it is and fail for real — wrong answers, and race reports. The
third reads `Ops`, which does not exist yet.

Create `internal/store/concurrency_test.go`; the imports are the usual ones
plus `sync`:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
package store

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)
```

The first test starts eight writers, each adding twenty-five tasks. It sets
`writers = 8` and `addsPerWriter = 25`, builds the store, and keeps its own
tally — `succeeded := make([]int, writers)` — so a race report can only be
about the store. A single `close(start)` releases all eight at once; each
writer adds a task, runs two reads while others append, and completes it:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
	start := make(chan struct{})
	var wg sync.WaitGroup
	for w := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i := range addsPerWriter {
				added, err := s.Add(ctx, task.Task{
					Title: fmt.Sprintf("writer %d task %d", w, i),
					Tags:  []string{fmt.Sprintf("tag-%d", w)},
				})
				if !assert.NoError(t, err, "Add") {
					return
				}
				succeeded[w]++
				...
			}
		}()
	}
	close(start)
	wg.Wait()
```

The `...` hides the middle of each round:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
				// Mixed readers between the writes: List and Stats run
				// against a store another goroutine may be appending to.
				if _, err := s.List(ctx); !assert.NoError(t, err, "List") {
					return
				}
				if _, err := s.Stats(ctx); !assert.NoError(t, err, "Stats") {
					return
				}
				// Complete the writer's own add. It was appended before
				// Add returned, so a miss here is a lost write.
				if err := s.Complete(ctx, added.ID); !assert.NoError(t, err, "Complete own add") {
					return
				}
```

`Add` returned this task's ID before the writer completed it, so a miss means
a lost write. When all eight finish, the test checks the invariants:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
	added := 0
	for _, n := range succeeded {
		added += n
	}

	list, err := s.List(ctx)
	require.NoError(t, err)

	// Every successful Add is present, and no append overwrote another.
	assert.Len(t, list, added, "every add lands")
```

"Every add lands": the final list must be as long as the writers' combined
successes. Then the IDs:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
	// IDs are unique and cover 1..added: nothing was handed the same ID
	// twice and no ID was skipped.
	ids := make(map[int]bool, len(list))
	for _, got := range list {
		assert.False(t, ids[got.ID], "duplicate ID %d", got.ID)
		ids[got.ID] = true
		assert.Equal(t, task.StatusDone, got.Status, "writer completed its own add")
	}
	for id := 1; id <= added; id++ {
		assert.True(t, ids[id], "ID %d missing", id)
	}
}
```

Every ID must be unique and the set must cover `1..added`.

The second test is the shape that hangs if a read method calls another read
method while holding the read lock. It sets `readers = 4` and `adds = 200`,
makes `done := make(chan struct{})`, and creates `readerWG` and
`readersReady` with `readersReady.Add(readers)`, so the writer waits for the
readers before it starts. Each reader signals `readersReady.Done()` and loops
until `done` is closed:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
	for range readers {
		readerWG.Add(1)
		go func() {
			defer readerWG.Done()
			readersReady.Done()
			for {
				select {
				case <-done:
					return
				default:
				}
				tags, err := s.Tags(ctx)
				if !assert.NoError(t, err, "Tags") {
					return
				}
				assert.True(t, slices.IsSorted(tags), "Tags returns sorted tags")
```

Inside the same loop each reader checks the aggregate with
`stats, err := s.Stats(ctx)` and
`assert.Equal(t, stats.Total, stats.Done+stats.Pending)`, and the writer's
first move is `readersReady.Wait()`. The final assertions pin the answer: five
labels, 200 tasks, forty per label. The third test comes with the counter.

## Watch it fail

Run the suite:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.002s
--- FAIL: TestMemoryStore_ConcurrentOps (0.02s)
    concurrency_test.go:65:
        	Error:      	Received unexpected error:
        	            	complete task 172: task not found
        	Messages:   	Complete own add
    …
    concurrency_test.go:83:
        	Error:      	"[[Done] writer 7 task 0 ... writer 5 task 24]" should have 191 item(s), but has 189
        	Messages:   	every add lands
    …
    concurrency_test.go:94:
        	Error:      	Should be true
        	Messages:   	ID 172 missing
    …
FAIL
FAIL	todo/internal/store	0.020s
ok  	todo/internal/task	0.004s
FAIL
```

Eight writers each added twenty-five tasks and completed their own; 191 adds
returned success, but only 189 tasks survive. Two successful adds are gone
whole — one writer's `Complete` could not find its own task:
`complete task 172: task not found`. Success does not mean the task is there.

The tests check answers; the detector checks the mechanism:

```bash
$ go test -race -count=1 ./...
```

```text
==================
WARNING: DATA RACE
Read at 0x00c00007e8b8 by goroutine 30:
  todo/internal/store.(*MemoryStore).Add()
      …/internal/store/store.go:75 +0xa4
  todo/internal/store.TestMemoryStore_ConcurrentOps.func1()
      …/internal/store/concurrency_test.go:46 +0x3bd

Previous write at 0x00c00007e8b8 by goroutine 35:
  todo/internal/store.(*MemoryStore).Add()
      …/internal/store/store.go:75 +0xc4
  todo/internal/store.TestMemoryStore_ConcurrentOps.func1()
      …/internal/store/concurrency_test.go:46 +0x3bd
...
==================
```

`store.go:75` is `s.nextID++` in `Add`: two writers read the number, add one,
and write it back, and one write can vanish. The `...` hides each goroutine's
creation lines. Twenty-three reports follow — the append to `tasks`, the
status write in `Complete`, the copy in `List`, the label map read while
another call writes it. The two new tests are the provokers.

```text
--- FAIL: TestMemoryStore_ConcurrentReadersAndWriter (0.06s)
    testing.go:1712: race detected during execution of test
FAIL
FAIL	todo/internal/store	0.079s
ok  	todo/internal/task	1.012s
FAIL
```

The run ends in `FAIL`: a proven race fails the test that provoked it.

## Guard the store with one lock

Open `internal/store/store.go`. Add `"sync"` and `"sync/atomic"` to the
imports, and give the struct its two new fields:

<!-- verify: internal/store/store.go at=sync-primitives -->
```go title="internal/store/store.go"
// MemoryStore is an in-memory task list. The zero value is not usable; build
// one with NewMemoryStore. All methods are safe for concurrent use.
type MemoryStore struct {
	// mu guards tasks and nextID. Every exported method acquires it once —
	// the read methods for reading, the mutators for writing — and no
	// method ever acquires it again while holding it: composition goes
	// through the *Locked helpers, which assume the caller holds mu and
	// never touch it. See Tags for the deadlock that rule prevents.
	mu sync.RWMutex

	tasks  []task.Task
	nextID int

	// ops counts the public operations observed since creation. It is
	// atomic rather than guarded by mu: an increment is one lock-free word
	// operation on a field no other code touches, and a call that fails at
	// entry still counts, because the counter measures calls observed, not
	// work done. Reads go through Ops.
	ops atomic.Int64
}
```

`mu` is the lock; its comment is the rule for the whole file: every public
method takes it once, and the helpers never take it. `ops` is the counter,
sitting outside the lock on purpose.

`Add` takes the lock for writing. The order of the new lines matters:

<!-- verify: internal/store/store.go at=sync-primitives -->
```go title="internal/store/store.go"
func (s *MemoryStore) Add(ctx context.Context, t task.Task) (task.Task, error) {
	s.ops.Add(1)
	if err := ctxErr(ctx, "add task"); err != nil {
		return task.Task{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	t.ID = s.nextID
	s.tasks = append(s.tasks, t)
	return t, nil
}
```

The count goes first, before the context check, so a call that fails at entry
still counts — the counter's contract. The check runs next, then `s.mu.Lock()`
takes the lock, and `defer s.mu.Unlock()` gives it back on every path out —
including the `return` inside `Complete`'s loop.

The readers take the read lock the same way. `List` shows the shape, and its
body moves into a helper:

<!-- verify: internal/store/store.go at=sync-primitives -->
```go title="internal/store/store.go"
func (s *MemoryStore) List(ctx context.Context) ([]task.Task, error) {
	s.ops.Add(1)
	if err := ctxErr(ctx, "list tasks"); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listLocked(), nil
}

// listLocked returns a copy of the task slice. The caller must hold mu, for
// reading or writing; like every *Locked helper it never acquires the lock,
// which is what keeps an exported method from re-entering mu.
func (s *MemoryStore) listLocked() []task.Task {
	return slices.Clone(s.tasks)
}
```

`listLocked` is the old body of `List` — the copy — split out so other
methods can use it under a lock they already hold. Its comment states the
rule: the caller holds `mu`, and the helper never takes it.

That rule matters most in the label listing:

<!-- verify: internal/store/store.go at=sync-primitives -->
```go title="internal/store/store.go"
func (s *MemoryStore) Tags(ctx context.Context) ([]string, error) {
	s.ops.Add(1)
	if err := ctxErr(ctx, "list tags"); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return slices.Sorted(maps.Keys(s.countByTagLocked())), nil
}
```

The label listing used to delegate to the exported `CountByTag`. With both
now taking the read lock, that call would nest one read lock inside another,
and nesting read locks can deadlock: read locks normally share, but once a
writer is waiting for its turn, new readers wait behind it.

Picture the trap: the listing holds a read lock and calls the counting
method, which asks for a second read lock; a writer then queues for the write
lock. The writer waits for the listing, the listing waits for the second read
lock, and the second read lock waits for the writer. The fix is the helper:
`countByTagLocked` is the same counting code with no lock of its own, so the
listing takes the lock exactly once.

`SortByDue` and `Stats` hold the lock for their copy only, then let go before
the real work:

<!-- verify: internal/store/store.go at=sync-primitives -->
```go title="internal/store/store.go"
	// The lock covers the copy only, and the unlock is explicit rather than
	// deferred to show the scope: the sort below reads the private copy and
	// never touches s.tasks, so holding the read lock through an
	// O(n log n) sort would only delay the next writer. Nothing between
	// here and the return can acquire mu again.
	s.mu.RLock()
	sorted := s.listLocked()
	s.mu.RUnlock()
```

The sort reads the private copy, so holding the read lock through it would
only delay the next writer. `Stats` releases the same way before starting its
workers:

<!-- verify: internal/store/stats.go at=sync-primitives -->
```go title="internal/store/stats.go"
func (s *MemoryStore) Stats(ctx context.Context) (Stats, error) {
	s.ops.Add(1)
	...
	if err := ctxErr(ctx, "stats"); err != nil {
		return Stats{}, err
	}

	// Snapshot first, under the read lock, so the copy is one consistent
	// instant. The snapshot goes through listLocked rather than List: Stats
	// takes the lock once itself, and delegating to an exported method
	// would count a second operation. The lock covers the copy only — the
	// workers only ever read their own copy, and holding the read lock
	// across the fold would only delay the next writer.
	s.mu.RLock()
	tasks := s.listLocked()
	s.mu.RUnlock()
```

The remaining readers get the same four lines:
`s.ops.Add(1)`, the context check, `s.mu.RLock()`, `defer s.mu.RUnlock()`.
`Complete` takes the write lock exactly as `Add` does, and the store's doc
comment now says what this bought: *All methods are safe for concurrent use.*

## Count the calls without a lock

The store keeps one more number: how many calls it has observed, read through
`Ops()`. A lock could guard it, but the count is one whole number, and
`sync/atomic` has a type for exactly that. An **atomic** operation happens
all at once — no other goroutine can see it half-finished — so an
`atomic.Int64` can be bumped and read with no lock and no lost updates.

`Ops` is three lines:

<!-- verify: internal/store/store.go at=sync-primitives -->
```go title="internal/store/store.go"
// Ops reports how many public operations the store has observed since it was
// ...
func (s *MemoryStore) Ops() int64 {
	return s.ops.Load()
}
```

Sequential callers get exact counts: after k calls have returned, `Ops` reads
k. Concurrent callers do not: while calls are in flight, a read is a snapshot
of a moving number. The counter sits outside `mu` on purpose — the guarded
fields share one story, the count belongs to neither, and an increment is one
word that cannot be seen half-done.

The third test pins both edges, one table entry per call, added to
`concurrency_test.go`:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
func TestMemoryStore_Ops(t *testing.T) {
	t.Parallel()

	s := NewMemoryStore()
	ctx := context.Background()

	assert.Zero(t, s.Ops(), "a fresh store has observed no operations")
	assert.Zero(t, s.Ops(), "Ops is a read, not an operation")

	// One table entry is one call, so after the i-th call the counter must
	// read i.
	calls := []struct {
		name string
		call func() error
	}{
		{"Add", func() error {
			_, err := s.Add(ctx, task.Task{Title: "one", Tags: []string{"go"}})
			return err
		}},
		{"List", func() error { _, err := s.List(ctx); return err }},
		...
	}

	for i, c := range calls {
		require.NoError(t, c.call(), c.name)
		assert.Equal(t, int64(i+1), s.Ops(), "%s counts exactly once", c.name)
	}
```

After the i-th call, the counter must read exactly i. The `...` hides the
other seven entries; then the two edges a table alone cannot show:

<!-- verify: internal/store/concurrency_test.go at=sync-primitives -->
```go title="internal/store/concurrency_test.go"
	// A call that fails at entry is still an operation the store observed:
	// the increment happens before the context check.
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err := s.List(canceled)
	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, int64(len(calls)+1), s.Ops(), "a canceled call still counts")

	// Stats composes from listLocked, not from List/CountByTag, so one
	// Stats call is still one operation.
	before := s.Ops()
	_, err = s.Stats(ctx)
	require.NoError(t, err)
	assert.Equal(t, before+1, s.Ops(), "Stats does not count its internals")
}
```

The first edge: a call that fails at entry still counts, because the
increment happens before the context check. The second: one `Stats` call is
one operation, even though it takes a lock and starts workers underneath. The
check also guards the re-entrancy rule — a `Stats` that called the exported
`List` would count twice.

## Run it again

Run the three new tests by name:

```bash
$ go test -v -count=1 -run 'TestMemoryStore_ConcurrentOps|TestMemoryStore_ConcurrentReadersAndWriter|TestMemoryStore_Ops' ./internal/store
```

```text
=== RUN   TestMemoryStore_ConcurrentOps
…
--- PASS: TestMemoryStore_Ops (0.00s)
--- PASS: TestMemoryStore_ConcurrentReadersAndWriter (0.00s)
--- PASS: TestMemoryStore_ConcurrentOps (0.01s)
PASS
ok  	todo/internal/store	0.008s
```

All three pass. `ConcurrentOps` at 0.01s is 200 adds, 200 lists, 200 stats,
and 200 completes from eight goroutines, and the assertions after `wg.Wait()`
see every one — `Wait` returning is ordered after every helper's `Done`.

The whole suite, plain and then under the detector:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.002s
ok  	todo/internal/store	0.009s
ok  	todo/internal/task	0.003s
```

```bash
$ go test -race -count=1 ./...
```

```text
ok  	todo/cmd/todo	1.013s
ok  	todo/internal/store	1.035s
ok  	todo/internal/task	1.012s
```

The detector instruments every memory access, so the suite takes about a
second — and it says nothing. Silence means no unsynchronized pair was
observed in this run; it is evidence, not proof, which is why the tests also
assert the invariants after everyone finishes.

## If something went wrong

**`go vet` says the lock was copied.** A struct carrying a lock must not be
copied after first use: two copies mean two locks guarding the same fields.
`go vet` reports it when a helper takes the store by value:

```text
main.go:11:17: snapshot passes lock by value: vetlab.store contains sync.Mutex
main.go:17:15: call of snapshot copies lock value: vetlab.store contains sync.Mutex
```

The fix: pass pointers. Every `MemoryStore` method has a pointer receiver, so
our code cannot make the copy; `Task` and `Stats` carry no locks.

**`panic: test timed out after 5s` — the lock taken twice.** A read method
that calls another read method while holding the read lock can deadlock the
moment a writer queues behind it. The test does not fail with a message; it
hangs until the runner's timeout turns it into this:

```text
panic: test timed out after 5s
	running tests:
		TestTrap (5s)
```

The full stack dump is in the first box below. The fix: compose from the
`...Locked` helpers, never calling a sibling while holding the lock.

**The exact count, asserted too early.** A test that reads `Ops` mid-flight
asks for a total the program has not earned:

```text
--- FAIL: TestOpsExactCountMidFlight (0.00s)
    count_test.go:24:
        	Error:      	Not equal:
        	            	expected: 1000
        	            	actual  : 0
        	Messages:   	the count after 1000 calls
```

The value is a snapshot, so it varies — 0 in this run, 37 in the next, 1000
only by accident. Synchronize first: `wg.Wait()` is an ordering edge, so
after it returns every write is visible. Then the assertion is a contract,
not a lottery.

<details>
<summary>Going deeper: why a read lock must not call another read lock</summary>

The `sync.RWMutex` docs state the rule the trap turns on:

> If any goroutine calls RWMutex.Lock while the lock is already held by one
> or more readers, concurrent calls to RWMutex.RLock will block until the
> writer has acquired (and released) the lock... Note that this prohibits
> recursive read-locking.

The last sentence is the one that bites: read locks do not nest safely. A
throwaway program with the naive shape — every method takes the read lock,
and the label listing calls the counting method while holding its own — hangs
under four readers and one writer; the timeout turns the hang into a stack
dump:

<!-- transcripts: authored -->
```text
goroutine 7 [sync.RWMutex.Lock]:
…
rlocktrap.TestTrap(0xb51741dc248?)
	/tmp/…/trap_test.go:59 +0x11c
…

goroutine 8 [sync.RWMutex.RLock]:
…
rlocktrap.(*store).CountByTag(0xb51741b6600)
	/tmp/…/trap_test.go:17 +0x4a
rlocktrap.(*store).Tags(0x0?)
	/tmp/…/trap_test.go:30 +0x9e
rlocktrap.TestTrap.func1()
	/tmp/…/trap_test.go:53 +0x65
…
```

One reader sits blocked in the second read lock, still holding the listing's
first; the writer sits in `Lock`, waiting for every reader to release, and
every other reader queues behind it. Nobody can move — a true deadlock, not a
slowdown. The store cannot reach this state: the listing composes from
`countByTagLocked`, which never takes anything.

</details>

<details>
<summary>Going deeper: what a lock promises the next goroutine</summary>

A lock does two jobs: it keeps goroutines from overlapping, and it hands the
next caller everything the last one finished. The memory model writes the
second job as an ordering: the n-th unlock is ordered before the m-th lock of
the same lock, for n < m.

So every write `Add` made before releasing is visible to whichever goroutine
locks next — the same kind of edge a channel send gives its receive. That is
also why the detector's verdict is lopsided: a report proves a real race,
while a clean run is only the absence of reports for the interleavings that
occurred.

</details>

The store is safe to share now; next, a whole batch of work learns to run
through a limited number of helpers at once — and to stop together on the
first failure.

<div class="day-tracker" data-day="20"></div>
