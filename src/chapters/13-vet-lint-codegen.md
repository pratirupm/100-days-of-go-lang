---
title: Linters and code generation
day: 15
time: "3 hours"
description: Point Go's own checker and a stricter linter at the code, then let a generator write a test fake that keeps up with the store's interface.
sidebar:
  order: 13
---

Our tests check the cases we thought to write down. Some mistakes never reach them: a write error nobody looks at, a value assigned and never read, a function nothing calls anymore. The tests keep passing, because the program still answers the inputs they know. These mistakes live in the code itself, waiting for a strange input on a bad day.

This lesson points checkers at the code. Go ships with one, `go vet`, and there is a popular, stricter one called golangci-lint. Both read the source and report suspicious shapes. The stricter one will find a real mistake in code we wrote earlier in the book — while every test keeps passing.

Then we hand part of the work to a generator. The store's tests use a hand-written fake to script a failure the real store cannot produce. A **fake** is a stand-in that behaves like the real thing in the ways a test needs. Hand-written fakes drift: when the interface they imitate grows a method, they quietly fall behind. A generator writes the fake from the interface itself, so the two cannot disagree.

## Two checkers that ship with Go

Two checkers are already on your machine, because they come with Go. The first is `go vet`. It reads your code for constructs that are almost always mistakes: a format string whose verbs do not match its arguments, a lock copied by value, code that can never run. It is conservative on purpose — it reports only what is nearly certainly wrong, so a quiet report means a lot.

The second is `gofmt`, the formatter. Go has one official layout for source code, and `gofmt` knows it. With `-l` it lists files whose layout does not match; silence means everything is tidy. The layout is not a matter of taste: because there is only one, nobody argues about spacing, and every Go file in the world looks familiar.

Point both at the app:

```bash
$ go vet ./...
$ gofmt -l .
```

Both print nothing. Nothing suspicious, nothing untidy — and that is the normal state. These two speak only when they have something to say. Keep them in mind; we will run them again at the end, after the code has changed.

## A stricter checker: golangci-lint

`go vet` stays deliberately quiet about whole categories of problems, dropped errors above all. Not every ignored error is a mistake, and vet refuses to guess. A **linter** does guess: it reads code and flags patterns its authors decided deserve a second look. golangci-lint runs a bundle of linters over the code and prints one list.

We run it without installing anything:

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
```

The `@v2.14.0` is deliberate. `go run` downloads that exact version, builds it, and runs it — nothing lands on your machine, and the version sits in the command. The first run takes a while as it compiles; later runs are quick.

Before that first run, write down what "lint" should mean for this project. The tool reads its policy from a file called `.golangci.yml` in the project root:

<!-- verify: .golangci.yml at=lint -->
```yaml title=".golangci.yml"
version: "2"

linters:
  # The curated gate: golangci-lint's five standard linters plus gosec.
  # `default: none` makes this list the whole policy: no linter is enabled by
  # accident, and a future tool release cannot add one behind our backs.
  default: none
  enable:
    - errcheck
    - govet
    - staticcheck
    - ineffassign
    - unused
    - gosec

  settings:
    errcheck:
      # errcheck layers its own built-in symbol exclusions on top of the
      # presets: fmt.Fprint* to os.Stderr, writes to bytes.Buffer and
      # strings.Builder, and a few hash/rand writes — calls whose error
      # cannot carry information the caller could act on. Kept (upstream
      # default) and made explicit; the arbitrary-io.Writer case is not on
      # that list, so it stays reported.
      disable-default-exclusions: false
```

The first line pins the file's format. Under `linters`, `default: none` throws away the tool's own default list and makes what follows the entire policy — no check runs by accident, and a future release cannot add one behind our backs. Then six names: `errcheck` (dropped errors), `govet` (the same checks as `go vet`), `staticcheck` (suspicious constructs and calls the standard library has retired), `ineffassign` (values assigned but never read), `unused` (code nothing calls), and `gosec` (patterns with a security smell).

The rest of the file is about what not to report:

<!-- verify: .golangci.yml at=lint -->
```yaml title=".golangci.yml"
  exclusions:
    # Generated files are not ours to fix. `strict` uses Go's own marker
    # (`// Code generated ... DO NOT EDIT.`, via ast.IsGenerated), which is
    # exactly what moq writes into store_moq_test.go.
    generated: strict

    # No exclusion presets, deliberately: v2 presets are opt-in (Default: []),
    # and the one that would matter here is std-error-handling (EXC0001). It
    # hides errcheck's report for any dropped fmt print/Close/Flush error by
    # name — but this CLI writes to an arbitrary io.Writer, and write
    # failures are part of run's error contract, so they must stay visible.
    presets: []
```

`generated: strict` skips files that carry Go's generated-code marker — the marker the generated mock will wear. `presets: []` refuses the ready-made silencing rules that ship with the tool: none of them is on, so nothing is hidden by name. errcheck's own narrow exclusions stay on, and the comment says which calls they cover.

Now the first run:

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
cmd/todo/main.go:35:14: Error return value of `fmt.Fprintf` is not checked (errcheck)
		fmt.Fprintf(w, "%d. %s\n", t.ID, t)
		           ^
1 issues:
* errcheck: 1
exit status 1
```

Read it in order. `cmd/todo/main.go:35:14` names the file, the line, and the column. Then the complaint, with the linter that made it in parentheses — `(errcheck)` — then the offending line with a caret under the exact spot. `1 issues:` and `* errcheck: 1` are the summary; `exit status 1` is the tool saying it found something. Your line numbers may differ by a line or two.

The finding is real. The loop writes each task to `w`, and `w` is whatever writer `run`'s caller handed in. `run` returns an error, so it has already promised to report failures — and a failed write is exactly the kind of failure its caller cares about: a full disk or a broken pipe. The loop throws that error away.

The fix is small: check the write and return it.

```diff
-		fmt.Fprintf(w, "%d. %s\n", t.ID, t)
+		if _, err := fmt.Fprintf(w, "%d. %s\n", t.ID, t); err != nil {
+			return err
+		}
```

Run the linter again:

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
0 issues.
```

Zero findings — the loop is honest now. The tests never noticed a thing: they passed before and they pass now, because no test hands `run` a writer that fails.

## The same mistake, hidden in a helper

Now look at where the loop lives: inside `run`, which is doing two jobs — assembling the list and printing it. Printing is the part that takes a writer, so it deserves its own name. Move the loop into a helper below `run`, and write it the way it is tempting to write it — dropping the error, with a comment claiming the drop is fine:

```go
// printTasks writes one line per task to w. Print output is best-effort: a
// dropped line does not change any task, so the write error is not reported.
func printTasks(w io.Writer, tasks []task.Task) {
	for _, t := range tasks {
		fmt.Fprintf(w, "%d. %s\n", t.ID, t)
	}
}
```

That comment states a policy — "the write error is not reported" — and the linter is about to disagree with it. This version is a demonstration, not the one we keep. Change `run` to call the helper:

```diff
-	for _, t := range s.List() {
-		if _, err := fmt.Fprintf(w, "%d. %s\n", t.ID, t); err != nil {
-			return err
-		}
-	}
+	printTasks(w, s.List())
 	return nil
```

Now run the linter and the tests, in that order:

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
cmd/todo/main.go:42:14: Error return value of `fmt.Fprintf` is not checked (errcheck)
		fmt.Fprintf(w, "%d. %s\n", t.ID, t)
		           ^
1 issues:
* errcheck: 1
exit status 1
```

The same finding, now pointing at line 42 — inside the helper.

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.003s
ok  	todo/internal/task	0.003s
```

The linter found the same mistake in its new home. The tests did not — no test hands `run` a writer that fails, so no assertion can notice a dropped write error. That is the gap these two tools fill: the tests check the answers the program produces, and the linter checks the promises the code makes.

Now write the helper the honest way. It returns the first write error, and `run` passes that error along instead of swallowing it:

<!-- verify: cmd/todo/main.go at=lint -->
```go title="cmd/todo/main.go"
// printTasks writes one line per task to w and reports the first write error:
// run's writer is arbitrary, so a broken pipe or full disk is its caller's
// problem to see.
func printTasks(w io.Writer, tasks []task.Task) error {
	for _, t := range tasks {
		if _, err := fmt.Fprintf(w, "%d. %s\n", t.ID, t); err != nil {
			return err
		}
	}
	return nil
}
```

The call site loses its `return nil` line and returns the helper's result instead:

```diff
-	printTasks(w, s.List())
-	return nil
+	return printTasks(w, s.List())
```

Ask the linter and the tests one last time:

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
0 issues.
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.003s
ok  	todo/internal/task	0.003s
```

Zero findings, and every package passes. The comment on the helper is now true, and not one test changed to make it so.

## The long commands get names

The commands above are long, and they are only getting longer: every tool the book adds arrives as a `go run` with a version pinned inside it. Writing a command like that out by hand invites a typo in a version number, and a typo in a version number runs a different tool than the one you meant.

The project keeps its long commands in a file called `Makefile`, one name per command. Create it at the app's root with exactly this content:

<!-- verify: Makefile at=lint -->
```makefile title="Makefile"
# The local gate. CI runs the same targets, so a green run here is a green
# run there. Tool versions are pinned here, once.

GOLANGCI_LINT_VERSION := v2.14.0
MOQ_VERSION           := v0.8.0

GOLANGCI_LINT := go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)

.PHONY: fmt vet test race lint generate check bench cover

# fmt fails when any .go file is not gofmt-clean.
fmt:
	@unformatted="$$(gofmt -l .)"; \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt would rewrite:"; echo "$$unformatted"; exit 1; \
	fi

vet:
	go vet ./...

test:
	go test -count=1 ./...

race:
	go test -race -count=1 ./...

lint:
	$(GOLANGCI_LINT) run

# generate runs every //go:generate directive in the module. The moq version
# in the directive is written literally: go generate expands environment
# variables ($VAR), never make variables, so $(MOQ_VERSION) there would reach
# moq as that literal text. The check below keeps the directive and the pin
# above in sync; it is a no-op while no directive exists yet.
generate:
	@pin="$$(grep -o 'matryer/moq@[^ ]*' internal/store/store.go || true)"; \
	if [ -n "$$pin" ] && [ "$$pin" != "matryer/moq@$(MOQ_VERSION)" ]; then \
		echo "internal/store/store.go pins $$pin; the Makefile pins matryer/moq@$(MOQ_VERSION)"; exit 1; \
	fi
	go generate ./...

# check is the full local gate: format, vet, lint, regenerate — failing if
# that changed anything, because generated code must be committed — then test.
check: fmt vet lint generate
	@git diff --exit-code || { echo "generated files are stale: run make generate and commit"; exit 1; }
	go test -count=1 ./...

bench:
	go test -bench=. -benchmem -count=10 ./internal/store

cover:
	go test -count=1 -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out | tail -1
```

Each name in the file is a **recipe**: the command, or several commands, that run under that name. `make fmt` checks the layout of every Go file, `make test` runs the tests, and `make lint` runs the long `go run` line from above. The version pins sit at the top of the file, and each recipe builds its command from them, so a tool's version is written once and nowhere else. `make check` runs several recipes in order — layout, vet, lint, and the generator — and then the tests, so the whole set is one command. The file grows as the book needs more: when a long command earns repeating, it gets a name, and the pages after this one use the name.

## Let a generator write the fake

The store's interface has eight methods, and one test needs a stand-in that fails on demand. `TestCompleteAll` scripts a failure for id 2 while ids 1 and 3 behave normally — and the real store cannot produce that failure, because `Complete` only fails for ids that do not exist.

The fake in the file today was written by hand: a small type that inherits `MemoryStore` and overrides `Complete` with a map of scripted failures. It works, but it has a weakness. It inherited every other method, so it can only fail in the ways its author imagined; and when `Store` grows a ninth method, the fake silently gains it from the embedded store — nothing stops the build, and nothing asks how the fake should answer. The generated mock closes that gap: its `var _ Store = &StoreMock{}` check stops the build until the mock is regenerated.

A **mock** is a fake generated from the interface itself: one scriptable function field per method, filled in only where needed. The generator is a tool called `moq`. As always, the test moves first. Open `internal/store/store_test.go` and find `TestCompleteAll`. Replace the setup that builds the `fakeStore` with this:

<!-- verify: internal/store/store_test.go at=lint -->
```go title="internal/store/store_test.go"
			// StoreMock scripts the failure the real store cannot produce.
			// Add and List delegate to a real store, and Complete passes
			// everything except the scripted id through: id 1 must really
			// succeed and id 3 must really be ErrNotFound.
			real := NewMemoryStore()
			s := &StoreMock{
				AddFunc:  real.Add,
				ListFunc: real.List,
				CompleteFunc: func(id int) error {
					if id == 2 {
						return errBoom
					}
					return real.Complete(id)
				},
			}
```

Three methods are scripted: `Add` and `List` delegate to a real store, and `Complete` passes everything through except id 2, which returns the scripted `errBoom`. The other five methods are left unset. The two `s.Add` lines below the setup, and every assertion under them, stay exactly as they are.

Run the tests:

```bash
$ go test -count=1 ./...
# todo/internal/store [todo/internal/store.test]
internal/store/store_test.go:508:10: undefined: StoreMock
ok  	todo/cmd/todo	0.002s
FAIL	todo/internal/store [build failed]
ok  	todo/internal/task	0.003s
FAIL
```

The store's test binary does not build: `undefined: StoreMock`. The test names a type that does not exist yet — the same `undefined:` shape as the book's first failing test. Only one package is broken; the other two compiled and passed. The old `fakeStore` is still at the bottom of the file, unused — Go allows unused types, so nothing complains yet.

Now tell Go how to produce the missing type. `go generate` is a small part of the toolchain: it walks the packages you name, finds special comment lines that begin `//go:generate`, and runs each command. Add this line to the doc comment of `Store`, in `internal/store/store.go`:

<!-- verify: internal/store/store.go at=lint -->
```go title="internal/store/store.go"
// Store is the persistence contract the rest of the application depends on.
//
//go:generate go run github.com/matryer/moq@v0.8.0 -pkg store -out store_moq_test.go . Store
type Store interface {
	Add(t task.Task) task.Task
	List() []task.Task
	ByStatus(status task.Status) []task.Task
	ByTag(tag string) []task.Task
	CountByTag() map[string]int
	Tags() []string
	SortByDue() []task.Task
	Complete(id int) error
}
```

The directive reads like a sentence: run the tool `github.com/matryer/moq@v0.8.0`, name the output's package `store`, write the result to `store_moq_test.go`, read the package in this folder (`.`), and mock the interface `Store`. The version is pinned in the command itself.

Ask `go generate` to do its work:

```bash
$ go generate ./...
```

Silence is success: a generator with nothing to say prints nothing. To watch it work, run it again with `-x`, which prints each command as it runs:

```bash
$ go generate -x ./...
go run github.com/matryer/moq@v0.8.0 -pkg store -out store_moq_test.go . Store
```

One line — the directive, expanded into the command it ran. `go generate` is not a shell, and a box at the end of the lesson explains what that means.

Now open the file that appeared. `internal/store/store_moq_test.go` was written entirely by the tool, and its first lines say so:

<!-- verify: internal/store/store_moq_test.go at=lint -->
```go title="internal/store/store_moq_test.go"
// Code generated by moq; DO NOT EDIT.
// github.com/matryer/moq

package store

import (
	"sync"
	"todo/internal/task"
)

// Ensure, that StoreMock does implement Store.
// If this is not the case, regenerate this file with moq.
var _ Store = &StoreMock{}
```

The `DO NOT EDIT` marker is a convention Go tools understand: it means a machine wrote this file, and `generated: strict` uses it to skip the file. The `var _ Store = &StoreMock{}` line is a promise to the compiler — if `Store` ever grows a method, this line stops compiling until the mock is regenerated.

Below the header, every method gets a `Func` field and a small recording wrapper. Here is `Complete`:

<!-- verify: internal/store/store_moq_test.go at=lint -->
```go title="internal/store/store_moq_test.go"
// Complete calls CompleteFunc.
func (mock *StoreMock) Complete(id int) error {
	if mock.CompleteFunc == nil {
		panic("StoreMock.CompleteFunc: method is nil but Store.Complete was just called")
	}
	...
	return mock.CompleteFunc(id)
}
```

The pattern repeats for all eight methods: calling the mock runs the matching `Func` field and records the call. If a test calls a method whose `Func` is still nil, the mock panics and names the method — a loud failure beats a stand-in that answers with zero values and lets a test pass by accident.

Now delete the old fake at the bottom of `store_test.go`:

```diff
-// fakeStore inherits the real behavior from MemoryStore and scripts failures
-// for chosen ids — simulating errors the real store cannot produce.
-type fakeStore struct {
-	*MemoryStore
-	failComplete map[int]error
-}
-
-func (f *fakeStore) Complete(id int) error {
-	if err, ok := f.failComplete[id]; ok {
-		return err
-	}
-	return f.MemoryStore.Complete(id)
-}
```

Then run the tests:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.004s
ok  	todo/internal/task	0.004s
```

All three packages pass, with every assertion untouched. Each id is still tested for what it is: id 1 really completes through the real store, id 2 returns the scripted `errBoom`, and id 3 is genuinely `ErrNotFound`, wrapped by the real store. Only the stand-in changed — and this one was written by a program, from the interface.

:::tip
Never edit a generated file by hand. If the mock is wrong, the interface or the directive is wrong; change one of those and run `go generate ./...` again.
:::

## Run the whole set

Four commands now watch the code from four angles. Run them from the app's root:

```bash
$ go vet ./...
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
0 issues.
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.004s
ok  	todo/internal/task	0.004s
$ gofmt -l .
```

All four are quiet. `go vet` found nothing suspicious, the linter reports zero findings, every test passes, and the formatter has nothing to tidy. Quiet is what success sounds like from this set: vet checks correctness, the linter checks the policy we wrote down, the tests check behavior, and `gofmt` checks the layout. None of them replaces the others — that is why we run all four.

## If something went wrong

**The tests will not build: `undefined: StoreMock`.** This is the expected failure: the test names a type that does not exist yet. `go vet` reports the same missing name in its own words:

```bash
$ go vet ./...
# todo/internal/store
# [todo/internal/store]
vet: internal/store/store_test.go:508:10: undefined: StoreMock
```

The fix: add the directive to `store.go` and run `go generate ./...`. If the name is still missing, check three things: the directive sits in a comment directly above `type Store interface`, it begins with exactly `//go:generate`, and the generated file landed in `internal/store/`, next to `store.go`.

**`gofmt -l .` lists a file.** One file is not in Go's layout:

```bash
$ gofmt -l .
internal/store/store_test.go
```

The usual cause is a stray blank line at the end of the file; `internal/store/store_test.go` had gained one. Open the file, delete the blank line, save, and run `gofmt -l .` again. Silence means the whole project is tidy.

**The linter reports `0 issues.` on code you know drops an error.** You added a silencing rule to make a finding go away:

```yaml
    presets: [std-error-handling]
```

Run the linter again and the finding is gone:

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
0 issues.
```

The preset matches findings by function name — anything containing `print` — so errcheck's report about `fmt.Fprintf` disappears without being fixed. The rule cannot tell a best-effort write from one whose error matters. The fix: keep `presets: []` and fix the code, not the config.

<details>
<summary>Going deeper: what the generated mock really is</summary>

Each of the eight methods gets three pieces: a `Func` field the test can fill in, a wrapper that appends the call's arguments to a per-method list under a lock, and a `Calls()` method that hands the list back for assertions. The lock is why the mock is safe to share between parallel subtests, and the recorded calls are why a test can ask not just what the mock answered, but what it was asked.

The panic on an unset `Func` is a feature. A mock that returned zero values for unscripted methods would let a test pass while quietly exercising a method nobody configured — a passing result that means less than it looks. And the file's `_test.go` name is the other half of the design: the mock compiles only into the test binary, never into the app.

What the generator buys is not fewer lines. It is an interface contract the compiler enforces: `var _ Store = &StoreMock{}` fails the build the moment `Store` grows a method, and the fix is one command.

</details>

<details>
<summary>Going deeper: `go generate` is not a shell</summary>

A directive's arguments are split on spaces and handed straight to the program. There is no shell in between, so pipes, redirection, and file globs do not work. The only variables that expand are environment variables written `$NAME` or `${NAME}`; `$(...)` is passed through as literal text. Three directives in a scratch module, with `FOO_VERSION=v9.9.9` in the environment, show the difference:

```text
literal: $(FOO_VERSION)
bare: v9.9.9
braced: v9.9.9
```

An environment variable could hold the tool's version, but then a plain `go generate ./...` would need that variable set, and the directive would stop working on its own. The pin is written literally in the directive instead, so the directive is complete by itself.

</details>

<details>
<summary>Going deeper: why the version rides in the command</summary>

`go run tool@vX.Y.Z` downloads that exact version into Go's module cache, builds it, and runs it. Nothing is installed, nothing needs upgrading, and the project's `go.mod` keeps describing the app's dependencies rather than its tools. The version is visible in the command that produced a finding. The first run pays to compile the tool, and the caches make every run after that quick.

</details>

The code is now watched by tools that read it the way a careful reviewer would, and one stand-in writes itself from the interface it imitates. Next, the book turns to what the code does when more than one thing runs at once.
