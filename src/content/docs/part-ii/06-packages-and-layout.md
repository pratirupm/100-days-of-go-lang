---
title: Organizing the code
description: Move the app's packages under internal/ and add the first runnable command — written test-first.
sidebar:
  order: 6
---

The app now has two packages: `task`, which knows what a task is, and `store`,
which keeps a list of them. Both are folders at the top of the project, right
beside `go.mod`. Two is a manageable number — but the top of a project is a
place that should stay easy to read.

Today it gets a shape. The app's own packages move into a folder named
`internal` — Go's way of saying "private to this project". And the project
gets its first runnable program: a command called `todo` that prints the task
list.

We write the command's test first, as always. This time the test shows us
something new: how a whole program gets tested, not just a single function.

## Write the command's test first

A runnable program in Go starts with a package named `main` and a function
named `main` inside it. When the program runs, that function is the first
thing Go calls, and everything else hangs off it.

Runnable programs live in a folder named `cmd`, one folder per command. Our
command is called `todo`, so its folder is `cmd/todo`. Create it:

```bash
$ mkdir -p cmd/todo
```

`mkdir` makes a folder, and `-p` lets it create the whole path at once — the
`cmd` folder doesn't exist yet, and without `-p` this command would refuse.

Now create `cmd/todo/main_test.go`, with this content:

<!-- verify: cmd/todo/main_test.go at=project-layout -->
```go title="cmd/todo/main_test.go"
package main

import (
	"bytes"
	"testing"
)

func TestRun(t *testing.T) {
	var out bytes.Buffer
	if err := run(&out); err != nil {
		t.Fatalf("run: %v", err)
	}
	want := "1. [Done] buy milk\n2. [Todo] write the book\n"
	if got := out.String(); got != want {
		t.Errorf("run output = %q, want %q", got, want)
	}
}
```

Three details carry the weight here. `package main` means the test lives
inside the same package as the code it tests — which is how it can call
`run`, a name that starts lowercase and stays private to the package. `var
out bytes.Buffer` makes a place in memory that collects text; the test hands
it to `run`, then reads what `run` wrote. And `want` pins the entire output
as one string — numbers, statuses, newlines and all.

The most important detail is that `run` doesn't exist yet. Run the test:

```bash
$ go test ./...
# todo/cmd/todo [todo/cmd/todo.test]
cmd/todo/main_test.go:10:12: undefined: run
FAIL	todo/cmd/todo [build failed]
ok  	todo/store	(cached)
ok  	todo/task	(cached)
FAIL
```

Read the failure in order. The first line names the package and the build
that failed — the test binary. `undefined: run` means Go looked for a
function called `run` and couldn't find one, and `main_test.go:10:12` is line
10, column 12, where the name appears. `[build failed]` means the test never
ran at all: the package could not be put together without `run`.

The last two lines are old friends, and they carry the day's clue. The
`store` and `task` tests still pass, and their paths are still `todo/store`
and `todo/task` — the packages haven't moved yet. `(cached)` means Go reused
the result of a previous run, because nothing inside those packages changed.

## Move the app's packages under `internal/`

An **import path** is how one package names another. Our project is a module
called `todo`, so a folder named `task` holds a package imported as
`todo/task` — the module name, a slash, the folder path.

Not every package is meant for other people's programs. `task` and `store`
are this app's own machinery: they exist to serve it, and we want to stay
free to change them. If other projects could import them, those projects
would come to depend on details we might change tomorrow.

Go has a word for "ours, private": a folder named `internal`. Code under
`internal/` can be imported only by code from the same project. It is not a
promise people make — Go checks the rule itself and refuses any import from
outside. The move costs one thing: import paths get longer.

Make the folder and move both packages into it:

```bash
$ mkdir internal
$ mv task internal/task
$ mv store internal/store
```

`mv` moves a folder — and everything inside it, tests included — to a new
place. After these three commands, the task package is imported as
`todo/internal/task`, and the store as `todo/internal/store`.

A moved folder breaks every line that names the old path. Two files in the
store package name `todo/task`, and each needs exactly one line updated. In
`store.go` it reads:

<!-- verify: internal/store/store.go at=project-layout -->
```go title="internal/store/store.go"
import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"time"

	"todo/internal/task"
)
```

The blank line keeps the project's own imports apart from the standard
library — a habit you'll see in every Go file. In `store_test.go` the same
single line changes:

<!-- verify: internal/store/store_test.go at=project-layout -->
```go title="internal/store/store_test.go"
import (
	"errors"
	"strings"
	"testing"
	"time"

	"todo/internal/task"
)
```

The `task` package itself needs no edits: it imports only the standard
library, so its two files move as they are.

Do all of this before running the tests again, because halfway through the
project does not build: `internal/store` would be importing a `todo/task`
that no longer exists. The move and the import lines are one change, not two.

## Give the command its code

The test wants a function called `run`, so `cmd/todo/main.go` starts with the
part of the program that names it. Create the file with the content below —
we'll take it in two pieces. First the top:

<!-- verify: cmd/todo/main.go at=project-layout -->
```go title="cmd/todo/main.go"
// Command todo is the todo application's CLI. For now it is a walking
// skeleton; the real commands arrive in Part VI.
package main

import (
	"fmt"
	"io"
	"os"

	"todo/internal/store"
	"todo/internal/task"
)

func main() {
	if err := run(os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

The comment above `package main` starts with "Command todo". That's the
convention for a command's doc comment, and Go can show it without anyone
opening the file:

```bash
$ go doc ./cmd/todo
Command todo is the todo application's CLI. For now it is a walking skeleton;
the real commands arrive in Part VI.
```

The comment calls `todo` a CLI — short for command-line tool, a program you
run from the terminal.

`main` does three small jobs and nothing else. It hands `run` the terminal
itself — `os.Stdout`, where normal output goes. If `run` reports an error,
`main` prints it to `os.Stderr`, where error messages belong, and exits with
code 1 — a signal to whatever started the program that something went wrong.
The real work lives in `run`, one step away.

Now the second piece, the function that does the work:

<!-- verify: cmd/todo/main.go at=project-layout -->
```go title="cmd/todo/main.go"
// run seeds two tasks, completes the first, and prints the list.
func run(w io.Writer) error {
	s := store.NewMemoryStore()
	for _, title := range []string{"buy milk", "write the book"} {
		t, err := task.NewTask(title)
		if err != nil {
			return err
		}
		s.Add(t)
	}
	if err := store.CompleteAll(s, []int{1}); err != nil {
		return err
	}
	for _, t := range s.List() {
		fmt.Fprintf(w, "%d. %s\n", t.ID, t)
	}
	return nil
}
```

`run` takes `w io.Writer` and returns an error. An `io.Writer` is any value
you can write text into: the terminal is one, and the test's `bytes.Buffer`
is another. That is the whole trick behind the test — production hands `run`
the terminal, the test hands it a buffer, and `run` cannot tell the
difference.

The body is everything the app can do so far, in one flow. It builds an
empty store, then loops over two titles: `task.NewTask` validates each one,
and `s.Add` stores it with an ID. It completes task 1 with
`store.CompleteAll(s, []int{1})`. Then it prints every task with
`fmt.Fprintf(w, "%d. %s\n", t.ID, t)` — `%d` is the ID, and `%s` calls the
task's `String` method, which formats it as `[Done] buy milk`.

Two seeded tasks may look like a strange program. It is a **skeleton**: the
smallest program that proves every piece connects — validation, storing,
completing, formatting, printing. The real commands arrive later in the book.

## Run the skeleton

Run the tests again:

```bash
$ go test ./...
ok  	todo/cmd/todo	0.002s
ok  	todo/internal/store	0.002s
ok  	todo/internal/task	0.002s
```

Three packages, three paths, everything passing. The store and task tests are
the same tests that passed before the move — same behavior, new address.
That's what a layout change should feel like: nothing changes except where
things live.

Now run the program itself:

```bash
$ go run ./cmd/todo
1. [Done] buy milk
2. [Todo] write the book
```

`go run` compiles the command and runs it in one step, and leaves no file
behind. The output is the skeleton walking: two tasks, the first completed,
each printed with its number and status.

One last command:

```bash
$ go build ./...
```

`go build ./...` compiles every package in the project and writes nothing; it
stays silent when everything builds. Where `go test ./...` asks "does
everything behave?", this asks "does everything compile?" — and the project
now has a shape worth reading: `cmd/` for the runnable command, `internal/`
for the app's private packages, `go.mod` at the top.

## If something went wrong

**The path names a folder that isn't there.** `go build ./cmd/tdo` reports:

```text
stat …/cmd/tdo: directory not found
```

After `./`, Go treats the rest as a path on disk, so a typo is a missing
folder, not a missing package. Check the spelling — `ls cmd` shows the folder
is called `todo` — and run the command again.

**An import line didn't move with its folder.** Go reports:

```text
cmd/todo/main.go:11:2: package todo/task is not in std (/usr/lib/golang/src/todo/task)
```

The project has no `todo/task` anymore, so Go falls back to searching the
standard library and reports a path that never existed there either. The fix
is to point the import at `todo/internal/task`. The `file:line` at the front
names each straggler in turn; fix them all and the error disappears. (The
path in parentheses belongs to the reference machine's Go installation —
yours will differ.)

**Two packages import each other.** Go refuses with:

```text
package todo/cmd/todo
	imports todo/internal/store from main.go
	imports todo/internal/task from store.go
	imports todo/internal/store from task.go: import cycle not allowed
```

This happens if `task` grows code that reaches for `store`, while `store`
already imports `task` — the chain closes on itself, and no file's code even
gets compiled. Keep the direction: `task` is the bottom of this pair, and
storage-flavored code belongs in `store`. Read the message as the full chain,
ending with the file that closes the loop.

<details>
<summary>Going deeper: what the packages import from each other</summary>

Ask Go to draw the project's package graph:

```bash
$ go list -f '{{.ImportPath}} -> {{join .Imports " "}}' ./...
todo/cmd/todo -> fmt io os todo/internal/store todo/internal/task
todo/internal/store -> cmp errors fmt slices time todo/internal/task
todo/internal/task -> fmt strings time
```

`a -> b` reads "a imports b". The command imports the standard library plus
the project's two packages; the store imports `task`, because it stores
tasks; `task` imports only the standard library. Every arrow points one way —
nothing points back up, which is exactly what keeps the compiler happy.

The flat view lists every package the command needs, dependencies first:

```bash
$ go list -deps ./cmd/todo
internal/goarch
unsafe
internal/abi
...
fmt
strings
todo/internal/task
todo/internal/store
todo/cmd/todo
```

That's a trimmed version — the full list is about seventy lines. The top is
Go's own runtime, the middle is the standard library, and the bottom three
are ours. A package appears only after everything it imports, which is why
`todo/internal/task` comes before `todo/internal/store`, and both come before
the command.

</details>

<details>
<summary>Going deeper: what `internal` refuses</summary>

The `internal` rule is enforced by Go itself, not by politeness. A different
project — a module of its own — that tried to import `todo/internal/task`
would be told:

```text
package othermod
	main.go:3:8: use of internal package todo/internal/task not allowed
```

Every package inside our project may still import it; the path is simply
longer. If we ever publish a package for other projects to use, it will live
outside `internal/` — a deliberate, visible choice.

</details>

The shape is settled; next, the store learns a few more questions to answer.
