---
title: Snapshot tests
day: 12
time: "2.5 hours"
description: Record the expected output in files the test tool writes, read them once, and let the suite compare against them from then on.
sidebar:
  order: 10
---

Most tests compare one value against another: a title, a status, an error's
identity. The CLI's test is different. It compares a whole listing — the two
lines a person sees in the terminal — and right now that listing lives inside
the test as text with `\n` marks where the line ends.

Text like that is hard to read, and every change to the output means editing
the test by hand. So we'll move it into a file. The test tool records the app's
output into the file on the first run; we read the file once and agree with it;
from then on the test compares the output against the file. A file recorded
this way is called a **snapshot**.

We'll record two things this way: the CLI listing, and the four shapes a task
line can take. Then we'll practice the part that matters most — reading what
was recorded, and knowing what to do when the output changes on purpose.

## A file that holds the expected output

A file holding expected output is often called a **golden file**. The name is
old and simple: the file is the gold copy that everything else is compared
against. A person writes it by hand, and the test compares the app's output
with it, character for character.

A snapshot is the same idea with a different author. The tool writes the file
on the first run — the test passes and records what it saw — and from that
moment the file is compared exactly like a golden. One rule makes this safe:
review. The file is trustworthy only because a person read it once and agreed
with it. The tool never rewrites a file on its own; updating is a separate,
deliberate step.

We'll use a library called `go-snaps` for the recording and the comparing. It
keeps its files in a folder named `__snapshots__`, next to the test that uses
them: `cmd/todo/__snapshots__/main_test.snap` for the CLI test, and
`internal/task/__snapshots__/task_test.snap` for the task tests. Each test gets
its own block, or entry, in the file, and the test's name is how the tool finds
the right entry on the next run.

## Add the two libraries

The snapshot library and a second one, for comparing whole structures, both
arrive with one command. Run it from the app's root folder — the one that holds
`go.mod`:

```bash
$ go get github.com/gkampitakis/go-snaps@v0.5.23 github.com/google/go-cmp@v0.7.0
go: downloading github.com/google/go-cmp v0.7.0
go: downloading github.com/gkampitakis/go-snaps v0.5.23
go: added github.com/gkampitakis/go-snaps v0.5.23
go: added github.com/google/go-cmp v0.7.0
```

`go get` fetched both libraries and added them to `go.mod`, the file that
records the project's dependencies. The interesting part of the file now reads:

<!-- verify: go.mod at=snapshots -->
```text title="go.mod"
require (
	github.com/gkampitakis/go-snaps v0.5.23
	github.com/google/go-cmp v0.7.0
	github.com/stretchr/testify v1.12.1
)
```

The two new names sit beside `testify`, which the suite already uses. Below
this block, `go.mod` lists the libraries' own dependencies, each marked
`// indirect` — things the two libraries need, which we never write by hand.

One ordering note before we move on: fetch the libraries now — the tests are
about to import them — and tidy the project's dependency files only after
that test code exists. `go mod tidy` removes a module that nothing imports, so
tidying now would undo this step; the same ordering the testify dependency
taught earlier.

## Hand the listing to a file

Open `cmd/todo/main_test.go`. It keeps its table, its subtest, and its
`require.NoError` guard; only the expected listing moves out. The changes are
small: the `assert` import becomes the `snaps` import, the table loses its
`want` field, and the old `assert.Equal` line becomes the snapshot call. The
finished file looks like this:

<!-- verify: cmd/todo/main_test.go at=snapshots -->
```go title="cmd/todo/main_test.go"
package main

import (
	"bytes"
	"testing"

	"github.com/gkampitakis/go-snaps/snaps"
	"github.com/stretchr/testify/require"
)

func TestRun(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
	}{
		{
			name: "seeds tasks, completes the first, and prints the list",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var out bytes.Buffer
			require.NoError(t, run(&out))
			snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, out.String())
		})
	}
}
```

Read the last line first: `MatchSnapshot` hands the output to the tool, and the
tool compares it with the entry named after this subtest. `snaps.Raw()` says to
store the text as it is — the listing exactly as a person would see it, not
wrapped in Go's own quoting. And the table survives with its one row, so a
second scenario still costs one more row.

## Snapshot the four task lines

Now `internal/task/task_test.go`. Add `snaps` to the imports:

<!-- verify: internal/task/task_test.go at=snapshots -->
```go title="internal/task/task_test.go"
import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gkampitakis/go-snaps/snaps"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)
```

Then add a new test after `TestTask_String`. Its cases cover every form a task
line can take — default, done, with a due date, and both at once. First the
table:

<!-- verify: internal/task/task_test.go at=snapshots -->
```go title="internal/task/task_test.go"
func TestTask_String_Snapshots(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		task Task
	}{
		{
			name: "default task",
			task: Task{Title: "buy milk", Status: StatusTodo, Priority: PriorityDefault},
		},
		{
			name: "done task",
			task: Task{Title: "buy milk", Status: StatusDone, Priority: PriorityDefault},
		},
		{
			name: "task with a due date",
			task: Task{
				Title:    "buy milk",
				Status:   StatusTodo,
				Priority: PriorityDefault,
				Due:      time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
			},
		},
		{
			name: "done task with a due date",
			task: Task{
				Title:    "buy milk",
				Status:   StatusDone,
				Priority: PriorityDefault,
				Due:      time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
			},
		},
	}
```

The case names are not decoration: each one becomes the heading of an entry in
the snapshot file, so write them the way you want to read them later. The due
dates are fixed on purpose — `time.Date(2026, 10, 20, ...)` is one exact
moment, the same on every machine and every day. A clock in a fixture would
make the recorded line change on its own.

The loop closes the test and hands each rendered line to the tool:

<!-- verify: internal/task/task_test.go at=snapshots -->
```go title="internal/task/task_test.go"
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, tt.task.String())
		})
	}
}
```

Each subtest matches its own entry: the case name picks the block in the file,
and the tool compares the line `String()` returns against the line recorded
there.

`TestTask_String` stays exactly as it is. It pins the exact line inside the
test file, where you can read it without opening anything else, and the
snapshot adds the two forms it never covered. Two tests, two views of the same
fact — when the format moves, both will say so.

## Compare whole tasks in the store

One more change, in `internal/store/store_test.go`, and it is a different kind
of comparison. `TestMemoryStore_SortByDue` checks the order of a list, and
until now it compared titles only. But titles don't say everything: the store
also assigns IDs, and no test ever checked them. The `want` becomes full tasks,
IDs included. Add `go-cmp` to the imports:

<!-- verify: internal/store/store_test.go at=snapshots -->
```go title="internal/store/store_test.go"
import (
	"errors"
	"testing"
	"time"

	"github.com/google/go-cmp/cmp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)
```

Then change the `want` field and the two lists. The `...` lines stand for the
parts already in your file — the task lists, and the last case, which does not
change:

<!-- verify: internal/store/store_test.go at=snapshots -->
```go title="internal/store/store_test.go"
	tests := []struct {
		name  string
		tasks []task.Task
		want  []task.Task // full tasks in expected order, with assigned IDs
	}{
		{
			name: "zero due dates last",
			...
			want: []task.Task{
				{ID: 3, Title: "sooner", Due: day(5)},
				{ID: 2, Title: "later", Due: day(20)},
				{ID: 1, Title: "no due"},
				{ID: 4, Title: "also none"},
			},
		},
		{
			name: "ties keep insertion order",
			...
			want: []task.Task{
				{ID: 3, Title: "earlier", Due: day(1)},
				{ID: 1, Title: "first tie", Due: day(10)},
				{ID: 2, Title: "second tie", Due: day(10)},
				{ID: 4, Title: "third tie", Due: day(10)},
			},
		},
		...
	}
```

Read the IDs: `sooner` sorts first while carrying ID 3 — the ID `Add` assigned
when it entered the store, not a position in the sorted list. Pinning them says
what `SortByDue` is: a view over the tasks in the order they were added, which
never renumbers them.

The loop asserts with `cmp.Diff` now:

<!-- verify: internal/store/store_test.go at=snapshots -->
```go title="internal/store/store_test.go"
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			s := mustStore(t, tt.tasks...)

			got := s.SortByDue()
			if diff := cmp.Diff(tt.want, got); diff != "" {
				t.Errorf("SortByDue() mismatch (-want +got):\n%s", diff)
			}
		})
	}
```

`cmp.Diff` returns a string — empty when the two values match, and otherwise a
report of exactly what differs. It prints the element that moved and the field
that changed, with the fields around them as context, so a list failure points
at the difference instead of printing two long slices for you to compare. The
message keeps the `(-want +got)` fragment, so the `-` lines are the expected
value and the `+` lines are what the app produced.

## Record the snapshots

Both new snapshot tests expect entries that don't exist yet, and that is the
interesting part: the first run writes them. One housekeeping step first: the
tests now import both libraries, so bring the project's dependency files up to
date:

<!-- transcripts: authored -->
```bash
$ go mod tidy
```

`go mod tidy` is quiet when there is nothing to report — the libraries are
already required, so the command fills in the checksums the first build needs
and keeps both entries, because the tests import them. Now run the CLI test
and watch:

```bash
$ NO_COLOR=true go test -count=1 -v ./cmd/todo
=== RUN   TestRun
=== PAUSE TestRun
=== CONT  TestRun
=== RUN   TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list
=== PAUSE TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list
=== CONT  TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list
    main_test.go:28: ✎ Snapshot added
--- PASS: TestRun (0.00s)
    --- PASS: TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list (0.00s)
PASS
ok  	todo/cmd/todo	0.002s
```

Two details in that command. `-count=1` tells Go to really run the tests
instead of reusing an earlier result, and `NO_COLOR=true` turns off the tool's
colors so the output is plain text — you can leave that part out.

`✎ Snapshot added` is the tool saying it wrote the missing entry into
`cmd/todo/__snapshots__/main_test.snap`. The test passed, and the file now
holds what the app printed. On your machine, a snapshot test's first run always
passes: the thing to review is the new file, not a failure.

The task package behaves the same way. All four subtests report
`✎ Snapshot added`, and the run ends like this:

```bash
$ NO_COLOR=true go test -count=1 -v -run '^TestTask_String_Snapshots$' ./internal/task
...
--- PASS: TestTask_String_Snapshots (0.00s)
    --- PASS: TestTask_String_Snapshots/task_with_a_due_date (0.00s)
    --- PASS: TestTask_String_Snapshots/done_task (0.00s)
    --- PASS: TestTask_String_Snapshots/default_task (0.00s)
    --- PASS: TestTask_String_Snapshots/done_task_with_a_due_date (0.00s)
PASS
ok  	todo/internal/task	0.004s
```

The four subtests run in parallel, so the order they report in may differ from
the one above; the set of lines is the same. The `^` and `$` in `-run` pin the
name from start to end, so only exactly this test runs.

## Read what was recorded

The next step is the one the whole idea depends on: read the files. They are
short, and reading them is the review. First the CLI's:

<!-- verify: cmd/todo/__snapshots__/main_test.snap at=snapshots -->
```text title="cmd/todo/__snapshots__/main_test.snap"

[TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list - 1]
1. [Done] buy milk
2. [Todo] write the book

---
```

Three parts. The line in brackets is the entry's heading — the test's name with
spaces written as underscores, and a counter that starts at 1. The two lines
under it are the output exactly as the app printed it. And `---` marks the end
of the entry; the blank line before it is the listing's own trailing newline,
kept because `Raw` stores the text as it is.

The task file holds four entries, one per case:

<!-- verify: internal/task/__snapshots__/task_test.snap at=snapshots -->
```text title="internal/task/__snapshots__/task_test.snap"

[TestTask_String_Snapshots/default_task - 1]
[Todo] buy milk
---

[TestTask_String_Snapshots/task_with_a_due_date - 1]
[Todo] buy milk (due 2026-10-20)
---

[TestTask_String_Snapshots/done_task - 1]
[Done] buy milk
---

[TestTask_String_Snapshots/done_task_with_a_due_date - 1]
[Done] buy milk (due 2026-10-20)
---
```

Five entries in total, and every one of them is a line a person could see in
the terminal. That is the point of the format: the files should read like the
app's output, not like code. Nothing in them moves on its own — the due dates
are the fixed ones from the fixtures, and the listing has no clock in it at
all.

The entries in your task file may sit in a different order, because the
subtests run in parallel and the tool finds an entry by its heading. Read each
line and ask: is this what the app should print? If a line surprises you, the
fix belongs in the fixture, not in the file.

## Run it again

Now that the files exist, the same tests compare instead of record. Run the
whole suite:

```bash
$ NO_COLOR=true go test -count=1 ./...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.003s
ok  	todo/internal/task	0.003s
```

All three packages pass. From here on, every run compares the app's output
against the reviewed files, and a change to either one shows up as a diff.

## When the output really changes

Snapshots need updating eventually — a reworded message, a new column — and
the routine for that is worth doing once on purpose. Do it in a copy, so the
app keeps its reviewed files. From the app's root folder:

```bash
$ cp -r . ../todo-snapshot-demo
$ cd ../todo-snapshot-demo
```

In the copy, open `internal/task/task.go` and find this method:

<!-- verify: internal/task/task.go at=snapshots -->
```go title="internal/task/task.go"
// String returns a one-line summary of the task, such as
// "[Todo] buy milk" or "[Todo] buy milk (due 2026-10-20)".
func (t Task) String() string {
	if t.Due.IsZero() {
		return fmt.Sprintf("[%s] %s", t.Status, t.Title)
	}
	return fmt.Sprintf("[%s] %s (due %s)", t.Status, t.Title, t.Due.Format("2006-01-02"))
}
```

Change the two square brackets to parentheses: `[%s]` becomes `(%s)` in both
lines. That is a real change to the app's output, so the recorded files no
longer match. Run the task snapshots and read the failure — one diff per entry,
and the first looks like this:

```bash
$ NO_COLOR=true go test -count=1 -v -run '^TestTask_String_Snapshots$' ./internal/task
=== RUN   TestTask_String_Snapshots/default_task
=== PAUSE TestTask_String_Snapshots/default_task
=== CONT  TestTask_String_Snapshots/default_task
    task_test.go:149: 
        - Snapshot - 1
        + Received + 1
        
        - [Todo] buy milk
        + (Todo) buy milk
        
        at __snapshots__/task_test.snap:2
...
```

Read it the way the tool wrote it: the `-` lines are the recorded snapshot,
the `+` lines are what the app prints now, and the last line points at the
entry in the file. The change is exactly the one we made, so we accept it.
Accepting means telling the tool to rewrite the entries — a deliberate,
separate step. The `\` at the end of the first command continues it onto the
next line:

```bash
$ UPDATE_SNAPS=true NO_COLOR=true go test -count=1 -v \
    -run '^TestTask_String_Snapshots$' ./internal/task
$ UPDATE_SNAPS=true NO_COLOR=true go test -count=1 -v -run '^TestRun$' ./cmd/todo
```

`UPDATE_SNAPS=true` makes the next run rewrite the entries that failed. Each
subtest reports `✎ Snapshot updated`, and the task run ends like this:

```text
...
=== NAME  TestTask_String_Snapshots/done_task_with_a_due_date
    task_test.go:149: ✎ Snapshot updated
--- PASS: TestTask_String_Snapshots (0.00s)
    --- PASS: TestTask_String_Snapshots/default_task (0.00s)
    --- PASS: TestTask_String_Snapshots/task_with_a_due_date (0.00s)
    --- PASS: TestTask_String_Snapshots/done_task (0.00s)
    --- PASS: TestTask_String_Snapshots/done_task_with_a_due_date (0.00s)
PASS
ok  	todo/internal/task	0.002s
```

The CLI run prints the same `✎ Snapshot updated` line at its own call site and
passes. Now open the two `.snap` files and read them again. That is the second
half of the routine: the update rewrites, and a person confirms the rewritten
file is exactly the change that was meant, and nothing more.

:::tip
Keep the update scoped with `-run` to the tests you have read.
`UPDATE_SNAPS=true go test ./...` would rewrite every failing entry in every
package at once — including entries nobody read.
:::

The copy is not fully passing yet: `TestTask_String` still pins the old
brackets, and that failure is the next thing to look at. Delete the copy when
you're done — `cd ..` first, then remove the folder
(`rm -rf todo-snapshot-demo`).

## If something went wrong

**`ok (cached)` when you run the tests again.** The first run was real, but the
second one answered from a stored result instead of running anything:

```text
ok  	todo/cmd/todo	0.007s
ok  	todo/internal/store	0.008s
ok  	todo/internal/task	(cached)
```

The fix is `-count=1`, on the runs where "it passed" must mean "it ran": after
reading a snapshot, after an update, and whenever the output matters.

**A fixture that reads the clock.** If you typed `time.Now()` instead of the
fixed date in one of the snapshot cases, the recorded line and the rendered
line drift apart, and the failure looks like this:

```text
--- FAIL: TestTask_String_Snapshots (0.00s)
    --- FAIL: TestTask_String_Snapshots/task_with_a_due_date (0.00s)
        task_test.go:149: 
            - Snapshot - 1
            + Received + 1
            
            - [Todo] buy milk (due 2026-10-20)
            + [Todo] buy milk (due 2026-10-13)
            
            at __snapshots__/task_test.snap:6
…
```

No update can settle that argument: accept today's date and the entry flaps
tomorrow. The fix is to put the variability out of the string — a fixed
`time.Date(..., time.UTC)` value, the same on every machine.

**The snapshot and the inline test disagree.** After the update in the copy,
the suite still fails — the snapshot now expects parentheses while
`TestTask_String` still pins the brackets:

```text
ok  	todo/cmd/todo	0.007s
ok  	todo/internal/store	0.010s
--- FAIL: TestTask_String (0.00s)
    --- FAIL: TestTask_String/default_task (0.00s)
        task_test.go:105: 
            	Error Trace:	…/internal/task/task_test.go:105
            	Error:      	Not equal: 
            	            	expected: "[Todo] buy milk"
            	            	actual  : "(Todo) buy milk"
…
FAIL
FAIL	todo/internal/task	0.007s
FAIL
```

Two tests hold the same fact and only one was updated. Decide which text is
right, then make both agree — update the inline expectation too, or change the
code back and update nothing. Keeping both views of a fact is the feature, not
the bug.

**The tests won't build.** If the build stops on the `snaps` or `cmp` import —
or asks for a missing `go.sum` entry — the dependency files are out of date
with the tests. Run `go mod tidy`, then run the tests again.

<details>
<summary>Going deeper: what makes a snapshot trustworthy?</summary>

A snapshot is only as good as its last review. The tool records what the app
printed, which means a bug recorded today would pass tomorrow. The file is
trustworthy because a person read it once and agreed — and because the tool
never rewrites an entry unless asked. When a failure appears, the question is
not "how do I make it pass?" but "what changed, and was that change meant?"
If you cannot explain every changed line, the update is not ready.

</details>

<details>
<summary>Going deeper: how does the tool find an entry?</summary>

Each entry is headed by the test's name — the subtest path, with spaces written
as underscores — plus a counter that starts at 1 and rises if one test matches
more than once. The tool finds an entry by that heading, so the order of blocks
in the file is cosmetic: our four task entries can land in a different order on
different runs, and the file still matches. A line that is exactly `---` ends
an entry.

</details>

<details>
<summary>Going deeper: why does `Raw` matter?</summary>

By default `MatchSnapshot` stores a value in a Go-flavored form: a string would
be quoted and its newlines written as `\n`. That is right for structs and maps,
where the snapshot is a value. Our snapshots are user-facing text — a listing,
a rendered task line — so both call sites use `snaps.Raw()`, which stores the
string as it is. The file then reads like the output, which is what makes the
review possible.

</details>

The expected text lives in reviewed files now, and the routine for keeping them
honest is in your hands. Next, we measure how much of the app the suite
actually reaches — and throw a fuzzer at the code that reads text.
