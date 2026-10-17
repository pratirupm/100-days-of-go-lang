---
title: "Day 2 — Structs and methods"
sidebar:
  order: 2
chapter: 2
---

**About 2.5 hours** · Part I, day 2 of 4.

**You'll be able to:**

- give a task a status, a priority, and an optional due date — with a constructor that refuses a blank title;
- teach a type to describe itself in one line with `String()`.

---

Our task can hold a title and nothing else. Real work needs more: whether it's
still to do, how urgent it is, and when it's due. So the task grows three new
fields, and the app gets its first rule — a task with a blank title is not a
task.

We'll also teach the task to describe itself in one line: `[Todo] buy milk`,
or `[Todo] buy milk (due 2026-10-20)` when a deadline is set. That takes a
**method** — a function attached to a type, so it can be called on any task.

The habit stays the same: write the test first, watch it fail, then make it
pass. The test is bigger now, so it gets a new shape — a table of cases, all
in one test.

## What a task needs now

A **field** is a named value inside a struct — one of the pieces a task is
made of. The real task has four:

- `Title` — the text from the sticky note, with surrounding spaces trimmed
  off.
- `Status` — where the task stands. New tasks start in `"Todo"`.
- `Priority` — how urgent it is, from 1 (highest) to 5 (lowest). New tasks
  start at 3.
- `Due` — the deadline, which is optional.

One rule guards the front door: a title that is empty — or nothing but
spaces — is refused. The old `New` can't do that job; it takes a title and
builds a task, no questions asked. Its replacement, **`NewTask`**, is a
**constructor**: a function whose whole job is to build a value and check it
first. It trims the title, rejects a blank one with an **error** (a value
that says what went wrong), and fills in the defaults — `"Todo"`, 3, and no
due date.

The second new piece is a method named `String`. Go's printing tools look for
a method with exactly that name whenever they print a value, so a task shows
the tidy one-line summary instead of a jumble of fields.

## Write the new test

Open `task/task_test.go` and replace everything in it — the old single-case
test is gone. The new file has three parts, and we'll walk through them in
order.

First, the test and its table:

<!-- verify: task/task_test.go at=task-methods -->
```go title="task/task_test.go"
package task

import (
	"testing"
	"time"
)

func TestNewTask(t *testing.T) {
	cases := []struct {
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
		{
			name:      "title is trimmed",
			title:     "  buy milk  ",
			wantTitle: "buy milk",
		},
		{
			name:    "empty title is rejected",
			title:   "",
			wantErr: true,
		},
		{
			name:    "whitespace-only title is rejected",
			title:   " \t ",
			wantErr: true,
		},
	}
```

The file opens with `package task` and the imports — `testing` for the test
tools, `time` for the due date. Then `TestNewTask` declares a **table**:
`cases` is a slice (Go's ordered list), and each row is a small, nameless
struct holding one case. The columns are `name` (what the row is about),
`title` (the input), `wantTitle` (the title we expect back), and `wantErr`
(whether we expect an error).

Read the four rows as the four rules: a good title passes through; spaces
around it are trimmed off; an empty title is refused; a title of only
whitespace — that's the `\t`, a tab, in the last row — is refused too. The
`name` is never checked; it's there so a failure can say which row broke.

Below the table, leave a blank line, then the loop:

<!-- verify: task/task_test.go at=task-methods -->
```go title="task/task_test.go"
	for _, tc := range cases {
		got, err := NewTask(tc.title)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: NewTask(%q) error = nil, want error", tc.name, tc.title)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: NewTask(%q) error = %v, want nil", tc.name, tc.title, err)
			continue
		}
		if got.Title != tc.wantTitle {
			t.Errorf("%s: NewTask(%q).Title = %q, want %q", tc.name, tc.title, got.Title, tc.wantTitle)
		}
		if got.Status != "Todo" {
			t.Errorf("%s: NewTask(%q).Status = %q, want %q", tc.name, tc.title, got.Status, "Todo")
		}
		if got.Priority != 3 {
			t.Errorf("%s: NewTask(%q).Priority = %d, want %d", tc.name, tc.title, got.Priority, 3)
		}
		if !got.Due.IsZero() {
			t.Errorf("%s: NewTask(%q).Due = %v, want zero time", tc.name, tc.title, got.Due)
		}
	}
}
```

`for _, tc := range cases` walks the rows one at a time, with `tc` holding
the current one. `got, err := NewTask(tc.title)` calls the constructor and
catches both answers: the task and the error.

When a row expects an error, the loop checks that one arrived, then
`continue`s — jumps to the next row, since there's nothing else worth
checking. When a row doesn't expect an error but one shows up, the loop
reports it and moves on before touching `got`. Otherwise it checks the four
fields, one `if` per rule. Every message starts with `tc.name`, so any
failure names its row.

Leave another blank line, then the second test:

<!-- verify: task/task_test.go at=task-methods -->
```go title="task/task_test.go"
func TestTask_String(t *testing.T) {
	cases := []struct {
		name string
		task Task
		want string
	}{
		{
			name: "default task",
			task: Task{Title: "buy milk", Status: "Todo", Priority: 3},
			want: "[Todo] buy milk",
		},
		{
			name: "task with a due date",
			task: Task{
				Title:    "buy milk",
				Status:   "Todo",
				Priority: 3,
				Due:      time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC),
			},
			want: "[Todo] buy milk (due 2026-10-20)",
		},
	}

	for _, tc := range cases {
		if got := tc.task.String(); got != tc.want {
			t.Errorf("%s: String() = %q, want %q", tc.name, got, tc.want)
		}
	}
}
```

`TestTask_String` builds tasks by hand with `Task{...}` — a **struct
literal**, the same shape as before with more fields filled in. It skips
`NewTask` on purpose: this test is about the summary line, not the front-door
rules.

The first row has no due date. The second sets `Due` to a fixed date with
`time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)` — year, month, day, then
hour, minute, second, nanosecond, and the standard world clock. The loop is
small: call `String()` on the task and compare the result with `want`.

## Watch it fail

Run the tests from the app's root — the folder that holds `go.mod`:

```bash
$ go test ./...
# todo/task [todo/task.test]
task/task_test.go:38:15: undefined: NewTask
task/task_test.go:72:34: unknown field Status in struct literal of type Task
task/task_test.go:72:50: unknown field Priority in struct literal of type Task
task/task_test.go:79:5: unknown field Status in struct literal of type Task
task/task_test.go:80:5: unknown field Priority in struct literal of type Task
task/task_test.go:81:5: unknown field Due in struct literal of type Task
task/task_test.go:88:21: tc.task.String undefined (type Task has no field or method String)
FAIL	todo/task [build failed]
FAIL
```

A bigger wall of text than before, but it reads in groups, one per piece we
haven't built:

- `undefined: NewTask` — the constructor doesn't exist yet.
- Five `unknown field` lines — `Task` still has only a `Title`, and the test
  writes tasks with `Status`, `Priority`, and `Due`. Each missing field,
  listed once per line that mentions it.
- `no field or method String` — the method doesn't exist yet.

Every line points into the test we just wrote, at something the test demands.
`[build failed]` means the tests never ran — the package doesn't build yet.
We've said what the code should do; the code hasn't caught up.

## Build the task

Open `task/task.go` and replace everything in it. First, the imports and the
struct:

<!-- verify: task/task.go at=task-methods -->
```go title="task/task.go"
// Package task defines the todo domain type.
package task

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Task is a single todo item.
type Task struct {
	// Title is the short description of the work to do.
	Title string
	// Status is the workflow state of the task. Tasks built by NewTask
	// start in "Todo".
	Status string
	// Priority ranks the task from 1 (highest) to 5 (lowest). Tasks built
	// by NewTask start at 3.
	Priority int
	// Due is the deadline. The zero value means the task has no due date.
	Due time.Time
}
```

Four imports, one per job: `errors` builds the blank-title error, `fmt` builds
the summary line, `strings` trims the title, and `time` carries the due date.

The struct holds the four fields from our list, each with a comment stating
its contract — what a task built by `NewTask` gets. Go fills in a **zero
value** for any field nobody sets: `""` for text, `0` for numbers, an empty
date for `time.Time`. The comments say which of those `NewTask` replaces.

Next, the constructor:

<!-- verify: task/task.go at=task-methods -->
```go title="task/task.go"
// NewTask validates the title and returns a task with the default status,
// priority, and no due date. It returns an error if the title is empty after
// trimming surrounding whitespace.
func NewTask(title string) (Task, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Task{}, errors.New("title cannot be empty")
	}
	return Task{
		Title:    title,
		Status:   "Todo",
		Priority: 3,
	}, nil
}
```

`strings.TrimSpace` strips spaces and tabs from both ends, so the blank check
sees the cleaned title — that's why both `"  buy milk  "` and `" \t "` behave.
When the title is empty, the function returns an empty `Task{}` and an error
from `errors.New`. The empty task is only there to fill the slot; a caller
must check the error before using the task.

When the title is good, the function returns a task literal with the defaults
in plain sight: `"Todo"` and `3`. `Due` is left out, and left out means the
zero date — no due date. The signature `(Task, error)` is Go's shape for "a
value that might not exist".

## Teach the task to print itself

The last piece is the method:

<!-- verify: task/task.go at=task-methods -->
```go title="task/task.go"
// String returns a one-line summary of the task, such as
// "[Todo] buy milk" or "[Todo] buy milk (due 2026-10-20)".
func (t Task) String() string {
	if t.Due.IsZero() {
		return fmt.Sprintf("[%s] %s", t.Status, t.Title)
	}
	return fmt.Sprintf("[%s] %s (due %s)", t.Status, t.Title, t.Due.Format("2006-01-02"))
}
```

A method is a function with a **receiver** — the `(t Task)` between `func` and
the name. The receiver says which type the method belongs to and gives the
function a name for the value it was called on: `task.String()` runs this
code with `t` set to `task`.

The body returns one of two shapes. `t.Due.IsZero()` asks whether the due
date is still empty; if it is, the summary is `[status] title`. Otherwise the
summary adds `(due ...)`.

`fmt.Sprintf` builds a string from a **template**. `%s` is a placeholder that
gets replaced by the next value in line: `"[%s] %s"` with `Todo` and
`buy milk` becomes `[Todo] buy milk`. And `t.Due.Format("2006-01-02")` turns
the date into text — Go has no format codes, so you write the shape you want
using a reference date, 2 January 2006.

Run the tests:

```bash
$ go test ./...
ok  	todo/task	0.009s
```

`ok` again — both tests pass. The task type is complete: four fields with
their contracts, a builder that enforces the rule, and a method that
describes a task in one line.

## See the task as other code sees it

One more command is worth running from the app's root:

```bash
$ go doc ./task Task
package task // import "todo/task"

type Task struct {
	// Title is the short description of the work to do.
	Title string
	...
	// Due is the deadline. The zero value means the task has no due date.
	Due time.Time
}
    Task is a single todo item.

func NewTask(title string) (Task, error)
func (t Task) String() string
```

That's the task as the rest of the app sees it — the type, its documented
fields, and the two functions that work with it. Those comments are the only
documentation a caller gets, which is why they carry the contract.

The task now knows what it is and how to describe itself. The app still needs
somewhere to keep many of them — a list — and that comes next.

## If something went wrong

**`undefined: NewTask`.** You ran the tests before writing the constructor —
that's the expected failure, not a mistake.

```bash
$ go test ./...
# todo/task [todo/task.test]
task/task_test.go:38:15: undefined: NewTask
...
FAIL	todo/task [build failed]
FAIL
```

If you've written `NewTask` and the message stays, check three things: the
file is saved, it opens with `package task`, and the name is spelled
`NewTask` — capital N, capital T — not `New` or `newTask`.

**`unknown field ... in struct literal of type Task`.** The struct in
`task/task.go` is still the small one, with only a `Title`. The compiler
lists each field it can't find, once per line that mentions it — five lines,
one cause. Grow the struct to match the block above; capitalization and
spelling both count.

```bash
$ go test ./...
task/task_test.go:72:34: unknown field Status in struct literal of type Task
...
task/task_test.go:81:5: unknown field Due in struct literal of type Task
...
```

**`no field or method String`.** The method doesn't exist yet, or it wasn't
written as a method. A method has its receiver before the name —
`func (t Task) String() string`. If you wrote `func String(t Task) string`,
that's a plain function, not a method, and the message stays.

```bash
$ go test ./...
task/task_test.go:88:21: tc.task.String undefined (type Task has no field or method String)
...
```

**`undefined: New`.** The old test is still in place. Replace the whole test
file; when a builder is replaced, its test goes with it.

```bash
$ go test ./...
# todo/task [todo/task.test]
task/task_test.go:6:9: undefined: New
FAIL	todo/task [build failed]
FAIL
```

<details>
<summary>Going deeper: why the date is written 2006-01-02</summary>

In `time.Format`, the string you pass is not a pattern language — it's an
example. Go ships one reference moment, 2 January 2006 at 15:04:05, and reads
your layout by matching pieces of it: `2006` means a four-digit year, `01` a
two-digit month, `02` a two-digit day. So `"2006-01-02"` yields `2026-10-20`,
and `"Jan 2, 2006"` would yield `Oct 20, 2026`. Once you've seen the
reference date, every layout in every Go program reads the same way.

</details>

<details>
<summary>Going deeper: value receivers and pointer receivers</summary>

The `(t Task)` before `String` is a **value receiver**: the method gets its
own copy of the task. `String` only reads, so a copy costs nothing to worry
about — and it means both a task and a pointer to a task can call the method.
A method that needs to change the task will take a **pointer receiver**,
`(t *Task)`, which is Go's way of sharing one value instead of copying it.
The rule of thumb: read, value receiver; write, pointer receiver.

</details>

<details>
<summary>Going deeper: what String() plugs into</summary>

Go's `fmt` package — the standard printing toolkit — checks every value for a
method named `String` and uses it when one exists, for `%v`, `%s`, and plain
`Println`. The name isn't our invention; it's the convention `fmt` looks for,
and the toolkit calls it the `Stringer` interface. We'll build interfaces of
our own later in the book, and this method will slot right in.

</details>

<div class="day-tracker" data-day="2"></div>
