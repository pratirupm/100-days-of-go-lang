---
title: Coverage, races, and fuzzing
day: 13
time: "3 hours"
description: Three tools that check what tests can't — which lines ran, which inputs break a promise, and which memory accesses race.
sidebar:
  order: 11
---

Every test so far checks a case we thought of: a blank title, a missing task, a
date on one particular day. A suite is only as strong as the person who
imagined those cases — and people don't imagine `"tomorrow0"`.

This chapter builds `ParseDue`, the function that turns typed text into a due
date, and then points three tools at it. Coverage records which lines ran
during the tests. Fuzzing invents thousands of inputs and hunts for one that
breaks a promise the code makes. The race detector watches for trouble that
appears only when a program does two things at once.

One of those tools finds a real bug the table tests missed — and leaves behind
a small file that turns the discovery into an ordinary test, running with the
suite from now on.

We start with the parser — and, as always, its test.

## A due date parser, test first

Later in the book, the command-line tool will let people type a due date:
`today`, `tomorrow`, or something like `2026-01-02`. One function will turn
that text into a real date: `ParseDue`. It takes one argument besides the text
— `now`, the moment that relative words are measured against.

Why pass the moment in? If `ParseDue` asked the clock itself with
`time.Now()`, a test for `"today"` could only check against whatever day it
happened to run. Handing `now` in makes it a fixed value the test chooses, so
the relative words have exact answers.

Open `internal/task/task_test.go` and append the table test. The file already
imports `strings`, `time`, and testify, so nothing else moves:

<!-- verify: internal/task/task_test.go at=race-and-fuzz -->
```go title="internal/task/task_test.go"
func TestParseDue(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 10, 13, 15, 30, 0, 0, time.UTC)

	tests := []struct {
		name    string
		input   string
		want    time.Time
		wantErr bool
	}{
		{
			name:  "absolute date",
			input: "2026-01-02",
			want:  time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "today",
			input: "today",
			want:  time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "tomorrow",
			input: "tomorrow",
			want:  time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC),
		},
		{
			name:  "whitespace-padded input",
			input: "  TODAY \t",
			want:  time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC),
		},
		{
			name:    "empty string is rejected",
			input:   "",
			wantErr: true,
		},
		{
			name:    "malformed date is rejected",
			input:   "2026-13-40",
			wantErr: true,
		},
		{
			name:    "unknown word is rejected",
			input:   "yesterday",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := ParseDue(tt.input, now)
			if tt.wantErr {
				var ve ValidationError
				require.ErrorAs(t, err, &ve)
				assert.Equal(t, "due", ve.Field)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
			assert.Equal(t, time.UTC, got.Location())
		})
	}
}
```

`now` is fixed at 3:30 in the afternoon on Tuesday, October 13, 2026 — a moment
that never moves. Seven rows follow: an absolute date, both relative words, a
padded and uppercased `"  TODAY \t"`, and three rejections.

Two rows do quiet work. `"  TODAY \t"` pins both halves of the cleanup at once:
trimming the space from the ends and folding the case. And the rejection branch
asks whether the error's `Field` is `"due"` instead of comparing message text,
so callers keep reacting to *what kind of failure this is*.

Before we run anything, add one more function. It's a fuzz target — a test
that states a promise instead of listing cases:

<!-- verify: internal/task/task_test.go at=race-and-fuzz -->
```go title="internal/task/task_test.go"
func FuzzParseDue(f *testing.F) {
	now := time.Date(2026, 10, 13, 15, 30, 0, 0, time.UTC)

	for _, seed := range []string{"2026-01-02", "today", "tomorrow", "", "garbage"} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, input string) {
		got, err := ParseDue(input, now)
		if err != nil {
			return
		}

		normalized := strings.ToLower(strings.TrimSpace(input))
		var want time.Time
		switch normalized {
		case "today":
			want = time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
		case "tomorrow":
			want = time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)
		default:
			parsed, err := time.Parse("2006-01-02", normalized)
			if err != nil {
				t.Fatalf(
					"ParseDue(%q) = %v, accepted input %q is neither today, tomorrow, nor a 2006-01-02 date",
					input, got, normalized,
				)
			}
			want = parsed
		}

		if !got.Equal(want) {
			t.Fatalf("ParseDue(%q) = %v, want %v", input, got, want)
		}
		if got.Location() != time.UTC {
			t.Fatalf("ParseDue(%q) location = %v, want UTC", input, got.Location())
		}
	})
}
```

Notice two things for now: it calls `ParseDue` too, so the compiler will
complain twice, and it is the tool that will hunt for the inputs nobody thought
to write down. We'll unpack it in a moment. Run the suite:

```bash
$ go test ./...
```

```text
# todo/internal/task [todo/internal/task.test]
internal/task/task_test.go:344:16: undefined: ParseDue
internal/task/task_test.go:367:15: undefined: ParseDue
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.003s
FAIL	todo/internal/task [build failed]
FAIL
```

Read it in order. Two complaints, both `undefined: ParseDue`: the first points
at the table's call, the second at the fuzz target's. The other packages
compiled and passed; only the task test binary is missing a name, and `[build
failed]` means no assertion ran. Your line numbers will differ.

## Write the parser

Now the code. Open `internal/task/task.go` and add two functions after
`NewTask`:

```go title="internal/task/task.go"
// ParseDue parses a due date. now is the reference for relative words;
// callers pass time.Now(). Accepted inputs (after trimming spaces and
// lowercasing): "today", "tomorrow", and absolute dates in 2006-01-02 form.
// The result is always at UTC midnight.
func ParseDue(s string, now time.Time) (time.Time, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return time.Time{}, ValidationError{Field: "due", Message: "cannot be empty"}
	}
	if strings.HasPrefix(s, "today") {
		return midnightUTC(now), nil
	}
	if strings.HasPrefix(s, "tomorrow") {
		return midnightUTC(now).AddDate(0, 0, 1), nil
	}
	due, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, ValidationError{
			Field:   "due",
			Message: fmt.Sprintf("unrecognized date %q", s),
		}
	}
	return due, nil
}

// midnightUTC returns the start of t's date in UTC.
func midnightUTC(t time.Time) time.Time {
	year, month, day := t.UTC().Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}
```

The first line cleans up the input: `strings.TrimSpace` removes space from the
ends, `strings.ToLower` folds the case, so `"  TODAY \t"` becomes `"today"`. An
empty string is rejected as a `ValidationError` with `Field: "due"` — the same
error type the title and status checks use.

The two relative words come next, then `time.Parse("2006-01-02", s)` for
everything else — that odd string is Go's date-shape layout, explained in a box
at the end of the chapter. Anything `time.Parse` can't read becomes a
`ValidationError` too. The helper at the bottom, `midnightUTC`, cuts a moment
to the start of its day in UTC, so a due date never carries a time of day.

Look slowly at the two relative-word checks — this chapter's turning point.
They accept any input that *starts with* the word; the doc comment above says
exactly `"today"` and exactly `"tomorrow"`. The two disagree, and no row in the
table covers the difference. Nobody writes a test for `"tomorrow0"`.

Run the suite:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.004s
ok  	todo/internal/store	0.004s
ok  	todo/internal/task	0.003s
```

Three packages pass, seven rows out of seven — with the shortcut still in the
code. That's not a failure of the loop: a table is exactly as strong as the
inputs its author imagined, and the tools ahead don't have that limit.

## Coverage: which lines ran

A **coverage profile** is a record of which statements ran during a test run.
Think of a flashlight in a dark room: it shows where the tests walked, not
whether they stepped on anything they shouldn't have.

Ask for the profile:

```bash
$ go test -coverprofile=coverage.out ./...
```

```text
ok  	todo/cmd/todo	0.015s	coverage: 64.3% of statements
ok  	todo/internal/store	0.004s	coverage: 100.0% of statements
ok  	todo/internal/task	0.004s	coverage: 100.0% of statements
```

Every package reports a percentage, and the tool writes `coverage.out`, a file
with the per-line details. `internal/store` and `internal/task` are at 100.0% —
every statement in both ran. `cmd/todo` is at 64.3%: its wiring and a few error
paths only happen in ways the tests can't provoke. Delete the report whenever
you like.

For the line-by-line view, fold the profile down to functions:

```bash
$ go tool cover -func=coverage.out
```

```text
...
todo/internal/task/task.go:124:		ParseDue	100.0%
todo/internal/task/task.go:146:		midnightUTC	100.0%
todo/internal/task/task.go:153:		String		100.0%
total:					(statements)	94.4%
```

The `...` hides the earlier functions; the lines shown are the end of the
report. There's the number to stare at: `ParseDue` — the function with the
shortcut — sits at 100.0%. Every statement in it ran, and not one row asked
what the shortcut accepts. Coverage answers *did this line run?* and never *was
the answer right?*

That's why the profile is a flashlight for finding lines nobody visits, not a
score to raise: the cheapest way to raise a percentage is a test with nothing
in it, and that's worse than no test at all.

## Fuzzing: let a machine hunt for inputs

Now the tool that reads the promise. The fuzz target you added is an ordinary
test with a twist: instead of listing cases, it states a **property** — a
sentence that must hold for every input — and hands the search to Go. As a
plain test, it checks the examples you gave it. In fuzzing mode, it mutates
those examples thousands of times a second, keeps the mutations that reach new
code, and checks the property on every one.

The five examples at the top are **seeds**: typed inputs the property should
hold for. The body inside `f.Fuzz` is the property itself. If `ParseDue`
returns no error, the input — after the trimming and lowercasing the doc
comment describes — must be exactly `"today"`, exactly `"tomorrow"`, or a date
`time.Parse` accepts, and the answer must sit at UTC midnight.

Start the engine. The time bound is the budget; the engine stops early if it
finds something:

```bash
$ go test -fuzz=FuzzParseDue -fuzztime=90s ./internal/task
```

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/5 completed
fuzz: elapsed: 0s, gathering baseline coverage: 5/5 completed, now fuzzing with 16 workers
fuzz: minimizing 47-byte failing input file
fuzz: elapsed: 0s, minimizing
--- FAIL: FuzzParseDue (0.27s)
    --- FAIL: FuzzParseDue (0.00s)
        task_test.go:382: ParseDue("tomorrow0") = 2026-10-14 00:00:00 +0000 UTC, accepted input "tomorrow0" is neither today, tomorrow, nor a 2006-01-02 date

    Failing input written to testdata/fuzz/FuzzParseDue/34bd1cf60ff12591
    To re-run:
    go test -run=FuzzParseDue/34bd1cf60ff12591
FAIL
exit status 1
FAIL	todo/internal/task	0.278s
```

Read the transcript in order. The engine gathers a baseline — the five seeds —
then starts sixteen workers mutating. The first failure arrives almost
immediately: a mutation of the `"tomorrow"` seed, `"tomorrow0"`. The message is
the property's default branch doing its job: the parse *succeeded*, so the
result was checked, and `"tomorrow0"` is neither word exactly nor a date.

The engine then minimized the failing input, wrote it to `testdata/fuzz`, and
printed the command to replay it. Total cost: 0.27 seconds of the ninety-second
budget — and the first failure a machine found for us.

Here is the file the engine wrote:

<!-- verify: internal/task/testdata/fuzz/FuzzParseDue/34bd1cf60ff12591 at=race-and-fuzz -->
```text title="internal/task/testdata/fuzz/FuzzParseDue/34bd1cf60ff12591"
go test fuzz v1
string("tomorrow0")
```

Two lines: a format marker and the input. The name is a hash of the input, so
yours may differ — keep whatever file your engine writes and don't rename it.
That folder is the **corpus**: the record of inputs that once broke the
promise. The file is tiny because the engine minimizes what it finds: a failing
input shrunk to something small that still fails.

The fix is two lines. The input is already trimmed and lowercased, so the
checks can compare for equality instead of "starts with":

```diff
-	if strings.HasPrefix(s, "today") {
+	if s == "today" {
 		return midnightUTC(now), nil
 	}
-	if strings.HasPrefix(s, "tomorrow") {
+	if s == "tomorrow" {
 		return midnightUTC(now).AddDate(0, 0, 1), nil
 	}
```

Change both, then run the tests again. Every ordinary test now replays the
corpus entry as its own subtest:

```bash
$ go test -run=FuzzParseDue -count=1 -v ./internal/task
```

```text
=== RUN   FuzzParseDue
=== RUN   FuzzParseDue/seed#0
=== RUN   FuzzParseDue/seed#1
=== RUN   FuzzParseDue/seed#2
=== RUN   FuzzParseDue/seed#3
=== RUN   FuzzParseDue/seed#4
=== RUN   FuzzParseDue/34bd1cf60ff12591
--- PASS: FuzzParseDue (0.00s)
    --- PASS: FuzzParseDue/seed#0 (0.00s)
...
    --- PASS: FuzzParseDue/34bd1cf60ff12591 (0.00s)
PASS
ok  	todo/internal/task	0.003s
```

The subtests are the five seeds plus the corpus entry, named by its hash.
`"tomorrow0"` now runs on every future test run, with no fuzzing flags. That's
the deal fuzzing offers: a bounded search once, and the bug it finds becomes a
permanent, ordinary test.

:::tip
Always give `-fuzz` a `-fuzztime`. Without one, the engine runs until it finds
something or you stop it — there is no default deadline.
:::

## A second fuzz target: the watchman

The first target was a bloodhound: it hunted a bug we half expected. The second
is a watchman: it guards a promise we believe already holds, so a future edit
can't quietly break it. Add it to the test file:

<!-- verify: internal/task/task_test.go at=race-and-fuzz -->
```go title="internal/task/task_test.go"
func FuzzStatusUnmarshalText(f *testing.F) {
	for _, seed := range []string{"Todo", "Done", "", "nope"} {
		f.Add(seed)
	}

	f.Fuzz(func(t *testing.T, input string) {
		var got Status
		if err := got.UnmarshalText([]byte(input)); err != nil {
			return
		}

		if got != StatusTodo && got != StatusDone {
			t.Fatalf("UnmarshalText(%q) accepted %q, want Todo or Done", input, got)
		}

		text, err := got.MarshalText()
		if err != nil {
			t.Fatalf("MarshalText() after UnmarshalText(%q): %v", input, err)
		}
		if string(text) != input {
			t.Fatalf("MarshalText() = %q, want %q after UnmarshalText(%q)", text, input, input)
		}
	})
}
```

Its property: for any input, `UnmarshalText` either fails, or stores exactly
`Todo` or `Done`; and `MarshalText` of the stored value gives back the exact
input bytes. There is no table, because there is no finite list of inputs —
those two sentences are the whole test. Run it for thirty seconds:

```bash
$ go test -fuzz=FuzzStatusUnmarshalText -fuzztime=30s ./internal/task
```

```text
fuzz: elapsed: 0s, gathering baseline coverage: 0/4 completed
fuzz: elapsed: 0s, gathering baseline coverage: 4/4 completed, now fuzzing with 16 workers
fuzz: elapsed: 3s, execs: 105840 (35254/sec), new interesting: 64 (total: 68)
...
fuzz: elapsed: 27s, execs: 1691151 (81260/sec), new interesting: 105 (total: 109)
fuzz: elapsed: 30s, execs: 1835004 (47941/sec), new interesting: 109 (total: 113)
fuzz: elapsed: 31s, execs: 1835004 (0/sec), new interesting: 109 (total: 113)
PASS
ok  	todo/internal/task	31.051s
```

Four seeds became 1,835,004 inputs in thirty seconds, and nothing failed —
expected, since the status parser switches on exact matches. A clean run isn't
a waste: it is evidence the round trip held for every input the engine could
generate in that time. Same tool, two moods.

## The race detector: when two things run at once

A **data race** happens when two parts of a program that run at the same time
use the same piece of memory, and nothing decides which goes first. The answer
may be wrong, may look right, and can change from run to run — races are
painful to find by eye. The race detector watches every read and write and
reports any pair that nothing ordered.

Our suite doesn't race, so to hear the detector speak, we'll build a program
that does. A **goroutine** is a piece of work Go runs alongside the rest;
`go func() { ... }()` starts one. Make a scratch folder outside the app, create
`main.go` in it, and give it two goroutines that append to one shared slice:

```go title="main.go"
package main

import (
	"fmt"
	"sync"
)

func main() {
	var data []int
	var wg sync.WaitGroup

	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			data = append(data, i)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			data = append(data, i)
		}
	}()
	wg.Wait()

	fmt.Println("len:", len(data))
}
```

The `WaitGroup` is the program's only synchronization: `wg.Add(2)` says two
workers are coming, each `defer wg.Done()` says one has finished, and
`wg.Wait()` holds the program until both are done. What it does *not* do is
order the loops against each other — nothing stops both goroutines from writing
to `data` at the same moment. Run it:

```bash
$ go run -race main.go
```

<!-- transcripts: authored -->
```text
==================
WARNING: DATA RACE
Read at 0x00c00012e030 by goroutine 8:
  main.main.func1()
      /tmp/…/main.go:16 +0xcc

Previous write at 0x00c00012e030 by goroutine 9:
  main.main.func2()
      /tmp/…/main.go:22 +0x14d

Goroutine 8 (running) created at:
  main.main()
      /tmp/…/main.go:13 +0x139

Goroutine 9 (finished) created at:
  main.main()
      /tmp/…/main.go:19 +0x1dc
==================
...
len: 20
Found 2 data race(s)
exit status 66
```

Two reports, one per conflicting pair of accesses. Each names both access
sites, both goroutines, and their creation points. The `...` hides the second
report; it points the same disagreement inside `runtime.growslice`, the code
that grows a slice when it runs out of room. Your file's path will be your own.

Two details matter more than the report. The program still printed `len: 20` —
a race is undefined behavior, not a guaranteed wrong answer; this run was a
coin toss that landed right. And the process still exited with status 66: a
proven race is a failure, whether or not the numbers look fine. The detector
only sees accesses that ran, so a clean run is evidence, not proof.

Now the suite under the same watch:

```bash
$ go test -race -count=1 ./...
```

```text
ok  	todo/cmd/todo	1.010s
ok  	todo/internal/store	1.014s
ok  	todo/internal/task	1.011s
```

Milliseconds became about a second — the detector instruments every memory
access — and every parallel test from earlier in the book passed under it.
That's the price and the point: a slower suite that can see what eyes can't.
The scratch program can be deleted; it did its job.

## If something went wrong

**The whole suite fails after the fuzzer writes its file.** You ran the tests
between the fuzzing run and the fix. The corpus entry is a test case now, and
on the unfixed parser it fails exactly as the engine first did:

```bash
$ go test -run=FuzzParseDue/34bd1cf60ff12591 ./internal/task
```

```text
--- FAIL: FuzzParseDue (0.00s)
    --- FAIL: FuzzParseDue/34bd1cf60ff12591 (0.00s)
        task_test.go:382: ParseDue("tomorrow0") = 2026-10-14 00:00:00 +0000 UTC, accepted input "tomorrow0" is neither today, tomorrow, nor a 2006-01-02 date
FAIL
FAIL	todo/internal/task	0.004s
FAIL
```

That is the regression seed doing its job. Fix the parser, keep the file, and
don't delete it when the failure is inconvenient — the failure is the point.

**`-race` requires cgo.** You turned cgo off and asked for the detector:

```bash
$ CGO_ENABLED=0 go test -race ./...
```

```text
go: -race requires cgo; enable cgo by setting CGO_ENABLED=1
```

cgo is the bridge that lets Go use C code; on Linux the race detector's runtime
is built through it. So `-race` needs a C compiler and cgo enabled — the
default wherever one is installed. The plain test run needs neither, which is
why it stays the fast path.

<details>
<summary>Going deeper: why dates in Go are written 2006-01-02</summary>

The layout `2006-01-02` is not a pattern language. It is a real reference
moment — January 2, 2006 — written in the shape you want your input to have.
Each number is a placeholder because it appears once in that moment. To accept
a time as well you would write `2006-01-02 15:04:05`. It looks odd, but a
layout reads by example: the string you write *is* a sample of the input you
accept.

</details>

<details>
<summary>Going deeper: what "ordered" means to the race detector</summary>

The detector's rule is called **happens-before**. Two accesses are ordered if
the program guarantees one finishes before the other starts — a channel send
before its receive, a lock before the next unlock, the code before `wg.Wait()`
before the code after it. Our two goroutines have no such guarantee, so every
append in one is unordered with every append in the other. That's also why a
clean run can't prove anything: the detector sees only the accesses that ran.

</details>

<details>
<summary>Going deeper: why the promise repeats the trimming and lowercasing</summary>

It is tempting to pull the cleanup into a helper that both `ParseDue` and its
fuzz target call. Don't. An oracle that shares code with the thing it judges
inherits its bugs: if the helper lowered case incorrectly, both sides would be
wrong the same way, and the target would stay silent. The small duplication is
a feature.

</details>

The parser now has a table a person wrote, a promise a machine hunts, and a
corpus file that remembers the input that once broke it. Next: how fast the
store really is.

