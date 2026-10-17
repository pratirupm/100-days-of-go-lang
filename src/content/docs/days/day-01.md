---
title: "Day 1 — The first test"
description: "Set up the project and write your first test — before the code it tests exists."
sidebar:
  order: 1
chapter: 1
---

**About 1.5 hours** · Part I, day 1 of 4.

**You'll be able to:**

- have the `todo` module and a test that passes — written before the code it tests;
- know the loop every chapter runs: write the test, watch it fail, make it pass.

---

Every application starts with an empty folder. Ours is called `todo`, and by
the end of the book it will hold a complete todo app: a command-line tool, a
web API, and a browser interface. Today it gets two small files and a habit.

The habit is this: **write the test first**. A test is just a small piece of
code that checks another piece of code. Writing it before the real code feels
backwards, but it means you decide what the code should do before you write
it — and you find out immediately when it doesn't.

Let's start with the folder.

## Set up the project

Open a terminal and create a folder for the project. Put it wherever you keep
your work; the location doesn't matter.

```bash
$ mkdir todo
$ cd todo
```

`mkdir` creates the folder and `cd` moves your terminal into it. Every
command from here on runs from inside this folder.

Next, check that Go is installed, and ask it to set up the project:

```bash
$ go version
go version go1.26.8-X:nodwarf5 linux/amd64
$ go mod init todo
go: creating new go.mod: module todo
```

The `-X:nodwarf5` part is a detail of the machine this book was built on;
yours will look slightly different. What matters is 1.26 or newer. The second
command turns the folder into a **Go module** and creates one file, `go.mod`,
that records the project's name:

```text title="go.mod"
module todo

go 1.26.8
```

The first line names the module — `todo`, matching the folder. The second
records the version of Go you're running, so yours will show your own
version. A module is Go's way of saying "this folder is a project", and the
`go` command reads that file to understand where the project begins.

## What we're building

The app's job is to track tasks, and every task has a title — the text you'd
write on a sticky note. In Go, a bundle of values like that is called a
**struct**, and we'll name ours `Task`. A second function, `New`, will build
one from a title.

We could write those two things right now; they're a few lines. But we won't.
First, we write the test that says what they must do.

## Write the test first

Create a folder called `task` inside `todo`. This is where the app's core
code will live:

```bash
$ mkdir task
```

Now create a file inside it called `task_test.go`, with this content:

<!-- verify: task/task_test.go at=toolchain -->
```go title="task/task_test.go"
package task

import "testing"

func TestNew(t *testing.T) {
	got := New("buy milk")
	if got.Title != "buy milk" {
		t.Errorf("New(%q).Title = %q, want %q", "buy milk", got.Title, "buy milk")
	}
}
```

There's a lot to take in, so let's walk through it:

- `package task` — every file in the folder belongs to the same **package**,
  and `task` is its name.
- `import "testing"` — pulls in Go's built-in testing toolkit.
- `func TestNew(t *testing.T)` — a test is a function whose name starts with
  `Test`. The `t` is how a test reports problems.
- `got := New("buy milk")` — asks for a task titled `"buy milk"` and stores
  the result in `got`.
- The `if` checks that the task's `Title` is what we asked for, and
  `t.Errorf` reports a problem if it isn't.

One detail is worth staring at: `New` doesn't exist yet. We're calling a
function we haven't written. That's exactly the point — the test comes first.

:::note
A test that fails before the code exists isn't a mistake. It's the first half
of the process, and it tells us precisely what to write next.
:::

## Watch it fail

Run the tests:

```bash
$ go test ./...
# todo/task [todo/task.test]
task/task_test.go:6:9: undefined: New
FAIL	todo/task [build failed]
FAIL
```

It fails — exactly as it should. Read the message: `undefined: New` means Go
looked for a function called `New` and couldn't find one. It even points at
the line that mentions it — `task/task_test.go:6:9` is line 6, column 9.

The last two lines say the package failed to build, which means the test
never ran. Nothing is broken; the project is simply missing the code we
haven't written yet.

## Make it pass

Now the code. Create `task/task.go`:

<!-- verify: task/task.go at=toolchain -->
```go title="task/task.go"
// Package task defines the todo domain type.
package task

// Task is a single todo item.
type Task struct {
	Title string
}

// New returns a task with the given title.
func New(title string) Task {
	return Task{Title: title}
}
```

That's the whole file. Two parts matter:

- `type Task struct { Title string }` defines the shape: a task has a title,
  and a title is text. In Go, text is a `string`.
- `func New(title string) Task` is the function our test called. It takes a
  title and returns a `Task` carrying that text.

The lines starting with `//` are comments — notes for humans. Go's convention
is that every name meant to be used from other code gets one, and we'll
follow that convention from the very first file.

## Run it again

```bash
$ go test ./...
ok  	todo/task	0.002s
```

`ok` means every test in the package passed. The line names the package, and
the number is how long the run took.

That's the cycle — write the test, watch it fail, make it pass — and it's the
same cycle for every piece of the app from here on. The next piece: giving
tasks more than a title.

## If something went wrong

**`undefined: New` even though you wrote `task/task.go`.** Go can't see the
function. Check three things: the file is saved, it opens with `package task`,
and the function is spelled with a capital N.

**`[no test files]`.** `go test` decides what counts as a test by the file's
name: it must end in `_test.go`. A file called `tasktest.go` is ordinary
code, and Go won't look inside it for tests.

**`found packages task and main in ...`.** Every file in a folder must
declare the same package. If `task_test.go` starts with `package main`,
change it to `package task`.

<details>
<summary>Going deeper: what exactly is a module, and what's a package?</summary>

A **module** is a project with a name. The name matters twice: it becomes the
prefix for importing the project's own code, and it gives Go a boundary —
everything inside the folder tree belongs to the module. The `go.mod` file at
the root is what makes a folder a module.

A **package** is a folder of Go files that work as one unit. Every file in the
folder opens with the same `package` line, and other code uses the package by
importing its path. Our module is `todo` and the folder is `task`, so the
package is imported as `todo/task`. Packages are how Go keeps large programs
organized; we'll meet more of them as the app grows.

</details>

<details>
<summary>Going deeper: why are `Task` and `New` capitalized?</summary>

In Go, capitalization is visibility. A name that starts with a capital letter
can be used from outside its package; a name in lowercase is private to the
package. `Task` and `New` are meant to be used by the rest of the app, so
they're capitalized. The field inside — `Title` — is capitalized for the same
reason.

</details>

<details>
<summary>Going deeper: why write the test first?</summary>

Because it flips the order of the decisions. When the test comes first, you
decide what the code should do *before* you write it — and the test holds you
to that decision. It also gives you a safety net for later: when the code
changes, the test tells you immediately if the behavior broke. This book runs
on that cycle because it's how the app was built, and it's how you'll build
yours.

</details>

<div class="day-tracker" data-day="1"></div>
