---
title: Custom types
day: 9
time: "2.5 hours"
description: Give Status and Priority types of their own — with rules the compiler checks and a text form the JSON decoder respects.
sidebar:
  order: 8
---

Two fields on a task live by rules nobody can see. `Status` is plain text — `"Todo"` or `"Done"` — and `Priority` is a plain number from 1 to 5. Both rules live in comments, where the compiler never looks.

Today those two fields get types of their own. In Go you can build a new type on top of an existing one — `type Status string` — and the result is not a nickname: a distinct type that behaves like the string underneath, but carries its own rules and methods, and that a plain string no longer fits.

The payoff shows up at the edges. A misspelled constant stops the build, and when tasks travel as JSON — the text format programs use to exchange data — the decoder rejects `"Nope"` while `"Done"` crosses as before. We write the tests first, as always.

## The rules are stuck in comments

Right now the rules are spelled by hand. `NewTask` returns `Status: "Todo"` and `Priority: 3`, `Complete` writes `"Done"` into a task, and `ByStatus` takes a `string` — any string. The legal values exist only in comments and tests, and that works until someone writes `"Todoo"`, or `"Done "` with a stray space, or priority 9.

A named type gives the compiler something to check. `type Status string` declares a new type whose underlying type is `string` — the kind it is built on. A `Status` can be compared, printed, and converted exactly like a string, but it is not a string: a plain `string` value does not fit where a `Status` is wanted, and methods written on `Status` belong to `Status` alone.

## Write the decoder's test

The first new test drives the decoder directly, with no JSON in the way: the two legal statuses must be accepted, and `"Nope"` and the empty string rejected. Append it to `internal/task/task_test.go`:

<!-- verify: internal/task/task_test.go at=text-encoding -->
```go title="internal/task/task_test.go"
func TestStatus_UnmarshalText(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		want    Status
		wantErr bool
	}{
		{
			name: "Todo is accepted",
			text: "Todo",
			want: StatusTodo,
		},
		{
			name: "Done is accepted",
			text: "Done",
			want: StatusDone,
		},
		{
			name:    "unknown status is rejected",
			text:    "Nope",
			wantErr: true,
		},
		{
			name:    "empty status is rejected",
			text:    "",
			wantErr: true,
		},
	}
```

The table is the contract in four rows: a case name, the text, and what should come back — a `Status` for the good rows, `wantErr: true` for the bad ones. Two names in it do not exist yet — on purpose.

The loop that runs the table is the shape we have used before, with one word changed:

<!-- verify: internal/task/task_test.go at=text-encoding -->
```go title="internal/task/task_test.go"
	for _, tc := range cases {
		var got Status
		err := got.UnmarshalText([]byte(tc.text))
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: UnmarshalText(%q) error = nil, want error", tc.name, tc.text)
				continue
			}
			var ve ValidationError
			if !errors.As(err, &ve) {
				t.Errorf("%s: UnmarshalText(%q) error = %v, want a ValidationError", tc.name, tc.text, err)
				continue
			}
			if ve.Field != "status" {
				t.Errorf("%s: UnmarshalText(%q) ValidationError.Field = %q, want %q", tc.name, tc.text, ve.Field, "status")
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: UnmarshalText(%q) error = %v, want nil", tc.name, tc.text, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%s: UnmarshalText(%q) = %q, want %q", tc.name, tc.text, got, tc.want)
		}
	}
}
```

Three details carry weight. The method is called on a `Status` variable — `got` — so the test exercises the pointer receiver the same way the JSON decoder will. The error branch is the `errors.As` block from the title validation, with `"title"` changed to `"status"`. And the empty string is rejected by the same rule as `"Nope"`: the check is the list of known statuses, not a test for empty text.

## Write the round-trip tests

JSON is the text format tasks will travel in — to a file, to a server, and back. Nothing writes JSON yet, but the types should be ready. Add `encoding/json`, `reflect`, and `strings` to the test file's imports.

The first test marshals a fully populated task and reads it back:

<!-- verify: internal/task/task_test.go at=text-encoding -->
```go title="internal/task/task_test.go"
func TestTask_JSONRoundTrip(t *testing.T) {
	want := Task{
		ID:       7,
		Title:    "write the book",
		Status:   StatusDone,
		Priority: PriorityMax,
		Due:      time.Date(2026, 10, 20, 12, 30, 0, 0, time.UTC),
		Tags:     []string{"go", "writing"},
	}

	data, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("json.Marshal error = %v", err)
	}
	if !strings.Contains(string(data), `"Status":"Done"`) {
		t.Errorf("json.Marshal(task) = %s, want it to contain %q", data, `"Status":"Done"`)
	}

	var got Task
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("json.Unmarshal error = %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("JSON round trip = %#v, want %#v", got, want)
	}
}
```

Two checks guard two directions. `strings.Contains` looks at the marshaled text for `"Status":"Done"`, so a change in the way `Status` writes itself fails here. `reflect.DeepEqual` compares the decoded task with the original, so a decoder that drops what it read fails too. The task is fully populated, so every field crosses the boundary.

`DeepEqual` is used instead of `==` because `Task` holds a slice, and `==` does not compile on structs that contain one. `%#v` prints the struct field by field, where the task's `String` method would hide which field drifted. The due date is fixed in UTC, so the round trip is exact and cannot go flaky.

The second test keeps the rejection honest:

<!-- verify: internal/task/task_test.go at=text-encoding -->
```go title="internal/task/task_test.go"
func TestTask_JSON_UnknownStatus(t *testing.T) {
	var got Task
	err := json.Unmarshal([]byte(`{"Title":"x","Status":"Nope"}`), &got)
	if err == nil {
		t.Fatalf("json.Unmarshal with unknown status: error = nil, want an error mentioning %q", "Nope")
	}
	if !strings.Contains(err.Error(), "Nope") {
		t.Errorf("json.Unmarshal with unknown status: error = %v, want it to mention %q", err, "Nope")
	}
}
```

One check, and a deliberately loose one: the message must mention `"Nope"`. The stricter claim — that the failure is a `ValidationError` with `Field: "status"` — belongs to the table test above. What this test adds is proof that the JSON package found and used our method.

## Write the range test

The last new test covers `Priority`'s range rule:

<!-- verify: internal/task/task_test.go at=text-encoding -->
```go title="internal/task/task_test.go"
func TestPriority_Valid(t *testing.T) {
	cases := []struct {
		name     string
		priority Priority
		want     bool
	}{
		{name: "zero is below the range", priority: 0, want: false},
		{name: "minimum", priority: PriorityMin, want: true},
		{name: "two", priority: 2, want: true},
		{name: "default", priority: PriorityDefault, want: true},
		{name: "four", priority: 4, want: true},
		{name: "maximum", priority: PriorityMax, want: true},
		{name: "six is above the range", priority: 6, want: false},
	}

	for _, tc := range cases {
		if got := tc.priority.Valid(); got != tc.want {
			t.Errorf("%s: Priority(%d).Valid() = %t, want %t", tc.name, tc.priority, got, tc.want)
		}
	}
}
```

The rows are the boundaries and the values just outside them. `0` and `6` are the numbers a decoder or a flag parser produces by accident; `2` and `4` are there because an implementation that only checked the two named constants would get the ends right and the middle wrong. The zero value's verdict — `false` — is what makes the rule usable later: an unset priority is not a legal one.

## Retype every fixture

A **fixture** is a test's data — the sample values it feeds in. The tests we already have spell statuses by hand, and those spellings must become the new names. In `internal/task/task_test.go`, the constructor's default checks become:

<!-- verify: internal/task/task_test.go at=text-encoding -->
```go title="internal/task/task_test.go"
		if got.Status != StatusTodo {
			t.Errorf("%s: NewTask(%q).Status = %q, want %q", tc.name, tc.title, got.Status, StatusTodo)
		}
		if got.Priority != PriorityDefault {
			t.Errorf("%s: NewTask(%q).Priority = %d, want %d", tc.name, tc.title, got.Priority, PriorityDefault)
		}
```

The same rename reaches the `TestTask_String` fixture and every other spelling; the expected strings stay exactly as they were. That is what makes the suite a proof of behavior instead of a copy of today's literals.

The store's tests get the same treatment. Everywhere a status was spelled `"Todo"` or `"Done"`, write `task.StatusTodo` or `task.StatusDone`. Places that deliberately used an unknown status keep their text, wrapped in a conversion. In `TestMemoryStore_ByStatus`, the fixtures become:

<!-- verify: internal/store/store_test.go at=text-encoding -->
```go title="internal/store/store_test.go"
	added := []task.Task{
		{Title: "write tests", Status: task.StatusTodo},
		{Title: "review code", Status: task.StatusDone},
		{Title: "ship it", Status: task.StatusTodo},
		{Title: "archive", Status: task.StatusDone},
		// "Blocked" is deliberately outside the known statuses: the type
		// admits it, and ByStatus is plain equality.
		{Title: "read spec", Status: task.Status("Blocked")},
	}
```

`task.Status("Blocked")` converts arbitrary text into a `Status`. The type admits it — conversion is not validation — and the test keeps it to pin that `ByStatus` is plain equality, not a legality check.

The table that drives the test changes its field type from `string` to `task.Status` — the whole signature story in one line.

The same rename reaches every other fixture in the file: the filter cases, the completion tests, and the expected statuses in `TestCompleteAll`, which become a slice of `task.Status` values. Do not hunt for them by eye: run the tests, and the compiler names each one in turn.

## Watch the build fail

```bash
$ go test ./...
# todo/internal/task [todo/internal/task.test]
internal/task/task_test.go:65:20: undefined: StatusTodo
internal/task/task_test.go:66:84: undefined: StatusTodo
internal/task/task_test.go:68:22: undefined: PriorityDefault
internal/task/task_test.go:69:88: undefined: PriorityDefault
...
# todo/internal/store [todo/internal/store.test]
internal/store/store_test.go:26:56: undefined: task.StatusTodo
internal/store/store_test.go:67:39: undefined: task.StatusTodo
internal/store/store_test.go:68:39: undefined: task.StatusDone
...
ok  	todo/cmd/todo	0.002s
FAIL	todo/internal/store [build failed]
FAIL	todo/internal/task [build failed]
FAIL
```

An untouched package answers from Go's test cache: `todo/cmd/todo` did not change here, so your run may print `(cached)` where this one shows a time.

Read it in order. The two `#` lines name the test builds that failed, and every middle line is `file:line:column: complaint`. The task package's names are bare because its test file lives in the same package; the store's carry a `task.` prefix because it reaches across a package boundary.

Every complaint is a name that does not exist yet, and the list is the to-do list: the constants, the type, and the fixtures waiting for both. Go stops each listing at ten errors, so fix in rounds and rerun; your line numbers will differ, and the names are what matter.

:::note
A build that fails before the code exists is the first half of the process, not a mistake.
:::

## Give `Status` a name and a text form

Now the type itself. In `internal/task/task.go`, below the `Task` struct, add:

<!-- verify: internal/task/task.go at=text-encoding -->
```go title="internal/task/task.go"
// Status is a task's lifecycle state.
type Status string

const (
	// StatusTodo is the state of a task that still has work left.
	StatusTodo Status = "Todo"
	// StatusDone is the state of a completed task.
	StatusDone Status = "Done"
)

// String returns the status as text, such as "Todo".
func (s Status) String() string {
	return string(s)
}
```

`type Status string` declares the new type, and from here on a `Status` is its own kind of value. The constants give the two legal ones names — a constant is a named value that never changes. `StatusTodo Status = "Todo"` reads "the constant `StatusTodo`, of type `Status`, equals the text `Todo`".

`String` returns the status as text: the method `fmt` calls when a status is printed with `%s`, which is how `Task.String` prints tasks. The other two methods are the standard library's text codecs — `MarshalText` writes a value as text, and `UnmarshalText` reads text back:

<!-- verify: internal/task/task.go at=text-encoding -->
```go title="internal/task/task.go"
// MarshalText returns the status in its text form, such as "Todo". The
// method makes Status an encoding.TextMarshaler, which encoding/json honors.
func (s Status) MarshalText() ([]byte, error) {
	return []byte(s), nil
}

// UnmarshalText sets the status from its text form. It accepts only the
// known statuses and reports anything else as a ValidationError.
func (s *Status) UnmarshalText(text []byte) error {
	switch Status(text) {
	case StatusTodo, StatusDone:
		*s = Status(text)
		return nil
	default:
		return ValidationError{Field: "status", Message: fmt.Sprintf("unknown status %q", text)}
	}
}
```

`MarshalText` returns the status as bytes: `[]byte(s)` converts the named type back to its underlying string and then to bytes. A byte is one unit of text and a string is a row of them. The method's name and shape make `Status` an `encoding.TextMarshaler` — the interface the JSON package looks for when it writes a value. JSON would spell `"Done"` without it, since the underlying kind is a string; we write it anyway, to make the text form owned rather than accidental.

`UnmarshalText` is where behavior really changes, because it is the decoder. Its receiver is a pointer — `(s *Status)` — because it writes: `*s = Status(text)` stores through the pointer into the caller's value. A method that only reads sits on the value; a method that writes sits on the pointer. Get that split wrong and the compiler will not always tell you.

Inside, the switch converts the incoming text once with `Status(text)`, so the cases can be the constants themselves. The default returns a `ValidationError` — the same value type the empty-title check returns — with `Field: "status"` and a message that quotes the offending text. `%q` puts quotes around it, so `"Nope"` and `" nope"` cannot be confused. The empty string falls into the same default — the fourth test row expects that.

## Give `Priority` a name and a range

Right below `Status`, add:

<!-- verify: internal/task/task.go at=text-encoding -->
```go title="internal/task/task.go"
// Priority is a task's urgency, from 1 (lowest) to 5 (highest).
type Priority int

const (
	// PriorityMin is the lowest urgency.
	PriorityMin Priority = 1
	// PriorityDefault is the urgency NewTask assigns to a new task.
	PriorityDefault Priority = 3
	// PriorityMax is the highest urgency.
	PriorityMax Priority = 5
)

// Valid reports whether the priority is within the allowed range,
// PriorityMin through PriorityMax.
func (p Priority) Valid() bool {
	return p >= PriorityMin && p <= PriorityMax
}
```

`Priority` is built on `int` — a whole number. The three constants name the ends of the range and the default that `NewTask` uses. `Valid` answers one question: is this number inside the range? The zero priority is not, which makes an unset priority easy to spot.

There is no codec here on purpose: priorities travel as numbers — `"Priority":3` — so there is nothing to translate. `Valid` does not reject anything by itself; nothing decodes a number through it, so a JSON priority of 9 lands with `Valid()` returning false.

One direction note: the old field comment ranked 1 as the highest urgency, and nothing read it. The new doc comment settles the direction — 1 is the lowest, 5 the highest — and the constant names say which end is which.

## Retype the fields and the constructor

The two fields now carry the types:

<!-- verify: internal/task/task.go at=text-encoding -->
```go title="internal/task/task.go"
	// Status is the workflow state of the task. Tasks built by NewTask
	// start in StatusTodo.
	Status Status
	// Priority is the task's urgency. Tasks built by NewTask start at
	// PriorityDefault.
	Priority Priority
```

A `Task` built by hand still compiles, but its zero status is `""` and its zero priority is `0`, and neither is legal. The constructor remains the door to a well-formed task:

<!-- verify: internal/task/task.go at=text-encoding -->
```go title="internal/task/task.go"
	return Task{
		Title:    title,
		Status:   StatusTodo,
		Priority: PriorityDefault,
	}, nil
```

The defaults have names now, and the compiler checks that each one is the right type.

## Thread the type through the store

Three one-line changes in `internal/store/store.go`, and the compiler holds them together. The interface names the new parameter:

<!-- verify: internal/store/store.go at=text-encoding -->
```go title="internal/store/store.go"
	ByStatus(status task.Status) []task.Task
```

The method follows it:

<!-- verify: internal/store/store.go at=text-encoding -->
```go title="internal/store/store.go"
// ByStatus returns the tasks whose Status equals status, in insertion order.
func (s *MemoryStore) ByStatus(status task.Status) []task.Task {
	return filter(s.tasks, func(t task.Task) bool { return t.Status == status })
}
```

And `Complete` writes the named constant instead of the literal:

<!-- verify: internal/store/store.go at=text-encoding -->
```go title="internal/store/store.go"
	for i, t := range s.tasks {
		if t.ID == id {
			s.tasks[i].Status = task.StatusDone
			return nil
		}
	}
```

The `var _ Store = (*MemoryStore)(nil)` line from the store's interface work keeps the two halves together: change one without the other and the build names the missing half right away. The test fake needs no edit at all — it embeds the memory store, so it inherits the new signature the way it inherited the old one.

What the typed parameter buys is smaller and sharper than "the compiler checks your statuses". A plain `string` variable no longer fits the call — a build error at the call site — while an untyped literal such as `"Todo"` still does, because Go converts untyped constants to the type they are assigned to.

One field keeps its plain type on purpose. A label is any text the user types — no closed set to name, no text form to own — so it stays a plain list of strings. Name the values whose text the program must check; do not name strings merely because they are strings.

## Run the suite

```bash
$ go test ./...
ok  	todo/cmd/todo	0.002s
ok  	todo/internal/store	0.002s
ok  	todo/internal/task	0.003s
```

All three packages pass, with the command's test untouched: it prints tasks with `%s` and never names a status, so the formatting contract held while the fields underneath changed type.

## If something went wrong

**The decoder validates but drops the value.** `UnmarshalText` writes, so its receiver must be a pointer. With a value receiver — `func (s Status) UnmarshalText(...)` — the decode still runs, still rejects bad text, and drops every accepted value on a copy. Run with `-v` to see each case by name. The tests report:

```text
=== RUN   TestStatus_UnmarshalText
    task_test.go:159: Todo is accepted: UnmarshalText("Todo") = "", want "Todo"
    task_test.go:159: Done is accepted: UnmarshalText("Done") = "", want "Done"
--- FAIL: TestStatus_UnmarshalText (0.00s)
=== RUN   TestTask_JSONRoundTrip
    task_test.go:187: JSON round trip = task.Task{ID:7, Title:"write the book", Status:"", Priority:5, ...
--- FAIL: TestTask_JSONRoundTrip (0.00s)
=== RUN   TestTask_JSON_UnknownStatus
--- PASS: TestTask_JSON_UnknownStatus (0.00s)
FAIL
FAIL	todo/internal/task	0.002s
FAIL
```

The good rows come back empty, while the unknown-status test passes: rejecting bad text never needed a writable receiver, but accepting good text does. The fix is the pointer receiver, writing through it: `func (s *Status) UnmarshalText(text []byte) error` and `*s = Status(text)`.

The two mismatched spellings are usually caught at the build. A value receiver with `*s = ...` stops at:

```text
internal/task/task.go:55:4: invalid operation: cannot indirect s (variable of string type Status)
```

A pointer receiver with `s = ...` stops at:

```text
internal/task/task.go:55:7: cannot use Status(text) (value of string type Status) as *Status value in assignment
```

The quiet one — a value receiver with a plain assignment — compiles, and only the tests catch the dropped value.

**A format verb that does not match the kind.** `%d` prints numbers and `%s` prints strings, and a value's kind decides which verbs fit. The wrong one is reported by `go vet`, which runs as part of `go test`:

```text
internal/task/scratch_vet_test.go:11:19: fmt.Sprintf format %d has arg s of wrong type todo/internal/task.Status
internal/task/scratch_vet_test.go:12:19: fmt.Sprintf format %s has arg p of wrong type todo/internal/task.Priority
```

The file name in yours will be the file that asked. `Status` is built on a string, so it takes `%s` or `%v` — they render the same, since `String` exists — and `Priority`, built on an int, takes `%d` or `%v`. And when a failure message shows an empty gap, the value is simply empty: the zero `Status` prints as nothing under `%v` and as `""` under `%q`.

<details>
<summary>Going deeper: what a named type does and does not stop</summary>

`type Status string` makes `Status` a distinct type, but it does not seal the set of values. An untyped literal still assigns — `Status: "Todo"` compiles, because Go converts an untyped constant to the type it is assigned to. A conversion still builds any value: `task.Status("Blocked")` is legal, and so is `task.Status("")`. And equality has no opinion: `ByStatus` will return any task carrying `task.Status("Blocked")`.

What the type stops is the quiet mistake with a name: a `string` variable — read from a flag, a column, a file — no longer slides into a status parameter. And it adds an address for the rule: methods, a doc comment, and one place for the decoder.

</details>

<details>
<summary>Going deeper: what the decoder never sees</summary>

Two values arrive without ever touching `UnmarshalText`. A JSON document with no `"Status"` key has no text to check, so no method runs and the field stays at its zero value, `""`. And priorities travel as numbers with no decoder, so `{"Priority":9}` lands with `Valid()` returning false.

Nothing rejects either one on the way in. A missing status is a question for wherever presence is known, and an out-of-range priority is a question for whoever makes a decision. Every status that arrives as text is checked; nothing else is claimed.

</details>

The rules have names and an address now; next, we turn to the tests themselves and give them a cleaner shape.
