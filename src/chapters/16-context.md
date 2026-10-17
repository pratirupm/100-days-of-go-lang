---
title: Context and cancellation
day: 19
time: "3 hours"
description: Pass a context into every store call so canceled work stops — and delete the hand-rolled timer and cancel channel.
sidebar:
  order: 16
---

Every store call we have written starts and then finishes. That is fine while
the work is microseconds over a slice in memory. But the same methods will
soon run against a database over the network, where one call can hang for
seconds. If the caller has already walked away, the work should stop.

Callers always care for a while and then maybe stop: a person presses Ctrl-C,
a web request times out. The work needs to hear one thing — *stop* — and to
say why.

So far, only `Stats` can hear it, through machinery we built by hand: a cancel
channel, a timer, a watcher goroutine, two error values of our own. Every
other operation runs to completion no matter what.

Go's standard library has a name for what that machinery imitates: a
**context**. A context is a small value that travels alongside a piece of
work and answers three questions: is the caller still waiting, why did they
stop, and when must this finish? By the end of this build, every store method
takes one first, a canceled call stops with a plain error, and the hand-rolled
parts are gone.

## What a context is

A context is not the work. It is the note that travels with the work, saying
which job this belongs to and how to tell whether anyone still wants it. In
Go it is a value of type `context.Context`, passed as an ordinary parameter.

Every chain starts at `context.Background()`: an empty context that never
stops — "nobody is waiting on me, run to completion".

A caller that *can* stop the work derives a child context from a parent.
`context.WithCancel` returns a child and a **cancel function**; calling it
marks the child done. `context.WithTimeout` adds a deadline, after which the
child goes done by itself. `context.WithCancelCause` returns a cancel function
that takes an error — the caller's own reason.

Three methods let the work ask its questions. `Done()` returns a channel that
closes when the context stops — waiting on it is how a `select` learns to
give up. `Err()` is nil while the context is live, and afterwards reports
`context.Canceled` or `context.DeadlineExceeded`. `Cause()` returns the
caller's own error when one was attached, and otherwise the same value as
`Err()`.

Two rules come with the type. A context is the first parameter of every
function that takes one, named `ctx`. And it is passed, never stored in a
struct: a context describes one call's lifetime, and a struct field outlives
it.

## The new promise, in tests

The promise has two halves. Every store method, handed a context that is
already done, must stop before doing any work and return an error matching
`context.Canceled`. And when the caller canceled with its own reason, the
error must match that reason instead.

One table covers all nine methods. Each entry calls a method with a given
context and keeps only the error:

<!-- verify: internal/store/store_test.go at=context -->
```go title="internal/store/store_test.go"
// storeCall names one Store method and runs it against s with ctx, discarding
// any returned values: the cancellation tests care about the error alone.
type storeCall struct {
	name string
	call func(s *MemoryStore, ctx context.Context) error
}

...
func storeCalls() []storeCall {
	return []storeCall{
		{
			name: "Add",
			call: func(s *MemoryStore, ctx context.Context) error {
				_, err := s.Add(ctx, task.Task{Title: "write tests"})
				return err
			},
		},
		...
	}
}
```

The `Add` entry shows the shape the other eight follow: call the method,
keep the error, drop the values.

The first test runs the whole table against a context canceled before the
loop:

<!-- verify: internal/store/store_test.go at=context -->
```go title="internal/store/store_test.go"
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
```

The context is done before any method runs, so every entry check sees it —
nothing races.

The second test runs the same table with a custom cause. The store must
report the caller's error, and must *not* match the generic one:

<!-- verify: internal/store/store_test.go at=context -->
```go title="internal/store/store_test.go"
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
```

`errors.Is` finds the caller's error inside the returned one; the generic
`context.Canceled` is deliberately absent.

`Stats` gets two tests of its own, because it has one corner the table cannot
reach: a deadline that has already passed.

<!-- verify: internal/store/stats_test.go at=context -->
```go title="internal/store/stats_test.go"
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
```

The entry check wins before a snapshot or a worker exists, so the call
reports the zero `Stats`.

The second test wires a deadline that expired in the past:
`context.WithTimeout(ctx, 0)` is done at creation, so no stopwatch is needed.

<!-- verify: internal/store/stats_test.go at=context -->
```go title="internal/store/stats_test.go"
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
```

Append the four tests — the table and the first two to
`internal/store/store_test.go`, the last two to
`internal/store/stats_test.go` — and add `context` to both files' imports.
Then delete the five tests that pinned the hand-rolled API: the three that
drove `StatsCancelable` and the two that drove `StatsWithin`.

One more sweep: every remaining store call in the test files needs a context
first, and a second return value where a value comes back; most pass
`context.Background()`, because they are not about cancellation. Then run
everything:

```bash
$ go test -count=1 ./...
```

```text
# todo/cmd/todo [todo/cmd/todo.test]
cmd/todo/main_test.go:28:49: too many arguments in call to run
	have (context.Context, *bytes.Buffer)
	want (io.Writer)
# todo/internal/store [todo/internal/store.test]
internal/store/bench_test.go:72:16: assignment mismatch: 2 variables but s.Add returns 1 value
internal/store/bench_test.go:72:32: too many arguments in call to s.Add
...
FAIL	todo/cmd/todo [build failed]
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	0.003s
FAIL
```

The compiler is the checklist. The two error lines say what every fix is:
`assignment mismatch: 2 variables but s.Add returns 1 value` counts the new
error return, and `too many arguments in call to s.Add` counts the new first
parameter.

The store binary stops after ten errors — all in the benchmark file, which
sorts first — but the remaining call sites need the same two edits. Your line
numbers will differ; the shapes will not.

## Give every store method a context

Now the interface. Every method gains `ctx context.Context` in front and an
error at the end — and `Stats` joins the list, because it can now fail like
everything else and belongs in the contract:

<!-- verify: internal/store/store.go at=context -->
```go title="internal/store/store.go"
// Store is the persistence contract the rest of the application depends on.
//
// Every method takes a context as its first parameter and reports a done
// context by returning an error that wraps context.Cause(ctx); values
// returned alongside such an error are unspecified, so callers check the
// error before trusting the value. A nil ctx is a programming error, not a
// cancellation: the methods panic on it the way ctx.Err does.
//
// ...
type Store interface {
	Add(ctx context.Context, t task.Task) (task.Task, error)
	List(ctx context.Context) ([]task.Task, error)
	ByStatus(ctx context.Context, status task.Status) ([]task.Task, error)
	ByTag(ctx context.Context, tag string) ([]task.Task, error)
	CountByTag(ctx context.Context) (map[string]int, error)
	Tags(ctx context.Context) ([]string, error)
	SortByDue(ctx context.Context) ([]task.Task, error)
	Complete(ctx context.Context, id int) error
	Stats(ctx context.Context) (Stats, error)
}
```

Read the doc comment as the contract: a done context comes back as an error
wrapping `context.Cause(ctx)`, the values beside such an error are
unspecified, and a nil `ctx` is a programming error — the methods panic, the
way `ctx.Err` does. If you are unsure which context to pass, pass
`context.TODO()`.

One helper does all the checking:

<!-- verify: internal/store/store.go at=context -->
```go title="internal/store/store.go"
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
```

`ctx.Err()` is the first question — nil while the context is live, non-nil
once it is done. The error wraps `context.Cause(ctx)` rather than
`ctx.Err()`: an ordinary cancel still matches `context.Canceled`, an expired
deadline matches `context.DeadlineExceeded`, and a caller who attached its
own error gets it in the chain. The name in front — `add task`, `list tasks`
— says what was attempted.

Every method opens with its own named check; `Add` is the pattern:

<!-- verify: internal/store/store.go at=context -->
```go title="internal/store/store.go"
func (s *MemoryStore) Add(ctx context.Context, t task.Task) (task.Task, error) {
	if err := ctxErr(ctx, "add task"); err != nil {
		return task.Task{}, err
	}
```

Methods that call a sibling pass the context down, so an error carries the
name of the operation the caller asked for. `CompleteAll` gains the leading
parameter without changing its best-effort policy:

<!-- verify: internal/store/store.go at=context -->
```go title="internal/store/store.go"
// CompleteAll completes every id, best-effort, and returns the joined errors
// of the operations that failed (nil when all succeed). Every Complete call
// receives ctx, so a done context turns each remaining id into a cancellation
// failure like any other; the batch still visits all of them because
// best-effort is its contract.
func CompleteAll(ctx context.Context, s Store, ids []int) error {
	var errs []error
	for _, id := range ids {
		if err := s.Complete(ctx, id); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
```

Each `Complete` receives the context, so a batch against a done context
collects one cancellation failure per id and joins them. Stopping early would
be a different promise.

The benchmark file gets the same treatment, with one shared
`benchCtx = context.Background()` that can never fire, so the measured work
carries no cancellation case.

## Delete the hand-rolled cancellation

`Stats` keeps the pool and the select shape; what changes is where the signal
comes from. The entry check returns the zero aggregate before any snapshot or
goroutine exists:

<!-- verify: internal/store/stats.go at=context -->
```go title="internal/store/stats.go"
func (s *MemoryStore) Stats(ctx context.Context) (Stats, error) {
	// Cancellation that is already visible at entry must not lose a worker
	// to the race: the check returns before the snapshot and before any
	// goroutine starts, which is also what keeps the pre-canceled test
	// deterministic — ctx.Done() is already closed, so no select can
	// choose otherwise.
	if err := ctxErr(ctx, "stats"); err != nil {
		return Stats{}, err
	}
```

Why the zero `Stats`? Nothing has been merged yet, so there is no partial
aggregate to hand back — and the value beside an error is always unspecified.

The worker's send is still its only place to wait, and the cancel channel is
now `ctx.Done()`:

<!-- verify: internal/store/stats.go at=context -->
```go title="internal/store/stats.go"
			// The send is the worker's cancellation point: if the caller
			// gave up, drop the partial and exit instead of blocking on
			// a consumer that may already be gone.
			select {
			case partials <- statsOf(chunk):
			case <-ctx.Done():
				return
			}
```

The merge loop gains the same case, and a cancel that lands mid-call returns
what was merged so far:

<!-- verify: internal/store/stats.go at=context -->
```go title="internal/store/stats.go"
		case <-ctx.Done():
			// A canceled call returns what was merged so far, not a
			// zeroed value. Workers still folding observe ctx.Done at
			// their next send and exit; the joiner's close then goes to
			// nobody, which is legal. A closed Done guarantees a non-nil
			// Err, so ctxErr always reports here.
			return merged, ctxErr(ctx, "stats")
```

With those three changes, the whole hand-roll goes:

| we wrote by hand | what replaced it |
| --- | --- |
| `ErrStatsCanceled` and `ErrStatsTimeout` | `context.Canceled` and `context.DeadlineExceeded` |
| `StatsCancelable(cancel)` | `Stats(ctx)`, selecting on `ctx.Done()` |
| `StatsWithin(d)` and its timer | the caller's `context.WithTimeout` |
| the watcher goroutine and its `done` channel | nothing — the package owns both |
| the panic guarding a nil channel | nothing — there is no nil channel |

Delete `StatsCancelable`, `StatsWithin`, both error values, and the old
`Stats` body from `stats.go`; `Stats` becomes the pool itself. The imports
follow: `stats.go` drops `errors` and `time`, and `context` joins it.

The deadline machinery did not disappear; it moved to the caller, where the
lifetime belongs. The idiom is two adjacent lines:

```go
	ctx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
```

The cancel function is not optional: it releases the timer and the child's
registration with its parent, and `go vet` refuses code that drops it.

One design note before moving on: every `MemoryStore` method checks once, at
entry, because its work cannot block; `Stats` checks at each send and
receive. Check where you wait.

## Turn signals into cancellation

The store can now stop when its caller says stop, but the app never says it.
`main` is where the outside world becomes a context:

<!-- verify: cmd/todo/main.go at=context -->
```go title="cmd/todo/main.go"
func main() {
	// A first interrupt or SIGTERM cancels ctx, so every store call in run
	// aborts with a context error instead of the process dying mid-write.
	// stop unregisters the handler; the defer covers the normal return,
	// while the os.Exit on the error path skips it — the process is
	// leaving anyway.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

`signal.NotifyContext` builds a context from `context.Background()` and
cancels it on the first interrupt (`os.Interrupt`, what Ctrl-C sends) or
termination request (`syscall.SIGTERM`, what the system sends to end a
process). `stop` unregisters the handler; the `defer` cleans up.

A signal that arrives while the store is working aborts every store call in
`run`, and `main` prints the context error and exits with status 1 instead of
dying mid-write.

`run` takes the context first and hands it to every store call:

<!-- verify: cmd/todo/main.go at=context -->
```go title="cmd/todo/main.go"
func run(ctx context.Context, w io.Writer) error {
	s := store.NewMemoryStore()
	for _, title := range []string{"buy milk", "write the book"} {
		t, err := task.NewTask(title)
		if err != nil {
			return err
		}
		if _, err := s.Add(ctx, t); err != nil {
			return err
		}
	}
```

The rest of `run` is unchanged: the `CompleteAll` call and the final `List`
receive `ctx` too. The snapshot test passes a context that can never fire.

## Regenerate the mock

The store's stand-in in the tests is generated from the interface, so the
interface's new shape has to be pushed through the generator. The
`//go:generate` line above the interface records the command; run it from the
app's root:

```bash
$ go generate ./...
```

The generator prints nothing on success, but the file it wrote cannot be
compiled. The store package's part of the next test run reads:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/store
package todo/internal/store
	imports todo/internal/store from store_moq_test.go: import cycle not allowed in test
FAIL	todo/internal/store [setup failed]
```

The generated file imports `todo/internal/store` — its own package — and Go
refuses a package that imports itself. The cause is one flag: `-pkg store`
made the generator qualify the new `Stats` return type with the package's own
import path instead of using it bare. Drop the flag, and the generator infers
the package from the directory — the same `package store`:

```text
-//go:generate go run github.com/matryer/moq@v0.8.0 -pkg store -out store_moq_test.go . Store
+//go:generate go run github.com/matryer/moq@v0.8.0 -out store_moq_test.go . Store
```

Regenerate, and the cycle is gone; the file is otherwise identical.

## Run everything

The four new tests, in one command:

```bash
$ go test -v -count=1 \
	-run 'TestMemoryStore_CanceledContext|TestMemoryStore_CustomCancelCause|TestMemoryStore_Stats_CanceledContext|TestMemoryStore_Stats_DeadlineExceededContext' \
	./internal/store
```

```text
--- PASS: TestMemoryStore_Stats_CanceledContext (0.00s)
--- PASS: TestMemoryStore_CustomCancelCause (0.00s)
    --- PASS: TestMemoryStore_CustomCancelCause/Add (0.00s)
    …
--- PASS: TestMemoryStore_CanceledContext (0.00s)
    --- PASS: TestMemoryStore_CanceledContext/Add (0.00s)
    …
--- PASS: TestMemoryStore_Stats_DeadlineExceededContext (0.00s)
PASS
ok  	todo/internal/store	0.005s
```

Four tests and eighteen subtests, every one at 0.00s — the `…` lines stand
in for the rest.

Then the whole suite:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.005s
ok  	todo/internal/task	0.003s
```

The store's tests are clean under the race detector too: the cancellation
travels only through the context's channel, an ordered hand-off.

Next: the store becomes safe to share between goroutines — a lock around its
tasks, and a counter for the calls made to it.

## If something went wrong

**The custom cause never arrives.** The propagation test fails with:

```text
--- FAIL: TestMemoryStore_CustomCancelCause (0.00s)
    --- FAIL: TestMemoryStore_CustomCancelCause/Add (0.00s)
        store_test.go:711:
            	Error:      	Target error should be in err chain:
            	            	expected: "budget exhausted"
            	            	in chain: "add task: context canceled"
            	            		"context canceled"
```

The chain says `context canceled`, so `errors.Is(err, errBudget)` cannot
match: `ctx.Err()` reports only the generic answer. Wrap
`context.Cause(ctx)` in `ctxErr`, as the quote above does. Report with
`Cause`, match with `errors.Is`, and never compare error text.

**A context stored in a struct.** No compiler will catch this one:

```go
type Store struct {
	ctx context.Context // the mistake
}
```

A context carries one call's lifetime, and a struct field outlives it. A
constructor that keeps its context makes every later operation report a
cancellation from long-dead startup work. Pass it instead: the method takes
`ctx`, and a goroutine gets the enclosing call's context through its closure.

**The cancel function lost.** `go vet` reports both ways of losing it. A
function thrown away:

```text
main.go:15:5: the cancel function returned by context.WithCancel should be called, not discarded, to avoid a context leak
main.go:16:5: the cancel function returned by context.WithTimeout should be called, not discarded, to avoid a context leak
```

And one reachable only on a single path:

```text
main.go:21:2: the cancel function is not used on all paths (possible context leak)
main.go:27:1: this return statement may be reached without using the cancel var defined on line 21
```

Writing `_, _ = context.WithCancel(...)` throws away the one handle that can
release the child, and a timeout's timer runs until it fires. Keep the handle
and `defer cancel()` on the line after the derivation: every path out of the
function then reaches it.

<details>
<summary>Going deeper: what `Done`, `Err`, and `Deadline` answer</summary>

`Done()` returns the channel to wait on; it closes once, when the context is
canceled or its deadline passes, and it never carries a value — closing *is*
the message. `Err()` answers "is this done, and why in the broad sense".
`Cause()` answers "who ended it, and for what reason". `Deadline()` answers
"when must this be finished", with `ok == false` when there is no deadline.

`context.Background()` and `context.TODO()` never fire: their `Done()` is
nil, and a receive from a nil channel blocks forever — the same rule the
hand-rolled cancel channel used to lean on.

</details>

<details>
<summary>Going deeper: values, and the reading behind this build</summary>

`context.WithValue` is the one part of the package this build never touches:
values are for request-scoped data like a request ID or a logger, never for
passing ordinary parameters.

The sources behind this build, if you want to read further:

- The `context` package reference: https://pkg.go.dev/context
- *Go Concurrency Patterns: Context*: https://go.dev/blog/context
- *Contexts and Structs*, on why a context never goes in a struct:
  https://go.dev/blog/context-and-structs
- `os/signal.NotifyContext`, the process edge: https://pkg.go.dev/os/signal#NotifyContext

</details>
