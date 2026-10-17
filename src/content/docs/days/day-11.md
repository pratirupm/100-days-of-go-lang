---
title: "Day 11 — Table-driven tests"
sidebar:
  order: 11
chapter: 9
---

**About 3 hours** · Part III, day 1 of 5.

**You'll be able to:**

- turn every test into a table with named subtests, using testify;
- run cases in parallel safely.

---

Every test in the project is a table: rows of cases, one loop, and a check
written out by hand for every value. The shape works, and the suite passes —
but the loop has been copied into every test file, and every copy carries
failure messages someone had to remember to write.

Today the suite gets one standard shape. Each case gets a name and runs as a
**subtest** — a test inside a test, with its own name and its own `t`. The
checks come from **testify**, a small library that prints the expected and
actual values side by side when a check fails. And cases run at the same time
where each one owns its data.

A new rule arrives first: a title may be at most 200 characters. Its tests
come before the code that enforces it, and then the whole suite is rebuilt
around the new shape — same cases, same behavior.

## The length limit arrives as a failing test

The rule is short: a title of 200 characters is accepted, and a title of 201
is rejected with the same `ValidationError` an empty title already gets,
naming the `title` field. We write both as two new rows at the end of the
`TestNewTask` table:

<!-- verify: internal/task/task_test.go at=testify -->
```go title="internal/task/task_test.go"
		{
			name:      "title at the length limit is accepted",
			title:     strings.Repeat("x", 200),
			wantTitle: strings.Repeat("x", 200),
		},
		{
			name:    "title over the length limit is rejected",
			title:   strings.Repeat("x", 201),
			wantErr: true,
		},
```

`strings.Repeat("x", 200)` builds the long titles for us: 200 copies of the
letter x, then 201. The rows use the same fields as every other row, and the
loop stays as it is for now.

Run the tests before touching the code:

```bash
$ go test ./...
ok  	todo/cmd/todo	(cached)
ok  	todo/internal/store	(cached)
--- FAIL: TestNewTask (0.00s)
    task_test.go:55: title over the length limit is rejected: NewTask("xxxx...") error = nil, want error
FAIL
FAIL	todo/internal/task	0.002s
FAIL
```

The suite compiles, so this is not a typo: one case ran and failed. Only
`todo/internal/task` fails; the other two didn't change, so Go answers them
from its cache. The message names the case, then says `error = nil, want
error`: `NewTask` accepted the 201-character title because its only rule so
far is "not empty".

The 200-character row passes already — a boundary that works before the code
exists is the other half of a good rule, and it tells us the failure is the
missing check, not a mistake in the test.

## Give the rule a name and a check

Two additions to `internal/task/task.go`: a constant for the limit, and the
check inside `NewTask`.

<!-- verify: internal/task/task.go at=testify -->
```go title="internal/task/task.go"
// maxTitleLength is the longest title NewTask accepts.
const maxTitleLength = 200

// NewTask validates the title and returns a task with the default status,
// priority, and no due date. It returns a ValidationError if the title is
// empty after trimming surrounding whitespace or if it is longer than
// maxTitleLength characters.
func NewTask(title string) (Task, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Task{}, ValidationError{Field: "title", Message: "cannot be empty"}
	}
	if len(title) > maxTitleLength {
		return Task{}, ValidationError{
			Field:   "title",
			Message: fmt.Sprintf("must be at most %d characters", maxTitleLength),
		}
	}
	return Task{
		Title:    title,
		Status:   StatusTodo,
		Priority: PriorityDefault,
	}, nil
}
```

The constant starts lowercase on purpose: 200 is a rule of this package, not
something callers pass in. The error message is built with `%d` and the
constant, so the number in the message can never drift from the number in the
check. And `len` counts bytes — every character in these tests is one byte, so
bytes and characters are the same number here. If titles ever allow accented
letters, the cap has to pick a side, and a box at the end of the chapter
shows why.

Run the tests:

```bash
$ go test ./...
ok  	todo/cmd/todo	0.002s
ok  	todo/internal/store	0.002s
ok  	todo/internal/task	0.002s
```

Three packages green, and the new rows pass — one rule, one constant, one
branch. The suite is still shaped the way it was before the rule arrived.

## Every case gets a name and an address

The old loop carries two costs. The case's name travels in a hand-written
message — `"%s: NewTask(%q)..."` — so a new check is only as clear as its
author remembered to be. And one loop body runs every check for every case, so
after a failed setup check it has to `continue` past the checks that no longer
mean anything.

The new shape runs each row as a subtest: `t.Run(tt.name, ...)` starts a test
inside the test, with its own name and its own `t`. The name nests under the
parent's, so the 201-character case is
`TestNewTask/title_over_the_length_limit_is_rejected` — an address you can
run by itself.

The new test uses two packages from testify. Add these two lines to the
import block of `internal/task/task_test.go`:

<!-- verify: internal/task/task_test.go at=testify -->
```go title="internal/task/task_test.go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
```

The other test files get the same two lines when we rebuild them. Now replace
the whole `TestNewTask` function with the version below — the table first,
with its middle rows elided because they don't change:

<!-- verify: internal/task/task_test.go at=testify -->
```go title="internal/task/task_test.go"
func TestNewTask(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		title     string
		wantTitle string
		wantErr   bool
	}{
		{
			name:      "valid title gets defaults",
			title:     "buy milk",
			wantTitle: "buy milk",
		},
		// ...
		{
			name:      "title at the length limit is accepted",
			title:     strings.Repeat("x", 200),
			wantTitle: strings.Repeat("x", 200),
		},
		{
			name:    "title over the length limit is rejected",
			title:   strings.Repeat("x", 201),
			wantErr: true,
		},
	}
```

The two new rows sit at the end, and the rows before them are unchanged.
Below the table, the loop that walks it:

<!-- verify: internal/task/task_test.go at=testify -->
```go title="internal/task/task_test.go"
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := NewTask(tt.title)
			if tt.wantErr {
				var ve ValidationError
				require.ErrorAs(t, err, &ve)
				assert.Equal(t, "title", ve.Field)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tt.wantTitle, got.Title)
			assert.Equal(t, StatusTodo, got.Status)
			assert.Equal(t, PriorityDefault, got.Priority)
			assert.True(t, got.Due.IsZero())
		})
	}
}
```

Read the loop from the outside in. The slice is called `tests` and each row
is `tt` — the suite's names everywhere. The parent test calls
`t.Parallel()`, and so does each case; the next sections cover what that
promises. `t.Run` gives every case its own name and its own `t`, so a failure
is reported under the case's name, and one case failing no longer hides its
siblings.

The rejection branch leads with `require.ErrorAs`: it checks that the error is
a `ValidationError` and stores it in `ve`. Everything below reads `ve`, so
that check is a precondition, and `require` stops the case when a precondition
fails. The field check is then an `assert`, so a wrong field reports itself
instead of stopping. The success branch leads with `require.NoError` for the
same reason: everything after it reads `got`. The four value checks are
deliberately boring — one call per value, expected value first, actual second.

The old messages are gone. The subtest's name says which case failed; testify
says which value, and which way.

## The project's first dependency

testify is not part of Go. It is a separate package, published by other
people, and the project has to download it — the first dependency the app has
ever had. Go's rule is literal: a dependency becomes real when code imports
it. The imports are in place, so ask Go to fetch what they name:

```bash
$ go mod tidy
go: finding module for package github.com/stretchr/testify/require
go: finding module for package github.com/stretchr/testify/assert
go: found github.com/stretchr/testify/assert in github.com/stretchr/testify v1.12.1
go: found github.com/stretchr/testify/require in github.com/stretchr/testify v1.12.1
```

`go mod tidy` reads every import in the project and makes `go.mod`, the file
that lists what the project needs, match. Two files change. The first is
`go.mod` itself:

<!-- verify: go.mod at=testify -->
```text title="go.mod"
module todo

go 1.26.8

require github.com/stretchr/testify v1.12.1

require go.yaml.in/yaml/v3 v3.0.5 // indirect
```

The first `require` line names a module our test files import directly. The
second is `// indirect`: no file here names it, but testify's own code imports
it, so the build needs it too. The second file is `go.sum`:

<!-- verify: go.sum at=testify -->
```text title="go.sum"
github.com/stretchr/testify v1.12.1 h1:EuwCh5fleGS7H32xRwO3wRGT7DxrDhLAT6FF8MpWDWE=
github.com/stretchr/testify v1.12.1/go.mod h1:MDEgiDPPsNp5cuIrHPPCyornHKgEVbtFUmoNlxoYthg=
go.yaml.in/yaml/v3 v3.0.5 h1:N6y/pJk8buWs9NY5ERU2HSMfm+IuD/OtfdAnq6kESPw=
go.yaml.in/yaml/v3 v3.0.5/go.mod h1:HVTZu1O7/Vkt2N+BFy8Zza+lnLsABggaTM2ZpNIGuKg=
```

`go.sum` is the receipt drawer: for every module the build touches, it records
a content hash, and Go checks each download against its hash before compiling.
A download server can hand over the bytes, but it cannot change them
unnoticed.

One warning about order. If you reach for `go get` before any file imports
the package, you get a requirement nothing uses:

```bash
$ go get github.com/stretchr/testify@latest
go: added github.com/stretchr/testify v1.12.1
```

The next `go mod tidy` takes it straight back out. Write the import first,
then tidy, and the requirement stays.

## Cases can run at the same time

`t.Parallel()` pauses a case. When the parent test's loop finishes, the
paused cases resume together. That saves time on a slow suite, and it comes
with one rule: a parallel case must own its data, or only read data nobody
writes.

Most cases own their data, because each one builds a fresh store. Two tables
in the store tests cannot, and both say so in a comment. The add-order cases
share one store on purpose: each ID depends on the adds before it:

<!-- verify: internal/store/store_test.go at=testify -->
```go title="internal/store/store_test.go"
		t.Run(tt.name, func(t *testing.T) {
			// No t.Parallel: these subtests share s, and each ID depends
			// on the adds that came before it.
			got := s.Add(task.Task{Title: tt.title, Status: task.StatusTodo})
```

The comment keeps that reason where the case lives. The `ByStatus` cases
share a store that nothing writes, so sharing is safe:

<!-- verify: internal/store/store_test.go at=testify -->
```go title="internal/store/store_test.go"
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			// s is read-only in these cases, so they may share it.
			got := s.ByStatus(tt.status)
```

Read-only sharing is safe, and the comment says so. That is the enforcement:
the next person to edit those cases reads why before adding a write. And when
you add a `t.Parallel()` of your own, run `go test -race` once — it watches
every read and write; the last error below shows what it reports.

## `require` stops; `assert` keeps going

testify ships as two packages with the same vocabulary. `require.Equal` and
`assert.Equal` check the same thing; the difference is what happens on
failure. `require` stops the case at the first failed check. `assert` records
the failure and returns, so one run reports every mismatch.

The suite's rule shows in every table: `require` for preconditions — a setup
error, an `err` that must be nil before the value below it means anything, an
error that must be the expected type before reading its fields — and `assert`
for the values themselves. The `Complete` cases show both:

<!-- verify: internal/store/store_test.go at=testify -->
```go title="internal/store/store_test.go"
			err := s.Complete(tt.id)
			if tt.wantErr {
				require.Error(t, err)
				assert.ErrorIs(t, err, ErrNotFound)
				assert.Contains(t, err.Error(), tt.wantErrMsg)
				return
			}

			require.NoError(t, err)
			list := s.List()
			require.Len(t, list, len(tt.wantStatus))
			for i, want := range tt.wantStatus {
				assert.Equal(t, want, list[i].Status)
			}
```

Two habits keep the reports boring, which is the point. Expected value first,
actual second — `assert.Equal(t, want, list[i].Status)` — so a failure reads
in that order. And one call per value: comparing a whole `Task` in one line
looks tempting until you have seen its diff.

A message belongs only where a case needs context. The missing-task row pins
the `"complete task 3: "` prefix, because that prefix is part of what the
error promises; the text after it is checked by identity, not by string.
Everywhere else, the subtest's name and testify's expected/actual pairing
already say which row and which value.

## One shape for the whole suite

The store tests are the biggest file in the suite, and they get the same
treatment. Work through it table by table: rename the slice to `tests`, wrap
each case in `t.Run(tt.name, ...)`, and replace each hand-written check with a
`require` or an `assert`. Seven store tests build a store the same way, so
that fixture moved into one helper:

<!-- verify: internal/store/store_test.go at=testify -->
```go title="internal/store/store_test.go"
// mustStore returns a store holding the given tasks in insertion order,
// with sequential IDs starting at 1.
func mustStore(t *testing.T, tasks ...task.Task) *MemoryStore {
	t.Helper()
	s := NewMemoryStore()
	for i, tt := range tasks {
		got := s.Add(tt)
		require.Equal(t, i+1, got.ID, "Add assigns IDs in insertion order")
	}
	return s
}
```

`t.Helper()` is the small but important line. Without it, a `require` inside
the helper would report a line inside `mustStore`; with it, a failure names
the test line that called the helper. The rule: any function that can fail a
test but is not itself a test should call `t.Helper()`.

Two details are worth keeping as they are. The `ByTag` cases preserve a
distinction the suite has always made: when nothing matches, the store returns
nil, not an empty list, and the test says so with `assert.Nil`. And tests that
had a single scenario — the command's run, the JSON round trip, the unknown
status — became one-row tables, so every test has the same shape.

The command's test is short enough to show whole:

<!-- verify: cmd/todo/main_test.go at=testify -->
```go title="cmd/todo/main_test.go"
package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRun(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		want string
	}{
		{
			name: "seeds tasks, completes the first, and prints the list",
			want: "1. [Done] buy milk\n2. [Todo] write the book\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var out bytes.Buffer
			require.NoError(t, run(&out))
			assert.Equal(t, tt.want, out.String())
		})
	}
}
```

Even one case gets a row and a subtest: any test can grow a second case
without changing shape. `require.NoError(t, run(&out))` comes before the
output is read, because a failed run makes the output meaningless.

## Run everything, and read the names

```bash
$ go test ./...
ok  	todo/cmd/todo	0.005s
ok  	todo/internal/store	0.006s
ok  	todo/internal/task	0.007s
```

Same verdict, same cases, new shape. That is what rebuilding tests should
feel like — behavior does not move.

Subtests also make one case runnable by name:

```bash
$ go test -v -run TestMemoryStore_ByStatus/unknown_status_returns_nothing ./internal/store
=== RUN   TestMemoryStore_ByStatus
...
--- PASS: TestMemoryStore_ByStatus (0.00s)
    --- PASS: TestMemoryStore_ByStatus/unknown_status_returns_nothing (0.00s)
PASS
ok  	todo/internal/store	0.007s
```

Spaces become underscores in a case's full name, and `-run` matches that
name. To see every case the suite contains, one per line:

```bash
$ go run gotest.tools/gotestsum@latest --format=testname -- ./...
PASS cmd/todo.TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list (0.00s)
PASS internal/store.TestMemoryStore_AddAndList/first_add_gets_ID_1 (0.00s)
PASS internal/task.TestNewTask/valid_title_gets_defaults (0.00s)
PASS internal/task.TestNewTask/title_over_the_length_limit_is_rejected (0.00s)
...

DONE 69 tests in 0.003s
```

`go run gotest.tools/gotestsum@latest` runs a tool without adding it to the
project — something you run, not a dependency the app ships. Sixty-nine tests,
every one with an address: `first_add_gets_ID_1` is one row of one table, and
the 201-character case sits under its parent's name.

Next, the tests learn to compare whole outputs, not single values.

## If something went wrong

**A row that forgot it expected an error.** Delete `wantErr: true` from the
201-character row and run that case alone:

```bash
$ go test -v -run TestNewTask/title_over_the_length_limit_is_rejected ./internal/task
=== RUN   TestNewTask
=== PAUSE TestNewTask
=== CONT  TestNewTask
=== RUN   TestNewTask/title_over_the_length_limit_is_rejected
=== PAUSE TestNewTask/title_over_the_length_limit_is_rejected
=== CONT  TestNewTask/title_over_the_length_limit_is_rejected
    task_test.go:65: 
        	Error Trace:	…/internal/task/task_test.go:65
        	Error:      	Received unexpected error:
        	            	invalid title: must be at most 200 characters
        	Test:       	TestNewTask/title_over_the_length_limit_is_rejected
--- FAIL: TestNewTask (0.00s)
    --- FAIL: TestNewTask/title_over_the_length_limit_is_rejected (0.00s)
FAIL
FAIL	todo/internal/task	0.006s
FAIL
```

`wantErr` is a `bool`, and a `bool` that was never set is `false`. A row that
omits it says "this call must succeed", so the loop walks into the success
branch — and the report blames the code for returning an error the row never
expected, a test failing in the wrong direction, which is worse than passing
by accident. Fix: set `wantErr: true` on every rejection row, and read each
row asking one question: which branch should this case take?

**`assert` where `require` was needed.** A scratch test that unmarshals broken
JSON and then reads the result:

```go
func TestScratch_AssertThenNilDeref(t *testing.T) {
	var got *Task
	err := json.Unmarshal([]byte(`{"Title":`), &got)
	assert.NoError(t, err)
	assert.Equal(t, "x", got.Title)
}
```

The run reports the JSON error first, then crashes:

```text
=== RUN   TestScratch_AssertThenNilDeref
    scratch_require_test.go:24: 
        	Error Trace:	…/scratch_require_test.go:24
        	Error:      	Received unexpected error:
        	            	unexpected end of JSON input
        	Test:       	TestScratch_AssertThenNilDeref
--- FAIL: TestScratch_AssertThenNilDeref (0.00s)
panic: runtime error: invalid memory address or nil pointer dereference [recovered, repanicked]
[signal SIGSEGV: segmentation violation code=0x1 addr=0x8 pc=0x5e1f0d]
…
FAIL	todo/internal/task	0.005s
FAIL
```

`assert` records the failed check and returns, so the next line runs with
`got` still empty — and reading a field of an empty pointer crashes the run,
taking every case after it down with it. Fix: `require.NoError`, because
everything below it uses the value. The tell is a value the next line reaches
into: that is a hard boundary, and `require` is the tool for hard boundaries.

**A parallel case that writes shared data.** Four cases adding to one store:

```go
func TestScratch_ParallelMutate(t *testing.T) {
	s := NewMemoryStore()
	for _, title := range []string{"one", "two", "three", "four"} {
		t.Run(title, func(t *testing.T) {
			t.Parallel()
			s.Add(task.Task{Title: title})
		})
	}
}
```

Run it with the race detector:

```bash
$ go test -race -count=1 -run TestScratch_ParallelMutate ./internal/store
==================
WARNING: DATA RACE
Read at 0x00c000134518 by goroutine 13:
  todo/internal/store.(*MemoryStore).Add()
      …/internal/store/store.go:48 +0xaa
...
==================
--- FAIL: TestScratch_ParallelMutate (0.00s)
    --- FAIL: TestScratch_ParallelMutate/two (0.00s)
        testing.go:1712: race detected during execution of test
FAIL
FAIL	todo/internal/store	0.022s
FAIL
```

Two cases touched the same store at the same time, and one wrote — the report
names both sides. Fix: give each case its own store, as `mustStore` does, or
leave the cases sequential when the shared order is the point, as the
add-order table does. Without the detector this failure is sneaky: it often
passes on one machine and fails on another.

<details>
<summary>Going deeper: bytes, characters, and the length limit</summary>

`len(title)` counts bytes, not characters. The letter `é` takes two bytes, so
a title of 200 `é` characters measures 400 bytes and the byte cap rejects it,
even though a reader would call it exactly at the limit. Nothing in these
tests has an accented letter, so the counts agree here. If that ever changes,
the check has to pick a side — `len` for bytes, `utf8.RuneCountInString` for
characters — and the doc comment above `NewTask` should say which.

</details>

<details>
<summary>Going deeper: the loop variable, then and now</summary>

Before Go 1.22, every loop had one variable, reused on every round. A case
that called `t.Parallel()` pauses until the loop finishes, so by the time it
ran, the variable held the *last* row's value and the case checked the wrong
data. The folklore fix was to copy the row inside the loop:

```go
	for _, tt := range tests {
		tt := tt // no longer needed
		t.Run(tt.name, func(t *testing.T) { ... })
	}
```

Go 1.22 gave every round its own variables, so this project's Go captures
`tt` directly and the copy line is dead weight. What still breaks is
capturing a variable the loop deliberately reuses — an accumulator declared
outside the loop. The per-iteration variable is fine; shared storage is not.

</details>

<details>
<summary>Going deeper: what testify adds, and what it costs</summary>

Every assertion in the suite could be an `if` plus a `t.Errorf`, and that is
how the suite was written until today. What testify adds is the report:
expected and actual printed side by side, a diff when values are long, and
one vocabulary every test speaks. What it costs is one dependency, four lines
in `go.sum`, and a style you have to keep boring — `assert.True(t, a == b)`
throws away everything `assert.Equal` is for.

</details>

<details>
<summary>Going deeper: what `go.mod` and `go.sum` really record</summary>

A module is a project with a name, and `go.mod` lists the modules it needs.
`require` lines are promises: each names a module and an exact version. The
`// indirect` marker means no file here imports that module directly — the
build needs it because testify's own code does.

A third module, `github.com/stretchr/objx`, appears in testify's own module
file but is imported only by a package this project doesn't use, so it stays
out of our `go.mod`. Ask Go for the full list the build can see:

```bash
$ go list -m all
todo
github.com/stretchr/objx v0.5.3
github.com/stretchr/testify v1.12.1
go.yaml.in/yaml/v3 v3.0.5
```

Downloads land in a cache on your machine, and `go.sum`'s hashes are checked
before anything is compiled. A repeat build reuses the cache; the network is
consulted only on a miss.

</details>

<div class="day-tracker" data-day="11"></div>
