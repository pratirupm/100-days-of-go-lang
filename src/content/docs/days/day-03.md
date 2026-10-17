---
title: "Day 3 — A list of tasks"
description: "Give tasks an ID and labels, then build a store that adds, lists, filters, counts, and sorts them in memory."
sidebar:
  order: 3
chapter: 3
---

**About 3 hours** · Part I, day 3 of 4.

**You'll be able to:**

- keep tasks in an in-memory store that adds, lists, filters, counts, and sorts;
- read and write slices and maps, and hide a store’s internals behind methods.

---

A task is now a complete thing — a title, a status, a priority, a due
date — but it still lives alone. A todo list is many tasks, and each needs
a name of its own.

Today we build the place they live: a **store**, a small part of the app
whose only job is to keep tasks in memory. It hands each new task a number
and answers a list's questions — what do I hold, what's still to do,
which labels keep showing up, what's due first.

Memory means the list lives only as long as the program runs. That's enough
for now; a real database arrives later in the book. And as always, the
store starts as a test.

## The store's job

Five behaviors, one per question:

- `Add` takes a task, gives it the next number — starting at 1 — and
  hands it back, so the caller learns the number.
- `List` returns everything, in the order it was added.
- `ByStatus` returns only the tasks carrying a given status.
- `CountByTag` counts, for every label, how many tasks carry it.
- `SortByDue` orders tasks by due date, soonest first, undated last.

Those five sentences are the contract; the test file we're about to write
turns each into a rule.

## Write the test first

Create a folder called `store`, beside `task`:

```bash
$ mkdir store
```

Then create a file inside it called `store_test.go`. It opens with the
package name and three imports:

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
package store

import (
	"testing"
	"time"

	"todo/task"
)
```

`package store`, not `store_test`: the test file belongs to the package it
tests, so it can reach `NewMemoryStore` with no import. `todo/task` is the
first import of our own code — the module name, a slash, the folder name.
`time` builds the due dates one test needs.

The first test is about identity:

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
func TestMemoryStore_AddAndList(t *testing.T) {
	s := NewMemoryStore()

	cases := []struct {
		name   string
		title  string
		wantID int
	}{
		{name: "first add gets ID 1", title: "write tests", wantID: 1},
		{name: "second add gets ID 2", title: "make them pass", wantID: 2},
		{name: "third add gets ID 3", title: "refactor", wantID: 3},
	}

	for _, tc := range cases {
		got := s.Add(task.Task{Title: tc.title, Status: "Todo"})
		if got.ID != tc.wantID {
			t.Errorf("%s: Add(%q).ID = %d, want %d", tc.name, tc.title, got.ID, tc.wantID)
		}
		if got.Title != tc.title {
			t.Errorf("%s: Add(%q).Title = %q, want %q", tc.name, tc.title, got.Title, tc.title)
		}
	}
```

Three tasks go in; `Add` must hand back IDs 1, 2, and 3, each keeping its
title.

The file continues with the `List` checks:

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
	wantTitles := []string{"write tests", "make them pass", "refactor"}
	list := s.List()
	if len(list) != len(wantTitles) {
		t.Fatalf("List() length = %d, want %d", len(list), len(wantTitles))
	}
	for i, want := range wantTitles {
		if list[i].Title != want {
			t.Errorf("List()[%d].Title = %q, want %q", i, list[i].Title, want)
		}
		if list[i].ID != i+1 {
			t.Errorf("List()[%d].ID = %d, want %d", i, list[i].ID, i+1)
		}
	}

	// The returned slice is a copy: reordering and overwriting it must not
	// reach the store's own slice.
	list[0], list[2] = list[2], list[0]
	list[0] = task.Task{Title: "mutated"}
	fresh := s.List()
	if len(fresh) != len(wantTitles) {
		t.Fatalf("List() after mutating the previous result: length = %d, want %d", len(fresh), len(wantTitles))
	}
	for i, want := range wantTitles {
		if fresh[i].Title != want {
			t.Errorf("List() after mutating the previous result: [%d].Title = %q, want %q", i, fresh[i].Title, want)
		}
	}
}
```

Same tasks, same order, same IDs. `t.Fatalf` stops the test on a wrong
length instead of crashing later.

The last paragraph gives this chapter its teeth: the test takes the list
`List` handed back, swaps two elements, overwrites one, and asks the store
again. The store must be unchanged — `List` promises a copy.

The second test covers `ByStatus`:

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
func TestMemoryStore_ByStatus(t *testing.T) {
	s := NewMemoryStore()
	added := []task.Task{
		{Title: "write tests", Status: "Todo"},
		{Title: "review code", Status: "Done"},
		{Title: "ship it", Status: "Todo"},
		{Title: "archive", Status: "Done"},
		{Title: "read spec", Status: "Blocked"},
	}
	for i, tt := range added {
		if got := s.Add(tt); got.ID != i+1 {
			t.Errorf("Add(%q).ID = %d, want %d", tt.Title, got.ID, i+1)
		}
	}
```

Five tasks across three statuses.

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
	cases := []struct {
		name       string
		status     string
		wantTitles []string
	}{
		{
			name:       "matching status keeps insertion order",
			status:     "Todo",
			wantTitles: []string{"write tests", "ship it"},
		},
		{
			name:       "done tasks",
			status:     "Done",
			wantTitles: []string{"review code", "archive"},
		},
		{
			name:       "single match",
			status:     "Blocked",
			wantTitles: []string{"read spec"},
		},
		{
			name:       "unknown status returns nothing",
			status:     "Cancelled",
			wantTitles: nil,
		},
	}
```

The table spells out what each status must return: `Todo` keeps insertion
order, `Done` gets its two, `Blocked` its one, and a status nothing carries
returns nothing. `nil` means "no titles at all".

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
	for _, tc := range cases {
		got := s.ByStatus(tc.status)
		if len(got) != len(tc.wantTitles) {
			t.Errorf("%s: ByStatus(%q) length = %d, want %d", tc.name, tc.status, len(got), len(tc.wantTitles))
			continue
		}
		for i, want := range tc.wantTitles {
			if got[i].Title != want {
				t.Errorf("%s: ByStatus(%q)[%d].Title = %q, want %q", tc.name, tc.status, i, got[i].Title, want)
			}
		}
	}
}
```

The third test pins the label count:

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
func TestMemoryStore_CountByTag(t *testing.T) {
	cases := []struct {
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
```

One task carries the same label twice on purpose: a task counts at most
once per label. The first `want` map is the whole answer for a mixed set —
`go` on three, `testing` on two, `review` on two. `map[string]int` is a
**map**, Go's word for a lookup table from strings to whole numbers.

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
	for _, tc := range cases {
		s := NewMemoryStore()
		for _, tt := range tc.tasks {
			s.Add(tt)
		}

		got := s.CountByTag()
		if len(got) != len(tc.want) {
			t.Errorf("%s: CountByTag() length = %d, want %d (got %v)", tc.name, len(got), len(tc.want), got)
		}
		for tag, wantCount := range tc.want {
			if got[tag] != wantCount {
				t.Errorf("%s: CountByTag()[%q] = %d, want %d", tc.name, tag, got[tag], wantCount)
			}
		}
		for tag, count := range got {
			if _, ok := tc.want[tag]; !ok {
				t.Errorf("%s: CountByTag() has unexpected tag %q = %d", tc.name, tag, count)
			}
		}
	}
}
```

The loop at the end checks the other direction: any label the table doesn't
know fails the test, so a stray label can't slip past a passing run.

The fourth test covers the due-date sort:

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
func TestMemoryStore_SortByDue(t *testing.T) {
	day := func(d int) time.Time {
		return time.Date(2026, 11, d, 0, 0, 0, 0, time.UTC)
	}

	cases := []struct {
		name  string
		tasks []task.Task
		want  []string // titles in expected order
	}{
		{
			name: "zero due dates last",
			tasks: []task.Task{
				{Title: "no due"},
				{Title: "later", Due: day(20)},
				{Title: "sooner", Due: day(5)},
				{Title: "also none"},
			},
			want: []string{"sooner", "later", "no due", "also none"},
		},
```

`day` builds a date in November 2026. The first case adds undated tasks
before and after dated ones, and requires the dated ones first — soonest
first, undated last.

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
		{
			name: "ties keep insertion order",
			tasks: []task.Task{
				{Title: "first tie", Due: day(10)},
				{Title: "second tie", Due: day(10)},
				{Title: "earlier", Due: day(1)},
				{Title: "third tie", Due: day(10)},
			},
			want: []string{"earlier", "first tie", "second tie", "third tie"},
		},
		{
			name:  "empty store",
			tasks: nil,
			want:  nil,
		},
	}
```

The second case is about ties: three tasks share day 10, and they must come
back in the order they were added. That promise is a **stable sort**, and it
decides which sorting tool the implementation reaches for.

<!-- verify: store/store_test.go at=in-memory-list -->
```go title="store/store_test.go"
	for _, tc := range cases {
		s := NewMemoryStore()
		for _, tt := range tc.tasks {
			s.Add(tt)
		}

		got := s.SortByDue()
		if len(got) != len(tc.want) {
			t.Errorf("%s: SortByDue() length = %d, want %d", tc.name, len(got), len(tc.want))
			continue
		}
		for i, want := range tc.want {
			if got[i].Title != want {
				t.Errorf("%s: SortByDue()[%d].Title = %q, want %q", tc.name, i, got[i].Title, want)
			}
		}
	}
}
```

That's the contract: five behaviors, four tests, one file. Type it
exactly — the failure below is what this file produces, line for line.

## Watch it fail

Run the tests:

```bash
$ go test ./...
# todo/store [todo/store.test]
store/store_test.go:11:7: undefined: NewMemoryStore
store/store_test.go:63:7: undefined: NewMemoryStore
store/store_test.go:127:28: unknown field Tags in struct literal of type task.Task
store/store_test.go:128:28: unknown field Tags in struct literal of type task.Task
store/store_test.go:129:26: unknown field Tags in struct literal of type task.Task
store/store_test.go:131:24: unknown field Tags in struct literal of type task.Task
store/store_test.go:148:8: undefined: NewMemoryStore
store/store_test.go:208:8: undefined: NewMemoryStore
FAIL	todo/store [build failed]
ok  	todo/task	(cached)
FAIL
```

Read the complaints in order. `undefined: NewMemoryStore` appears at four
call sites: the function doesn't exist yet. `unknown field` appears at four
struct literals: the field doesn't exist yet. Notice what is *not* reported
— nothing about `s.Add`, `got.ID`, or `list[i].ID`. Once `s` has no valid
type, the compiler — the program that reads your code first — can't check
anything that flows from it, so the report names the first missing piece.

`[build failed]` means the test binary never ran, so no check executed: the
failure proves the tests mention the right API, not that it behaves.
And `ok todo/task (cached)` is the task package, untouched by this change.

## Give tasks an ID and labels

Now the code. Open `task/task.go` and find the `Task` struct:

<!-- verify: task/task.go at=in-memory-list -->
```go title="task/task.go"
// Task is a single todo item.
type Task struct {
	// ID is the task's identifier. It is zero until a store assigns one.
	ID int
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
	// Tags is the set of labels attached to the task. Tasks built by
	// NewTask start with no tags.
	Tags []string
}
```

Two fields are new. `ID` sits at the top: a whole number that stays 0 until
a store assigns one — the field's comment says exactly that. The field at
the bottom is a list of labels: `[]string` means "a list of strings" — the
brackets say "list", the word inside says what it holds. In code, a label is
called a `tag` — the field is `Tags`, and the store's counting method is
`CountByTag`.

In Go, a list like this is called a **slice**. A new task starts with no
labels, and its slice is `nil` — Go's word for "nothing yet". A nil slice
has length zero and can grow.

Nothing else changes. `NewTask` doesn't touch either field, and the
existing tests don't mention them. Growing a struct must not break the
promises it already made.

## Build the store

Create `store/store.go`. It opens with a package comment and the imports:

<!-- verify: store/store.go at=in-memory-list -->
```go title="store/store.go"
// Package store keeps tasks in memory.
package store

import (
	"cmp"
	"slices"
	"time"

	"todo/task"
)
```

Three tools from the standard library — `slices` for the list helpers,
`cmp` for comparisons, `time` for dates — and `todo/task`, the import path
the test file already used. Standard library first, a blank line, then our
own code; that's the order `gofmt` keeps.

The store's state is two fields:

<!-- verify: store/store.go at=in-memory-list -->
```go title="store/store.go"
// MemoryStore is an in-memory task list. The zero value is not usable; build
// one with NewMemoryStore.
type MemoryStore struct {
	tasks  []task.Task
	nextID int
}

// NewMemoryStore returns an empty store. The first task added gets ID 1.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{}
}
```

The store's whole world is the task list and the next number to hand out.
Both are lowercase, which keeps them private to the package — the store
defends one rule: the counter and the list move together. `NewMemoryStore`
returns a **pointer** (`*MemoryStore`), a value that points at the one
store, so every call changes that store rather than a copy.

<!-- verify: store/store.go at=in-memory-list -->
```go title="store/store.go"
// Add assigns the next ID (starting at 1) to the task, stores a copy, and
// returns the stored task.
func (s *MemoryStore) Add(t task.Task) task.Task {
	s.nextID++
	t.ID = s.nextID
	s.tasks = append(s.tasks, t)
	return t
}
```

`Add` is the identity desk: bump the counter, stamp the task, store it,
return it. The parameter is a value, so `t` is already the store's own copy
before `t.ID` is set.

<!-- verify: store/store.go at=in-memory-list -->
```go title="store/store.go"
// List returns the tasks in insertion order. The returned slice is a copy:
// callers cannot reorder or replace the store's slice by mutating it.
func (s *MemoryStore) List() []task.Task {
	return slices.Clone(s.tasks)
}
```

`List` is where the copy boundary gets its name. `slices.Clone` returns a
fresh list holding the same tasks. A caller may reverse, sort, or overwrite
it; the store's order doesn't move.

<!-- verify: store/store.go at=in-memory-list -->
```go title="store/store.go"
// ByStatus returns the tasks whose Status equals status, in insertion order.
func (s *MemoryStore) ByStatus(status string) []task.Task {
	var matches []task.Task
	for _, t := range s.tasks {
		if t.Status == status {
			matches = append(matches, t)
		}
	}
	return matches
}
```

`ByStatus` walks the tasks in order and keeps the ones whose status
matches. The matches start as a nil slice and grow with `append`; when
nothing matches, the caller gets nil back — which reads as "nothing".

<!-- verify: store/store.go at=in-memory-list -->
```go title="store/store.go"
// CountByTag returns, for every distinct tag on every task, how many tasks
// carry it. A task counts at most once per tag; tasks with no tags contribute
// nothing.
func (s *MemoryStore) CountByTag() map[string]int {
	counts := make(map[string]int)
	for _, t := range s.tasks {
		seen := make(map[string]bool, len(t.Tags))
		for _, tag := range t.Tags {
			if seen[tag] {
				continue
			}
			seen[tag] = true
			counts[tag]++
		}
	}
	return counts
}
```

Three moving parts. `make` gives a map callers can write to even when no
task carries labels. `seen`, rebuilt per task, enforces "at most once per
task per label" however often the list repeats one. And the increment is
the counting idiom: a missing key reads as 0, the increment makes it 1, and
the key exists from then on.

<!-- verify: store/store.go at=in-memory-list -->
```go title="store/store.go"
// SortByDue returns all tasks sorted by Due ascending, with tasks that have
// no due date (zero time) last. Equal due dates keep insertion order.
func (s *MemoryStore) SortByDue() []task.Task {
	sorted := slices.Clone(s.tasks)
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
	return sorted
}
```

Clone first, because sorting rewrites the list it is given. `zeroRank`
folds "has no due date" into a number, so undated tasks sort last. When the
ranks tie, the dates decide; when the dates tie too, `SortStableFunc`
leaves the tasks in the order they were added — what the `first tie`,
`second tie`, `third tie` check was watching.

## Run it again

```bash
$ go test ./...
ok  	todo/store	0.002s
ok  	todo/task	0.002s
```

Both packages pass. The store's `0.002s` is a real run; run it again
unchanged and Go answers `(cached)`.

The store now holds tasks with IDs, filters by status, counts labels, and
sorts by due date — and four tests hold it in place.

## If something went wrong

**The store changed when it shouldn't.** You'll see this:

```text
--- FAIL: TestMemoryStore_AddAndList (0.00s)
    store_test.go:57: List() after mutating the previous result: [0].Title = "mutated", want "write tests"
    store_test.go:57: List() after mutating the previous result: [2].Title = "write tests", want "refactor"
FAIL
FAIL	todo/store	0.002s
FAIL
```

The cause: `List` returns the store's own slice — the `slices.Clone` call
is missing, or it was replaced with `return s.tasks`. The list the test
mutated *is* the store's list, so the swap and the overwrite both landed in
the store. The fix: `return slices.Clone(s.tasks)`.

**Every count is 1.** The test says:

```text
--- FAIL: TestMemoryStore_CountByTag (0.00s)
    store_test.go:159: overlapping, repeated, and missing tags: CountByTag()["go"] = 1, want 3
    store_test.go:159: overlapping, repeated, and missing tags: CountByTag()["testing"] = 1, want 2
    store_test.go:159: overlapping, repeated, and missing tags: CountByTag()["review"] = 1, want 2
FAIL
FAIL	todo/store	0.001s
FAIL
```

The three lines come from a loop over a map, so their order varies between
runs — the counts are what matter.

The cause: the line assigns `1` instead of incrementing, so `go` can be
seen three times and stay at 1. The fix: increment with `++` — a missing
key reads as 0, so the increment both starts and counts.

**Every `Add` returns ID 1.** The output:

```text
--- FAIL: TestMemoryStore_AddAndList (0.00s)
    store_test.go:26: second add gets ID 2: Add("make them pass").ID = 1, want 2
    store_test.go:26: third add gets ID 3: Add("refactor").ID = 1, want 3
    store_test.go:36: List() length = 0, want 3
--- FAIL: TestMemoryStore_ByStatus (0.00s)
    store_test.go:73: Add("review code").ID = 1, want 2
...
FAIL
FAIL	todo/store	0.002s
FAIL
```

The cause: `func (s MemoryStore) Add(...)` — a value receiver. Every call
gets its own copy of the store, so `nextID++` and the `append` land in a
store nobody keeps. The tells: every `Add` says ID 1, and `List` is empty
after three adds. The fix: the pointer receiver,
`func (s *MemoryStore) Add(...)` — a method that changes its receiver takes
the pointer.

<details>
<summary>Going deeper: a slice is a view, not a container</summary>

A slice value is a small window onto a list stored somewhere else. Copy the
slice and you copy the window, not the list: two windows onto one list see
each other's writes.

If the window has room to spare, `append` writes into the list it already
sees; if not, it builds a new list and returns a window onto the copy. Both
outcomes are legal, so keep every `append` result — as in
`s.tasks = append(s.tasks, t)`. A bare `append(...)` throws the new window
away, and the task with it.

Here is the trap at its smallest:

```go
a := []int{1, 2, 3}
b := append(a[:2], 99)
fmt.Println(a, b) // [1 2 99] [1 2 99]
```

`a[:2]` had room to spare, so `99` landed in `a`'s third slot, and `a`
changed even though nobody assigned to it.

One wrinkle: the copy is shallow. `slices.Clone` copies the tasks, but each
task's label list is shared with the stored one, so a determined caller can
still reach the store through it. Treat labels as read-only once a task is
stored.

</details>

<details>
<summary>Going deeper: maps count by reading zero</summary>

Reading a key that isn't in a map gives you the value type's zero — `0` for
a `map[string]int`. That's what makes the increment work: read 0, add 1,
and the key exists from then on. Reach for the two-result form only when
"missing" and "zero" must be told apart.

`make` first: a nil map rejects writes. And never build logic on the order
a map hands its keys back — Go randomizes it.

</details>

<details>
<summary>Going deeper: why the sort must be stable</summary>

`SortStableFunc` guarantees that elements the comparison calls equal keep
their original relative order; plain `SortFunc` may shuffle them. For due
dates that matters: three tasks due the same day must stay in the order
they were added.

The `zeroRank` helper exists because of a typing rule. The obvious
comparison — `t.IsZero()` against `t.IsZero()` — doesn't compile: Go's
generic comparison helpers accept numbers and strings, but not `true` and
`false`. `zeroRank` turns the yes-or-no into 0 or 1, which compares fine.

</details>

Next, the store learns to fail — and to hand failures back as values you
can inspect.

<div class="day-tracker" data-day="3"></div>
