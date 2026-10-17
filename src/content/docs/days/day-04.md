---
title: "Day 4 — When things go wrong"
description: "Give failures identity — an error that carries the field that failed, and one shared \"not found\" error the store wraps with context. — Day 4 of 100 Days of Go Lang."
sidebar:
  order: 4
chapter: 4
---

**About 2.5 hours** · Part I, day 4 of 4.

**You'll be able to:**

- return errors as values, wrap them with context, and match them by identity with `errors.Is` and `errors.As`;
- explain why error text is not an API.

---

The app already has one failure path: `NewTask` refuses a blank title. But it
reports that failure as a plain message, and nothing can tell what *kind* of
failure it is without reading the text. The store has no failure path at all:
every operation it has today can only succeed.

That changes now. We'll give failures identity: an error that carries the field
that failed, and one shared error that stands for "no such task". Callers will
be able to ask *is this that failure?* and *what does this failure carry?*
without matching a single word of text.

The app is growing. A command-line tool and a web interface will sit on top of
these packages, and both will need to react to failures — show a validation
message, or tell the person the task is missing. Reacting to text is fragile;
reacting to identity is exact.

We'll start where we always start: with the tests.

## Failures need identity

An error is a value like any other. A function that can fail returns one as its
last result: `nil` means nothing went wrong, and anything else is the failure
itself. Once a caller holds that value, it wants two answers: is this a failure
it already knows about, and what does the failure carry?

Answering those questions by reading the message text is a trap. Text is for
humans: it can be reworded tomorrow without changing what actually happened. A
program that decides by text breaks when the wording changes — and keeps
working when the meaning changes underneath.

So failures get identity, in two shapes. The first is a **typed error**: an
error whose type is a struct, so it can carry fields — which field failed, and
why. The second is a **shared error**: one value, created once, that stands for
one condition. Go programmers call it a *sentinel*, because it is a fixed point
every caller can name.

There is one more move to learn: **wrapping**. To wrap an error is to put it
inside a new error that adds context — the operation that was attempted, and
the ID it was attempted on. The outer error is what gets printed; the inner one
stays reachable inside it.

Go's standard library — the packages that ship with Go — gives us two ways to
ask those questions, both in the `errors` package. `errors.Is(err, target)`
answers the first: is this error, or anything wrapped inside it, the value
`target`? `errors.As(err, &target)` answers the second: is this error, or
anything wrapped inside it, of a particular type — and if so, copy it into
`target` so its fields can be read. The `&` is the address-of symbol: it tells
`As` where to put the error it finds.

## Ask the tests for more

The test for a blank title only checks that *an* error appears. That was the
right contract when the error was a plain message. Now we want the type and the
field, so the error branch of the table grows three checks: an error is there,
it is a `ValidationError`, and its `Field` says `"title"`.

Open `task/task_test.go`, add `errors` to its imports, and grow the error
branch to match this:

<!-- verify: task/task_test.go at=error-wrapping -->
```go title="task/task_test.go"
	for _, tc := range cases {
		got, err := NewTask(tc.title)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: NewTask(%q) error = nil, want error", tc.name, tc.title)
				continue
			}
			var ve ValidationError
			if !errors.As(err, &ve) {
				t.Errorf("%s: NewTask(%q) error = %v, want a ValidationError", tc.name, tc.title, err)
				continue
			}
			if ve.Field != "title" {
				t.Errorf("%s: NewTask(%q) ValidationError.Field = %q, want %q", tc.name, tc.title, ve.Field, "title")
			}
			continue
		}
...
```

The rest of the loop is unchanged — the `...` stands for the lines already in
your file. Read the new middle first: `var ve ValidationError` declares a
target, `errors.As(err, &ve)` looks inside the error for one, and from then on
`ve` is an ordinary struct the test can read. Every check reports and moves on
with `continue`, so a problem in one row cannot hide the rest.

The store's new test is the centerpiece. Add it at the end of
`store/store_test.go`, and add `errors` and `strings` to that file's imports:

<!-- verify: store/store_test.go at=error-wrapping -->
```go title="store/store_test.go"
func TestMemoryStore_Complete(t *testing.T) {
	s := NewMemoryStore()
	s.Add(task.Task{Title: "write tests", Status: "Todo"})
	s.Add(task.Task{Title: "make them pass", Status: "Todo"})

	if err := s.Complete(2); err != nil {
		t.Fatalf("Complete(2) error = %v, want nil", err)
	}

	list := s.List()
	if len(list) != 2 {
		t.Fatalf("List() length = %d, want %d", len(list), 2)
	}
	if list[1].Status != "Done" {
		t.Errorf("after Complete(2), List()[1].Status = %q, want %q", list[1].Status, "Done")
	}
	if list[0].Status != "Todo" {
		t.Errorf("after Complete(2), List()[0].Status = %q, want %q", list[0].Status, "Todo")
	}

	err := s.Complete(3)
	if err == nil {
		t.Fatalf("Complete(3) error = nil, want an error wrapping ErrNotFound")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("Complete(3) error = %v, want an error that wraps ErrNotFound", err)
	}
	if !strings.Contains(err.Error(), "complete task 3: ") {
		t.Errorf("Complete(3) error = %v, want message containing %q", err, "complete task 3: ")
	}
}
```

Three details carry the lesson. The successful `Complete(2)` is checked with
`err :=` inside the `if`, so the error is used and then gone. The miss is
checked with `errors.Is(err, ErrNotFound)` — a question about identity, not
text. And the message check uses `strings.Contains` for the prefix
`complete task 3: `, asking *did this layer add context?* rather than *how is
the sentence spelled?*

Run the tests now, before writing any of the new code:

```bash
$ go test ./...
# todo/task [todo/task.test]
task/task_test.go:45:11: undefined: ValidationError
# todo/store [todo/store.test]
store/store_test.go:233:14: s.Complete undefined (type *MemoryStore has no field or method Complete)
store/store_test.go:248:11: s.Complete undefined (type *MemoryStore has no field or method Complete)
store/store_test.go:252:21: undefined: ErrNotFound
FAIL	todo/store [build failed]
FAIL	todo/task [build failed]
FAIL
```

Four complaints, three missing pieces. In `task`, the type `ValidationError`
does not exist. In `store`, the method `Complete` is missing at two call sites,
and the value `ErrNotFound` is missing. Both packages end `[build failed]`,
which means the test binaries never built, so no assertion ran. That is what
the tests look like before the code that meets them.

## An error that carries the field

Open `task/task.go` and add the new type above `NewTask`:

<!-- verify: task/task.go at=error-wrapping -->
```go title="task/task.go"
// ValidationError reports a task field that failed validation.
type ValidationError struct {
	// Field is the name of the task field that failed validation, such as
	// "title".
	Field string
	// Message explains why the field is invalid.
	Message string
}

// Error returns the validation failure as a message, such as
// "invalid title: cannot be empty".
func (e ValidationError) Error() string {
	return fmt.Sprintf("invalid %s: %s", e.Field, e.Message)
}
```

The struct is ordinary; the method is the interesting part. `Error() string` is
what makes a `ValidationError` an error — in Go, any value with that method can
be used as one. (The rule behind that is called an interface, and interfaces
get their own introduction later in the book. For now, the method is the
membership card.)

`Field` is a machine name — `"title"` — and `Message` is a human sentence —
`"cannot be empty"`. `Error()` joins them into `invalid title: cannot be
empty`: lowercase, no trailing punctuation, so a caller above can wrap it into
a message like `create task: invalid title: cannot be empty`.

The receiver is a value, `(e ValidationError)`, not a pointer. The method only
reads, and with a value receiver both a `ValidationError` and a pointer to one
count as errors — which is why the test's `errors.As` target is the plain type.

Now change `NewTask` to return the new value:

<!-- verify: task/task.go at=error-wrapping -->
```go title="task/task.go"
// NewTask validates the title and returns a task with the default status,
// priority, and no due date. It returns a ValidationError if the title is
// empty after trimming surrounding whitespace.
func NewTask(title string) (Task, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Task{}, ValidationError{Field: "title", Message: "cannot be empty"}
	}
	return Task{
		Title:    title,
		Status:   "Todo",
		Priority: 3,
	}, nil
}
```

The failure line returns `ValidationError{Field: "title", Message: "cannot be
empty"}` instead of `errors.New("title cannot be empty")`, and the doc comment
promises the new type. The message a person sees changed shape to
`invalid title: cannot be empty`, and no test noticed — no test ever compared
the text.

The file no longer uses the `errors` package, so remove `errors` from its
imports. Go refuses to build a file that imports a package it never uses.

## One shared error for a missing task

The store needs its first failure path. Open `store/store.go`, add `errors` and
`fmt` to its imports, and put one value near the top, above the `MemoryStore`
type:

<!-- verify: store/store.go at=error-wrapping -->
```go title="store/store.go"
// ErrNotFound is reported when an operation names a task that does not exist.
var ErrNotFound = errors.New("task not found")
```

This is the sentinel: created once, at package scope, and exported — the
capital `E` — so every caller can name it. Its message is deliberately plain,
because "the named task does not exist" is all there is to say about it; a
caller who needs details asks with `errors.Is`, never by text.

Now the method. Add it directly after `Add`:

<!-- verify: store/store.go at=error-wrapping -->
```go title="store/store.go"
// Complete marks the task with the given ID as done. It returns an error that
// wraps ErrNotFound when no such task exists.
func (s *MemoryStore) Complete(id int) error {
	for i, t := range s.tasks {
		if t.ID == id {
			s.tasks[i].Status = "Done"
			return nil
		}
	}
	return fmt.Errorf("complete task %d: %w", id, ErrNotFound)
}
```

Read it in two halves. The loop scans for the ID; on a match it writes `"Done"`
into the store's own slot and returns `nil`, which means nothing went wrong.
The write is `s.tasks[i].Status`, not `t.Status`: `range` hands out a copy of
each task, so writing to `t` would change a value nobody keeps — the same
ownership rule that made `List` return a copy.

The miss is the interesting half. `fmt.Errorf` builds a new error the way
`fmt.Sprintf` builds a string: `%d` formats the ID, and `%w` — the one to
remember — records `ErrNotFound` *inside* the new error. The result prints as
`complete task 3: task not found`, and it still answers yes to
`errors.Is(err, ErrNotFound)`, because `Is` knows how to look inside a wrap.
Swap `%w` for `%v` and the message prints the same while the identity
disappears: `%v` only formats the inner error into text.

One rule to keep: wrap once, at the layer that knows the fact. This layer knows
*which* task was missing, so the ID goes here. A layer above that added the
same words again would print a stutter — `complete task 3: complete task 3:
task not found` — so it should pass the error along untouched, or add genuinely
new context.

## Run it again

Both packages have their new pieces. Run the whole suite:

```bash
$ go test ./...
ok  	todo/store	0.002s
ok  	todo/task	0.002s
```

`ok` for both packages: every test passes, including every test from the
earlier work that we never touched. That is the point of a suite — new failure
paths should not disturb the successes around them.

The blank-title failure is now a `ValidationError` carrying `Field: "title"`,
and completing a missing task is now an error that wraps `ErrNotFound` and
names the ID it could not find.

## If something went wrong

**Comparing the message text instead of the identity.** It is tempting to check
a failure by comparing `err.Error()` with the exact text you expect. The text
is one layer's rendering; the moment a caller above wraps the error with its
own words, the comparison breaks even though the failure is the same. A
throwaway test that compared the full text fails like this (run with `-v` to
see the case by name) — the first part of the line names the file where the
check lived, and yours will name your own:

```text
=== RUN   TestScratch_StringCompare
    scratch_errors_test.go:12: err.Error() = "cli: mark done: complete task 3: task not found", want "complete task 3: task not found"
--- FAIL: TestScratch_StringCompare (0.00s)
FAIL
FAIL	todo/store	0.002s
FAIL
```

The fix is to ask for identity — `errors.Is(err, ErrNotFound)` — and, if you
want to check that context was added, to use `strings.Contains` on the prefix
your own layer contributes, the way `TestMemoryStore_Complete` does.

**`%v` where `%w` is needed.** The two verbs print the same message, so the
test's failure line is the only clue:

```text
--- FAIL: TestMemoryStore_Complete (0.00s)
    store_test.go:253: Complete(3) error = complete task 3: task not found, want an error that wraps ErrNotFound
FAIL
FAIL	todo/store	0.001s
FAIL
```

`%v` formatted the sentinel into text and recorded nothing, so `errors.Is` had
no chain to walk. The message looked perfect — that is the trap. Use `%w`.

**`errors.As` handed the variable instead of its address.** The mistake is
reported by `go vet`, which runs as part of `go test`:

```text
# todo/task
# [todo/task]
task/scratch_as_test.go:11:6: second argument to errors.As must be a non-nil pointer to either a type that implements error, or to any interface type
FAIL	todo/task [build failed]
FAIL
```

`errors.As` must be able to copy the error it finds into your variable, so it
needs the variable's address: `errors.As(err, &ve)`. The file name at the start
of the message is wherever the call lived; the sentence after it is the one to
read.

<details>
<summary>Going deeper: why not compare errors directly?</summary>

`err == ErrNotFound` is true only when the error at the top *is* that value.
`Complete` returns a new error that contains the sentinel, so the comparison is
false even though the failure is the one we mean. `errors.Is` asks the same
question properly: it walks down through every wrap, comparing each error in
the chain to the target, and answers yes when one of them matches.

</details>

<details>
<summary>Going deeper: what does %w actually record?</summary>

A wrapped error is an error with one extra method: `Unwrap() error`, which
hands back the error inside. `fmt.Errorf` with `%w` builds a value that has it,
and `errors.Is` and `errors.As` follow those links one error at a time. One
`%w` per `Errorf` wraps exactly one cause, which is all this lesson needs;
wrapping several errors at once arrives later in the book.

</details>

<details>
<summary>Going deeper: what if ValidationError used a pointer receiver?</summary>

Then only a `*ValidationError` — a pointer to one — would count as an error,
and the test's target would be the pointer type: `var ve *ValidationError`,
with `errors.As(err, &ve)` still passing the address, this time of the pointer.
The value receiver keeps both forms working and lets the test read `ve.Field`
directly. A receiver that only reads usually stays a value; one that changes
the receiver takes a pointer.

</details>

Failures have names now — which is what lets the rest of the app react to them
without reading a single word of text. Next, we'll give the store's behavior a
name of its own, so the app can depend on a promise instead of this one store.

<div class="day-tracker" data-day="4"></div>
