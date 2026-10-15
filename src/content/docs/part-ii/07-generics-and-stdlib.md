---
title: Generics
description: Write one small helper that works for any element type, then let the standard library's generic tools do the rest.
sidebar:
  order: 7
---

The store can already answer "which tasks are `Todo`?". It answers with a
small walk: start with nothing, look at each task in order, keep the ones
whose status matches. Now the app wants two more questions answered: which
tasks carry a given label, and which labels exist anywhere in the store.

The tempting move is to copy the walk and change one line. But a copied walk
has two homes, and the next change to it lands in one of them. Go has a
better offer: leave the element type as a placeholder for each caller to
fill in. Code written that way is called **generic**, and the placeholder is
a **type parameter**.

The standard library has been shipping generic functions all along —
`slices.Clone` and `slices.SortStableFunc` took any element type, with Go
choosing the type at every call. Today we write a type parameter of our own
and meet two more of the library's generic tools.

## The walk we're about to write twice

`ByStatus` lives in `internal/store/store.go`, and its body is five lines: a
nil slice, a loop over the store's tasks, an `if` that keeps the matching
task, and a return. `ByTag` wants the same five lines with one decision
changed: keep the task when its label list contains the one we asked for.

That's the moment a walk earns a name. The loop is identical; only the
yes-or-no decision differs. A function whose answer is just true or false is
called a **predicate**. If each query carries its own copy of the walk,
every future change has to be made twice — and the second copy is the one
that gets forgotten.

So we build one function that owns the walk and asks its caller for the
predicate. The tests come first, as always.

## Write the tests first

Three tests go into `internal/store/store_test.go`, added after
`TestMemoryStore_ByStatus` and before `TestMemoryStore_CountByTag`. They
describe the two queries and the shared helper before any of the three
exists.

First, the label query — the setup and the table:

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
func TestMemoryStore_ByTag(t *testing.T) {
	s := NewMemoryStore()
	added := []task.Task{
		{Title: "write tests", Tags: []string{"go", "testing"}},
		{Title: "review code", Tags: []string{"go", "review"}},
		{Title: "ship it", Tags: []string{"testing"}},
		{Title: "archive"},
	}
	for i, tt := range added {
		if got := s.Add(tt); got.ID != i+1 {
			t.Errorf("Add(%q).ID = %d, want %d", tt.Title, got.ID, i+1)
		}
	}

	cases := []struct {
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
```

Four tasks go in: two carry the label `go`, one carries `review`, and one
carries nothing. The table asks three questions: a shared label keeps
insertion order, a single match returns one, and an unknown label returns
nil.

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
	for _, tc := range cases {
		got := s.ByTag(tc.tag)
		if len(got) != len(tc.wantTitles) {
			t.Errorf("%s: ByTag(%q) length = %d, want %d", tc.name, tc.tag, len(got), len(tc.wantTitles))
			continue
		}
		for i, want := range tc.wantTitles {
			if got[i].Title != want {
				t.Errorf("%s: ByTag(%q)[%d].Title = %q, want %q", tc.name, tc.tag, i, got[i].Title, want)
			}
		}
		if tc.wantTitles == nil && got != nil {
			t.Errorf("%s: ByTag(%q) = %v, want nil", tc.name, tc.tag, got)
		}
	}
}
```

The loop checks lengths before elements, so a short answer fails cleanly
instead of crashing. The last check is the new one:
`tc.wantTitles == nil && got != nil` fails when a no-match answer is an
empty list instead of nil. A length check alone can't tell the two apart, so
the test says the word nil.

## The test for listing labels

The second query lists every distinct label in the store, sorted. Its table:

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
func TestMemoryStore_Tags(t *testing.T) {
	cases := []struct {
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
```

The first case seeds four tasks, and the answer is `[go review testing]` —
alphabetical, not the order the labels appeared. `go` shows up twice on one
task and once on another and still contributes one entry. The other two
cases are the nil rule again: no labels, and an empty store.

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
	for _, tc := range cases {
		s := NewMemoryStore()
		for _, tt := range tc.tasks {
			s.Add(tt)
		}

		got := s.Tags()
		if len(got) != len(tc.want) {
			t.Errorf("%s: Tags() length = %d, want %d (got %v)", tc.name, len(got), len(tc.want), got)
			continue
		}
		for i, want := range tc.want {
			if got[i] != want {
				t.Errorf("%s: Tags()[%d] = %q, want %q", tc.name, i, got[i], want)
			}
		}
		if tc.want == nil && got != nil {
			t.Errorf("%s: Tags() = %v, want nil", tc.name, got)
		}
	}
}
```

Each case builds its own store, adds the tasks, and asks; the loop keeps the
same shape, nil check included.

## A test for the walk itself

The walk gets a test of its own, because the other two will share it. The
first subtest uses plain numbers — the smallest element type there is:

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
func TestFilter(t *testing.T) {
	t.Run("ints", func(t *testing.T) {
		even := func(n int) bool { return n%2 == 0 }
		cases := []struct {
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
```

The table covers the three shapes a walk must get right: keep some, keep
all, and keep none. `even` is a predicate named once and reused by two rows.

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
		for _, tc := range cases {
			got := filter(tc.xs, tc.keep)
			if len(got) != len(tc.want) {
				t.Errorf("%s: filter(...) length = %d, want %d", tc.name, len(got), len(tc.want))
				continue
			}
			for i, want := range tc.want {
				if got[i] != want {
					t.Errorf("%s: filter(...)[%d] = %d, want %d", tc.name, i, got[i], want)
				}
			}
			if tc.want == nil && got != nil {
				t.Errorf("%s: filter(...) = %v, want nil", tc.name, got)
			}
		}
	})
```

Look at the call: `filter(tc.xs, tc.keep)`. It names no types at all — Go
figures out the element type from `tc.xs`. The last row starts from nil, and
the loop checks the nil promise by name.

The second subtest repeats the shapes with the app's real element type:

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
	t.Run("task.Task", func(t *testing.T) {
		tasks := []task.Task{
			{Title: "write tests", Status: "Todo"},
			{Title: "review code", Status: "Done"},
			{Title: "ship it", Status: "Todo"},
		}
		cases := []struct {
			name string
			keep func(task.Task) bool
			want []string
		}{
			{
				name: "keeps tasks by status",
				keep: func(tt task.Task) bool { return tt.Status == "Todo" },
				want: []string{"write tests", "ship it"},
			},
			{
				name: "all false returns nil",
				keep: func(tt task.Task) bool { return tt.Status == "Cancelled" },
				want: nil,
			},
		}
```

The table asks the same shapes with tasks, and the answers are titles.

<!-- verify: internal/store/store_test.go at=generics -->
```go title="internal/store/store_test.go"
		for _, tc := range cases {
			got := filter(tasks, tc.keep)
			if len(got) != len(tc.want) {
				t.Errorf("%s: filter(...) length = %d, want %d", tc.name, len(got), len(tc.want))
				continue
			}
			for i, want := range tc.want {
				if got[i].Title != want {
					t.Errorf("%s: filter(...)[%d].Title = %q, want %q", tc.name, i, got[i].Title, want)
				}
			}
			if tc.want == nil && got != nil {
				t.Errorf("%s: filter(...) = %v, want nil", tc.name, got)
			}
		}
	})
}
```

Two subtests, two element types: that's the point of testing a type
parameter — one body, held against two types. The call
`filter(tasks, tc.keep)` infers `task.Task` from the slice, and the
predicate comes typed from the table.

## Watch it fail

Run the tests from the app's root — the folder that holds `go.mod`:

```bash
$ go test ./...
ok  	todo/cmd/todo	(cached)
# todo/internal/store [todo/internal/store.test]
internal/store/store_test.go:157:12: s.ByTag undefined (type *MemoryStore has no field or method ByTag)
internal/store/store_test.go:207:12: s.Tags undefined (type *MemoryStore has no field or method Tags)
internal/store/store_test.go:253:11: undefined: filter
internal/store/store_test.go:293:11: undefined: filter
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	(cached)
FAIL
```

Read the complaints in pairs. The two method calls on the store are reported
as "has no field or method". `filter` is a plain name, reported as
`undefined` — the test calls the helper directly, so the helper is part of
what this chapter must build. `[build failed]` means no assertion ran: the
test binary never existed. The `ok` lines are packages this change didn't
touch.

The line numbers assume the tests landed where we placed them; the names
matter.

## A function that works for any element type

Now the walk. In `internal/store/store.go`, above `ByStatus`, add:

<!-- verify: internal/store/store.go at=generics -->
```go title="internal/store/store.go"
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
```

The first line is the new idea, so read it twice.

- `filter` starts lowercase, so the name is private to the package. It's our
  walk, not part of what the package promises other code.
- `[T any]` is the placeholder. `T` is a **type parameter** — a name that
  stands for some type — and `any` is its **constraint**, the rule about
  which types may stand in. `any` means all of them.
- `xs []T` reads "a list of T". `keep func(T) bool` reads "a function that
  takes one T and answers true or false". The `[]T` at the end is the
  answer: a list of the same element type.

Inside the body, `T` behaves like a type: `matches` is a list of T, `x` is
one T, and `keep(x)` is a true-or-false answer. The body never compares or
orders elements — the caller's predicate decides everything — and that's
why `any` is enough. The walk starts from a nil list, so "nothing matched"
keeps the answer the store has always given: nil.

At a call site, you write no types at all. `filter(s.tasks, ...)` hands Go a
list of tasks, so Go sets `T` to `task.Task` by itself. That's **type
inference**, and it's why a generic call reads like an ordinary one.

## Two queries, one walk

`ByStatus` moves onto the helper — its five-line loop disappears — and
`ByTag` arrives as a second caller:

<!-- verify: internal/store/store.go at=generics -->
```go title="internal/store/store.go"
// ByStatus returns the tasks whose Status equals status, in insertion order.
func (s *MemoryStore) ByStatus(status string) []task.Task {
	return filter(s.tasks, func(t task.Task) bool { return t.Status == status })
}

// ByTag returns the tasks carrying the given tag, in insertion order.
func (s *MemoryStore) ByTag(tag string) []task.Task {
	return filter(s.tasks, func(t task.Task) bool { return slices.Contains(t.Tags, tag) })
}
```

`ByStatus` is now one line: the walk lives in `filter`, and the predicate —
`t.Status == status` — stays with the question it answers. The deleted loop
is the point; the behavior is identical.

`ByTag` hands over a different predicate: does this task's label list
contain the label? `slices.Contains` answers that, and it's a generic
function itself — Go infers `string` from the label list. Both queries
inherit insertion order and the nil answer from the shared walk.

## Every label, one expression

The third query needs no walk at all:

<!-- verify: internal/store/store.go at=generics -->
```go title="internal/store/store.go"
// Tags returns every distinct tag across all tasks, sorted.
func (s *MemoryStore) Tags() []string {
	return slices.Sorted(maps.Keys(s.CountByTag()))
}
```

Read it inside out. `s.CountByTag()` returns a map — a lookup table whose
keys are exactly the distinct labels. `maps.Keys` hands over just the keys
as a **sequence**: a value that gives up its elements one at a time. Go
calls it an **iterator**. `slices.Sorted` collects the sequence into a list
and sorts it.

Why not hand the keys back directly? Because `maps.Keys` doesn't return a
list at all — it returns the sequence, and turning a sequence into a
container is a separate decision. `slices.Collect` gives an unsorted list;
`slices.Sorted` gives a sorted one. We need sorted, because map order is
random and a method can't return randomness as an answer. And nil falls out
for free: an empty sequence collects into a nil list.

One import joins the file:

<!-- verify: internal/store/store.go at=generics -->
```go title="internal/store/store.go"
import (
	"cmp"
	"errors"
	"fmt"
	"maps"
	"slices"
	"time"

	"todo/internal/task"
)
```

`"maps"` is another standard package — no new dependency, just a tool riding
along with `slices` and `cmp`.

## Grow the interface

The `Store` interface is the list of abilities the rest of the app asks of a
store, so both queries join it:

<!-- verify: internal/store/store.go at=generics -->
```go title="internal/store/store.go"
// Store is the persistence contract the rest of the application depends on.
type Store interface {
	Add(t task.Task) task.Task
	List() []task.Task
	ByStatus(status string) []task.Task
	ByTag(tag string) []task.Task
	CountByTag() map[string]int
	Tags() []string
	...
}
```

The two new lines join the list; the rest of the interface stays as it is.
The check below it — `var _ Store = (*MemoryStore)(nil)` — now holds the new
methods to the same promise.

And the test's stand-in doesn't change at all: `fakeStore` embeds
`*MemoryStore`, so it inherits the new methods the moment the real store has
them. That's what embedding buys — a stand-in that survives an interface
that grows.

## Run it again

```bash
$ go test ./...
ok  	todo/cmd/todo	0.002s
ok  	todo/internal/store	0.002s
ok  	todo/internal/task	0.002s
```

Three packages, everything passing. One command shows what the package now
offers:

```bash
$ go doc ./internal/store MemoryStore
package store // import "todo/internal/store"
...
func (s *MemoryStore) ByTag(tag string) []task.Task
func (s *MemoryStore) Tags() []string
```

The listing grew by two entries — and `filter` is not among them: the helper
is private, so the package's promise didn't grow, only its implementation
shrank. The tests can still call it because they live in the same package.

## If something went wrong

**A predicate whose type doesn't match the list.** You typed `keep` as
`func(any) bool`:

```text
# todo/internal/store [todo/internal/store.test]
internal/store/store_test.go:253:25: in call to filter, type func(any) bool of tc.keep does not match inferred type func(int) bool for func(T) bool
FAIL	todo/internal/store [build failed]
FAIL
```

Go infers `T` from the list: a `[]int` makes `T` equal to `int`, so the
predicate must be `func(int) bool`, and a `func(any) bool` is a different
type — Go won't convert between them. Type the predicate with the element
type, `func(n int) bool` or `func(t task.Task) bool`, which is why the
helper's test splits by element type.

The same family arrives from the other end: `filter(nil, nil)` reports
`cannot infer T`, because nil is untyped and nothing fixes the element type.
Pass a real list.

**`comparable` rejects the store's own element type.** The constraint that
sounds more precise — `filter[T comparable]` — refuses `task.Task`:

```text
# todo/internal/store
internal/store/store.go:98:15: task.Task does not satisfy comparable
internal/store/store.go:103:15: task.Task does not satisfy comparable
FAIL	todo/cmd/todo [build failed]
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	0.002s
FAIL
```

`comparable` admits only types you can compare with `==` and `!=`. A task
carries a list of labels, and a struct holding a list is not comparable — so
the stricter constraint rejects the very type the store walks. The two
errors land at the call sites, where `T` receives its type.
Back to `any`: the walk itself never compares anything.

**`maps.Keys` is not a list.** The first attempt at the label query returns
the sequence directly:

```go
func (s *MemoryStore) Tags() []string {
	keys := maps.Keys(s.CountByTag())
	return keys
}
```

The build stops:

```text
# todo/internal/store [todo/internal/store.test]
internal/store/store.go:109:9: cannot use keys (variable of func type iter.Seq[string]) as []string value in return statement
FAIL	todo/internal/store [build failed]
FAIL
```

The message says what the value really is — "variable of func type
`iter.Seq[string]`". A sequence is a function a loop can drive, not a
container; `len(keys)` fails the same way. Decide the container at the call:
`slices.Collect` for a list, `slices.Sorted` for a sorted one.

**The empty list that is not nil.** If the walk starts
`matches := make([]T, 0, len(xs))` instead of `var matches []T`:

```text
--- FAIL: TestMemoryStore_ByTag (0.00s)
    store_test.go:168: unknown tag returns nil: ByTag("urgent") = [], want nil
--- FAIL: TestFilter (0.00s)
    --- FAIL: TestFilter/ints (0.00s)
        store_test.go:264: all false returns nil: filter(...) = [], want nil
    --- FAIL: TestFilter/task.Task (0.00s)
        store_test.go:304: all false returns nil: filter(...) = [], want nil
FAIL
FAIL	todo/internal/store	0.002s
FAIL
```

`make` returns an empty list that is not nil, so every no-match answer flips
from `nil` to `[]` — and the tests that say the word catch it. That's the
assertion doing its job: a length check alone would have let the change
through. The fix is `var matches []T`; the walk's empty answer is nil.

<details>
<summary>Going deeper: what the compiler does with a type parameter</summary>

A generic function is checked in two passes. The body is checked once,
against the constraint alone: under `any`, only the operations every type
supports are allowed — move a value, store it in a list, pass it to a
function. `x == y` would not compile in the walk, because not every type can
be compared.

Then every call is checked with its element type filled in.
`filter(tc.xs, tc.keep)` makes `T` equal to `int`, so `tc.keep` must be a
`func(int) bool`; a `func(any) bool` does not fit. One body, held against
every caller's type — which is why the helper's test runs two subtests.

</details>

<details>
<summary>Going deeper: when a type parameter pays for itself</summary>

A type parameter costs the reader something: the placeholder, its
constraint, and the rules of inference are extra to read at every call site.
So it pays only when the sharing is real. Two rules of thumb: if a function
works on exactly one concrete type, a type parameter just renames what the
compiler already knew; and if there is only one call site, nothing is shared
yet — write the loop, and reach for the parameter when the second copy
appears.

The standard library follows the same rule: `slices` ships `Contains`,
`Clone`, and `SortStableFunc`, but no `Filter`, `Map`, or `Reduce`. The
omission is deliberate — a `Filter` in the standard library would have to
serve everyone who can write a five-line loop. Our `filter` stays lowercase
for the same reason: two call sites earn a shared implementation, not a
public name. An exported name is a promise the package keeps.

</details>

<details>
<summary>Going deeper: an iterator is a shape, not a container</summary>

`maps.Keys` returns an `iter.Seq[string]`, which the standard `iter` package
defines as `func(yield func(string) bool)`. That's a function that hands out
elements: it calls `yield` once per key, and a `yield` that returns false
stops it early. Since Go 1.23, a `for ... range` loop works over any value
of that shape — which is how a sequence and a loop speak the same language.

The standard `maps` package waited for that release before adding `Keys`, so
it could return the sequence and leave the container to the caller:
`slices.Collect(maps.Keys(m))` for an unsorted list,
`slices.Sorted(maps.Keys(m))` for a sorted one.

</details>

<details>
<summary>Going deeper: nil and empty are different answers</summary>

Nil and an empty list both have length zero, so `len` cannot tell them apart
— but the store's promise, made when `ByStatus` was first written, is nil
when nothing matches. The difference shows elsewhere: `encoding/json` writes
`null` for nil and `[]` for an empty list, and a test that cares has to
compare against nil itself, which is what the new checks do.

That makes the tempting shortcut in the walk — starting from a list with
room for everything — a change to the contract, not a speed-up. The test is
the tripwire that keeps the convention decided.

</details>

The store answers two more questions now, both standing on one shared walk.
Next, statuses and priorities stop being plain text and numbers, and a task
learns to travel as JSON.
