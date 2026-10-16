---
title: "internal/store — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/appendices/the-finished-app/).


## `internal/store/batch.go`

````go
package store

import (
	"context"
	"fmt"
	"runtime"

	"golang.org/x/sync/errgroup"

	"todo/internal/task"
)

// Process applies fn to every task in the store, running at most limit
// functions concurrently. The first error — from fn or from ctx — stops new
// work from being scheduled and is returned wrapped so errors.Is finds it.
// limit < 1 means GOMAXPROCS.
//
// The batch rides on an errgroup.Group. WithContext derives the context the
// group cancels when a call returns non-nil; SetLimit bounds how many calls
// may be in flight; Wait returns the first error and blocks until every
// started call has returned, so stopping early never leaks a goroutine. The
// task list is one List snapshot, taken before any worker starts.
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
````


## `internal/store/batch_test.go`

````go
package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
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

// TestProcess_VisitsEveryTaskOnce pins the happy path: a live context and an
// fn that never errors visit every task in the store exactly once. Process
// runs fn from several goroutines, so the visited slice is shared state and
// appending to it needs a mutex — the unlocked-append race chapter 17's red
// showed on the store's own slice would otherwise reappear here in the test's
// bookkeeping. After Process returns, every append has a happens-before edge
// to the assertions through Wait, so sorting and comparing are safe.
func TestProcess_VisitsEveryTaskOnce(t *testing.T) {
	t.Parallel()

	const (
		tasks = 20
		limit = 4
	)
	s := mustStore(t, batchTasks(tasks)...)

	var (
		mu      sync.Mutex
		visited []string
	)
	err := Process(context.Background(), s, limit, func(t task.Task) error {
		mu.Lock()
		defer mu.Unlock()
		visited = append(visited, t.ID.String())
		return nil
	})
	require.NoError(t, err)

	// The expectation is the store's own id set, sorted the same way: every
	// task was visited exactly once and no id was invented.
	list, err := s.List(context.Background())
	require.NoError(t, err)
	want := make([]string, len(list))
	for i, tt := range list {
		want[i] = tt.ID.String()
	}
	slices.Sort(visited)
	slices.Sort(want)
	assert.Equal(t, want, visited, "every task visited exactly once")
}

// TestProcess_LimitBoundsConcurrency proves the concurrency ceiling with
// start and release gates instead of a clock. Every fn signals on started and
// then parks on release, so nothing advances until the test says so; with the
// limit in force the third g.Go is blocked on the group's semaphore while the
// first two calls are parked, which is why exactly two starts can have
// happened. The non-blocking check below cannot be overtaken by a late third:
// a third start is impossible until a release, so there is nothing to wait
// for. A time-based version of this test would guess a delay and fail on a
// loaded machine.
func TestProcess_LimitBoundsConcurrency(t *testing.T) {
	t.Parallel()

	const (
		limit = 2
		tasks = 5
	)
	s := mustStore(t, batchTasks(tasks)...)

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

	close(release)
	require.NoError(t, <-done)

	// The remaining tasks ran once the release unblocked the parked calls,
	// and every send happened before Process returned, so draining the
	// buffer now is deterministic.
	assert.Len(t, started, tasks-limit, "every held-back call ran after the release")
}

// TestProcess_FirstErrorStopsScheduling pins the fail-fast contract. limit=1
// serializes the batch — the next fn cannot start before the previous one
// returned — so no gate is needed to make the ordering deterministic: when
// the first call returns errBoom, the group context is canceled before the
// next call is allowed to start, and the check ahead of fn turns the second
// task away. errors.Is finds the sentinel through the group's return path, so
// the identity survives the whole trip.
func TestProcess_FirstErrorStopsScheduling(t *testing.T) {
	t.Parallel()

	errBoom := errors.New("boom")
	s := mustStore(t, batchTasks(3)...)
	list, err := s.List(context.Background())
	require.NoError(t, err)
	firstID := list[0].ID

	var (
		mu    sync.Mutex
		calls []uuid.UUID
	)
	err = Process(context.Background(), s, 1, func(t task.Task) error {
		mu.Lock()
		calls = append(calls, t.ID)
		mu.Unlock()
		if t.ID == firstID {
			return errBoom
		}
		return nil
	})

	require.ErrorIs(t, err, errBoom)
	assert.Equal(t, []uuid.UUID{firstID}, calls, "the first error stops the next call")
}

// TestProcess_PreCanceledContextRunsNothing pins the entry check: an
// already-done context returns its error — context.Canceled here — and never
// calls fn, not even once. The check sits before List, so a canceled batch
// does not touch the store at all. Mid-flight cancellation is deliberately
// not asserted here: it is a race by nature, and the deterministic form of
// that behavior belongs to the gates above.
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

// TestProcess_NonPositiveLimitUsesGOMAXPROCS pins the default: limit < 1 is
// not an error and not "no limit" — it means GOMAXPROCS — so the batch still
// completes. The test asserts completion only: the default is a property of
// the machine, and pinning a concurrency count would pin the runtime's
// setting, not Process's contract.
func TestProcess_NonPositiveLimitUsesGOMAXPROCS(t *testing.T) {
	t.Parallel()

	for _, limit := range []int{0, -1} {
		t.Run(fmt.Sprintf("limit=%d", limit), func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, batchTasks(5)...)

			var (
				mu      sync.Mutex
				visited map[uuid.UUID]bool
			)
			visited = make(map[uuid.UUID]bool)
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
````


## `internal/store/bench_test.go`

````go
package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"todo/internal/task"
)

// benchSizes are the store sizes the size-scaled benchmarks run at. The
// sub-benchmark names ("n=100", "n=10000") are stable so benchstat can pair
// runs across commits.
var benchSizes = []int{100, 10000}

// benchTags is the fixed tag pool the seeding helper draws from.
var benchTags = []string{"go", "book", "urgent", "home", "work"}

// benchBase is the fixed reference date for seeded due dates. The seeding
// helper never reads the clock, so every run seeds the same tasks.
var benchBase = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

// benchCtx is the context every benchmarked call receives. It is never done,
// so it adds no cancellation case to the code under measurement; the loops
// still check each error, because a benchmark that swallowed one could report
// numbers for a call that no longer works.
var benchCtx = context.Background()

// benchSink keeps the results of the benchmarked calls reachable. Writing to
// a package-level variable the compiler cannot see through is what keeps the
// calls under measurement from being optimized away.
var benchSink struct {
	task   task.Task
	tasks  []task.Task
	counts map[string]int
	tags   []string
}

// benchTask builds the i-th task of the seeding pattern: the status cycles
// between Todo and Done, every other task has a due date, and most tasks
// carry tags from the small pool — with repeats, so CountByTag must
// deduplicate within a task.
func benchTask(i int) task.Task {
	t := task.Task{
		Title:  fmt.Sprintf("task-%05d", i),
		Status: task.StatusTodo,
	}
	if i%3 == 0 {
		t.Status = task.StatusDone
	}
	if i%2 == 0 {
		t.Due = benchBase.AddDate(0, 0, i%60)
	}
	if i%7 != 0 {
		first := benchTags[i%len(benchTags)]
		t.Tags = []string{first, benchTags[(i+1)%len(benchTags)]}
		if i%5 == 0 {
			t.Tags = append(t.Tags, first)
		}
	}
	return t
}

// seedStore returns a store holding n tasks built by benchTask, in insertion
// order, each with a store-assigned id. benchCtx is never done, so Add
// cannot report an error here; a panic would mean the store's own contract
// broke, which no benchmark can measure.
func seedStore(n int) *MemoryStore {
	s := NewMemoryStore()
	for i := range n {
		if _, err := s.Add(benchCtx, benchTask(i)); err != nil {
			panic(err)
		}
	}
	return s
}

func BenchmarkAdd(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			s := seedStore(n)
			t := benchTask(n)
			b.ReportAllocs()
			// Seeding above happened inside the timed region; drop it.
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				got, err := s.Add(benchCtx, t)
				if err != nil {
					b.Fatal(err)
				}
				benchSink.task = got
			}
		})
	}
}

func BenchmarkList(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				got, err := s.List(benchCtx)
				if err != nil {
					b.Fatal(err)
				}
				benchSink.tasks = got
			}
		})
	}
}

func BenchmarkByStatus(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				got, err := s.ByStatus(benchCtx, task.StatusTodo)
				if err != nil {
					b.Fatal(err)
				}
				benchSink.tasks = got
			}
		})
	}
}

func BenchmarkByTag(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				got, err := s.ByTag(benchCtx, benchTags[0])
				if err != nil {
					b.Fatal(err)
				}
				benchSink.tasks = got
			}
		})
	}
}

func BenchmarkSortByDue(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				got, err := s.SortByDue(benchCtx)
				if err != nil {
					b.Fatal(err)
				}
				benchSink.tasks = got
			}
		})
	}
}

func BenchmarkCountByTag(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				got, err := s.CountByTag(benchCtx)
				if err != nil {
					b.Fatal(err)
				}
				benchSink.counts = got
			}
		})
	}
}

func BenchmarkTags(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				got, err := s.Tags(benchCtx)
				if err != nil {
					b.Fatal(err)
				}
				benchSink.tags = got
			}
		})
	}
}
````


## `internal/store/concurrency_test.go`

````go
package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)

// TestMemoryStore_ConcurrentOps hammers one store from writers that mix all
// four operation shapes — Add, List, Stats, Complete — and then checks the
// invariants that surviving concurrency must not have broken: every
// successful Add is in the final List, every ID the store handed out is
// unique, and every task its own writer completed is done. While the store
// was unlocked, the race detector reported this test: the writers race on
// nextID, on the tasks slice header, and on each task's Status.
func TestMemoryStore_ConcurrentOps(t *testing.T) {
	t.Parallel()

	const (
		writers       = 8
		addsPerWriter = 25
	)
	s := NewMemoryStore()
	ctx := context.Background()

	// Each writer counts its own successful adds and only its own: the
	// test's bookkeeping shares nothing, so a -race report can only be
	// about the store.
	succeeded := make([]int, writers)

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

				// Mixed readers between the writes: List and Stats run
				// against a store another goroutine may be appending to.
				if _, err := s.List(ctx); !assert.NoError(t, err, "List") {
					return
				}
				if _, err := s.Stats(ctx); !assert.NoError(t, err, "Stats") {
					return
				}
				// Complete the writer's own add, with the version Add
				// returned: the snapshot is current, so the CAS must win.
				if err := s.Complete(ctx, added.ID, added.Version); !assert.NoError(t, err, "Complete own add") {
					return
				}
			}
		}()
	}
	close(start)
	wg.Wait()

	added := 0
	for _, n := range succeeded {
		added += n
	}

	list, err := s.List(ctx)
	require.NoError(t, err)

	// Every successful Add is present, and no append overwrote another.
	assert.Len(t, list, added, "every add lands")

	// IDs are unique: nothing was handed the same ID twice. The ids are v7
	// values, so there is no 1..added range to cover — uniqueness is the
	// whole promise.
	ids := make(map[uuid.UUID]bool, len(list))
	for _, got := range list {
		assert.False(t, ids[got.ID], "duplicate ID %s", got.ID)
		ids[got.ID] = true
		assert.Equal(t, task.StatusDone, got.Status, "writer completed its own add")
	}
}

// TestMemoryStore_ConcurrentReadersAndWriter keeps every reader busy on Tags
// and Stats while the only writer adds. This is the shape that hangs if a
// read method ever calls another read method: a Tags holding RLock and
// calling the locked CountByTag would wait for a writer that is already
// queued behind Tags' own RLock — Go's RWMutex makes a waiting writer block
// new readers — and that writer waits for the lock Tags already holds. The
// store composes from the *Locked helpers instead, so the loop keeps making
// progress.
func TestMemoryStore_ConcurrentReadersAndWriter(t *testing.T) {
	t.Parallel()

	const (
		readers = 4
		adds    = 200
	)
	s := NewMemoryStore()
	ctx := context.Background()

	done := make(chan struct{})
	var readerWG sync.WaitGroup
	// Every reader signals from inside its goroutine after it has entered
	// the loop, so the writer only starts once the readers are hammering.
	// Without the gate the writer can finish before a reader is ever
	// scheduled, and the test would stress nothing.
	var readersReady sync.WaitGroup
	readersReady.Add(readers)
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
				stats, err := s.Stats(ctx)
				if !assert.NoError(t, err, "Stats") {
					return
				}
				assert.Equal(t, stats.Total, stats.Done+stats.Pending)
			}
		}()
	}

	// The main goroutine is the writer. Any error must still close done, or
	// the readers would spin until the test times out instead of failing.
	readersReady.Wait()
	var addErr error
	for i := range adds {
		_, err := s.Add(ctx, task.Task{
			Title: fmt.Sprintf("task %03d", i),
			Tags:  []string{fmt.Sprintf("tag-%d", i%5)},
		})
		if err != nil {
			addErr = err
			break
		}
	}
	close(done)
	readerWG.Wait()
	require.NoError(t, addErr)

	tags, err := s.Tags(ctx)
	require.NoError(t, err)
	assert.Equal(t, []string{"tag-0", "tag-1", "tag-2", "tag-3", "tag-4"}, tags)

	stats, err := s.Stats(ctx)
	require.NoError(t, err)
	assert.Equal(t, adds, stats.Total)
	assert.Equal(t, adds/len(tags), stats.ByTag["tag-0"])
}

// TestMemoryStore_Ops pins the counter's contract: every public method
// increments it exactly once, on entry, and Ops itself does not increment.
// The test is sequential on purpose — concurrent callers cannot assert exact
// counts, which is what Ops documents — and it counts its own calls by hand,
// one table entry per call.
func TestMemoryStore_Ops(t *testing.T) {
	t.Parallel()

	s := NewMemoryStore()
	ctx := context.Background()

	assert.Zero(t, s.Ops(), "a fresh store has observed no operations")
	assert.Zero(t, s.Ops(), "Ops is a read, not an operation")

	// One table entry is one call, so after the i-th call the counter must
	// read i. The Add case records the id and version it was handed, and
	// Complete completes that same task with them, so every call in the
	// table succeeds.
	var addedID uuid.UUID
	var addedVersion int
	calls := []struct {
		name string
		call func() error
	}{
		{"Add", func() error {
			got, err := s.Add(ctx, task.Task{Title: "one", Tags: []string{"go"}})
			addedID = got.ID
			addedVersion = got.Version
			return err
		}},
		{"List", func() error { _, err := s.List(ctx); return err }},
		{"ByStatus", func() error { _, err := s.ByStatus(ctx, task.StatusTodo); return err }},
		{"ByTag", func() error { _, err := s.ByTag(ctx, "go"); return err }},
		{"CountByTag", func() error { _, err := s.CountByTag(ctx); return err }},
		{"Tags", func() error { _, err := s.Tags(ctx); return err }},
		{"SortByDue", func() error { _, err := s.SortByDue(ctx); return err }},
		{"Complete", func() error { return s.Complete(ctx, addedID, addedVersion) }},
		{"Stats", func() error { _, err := s.Stats(ctx); return err }},
	}

	for i, c := range calls {
		require.NoError(t, c.call(), c.name)
		assert.Equal(t, int64(i+1), s.Ops(), "%s counts exactly once", c.name)
	}

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

// TestConcurrentUpdates_Conflict is the lost-update scenario in miniature:
// two writers read the same task and both hold the same version, so the
// first Complete wins the compare-and-swap and the second is rejected as
// stale instead of silently overwriting the winner. Which writer wins is the
// scheduler's choice; what is deterministic is that exactly one wins, the
// other sees ErrConflict, and the stored task shows the winner's state with
// the version bumped exactly once. The same scenario runs against both
// stores because the guarantee is the Store contract's, not one
// implementation's.
func TestConcurrentUpdates_Conflict(t *testing.T) {
	t.Parallel()

	newStores := map[string]func(t *testing.T) Store{
		"MemoryStore": func(*testing.T) Store {
			return NewMemoryStore()
		},
		"TursoStore": func(t *testing.T) Store {
			s, err := NewTursoStore(context.Background(), tursoStorePath(t))
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, s.Close()) })
			return s
		},
	}

	for name, newStore := range newStores {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			ctx := context.Background()
			s := newStore(t)
			added, err := s.Add(ctx, task.Task{Title: "write tests", Status: task.StatusTodo})
			require.NoError(t, err)

			// Both writers read the same task before either writes: the
			// same id and the same version, read twice.
			firstRead, err := s.List(ctx)
			require.NoError(t, err)
			secondRead, err := s.List(ctx)
			require.NoError(t, err)
			require.Len(t, firstRead, 1)
			require.Len(t, secondRead, 1)
			a, b := firstRead[0], secondRead[0]
			require.Equal(t, a.Version, b.Version)

			start := make(chan struct{})
			results := make(chan error, 2)
			for _, snapshot := range []task.Task{a, b} {
				go func() {
					<-start
					results <- s.Complete(ctx, snapshot.ID, snapshot.Version)
				}()
			}
			close(start)

			var winners, conflicts int
			for range 2 {
				switch err := <-results; {
				case err == nil:
					winners++
				case errors.Is(err, ErrConflict):
					conflicts++
				default:
					t.Errorf("unexpected Complete error: %v", err)
				}
			}
			assert.Equal(t, 1, winners, "exactly one writer wins the compare-and-swap")
			assert.Equal(t, 1, conflicts, "the stale writer is rejected")

			// No lost update: the winner's write is what the store holds,
			// and the version moved exactly once.
			list, err := s.List(ctx)
			require.NoError(t, err)
			require.Len(t, list, 1)
			assert.Equal(t, task.StatusDone, list[0].Status)
			assert.Equal(t, added.Version+1, list[0].Version)
		})
	}
}
````


## `internal/store/conformance_test.go`

````go
// Package store_test is the external test package that runs the store
// conformance suite against every Store implementation. It must be external:
// the suite package imports todo/internal/store, so an internal test file of
// package store importing the suite would be an import cycle.
package store_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/store/storetest"
)

// TestStoreConformance runs one suite body against both implementations. A
// failure here names the implementation and the case, so the two stores are
// held to the same contract by the same assertions.
func TestStoreConformance(t *testing.T) {
	t.Run("MemoryStore", func(t *testing.T) {
		storetest.Run(t, func(t *testing.T) store.Store {
			return store.NewMemoryStore()
		})
	})

	t.Run("TursoStore", func(t *testing.T) {
		storetest.Run(t, func(t *testing.T) store.Store {
			// A file database, not :memory: — the conformance contract
			// should hold for the store's real deployment shape, and each
			// subtest gets its own file inside its own temp directory.
			s, err := store.NewTursoStore(context.Background(), filepath.Join(t.TempDir(), "tasks.db"))
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, s.Close()) })
			seedOwners(t, s, storetest.OwnerA, storetest.OwnerB)
			return s
		})
	})
}

// seedOwners inserts the user rows the suite's scoping cases own tasks with.
// The schema's owner_id foreign key requires a task's owner to exist, and the
// suite seeds through the Store contract only — which does not know users —
// so the two rows arrive here, in the one place that holds the database. The
// memory store has no schema to satisfy, which is why only this constructor
// seeds.
func seedOwners(t *testing.T, s *store.TursoStore, ids ...uuid.UUID) {
	t.Helper()
	for i, id := range ids {
		_, err := s.DB().Exec(
			`INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
			id.String(), fmt.Sprintf("owner-%d@example.com", i), "not-a-real-hash", time.Now().Unix(),
		)
		require.NoError(t, err)
	}
}
````


## `internal/store/export.go`

````go
package store

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"todo/internal/task"
)

// exportVersion is the schema version the interchange format carries. Writing
// the field is not enough to make it a contract: the reader checks it, so a
// document that claims a schema this package does not know is refused before
// a single task is added instead of being misread as a newer one. Version 1
// was the integer-id era; version 2 is the UUID era, whose ids ride uuid's
// canonical string form; version 3 adds the task version, the value the
// optimistic-concurrency writes compare against. The loader is strict to the
// current version — it opens a live store, and a document it does not
// understand must fail loudly — while the importer reads every version back
// to 1 and maps each shape forward.
const exportVersion = 3

// exportDoc is the interchange envelope: a schema version and the task set,
// in that order. Neither direction marshals this struct whole — ExportJSON
// writes the header and one task at a time, ImportJSON walks the same fields
// with a json.Decoder — so the type is the format's single declared
// spelling: the writer's hand-written header and the reader's field checks
// are pinned against it, and the tests decode whole documents into it. Its
// field names are the JSON names task.Task already carries; the document is
// the domain type.
type exportDoc struct {
	Version int         `json:"version"` // 3
	Tasks   []task.Task `json:"tasks"`
}

// ExportJSON writes s's tasks to w as a version-3 interchange document: one
// JSON object, {"version":3,"tasks":[...]}, compact, tasks in insertion
// order. The document streams: the envelope's opening is written first, then
// each task is marshaled and written on its own, then the closing brackets.
// Nothing ever holds the whole document as one []byte — the memory-thread
// rule this shape follows is that peak encoding memory is one task, not one
// document, however many tasks the store holds — and the bufio.Writer in
// front of w keeps the many small writes from becoming many syscalls. On a
// write error the bytes already written stay written; streaming is what
// makes that the caller's visible state, and a caller that must not keep a
// partial document is the one that writes to a temp file first (see
// WriteExportFile).
//
// The store is read once, through List, before the first byte is written, so
// a concurrent mutation is not part of this document. A done ctx is reported
// by wrapping context.Cause(ctx), before any output.
func ExportJSON(ctx context.Context, s Store, w io.Writer) error {
	if err := ctxErr(ctx, "export tasks"); err != nil {
		return err
	}
	tasks, err := s.List(ctx)
	if err != nil {
		return fmt.Errorf("export tasks: %w", err)
	}

	bw := bufio.NewWriter(w)
	if _, err := fmt.Fprintf(bw, `{"version":%d,"tasks":[`, exportVersion); err != nil {
		return fmt.Errorf("export tasks: %w", err)
	}
	for i, t := range tasks {
		if i > 0 {
			if err := bw.WriteByte(','); err != nil {
				return fmt.Errorf("export tasks: %w", err)
			}
		}
		// One task at a time: Marshal returns one task's bytes, which are
		// written and dropped before the next task is touched. The whole
		// document is never materialized, which is the point of the shape.
		data, err := json.Marshal(t)
		if err != nil {
			return fmt.Errorf("export tasks: task %d: %w", i, err)
		}
		if _, err := bw.Write(data); err != nil {
			return fmt.Errorf("export tasks: %w", err)
		}
	}
	if _, err := bw.WriteString("]}"); err != nil {
		return fmt.Errorf("export tasks: %w", err)
	}
	if err := bw.Flush(); err != nil {
		return fmt.Errorf("export tasks: %w", err)
	}
	return nil
}

// WriteExportFile writes the interchange document for s to path in one
// visible step. The document streams into a fresh temp file in path's own
// directory, that file is synced, closed, chmodded 0644, and renamed over
// path: a reader of path sees the previous document or the new one, never a
// half-written one, and every failure before the rename removes the temp and
// leaves whatever was at path exactly as it was.
//
// The temp must live in the same directory because rename does not cross
// filesystems: /tmp is usually a different mount, and os.Rename across
// mounts fails with EXDEV rather than copying. Same directory, same
// filesystem, one rename. Sync pushes the bytes to the device before the
// rename publishes them, so a crash after the rename cannot expose a name
// pointing at unwritten content; it does not sync the directory entry the
// rename created, so a crash in that window can revert to the old document —
// still a whole document, which is the invariant this function promises. The
// chmod undoes CreateTemp's 0600 because the rename carries the temp file's
// permissions to the destination; without it, the export file would become
// owner-only the first time it was rewritten.
func WriteExportFile(ctx context.Context, s Store, path string) error {
	if err := ctxErr(ctx, "write export file"); err != nil {
		return err
	}

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("write export file: create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()

	// Every failure past creation removes the temp file; success clears the
	// name so the deferred remove is skipped. The remove's own error is
	// ignored: the failure being returned is the actionable one, and the
	// destination still holds the previous document.
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	if err := ExportJSON(ctx, s, tmp); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write export file: sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write export file: close temp file: %w", err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil { // #nosec G302 -- the export file is user data, meant to be world-readable like the files it backs up
		return fmt.Errorf("write export file: chmod temp file: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("write export file: replace %s: %w", path, err)
	}
	tmpName = ""
	return nil
}
````


## `internal/store/export_test.go`

````go
package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)

// exportDue is the due date the export fixtures share, so every case can
// spell the same expected task.
var exportDue = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

// exportSeeds returns the fixture tasks the round trip and the file tests
// share: a tagged todo with a due date, a task that gets completed, and a
// bare todo with neither tags nor a deadline.
func exportSeeds() []task.Task {
	return []task.Task{
		{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: exportDue, Tags: []string{"go", "book"}},
		{Title: "review code", Status: task.StatusTodo, Priority: task.PriorityMax, Tags: []string{"review"}},
		{Title: "ship it", Status: task.StatusTodo, Priority: task.PriorityMin},
	}
}

// canonicalTags returns t with its tags deduplicated and sorted. The Store
// contract treats a task's tags as a set — memory keeps insertion order,
// Turso's join returns them sorted — so comparisons that spell out whole
// tasks normalize both sides instead of pinning what the contract leaves
// free.
func canonicalTags(t task.Task) task.Task {
	t.Tags = slices.Compact(slices.Sorted(slices.Values(t.Tags)))
	return t
}

// canonicalAllTags maps canonicalTags over tasks.
func canonicalAllTags(tasks []task.Task) []task.Task {
	out := make([]task.Task, len(tasks))
	for i, t := range tasks {
		out[i] = canonicalTags(t)
	}
	return out
}

// importStores returns the Store implementations an import case runs
// against, each built fresh per subtest. The importer's contract — versions
// 1 through 3, all-or-nothing — is the same for both, so the cases that do
// not need a database exercise both.
func importStores() map[string]func(t *testing.T) Store {
	return map[string]func(t *testing.T) Store{
		"MemoryStore": func(*testing.T) Store {
			return NewMemoryStore()
		},
		"TursoStore": func(t *testing.T) Store {
			s, err := NewTursoStore(context.Background(), tursoStorePath(t))
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, s.Close()) })
			return s
		},
	}
}

// TestExportImport_RoundTrip pins the interchange contract end to end: the
// document is the v3 envelope in raw bytes, the exporting store's UUIDs and
// versions ride it in their canonical forms, and importing rebuilds every
// field — title, status, priority, due date, tags, id, version — so the
// document is the store it was written from.
func TestExportImport_RoundTrip(t *testing.T) {
	t.Parallel()

	seeds := exportSeeds()
	source := NewMemoryStore()
	added := make([]task.Task, 0, len(seeds))
	for _, seed := range seeds {
		got, err := source.Add(context.Background(), seed)
		require.NoError(t, err)
		added = append(added, got)
	}
	require.NoError(t, source.Complete(context.Background(), added[1].ID, added[1].Version))

	var buf bytes.Buffer
	require.NoError(t, ExportJSON(context.Background(), source, &buf))

	// The raw document, not just the decoded values: the streaming writer
	// spells the envelope's header by hand, so the test pins it against
	// exportDoc's declaration; the id rides uuid's canonical string form,
	// Status its MarshalText form, and Due the RFC 3339 form time.Time
	// marshals to.
	raw := buf.String()
	assert.True(t, strings.HasPrefix(raw, `{"version":3,"tasks":[`),
		"document opens with the v3 envelope header: %s", raw)
	assert.Contains(t, raw, `"ID":"`+added[0].ID.String()+`"`)
	assert.Contains(t, raw, `"Version":1`)
	assert.Contains(t, raw, `"Version":2`)
	assert.Contains(t, raw, `"Status":"Done"`)
	assert.Contains(t, raw, `"Due":"2026-11-01T00:00:00Z"`)

	want := slices.Clone(added)
	want[1].Status = task.StatusDone
	want[1].Version = 2

	for name, newStore := range importStores() {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			target := newStore(t)
			n, err := ImportJSON(context.Background(), target, strings.NewReader(raw))
			require.NoError(t, err)
			assert.Equal(t, len(seeds), n)

			got, err := target.List(context.Background())
			require.NoError(t, err)
			if diff := cmp.Diff(canonicalAllTags(want), canonicalAllTags(got)); diff != "" {
				t.Errorf("imported tasks mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

// TestImportJSON_V1 pins the oldest document the importer reads: integer
// ids, the pre-UUID era. The integer cannot be carried into the UUID era —
// it embeds no timestamp and no randomness to rebuild a v7 from — so every
// task gets a fresh v7 id in document order and starts at version 1, while
// every other field crosses over untouched.
func TestImportJSON_V1(t *testing.T) {
	t.Parallel()

	doc := `{"version":1,"tasks":[
		{"ID":7,"Title":"from v1","Status":"Todo","Priority":3,"Due":"2026-11-01T00:00:00Z","Tags":["go","book"]},
		{"ID":9,"Title":"also v1","Status":"Done","Priority":5}
	]}`

	for name, newStore := range importStores() {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			s := newStore(t)
			n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
			require.NoError(t, err)
			assert.Equal(t, 2, n)

			got, err := s.List(context.Background())
			require.NoError(t, err)
			require.Len(t, got, 2)

			assert.NotEqual(t, uuid.Nil, got[0].ID, "v1's integer id is replaced by a fresh one")
			assert.NotEqual(t, got[0].ID, got[1].ID, "each task gets its own fresh id")
			assert.Equal(t, uuid.Version(7), got[0].ID.Version(), "fresh ids are v7")
			assert.Equal(t, uuid.Version(7), got[1].ID.Version(), "fresh ids are v7")

			want := []task.Task{
				{ID: got[0].ID, Version: 1, Title: "from v1", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: exportDue, Tags: []string{"go", "book"}},
				{ID: got[1].ID, Version: 1, Title: "also v1", Status: task.StatusDone, Priority: task.PriorityMax},
			}
			if diff := cmp.Diff(canonicalAllTags(want), canonicalAllTags(got)); diff != "" {
				t.Errorf("imported tasks mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

// TestImportJSON_V2 pins the middle document: UUID ids that survive, and no
// version field — v2 predates the version column, so every task it holds was
// at version 1 by definition, and the importer normalizes the absent field
// to that value instead of importing a task at version 0.
func TestImportJSON_V2(t *testing.T) {
	t.Parallel()

	const (
		firstID  = "0199c0de-0000-7000-8000-000000000001"
		secondID = "0199c0de-0000-7000-8000-000000000002"
	)
	doc := `{"version":2,"tasks":[
		{"ID":"` + firstID + `","Title":"from v2","Status":"Todo","Priority":3},
		{"ID":"` + secondID + `","Title":"also v2","Status":"Done","Priority":5,"Tags":["go"]}
	]}`

	for name, newStore := range importStores() {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			s := newStore(t)
			n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
			require.NoError(t, err)
			assert.Equal(t, 2, n)

			got, err := s.List(context.Background())
			require.NoError(t, err)
			want := []task.Task{
				{ID: uuid.MustParse(firstID), Version: 1, Title: "from v2", Status: task.StatusTodo, Priority: task.PriorityDefault},
				{ID: uuid.MustParse(secondID), Version: 1, Title: "also v2", Status: task.StatusDone, Priority: task.PriorityMax, Tags: []string{"go"}},
			}
			if diff := cmp.Diff(canonicalAllTags(want), canonicalAllTags(got)); diff != "" {
				t.Errorf("imported tasks mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

// TestImportJSON_V3 pins the current document: ids and versions both
// survive, because v3 is what this build writes and a document that carries
// a version means exactly what it says.
func TestImportJSON_V3(t *testing.T) {
	t.Parallel()

	const (
		firstID  = "0199c0de-0000-7000-8000-000000000011"
		secondID = "0199c0de-0000-7000-8000-000000000012"
	)
	doc := `{"version":3,"tasks":[
		{"ID":"` + firstID + `","Version":4,"Title":"from v3","Status":"Done","Priority":3},
		{"ID":"` + secondID + `","Version":1,"Title":"also v3","Status":"Todo","Priority":5,"Due":"2026-11-01T00:00:00Z","Tags":["go"]}
	]}`

	for name, newStore := range importStores() {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			s := newStore(t)
			n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
			require.NoError(t, err)
			assert.Equal(t, 2, n)

			got, err := s.List(context.Background())
			require.NoError(t, err)
			want := []task.Task{
				{ID: uuid.MustParse(firstID), Version: 4, Title: "from v3", Status: task.StatusDone, Priority: task.PriorityDefault},
				{ID: uuid.MustParse(secondID), Version: 1, Title: "also v3", Status: task.StatusTodo, Priority: task.PriorityMax, Due: exportDue, Tags: []string{"go"}},
			}
			if diff := cmp.Diff(canonicalAllTags(want), canonicalAllTags(got)); diff != "" {
				t.Errorf("imported tasks mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

// TestImportJSON_Atomic is the non-vacuity case for the importer's promise:
// a document that goes bad after its first element leaves the store exactly
// as it was — the seeded task, nothing else — and reports the failure with
// the element's position. The malformed element is the second one, so an
// importer that wrote as it decoded without a rollback would have one
// imported task to show; both do not.
func TestImportJSON_Atomic(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		doc     string
		wantErr string
	}{
		{
			name: "unknown status",
			doc: `{"version":3,"tasks":[
				{"ID":"00000000-0000-0000-0000-000000000001","Version":1,"Title":"fine","Status":"Todo","Priority":3},
				{"ID":"00000000-0000-0000-0000-000000000002","Version":1,"Title":"broken","Status":"Blocked","Priority":3},
				{"ID":"00000000-0000-0000-0000-000000000003","Version":1,"Title":"never","Status":"Todo","Priority":3}
			]}`,
			wantErr: "task 1",
		},
		{
			name: "truncated element",
			doc: `{"version":3,"tasks":[
				{"ID":"00000000-0000-0000-0000-000000000001","Version":1,"Title":"fine","Status":"Todo","Priority":3},
				{"ID":"00000000-0000-0000-0000-000000000002","Version":1,"Title":"broken"
			]}`,
			wantErr: "task 1",
		},
		{
			name:    "document ends inside the array",
			doc:     `{"version":3,"tasks":[`,
			wantErr: "unexpected EOF",
		},
		{
			name: "document ends after a decoded task",
			doc: `{"version":3,"tasks":[
				{"ID":"00000000-0000-0000-0000-000000000001","Version":1,"Title":"fine","Status":"Todo","Priority":3}`,
			wantErr: "unexpected EOF",
		},
		{
			name: "trailing data after the document",
			doc: `{"version":3,"tasks":[
				{"ID":"00000000-0000-0000-0000-000000000001","Version":1,"Title":"fine","Status":"Todo","Priority":3}
			]}{"version":3,"tasks":[]}`,
			wantErr: "trailing data after the document",
		},
	}

	for name, newStore := range importStores() {
		for _, tt := range tests {
			t.Run(name+"/"+tt.name, func(t *testing.T) {
				t.Parallel()

				s := newStore(t)
				seeded, err := s.Add(context.Background(), task.Task{Title: "existing", Status: task.StatusTodo})
				require.NoError(t, err)

				n, err := ImportJSON(context.Background(), s, strings.NewReader(tt.doc))
				require.Error(t, err)
				assert.Zero(t, n, "a failed import added nothing")
				assert.Contains(t, err.Error(), tt.wantErr)

				got, err := s.List(context.Background())
				require.NoError(t, err)
				require.Len(t, got, 1, "the store is exactly as it was")
				assert.Equal(t, seeded, got[0])
			})
		}
	}
}

// TestImportJSON_TursoRollbackOnDuplicateID pins the rollback at the store,
// not at the decoder: the document is well formed and every task decodes,
// and the failure is a constraint the database reports mid-transaction — two
// tasks with the same id — after which the transaction rolls back and the
// import leaves nothing. The memory store has no constraint to violate (its
// batch append would admit the duplicate), so this case is the database
// store's own.
func TestImportJSON_TursoRollbackOnDuplicateID(t *testing.T) {
	t.Parallel()

	const id = "0199c0de-0000-7000-8000-000000000021"
	doc := `{"version":3,"tasks":[
		{"ID":"` + id + `","Version":1,"Title":"first","Status":"Todo","Priority":3},
		{"ID":"` + id + `","Version":1,"Title":"duplicate","Status":"Todo","Priority":3}
	]}`

	s, err := NewTursoStore(context.Background(), tursoStorePath(t))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.Error(t, err)
	assert.Zero(t, n)
	assert.Contains(t, err.Error(), "UNIQUE constraint failed", "the database's own refusal travels")

	list, err := s.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list, "the duplicate rolled the whole batch back")
}

// TestImportJSON_RejectsUnknownVersion pins that the version field is read,
// not merely written: a document claiming a schema this importer does not
// know is refused before a single task is added, instead of being misread as
// a known one.
func TestImportJSON_RejectsUnknownVersion(t *testing.T) {
	t.Parallel()

	for _, version := range []int{0, exportVersion + 1} {
		t.Run(fmt.Sprintf("version %d", version), func(t *testing.T) {
			t.Parallel()

			s := NewMemoryStore()
			doc := fmt.Sprintf(`{"version":%d,"tasks":[{"ID":"0199c0de-0000-7000-8000-000000000001","Title":"later","Status":"Todo","Priority":3}]}`, version)

			n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
			require.Error(t, err)
			assert.Zero(t, n)
			assert.Contains(t, err.Error(), fmt.Sprintf("unsupported version %d", version))

			list, err := s.List(context.Background())
			require.NoError(t, err)
			assert.Empty(t, list, "an unknown version is refused before any task is added")
		})
	}
}

// TestImportJSON_RejectsInvalidTaskVersion pins the one piece of strictness
// the v3 shape adds: a task's version is at least 1, because 1 is what Add
// assigns and every write bumps it, so a document that says 0 — explicitly
// or by omission — is describing a task no store could have written. The
// refusal happens mid-stream, so it is also the rollback's case.
func TestImportJSON_RejectsInvalidTaskVersion(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		doc  string
	}{
		{
			name: "explicit zero",
			doc:  `{"version":3,"tasks":[{"ID":"0199c0de-0000-7000-8000-000000000001","Version":0,"Title":"bad","Status":"Todo","Priority":3}]}`,
		},
		{
			name: "missing field",
			doc:  `{"version":3,"tasks":[{"ID":"0199c0de-0000-7000-8000-000000000001","Title":"bad","Status":"Todo","Priority":3}]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := NewMemoryStore()
			n, err := ImportJSON(context.Background(), s, strings.NewReader(tt.doc))
			require.Error(t, err)
			assert.Zero(t, n)
			assert.Contains(t, err.Error(), "task 0: version 0 is invalid")

			list, err := s.List(context.Background())
			require.NoError(t, err)
			assert.Empty(t, list)
		})
	}
}

// TestImportJSON_RejectsIntegerID pins the structural half of the v1
// refusal: a document that claims a current version cannot smuggle an
// integer id past the task type. uuid.UUID decodes from its canonical string
// form, and encoding/json rejects the number before the store ever sees the
// task, so a v1-shaped task in a v3 envelope is refused rather than
// misread.
func TestImportJSON_RejectsIntegerID(t *testing.T) {
	t.Parallel()

	s := NewMemoryStore()
	doc := `{"version":3,"tasks":[{"ID":1,"Version":1,"Title":"from v1","Status":"Todo","Priority":3}]}`

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.Error(t, err)
	assert.Zero(t, n)
	assert.Contains(t, err.Error(), "task 0", "the failure names the element's position")

	list, err := s.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list, "the task with the integer id never reaches the store")
}

// TestImportJSON_IgnoresUnknownTaskFields pins the forward-compatible half
// of the format's strictness. The envelope is exact — the version field
// gates the schema — but a task element is decoded by encoding/json, which
// skips fields the type does not declare, so a document written by a build
// that grew a task field still imports. Additive task changes need no new
// version; incompatible ones do.
func TestImportJSON_IgnoresUnknownTaskFields(t *testing.T) {
	t.Parallel()

	s := NewMemoryStore()
	doc := `{"version":3,"tasks":[{"ID":"0199c0de-0000-7000-8000-000000000001","Version":1,"Title":"from the future","Status":"Todo","Priority":3,"Colour":"blue"}]}`

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.NoError(t, err)
	assert.Equal(t, 1, n)

	got, err := s.List(context.Background())
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "from the future", got[0].Title)
}

// plainStore is a Store with the atomic-import hook hidden: embedding the
// interface promotes only the Store method set, so the concrete store behind
// it is not reachable as a bulkInserter. ImportJSON must refuse it rather
// than fall back to one-at-a-time writes that could leave a partial
// document.
type plainStore struct {
	Store
}

// TestImportJSON_RequiresAtomicStore pins that refusal: a store that cannot
// promise the batch is not silently served a different promise.
func TestImportJSON_RequiresAtomicStore(t *testing.T) {
	t.Parallel()

	s := plainStore{Store: NewMemoryStore()}
	doc := `{"version":3,"tasks":[{"ID":"0199c0de-0000-7000-8000-000000000001","Version":1,"Title":"fine","Status":"Todo","Priority":3}]}`

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.Error(t, err)
	assert.Zero(t, n)
	assert.Contains(t, err.Error(), "does not support atomic import")

	list, err := s.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list)
}

// byteCountingReader is an io.Reader that yields one byte per Read and
// records how many it has yielded. One byte at a time is the point: the
// decoder cannot refill ahead of what the step in progress needs, so the
// reader's count at each stream pull is a precise record of how far the
// import had read when it asked for that task.
type byteCountingReader struct {
	data []byte
	read int
}

func (r *byteCountingReader) Read(p []byte) (int, error) {
	if r.read >= len(r.data) {
		return 0, io.EOF
	}
	p[0] = r.data[r.read]
	r.read++
	return 1, nil
}

// streamProbe is a Store that records the reader's position at the moment
// each task is pulled, then buffers the batch the way the memory store's own
// hook does. A decode-all-then-insert importer would reach the store only
// after the reader hit EOF — every recorded position would equal the
// document's length — so the positions below are the proof that the store's
// batch consumes the stream while the document is still arriving. The
// method's signature is written out rather than named so the probe compiles
// against the store's pre-importer shape too: what it tests is the hook, not
// the type name.
type streamProbe struct {
	*MemoryStore
	r          *byteCountingReader
	readAtNext []int
}

func (s *streamProbe) insertAll(ctx context.Context, stream func() (task.Task, error)) (int, error) {
	var batch []task.Task
	for {
		s.readAtNext = append(s.readAtNext, s.r.read)
		t, err := stream()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, err
		}
		batch = append(batch, t)
	}
	s.core.mu.Lock()
	defer s.core.mu.Unlock()
	for _, t := range batch {
		s.core.tasks = append(s.core.tasks, storedTask{Task: t, owner: s.owner})
	}
	return len(batch), nil
}

// TestImportJSON_StreamsFromAChunkedReader pins the streaming store: the
// document arrives one byte per Read, every task is pulled — and inserted —
// before the reader reaches EOF, and each pull happens after the previous
// one, so the decoder consumed the first task before it saw the second. The
// whole document is consumed by the time the import returns.
func TestImportJSON_StreamsFromAChunkedReader(t *testing.T) {
	t.Parallel()

	source := mustStore(t, exportSeeds()...)
	var buf bytes.Buffer
	require.NoError(t, ExportJSON(context.Background(), source, &buf))
	doc := buf.Bytes()

	r := &byteCountingReader{data: doc}
	probe := &streamProbe{MemoryStore: NewMemoryStore(), r: r}

	n, err := ImportJSON(context.Background(), probe, r)
	require.NoError(t, err)
	require.Equal(t, len(exportSeeds()), n)
	require.Len(t, probe.readAtNext, n+1, "one pull per task, plus the exhaustion pull")

	for i, pos := range probe.readAtNext {
		assert.Less(t, pos, len(doc), "pull %d happened before the reader reached EOF", i)
		if i > 0 {
			assert.Greater(t, pos, probe.readAtNext[i-1], "the decoder consumed a task between pulls")
		}
	}
	assert.Equal(t, len(doc), r.read, "the whole document was consumed")
}

// TestWriteExportFile_NoTempLeftovers pins the atomic write's cleanup and
// its result: after several exports the directory holds exactly one entry —
// the export file, whose bytes are the document ExportJSON streams — and no
// .tmp debris. A lingering temp file is what a crash would leave behind; a
// successful export must not.
func TestWriteExportFile_NoTempLeftovers(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "tasks.json")
	s := mustStore(t, exportSeeds()...)

	for range 3 {
		require.NoError(t, WriteExportFile(context.Background(), s, path))
	}

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1, "only the export file remains after writes")
	assert.Equal(t, "tasks.json", entries[0].Name())

	raw, err := os.ReadFile(path) // #nosec G304 -- the test reads the very file it just told WriteExportFile to write
	require.NoError(t, err)
	var doc exportDoc
	require.NoError(t, json.Unmarshal(raw, &doc))
	assert.Equal(t, exportVersion, doc.Version)
	require.Len(t, doc.Tasks, len(exportSeeds()))
	assert.Equal(t, "write tests", doc.Tasks[0].Title)
}

// TestWriteExportFile_FailedWriteKeepsOldFile pins the atomic write's
// central promise: when a new export cannot be written, the previous
// document is still there, whole. The read-only directory makes the temp
// file's creation fail before a byte of the new state exists, so "old file
// intact" is asserted against bytes that predate the failure.
func TestWriteExportFile_FailedWriteKeepsOldFile(t *testing.T) {
	t.Parallel()

	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions, so the write cannot be failed this way")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "tasks.json")
	s := mustStore(t, exportSeeds()...)
	require.NoError(t, WriteExportFile(context.Background(), s, path))

	before, err := os.ReadFile(path) // #nosec G304 -- the test reads the very file it just told WriteExportFile to write
	require.NoError(t, err)

	// A directory without write permission fails os.CreateTemp with EACCES
	// (read and execute stay, so listing and reading still work). Cleanups
	// run last-in-first-out, and t.TempDir registered its removal before
	// this restore, so the permission is back before the tree is removed.
	require.NoError(t, os.Chmod(dir, 0o500)) // #nosec G302 -- the restrictive mode is the point: it is how this test fails the write
	t.Cleanup(func() {
		require.NoError(t, os.Chmod(dir, 0o700)) // #nosec G302 -- restoring write permission so t.TempDir can remove the tree
	})

	err = WriteExportFile(context.Background(), s, path)
	require.Error(t, err, "WriteExportFile reports the write failure")

	after, err := os.ReadFile(path) // #nosec G304 -- the test reads the very file it just told WriteExportFile to write
	require.NoError(t, err, "the old file is still readable")
	assert.Equal(t, string(before), string(after), "the failed write left the old file intact")

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, "tasks.json", entries[0].Name())
}

// listErrStore is a Store whose List fails. It exercises WriteExportFile's
// failure path after the temp file has been created — the directory is
// writable and the failure comes from the document's source — so the
// cleanup this test asserts is the deferred remove, not the absence of a
// temp that was never made.
type listErrStore struct {
	*MemoryStore
	err error
}

func (s listErrStore) List(context.Context) ([]task.Task, error) {
	return nil, s.err
}

// TestWriteExportFile_SourceFailureRemovesTemp pins the temp cleanup on a
// failure past creation: when the export document cannot be produced, the
// destination is not created and the temp file is gone — the old file, or
// its absence, is exactly what the caller had before.
func TestWriteExportFile_SourceFailureRemovesTemp(t *testing.T) {
	t.Parallel()

	errBoom := errors.New("list failed")
	dir := t.TempDir()
	path := filepath.Join(dir, "tasks.json")

	s := listErrStore{MemoryStore: NewMemoryStore(), err: errBoom}
	err := WriteExportFile(context.Background(), s, path)
	require.ErrorIs(t, err, errBoom, "the source's error travels unchanged")

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	assert.Empty(t, entries, "the failed export left no temp file and no destination")
}

// BenchmarkExport measures one full export of a seeded store. The writer is
// io.Discard: the cost under measurement is the encoding — the bufio writer,
// one json.Marshal per task, the header and the separators — not the
// destination. The call writes to its writer, so it cannot be optimized
// away; no sink is needed.
func BenchmarkExport(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				if err := ExportJSON(benchCtx, s, io.Discard); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkImport measures one full import of the document the same store
// exports, into a fresh store each iteration: the decode of every task plus
// the store-side batch, which is what an import actually costs. The document
// is exported once, before the timer starts.
func BenchmarkImport(b *testing.B) {
	for _, n := range benchSizes {
		var buf bytes.Buffer
		if err := ExportJSON(benchCtx, seedStore(n), &buf); err != nil {
			b.Fatal(err)
		}
		doc := buf.Bytes()
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				s := NewMemoryStore()
				if _, err := ImportJSON(benchCtx, s, bytes.NewReader(doc)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
````


## `internal/store/importer.go`

````go
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"

	"todo/internal/task"
)

// taskStream yields a document's tasks in order, one per call; io.EOF ends
// the stream. It is how the importer stays bounded: the store pulls one task
// at a time while its write is open, instead of the importer decoding the
// whole document into a slice first. Because the stream reads from a
// one-shot reader, a store may call it once — there is no rewind — which is
// why the transaction that consumes it is not retried.
//
// It is an alias rather than a defined type on purpose: an implementation or
// a test double can spell the signature out and still satisfy
// bulkInserter, so the name documents the shape without becoming a second
// thing to import.
type taskStream = func() (task.Task, error)

// bulkInserter is the store-side half of ImportJSON: the importer decodes
// and validates the document, and the store writes what the stream yields in
// one atomic batch — all of it or none. Both stores implement it: memory by
// buffering the stream and appending the batch under one write lock (it is
// the test double; the buffer is the store's own state arriving), the Turso
// store by streaming straight into one BEGIN CONCURRENT transaction whose
// rollback is the atomicity. The interface is unexported because atomicity
// is a property the stores already have, not a new public promise; ImportJSON
// is the door, and it asserts the store supports the batch instead of
// silently falling back to one-at-a-time writes that could leave a partial
// document.
type bulkInserter interface {
	insertAll(ctx context.Context, stream taskStream) (int, error)
}

// ImportJSON reads an interchange document from r and adds every task it
// carries to s in one atomic batch, returning how many it added. The reader
// streams twice over: a json.Decoder walks the envelope token by token —
// the opening brace, the version field, the tasks array's opening bracket —
// and the store pulls one decoded task at a time while its write is open.
// The document is never held whole in memory, and neither is the decoded
// set: at any moment the import holds one task's bytes plus whatever the
// store keeps. Atomicity comes from the store's transaction, not from
// reading the document first: a malformed task mid-stream, a task the store
// refuses, or a document that does not end cleanly rolls the whole batch
// back, so a failure anywhere leaves the store exactly as it was.
//
// The version is read first and refused if unknown, before any task is
// added, and the version picks the decoder: v1's integer ids get fresh
// UUIDv7 values in document order (an integer carries no timestamp to
// rebuild one from), v2's UUID ids survive with Version normalized to 1
// (v2 predates the version column, so every task it holds was at version
// 1), and v3 keeps both id and version as written. The envelope is exact —
// version then tasks, the order exportDoc declares and the writer emits —
// and the document must end at its closing brace; a task element, by
// contrast, may carry fields this build does not know, and encoding/json
// skips them, so additive task changes do not need a new version. Decoding
// is validation: task.Status's UnmarshalText accepts only Todo and Done, and
// a v3 task must carry a version of at least 1 — the value Add assigns —
// so a malformed element is named by its zero-based position in the array
// ("task 2: ...") and fails the import whole.
func ImportJSON(ctx context.Context, s Store, r io.Reader) (int, error) {
	if err := ctxErr(ctx, "import tasks"); err != nil {
		return 0, err
	}

	bi, ok := s.(bulkInserter)
	if !ok {
		return 0, fmt.Errorf("import tasks: %T does not support atomic import", s)
	}

	d := json.NewDecoder(r)

	// The envelope opens with an object, and the format puts version before
	// tasks. Reading the version before the array is what lets an unknown
	// schema be refused before a single task is added; a document with the
	// fields the other way around is refused here instead of guessed at.
	tok, err := d.Token()
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return 0, fmt.Errorf("import tasks: document is not a JSON object")
	}

	tok, err = d.Token()
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}
	if tok != "version" {
		return 0, fmt.Errorf("import tasks: expected the version field, found %q", tok)
	}
	var version int
	if err := d.Decode(&version); err != nil {
		return 0, fmt.Errorf("import tasks: version: %w", err)
	}
	stream, err := taskStreamFor(d, version)
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}

	tok, err = d.Token()
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}
	if tok != "tasks" {
		return 0, fmt.Errorf("import tasks: expected the tasks field, found %q", tok)
	}
	tok, err = d.Token()
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '[' {
		return 0, fmt.Errorf("import tasks: tasks is not a JSON array")
	}

	// The store pulls the stream inside its own write: for the Turso store
	// that is one BEGIN CONCURRENT transaction whose rollback undoes a
	// failed import, for the memory store one buffered append under one
	// lock. Either way the count is the batch's size, and on error it is
	// zero — nothing landed.
	count, err := bi.insertAll(ctx, stream)
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}
	return count, nil
}

// importTaskV1 is the task shape of the integer-id era. Its ID is the one
// field the current Task type cannot represent — an integer, while the UUID
// era's ids are 128-bit values — and it is the only field the v1 decoder
// drops. Everything else decodes into the same types the current format
// uses.
type importTaskV1 struct {
	ID       int64
	Title    string
	Status   task.Status
	Priority task.Priority
	Due      time.Time
	Tags     []string
}

// taskStreamFor returns the stream that decodes the tasks array for its
// document version. An unknown version is refused here, before the array is
// entered and before any task is added. The returned stream wraps every
// decode failure with the element's zero-based position, because "which row
// is bad" is the first thing a caller needs to know.
func taskStreamFor(d *json.Decoder, version int) (taskStream, error) {
	if version < 1 || version > exportVersion {
		return nil, fmt.Errorf("unsupported version %d", version)
	}
	index := 0
	return func() (task.Task, error) {
		if !d.More() {
			// The array and the object must close here, and the input must
			// end at the last brace. These checks run from the exhaustion
			// call — inside the store's write — so a document that does not
			// end cleanly fails the import whole instead of landing its
			// tasks and then reporting them.
			if err := closeDocument(d); err != nil {
				return task.Task{}, err
			}
			return task.Task{}, io.EOF
		}
		i := index
		index++

		if version == 1 {
			var old importTaskV1
			if err := d.Decode(&old); err != nil {
				return task.Task{}, fmt.Errorf("task %d: %w", i, err)
			}
			// The integer id has no mapping into the UUID era: it carries
			// no timestamp and no randomness to rebuild one from, and
			// reusing the number would drag the old sequence into the new
			// ids. A fresh v7 value in document order is the upgrade.
			id, err := uuid.NewV7()
			if err != nil {
				return task.Task{}, fmt.Errorf("task %d: %w", i, err)
			}
			return task.Task{
				ID:       id,
				Version:  1,
				Title:    old.Title,
				Status:   old.Status,
				Priority: old.Priority,
				Due:      old.Due,
				Tags:     old.Tags,
			}, nil
		}

		var t task.Task
		if err := d.Decode(&t); err != nil {
			return task.Task{}, fmt.Errorf("task %d: %w", i, err)
		}
		if version == 2 {
			// v2 predates the version column: every task it holds was at
			// version 1 by definition, and the absent field would otherwise
			// decode as the zero version.
			t.Version = 1
		}
		if t.Version < 1 {
			// A v3 task at version 0 is not a task this store could have
			// written: Add assigns 1 and every write bumps it. Refusing it
			// keeps "version counts committed writes" true for imported
			// rows instead of admitting one that no CAS would ever match.
			return task.Task{}, fmt.Errorf("task %d: version %d is invalid", i, t.Version)
		}
		return t, nil
	}, nil
}

// closeDocument consumes the tasks array's closing bracket and the
// envelope's closing brace, requires both, and requires the input to end
// there: the decoder stops at the last brace, so one token more proves a
// second document cannot ride silently behind the first. A stream that ends
// before the brackets close reports io.ErrUnexpectedEOF — deliberately not
// io.EOF, which is the stream's own end-of-input sentinel and would be
// mistaken for a clean finish by the stores' insert loops, landing a
// truncated document's leading tasks as if the document had closed.
func closeDocument(d *json.Decoder) error {
	tok, err := d.Token()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("document ends inside the tasks array: %w", io.ErrUnexpectedEOF)
		}
		return err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != ']' {
		return fmt.Errorf("expected the tasks array to close, found %v", tok)
	}
	tok, err = d.Token()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("document ends inside the envelope: %w", io.ErrUnexpectedEOF)
		}
		return err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '}' {
		return fmt.Errorf("expected the document to close, found %v", tok)
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return errors.New("trailing data after the document")
	}
	return nil
}
````


## `internal/store/perf_bench_test.go`

````go
package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"todo/internal/db"
	"todo/internal/task"
)

// This file is chapter 50's workload: a seeded, hundred-thousand-task Turso
// database and the benchmarks that read it. Chapter 12's bench_test.go
// measures the in-memory store at 100 and 10,000 tasks; the numbers here are
// the other half of the story — the same reads against the engine, at a size
// where the SQLite planner, the driver's row marshaling, and the collector's
// work are all visible. The benchmarks reuse benchTask's seeding pattern
// (see bench_test.go), so the two suites measure one workload shape.
//
// The database is built once per process and reused by every benchmark in
// the run; TODO_PERF_DB names the file when a capture wants to share one
// database across processes — benchstat comparisons interleave two test
// binaries, and re-seeding a hundred thousand tasks per process would make
// the seeding dominate the capture. The seeded rows are deterministic:
// benchTask reads no clock, and the ids are generated from the row index, so
// the same file is the same workload in every process that opens it.

// perfTaskCount is the workload's size: the number of tasks the seeded
// database holds. It is named in every benchmark's sub-name, because a
// comparison across a size change would be a comparison of two workloads.
const perfTaskCount = 100_000

// perfSeedBatch is how many tasks one seeding transaction inserts. Ten
// thousand rows per transaction keeps the seed to ten commits while keeping
// each transaction's memory bounded; the seed is not the thing being
// measured, so it only has to be fast enough to run between captures.
const perfSeedBatch = 10_000

// perfDirOnce and perfDir are the process's seeded database directory. The
// benchmarks share one file per process — not one per benchmark and not one
// per count — because seeding is the expensive part of the suite and every
// benchmark reads the same workload; a per-test file would seed a hundred
// thousand tasks once per benchmark per -count. TestMain removes the
// directory when the process ends.
var (
	perfDirOnce sync.Once
	perfDir     string
)

func perfDirFor(b *testing.B) string {
	b.Helper()
	perfDirOnce.Do(func() {
		dir, err := os.MkdirTemp("", "todo-perf-*")
		if err != nil {
			b.Fatalf("create perf directory: %v", err)
		}
		perfDir = dir
	})
	return perfDir
}

// TestMain removes the process's seeded database when the run ends. The
// benchmarks build it under the system temp directory rather than under a
// test's, because it must outlive the test that seeded it — see perfStore.
func TestMain(m *testing.M) {
	code := m.Run()
	if perfDir != "" {
		_ = os.RemoveAll(perfDir)
	}
	os.Exit(code)
}

// perfStore returns the seeded store the Turso benchmarks read. The file is
// TODO_PERF_DB when set — the interleaved-capture case, where both binaries
// must open one database — and a process-owned temp file otherwise. An
// existing file is adopted only when it already holds exactly
// perfTaskCount tasks, so a half-seeded or stale file fails the benchmark
// loudly instead of being read as the workload.
func perfStore(b *testing.B) *TursoStore {
	b.Helper()
	path := os.Getenv("TODO_PERF_DB")
	if path == "" {
		path = filepath.Join(perfDirFor(b), "perf.db")
	}
	s, err := NewTursoStore(context.Background(), path)
	if err != nil {
		b.Fatalf("open perf store %s: %v", path, err)
	}
	b.Cleanup(func() { _ = s.Close() })

	var n int
	if err := s.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM tasks").Scan(&n); err != nil {
		b.Fatalf("count perf tasks: %v", err)
	}
	if n == perfTaskCount {
		return s
	}
	if n != 0 {
		b.Fatalf("%s holds %d tasks, want 0 or %d", path, n, perfTaskCount)
	}
	seedPerfStore(b, s)
	return s
}

// seedPerfStore inserts the workload: perfTaskCount tasks built by
// perfSeedTask, in batches of perfSeedBatch rows inside one concurrent
// transaction each. The ids are generated from the row index rather than by
// uuid.NewV7, so every process that seeds builds the same keys and an
// interleaved capture compares two binaries over one database.
func seedPerfStore(b *testing.B, s *TursoStore) {
	b.Helper()
	ctx := context.Background()
	start := time.Now()
	for lo := 0; lo < perfTaskCount; lo += perfSeedBatch {
		hi := min(lo+perfSeedBatch, perfTaskCount)
		err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			q := db.New(conn)
			for i := lo; i < hi; i++ {
				t := perfSeedTask(i)
				if err := q.InsertTask(ctx, db.InsertTaskParams{
					ID:       t.ID.String(),
					Title:    t.Title,
					Status:   string(t.Status),
					Priority: int64(t.Priority),
					Due:      dueSQL(t.Due),
					Version:  int64(t.Version),
				}); err != nil {
					return err
				}
				for _, tag := range uniqueTags(t.Tags) {
					if err := q.InsertTag(ctx, db.InsertTagParams{TaskID: t.ID.String(), Tag: tag}); err != nil {
						return err
					}
				}
			}
			return nil
		})
		if err != nil {
			b.Fatalf("seed perf store: %v", err)
		}
	}
	b.Logf("seeded %d tasks in %s", perfTaskCount, time.Since(start))
}

// perfRareTag and perfRareTagIndex are the workload's needle: exactly one
// task carries perfRareTag, and its row index is chosen so benchTask gives
// it no other tags — 77777 is divisible by 7, the pattern's no-tags case. A
// tag every third task carries measures the common case; the needle measures
// what an access path is for: finding one row in a hundred thousand without
// reading the table.
const (
	perfRareTag      = "needle"
	perfRareTagIndex = 77777
)

// perfSeedTask builds the i-th task of the workload: benchTask's shape with
// a deterministic id, plus the needle. The id is the row index in UUIDv7's
// text form — a fixed prefix, the version and variant nibbles set, and the
// index in the low bits — so id order is index order and ListTasks' ORDER BY
// id is the insertion order the domain promises.
func perfSeedTask(i int) task.Task {
	t := benchTask(i)
	if i == perfRareTagIndex {
		t.Tags = []string{perfRareTag}
	}
	t.ID = perfSeedID(i)
	t.Version = 1
	return t
}

// perfSeedID formats the row index as the UUIDv7 text a store would have
// assigned: uuid's 8-4-4-4-12 layout, version 7 in the third group's high
// nibble, variant 10 in the fourth group's high bits. The index is decimal
// here — the point is determinism, not a plausible timestamp — and it fits
// the last group's twelve digits for every index the workload uses.
func perfSeedID(i int) uuid.UUID {
	return uuid.MustParse(fmt.Sprintf("01a00000-0000-7000-8000-%012d", i))
}

// perfSink keeps the benchmarked Turso calls' results reachable, for the
// same reason benchSink does: a call whose result nothing reads can be
// optimized away.
var perfSink struct {
	stats Stats
	done  int
}

func BenchmarkTursoList(b *testing.B) {
	s := perfStore(b)
	b.Run(fmt.Sprintf("n=%d", perfTaskCount), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			got, err := s.List(benchCtx)
			if err != nil {
				b.Fatal(err)
			}
			benchSink.tasks = got
		}
	})
}

func BenchmarkTursoByTag(b *testing.B) {
	s := perfStore(b)
	b.Run(fmt.Sprintf("n=%d", perfTaskCount), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			got, err := s.ByTag(benchCtx, benchTags[0])
			if err != nil {
				b.Fatal(err)
			}
			benchSink.tasks = got
		}
	})
}

func BenchmarkTursoByTagRare(b *testing.B) {
	s := perfStore(b)
	b.Run(fmt.Sprintf("n=%d", perfTaskCount), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			got, err := s.ByTag(benchCtx, perfRareTag)
			if err != nil {
				b.Fatal(err)
			}
			benchSink.tasks = got
		}
	})
}

func BenchmarkTursoSortByDue(b *testing.B) {
	s := perfStore(b)
	b.Run(fmt.Sprintf("n=%d", perfTaskCount), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			got, err := s.SortByDue(benchCtx)
			if err != nil {
				b.Fatal(err)
			}
			benchSink.tasks = got
		}
	})
}

func BenchmarkTursoStats(b *testing.B) {
	s := perfStore(b)
	b.Run(fmt.Sprintf("n=%d", perfTaskCount), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			got, err := s.Stats(benchCtx)
			if err != nil {
				b.Fatal(err)
			}
			perfSink.stats = got
		}
	})
}

func BenchmarkTursoGet(b *testing.B) {
	s := perfStore(b)
	id := perfSeedID(perfTaskCount / 2)
	b.Run(fmt.Sprintf("n=%d", perfTaskCount), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			got, err := s.Get(benchCtx, id)
			if err != nil {
				b.Fatal(err)
			}
			benchSink.task = got
		}
	})
}

// BenchmarkTursoComplete measures the one-row write path — the compare-and-
// swap the CLI's done command and the API's PATCH ride — against the seeded
// database. Each iteration completes a distinct row at the version the
// opening List read, so b.N iterations are b.N real transactions, each one a
// CAS that hits; the writes move the rows' versions, which the next count's
// opening List reads fresh.
func BenchmarkTursoComplete(b *testing.B) {
	s := perfStore(b)
	ctx := context.Background()
	tasks, err := s.List(ctx)
	if err != nil {
		b.Fatal(err)
	}
	if len(tasks) < b.N {
		b.Fatalf("workload holds %d tasks, want at least b.N=%d", len(tasks), b.N)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := s.Complete(ctx, tasks[i].ID, tasks[i].Version); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkTaskScanValues and BenchmarkTaskScanPointers measure the two
// shapes a slice of tasks can take when the only thing done with it is
// scanning: a contiguous []task.Task, whose elements are read in place, and
// a []*task.Task, whose elements are one allocation each and one pointer
// dereference away. The workload is the same 100,000 tasks the seeded
// database holds, built in memory: the memory thread's claim is that the
// value slice scans better, and this is where the claim is measured.
func BenchmarkTaskScanValues(b *testing.B) {
	tasks := perfTasks(perfTaskCount)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		perfSink.done = scanTasks(tasks)
	}
}

func BenchmarkTaskScanPointers(b *testing.B) {
	values := perfTasks(perfTaskCount)
	ptrs := make([]*task.Task, len(values))
	for i := range values {
		ptrs[i] = &values[i]
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		perfSink.done = scanTaskPtrs(ptrs)
	}
}

// perfTasks builds n tasks with benchTask's shape, in memory.
func perfTasks(n int) []task.Task {
	tasks := make([]task.Task, n)
	for i := range tasks {
		tasks[i] = benchTask(i)
	}
	return tasks
}

// scanTasks counts the done tasks in a value slice: elements read in place,
// one contiguous pass.
func scanTasks(tasks []task.Task) int {
	done := 0
	for i := range tasks {
		if tasks[i].Status == task.StatusDone {
			done++
		}
	}
	return done
}

// scanTaskPtrs counts the done tasks in a pointer slice: one indirection per
// element, the same field read.
func scanTaskPtrs(tasks []*task.Task) int {
	done := 0
	for _, t := range tasks {
		if t.Status == task.StatusDone {
			done++
		}
	}
	return done
}
````


## `internal/store/stats.go`

````go
package store

import (
	"context"
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
// The concurrency here is the pattern, not a speedup — chapter 12's
// discipline says measure first — so the count stays a constant: chapter 18
// revisits the pool with errgroup.
const statsWorkers = 4

// Stats computes the aggregate across a fixed pool of workers. It observes
// ctx in the two places that wait: at entry, where a done context returns the
// zero Stats and an error before any snapshot or goroutine exists, and in the
// merge loop, where a context that becomes done mid-call returns the partial
// aggregate merged so far plus that error. The error wraps
// context.Cause(ctx), so a canceled caller matches context.Canceled, an
// expired deadline matches context.DeadlineExceeded, and a caller that
// canceled with context.WithCancelCause matches its own cause.
func (s *MemoryStore) Stats(ctx context.Context) (Stats, error) {
	s.core.ops.Add(1)
	// Cancellation that is already visible at entry must not lose a worker
	// to the race: the check returns before the snapshot and before any
	// goroutine starts, which is also what keeps the pre-canceled test
	// deterministic — ctx.Done() is already closed, so no select can
	// choose otherwise.
	if err := ctxErr(ctx, "stats"); err != nil {
		return Stats{}, err
	}

	// Snapshot first, under the read lock, so the copy is one consistent
	// instant. The snapshot goes through listLocked rather than List: Stats
	// takes the lock once itself, and delegating to an exported method
	// would count a second operation — and listLocked is what narrows the
	// snapshot to the view's owner. The lock covers the copy only — the
	// workers only ever read their own copy, and holding the read lock
	// across the fold would only delay the next writer.
	s.core.mu.RLock()
	tasks := s.listLocked()
	s.core.mu.RUnlock()
	if len(tasks) == 0 {
		// Nothing to fold; the empty aggregate still carries a non-nil
		// ByTag, matching CountByTag.
		return Stats{ByTag: make(map[string]int)}, nil
	}

	// At most statsWorkers workers, and never more than one per task. The
	// rounding-up division is the chunk math: the last chunk takes the
	// remainder, so no task is dropped when the split is uneven.
	workers := min(statsWorkers, len(tasks))
	chunkSize := (len(tasks) + workers - 1) / workers

	// The buffer lets every worker hand its partial off and finish without
	// waiting for the consumer to be scheduled.
	partials := make(chan Stats, workers)

	var wg sync.WaitGroup
	for start := 0; start < len(tasks); start += chunkSize {
		chunk := tasks[start:min(start+chunkSize, len(tasks))]
		wg.Add(1)
		go func() {
			defer wg.Done()
			// The send is the worker's cancellation point: if the caller
			// gave up, drop the partial and exit instead of blocking on
			// a consumer that may already be gone.
			select {
			case partials <- statsOf(chunk):
			case <-ctx.Done():
				return
			}
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
	// each partial transfers through the channel. Receiving and cancelling
	// are offered together: whichever case is ready first wins, and when
	// both are ready select picks at random — the merge stays correct
	// either way, and no committed test races the two.
	merged := Stats{ByTag: make(map[string]int)}
	for {
		select {
		case <-ctx.Done():
			// A canceled call returns what was merged so far, not a
			// zeroed value. Workers still folding observe ctx.Done at
			// their next send and exit; the joiner's close then goes to
			// nobody, which is legal. A closed Done guarantees a non-nil
			// Err, so ctxErr always reports here.
			return merged, ctxErr(ctx, "stats")
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
````


## `internal/store/stats_test.go`

````go
package store

import (
	"context"
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
		{
			name: "fewer tasks than workers",
			tasks: []task.Task{
				{Title: "write tests", Status: task.StatusTodo, Tags: []string{"go", "testing"}},
				{Title: "review code", Status: task.StatusDone, Tags: []string{"go"}},
				{Title: "ship it", Status: task.StatusTodo},
			},
		},
		{
			name:  "exact multiple of the worker count",
			tasks: statsTasks(2 * statsWorkers),
		},
		{
			name: "out-of-set statuses count as pending",
			tasks: []task.Task{
				{Title: "write tests", Status: task.StatusTodo},
				{Title: "review code", Status: task.StatusDone},
				{Title: "read spec", Status: task.Status("Blocked")},
				{Title: "drop it", Status: task.Status("Cancelled")},
			},
		},
		{
			name: "overlapping tags",
			tasks: []task.Task{
				{Title: "write tests", Status: task.StatusTodo, Tags: []string{"go", "testing"}},
				{Title: "review code", Status: task.StatusDone, Tags: []string{"go", "review"}},
				{Title: "tag twice", Status: task.StatusTodo, Tags: []string{"go", "go", "testing"}},
				{Title: "no tags", Status: task.StatusTodo},
				{Title: "one tag", Status: task.StatusDone, Tags: []string{"review"}},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, tt.tasks...)

			tasks, err := s.List(context.Background())
			require.NoError(t, err)
			want := statsSequential(tasks)
			got, err := s.Stats(context.Background())
			require.NoError(t, err)
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("Stats() mismatch against the sequential oracle (-want +got):\n%s", diff)
			}
		})
	}
}

func TestMemoryStore_Stats_LargeSetMatchesOracle(t *testing.T) {
	t.Parallel()

	// 1001 is deliberately one more than 4*250: the split is uneven and the
	// last chunk is short, which the merged result must still absorb exactly.
	s := mustStore(t, statsTasks(1001)...)

	// The set must exercise every fold; if a future seed change made it
	// boring, the equality check below would quietly weaken.
	tasks, err := s.List(context.Background())
	require.NoError(t, err)
	want := statsSequential(tasks)
	require.Positive(t, want.Done, "the fixed seed must produce completed tasks")
	require.Positive(t, want.Pending, "the fixed seed must produce pending tasks")
	require.Greater(t, len(want.ByTag), 1, "the fixed seed must produce overlapping tags")

	got, err := s.Stats(context.Background())
	require.NoError(t, err)
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Stats() mismatch against the sequential oracle (-want +got):\n%s", diff)
	}
}

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
	got, err := s.Stats(context.Background())
	require.NoError(t, err)
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

	got, err := s.Stats(context.Background())
	require.NoError(t, err)
	assert.Equal(t, Stats{
		Total:   5,
		Done:    2,
		Pending: 3,
		ByTag:   map[string]int{"go": 3, "testing": 2, "review": 2},
	}, got)
	// Stats.ByTag is defined to match CountByTag, so the store's own
	// aggregate is a second oracle for it.
	counts, err := s.CountByTag(context.Background())
	require.NoError(t, err)
	assert.Equal(t, counts, got.ByTag)
}

func TestMemoryStore_Stats_ByTagNonNilWhenEmpty(t *testing.T) {
	t.Parallel()

	t.Run("empty store", func(t *testing.T) {
		t.Parallel()

		got, err := NewMemoryStore().Stats(context.Background())
		require.NoError(t, err)
		require.NotNil(t, got.ByTag, "ByTag is non-nil even when empty, matching CountByTag")
		assert.Equal(t, Stats{ByTag: map[string]int{}}, got)
	})

	t.Run("tasks without tags", func(t *testing.T) {
		t.Parallel()

		s := mustStore(t,
			task.Task{Title: "write tests", Status: task.StatusTodo},
			task.Task{Title: "review code", Status: task.StatusDone},
		)
		got, err := s.Stats(context.Background())
		require.NoError(t, err)
		require.NotNil(t, got.ByTag, "ByTag is non-nil even when empty, matching CountByTag")
		assert.Equal(t, Stats{Total: 2, Done: 1, Pending: 1, ByTag: map[string]int{}}, got)
	})
}

// Chapter 16 threads context through Stats and deletes chapter 15's
// hand-rolled cancel channel and timer. The tests below pin only the
// deterministic corners: a context canceled before the call and a deadline
// that has already passed, both visible at entry, so the entry check always
// wins and no worker starts. Canceling in the middle of a computation is not
// tested on purpose: the merge loop's select races ctx.Done against a
// buffered partials channel, and once both are ready the runtime picks among
// them at random — a suite that raced that coin flip would be flaky by
// construction. See the chapter's notes for what stays deterministic instead.

func TestMemoryStore_Stats_CanceledContext(t *testing.T) {
	t.Parallel()

	// Cancellation is visible before entry, so the call reports the zero
	// Stats without taking a snapshot or starting a worker.
	s := mustStore(t, statsTasks(1001)...)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	got, err := s.Stats(ctx)
	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, Stats{}, got)
}

func TestMemoryStore_Stats_DeadlineExceededContext(t *testing.T) {
	t.Parallel()

	// WithTimeout(0) is a deadline that has already passed: the context is
	// done at creation and its cause is context.DeadlineExceeded, so the
	// same entry check reports the zero Stats under the deadline sentinel.
	s := mustStore(t, statsTasks(1001)...)

	ctx, cancel := context.WithTimeout(context.Background(), 0)
	defer cancel()

	got, err := s.Stats(ctx)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Equal(t, Stats{}, got)
}
````


## `internal/store/store.go`

````go
// Package store keeps tasks: the Store interface, its in-memory and
// Turso-backed implementations, and the export, import, and batch helpers
// around them.
package store

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"todo/internal/task"
)

// ErrNotFound is reported when an operation names a task that does not exist.
var ErrNotFound = errors.New("task not found")

// ErrConflict is reported when an operation's snapshot of a task is stale:
// the caller read the task at one version, someone else wrote it since, and
// the write that carried the old version lost the compare-and-swap. The
// caller's answer is to re-read the task and decide again, which is why the
// error is a sentinel rather than a description of what changed — the store
// cannot know what the caller meant to write. A stale snapshot is not the
// same thing as a missing task (ErrNotFound) or as an engine-level
// write-write conflict the store retries internally; those keep their own
// meanings.
var ErrConflict = errors.New("task was modified")

// ctxErr reports the cancellation of ctx as an error scoped to the named
// operation, and nil while ctx is live. The wrapped cause is
// context.Cause(ctx): context.Canceled for a canceled call,
// context.DeadlineExceeded for an expired deadline, and the custom error when
// the caller canceled with context.WithCancelCause. Every Store method begins
// with this check, so a done context stops an operation before it starts any
// work.
func ctxErr(ctx context.Context, op string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%s: %w", op, context.Cause(ctx))
	}
	return nil
}

// Store is the persistence contract the rest of the application depends on.
//
// Every method takes a context as its first parameter and reports a done
// context by returning an error that wraps context.Cause(ctx); values
// returned alongside such an error are unspecified, so callers check the
// error before trusting the value. A nil ctx is a programming error, not a
// cancellation: the methods panic on it the way ctx.Err does.
//
// A Store is a scope over the task data, not the whole table: every query it
// runs carries an owner, so a store can see and write only the tasks one
// owner owns. The store NewMemoryStore and NewTursoStore return serves the
// user-less scope — the local, user-less tasks of the CLI, the rows whose
// owner_id is NULL — and Scoped returns a view serving one user, which is
// what the API's per-user surface holds. The scoping lives in the queries
// themselves, never in a caller's filter: a task outside the scope is
// indistinguishable from one that does not exist, so a foreign task is
// ErrNotFound, never a refusal that would leak its existence.
//
// The three single-task writes — Complete, Update, and Delete — are
// compare-and-swaps: the caller hands back the version it read with the task,
// and a write whose snapshot is stale fails with ErrConflict instead of
// overwriting a concurrent writer's work. A write that names a task no store
// holds — or one the scope does not own — fails with ErrNotFound. Reads
// return copies: a caller cannot reach a store's own state by mutating what
// it was handed.
//
// The SQL the Turso store runs is generated from internal/db/queries: sqlc
// reads the goose migrations as the schema and writes typed Go into
// internal/db, committed like store_moq_test.go. go generate runs a directive
// in the directory of the file that holds it, hence -f ../../sqlc.yaml; sqlc
// resolves the paths inside the config relative to the config file itself.
//
// The sqlc directive sits above the moq one on purpose: moq type-checks the
// package it mocks, and that package contains the generated sqlc code, so a
// query change that breaks the generated types has to be regenerated before
// moq runs. Directives run in the order they appear in the file.
//
//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f ../../sqlc.yaml

//go:generate go run github.com/matryer/moq@v0.8.0 -out store_moq_test.go . Store
type Store interface {
	// Scoped returns a view of the same store restricted to one owner:
	// every task query the view runs carries the owner, so the view reads
	// and writes only that owner's tasks. uuid.Nil is the user-less scope —
	// the local tasks of the CLI — and Scoped on a view re-scopes it: there
	// is one level of scope, not a nesting. The view shares the store's
	// data and its database handle; Close belongs to the store Scoped was
	// called on, not to the view.
	Scoped(owner uuid.UUID) Store

	Add(ctx context.Context, t task.Task) (task.Task, error)
	Get(ctx context.Context, id uuid.UUID) (task.Task, error)
	List(ctx context.Context) ([]task.Task, error)
	ByStatus(ctx context.Context, status task.Status) ([]task.Task, error)
	ByTag(ctx context.Context, tag string) ([]task.Task, error)
	CountByTag(ctx context.Context) (map[string]int, error)
	Tags(ctx context.Context) ([]string, error)
	SortByDue(ctx context.Context) ([]task.Task, error)
	Complete(ctx context.Context, id uuid.UUID, version int) error
	Update(ctx context.Context, t task.Task) (task.Task, error)
	Delete(ctx context.Context, id uuid.UUID, version int) error
	Stats(ctx context.Context) (Stats, error)
}

// MemoryStore is one implementation of Store.
var _ Store = (*MemoryStore)(nil)

// MemoryStore is an in-memory task list. The zero value is not usable; build
// one with NewMemoryStore. All methods are safe for concurrent use.
//
// One MemoryStore holds the tasks; Scoped returns another view of the same
// store — same tasks, same operation counter, one owner's slice of them. The
// store NewMemoryStore returns serves the user-less scope.
type MemoryStore struct {
	// core is the state every view of one store shares: a write through one
	// view is visible through every other view of the same owner, and the
	// ops counter counts the store, not the view.
	core *memoryCore

	// owner is the view's scope. uuid.Nil is the user-less scope: the local
	// tasks of the CLI, the rows whose owner_id is NULL. See Store.Scoped.
	owner uuid.UUID
}

// memoryCore is the state every view of one memory store shares.
type memoryCore struct {
	// mu guards tasks. Every exported method acquires it once — the read
	// methods for reading, the mutators for writing — and no method ever
	// acquires it again while holding it: composition goes through the
	// *Locked helpers, which assume the caller holds mu and never touch
	// it. See Tags for the deadlock that rule prevents.
	mu sync.RWMutex

	// tasks is the whole store: every owner's rows. A view reads and writes
	// only the rows whose owner matches its scope.
	tasks []storedTask

	// ops counts the public operations observed since creation. It is
	// atomic rather than guarded by mu: an increment is one lock-free word
	// operation on a field no other code touches, and a call that fails at
	// entry still counts, because the counter measures calls observed, not
	// work done. Reads go through Ops.
	ops atomic.Int64
}

// storedTask is one row: the task plus the owner it was written under. The
// owner is not a field of task.Task — ownership is the store's scoping fact,
// not something the domain type or the interchange format carries — so the
// row keeps the two together.
type storedTask struct {
	task.Task
	owner uuid.UUID
}

// NewMemoryStore returns an empty store scoped to nobody: the local,
// user-less tasks. Every task added gets a UUIDv7 id; Scoped returns a view
// of the same store serving one user.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{core: new(memoryCore)}
}

// Scoped implements Store. The view shares the store's tasks and operation
// counter; only the rows whose owner matches the scope are visible or
// writable through it.
func (s *MemoryStore) Scoped(owner uuid.UUID) Store {
	return &MemoryStore{core: s.core, owner: owner}
}

// Ops reports how many public operations the store has observed since it was
// created. Every method except Ops increments the counter exactly once, at
// entry, before the context check and before any lock; Scoped is not an
// operation, and every view of one store reads the same counter. Sequential
// callers can assert exact counts: k calls, then Ops() == k. Concurrent
// callers cannot: goroutines overlap, so a value read while calls are in
// flight is a snapshot of a moving number rather than an ordering — only the
// total after every caller has returned is meaningful. Ops itself does not
// increment.
func (s *MemoryStore) Ops() int64 {
	return s.core.ops.Load()
}

// Add assigns a UUIDv7 id to the task, stores a copy at version 1 under the
// view's owner, and returns the stored task. v7 embeds a millisecond
// timestamp whose generator is monotonic within the process, so id order is
// creation order; generating the id inside the write lock keeps that order
// the same as the slice order even when Adds run concurrently. The version,
// like the id, is the store's to assign: whatever the caller passed is
// overwritten, so no caller can seed a task at a version the store never
// handed out. A done ctx aborts before an id is assigned.
func (s *MemoryStore) Add(ctx context.Context, t task.Task) (task.Task, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "add task"); err != nil {
		return task.Task{}, err
	}
	s.core.mu.Lock()
	defer s.core.mu.Unlock()
	id, err := uuid.NewV7()
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
	t.ID = id
	t.Version = 1
	s.core.tasks = append(s.core.tasks, storedTask{Task: t, owner: s.owner})
	return t, nil
}

// Get returns the task with the given id, provided the view's owner owns it.
// The returned task is a copy — its tags slice included — so a caller cannot
// reach the store's own state by mutating what it was handed. It returns an
// error that wraps ErrNotFound when no such task exists in the scope — a
// task another owner holds included — and context.Cause(ctx) when ctx is
// done.
func (s *MemoryStore) Get(ctx context.Context, id uuid.UUID) (task.Task, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "get task"); err != nil {
		return task.Task{}, err
	}
	s.core.mu.RLock()
	defer s.core.mu.RUnlock()
	i := s.findLocked(id)
	if i < 0 {
		return task.Task{}, fmt.Errorf("get task %s: %w", id, ErrNotFound)
	}
	return copyTask(s.core.tasks[i].Task), nil
}

// Complete marks the task with the given ID as done, but only while the view
// owns it and it is still at the given version. The lock covers the compare
// and the write together, so no writer can slip between them: a version that
// does not match the stored task fails the compare-and-swap with ErrConflict,
// and a matching one moves the status and the version in the same critical
// section, so no reader can observe Done at the old version. It returns an
// error that wraps ErrNotFound when no such task exists in the scope,
// ErrConflict when the caller's snapshot is stale, and context.Cause(ctx)
// when ctx is done.
func (s *MemoryStore) Complete(ctx context.Context, id uuid.UUID, version int) error {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "complete task"); err != nil {
		return err
	}
	s.core.mu.Lock()
	defer s.core.mu.Unlock()
	i := s.findLocked(id)
	if i < 0 {
		return fmt.Errorf("complete task %s: %w", id, ErrNotFound)
	}
	if s.core.tasks[i].Version != version {
		return fmt.Errorf("complete task %s: %w", id, ErrConflict)
	}
	s.core.tasks[i].Status = task.StatusDone
	s.core.tasks[i].Version++
	return nil
}

// Update replaces the task with the same id, but only while the view owns it
// and it is still at the version the argument carries. Every field but the id
// is replaced by the argument's — the tag set included, which is why Update
// takes the whole task rather than a list of changed fields: the caller read a
// snapshot, changed what it meant to change, and hands the whole snapshot
// back. The compare and the write happen under one write lock, so no writer
// can slip between them: a stale version fails with ErrConflict, a missing id
// or one outside the scope with ErrNotFound. On success the stored task is
// returned at the bumped version, its tags cloned so the caller's slice cannot
// reach the store's state. A done ctx aborts before the lock.
func (s *MemoryStore) Update(ctx context.Context, t task.Task) (task.Task, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "update task"); err != nil {
		return task.Task{}, err
	}
	s.core.mu.Lock()
	defer s.core.mu.Unlock()
	i := s.findLocked(t.ID)
	if i < 0 {
		return task.Task{}, fmt.Errorf("update task %s: %w", t.ID, ErrNotFound)
	}
	if s.core.tasks[i].Version != t.Version {
		return task.Task{}, fmt.Errorf("update task %s: %w", t.ID, ErrConflict)
	}
	t.Version++
	s.core.tasks[i] = storedTask{Task: copyTask(t), owner: s.owner}
	return t, nil
}

// Delete removes the task with the given id, but only while the view owns it
// and it is still at the given version: the same compare-and-swap Complete
// and Update use, with the same outcomes — ErrNotFound for a task missing
// from the scope, ErrConflict for a stale snapshot. The task's tags are part
// of the task, so they go with it. A done ctx aborts before the lock.
func (s *MemoryStore) Delete(ctx context.Context, id uuid.UUID, version int) error {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "delete task"); err != nil {
		return err
	}
	s.core.mu.Lock()
	defer s.core.mu.Unlock()
	i := s.findLocked(id)
	if i < 0 {
		return fmt.Errorf("delete task %s: %w", id, ErrNotFound)
	}
	if s.core.tasks[i].Version != version {
		return fmt.Errorf("delete task %s: %w", id, ErrConflict)
	}
	s.core.tasks = slices.Delete(s.core.tasks, i, i+1)
	return nil
}

// CompleteAll completes every target, best-effort, and returns the joined
// errors of the operations that failed (nil when all succeed). Each target
// carries the id and version the caller read, so a batch never overwrites a
// concurrent writer's update: a target whose version moved on fails with
// ErrConflict like any other stale write, and the batch keeps going. Every
// Complete call receives ctx, so a done context turns each remaining target
// into a cancellation failure like any other; the batch still visits all of
// them because best-effort is its contract.
func CompleteAll(ctx context.Context, s Store, targets []task.Task) error {
	var errs []error
	for _, t := range targets {
		if err := s.Complete(ctx, t.ID, t.Version); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// insertAll is the memory store's half of ImportJSON. There is no
// transaction to ride in memory, so atomicity comes from buffering: the
// stream is pulled into a slice and the whole batch is appended under one
// write lock, so a failure while streaming leaves the buffer behind and
// never the store, and a success makes every task visible in one critical
// section. The batch lands in the view's scope, like every other write: an
// import through the user-less store writes user-less tasks. The buffer is
// not a violation of the importer's bound — it is the store's own state
// arriving, and the importer itself still holds one task at a time. The ops
// counter does not move: insertAll is not a Store method, it is the door
// ImportJSON opens.
func (s *MemoryStore) insertAll(ctx context.Context, stream taskStream) (int, error) {
	if err := ctxErr(ctx, "import tasks"); err != nil {
		return 0, err
	}
	var batch []task.Task
	for {
		t, err := stream()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, err
		}
		batch = append(batch, t)
	}
	s.core.mu.Lock()
	defer s.core.mu.Unlock()
	for _, t := range batch {
		s.core.tasks = append(s.core.tasks, storedTask{Task: t, owner: s.owner})
	}
	return len(batch), nil
}

// List returns the view's tasks in insertion order. The returned slice is a
// copy: callers cannot reorder or replace the store's slice by mutating it.
// On a done ctx it returns nil and an error wrapping context.Cause(ctx).
func (s *MemoryStore) List(ctx context.Context) ([]task.Task, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "list tasks"); err != nil {
		return nil, err
	}
	s.core.mu.RLock()
	defer s.core.mu.RUnlock()
	return s.listLocked(), nil
}

// listLocked returns a copy of the view's tasks: the rows whose owner matches
// the scope, each with its tags cloned. The result is nil when the scope
// holds nothing, matching List's empty-store promise. The caller must hold
// mu, for reading or writing; like every *Locked helper it never acquires
// the lock, which is what keeps an exported method from re-entering mu.
func (s *MemoryStore) listLocked() []task.Task {
	var tasks []task.Task
	for _, st := range s.core.tasks {
		if st.owner == s.owner {
			tasks = append(tasks, copyTask(st.Task))
		}
	}
	return tasks
}

// findLocked returns the index of the view's task with the given id, or -1
// when the scope holds none. A task another owner holds is not found: the
// owner predicate is part of the lookup, exactly as it is part of the SQL.
// The caller must hold mu; the helper never acquires it.
func (s *MemoryStore) findLocked(id uuid.UUID) int {
	for i, st := range s.core.tasks {
		if st.ID == id && st.owner == s.owner {
			return i
		}
	}
	return -1
}

// copyTask returns a task whose tags slice is its own. It is how the read
// methods hand out what they hold without handing out the store's own
// memory: the struct is a value already, and the slice is the one field that
// would still alias.
func copyTask(t task.Task) task.Task {
	t.Tags = slices.Clone(t.Tags)
	return t
}

// filter returns the elements of xs for which keep returns true. It returns
// nil when nothing matches.
func filter[T any](xs []T, keep func(T) bool) []T {
	var matches []T
	for _, x := range xs {
		if keep(x) {
			matches = append(matches, x)
		}
	}
	return matches
}

// ByStatus returns the view's tasks whose Status equals status, in insertion
// order. On a done ctx it returns nil and an error wrapping
// context.Cause(ctx).
func (s *MemoryStore) ByStatus(ctx context.Context, status task.Status) ([]task.Task, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "tasks by status"); err != nil {
		return nil, err
	}
	s.core.mu.RLock()
	defer s.core.mu.RUnlock()
	return filter(s.listLocked(), func(t task.Task) bool { return t.Status == status }), nil
}

// ByTag returns the view's tasks carrying the given tag, in insertion order.
// On a done ctx it returns nil and an error wrapping context.Cause(ctx).
func (s *MemoryStore) ByTag(ctx context.Context, tag string) ([]task.Task, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "tasks by tag"); err != nil {
		return nil, err
	}
	s.core.mu.RLock()
	defer s.core.mu.RUnlock()
	return filter(s.listLocked(), func(t task.Task) bool { return slices.Contains(t.Tags, tag) }), nil
}

// Tags returns every distinct tag across the view's tasks, sorted. On a done
// ctx it returns nil and an error wrapping context.Cause(ctx).
//
// Tags composes from countByTagLocked under the one RLock it takes. Calling
// the exported CountByTag here instead would re-enter the lock while holding
// it, and that deadlocks: Go's RWMutex makes a queued writer block every new
// reader, so a second RLock waits for a writer that is itself waiting behind
// Tags' first RLock. With many goroutines calling Tags on a store taking
// writes, the arrival that triggers it is a matter of when, not if. The rule
// that rules the class out: acquire mu exactly once, at the exported
// boundary, and let helpers assume it is held.
func (s *MemoryStore) Tags(ctx context.Context) ([]string, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "list tags"); err != nil {
		return nil, err
	}
	s.core.mu.RLock()
	defer s.core.mu.RUnlock()
	return slices.Sorted(maps.Keys(s.countByTagLocked())), nil
}

// CountByTag returns, for every distinct tag on the view's tasks, how many
// tasks carry it. A task counts at most once per tag; tasks with no tags
// contribute nothing. The map is non-nil even when nothing is counted; on a
// done ctx it returns nil and an error wrapping context.Cause(ctx).
func (s *MemoryStore) CountByTag(ctx context.Context) (map[string]int, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "count by tag"); err != nil {
		return nil, err
	}
	s.core.mu.RLock()
	defer s.core.mu.RUnlock()
	return s.countByTagLocked(), nil
}

// countByTagLocked is CountByTag's body under a held lock, over the view's
// tasks. The caller must hold mu; the helper never acquires it. The returned
// map is always non-nil.
func (s *MemoryStore) countByTagLocked() map[string]int {
	counts := make(map[string]int)
	for _, st := range s.core.tasks {
		if st.owner != s.owner {
			continue
		}
		seen := make(map[string]bool, len(st.Tags))
		for _, tag := range st.Tags {
			if seen[tag] {
				continue
			}
			seen[tag] = true
			counts[tag]++
		}
	}
	return counts
}

// SortByDue returns the view's tasks sorted by Due ascending, with tasks that
// have no due date (zero time) last. Equal due dates keep insertion order. On
// a done ctx it returns nil and an error wrapping context.Cause(ctx).
func (s *MemoryStore) SortByDue(ctx context.Context) ([]task.Task, error) {
	s.core.ops.Add(1)
	if err := ctxErr(ctx, "sort by due"); err != nil {
		return nil, err
	}
	// The lock covers the copy only, and the unlock is explicit rather than
	// deferred to show the scope: the sort below reads the private copy and
	// never touches the store's rows, so holding the read lock through an
	// O(n log n) sort would only delay the next writer. Nothing between
	// here and the return can acquire mu again.
	s.core.mu.RLock()
	sorted := s.listLocked()
	s.core.mu.RUnlock()
	// zeroRank maps "no due date" to 1, so cmp.Compare sorts those tasks
	// after every task that has a due date.
	zeroRank := func(t time.Time) int {
		if t.IsZero() {
			return 1
		}
		return 0
	}
	slices.SortStableFunc(sorted, func(a, b task.Task) int {
		if c := cmp.Compare(zeroRank(a.Due), zeroRank(b.Due)); c != 0 {
			return c
		}
		return a.Due.Compare(b.Due)
	})
	return sorted, nil
}
````


## `internal/store/store_test.go`

````go
package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)

// missingID is the fixed, valid UUID no store holds. Tests that need a miss
// use it instead of a random one so the expected error text is a constant.
var missingID = uuid.MustParse("00000000-0000-0000-0000-000000000042")

// mustStore returns a store holding the given tasks in insertion order, each
// with a store-assigned id.
func mustStore(t *testing.T, tasks ...task.Task) *MemoryStore {
	t.Helper()
	s := NewMemoryStore()
	for _, tt := range tasks {
		got, err := s.Add(context.Background(), tt)
		require.NoError(t, err)
		require.NotEqual(t, uuid.Nil, got.ID, "Add assigns a non-nil id")
	}
	return s
}

func TestMemoryStore_AddAndList(t *testing.T) {
	t.Parallel()

	s := NewMemoryStore()

	tests := []struct {
		name  string
		title string
	}{
		{name: "first add", title: "write tests"},
		{name: "second add", title: "make them pass"},
		{name: "third add", title: "refactor"},
	}

	var ids []uuid.UUID
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// No t.Parallel: these subtests share s, and each id depends
			// on the adds that came before it.
			got, err := s.Add(context.Background(), task.Task{Title: tt.title, Status: task.StatusTodo})
			require.NoError(t, err)
			require.NotEqual(t, uuid.Nil, got.ID)
			assert.Equal(t, tt.title, got.Title)
			ids = append(ids, got.ID)
		})
	}

	wantTitles := []string{"write tests", "make them pass", "refactor"}
	list, err := s.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, len(wantTitles))
	for i, want := range wantTitles {
		assert.Equal(t, want, list[i].Title)
		assert.Equal(t, ids[i], list[i].ID, "List returns the ids Add handed out, in order")
	}

	// The returned slice is a copy: reordering and overwriting it must not
	// reach the store's own slice.
	list[0], list[2] = list[2], list[0]
	list[0] = task.Task{Title: "mutated"}
	fresh, err := s.List(context.Background())
	require.NoError(t, err)
	require.Len(t, fresh, len(wantTitles))
	for i, want := range wantTitles {
		assert.Equal(t, want, fresh[i].Title)
	}
}

// TestUUIDv7_Monotonic pins the property the id era buys: ids assigned in
// sequence sort in insertion order. google/uuid's NewV7 draws its timestamp
// from a process-wide (milliseconds, sequence) counter that is guaranteed to
// increase with every call — verified against v1.6.0's getV7Time and
// empirically over 200,000 calls — so the 60-bit prefix of each id, and
// therefore the whole byte string, is strictly increasing while the process
// lives. The store generates the id inside its write lock, which is what
// makes "assignment order" and "slice order" the same sequence. The sorted
// comparison below is the property stated the way a caller would use it:
// sorting by id reproduces insertion order.
func TestUUIDv7_Monotonic(t *testing.T) {
	t.Parallel()

	const n = 1000
	s := NewMemoryStore()
	added := make([]task.Task, n)
	for i := range added {
		got, err := s.Add(context.Background(), task.Task{Title: fmt.Sprintf("task %03d", i)})
		require.NoError(t, err)
		added[i] = got
	}

	for i := 1; i < len(added); i++ {
		assert.Negative(t, bytes.Compare(added[i-1].ID[:], added[i].ID[:]),
			"id %d sorts before id %d", i-1, i)
	}

	ids := make([]uuid.UUID, len(added))
	for i, tt := range added {
		ids[i] = tt.ID
		assert.Equal(t, uuid.Version(7), tt.ID.Version())
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	for i, id := range ids {
		assert.Equal(t, added[i].ID, id, "sorted order equals insertion order")
	}
}

func TestMemoryStore_ByStatus(t *testing.T) {
	t.Parallel()

	added := []task.Task{
		{Title: "write tests", Status: task.StatusTodo},
		{Title: "review code", Status: task.StatusDone},
		{Title: "ship it", Status: task.StatusTodo},
		{Title: "archive", Status: task.StatusDone},
		// "Blocked" is deliberately outside the known statuses: the type
		// admits it, and ByStatus is plain equality.
		{Title: "read spec", Status: task.Status("Blocked")},
	}
	s := mustStore(t, added...)

	tests := []struct {
		name       string
		status     task.Status
		wantTitles []string
	}{
		{
			name:       "matching status keeps insertion order",
			status:     task.StatusTodo,
			wantTitles: []string{"write tests", "ship it"},
		},
		{
			name:       "done tasks",
			status:     task.StatusDone,
			wantTitles: []string{"review code", "archive"},
		},
		{
			name:       "single match",
			status:     task.Status("Blocked"),
			wantTitles: []string{"read spec"},
		},
		{
			name:       "unknown status returns nothing",
			status:     task.Status("Cancelled"),
			wantTitles: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			// s is read-only in these cases, so they may share it.
			got, err := s.ByStatus(context.Background(), tt.status)
			require.NoError(t, err)
			require.Len(t, got, len(tt.wantTitles))
			for i, want := range tt.wantTitles {
				assert.Equal(t, want, got[i].Title)
			}
		})
	}
}

func TestMemoryStore_ByTag(t *testing.T) {
	t.Parallel()

	added := []task.Task{
		{Title: "write tests", Tags: []string{"go", "testing"}},
		{Title: "review code", Tags: []string{"go", "review"}},
		{Title: "ship it", Tags: []string{"testing"}},
		{Title: "archive"},
	}
	s := mustStore(t, added...)

	tests := []struct {
		name       string
		tag        string
		wantTitles []string
	}{
		{
			name:       "tag shared by two tasks keeps insertion order",
			tag:        "go",
			wantTitles: []string{"write tests", "review code"},
		},
		{
			name:       "single match",
			tag:        "review",
			wantTitles: []string{"review code"},
		},
		{
			name:       "unknown tag returns nil",
			tag:        "urgent",
			wantTitles: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			// s is read-only in these cases, so they may share it.
			got, err := s.ByTag(context.Background(), tt.tag)
			require.NoError(t, err)
			require.Len(t, got, len(tt.wantTitles))
			for i, want := range tt.wantTitles {
				assert.Equal(t, want, got[i].Title)
			}
			if tt.wantTitles == nil {
				assert.Nil(t, got)
			}
		})
	}
}

func TestMemoryStore_Tags(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		tasks []task.Task
		want  []string
	}{
		{
			name: "distinct tags across tasks, sorted",
			tasks: []task.Task{
				{Title: "write tests", Tags: []string{"go", "testing"}},
				{Title: "review code", Tags: []string{"go", "review"}},
				{Title: "tag twice", Tags: []string{"go", "go", "testing"}},
				{Title: "no tags"},
			},
			want: []string{"go", "review", "testing"},
		},
		{
			name:  "tasks without tags contribute nothing",
			tasks: []task.Task{{Title: "first"}, {Title: "second"}},
			want:  nil,
		},
		{
			name:  "empty store",
			tasks: nil,
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, tt.tasks...)

			got, err := s.Tags(context.Background())
			require.NoError(t, err)
			require.Len(t, got, len(tt.want))
			for i, want := range tt.want {
				assert.Equal(t, want, got[i])
			}
			if tt.want == nil {
				assert.Nil(t, got)
			}
		})
	}
}

func TestFilter(t *testing.T) {
	t.Parallel()

	t.Run("ints", func(t *testing.T) {
		t.Parallel()

		even := func(n int) bool { return n%2 == 0 }
		tests := []struct {
			name string
			xs   []int
			keep func(int) bool
			want []int
		}{
			{
				name: "keeps matching elements in order",
				xs:   []int{1, 2, 3, 4, 5, 6},
				keep: even,
				want: []int{2, 4, 6},
			},
			{
				name: "all true keeps everything",
				xs:   []int{1, 2, 3},
				keep: func(int) bool { return true },
				want: []int{1, 2, 3},
			},
			{
				name: "all false returns nil",
				xs:   []int{1, 3, 5},
				keep: even,
				want: nil,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				t.Parallel()

				got := filter(tt.xs, tt.keep)
				require.Len(t, got, len(tt.want))
				for i, want := range tt.want {
					assert.Equal(t, want, got[i])
				}
				if tt.want == nil {
					assert.Nil(t, got)
				}
			})
		}
	})

	t.Run("task.Task", func(t *testing.T) {
		t.Parallel()

		tasks := []task.Task{
			{Title: "write tests", Status: task.StatusTodo},
			{Title: "review code", Status: task.StatusDone},
			{Title: "ship it", Status: task.StatusTodo},
		}
		tests := []struct {
			name string
			keep func(task.Task) bool
			want []string
		}{
			{
				name: "keeps tasks by status",
				keep: func(tt task.Task) bool { return tt.Status == task.StatusTodo },
				want: []string{"write tests", "ship it"},
			},
			{
				name: "all false returns nil",
				keep: func(tt task.Task) bool { return tt.Status == task.Status("Cancelled") },
				want: nil,
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				t.Parallel()

				got := filter(tasks, tt.keep)
				require.Len(t, got, len(tt.want))
				for i, want := range tt.want {
					assert.Equal(t, want, got[i].Title)
				}
				if tt.want == nil {
					assert.Nil(t, got)
				}
			})
		}
	})
}

func TestMemoryStore_CountByTag(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		tasks []task.Task
		want  map[string]int
	}{
		{
			name: "overlapping, repeated, and missing tags",
			tasks: []task.Task{
				{Title: "write tests", Tags: []string{"go", "testing"}},
				{Title: "review code", Tags: []string{"go", "review"}},
				{Title: "tag twice", Tags: []string{"go", "go", "testing"}},
				{Title: "no tags"},
				{Title: "one tag", Tags: []string{"review"}},
			},
			want: map[string]int{"go": 3, "testing": 2, "review": 2},
		},
		{
			name:  "tasks without tags contribute nothing",
			tasks: []task.Task{{Title: "first"}, {Title: "second"}},
			want:  map[string]int{},
		},
		{
			name:  "empty store",
			tasks: nil,
			want:  map[string]int{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, tt.tasks...)

			got, err := s.CountByTag(context.Background())
			require.NoError(t, err)
			assert.Len(t, got, len(tt.want))
			for tag, wantCount := range tt.want {
				assert.Equalf(t, wantCount, got[tag], "CountByTag()[%q]", tag)
			}
			for tag, count := range got {
				_, ok := tt.want[tag]
				assert.Truef(t, ok, "CountByTag() has unexpected tag %q = %d", tag, count)
			}
		})
	}
}

func TestMemoryStore_SortByDue(t *testing.T) {
	t.Parallel()

	day := func(d int) time.Time {
		return time.Date(2026, 11, d, 0, 0, 0, 0, time.UTC)
	}

	// wantOrder indexes the tasks as they were added: the expected result,
	// ids and all, is rebuilt from what Add returned, because v7 ids are
	// random-looking values the table cannot spell out.
	tests := []struct {
		name      string
		tasks     []task.Task
		wantOrder []int
	}{
		{
			name: "zero due dates last",
			tasks: []task.Task{
				{Title: "no due"},
				{Title: "later", Due: day(20)},
				{Title: "sooner", Due: day(5)},
				{Title: "also none"},
			},
			wantOrder: []int{2, 1, 0, 3},
		},
		{
			name: "ties keep insertion order",
			tasks: []task.Task{
				{Title: "first tie", Due: day(10)},
				{Title: "second tie", Due: day(10)},
				{Title: "earlier", Due: day(1)},
				{Title: "third tie", Due: day(10)},
			},
			wantOrder: []int{2, 0, 1, 3},
		},
		{
			name:  "empty store",
			tasks: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, tt.tasks...)
			added, err := s.List(context.Background())
			require.NoError(t, err)
			require.Len(t, added, len(tt.tasks))

			var want []task.Task
			for _, i := range tt.wantOrder {
				want = append(want, added[i])
			}

			got, err := s.SortByDue(context.Background())
			require.NoError(t, err)
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("SortByDue() mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestMemoryStore_Complete(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		stale        bool
		missing      bool
		wantErr      error
		wantErrMsg   string
		wantStatus   []task.Status
		wantVersions []int
	}{
		{
			name:         "existing task is marked done",
			wantStatus:   []task.Status{task.StatusTodo, task.StatusDone},
			wantVersions: []int{1, 2},
		},
		{
			name:       "missing task reports ErrNotFound",
			missing:    true,
			wantErr:    ErrNotFound,
			wantErrMsg: "complete task " + missingID.String() + ": ",
		},
		{
			name:       "stale version reports ErrConflict",
			stale:      true,
			wantErr:    ErrConflict,
			wantErrMsg: "complete task ",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t,
				task.Task{Title: "write tests", Status: task.StatusTodo},
				task.Task{Title: "make them pass", Status: task.StatusTodo},
			)
			added, err := s.List(context.Background())
			require.NoError(t, err)

			// The case completes the second task; the miss names an id no
			// store can hold, and the stale case completes the task once
			// with its real snapshot and then again with that same snapshot.
			target := added[1]
			if tt.missing {
				target.ID = missingID
			}
			if tt.stale {
				require.NoError(t, s.Complete(context.Background(), target.ID, target.Version))
			}

			err = s.Complete(context.Background(), target.ID, target.Version)
			if tt.wantErr != nil {
				require.Error(t, err)
				assert.ErrorIs(t, err, tt.wantErr)
				assert.Contains(t, err.Error(), tt.wantErrMsg)
				return
			}

			require.NoError(t, err)
			list, err := s.List(context.Background())
			require.NoError(t, err)
			require.Len(t, list, len(tt.wantStatus))
			for i, want := range tt.wantStatus {
				assert.Equal(t, want, list[i].Status)
				assert.Equal(t, tt.wantVersions[i], list[i].Version)
			}
		})
	}
}

func TestCompleteAll(t *testing.T) {
	t.Parallel()

	errBoom := errors.New("disk on fire")

	tests := []struct {
		name       string
		wantErrs   []error
		wantStatus []task.Status
	}{
		{
			name: "failing and missing targets do not stop the batch",
			// The second task is scripted to fail, the fixed missing id
			// does not exist, and the first task must complete despite
			// both: a failure does not stop the batch.
			wantErrs:   []error{errBoom, ErrNotFound},
			wantStatus: []task.Status{task.StatusDone, task.StatusTodo},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			// StoreMock scripts the failure the real store cannot produce.
			// Add and List delegate to a real store, and Complete passes
			// everything except the scripted id through: the first target
			// must really succeed and the fixed missing id must really be
			// ErrNotFound.
			real := NewMemoryStore()
			var scripted uuid.UUID
			s := &StoreMock{
				AddFunc: func(ctx context.Context, t task.Task) (task.Task, error) {
					return real.Add(ctx, t)
				},
				ListFunc: func(ctx context.Context) ([]task.Task, error) {
					return real.List(ctx)
				},
				CompleteFunc: func(ctx context.Context, id uuid.UUID, version int) error {
					if id == scripted {
						return errBoom
					}
					return real.Complete(ctx, id, version)
				},
			}
			added := make([]task.Task, 0, 2)
			for _, title := range []string{"write tests", "make them pass"} {
				got, err := s.Add(context.Background(), task.Task{Title: title, Status: task.StatusTodo})
				require.NoError(t, err)
				added = append(added, got)
			}
			scripted = added[1].ID
			targets := []task.Task{added[0], added[1], {ID: missingID, Version: 1}}

			err := CompleteAll(context.Background(), s, targets)
			require.Error(t, err)
			for _, wantErr := range tt.wantErrs {
				assert.ErrorIs(t, err, wantErr)
			}

			list, err := s.List(context.Background())
			require.NoError(t, err)
			require.Len(t, list, len(tt.wantStatus))
			for i, want := range tt.wantStatus {
				assert.Equal(t, want, list[i].Status)
			}
		})
	}
}

func TestCompleteAll_AllOK(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		wantStatus []task.Status
	}{
		{
			name:       "every target completes",
			wantStatus: []task.Status{task.StatusDone, task.StatusDone},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t,
				task.Task{Title: "write tests", Status: task.StatusTodo},
				task.Task{Title: "make them pass", Status: task.StatusTodo},
			)
			added, err := s.List(context.Background())
			require.NoError(t, err)

			require.NoError(t, CompleteAll(context.Background(), s, added))

			list, err := s.List(context.Background())
			require.NoError(t, err)
			require.Len(t, list, len(tt.wantStatus))
			for i, want := range tt.wantStatus {
				assert.Equal(t, want, list[i].Status)
				assert.Equal(t, 2, list[i].Version)
			}
		})
	}
}

// storeCall names one Store method and runs it against s with ctx, discarding
// any returned values: the cancellation tests care about the error alone.
type storeCall struct {
	name string
	call func(s *MemoryStore, ctx context.Context) error
}

// storeCalls is the table behind the cancellation tests. Every Store method
// appears exactly once, so one loop covers the whole surface; the table is
// rebuilt per test so the closures never share state.
func storeCalls() []storeCall {
	return []storeCall{
		{
			name: "Add",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.Add(ctx, task.Task{Title: "write tests"})
				return err
			},
		},
		{
			name: "List",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.List(ctx)
				return err
			},
		},
		{
			name: "ByStatus",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.ByStatus(ctx, task.StatusTodo)
				return err
			},
		},
		{
			name: "ByTag",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.ByTag(ctx, "go")
				return err
			},
		},
		{
			name: "CountByTag",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.CountByTag(ctx)
				return err
			},
		},
		{
			name: "Tags",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.Tags(ctx)
				return err
			},
		},
		{
			name: "SortByDue",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.SortByDue(ctx)
				return err
			},
		},
		{
			name: "Complete",
			call: func(s *MemoryStore, ctx context.Context) error {
				return s.Complete(ctx, uuid.Nil, 1)
			},
		},
		{
			name: "Stats",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.Stats(ctx)
				return err
			},
		},
	}
}

func TestMemoryStore_CanceledContext(t *testing.T) {
	t.Parallel()

	s := mustStore(t, task.Task{Title: "write tests", Status: task.StatusTodo})

	// Pre-canceled: ctx is done before any method runs, so every entry
	// check sees it — no method starts work, which is what keeps the table
	// deterministic. Each method still wraps the same cause in its own
	// operation name.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	for _, tt := range storeCalls() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			err := tt.call(s, ctx)
			require.Error(t, err)
			assert.ErrorIs(t, err, context.Canceled)
		})
	}
}

// errBudget is the custom cancellation cause the propagation test feeds into
// the store; it is package-level so every subtest compares against the same
// value.
var errBudget = errors.New("budget exhausted")

func TestMemoryStore_CustomCancelCause(t *testing.T) {
	t.Parallel()

	s := mustStore(t, task.Task{Title: "write tests", Status: task.StatusTodo})

	// WithCancelCause lets the caller attach the reason; context.Cause
	// returns it, and the store wraps the cause — replacing the generic
	// context.Canceled — into the operation error.
	ctx, cancel := context.WithCancelCause(context.Background())
	cancel(errBudget)

	for _, tt := range storeCalls() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			err := tt.call(s, ctx)
			require.ErrorIs(t, err, errBudget, "the custom cause comes through context.Cause")
			assert.NotErrorIs(t, err, context.Canceled, "a custom cause replaces context.Canceled in the chain")
		})
	}
}
````


## `internal/store/storetest/suite.go`

````go
// Package storetest is the Store conformance suite: one test body that every
// implementation of todo/internal/store.Store must pass. It lives in its own
// package so the same suite can run against several implementations from one
// external test package. The suite imports store, which is exactly why its
// caller cannot be an internal test file of package store — that would be an
// import cycle — so the caller is an external test package such as
// store_test.
package storetest

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/task"
)

// missingID is the fixed, valid UUID no store holds. The suite's miss cases
// use it so their expected error text is a constant.
var missingID = uuid.MustParse("00000000-0000-0000-0000-000000000042")

// OwnerA and OwnerB are the two user ids the scoping cases act as. They are
// exported because a store whose schema enforces that a task's owner exists —
// the Turso store's owner_id foreign key — needs the user rows to exist
// before the cases add tasks owned by them, and the suite seeds through the
// Store contract only, which does not know users. The caller that holds the
// database seeds the two rows (see conformance_test.go); the ids themselves
// are opaque to the suite.
var (
	OwnerA = uuid.MustParse("0199cafe-0000-7000-8000-0000000000a1")
	OwnerB = uuid.MustParse("0199cafe-0000-7000-8000-0000000000b2")
)

// Run exercises the Store contract against one implementation. newStore
// returns a fresh store per subtest and a cleanup.
//
// The suite is the deterministic subset of the contract: it seeds every
// store through Add, so it works against any implementation, and it never
// races, sleeps, or measures time. Concurrency and persistence specifics
// stay in each implementation's own tests; what is pinned here is what all
// implementations must agree on.
func Run(t *testing.T, newStore func(t *testing.T) store.Store) {
	t.Helper()

	t.Run("AddAndList", func(t *testing.T) {
		s := newStore(t)

		seeds := []task.Task{
			{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: due(1), Tags: []string{"go", "book"}},
			{Title: "review code", Status: task.StatusTodo, Priority: task.PriorityMax, Tags: []string{"review"}},
			{Title: "tag twice", Status: task.StatusTodo, Tags: []string{"go", "go", "testing"}},
			{Title: "ship it", Status: task.StatusTodo, Priority: task.PriorityMin},
		}
		want := addAll(t, s, seeds...)

		got, err := s.List(context.Background())
		require.NoError(t, err)
		if diff := cmp.Diff(canonicalAll(want), canonicalAll(got)); diff != "" {
			t.Errorf("List() mismatch (-want +got):\n%s", diff)
		}

		// The returned slice is a copy: overwriting it must not reach the
		// store's own state.
		got[0] = task.Task{Title: "mutated"}
		fresh, err := s.List(context.Background())
		require.NoError(t, err)
		require.Len(t, fresh, len(seeds))
		assert.Equal(t, "write tests", fresh[0].Title)
	})

	t.Run("EmptyStore", func(t *testing.T) {
		s := newStore(t)
		ctx := context.Background()

		list, err := s.List(ctx)
		require.NoError(t, err)
		assert.Nil(t, list, "List returns nil on an empty store")

		byStatus, err := s.ByStatus(ctx, task.StatusTodo)
		require.NoError(t, err)
		assert.Nil(t, byStatus, "ByStatus returns nil when nothing matches")

		byTag, err := s.ByTag(ctx, "go")
		require.NoError(t, err)
		assert.Nil(t, byTag, "ByTag returns nil when nothing matches")

		sorted, err := s.SortByDue(ctx)
		require.NoError(t, err)
		assert.Nil(t, sorted, "SortByDue returns nil on an empty store")

		tags, err := s.Tags(ctx)
		require.NoError(t, err)
		assert.Nil(t, tags, "Tags returns nil when there are no tags")

		counts, err := s.CountByTag(ctx)
		require.NoError(t, err)
		assert.NotNil(t, counts, "CountByTag returns a non-nil map even when empty")
		assert.Empty(t, counts)

		stats, err := s.Stats(ctx)
		require.NoError(t, err)
		assert.Equal(t, store.Stats{ByTag: map[string]int{}}, stats)
	})

	t.Run("Complete", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s,
			task.Task{Title: "write tests", Status: task.StatusTodo},
			task.Task{Title: "review code", Status: task.StatusTodo},
		)
		require.Equal(t, 1, added[0].Version, "Add starts every task at version 1")

		require.NoError(t, s.Complete(context.Background(), added[0].ID, added[0].Version))

		got, err := s.List(context.Background())
		require.NoError(t, err)
		require.Len(t, got, 2)
		assert.Equal(t, task.StatusDone, got[0].Status)
		assert.Equal(t, 2, got[0].Version, "Complete bumps the version")
		assert.Equal(t, task.StatusTodo, got[1].Status)
		assert.Equal(t, 1, got[1].Version, "other tasks keep their version")
	})

	t.Run("CompleteStaleVersion", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s, task.Task{Title: "write tests", Status: task.StatusTodo})
		stale := added[0] // the caller's snapshot: id and version together

		require.NoError(t, s.Complete(context.Background(), stale.ID, stale.Version))

		// The same snapshot is one version behind now: the second write
		// must lose the compare-and-swap instead of overwriting the first.
		err := s.Complete(context.Background(), stale.ID, stale.Version)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrConflict)
		assert.NotErrorIs(t, err, store.ErrNotFound, "a stale version is not a missing task")
		assert.Contains(t, err.Error(), "complete task "+stale.ID.String())

		got, err := s.List(context.Background())
		require.NoError(t, err)
		require.Len(t, got, 1)
		assert.Equal(t, task.StatusDone, got[0].Status)
		assert.Equal(t, 2, got[0].Version, "the winner bumped the version exactly once")
	})

	t.Run("CompleteMissing", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s, task.Task{Title: "write tests", Status: task.StatusTodo})

		err := s.Complete(context.Background(), missingID, 1)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.NotErrorIs(t, err, store.ErrConflict, "a missing task is not a conflict")
		assert.Contains(t, err.Error(), "complete task "+missingID.String())
	})

	t.Run("Get", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s,
			task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityMax, Due: due(1), Tags: []string{"go", "book"}},
			task.Task{Title: "review code", Status: task.StatusDone},
		)

		got, err := s.Get(context.Background(), added[0].ID)
		require.NoError(t, err)
		if diff := cmp.Diff(canonical(added[0]), canonical(got)); diff != "" {
			t.Errorf("Get() mismatch (-want +got):\n%s", diff)
		}

		// The returned task is a copy, its tags included: overwriting both
		// must not reach the store's own state.
		got.Title = "mutated"
		got.Tags[0] = "mutated"
		fresh, err := s.Get(context.Background(), added[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "write tests", fresh.Title)
		assert.Contains(t, fresh.Tags, "go")

		_, err = s.Get(context.Background(), missingID)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.Contains(t, err.Error(), "get task "+missingID.String())
	})

	t.Run("Update", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s,
			task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Tags: []string{"go", "old"}},
			task.Task{Title: "review code", Status: task.StatusTodo},
		)

		// The caller's snapshot, changed the way the caller means to
		// change it: Update replaces every field the argument carries.
		next := added[0]
		next.Title = "write more tests"
		next.Status = task.StatusDone
		next.Priority = task.PriorityMax
		next.Due = due(3)
		next.Tags = []string{"go", "review"}

		stored, err := s.Update(context.Background(), next)
		require.NoError(t, err)
		assert.Equal(t, 2, stored.Version, "Update bumps the version")
		want := next
		want.Version = 2
		if diff := cmp.Diff(canonical(want), canonical(stored)); diff != "" {
			t.Errorf("Update() mismatch (-want +got):\n%s", diff)
		}

		// The store holds the updated task — the tag set replaced, not
		// merged: "old" is gone — and the other task is untouched.
		fresh, err := s.Get(context.Background(), added[0].ID)
		require.NoError(t, err)
		if diff := cmp.Diff(canonical(want), canonical(fresh)); diff != "" {
			t.Errorf("Get() after Update mismatch (-want +got):\n%s", diff)
		}
		all, err := s.List(context.Background())
		require.NoError(t, err)
		require.Len(t, all, 2)
		if diff := cmp.Diff(added[1], all[1]); diff != "" {
			t.Errorf("the other task changed (-want +got):\n%s", diff)
		}
	})

	t.Run("UpdateStaleVersion", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s, task.Task{Title: "write tests", Status: task.StatusTodo})
		stale := added[0] // the caller's snapshot: id and version together

		first := stale
		first.Title = "first write"
		_, err := s.Update(context.Background(), first)
		require.NoError(t, err)

		// The same snapshot is one version behind now: the second write
		// must lose the compare-and-swap instead of overwriting the first.
		second := stale
		second.Title = "second write"
		_, err = s.Update(context.Background(), second)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrConflict)
		assert.NotErrorIs(t, err, store.ErrNotFound, "a stale version is not a missing task")
		assert.Contains(t, err.Error(), "update task "+stale.ID.String())

		got, err := s.Get(context.Background(), stale.ID)
		require.NoError(t, err)
		assert.Equal(t, "first write", got.Title, "the winner's state stands")
		assert.Equal(t, 2, got.Version, "the winner bumped the version exactly once")
	})

	t.Run("UpdateMissing", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s, task.Task{Title: "write tests"})

		_, err := s.Update(context.Background(), task.Task{ID: missingID, Version: 1, Title: "ghost"})
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.NotErrorIs(t, err, store.ErrConflict, "a missing task is not a conflict")
		assert.Contains(t, err.Error(), "update task "+missingID.String())
	})

	t.Run("Delete", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s,
			task.Task{Title: "write tests", Status: task.StatusTodo, Tags: []string{"go", "testing"}},
			task.Task{Title: "review code", Status: task.StatusTodo, Tags: []string{"review"}},
		)

		require.NoError(t, s.Delete(context.Background(), added[0].ID, added[0].Version))

		got, err := s.List(context.Background())
		require.NoError(t, err)
		require.Len(t, got, 1)
		assert.Equal(t, added[1].ID, got[0].ID)

		// The task's tags went with it: nothing counts "go" or "testing"
		// any more.
		counts, err := s.CountByTag(context.Background())
		require.NoError(t, err)
		assert.Equal(t, map[string]int{"review": 1}, counts)

		// The same snapshot again finds no task: the second delete is a
		// miss, not a conflict.
		err = s.Delete(context.Background(), added[0].ID, added[0].Version)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.NotErrorIs(t, err, store.ErrConflict)
	})

	t.Run("DeleteStaleVersion", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s, task.Task{Title: "write tests"})
		stale := added[0]

		next := stale
		next.Status = task.StatusDone
		_, err := s.Update(context.Background(), next)
		require.NoError(t, err)

		err = s.Delete(context.Background(), stale.ID, stale.Version)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrConflict)
		assert.NotErrorIs(t, err, store.ErrNotFound, "a stale version is not a missing task")
		assert.Contains(t, err.Error(), "delete task "+stale.ID.String())

		// The task is still there.
		_, err = s.Get(context.Background(), stale.ID)
		require.NoError(t, err)
	})

	t.Run("DeleteMissing", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s, task.Task{Title: "write tests"})

		err := s.Delete(context.Background(), missingID, 1)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.NotErrorIs(t, err, store.ErrConflict, "a missing task is not a conflict")
		assert.Contains(t, err.Error(), "delete task "+missingID.String())
	})

	t.Run("ByStatus", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s,
			task.Task{Title: "write tests", Status: task.StatusTodo},
			task.Task{Title: "review code", Status: task.StatusDone},
			task.Task{Title: "ship it", Status: task.StatusTodo},
			task.Task{Title: "archive", Status: task.StatusDone},
		)

		ctx := context.Background()

		todo, err := s.ByStatus(ctx, task.StatusTodo)
		require.NoError(t, err)
		assert.Equal(t, []string{"write tests", "ship it"}, titles(todo))

		done, err := s.ByStatus(ctx, task.StatusDone)
		require.NoError(t, err)
		assert.Equal(t, []string{"review code", "archive"}, titles(done))

		none, err := s.ByStatus(ctx, task.Status("Cancelled"))
		require.NoError(t, err)
		assert.Nil(t, none, "a status nothing matches returns nil")
	})

	t.Run("ByTag", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s,
			task.Task{Title: "write tests", Tags: []string{"go", "testing"}},
			task.Task{Title: "review code", Tags: []string{"go", "review"}},
			task.Task{Title: "ship it", Tags: []string{"testing"}},
			task.Task{Title: "archive"},
		)

		ctx := context.Background()

		goTag, err := s.ByTag(ctx, "go")
		require.NoError(t, err)
		assert.Equal(t, []string{"write tests", "review code"}, titles(goTag))

		review, err := s.ByTag(ctx, "review")
		require.NoError(t, err)
		assert.Equal(t, []string{"review code"}, titles(review))

		none, err := s.ByTag(ctx, "urgent")
		require.NoError(t, err)
		assert.Nil(t, none, "a tag nothing carries returns nil")
	})

	t.Run("CountByTag", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s,
			task.Task{Title: "write tests", Tags: []string{"go", "testing"}},
			task.Task{Title: "review code", Tags: []string{"go", "review"}},
			task.Task{Title: "tag twice", Tags: []string{"go", "go", "testing"}},
			task.Task{Title: "no tags"},
			task.Task{Title: "one tag", Tags: []string{"review"}},
		)

		got, err := s.CountByTag(context.Background())
		require.NoError(t, err)
		assert.Equal(t, map[string]int{"go": 3, "testing": 2, "review": 2}, got)
	})

	t.Run("Tags", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s,
			task.Task{Title: "write tests", Tags: []string{"go", "testing"}},
			task.Task{Title: "review code", Tags: []string{"go", "review"}},
			task.Task{Title: "tag twice", Tags: []string{"go", "go", "testing"}},
			task.Task{Title: "no tags"},
		)

		got, err := s.Tags(context.Background())
		require.NoError(t, err)
		assert.Equal(t, []string{"go", "review", "testing"}, got)
	})

	t.Run("SortByDue", func(t *testing.T) {
		t.Run("zero due dates last", func(t *testing.T) {
			s := newStore(t)
			added := addAll(t, s,
				task.Task{Title: "no due"},
				task.Task{Title: "later", Due: due(20)},
				task.Task{Title: "sooner", Due: due(5)},
				task.Task{Title: "also none"},
			)

			got, err := s.SortByDue(context.Background())
			require.NoError(t, err)
			// The expected result, ids and all, is rebuilt from what Add
			// returned: ids are store-assigned UUIDs, so the case pins the
			// order, not values it cannot know.
			want := []task.Task{added[2], added[1], added[0], added[3]}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("SortByDue() mismatch (-want +got):\n%s", diff)
			}
		})

		t.Run("ties keep insertion order", func(t *testing.T) {
			s := newStore(t)
			added := addAll(t, s,
				task.Task{Title: "first tie", Due: due(10)},
				task.Task{Title: "second tie", Due: due(10)},
				task.Task{Title: "earlier", Due: due(1)},
				task.Task{Title: "third tie", Due: due(10)},
			)

			got, err := s.SortByDue(context.Background())
			require.NoError(t, err)
			want := []task.Task{added[2], added[0], added[1], added[3]}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("SortByDue() mismatch (-want +got):\n%s", diff)
			}
		})
	})

	t.Run("Stats", func(t *testing.T) {
		s := newStore(t)
		addAll(t, s,
			task.Task{Title: "write tests", Status: task.StatusTodo, Tags: []string{"go", "testing"}},
			task.Task{Title: "review code", Status: task.StatusDone, Tags: []string{"go"}},
			task.Task{Title: "ship it", Status: task.StatusTodo, Tags: []string{"go", "go", "review"}},
			task.Task{Title: "no tags", Status: task.StatusTodo},
		)

		got, err := s.Stats(context.Background())
		require.NoError(t, err)
		want := store.Stats{
			Total:   4,
			Done:    1,
			Pending: 3,
			ByTag:   map[string]int{"go": 3, "testing": 1, "review": 1},
		}
		if diff := cmp.Diff(want, got); diff != "" {
			t.Errorf("Stats() mismatch (-want +got):\n%s", diff)
		}
	})

	t.Run("ScopedVisibility", func(t *testing.T) {
		s := newStore(t)
		ctx := context.Background()
		alice, bob := s.Scoped(OwnerA), s.Scoped(OwnerB)

		local := addAll(t, s, task.Task{Title: "local task"})
		mine := addAll(t, alice, task.Task{Title: "alice's task"})
		theirs := addAll(t, bob, task.Task{Title: "bob's task"})

		// Each scope lists exactly its own tasks, and the ownerless scope —
		// the local, user-less one — sees only the user-less task.
		got, err := alice.List(ctx)
		require.NoError(t, err)
		assert.Equal(t, []string{"alice's task"}, titles(got))

		got, err = bob.List(ctx)
		require.NoError(t, err)
		assert.Equal(t, []string{"bob's task"}, titles(got))

		got, err = s.List(ctx)
		require.NoError(t, err)
		assert.Equal(t, []string{"local task"}, titles(got))

		// A task another scope owns is a miss, not a leak: the store cannot
		// tell the caller the task exists but is not theirs.
		_, err = alice.Get(ctx, theirs[0].ID)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.NotErrorIs(t, err, store.ErrConflict)

		// The ownerless task is foreign to every user scope.
		_, err = alice.Get(ctx, local[0].ID)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)

		// The foreign task is untouched, and a view taken later shares the
		// data: scopes are views of one store, not copies.
		kept, err := bob.Get(ctx, theirs[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "bob's task", kept.Title)

		fresh := s.Scoped(OwnerA)
		mineBack, err := fresh.Get(ctx, mine[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "alice's task", mineBack.Title)
	})

	t.Run("ScopedForeignWrites", func(t *testing.T) {
		s := newStore(t)
		ctx := context.Background()
		alice, bob := s.Scoped(OwnerA), s.Scoped(OwnerB)
		theirs := addAll(t, bob, task.Task{Title: "bob's task", Status: task.StatusTodo})

		// Every compare-and-swap write answers a foreign task the same way a
		// missing one: ErrNotFound. The scope is part of the statement's own
		// WHERE clause, so it is checked before the version — a foreign write
		// with a stale version is still a miss, never a conflict.
		err := alice.Complete(ctx, theirs[0].ID, theirs[0].Version)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.NotErrorIs(t, err, store.ErrConflict)

		err = alice.Complete(ctx, theirs[0].ID, theirs[0].Version+5)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound, "ownership is checked before the version")

		_, err = alice.Update(ctx, task.Task{ID: theirs[0].ID, Version: theirs[0].Version, Title: "stolen"})
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)

		err = alice.Delete(ctx, theirs[0].ID, theirs[0].Version)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)

		// Bob's task survived every probe, untouched.
		got, err := bob.Get(ctx, theirs[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "bob's task", got.Title)
		assert.Equal(t, task.StatusTodo, got.Status)
		assert.Equal(t, 1, got.Version)
	})

	t.Run("ScopedAggregates", func(t *testing.T) {
		s := newStore(t)
		ctx := context.Background()
		alice := s.Scoped(OwnerA)

		addAll(t, s, task.Task{Title: "local", Tags: []string{"local"}})
		addAll(t, alice,
			task.Task{Title: "alice todo", Status: task.StatusTodo, Due: due(1), Tags: []string{"go", "home"}},
			task.Task{Title: "alice done", Status: task.StatusDone, Due: due(2), Tags: []string{"go"}},
		)
		addAll(t, s.Scoped(OwnerB), task.Task{Title: "bob todo", Status: task.StatusTodo, Due: due(3), Tags: []string{"bob"}})

		// The filters see the scope's tasks only.
		got, err := alice.ByStatus(ctx, task.StatusTodo)
		require.NoError(t, err)
		assert.Equal(t, []string{"alice todo"}, titles(got))

		got, err = alice.ByTag(ctx, "go")
		require.NoError(t, err)
		assert.Equal(t, []string{"alice todo", "alice done"}, titles(got))

		got, err = alice.SortByDue(ctx)
		require.NoError(t, err)
		assert.Equal(t, []string{"alice todo", "alice done"}, titles(got))

		// So do the aggregates.
		counts, err := alice.CountByTag(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]int{"go": 2, "home": 1}, counts)

		tags, err := alice.Tags(ctx)
		require.NoError(t, err)
		assert.Equal(t, []string{"go", "home"}, tags)

		stats, err := alice.Stats(ctx)
		require.NoError(t, err)
		assert.Equal(t, store.Stats{
			Total:   2,
			Done:    1,
			Pending: 1,
			ByTag:   map[string]int{"go": 2, "home": 1},
		}, stats)

		// The ownerless scope's aggregates see only the local task.
		counts, err = s.CountByTag(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]int{"local": 1}, counts)
	})

	t.Run("CanceledContext", func(t *testing.T) {
		s := newStore(t)

		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		_, err := s.List(ctx)
		require.Error(t, err)
		assert.ErrorIs(t, err, context.Canceled)
	})
}

// addAll adds tasks in order, requires each Add to hand out a non-nil id and
// to store the task at version 1 — the value every stored task starts at —
// requires the ids to be unique, and returns the stored tasks. The ids
// themselves are v7 values the suite cannot predict; what the contract
// promises is that they exist, identify the task, and do not repeat.
func addAll(t *testing.T, s store.Store, tasks ...task.Task) []task.Task {
	t.Helper()
	added := make([]task.Task, len(tasks))
	seen := make(map[uuid.UUID]bool, len(tasks))
	for i, tt := range tasks {
		got, err := s.Add(context.Background(), tt)
		require.NoError(t, err)
		require.NotEqual(t, uuid.Nil, got.ID, "Add assigns a non-nil id")
		require.False(t, seen[got.ID], "Add assigns unique ids")
		require.Equal(t, 1, got.Version, "Add stores the task at version 1")
		seen[got.ID] = true
		added[i] = got
	}
	return added
}

// titles returns the titles of tasks in order, for assertions about
// selection and ordering that do not need whole tasks spelled out.
func titles(tasks []task.Task) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.Title
	}
	return out
}

// canonical returns t with its tags deduplicated and sorted. The Store
// contract treats a task's tags as a set — CountByTag counts a repeated tag
// once, and Turso's task_tags table has no order column — so conformance
// comparisons normalize tag order instead of pinning what the contract
// leaves free.
func canonical(t task.Task) task.Task {
	t.Tags = slices.Compact(slices.Sorted(slices.Values(t.Tags)))
	return t
}

// canonicalAll maps canonical over tasks.
func canonicalAll(tasks []task.Task) []task.Task {
	out := make([]task.Task, len(tasks))
	for i, t := range tasks {
		out[i] = canonical(t)
	}
	return out
}

// due returns midnight UTC on November d, 2026, the fixed reference date the
// suite's ordering cases share.
func due(d int) time.Time {
	return time.Date(2026, 11, d, 0, 0, 0, 0, time.UTC)
}
````


## `internal/store/testdata/bench/baseline-turso.txt`

````text
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
# control-ref: 8787d107f68542231244cd9afe5019dcdc28a55b
BenchmarkTursoList/n=100000-16  	       1	1824410964 ns/op	362438968 B/op	11987045 allocs/op
BenchmarkTursoByTag/n=100000-16 	       2	 810995997 ns/op	135928548 B/op	 4393958 allocs/op
BenchmarkTursoByTagRare/n=100000-16         	    6512	    189763 ns/op	    7149 B/op	     283 allocs/op
BenchmarkTursoSortByDue/n=100000-16         	       1	1983292915 ns/op	362091848 B/op	11974799 allocs/op
BenchmarkTursoStats/n=100000-16             	       3	 434172327 ns/op	   10741 B/op	     353 allocs/op
BenchmarkTursoGet/n=100000-16               	    8062	    153805 ns/op	    7577 B/op	     316 allocs/op
BenchmarkTursoComplete-16                   	   19212	     66148 ns/op	    3416 B/op	     129 allocs/op
BenchmarkTaskScanValues-16                  	    4892	    208680 ns/op	       0 B/op	       0 allocs/op
BenchmarkTaskScanPointers-16                	    5071	    235397 ns/op	       0 B/op	       0 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkTursoList/n=100000-16  	       1	1745359064 ns/op	362437296 B/op	11987051 allocs/op
BenchmarkTursoByTag/n=100000-16 	       2	 721133293 ns/op	135931736 B/op	 4393961 allocs/op
BenchmarkTursoByTagRare/n=100000-16         	    7405	    165441 ns/op	    7149 B/op	     283 allocs/op
BenchmarkTursoSortByDue/n=100000-16         	       1	1956371541 ns/op	362094256 B/op	11974806 allocs/op
BenchmarkTursoStats/n=100000-16             	       3	 394861426 ns/op	   10389 B/op	     351 allocs/op
BenchmarkTursoGet/n=100000-16               	    9157	    156301 ns/op	    7577 B/op	     316 allocs/op
BenchmarkTursoComplete-16                   	   18582	     73112 ns/op	    3416 B/op	     129 allocs/op
BenchmarkTaskScanValues-16                  	    5335	    198813 ns/op	       0 B/op	       0 allocs/op
BenchmarkTaskScanPointers-16                	    5365	    223467 ns/op	       0 B/op	       0 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkTursoList/n=100000-16  	       1	1789959939 ns/op	362440208 B/op	11987052 allocs/op
BenchmarkTursoByTag/n=100000-16 	       2	 772801040 ns/op	135928508 B/op	 4393958 allocs/op
BenchmarkTursoByTagRare/n=100000-16         	    6808	    182103 ns/op	    7149 B/op	     283 allocs/op
BenchmarkTursoSortByDue/n=100000-16         	       1	2041460018 ns/op	362094872 B/op	11974822 allocs/op
BenchmarkTursoStats/n=100000-16             	       3	 398995781 ns/op	    9925 B/op	     349 allocs/op
BenchmarkTursoGet/n=100000-16               	    7521	    140613 ns/op	    7577 B/op	     316 allocs/op
BenchmarkTursoComplete-16                   	   19023	     71658 ns/op	    3416 B/op	     129 allocs/op
BenchmarkTaskScanValues-16                  	    7125	    173385 ns/op	       0 B/op	       0 allocs/op
BenchmarkTaskScanPointers-16                	    5294	    219339 ns/op	       0 B/op	       0 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkTursoList/n=100000-16  	       1	1899112161 ns/op	362429232 B/op	11987039 allocs/op
BenchmarkTursoByTag/n=100000-16 	       2	 731895430 ns/op	135928844 B/op	 4393959 allocs/op
BenchmarkTursoByTagRare/n=100000-16         	    7506	    178043 ns/op	    7149 B/op	     283 allocs/op
BenchmarkTursoSortByDue/n=100000-16         	       1	2017886509 ns/op	362096864 B/op	11974816 allocs/op
BenchmarkTursoStats/n=100000-16             	       3	 497204848 ns/op	   10469 B/op	     352 allocs/op
BenchmarkTursoGet/n=100000-16               	    7740	    136442 ns/op	    7577 B/op	     316 allocs/op
BenchmarkTursoComplete-16                   	   15703	     65191 ns/op	    3416 B/op	     129 allocs/op
BenchmarkTaskScanValues-16                  	    5954	    180671 ns/op	       0 B/op	       0 allocs/op
BenchmarkTaskScanPointers-16                	    5325	    203619 ns/op	       0 B/op	       0 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkTursoList/n=100000-16  	       1	1801194402 ns/op	362434024 B/op	11987043 allocs/op
BenchmarkTursoByTag/n=100000-16 	       2	 749290356 ns/op	135928892 B/op	 4393958 allocs/op
BenchmarkTursoByTagRare/n=100000-16         	    6856	    196922 ns/op	    7149 B/op	     283 allocs/op
BenchmarkTursoSortByDue/n=100000-16         	       1	1998200575 ns/op	362092920 B/op	11974811 allocs/op
BenchmarkTursoStats/n=100000-16             	       2	 504498518 ns/op	   10900 B/op	     355 allocs/op
BenchmarkTursoGet/n=100000-16               	    7760	    142658 ns/op	    7577 B/op	     316 allocs/op
BenchmarkTursoComplete-16                   	   18357	     64431 ns/op	    3416 B/op	     129 allocs/op
BenchmarkTaskScanValues-16                  	    6370	    176469 ns/op	       0 B/op	       0 allocs/op
BenchmarkTaskScanPointers-16                	    4720	    212114 ns/op	       0 B/op	       0 allocs/op
PASS
````


## `internal/store/testdata/bench/baseline.txt`

````text
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
# control-ref: 8787d107f68542231244cd9afe5019dcdc28a55b
BenchmarkAdd/n=100-16     	 2152731	       469.5 ns/op	     712 B/op	       1 allocs/op
BenchmarkAdd/n=10000-16   	 2589240	       456.3 ns/op	     738 B/op	       1 allocs/op
BenchmarkList/n=100-16    	  108404	     11324 ns/op	   35520 B/op	      93 allocs/op
BenchmarkList/n=10000-16  	     633	   1926668 ns/op	 4823444 B/op	    8590 allocs/op
BenchmarkByStatus/n=100-16         	   80476	     16048 ns/op	   51664 B/op	     100 allocs/op
BenchmarkByStatus/n=10000-16       	     386	   3273876 ns/op	 8222891 B/op	    8608 allocs/op
BenchmarkByTag/n=100-16            	   85053	     13955 ns/op	   43472 B/op	      99 allocs/op
BenchmarkByTag/n=10000-16          	     390	   2684106 ns/op	 6142117 B/op	    8605 allocs/op
BenchmarkSortByDue/n=100-16        	   63186	     19445 ns/op	   35520 B/op	      93 allocs/op
BenchmarkSortByDue/n=10000-16      	     294	   4121686 ns/op	 4823444 B/op	    8590 allocs/op
BenchmarkCountByTag/n=100-16       	  173071	      7556 ns/op	     256 B/op	       2 allocs/op
BenchmarkCountByTag/n=10000-16     	    1834	    692042 ns/op	     256 B/op	       2 allocs/op
BenchmarkTags/n=100-16             	  144254	      8145 ns/op	     304 B/op	       7 allocs/op
BenchmarkTags/n=10000-16           	    1764	    932550 ns/op	     304 B/op	       7 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAdd/n=100-16     	 2401426	       491.8 ns/op	     797 B/op	       1 allocs/op
BenchmarkAdd/n=10000-16   	 3072363	       548.0 ns/op	     777 B/op	       1 allocs/op
BenchmarkList/n=100-16    	  110340	     11877 ns/op	   35520 B/op	      93 allocs/op
BenchmarkList/n=10000-16  	     646	   1881906 ns/op	 4823443 B/op	    8590 allocs/op
BenchmarkByStatus/n=100-16         	   73410	     16263 ns/op	   51664 B/op	     100 allocs/op
BenchmarkByStatus/n=10000-16       	     342	   3380882 ns/op	 8222890 B/op	    8608 allocs/op
BenchmarkByTag/n=100-16            	   85237	     14636 ns/op	   43472 B/op	      99 allocs/op
BenchmarkByTag/n=10000-16          	     450	   2714566 ns/op	 6142114 B/op	    8605 allocs/op
BenchmarkSortByDue/n=100-16        	   62407	     20154 ns/op	   35520 B/op	      93 allocs/op
BenchmarkSortByDue/n=10000-16      	     297	   4284291 ns/op	 4823444 B/op	    8590 allocs/op
BenchmarkCountByTag/n=100-16       	  174522	      7544 ns/op	     256 B/op	       2 allocs/op
BenchmarkCountByTag/n=10000-16     	    1822	    708798 ns/op	     256 B/op	       2 allocs/op
BenchmarkTags/n=100-16             	  160045	      7918 ns/op	     304 B/op	       7 allocs/op
BenchmarkTags/n=10000-16           	    1396	    914003 ns/op	     304 B/op	       7 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAdd/n=100-16     	 2580847	       519.9 ns/op	     742 B/op	       1 allocs/op
BenchmarkAdd/n=10000-16   	 2846679	       450.6 ns/op	     672 B/op	       1 allocs/op
BenchmarkList/n=100-16    	   90226	     11437 ns/op	   35520 B/op	      93 allocs/op
BenchmarkList/n=10000-16  	     592	   1965747 ns/op	 4823442 B/op	    8590 allocs/op
BenchmarkByStatus/n=100-16         	   67698	     17703 ns/op	   51664 B/op	     100 allocs/op
BenchmarkByStatus/n=10000-16       	     361	   3260673 ns/op	 8222888 B/op	    8608 allocs/op
BenchmarkByTag/n=100-16            	   83418	     13857 ns/op	   43472 B/op	      99 allocs/op
BenchmarkByTag/n=10000-16          	     435	   2704233 ns/op	 6142115 B/op	    8605 allocs/op
BenchmarkSortByDue/n=100-16        	   62295	     20485 ns/op	   35520 B/op	      93 allocs/op
BenchmarkSortByDue/n=10000-16      	     262	   4320658 ns/op	 4823443 B/op	    8590 allocs/op
BenchmarkCountByTag/n=100-16       	  162520	      8094 ns/op	     256 B/op	       2 allocs/op
BenchmarkCountByTag/n=10000-16     	    1717	    719470 ns/op	     256 B/op	       2 allocs/op
BenchmarkTags/n=100-16             	  134854	      8028 ns/op	     304 B/op	       7 allocs/op
BenchmarkTags/n=10000-16           	    1752	    760014 ns/op	     304 B/op	       7 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAdd/n=100-16     	 2140654	       483.4 ns/op	     716 B/op	       1 allocs/op
BenchmarkAdd/n=10000-16   	 2723188	       456.5 ns/op	     702 B/op	       1 allocs/op
BenchmarkList/n=100-16    	   91418	     10959 ns/op	   35520 B/op	      93 allocs/op
BenchmarkList/n=10000-16  	     640	   1908791 ns/op	 4823441 B/op	    8590 allocs/op
BenchmarkByStatus/n=100-16         	   75634	     16144 ns/op	   51664 B/op	     100 allocs/op
BenchmarkByStatus/n=10000-16       	     379	   3218570 ns/op	 8222887 B/op	    8608 allocs/op
BenchmarkByTag/n=100-16            	   85117	     13620 ns/op	   43472 B/op	      99 allocs/op
BenchmarkByTag/n=10000-16          	     430	   2627457 ns/op	 6142117 B/op	    8605 allocs/op
BenchmarkSortByDue/n=100-16        	   54988	     19824 ns/op	   35520 B/op	      93 allocs/op
BenchmarkSortByDue/n=10000-16      	     270	   4489038 ns/op	 4823443 B/op	    8590 allocs/op
BenchmarkCountByTag/n=100-16       	  151766	      9179 ns/op	     256 B/op	       2 allocs/op
BenchmarkCountByTag/n=10000-16     	    1864	    807460 ns/op	     256 B/op	       2 allocs/op
BenchmarkTags/n=100-16             	  136376	      7823 ns/op	     304 B/op	       7 allocs/op
BenchmarkTags/n=10000-16           	    1852	    744596 ns/op	     304 B/op	       7 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAdd/n=100-16     	 2202819	       505.8 ns/op	     696 B/op	       1 allocs/op
BenchmarkAdd/n=10000-16   	 2679447	       492.4 ns/op	     714 B/op	       1 allocs/op
BenchmarkList/n=100-16    	  112464	     10885 ns/op	   35520 B/op	      93 allocs/op
BenchmarkList/n=10000-16  	     718	   1851310 ns/op	 4823443 B/op	    8590 allocs/op
BenchmarkByStatus/n=100-16         	   72530	     15456 ns/op	   51664 B/op	     100 allocs/op
BenchmarkByStatus/n=10000-16       	     342	   3728566 ns/op	 8222897 B/op	    8608 allocs/op
BenchmarkByTag/n=100-16            	   84196	     13990 ns/op	   43472 B/op	      99 allocs/op
BenchmarkByTag/n=10000-16          	     415	   2837459 ns/op	 6142116 B/op	    8605 allocs/op
BenchmarkSortByDue/n=100-16        	   58993	     20159 ns/op	   35520 B/op	      93 allocs/op
BenchmarkSortByDue/n=10000-16      	     285	   4137647 ns/op	 4823443 B/op	    8590 allocs/op
BenchmarkCountByTag/n=100-16       	  151801	      7253 ns/op	     256 B/op	       2 allocs/op
BenchmarkCountByTag/n=10000-16     	    1611	    705250 ns/op	     256 B/op	       2 allocs/op
BenchmarkTags/n=100-16             	  157465	      8072 ns/op	     304 B/op	       7 allocs/op
BenchmarkTags/n=10000-16           	    1737	    742776 ns/op	     304 B/op	       7 allocs/op
PASS
````


## `internal/store/turso.go`

````go
package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	turso "turso.tech/database/tursogo" // the driver registers "turso" with database/sql on import; NewConnector builds the handle

	"todo/internal/db"
	"todo/internal/task"
)

// TursoStore is a Store backed by a Turso database through database/sql.
// The driver is turso.tech/database/tursogo, a pure-Go binding over Turso's
// own engine: it calls the engine's native library through purego, so the
// module needs no cgo and CGO_ENABLED=0 builds and cross-compilation both
// work. The schema comes from the embedded migrations in todo/internal/db,
// and the SQL comes from the sqlc-generated queries in that same package:
// the store runs the generated methods and maps their database-shaped rows
// to todo/internal/task values, which is the boundary that keeps generated
// code out of the domain.
//
// A TursoStore is one scope over the tasks table: every query it runs carries
// owner_id, so the store reads and writes only one owner's rows. The store
// NewTursoStore returns serves the user-less scope; Scoped returns a view
// sharing the same database handle and queries, restricted to one user.
type TursoStore struct {
	// db is the database/sql handle. Every method goes through it; the
	// pool holds one connection per concurrent writer (NewTursoStore sizes
	// it), and the write path checks one out per transaction.
	db *sql.DB

	// queries runs the generated statements. NewTursoStore binds it to db;
	// Stats rebinds a copy to its read transaction with WithTx, and Add,
	// Complete, and the importer build one over their dedicated
	// transaction connection with db.New.
	queries *db.Queries

	// owner is the store's scope. uuid.Nil is the user-less scope: the
	// local tasks of the CLI, the rows whose owner_id is NULL. See
	// Store.Scoped.
	owner uuid.UUID
}

// TursoStore is one implementation of Store.
var _ Store = (*TursoStore)(nil)

// Scoped implements Store: the view shares the store's handle and its
// generated queries, and differs only in the owner every query pins. Close
// belongs to the store Scoped was called on: closing a view would close the
// handle every other view is using.
func (s *TursoStore) Scoped(owner uuid.UUID) Store {
	return &TursoStore{db: s.db, queries: s.queries, owner: owner}
}

// ownerSQL maps a scope to the owner column's shape: uuid.Nil is SQL NULL,
// the user-less scope, and any other id is its canonical text. It is the one
// place a scope becomes a query parameter, which is what keeps the owner
// predicate and the column's NULL meaning from drifting apart.
func ownerSQL(owner uuid.UUID) sql.NullString {
	if owner == uuid.Nil {
		return sql.NullString{}
	}
	return sql.NullString{String: owner.String(), Valid: true}
}

// NewTursoStore opens — creating it if needed — the Turso database at path
// and brings its schema up to date with the embedded migrations. A path that
// does not exist yet is not an error. The returned store is safe for
// concurrent use: the database/sql pool keeps one connection per concurrent
// writer, and every write runs as a BEGIN CONCURRENT transaction under MVCC.
func NewTursoStore(ctx context.Context, path string) (*TursoStore, error) {
	connector, err := turso.NewConnector(tursoDSN(path))
	if err != nil {
		return nil, fmt.Errorf("open turso store %s: %w", path, err)
	}
	// foreign_keys is a per-connection switch, and the driver's DSN has no
	// pragma mechanism to set it on every connection the pool opens, so the
	// connector is wrapped: every fresh connection runs the store's pragmas
	// before database/sql receives it.
	sqlDB := sql.OpenDB(&pragmaConnector{
		base:    connector,
		pragmas: []string{"PRAGMA foreign_keys(1)"},
	})

	// MVCC is the journal mode BEGIN CONCURRENT requires, and it is a
	// property of the file, not of a connection: setting it once here makes
	// it the mode every later open and every pooled connection sees. The
	// readback is the receipt — a mode the engine refuses fails the open
	// instead of surfacing later as a transaction error on the first write.
	// The statement runs before the migrations, so goose's transactions run
	// under the same mode the store serves in.
	var mode string
	if err := sqlDB.QueryRowContext(ctx, "PRAGMA journal_mode = mvcc").Scan(&mode); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("open turso store %s: enable mvcc: %w", path, err)
	}
	if mode != "mvcc" {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("open turso store %s: journal mode is %q, want mvcc", path, mode)
	}

	// MVCC admits many writers, so the pool is no longer pinned to one
	// connection: concurrent BEGIN CONCURRENT transactions are the point.
	// A :memory: database is the exception: every new connection opens its
	// own private, empty database, so a memory path keeps the single
	// connection the schema lives on. MVCC buys a memory store nothing —
	// there is nothing to share — but the mode is harmless there and the
	// one connection still runs concurrent transactions.
	maxConns := 8
	if path == memoryPath {
		maxConns = 1
	}
	sqlDB.SetMaxOpenConns(maxConns)

	// The schema is not created here: the embedded migrations are the one
	// place the DDL lives, and goose applies whatever is pending. ctx
	// governs that step, so a canceled boot aborts before serving.
	if err := db.Up(ctx, sqlDB); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("open turso store %s: %w", path, err)
	}
	return &TursoStore{db: sqlDB, queries: db.New(sqlDB)}, nil
}

// memoryPath is the one DSN that opens a private, per-connection database.
// The driver has no URI support — file::memory:?cache=shared is a literal
// filename to it — so this is the whole list.
const memoryPath = ":memory:"

// Close folds the MVCC log back into the database file and releases the
// handle. The checkpoint is best effort and runs first: PRAGMA
// wal_checkpoint(TRUNCATE) moves every committed row out of the sidecar
// log that MVCC keeps beside the file and truncates it, so the .db file
// alone is a portable backup afterwards. Without it a copy of the .db file
// alone is missing the schema and every row — they still live in the log —
// which is the trap the store's Close exists to close. A second Close (or
// one on a broken handle) reports no checkpoint and closes again; both are
// no-ops.
func (s *TursoStore) Close() error {
	_, _ = s.db.ExecContext(context.Background(), "PRAGMA wal_checkpoint(TRUNCATE)")
	return s.db.Close()
}

// DB returns the store's database handle. The store owns the handle's
// lifecycle — Close closes it — and hands it out because the auth material
// serves other tables of the same database: the server's auth service and
// session store, and the CLI's admin commands. One process, one pool, one
// close. The returned handle is safe for concurrent use, like the store.
func (s *TursoStore) DB() *sql.DB { return s.db }

// Add assigns a UUIDv7 id to the task and inserts the task and its tags in
// one BEGIN CONCURRENT transaction, returning the stored task at version 1
// under the store's scope: a scoped store stamps its owner into the row, the
// user-less store leaves owner_id NULL. The transaction is the unit of
// atomicity for a two-table write: without it, a failure between the task
// insert and a tag insert would leave a task that lost tags.
// db.WithConcurrentTx runs the transaction under MVCC and retries a busy
// engine or a write-write conflict, so a writer contending with another
// connection waits the conflict out instead of failing mid-way. The
// generated queries rebind to the dedicated connection with db.New — same
// package, different DBTX. The id is generated in Go, not by the database:
// v7 ids are time-ordered, and the store hands the same value to the row and
// back to the caller, storing its canonical string form. The version, like
// the id, is the store's to assign: whatever the caller passed is
// overwritten, so no caller can seed a task at a version the store never
// handed out. A done ctx aborts before the insert, and a context canceled
// mid-transaction rolls it back.
func (s *TursoStore) Add(ctx context.Context, t task.Task) (task.Task, error) {
	if err := ctxErr(ctx, "add task"); err != nil {
		return task.Task{}, err
	}

	id, err := uuid.NewV7()
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}

	// The stored task starts at version 1, whatever the argument carried:
	// the version, like the id, is the store's to assign.
	t.ID = id
	t.Version = 1

	err = db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		if err := q.InsertTask(ctx, db.InsertTaskParams{
			ID:       id.String(),
			Title:    t.Title,
			Status:   string(t.Status),
			Priority: int64(t.Priority),
			Due:      dueSQL(t.Due),
			Version:  int64(t.Version),
			Owner:    ownerSQL(s.owner),
		}); err != nil {
			return err
		}

		// uniqueTags because task_tags' primary key makes a repeated tag a
		// constraint violation, and the contract counts a task at most once
		// per tag anyway.
		for _, tag := range uniqueTags(t.Tags) {
			if err := q.InsertTag(ctx, db.InsertTagParams{TaskID: id.String(), Tag: tag}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
	return t, nil
}

// Get returns the task with the given id, tags included, provided the store's
// scope owns it. The generated GetTask query is the same probe the CAS writes
// use to tell a missing task from a stale one; here sql.ErrNoRows is simply
// the miss — a task another owner holds reads back as no row at all. The row
// is mapped to the domain type at the same boundary the list queries use, and
// the tags ride one ListTagsForTasks call, so a task always arrives whole.
func (s *TursoStore) Get(ctx context.Context, id uuid.UUID) (task.Task, error) {
	if err := ctxErr(ctx, "get task"); err != nil {
		return task.Task{}, err
	}
	row, err := s.queries.GetTask(ctx, db.GetTaskParams{ID: id.String(), Owner: ownerSQL(s.owner)})
	if errors.Is(err, sql.ErrNoRows) {
		return task.Task{}, fmt.Errorf("get task %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return task.Task{}, fmt.Errorf("get task %s: %w", id, err)
	}
	t, err := taskFromRow(row.ID, row.Title, row.Status, row.Priority, row.Due, row.Version)
	if err != nil {
		return task.Task{}, fmt.Errorf("get task %s: %w", id, err)
	}
	// attachTags fills a slice in place, so the one task travels through a
	// slice of one rather than growing a single-task variant of the query.
	one := []task.Task{t}
	if err := s.attachTags(ctx, one); err != nil {
		return task.Task{}, fmt.Errorf("get task %s: %w", id, err)
	}
	return one[0], nil
}

// Complete marks the task with the given ID as done, but only while the
// store's scope owns it and it is still at the given version. CompleteTask is
// an :execrows query whose UPDATE carries the version as a compare-and-swap —
// the WHERE clause pins the version the caller read, the owner the store was
// scoped to, and the SET clause bumps the version — and its count is how the
// UPDATE reports that nothing matched: an UPDATE that touches nothing is a
// successful statement. Zero rows means the task is gone, the caller's
// snapshot is stale, or the task was never the scope's; classifyWrite tells
// the three apart (the last two collapse into "not found" for a foreign
// task), and its probe runs after the UPDATE, so a task that is gone is
// ErrNotFound even when the caller's version is also stale. The id reaches
// SQL as its canonical string form, the same text Add stored.
//
// The UPDATE runs inside BEGIN CONCURRENT even though it is a single
// statement. In MVCC mode an autocommit write still takes the exclusive
// path, and concurrent transactions cannot commit while an exclusive
// transaction is active: leaving Complete as an autocommit UPDATE would
// stall every other writer's commit and turn the store's multi-writer claim
// into retries. Every write, one statement or ten, rides a concurrent
// transaction. The retry loop is safe here because the transaction is one
// statement: a retry re-runs exactly the CAS, and if the version moved while
// the attempt waited, the retried CAS reports it as a conflict — never as an
// engine write-write conflict, which keeps its own meaning.
func (s *TursoStore) Complete(ctx context.Context, id uuid.UUID, version int) error {
	if err := ctxErr(ctx, "complete task"); err != nil {
		return err
	}
	var n int64
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		var err error
		n, err = db.New(conn).CompleteTask(ctx, db.CompleteTaskParams{
			Status:  string(task.StatusDone),
			ID:      id.String(),
			Version: int64(version),
			Owner:   ownerSQL(s.owner),
		})
		return err
	})
	if err != nil {
		return fmt.Errorf("complete task %s: %w", id, err)
	}
	if n > 0 {
		return nil
	}
	return s.classifyWrite(ctx, "complete task", id)
}

// Update replaces the task's columns and its tag set in one BEGIN CONCURRENT
// transaction, but only while the store's scope owns it and it is still at
// the version the argument carries. UpdateTask is the same compare-and-swap
// shape Complete uses: one statement whose WHERE clause pins the snapshot and
// the owner and whose SET clause bumps the version, so the database decides
// whether the write is still valid. Zero rows changed leaves the same
// question — gone, stale, or foreign — and classifyWrite answers it after the
// transaction. The tag set is written as a replacement: DeleteTaskTags drops
// every row the task had, then the caller's tags are inserted, all in the
// same transaction, so a failure anywhere rolls the whole update back and no
// reader ever sees a task without its tags.
//
// The transaction is safe to retry because it is re-runnable from the start:
// a retried CAS re-reads nothing — the version it compares is the caller's —
// so a conflict that landed while the attempt waited fails the retry as
// ErrConflict, exactly as it would have failed the first attempt.
func (s *TursoStore) Update(ctx context.Context, t task.Task) (task.Task, error) {
	if err := ctxErr(ctx, "update task"); err != nil {
		return task.Task{}, err
	}
	var n int64
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		var err error
		n, err = q.UpdateTask(ctx, db.UpdateTaskParams{
			Title:    t.Title,
			Status:   string(t.Status),
			Priority: int64(t.Priority),
			Due:      dueSQL(t.Due),
			ID:       t.ID.String(),
			Version:  int64(t.Version),
			Owner:    ownerSQL(s.owner),
		})
		if err != nil || n == 0 {
			return err
		}
		if err := q.DeleteTaskTags(ctx, t.ID.String()); err != nil {
			return err
		}
		for _, tag := range uniqueTags(t.Tags) {
			if err := q.InsertTag(ctx, db.InsertTagParams{TaskID: t.ID.String(), Tag: tag}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return task.Task{}, fmt.Errorf("update task %s: %w", t.ID, err)
	}
	if n == 0 {
		return task.Task{}, s.classifyWrite(ctx, "update task", t.ID)
	}
	t.Version++
	return t, nil
}

// Delete removes the task with the given id, but only while the store's scope
// owns it and it is still at the given version: DeleteTask is the same
// compare-and-swap as the other writes, one statement inside BEGIN CONCURRENT,
// and a zero-row delete is classified by the same probe. The task's tag rows
// go with it through task_tags' ON DELETE CASCADE — the connections turn
// foreign keys on, so the engine enforces it rather than the store
// remembering to.
func (s *TursoStore) Delete(ctx context.Context, id uuid.UUID, version int) error {
	if err := ctxErr(ctx, "delete task"); err != nil {
		return err
	}
	var n int64
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		var err error
		n, err = db.New(conn).DeleteTask(ctx, db.DeleteTaskParams{
			ID:      id.String(),
			Version: int64(version),
			Owner:   ownerSQL(s.owner),
		})
		return err
	})
	if err != nil {
		return fmt.Errorf("delete task %s: %w", id, err)
	}
	if n > 0 {
		return nil
	}
	return s.classifyWrite(ctx, "delete task", id)
}

// classifyWrite answers the question a zero-row compare-and-swap leaves open:
// is the task gone, is the caller's snapshot stale, or is the task simply not
// the scope's? One GetTask probe, itself scoped, tells them apart: a task the
// scope does not own is invisible to the probe exactly as a missing one is,
// so a foreign task reports ErrNotFound — the same answer, on purpose, so a
// caller cannot use the store to learn that another user's task exists. The
// probe runs after the failed write, so a task that is gone is ErrNotFound
// even when the caller's version is also stale. op names the operation in the
// wrapped error, so every store reports the same sentences MemoryStore does.
func (s *TursoStore) classifyWrite(ctx context.Context, op string, id uuid.UUID) error {
	_, err := s.queries.GetTask(ctx, db.GetTaskParams{ID: id.String(), Owner: ownerSQL(s.owner)})
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("%s %s: %w", op, id, ErrNotFound)
	case err != nil:
		return fmt.Errorf("%s %s: %w", op, id, err)
	default:
		return fmt.Errorf("%s %s: %w", op, id, ErrConflict)
	}
}

// insertAll is the Turso store's half of ImportJSON: every task the stream
// yields is inserted, with its tags, inside one BEGIN CONCURRENT
// transaction, so a failure at any row rolls the whole batch back and the
// import is all-or-nothing at the database too. The tasks arrive with their
// ids and versions — the importer decoded them from the document — so
// nothing is generated here, and the id reaches SQL as the canonical string
// the document carried. The batch lands in the store's scope: an import
// through the user-less store writes user-less tasks, which is what makes the
// interchange format and the CLI's story agree — a document carries no owner.
//
// The import rides the single attempt, not the retry loop, because the
// stream cannot be replayed: it decodes from a one-shot reader, and a retry
// of the transaction would continue from where the failed attempt stopped —
// silently importing the document's suffix. A write-write conflict aborts
// the whole import instead, and the caller re-runs it with a fresh document.
// That is the price of the bound: the retry loop is for writes the store can
// re-run from the start, and a document cannot be re-read.
func (s *TursoStore) insertAll(ctx context.Context, stream taskStream) (int, error) {
	if err := ctxErr(ctx, "import tasks"); err != nil {
		return 0, err
	}
	count := 0
	err := db.ConcurrentTxOnce(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		for {
			t, err := stream()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return err
			}
			if err := q.InsertTask(ctx, db.InsertTaskParams{
				ID:       t.ID.String(),
				Title:    t.Title,
				Status:   string(t.Status),
				Priority: int64(t.Priority),
				Due:      dueSQL(t.Due),
				Version:  int64(t.Version),
				Owner:    ownerSQL(s.owner),
			}); err != nil {
				return err
			}
			for _, tag := range uniqueTags(t.Tags) {
				if err := q.InsertTag(ctx, db.InsertTagParams{TaskID: t.ID.String(), Tag: tag}); err != nil {
					return err
				}
			}
			count++
		}
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

// List returns the scope's tasks in id order. Ids are UUIDv7 values, whose
// text form sorts by creation time, so for an append-only store this is
// insertion order.
func (s *TursoStore) List(ctx context.Context) ([]task.Task, error) {
	if err := ctxErr(ctx, "list tasks"); err != nil {
		return nil, err
	}
	rows, err := s.queries.ListTasks(ctx, ownerSQL(s.owner))
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	return s.queryTasks(ctx, "list tasks", rows)
}

// ByStatus returns the scope's tasks whose status equals status, in id order.
func (s *TursoStore) ByStatus(ctx context.Context, status task.Status) ([]task.Task, error) {
	if err := ctxErr(ctx, "tasks by status"); err != nil {
		return nil, err
	}
	rows, err := s.queries.ListTasksByStatus(ctx, db.ListTasksByStatusParams{
		Status: string(status),
		Owner:  ownerSQL(s.owner),
	})
	if err != nil {
		return nil, fmt.Errorf("tasks by status: %w", err)
	}
	return s.queryTasks(ctx, "tasks by status", rows)
}

// ByTag returns the scope's tasks carrying the given tag, in id order. The
// join yields a task once per matching task_tags row, and the primary key
// keeps that at most one.
func (s *TursoStore) ByTag(ctx context.Context, tag string) ([]task.Task, error) {
	if err := ctxErr(ctx, "tasks by tag"); err != nil {
		return nil, err
	}
	rows, err := s.queries.ListTasksByTag(ctx, db.ListTasksByTagParams{
		Tag:   tag,
		Owner: ownerSQL(s.owner),
	})
	if err != nil {
		return nil, fmt.Errorf("tasks by tag: %w", err)
	}
	return s.queryTasks(ctx, "tasks by tag", rows)
}

// CountByTag returns, for every distinct tag of the scope's tasks, how many
// tasks carry it. A task counts at most once per tag because task_tags holds
// one row per pair, and the map is non-nil even when nothing is counted.
func (s *TursoStore) CountByTag(ctx context.Context) (map[string]int, error) {
	if err := ctxErr(ctx, "count by tag"); err != nil {
		return nil, err
	}
	rows, err := s.queries.CountTasksByTag(ctx, ownerSQL(s.owner))
	if err != nil {
		return nil, fmt.Errorf("count by tag: %w", err)
	}
	counts := make(map[string]int, len(rows))
	for _, r := range rows {
		counts[r.Tag] = int(r.Count)
	}
	return counts, nil
}

// Tags returns every distinct tag of the scope's tasks, sorted. The result is
// nil when there are no tags, matching MemoryStore: the generated query
// returns a nil slice on no rows, and the check makes that promise the
// store's rather than a property of whatever sqlc emits.
func (s *TursoStore) Tags(ctx context.Context) ([]string, error) {
	if err := ctxErr(ctx, "list tags"); err != nil {
		return nil, err
	}
	tags, err := s.queries.ListTags(ctx, ownerSQL(s.owner))
	if err != nil {
		return nil, fmt.Errorf("list tags: %w", err)
	}
	if len(tags) == 0 {
		return nil, nil
	}
	return tags, nil
}

// SortByDue returns the scope's tasks sorted by Due ascending, with tasks
// that have no due date last and ties in insertion order. The generated query
// keeps the ordering rule in SQL: (due IS NULL) is 0 for dated tasks and 1
// for undated ones, which is what pushes the zero dates to the end; due
// orders the rest; and id breaks ties. The tie-break is stronger than it was
// under integer ids: UUIDv7's text form is time-ordered, so id order is
// creation order for every row the store inserted itself.
func (s *TursoStore) SortByDue(ctx context.Context) ([]task.Task, error) {
	if err := ctxErr(ctx, "sort by due"); err != nil {
		return nil, err
	}
	rows, err := s.queries.SortTasksByDue(ctx, ownerSQL(s.owner))
	if err != nil {
		return nil, fmt.Errorf("sort by due: %w", err)
	}
	return s.queryTasks(ctx, "sort by due", rows)
}

// Stats aggregates the scope's tasks with two generated queries inside one
// read transaction, so both see the same snapshot and the totals cannot come
// from different instants. COUNT is 0 and SUM is NULL on an empty table, and
// the query's COALESCE folds the NULL back to 0; the empty aggregate still
// carries a non-nil ByTag, matching CountByTag.
func (s *TursoStore) Stats(ctx context.Context) (Stats, error) {
	if err := ctxErr(ctx, "stats"); err != nil {
		return Stats{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Stats{}, fmt.Errorf("stats: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // a read-only transaction, rolled back

	q := s.queries.WithTx(tx)
	row, err := q.TaskStats(ctx, db.TaskStatsParams{
		Status: string(task.StatusDone),
		Owner:  ownerSQL(s.owner),
	})
	if err != nil {
		return Stats{}, fmt.Errorf("stats: %w", err)
	}
	stats := Stats{
		Total: int(row.Total),
		Done:  int(row.Done),
	}
	stats.Pending = stats.Total - stats.Done

	tagRows, err := q.CountTasksByTag(ctx, ownerSQL(s.owner))
	if err != nil {
		return Stats{}, fmt.Errorf("stats: %w", err)
	}
	stats.ByTag = make(map[string]int, len(tagRows))
	for _, r := range tagRows {
		stats.ByTag[r.Tag] = int(r.Count)
	}
	return stats, nil
}

// queryTasks maps the rows of a generated task query to domain tasks and
// hydrates each with its tags. All four task queries — ListTasks,
// ListTasksByStatus, ListTasksByTag, SortTasksByDue — return []db.Task, so
// the mapping exists once. An empty result stays nil, matching MemoryStore's
// nil-when-empty semantics. op names the operation in error wrapping.
func (s *TursoStore) queryTasks(ctx context.Context, op string, rows []db.Task) ([]task.Task, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	tasks := make([]task.Task, 0, len(rows))
	for _, r := range rows {
		t, err := taskFromRow(r.ID, r.Title, r.Status, r.Priority, r.Due, r.Version)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", op, err)
		}
		tasks = append(tasks, t)
	}
	if err := s.attachTags(ctx, tasks); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	return tasks, nil
}

// taskFromRow maps one generated row to a domain task. The generated types
// are database shapes — string ids and priority, sql.NullString due, int64
// version — and this is the boundary where they become todo/internal/task
// values: the id text is parsed back into a uuid.UUID, and a zero Due is the
// zero time, not the year 1.
func taskFromRow(id, title, status string, priority int64, due sql.NullString, version int64) (task.Task, error) {
	parsedID, err := uuid.Parse(id)
	if err != nil {
		return task.Task{}, fmt.Errorf("parse id %q: %w", id, err)
	}
	t := task.Task{
		ID:       parsedID,
		Version:  int(version),
		Title:    title,
		Status:   task.Status(status),
		Priority: task.Priority(priority),
	}
	if due.Valid {
		parsed, err := time.Parse(time.RFC3339, due.String)
		if err != nil {
			return task.Task{}, fmt.Errorf("parse due %q: %w", due.String, err)
		}
		t.Due = parsed
	}
	return t, nil
}

// tagChunkSize is how many task ids one tag query carries. The generated
// ListTagsForTasks expands its sqlc.slice argument to one placeholder per
// id, and the placeholder list is part of the statement text: one query for
// a hundred thousand tasks is a statement with a hundred thousand
// placeholders — a megabyte of SQL the engine parses, one bind call per id,
// and a statement no other call can share. Chunking bounds the statement,
// and the bound is what makes the query text repeatable: every full chunk
// sends the same 512-placeholder statement, which the driver can prepare
// once per connection, and only the final short chunk is a text of its own.
// 512 is a size, not a law: it is small enough that the SQL stays short and
// large enough that a list read is a handful of queries, not thousands.
const tagChunkSize = 512

// attachTags loads the tags of every task in tasks and assigns them sorted,
// the shape Tags returns. The tasks must be in id order — every query that
// feeds it orders by id (ListTasks, ListTasksByStatus, ListTasksByTag,
// SortTasksByDue), and Get hands it a slice of one — because the walk below
// pairs the two ordered streams instead of building an index.
//
// The shape is a merge join over bounded chunks. For each chunk of at most
// tagChunkSize tasks the store asks ListTagsForTasks for that chunk's tags
// and walks the rows — ordered by task_id, tag — together with the chunk —
// ordered by id — advancing one pointer per row and one per task, never
// backwards. A map from id to task would answer the same question and is
// what this code did before: it cost a hash table with one entry per task,
// one string per id for the map's keys, and one more lookup per tag row.
// The walk costs neither. What it cannot do is tolerate an unordered slice:
// a task out of order would take the rows of its neighbour, which is why the
// precondition is written here and why the conformance suite — which asserts
// every task's tags on every list query — is the test that holds it.
//
// The generated queries close their rows before returning, so no rows are
// open when the next chunk's query runs: with one connection, a second query
// would wait for a connection that open rows still hold. Both sides key on
// the id's canonical string form, which is what the column stores.
func (s *TursoStore) attachTags(ctx context.Context, tasks []task.Task) error {
	if len(tasks) == 0 {
		return nil
	}
	for lo := 0; lo < len(tasks); lo += tagChunkSize {
		hi := min(lo+tagChunkSize, len(tasks))
		if err := s.attachTagChunk(ctx, tasks[lo:hi]); err != nil {
			return err
		}
	}
	return nil
}

// attachTagChunk attaches the tags of one id-ordered chunk. The chunk's ids
// are rendered once, up front: the rows are compared against that slice
// rather than against ID.String(), so the canonical text of each id is built
// once per task instead of once per comparison.
func (s *TursoStore) attachTagChunk(ctx context.Context, tasks []task.Task) error {
	ids := make([]string, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].ID.String()
	}

	rows, err := s.queries.ListTagsForTasks(ctx, ids)
	if err != nil {
		return err
	}

	// Both streams are ordered by id, so one pass pairs them: i names the
	// task the next row belongs to, and it only ever moves forward. A row
	// whose id has no task in the chunk cannot happen — the query asked for
	// exactly these ids — so reaching the end of the chunk ends the walk
	// rather than being treated as an error.
	i := 0
	for _, r := range rows {
		for i < len(tasks) && ids[i] != r.TaskID {
			i++
		}
		if i == len(tasks) {
			break
		}
		tasks[i].Tags = append(tasks[i].Tags, r.Tag)
	}
	return nil
}

// uniqueTags returns tags without repetitions, preserving first-seen order.
// The task_tags primary key (task_id, tag) admits one row per pair, and the
// Store contract counts a task at most once per tag, so Add deduplicates
// before inserting instead of letting the constraint reject a repeated tag.
func uniqueTags(tags []string) []string {
	seen := make(map[string]bool, len(tags))
	unique := make([]string, 0, len(tags))
	for _, tag := range tags {
		if seen[tag] {
			continue
		}
		seen[tag] = true
		unique = append(unique, tag)
	}
	return unique
}

// dueSQL maps a due date to the column's shape: a zero time is SQL NULL, and
// a dated task is stored as RFC 3339 text in UTC, the format taskFromRow
// parses back.
func dueSQL(due time.Time) sql.NullString {
	if due.IsZero() {
		return sql.NullString{}
	}
	return sql.NullString{String: due.UTC().Format(time.RFC3339), Valid: true}
}

// tursoDSN builds the DSN the Turso driver opens path with. The driver's DSN
// grammar has exactly one knob this store needs: _busy_timeout, which makes a
// connection wait up to five seconds for a lock instead of failing
// immediately. There is no _pragma parameter — a modernc.org/sqlite DSN
// would carry the store's other pragmas there, but this driver's parser
// knows only its own keys and silently ignores everything else — so
// foreign_keys rides the connector wrapper and journal_mode is set once on
// the file at open.
func tursoDSN(path string) string {
	return path + "?_busy_timeout=5000"
}

// pragmaConnector is a driver.Connector that runs PRAGMA statements on every
// fresh connection before database/sql receives it. database/sql has no
// connection hook of its own, and foreign_keys is per-connection state that
// Turso leaves off by default: a pool whose later connections skipped the
// pragma would silently run with foreign keys off, and the schema's ON
// DELETE CASCADE would do nothing.
type pragmaConnector struct {
	base    driver.Connector
	pragmas []string
}

// Connect opens one connection and runs the pragmas on it. A pragma that
// fails closes the connection and fails the connect: a connection without
// the store's settings is worse than no connection.
func (c *pragmaConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	execer, ok := conn.(driver.ExecerContext)
	if !ok {
		_ = conn.Close()
		return nil, errors.New("turso: connection cannot execute SQL")
	}
	for _, stmt := range c.pragmas {
		if _, err := execer.ExecContext(ctx, stmt, nil); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("turso: run %q: %w", stmt, err)
		}
	}
	return conn, nil
}

// Driver returns the underlying driver.
func (c *pragmaConnector) Driver() driver.Driver { return c.base.Driver() }
````


## `internal/store/turso_test.go`

````go
package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sync/errgroup"

	"todo/internal/task"
)

// tursoStorePath returns the path of a database inside a test-owned
// directory, so the tests run in parallel and each sees only its own file.
func tursoStorePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "tasks.db")
}

// TestTursoStore_Pragmas pins the store's settings by asking the live
// connection what it is running: MVCC — the mode BEGIN CONCURRENT requires,
// set on the file at open — the busy timeout that rode the DSN, the pool
// size that lets concurrent writers exist, and foreign keys on, which Turso
// leaves off by default and the store turns on per connection. The
// constraint check at the end proves the last one is enforcement, not a
// report, on a connection that did not run the pragma itself.
func TestTursoStore_Pragmas(t *testing.T) {
	t.Parallel()

	s, err := NewTursoStore(context.Background(), tursoStorePath(t))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })

	ctx := context.Background()

	var mode string
	require.NoError(t, s.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode))
	assert.Equal(t, "mvcc", mode)

	// The busy timeout is the driver's own DSN knob, _busy_timeout; there is
	// no _pragma mechanism to carry the rest of the settings.
	var timeout int
	require.NoError(t, s.db.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&timeout))
	assert.Equal(t, 5000, timeout)

	// The pool is what lets more than one writer exist at a time; MVCC is
	// what lets their transactions commit without serializing.
	assert.Equal(t, 8, s.db.Stats().MaxOpenConnections)

	var foreignKeys int
	require.NoError(t, s.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys))
	assert.Equal(t, 1, foreignKeys)

	// foreign_keys is per-connection state: hold the connection that ran
	// the readbacks, so the failing insert below runs on a different,
	// freshly opened one. The wrapped connector must have configured it
	// before database/sql saw it.
	held, err := s.db.Conn(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, held.Close()) })

	// A tag row naming a task that does not exist must fail: with
	// foreign_keys on, the schema's REFERENCES clause is enforced.
	_, err = s.db.ExecContext(ctx, `INSERT INTO task_tags (task_id, tag) VALUES ('00000000-0000-0000-0000-000000000999', 'orphan')`)
	require.Error(t, err, "foreign keys are on for a connection that did not run the pragma")
	assert.Contains(t, err.Error(), "FOREIGN KEY")
}

// TestTursoStore_ReopenKeepsData pins persistence end to end: after Close, a
// fresh NewTursoStore over the same file reads back the tasks — due dates,
// tags, and the ids they were stored under — so a reopened store still
// recognizes the ids it handed out.
func TestTursoStore_ReopenKeepsData(t *testing.T) {
	t.Parallel()

	path := tursoStorePath(t)
	due := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

	s, err := NewTursoStore(context.Background(), path)
	require.NoError(t, err)
	// The explicit Close below is the point of the test; this cleanup is a
	// safety net for an early failure and a second Close is a no-op.
	t.Cleanup(func() { _ = s.Close() })

	first, err := s.Add(context.Background(), task.Task{
		Title:    "write tests",
		Status:   task.StatusTodo,
		Priority: task.PriorityDefault,
		Due:      due,
		Tags:     []string{"book", "go"},
	})
	require.NoError(t, err)
	second, err := s.Add(context.Background(), task.Task{
		Title:  "review code",
		Status: task.StatusTodo,
		Tags:   []string{"review"},
	})
	require.NoError(t, err)
	require.NoError(t, s.Complete(context.Background(), second.ID, second.Version))
	require.NoError(t, s.Close())

	reopened, err := NewTursoStore(context.Background(), path)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, reopened.Close()) })

	var mode string
	require.NoError(t, reopened.db.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&mode))
	assert.Equal(t, "mvcc", mode, "the journal mode is a file property and survives the reopen")

	want := []task.Task{first, second}
	want[1].Status = task.StatusDone
	want[1].Version = 2
	got, err := reopened.List(context.Background())
	require.NoError(t, err)
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("reopened store contents mismatch (-want +got):\n%s", diff)
	}

	next, err := reopened.Add(context.Background(), task.Task{Title: "after reload"})
	require.NoError(t, err)
	assert.NotEqual(t, uuid.Nil, next.ID)
	assert.NotEqual(t, first.ID, next.ID, "a reopen does not hand out a persisted id again")
	assert.NotEqual(t, second.ID, next.ID, "a reopen does not hand out a persisted id again")
}

// TestTursoStore_MemoryPitfall pins why :memory: is a trap for anything but
// a single connection: every new connection to ":memory:" opens its own
// private, empty database. The store knows this and keeps a memory path on
// one connection — the only way it works at all — which is the first
// assertion below. Raising the pool by hand is what shows the trap the pin
// exists to avoid: the second connection sees an empty database with no
// schema.
func TestTursoStore_MemoryPitfall(t *testing.T) {
	t.Parallel()

	s, err := NewTursoStore(context.Background(), ":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })

	assert.Equal(t, 1, s.db.Stats().MaxOpenConnections, "a memory path keeps one connection")

	_, err = s.Add(context.Background(), task.Task{Title: "write tests", Status: task.StatusTodo})
	require.NoError(t, err)

	// Allow a second connection, then check the first one out of the pool
	// so the query below cannot reuse it.
	s.db.SetMaxOpenConns(2)
	conn, err := s.db.Conn(context.Background())
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })

	_, err = s.List(context.Background())
	require.Error(t, err, "the second connection cannot see the first one's schema")
	assert.Contains(t, err.Error(), "no such table")
}

// copyFile copies src to dst byte for byte. The backup tests copy the
// database file alone on purpose: what a lone .db copy contains is the thing
// under test, so the helper must not drag sidecars along.
func copyFile(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src) // #nosec G304 -- the test reads the very database file it created
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(dst, data, 0o600)) // #nosec G703 -- the destination is a t.TempDir path the test just made
}

// TestTursoStore_CloseCheckpoints is the backup receipt. An MVCC database
// keeps its committed rows in a log beside the file (t.db-log), and a copy
// of the file alone — the obvious thing to do with a .db file — is missing
// the schema and every row until the log is folded back in. Close runs
// PRAGMA wal_checkpoint(TRUNCATE) before it releases the handle, and this
// test is the before/after: the lone copy made while the store is open has
// no tasks table at all, and the lone copy made after Close opens as a whole
// database with the task still in it.
func TestTursoStore_CloseCheckpoints(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "tasks.db")

	s, err := NewTursoStore(context.Background(), path)
	require.NoError(t, err)
	// The explicit Close below is the point of the test; this cleanup is a
	// safety net for an early failure and a second Close is a no-op.
	t.Cleanup(func() { _ = s.Close() })

	added, err := s.Add(context.Background(), task.Task{Title: "write tests", Status: task.StatusTodo})
	require.NoError(t, err)

	// Before Close: the lone copy is not a database yet. The engine reports
	// it as a parse error — there is no tasks table in the file — which is
	// exactly the failure a backup made this way would hit.
	loneBefore := filepath.Join(t.TempDir(), "before.db")
	copyFile(t, path, loneBefore)
	probe, err := sql.Open("turso", loneBefore+"?_busy_timeout=5000")
	require.NoError(t, err)
	var count int
	err = probe.QueryRow(`SELECT COUNT(*) FROM tasks`).Scan(&count)
	require.Error(t, err, "a lone copy made while the store is open cannot see the schema")
	assert.Contains(t, err.Error(), "no such table")
	require.NoError(t, probe.Close())

	require.NoError(t, s.Close())

	// After Close: the checkpoint folded the log back into the file, so the
	// same copy is the whole database.
	loneAfter := filepath.Join(t.TempDir(), "after.db")
	copyFile(t, path, loneAfter)
	reopened, err := NewTursoStore(context.Background(), loneAfter)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, reopened.Close()) })

	list, err := reopened.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1, "the checkpointed file alone carries the row")
	assert.Equal(t, added.ID, list[0].ID)
	assert.Equal(t, added.Version, list[0].Version)
}

// TestTursoStore_ConcurrentWriters is the chapter's headline claim at the
// store level: the pool admits concurrent writers, and a writer that is
// already inside an open concurrent transaction — with an uncommitted write
// of its own — does not stop other writers from committing. The held writer
// is the adversarial part: with the pool pinned to one connection, its
// checked-out connection would be the store's only one and the workload
// below could not even start; under MVCC the writers run beside it, each
// transaction from its own snapshot.
func TestTursoStore_ConcurrentWriters(t *testing.T) {
	t.Parallel()

	s, err := NewTursoStore(context.Background(), tursoStorePath(t))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })

	ctx := context.Background()
	seed, err := s.Add(ctx, task.Task{Title: "held row", Status: task.StatusTodo})
	require.NoError(t, err)

	held, err := s.db.Conn(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = held.Close() })
	_, err = held.ExecContext(ctx, "BEGIN CONCURRENT")
	require.NoError(t, err, "a concurrent transaction opens under MVCC")
	_, err = held.ExecContext(ctx, `UPDATE tasks SET title = 'held' WHERE id = ?`, seed.ID.String())
	require.NoError(t, err)

	const (
		writers       = 8
		addsPerWriter = 25
	)

	g, gctx := errgroup.WithContext(ctx)
	start := make(chan struct{})
	for w := range writers {
		g.Go(func() error {
			<-start
			for i := range addsPerWriter {
				if _, err := s.Add(gctx, task.Task{
					Title: fmt.Sprintf("writer %d task %d", w, i),
					Tags:  []string{fmt.Sprintf("tag-%d", w)},
				}); err != nil {
					return err
				}
			}
			return nil
		})
	}
	close(start)
	require.NoError(t, g.Wait(), "every writer commits while another transaction is open")

	// The held transaction rolls back, so its update never lands: the
	// multi-writer path did not turn one writer's open snapshot into
	// another writer's committed state.
	_, err = held.ExecContext(ctx, "ROLLBACK")
	require.NoError(t, err)

	list, err := s.List(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1+writers*addsPerWriter, "every add landed")
	for _, tt := range list {
		if tt.ID == seed.ID {
			assert.Equal(t, "held row", tt.Title, "the rolled-back update never landed")
			assert.Equal(t, 1, tt.Version, "the rolled-back update never bumped the version")
			continue
		}
		assert.Equal(t, 1, tt.Version, "a fresh task is at version 1")
	}
}

// TestTursoStore_WriteWriteConflictIsNotErrConflict pins that the engine's
// write-write conflict and the store's stale-snapshot sentinel stay apart.
// A writer holds an open concurrent transaction with an uncommitted UPDATE
// of the row the CAS wants, so every attempt meets the engine's conflict;
// after the bounded retries the store reports the engine's error — a
// retryable conflict — and not ErrConflict, which means something else
// entirely: the snapshot the caller wrote from is stale and re-reading is
// the answer. The held transaction never moves the version, so the CAS
// itself stays valid; the failure is the engine's, and it must surface as
// the engine's.
func TestTursoStore_WriteWriteConflictIsNotErrConflict(t *testing.T) {
	t.Parallel()

	s, err := NewTursoStore(context.Background(), tursoStorePath(t))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })

	ctx := context.Background()
	added, err := s.Add(ctx, task.Task{Title: "write tests", Status: task.StatusTodo})
	require.NoError(t, err)

	held, err := s.db.Conn(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = held.Close() })
	_, err = held.ExecContext(ctx, "BEGIN CONCURRENT")
	require.NoError(t, err)
	_, err = held.ExecContext(ctx, `UPDATE tasks SET title = 'held' WHERE id = ?`, added.ID.String())
	require.NoError(t, err)
	defer func() { _, _ = held.ExecContext(context.WithoutCancel(ctx), "ROLLBACK") }()

	err = s.Complete(ctx, added.ID, added.Version)
	require.Error(t, err)
	assert.NotErrorIs(t, err, ErrConflict, "an engine write-write conflict is not a stale snapshot")
	assert.NotErrorIs(t, err, ErrNotFound, "an engine write-write conflict is not a missing task")
	assert.Contains(t, err.Error(), "Write-write conflict")

	// The row is untouched: the failed attempts rolled back, and the held
	// transaction still owns its uncommitted update.
	list, err := s.List(ctx)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, task.StatusTodo, list[0].Status)
	assert.Equal(t, 1, list[0].Version)
}

// TestTursoStore_TagsAcrossChunks pins the chunk boundary attachTags works
// in: a list longer than tagChunkSize is attached in more than one query, and
// every task's tags must arrive whole — the first task, the task on the
// boundary, and the last one. The walk pairs the two ordered streams, so a
// bug at a boundary would either drop a chunk's tags or attach them to the
// neighbour, and this is the test that says so.
func TestTursoStore_TagsAcrossChunks(t *testing.T) {
	t.Parallel()

	s, err := NewTursoStore(context.Background(), tursoStorePath(t))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })

	ctx := context.Background()
	n := tagChunkSize + 1
	for i := 0; i < n; i++ {
		_, err := s.Add(ctx, task.Task{
			Title: fmt.Sprintf("task-%04d", i),
			Tags:  []string{fmt.Sprintf("tag-%04d", i), "every"},
		})
		require.NoError(t, err)
	}

	tasks, err := s.List(ctx)
	require.NoError(t, err)
	require.Len(t, tasks, n)
	for i, tt := range tasks {
		assert.Equal(t, []string{"every", fmt.Sprintf("tag-%04d", i)}, tt.Tags,
			"task %d carries its own tags and only its own", i)
	}

	// The same check through a filtered query, which is the other path into
	// attachTags: every task carries "every", so ByTag crosses the chunk
	// boundary too.
	byTag, err := s.ByTag(ctx, "every")
	require.NoError(t, err)
	require.Len(t, byTag, n)
	assert.Equal(t, []string{"every", "tag-0000"}, byTag[0].Tags)
	assert.Equal(t, []string{"every", fmt.Sprintf("tag-%04d", n-1)}, byTag[n-1].Tags)
}
````


## `internal/store/tx_test.go`

````go
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	turso "turso.tech/database/tursogo"

	"todo/internal/db"
)

// TestWithConcurrentTx pins the helper's discipline: a commit makes the
// write visible, an error from fn rolls the whole attempt back, and the
// connection is released either way — the next call runs on a clean one.
func TestWithConcurrentTx(t *testing.T) {
	t.Parallel()

	s, err := NewTursoStore(context.Background(), tursoStorePath(t))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })
	ctx := context.Background()

	insert := func(conn *sql.Conn, id string) error {
		_, err := conn.ExecContext(ctx, `
			INSERT INTO tasks (id, title, status, priority, due, version)
			VALUES (?, 'from the helper', 'Todo', 3, NULL, 1)`, id)
		return err
	}

	count := func() int {
		var n int
		require.NoError(t, s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tasks`).Scan(&n))
		return n
	}

	t.Run("commit makes the write visible", func(t *testing.T) {
		id, err := uuid.NewV7()
		require.NoError(t, err)
		require.NoError(t, db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			return insert(conn, id.String())
		}))
		assert.Equal(t, 1, count())
	})

	t.Run("rollback after an error leaves nothing", func(t *testing.T) {
		id, err := uuid.NewV7()
		require.NoError(t, err)
		errBoom := errors.New("stop here")
		err = db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			if err := insert(conn, id.String()); err != nil {
				return err
			}
			return errBoom
		})
		require.ErrorIs(t, err, errBoom)
		assert.Equal(t, 1, count(), "the failed attempt's insert rolled back")
	})

	t.Run("a write-write conflict is retried and the retry commits", func(t *testing.T) {
		// The error shape is fabricated because a real conflict needs a
		// second writer holding the row; what is under test is the loop's
		// contract — the predicate matches, fn runs again from the start,
		// and the retry's write is what lands. The message and the generic
		// kind are the two halves isRetryable looks for, which is all the
		// driver gives a conflict.
		id, err := uuid.NewV7()
		require.NoError(t, err)
		attempts := 0
		err = db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			attempts++
			if err := insert(conn, id.String()); err != nil {
				return err
			}
			if attempts == 1 {
				return fmt.Errorf("%w: Write-write conflict", turso.ErrTursoGeneric)
			}
			return nil
		})
		require.NoError(t, err)
		assert.Equal(t, 2, attempts, "the failed attempt was retried")
		assert.Equal(t, 2, count(), "the retry's insert is the one that landed")
	})

	t.Run("a constraint error is not retried", func(t *testing.T) {
		id, err := uuid.NewV7()
		require.NoError(t, err)
		require.NoError(t, db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			return insert(conn, id.String())
		}))

		attempts := 0
		err = db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			attempts++
			return insert(conn, id.String())
		})
		require.Error(t, err)
		assert.ErrorIs(t, err, turso.ErrTursoConstraint, "a duplicate id is a constraint failure")
		assert.Equal(t, 1, attempts, "a constraint error is a fact, not a transient conflict")
	})
}
````
