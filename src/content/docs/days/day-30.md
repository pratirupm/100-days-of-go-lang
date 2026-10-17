---
title: "Day 30 — A command-line tool"
description: "Give the app its real commands — add, list, done, stats, and import — built as a cobra tree that tests can drive."
sidebar:
  order: 30
chapter: 25
---

**About 3 hours** · Part VI, day 1 of 5.

**You'll be able to:**

- build a command tree with cobra: add, list, done, and friends;
- test the commands and read the help they print.

---

The app can hold tasks in a database, but the only way to reach them is
`cmd/todo/main.go`: a skeleton that seeds two tasks of its own and prints the
list. Nobody can add a task, finish one, or ask for a count. Today the app
becomes a tool a person actually uses.

You have used tools with this shape all along. In
`go test -run TestAdd ./internal/cli`, `go` is the program and `test` says
what to do — a **subcommand**. `-run TestAdd` is a **flag**, a named setting,
and `./internal/cli` is an argument: a value that stands on its own.

Our tool gets the same shape. `todo` is the program, and `add`, `list`,
`done`, `stats`, and `import` are the subcommands.
`todo add "buy milk" --due tomorrow` should store a task and print its id,
`todo list` should show every task, and `todo done <id>` should mark one
finished. The id is the handle: `add` prints it, and the other commands take
it.

We won't parse that shape by hand. A **library** — a package someone else
wrote and published — called cobra builds it, the way the database driver
came from somewhere else. By the end, every command is real, and a test can
run the whole tool as ordinary Go code.

## The shape of a command

A command-line program is a tree. The program's name is the root — `todo` —
and each subcommand is a branch: `todo add`, `todo list`. In cobra, the root
is a command too, and the tree grows with `AddCommand`: the root gets its
five children, and each child knows its own name, its description, and the
function that runs it.

Two kinds of input travel beside the command names. A **positional
argument** is the command's subject — the title in `add "buy milk"`, the id
in `done <id>`, the file in `import <path>` — and there is exactly one each.
A **flag** is a named setting, written with dashes: `--due tomorrow`,
`--priority 5`, `-h` for help. Flags are optional; the argument is not.

A cobra command is a struct we fill in. `Use` is how the command is called;
`Short` and `Long` are its one-line and full descriptions; `Args` checks how
many arguments arrived; `RunE` is the function that does the work. The `E`
stands for error — `RunE` returns one, and that error travels up to the one
place that prints it.

That last point is the tool's contract with the terminal. Success exits with
code 0; failure exits non-zero and prints one line to **stderr**, the stream
reserved for errors. Normal output goes to **stdout**. When a test runs the
tree, both streams are just buffers, and the returned error stands in for the
exit code.

## The tests come first

The tests come before the tool, as always. Create the folder `internal/cli`
and, inside it, `cli_test.go`. It opens as an **external test package** —
`package cli_test`, not `package cli` — so it can touch only what the
constructor hands over: the store, the writers, the arguments. The finished
app's appendix holds this file in full — read the parts behind the `...`
there as you type them.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
package cli_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/cli"
	"todo/internal/store"
	"todo/internal/task"
)
```

The import list is the case file's toolbox: buffers to capture output, the
store and the domain, testify's assertions, and the file and time helpers the
later cases use.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
// ...
func runCLI(t *testing.T, st store.Store, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	root := cli.New(st, &out, &errOut)
	root.SetArgs(args)
	err = root.ExecuteContext(context.Background())
	return out.String(), errOut.String(), err
}
```

`runCLI` is the seam every case shares: build a fresh tree around the store,
point it at the arguments, run it, and hand back what it printed plus the
error. No separate process, no `os.Stdout`, no state left between cases.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
// seedTask stores one task with each mutate applied and returns the stored
// copy: the snapshot with the id and version the CLI reads back.
func seedTask(t *testing.T, s store.Store, title string, mutate ...func(*task.Task)) task.Task {
	t.Helper()
	tt, err := task.NewTask(title)
	require.NoError(t, err)
	for _, m := range mutate {
		m(&tt)
	}
	stored, err := s.Add(context.Background(), tt)
	require.NoError(t, err)
	return stored
}

// due2026 is the fixed due date the deterministic cases share.
var due2026 = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
```

`seedTask` stores one task and returns the stored copy — the snapshot with
the id and version the commands read back — and `due2026` is the fixed date
the deterministic cases share.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
func TestAdd(t *testing.T) {
	t.Parallel()

	t.Run("args and flags land in the stored task", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		out, _, err := runCLI(t, st, "add", "buy milk", "--due", "2026-11-01", "--priority", "5", "--tag", "home", "--tag", "work")
		require.NoError(t, err)

		list, err := st.List(context.Background())
		require.NoError(t, err)
		require.Len(t, list, 1)
		got := list[0]
		assert.Equal(t, "buy milk", got.Title)
		assert.Equal(t, task.StatusTodo, got.Status)
		assert.Equal(t, task.PriorityMax, got.Priority)
		assert.Equal(t, due2026, got.Due)
		assert.Equal(t, []string{"home", "work"}, got.Tags)
		assert.Equal(t, got.ID.String()+"\n", out, "add prints the id the store assigned")
	})

	t.Run("--due tomorrow parses", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		_, _, err := runCLI(t, st, "add", "call mom", "--due", "tomorrow")
		require.NoError(t, err)

		list, err := st.List(context.Background())
		require.NoError(t, err)
		require.Len(t, list, 1)
		got := list[0]
		// ParseDue resolves "tomorrow" against the command's own time.Now,
		// so the expected date is one of two: the test's tomorrow, or its
		// today when midnight crossed between the command and this check.
		now := time.Now().UTC()
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		assert.Contains(t, []time.Time{today, today.AddDate(0, 0, 1)}, got.Due)
	})
}
```

The first case runs `add` the way a person would — a title, a due date, a
priority, and two labels — and checks both halves of the promise: the values
land in the stored task, and the printed line is the id the store assigned.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
// TestAdd_InvalidDue pins that a due date the domain refuses fails the
// command and leaves the store untouched.
func TestAdd_InvalidDue(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	_, _, err := runCLI(t, st, "add", "buy milk", "--due", "not-a-date")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unrecognized date")

	list, err := st.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list, "a bad due date adds nothing")
}
```

The next case hands `add` a date the domain refuses. The message comes from
`task.ParseDue`, not from the CLI — the command writes no rules of its own —
and the store stays empty.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
	t.Run("unknown id is ErrNotFound and names the id", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		missing := uuid.MustParse("00000000-0000-0000-0000-000000000042")

		_, _, err := runCLI(t, st, "done", missing.String())
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.Contains(t, err.Error(), missing.String())
	})
```

This case in `TestDone` checks the other end of the write: an id no task
carries comes back as the store's `ErrNotFound`, and the message names the
id, because a person needs to see which handle was wrong.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
// v3Doc is a minimal version-3 document: the current format, two tasks.
const v3Doc = `{"version":3,"tasks":[
	{"ID":"0199c0de-0000-7000-8000-000000000001","Title":"write tests","Status":"Todo","Priority":3,"Version":1},
	{"ID":"0199c0de-0000-7000-8000-000000000002","Title":"review code","Status":"Done","Priority":5,"Version":2}
]}`

// writeTempFile writes content to a file in a test-owned directory and
// returns its path.
func writeTempFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.json")
	require.NoError(t, os.WriteFile(path, []byte(content), 0o600))
	return path
}
```

`v3Doc` is a whole interchange document in the format the export work
pinned, and `writeTempFile` puts any document on disk where the import
command can open it.

<!-- verify: internal/cli/cli_test.go at=cli-commands -->
```go title="internal/cli/cli_test.go"
	t.Run("a v3 document is imported and counted", func(t *testing.T) {
		t.Parallel()

		path := writeTempFile(t, v3Doc)

		st := store.NewMemoryStore()
		out, _, err := runCLI(t, st, "import", path)
		require.NoError(t, err)
		assert.Equal(t, "imported 2 tasks\n", out)

		list, err := st.List(context.Background())
		require.NoError(t, err)
		assert.Len(t, list, 2)
	})
```

The import case proves the whole road: a file on disk, two tasks in the
store, and the printed count. One more case feeds the importer a document
with a missing closing bracket and checks the store is still empty — the
import is all-or-nothing, as the importer promised.

The rest of the file follows the same shape. `TestList` seeds three tasks —
one with a due date and a label, one plain, one already done — and pins the
exact lines plain `list` prints, then the same for each filter. `TestStats`
pins the totals block. Every case gets its own store and its own tree, so
they can run in parallel without touching each other.

## Watch them fail

Run the tests:

```bash
$ go test -count=1 ./...
todo/internal/cli: no non-test Go files in …/internal/cli
ok  	todo/cmd/todo	0.004s
FAIL	todo/internal/cli [build failed]
ok  	todo/internal/db	0.018s
ok  	todo/internal/store	0.083s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.005s
FAIL
```

The message is honest and a little odd: the go tool never gets as far as
`undefined: cli.New`. The import has no package behind it, so the build stops
at the folder — `no non-test Go files` is the compiler saying it found only
the test. And `cmd/todo` still passes, because the skeleton hasn't been
touched yet.

## Add cobra

cobra is not in the project yet. From the app's root folder:

<!-- transcripts: authored -->
```bash
$ go get github.com/spf13/cobra@v1.10.2
$ go mod tidy
```

`go get` adds the library to `go.mod`, the file that records the project's
dependencies, and `go mod tidy` fills in and prunes the rest. One direct
dependency arrives — cobra v1.10.2 — with two companions marked indirect:
pflag v1.0.9, the flag parser underneath it, and mousetrap v1.1.0, a small
Windows console helper.

<!-- verify: go.mod at=cli-commands -->
```text title="go.mod"
require (
	github.com/gkampitakis/go-snaps v0.5.23
	...
	github.com/spf13/cobra v1.10.2
	...
)
```

cobra lands in the first `require` block, beside the dependencies already
there; the two indirect companions appear in the second.

## The tree is one function

Everything lives in `internal/cli/cli.go`. The finished app's appendix holds
this file in full; the pieces quoted here are the ones that carry the idea.
It opens with the package's job description:

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
// Package cli builds the todo command tree: the thin layer that parses
// arguments, calls the store, and formats what it reads. The tree is built
// around its dependencies — a store and two writers — instead of reaching for
// globals, so the commands are exercised in-process and the wiring stays in
// cmd/todo.
package cli
```

Parsing, store calls, and formatting — everything a command does — live in
this package, and the wiring stays in `cmd/todo`.

`New` builds the whole tree from its three dependencies: the store and two
writers.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
// New builds the todo command tree around a store. Output goes to out and
// errOut so tests can capture it.
func New(s store.Store, out, errOut io.Writer) *cobra.Command {
	root := &cobra.Command{
		Use:   "todo",
		Short: "A small todo list for the terminal",
		Long: `todo keeps a task list in a local Turso database.

Tasks have an id, a title, a status, a priority, an optional due date, and
tags. add prints the new task's id; that id is the handle the other commands
take.`,
		// Cobra's defaults are built for a program that lets cobra report
		// its own errors, and this one does not: main prints the error
		// once. SilenceErrors stops cobra from printing it too — without
		// it, every failure is printed twice — and SilenceUsage stops a
		// runtime failure like a bad id from dumping the full usage text
		// on top of the one error line.
		SilenceUsage:  true,
		SilenceErrors: true,
	}
```

`Use` is the program's name, `Short` is the one-liner in help, and `Long` is
the paragraph `--help` prints first — help is part of the interface, so it is
written as prose. The two silence fields answer cobra's defaults: cobra would
print a failing command's error itself, with a usage block under it. Our
`main` prints the error once, so both are switched off.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
	// The writers reach cobra's own output too: help and the built-in
	// completion command print to out, so a test can capture those as well.
	root.SetOut(out)
	root.SetErr(errOut)
```

The writers are set on the root, so every child's `cmd.OutOrStdout()`
resolves to `out`. Help and the built-in completion command print through
cobra's own writer, so pointing it at the buffer is what makes them
capturable too.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
	// rm is deliberately absent. Store has no Remove — after Add, the only
	// write the domain knows is Complete — and a delete command cannot be
	// ...
	root.AddCommand(
		newAddCmd(s),
		newListCmd(s),
		newDoneCmd(s),
		newStatsCmd(s),
		newImportCmd(s),
	)
	return root
}
```

The five children are attached here, and each one takes the store as a
parameter — nothing reaches for a global. `rm` is deliberately absent: the
store has no way to remove a task, and a delete command cannot be faked
without lying about what happened. A command that doesn't exist says so:

```bash
$ ./todo rm
unknown command "rm" for "todo"
```

That message comes from cobra, not from us: the tree simply has no `rm`
branch.

## add: one title, three flags

`add` is the first child. One positional title, and three optional settings:
a due date, a priority, and a repeatable label.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
// newAddCmd builds the add command: one positional title, three flags, and
// the store's Add behind them. The flags are validated by the domain — the
// same ParseDue and Priority.Valid every other caller uses — so the CLI
// cannot drift from the rules.
// ...
	cmd := &cobra.Command{
		Use:   "add <title>",
		Short: "Add a task and print its id",
		// ...
		Args: cobra.ExactArgs(1),
		// ...
	}
	cmd.Flags().StringVar(&due, "due", "", `when it is due: "today", "tomorrow", or YYYY-MM-DD`)
	cmd.Flags().IntVar(&priority, "priority", int(task.PriorityDefault), "urgency from 1 (lowest) to 5 (highest)")
	cmd.Flags().StringArrayVar(&tags, "tag", nil, "attach a tag (repeatable)")
	return cmd
}
```

`ExactArgs(1)` is the argument count: `add` with zero titles or two is
refused before the command's function runs. `StringArrayVar` is what makes
the third flag repeatable — each occurrence adds one value, with no
comma-splitting.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
		RunE: func(cmd *cobra.Command, args []string) error {
			t, err := task.NewTask(args[0])
			if err != nil {
				return err
			}
			if cmd.Flags().Changed("due") {
				if t.Due, err = task.ParseDue(due, time.Now()); err != nil {
					return err
				}
			}
			p := task.Priority(priority)
			if !p.Valid() {
				return task.ValidationError{
					Field:   "priority",
					Message: fmt.Sprintf("must be between %d and %d", task.PriorityMin, task.PriorityMax),
				}
			}
			t.Priority = p
			t.Tags = tags

			stored, err := s.Add(cmd.Context(), t)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), stored.ID)
			return err
		},
```

The function is the whole command, and it adds no rules of its own.
`task.NewTask` validates the title; `Changed("due")` asks whether the flag
was given at all — an empty string is a value `ParseDue` rejects, and "not
given" must not become an error; `p.Valid()` is the domain's range check.
`args[0]` is safe because `ExactArgs(1)` already ran, and the last line
prints the store's id through `cmd.OutOrStdout()` — the writer the
constructor wired.

## list: a typed flag and an honest refusal

`list` shows the tasks, optionally filtered. Its status flag is the
interesting one, because the value is checked by the domain while the flag is
being parsed.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
// statusFlag adapts task.Status to pflag.Value, so --status is validated by
// the domain's own UnmarshalText while the flag is parsed and RunE receives a
// typed task.Status. pflag has no encoding.TextUnmarshaler hook, hence the
// three-method wrapper.
type statusFlag struct {
	status task.Status
}

// String returns the flag's current value; pflag prints it as the default.
func (f *statusFlag) String() string { return string(f.status) }

// Set parses one --status occurrence through the domain's UnmarshalText.
func (f *statusFlag) Set(value string) error {
	return f.status.UnmarshalText([]byte(value))
}

// Type names the value type in help: --status status.
func (f *statusFlag) Type() string { return "status" }
```

pflag, the flag parser under cobra, has no hook for Go's text-decoding
interface, so this three-method wrapper hands the value to the domain. `list
--status Nope` fails before any store call, and the command's function
receives a typed `task.Status`.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
			switch {
			case cmd.Flags().Changed("status") && tag != "":
				return errors.New("--status and --tag cannot be combined yet")
			case cmd.Flags().Changed("status"):
				tasks, err = s.ByStatus(ctx, status.status)
			case tag != "":
				tasks, err = s.ByTag(ctx, tag)
			default:
				tasks, err = s.List(ctx)
			}
```

The switch picks the store query. The first arm is a refusal: the store has
no combined query, so the two filters cannot be combined yet. Silently
dropping one would return tasks the user didn't ask for, so the command
refuses instead:

```bash
$ ./todo list --status Done --tag home
--status and --tag cannot be combined yet
```

One line, and the exit code says failure — the same report shape as every
other error.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
// formatTask renders one task for the list command: the id first — the
// handle every other command takes — then the domain's one-line summary,
// ...
func formatTask(t task.Task) string {
	line := fmt.Sprintf("%s  %s", t.ID, t)
	if len(t.Tags) > 0 {
		line += fmt.Sprintf(" (tags: %s)", strings.Join(t.Tags, ", "))
	}
	return line
}
```

`formatTask` builds the line: the id first, because it is the handle, then
the domain's own one-line summary — which already renders the due date — and
the labels when there are any.

## done reads before it writes

`done` marks one task finished. It parses the id, reads the task, and hands
the version it read back to the store.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			id, err := uuid.Parse(args[0])
			if err != nil {
				return fmt.Errorf("done: invalid id %q: %w", args[0], err)
			}
			t, err := findTask(ctx, s, id)
			if err != nil {
				return err
			}
			return s.Complete(ctx, id, t.Version)
		},
```

A bad id is named in the error, and the write carries the version from the
snapshot — the compare-and-swap the store grew.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
// findTask returns the task with the given id from the store's snapshot. It
// exists because Store has no Get: the CLI reads what the interface offers,
// and the version in the returned snapshot is the one Complete checks.
func findTask(ctx context.Context, s store.Store, id uuid.UUID) (task.Task, error) {
	tasks, err := s.List(ctx)
	if err != nil {
		return task.Task{}, err
	}
	for _, t := range tasks {
		if t.ID == id {
			return t, nil
		}
	}
	return task.Task{}, fmt.Errorf("done: task %s: %w", id, store.ErrNotFound)
}
```

`findTask` exists because the store has no `Get`: the command lists and
scans. Reading first is also what keeps the two failures apart — a task that
changed between the read and the write fails with the store's conflict error
instead of being overwritten, and a task that never existed is `ErrNotFound`,
with the message naming the id.

## stats and import

The last two commands are one store call each. `stats` counts:

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
		RunE: func(cmd *cobra.Command, _ []string) error {
			stats, err := s.Stats(cmd.Context())
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "Total:   %d\nDone:    %d\nPending: %d\n",
				stats.Total, stats.Done, stats.Pending)
			return err
		},
```

Three numbers, formatted in one call. The output format stays plain on
purpose; a later pass gives `list` and `stats` proper formats.

<!-- verify: internal/cli/cli.go at=cli-commands -->
```go title="internal/cli/cli.go"
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := os.Open(args[0]) // #nosec G304 -- the caller names the file to import; reading exactly that file is the command's purpose
			if err != nil {
				return fmt.Errorf("import: %w", err)
			}
			defer func() {
				// The document has been read by the time the deferred close
				// runs, and this handle only read; a close error cannot
				// change the outcome, so it is discarded explicitly.
				_ = f.Close()
			}()

			n, err := store.ImportJSON(cmd.Context(), s, f)
			if err != nil {
				return err
			}
			noun := "tasks"
			if n == 1 {
				noun = "task"
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "imported %d %s\n", n, noun)
			return err
		},
```

`import` opens the named file, feeds it to the importer, and prints the count
with the right noun. The import itself is all-or-nothing: a document the
importer rejects changes nothing.

## main becomes wiring

With the tree in its own package, `main` shrinks to the wiring: signals, the
database handle, and the exit code. The finished app's appendix holds this
file in full — the lines behind the `...` are there as you type them.

<!-- verify: cmd/todo/main.go at=cli-commands -->
```go title="cmd/todo/main.go"
// Command todo is the todo application's CLI: a cobra command tree over the
// SQLite store. The tree itself lives in internal/cli; this file is the
// wiring — signals, the database handle, and the exit code.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"todo/internal/cli"
	"todo/internal/store"
)
```

The imports say what the file is: signals, the CLI package, the store — no
command code.

<!-- verify: cmd/todo/main.go at=cli-commands -->
```go title="cmd/todo/main.go"
func main() {
	// A first interrupt or SIGTERM cancels ctx, so every store call aborts
	// with a context error instead of the process dying mid-write. stop
	// unregisters the handler; the defer covers the normal return, while
	// the os.Exit below skips it — the process is leaving anyway.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The database path is a constant for now: the working directory is the
	// ...
	st, err := store.NewTursoStore(ctx, "todo.db")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// The store owns the database handle; closing it checkpoints the WAL
	// and releases the file. The error path's os.Exit skips this — the
	// process is leaving anyway, and every write already committed.
	defer func() {
		if err := st.Close(); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
```

The context starts with Ctrl-C wired into it, so a first interrupt cancels
every store call instead of killing the process mid-write. The database path
is a constant for now — the store lives in the folder you run from — and a
store that fails to open prints one line and exits 1.

<!-- verify: cmd/todo/main.go at=cli-commands -->
```go title="cmd/todo/main.go"
	root := cli.New(st, os.Stdout, os.Stderr)
	if err := root.ExecuteContext(ctx); err != nil {
		// The tree silences cobra's own error reporting, so this is the one
		// place an error is printed: once, on stderr, the way a Unix tool
		// reports it.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
```

`cli.New` gets the store and the two standard streams, and `ExecuteContext`
runs whatever the user typed. If it returns an error, this is the one place
it is printed — once, on stderr — and the process exits 1.

Two files go away with the skeleton: delete `cmd/todo/main_test.go` and the
folder `cmd/todo/__snapshots__`. Their job was to prove the wiring — a
context, a store, a writer, an exit code — and the real tree proves it now.
A recorded output of behavior that no longer exists isn't a test anymore.

## Run it

Run everything:

```bash
$ go test -count=1 ./...
?   	todo/cmd/todo	[no test files]
ok  	todo/internal/cli	0.005s
ok  	todo/internal/db	0.017s
ok  	todo/internal/store	0.090s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.005s
```

Every package passes. `cmd/todo` is `[no test files]` now — its test went
with the skeleton — and the new package's cases all passed on this first run.

Build the real tool and try it:

```bash
$ CGO_ENABLED=0 go build -o ./todo ./cmd/todo
```

The `CGO_ENABLED=0` part keeps the binary pure Go, as the database work
established. Run these commands from the app's root folder; the first one
creates `todo.db` beside you, the store every command shares.

```bash
$ ./todo add "buy milk" --due tomorrow --tag home
01a1373f-edac-7be0-8cda-597238bddf79
$ ./todo add "write the book" --priority 5 --tag book
01a1373f-edb0-7c1e-a4a7-a65a06b01c14
$ ./todo list
01a1373f-edac-7be0-8cda-597238bddf79  [Todo] buy milk (due 2026-10-14) (tags: home)
01a1373f-edb0-7c1e-a4a7-a65a06b01c14  [Todo] write the book (tags: book)
$ ./todo stats
Total:   2
Done:    0
Pending: 2
```

`add` printed each task's id, `list` shows id first — the handle — and
`stats` counts. The ids and the due date are from the day this session was
recorded; yours will be your own.

```bash
$ ./todo done 01a1373f-edac-7be0-8cda-597238bddf79
$ ./todo list
01a1373f-edac-7be0-8cda-597238bddf79  [Done] buy milk (due 2026-10-14) (tags: home)
01a1373f-edb0-7c1e-a4a7-a65a06b01c14  [Todo] write the book (tags: book)
$ ./todo stats
Total:   2
Done:    1
Pending: 1
```

`done` prints nothing on success. That is the old Unix habit: a command that
did its job says so with silence and exit code 0, and the next `list` shows
the change. Failures do speak up:

```bash
$ ./todo done not-a-uuid
done: invalid id "not-a-uuid": invalid UUID length: 10
$ echo $?
1
$ ./todo done 00000000-0000-0000-0000-000000000042
done: task 00000000-0000-0000-0000-000000000042: task not found
```

One line on stderr and exit code 1. The second failure names the id and says
what is wrong with it — the id no task carries. Because `done` reads first, a
missing task is never reported as a conflict.

The import command takes a file. Create `tasks.json` in the folder you run
from, holding one task in the interchange format the export work pinned:

```json
{
  "version": 3,
  "tasks": [
    {
      "ID": "0199c0de-0000-7000-8000-000000000010",
      "Title": "water the plants",
      "Status": "Todo",
      "Priority": 3,
      "Due": "2026-11-01T00:00:00Z",
      "Tags": ["home"],
      "Version": 1
    }
  ]
}
```

Then import it:

```bash
$ ./todo import tasks.json
imported 1 task
$ ./todo list
0199c0de-0000-7000-8000-000000000010  [Todo] water the plants (due 2026-11-01) (tags: home)
01a1373f-edac-7be0-8cda-597238bddf79  [Done] buy milk (due 2026-10-14) (tags: home)
01a1373f-edb0-7c1e-a4a7-a65a06b01c14  [Todo] write the book (tags: book)
```

`imported 1 task` — the noun agrees because the command checks the count. The
imported task leads the list because the database orders tasks by id and
`0199…` sorts before the `01a1…` ids. Real database, real tool.

## Help is part of the tool

Ask the tool what it can do:

```bash
$ ./todo --help
todo keeps a task list in a local Turso database.

Tasks have an id, a title, a status, a priority, an optional due date, and
tags. add prints the new task's id; that id is the handle the other commands
take.

Usage:
  todo [command]

Available Commands:
  add         Add a task and print its id
  completion  Generate the autocompletion script for the specified shell
  done        Mark a task done
  help        Help about any command
  import      Import tasks from a JSON document
  list        List tasks
  stats       Show task totals

Flags:
  -h, --help   help for todo

Use "todo [command] --help" for more information about a command.
```

The root's `Long` text leads the help, and cobra adds two commands we didn't
write: `help`, which prints the same text, and `completion`, which generates
autocompletion scripts for bash, zsh, fish, and PowerShell from the tree
itself. A leaf's help is built the same way: `todo add --help` shows the
`Use` line, the description, and the three flags with their defaults.

## If something went wrong

**The id appeared in your terminal, but the test says the output was empty.**
If a command prints with `fmt.Println` instead of the writer the constructor
wired, the test's buffer stays empty while the id leaks into the test
process's real output:

```text
01a13746-6304-794c-8f36-2e8d55d64c37
--- FAIL: TestAdd (0.00s)
    --- FAIL: TestAdd/args_and_flags_land_in_the_stored_task (0.00s)
        cli_test.go:71: 
            	Error:      	Not equal: 
            	            	expected: "01a13746-6304-794c-8f36-2e8d55d64c37\n"
            	            	actual  : ""
            	…
FAIL
FAIL	todo/internal/cli	0.003s
FAIL
```

Fix: print through `cmd.OutOrStdout()`, the writer `New` handed over. That is
also what makes help and completion output capturable.

**A failure prints twice, once under a wall of usage text.** If you leave out
the two silence fields — or set only one — cobra reports the error itself on
top of `main`'s report. A small program — one command, named `lab` — with the
same error flow shows the difference:

```bash
$ ./lab fail
Error: boom: something failed
Usage:
  lab fail [flags]

Flags:
  -h, --help   help for fail

boom: something failed
$ ./lab silenced fail
boom: something failed
```

Fix: keep `SilenceUsage` and `SilenceErrors` set to `true` on the root;
children inherit them.

**An extra argument vanishes silently.** Without an `Args` validator, cobra
hands every argument to `RunE` and the command reads `args[0]` — the second
word is dropped with no message. `Args: cobra.ExactArgs(1)` fails before
`RunE` instead:

```bash
$ ./todo add "a" "b"
accepts 1 arg(s), received 2
```

`cobra.NoArgs` is the same guard for commands that take none.

<details>
<summary>Going deeper: why `RunE` and not `Run`</summary>

`Run` is the same function without the error. A failing `Run` can print,
panic, or call `os.Exit`, but it cannot tell the tree that it failed — so a
program whose `main` checks the returned error sees success and exits 0
whatever happened. A tiny program with one command shows it:

```bash
$ ./lab lost
boom: something failed
$ echo $?
0
```

The message is there; the exit code is a lie. `RunE` returns the error, cobra
propagates it, and `main` turns it into exit 1 — every command in the tree is
a `RunE`, and no command calls `os.Exit`.

</details>

<details>
<summary>Going deeper: help and completion come from the tree</summary>

cobra adds two commands we never wrote: `help` and `completion`. The
completion scripts are generated from the tree itself — the command names and
flag lists in a script are the ones we declared. Ask for one:

```bash
$ ./todo completion bash | head
# bash completion V2 for todo                                 -*- shell-script -*-

__todo_debug()
{
    if [[ -n ${BASH_COMP_DEBUG_FILE-} ]]; then
        echo "$*" >> "${BASH_COMP_DEBUG_FILE}"
    fi
}
```

Nothing in that script was written by hand, and nothing in the tree was
written for the shell; the script is derived from `Use` and the flags. A
hidden `__complete` command feeds it the candidates as you type.

</details>

<details>
<summary>Going deeper: why "tomorrow" can look like today</summary>

In the session above, `--due tomorrow` resolved to `2026-10-14` while the
machine's local date was already October 14. The machine was on IST
(UTC+05:30), and the domain computes relative words from the UTC date:

```bash
$ date
Wed Oct 14 03:33:34 AM IST 2026
$ date -u
Tue Oct 13 10:03:34 PM UTC 2026
```

At 03:33 local, UTC was still October 13, so tomorrow was the 14th. The tool
passes the current time exactly as specified; the anchoring belongs to the
domain, which takes the reference time as a parameter — and that is why the
tests can check either side of a midnight boundary instead of freezing a
clock.

</details>

<details>
<summary>Going deeper: why the imported task leads the list</summary>

The database orders its tasks by id, and `0199…` sorts before the `01a1…`
ids, so the imported task appears first. The memory store the tests use lists
in insertion order instead. Both are fine: the interface does not promise one
order across implementations — so if you write your own tool over the store,
sort the list yourself when order matters.

</details>

The tool is real, and every command is covered by tests that never start a
process. Next, the database path stops being a constant: the tool learns to
take it from a flag, an environment variable, or a sensible default.

<div class="day-tracker" data-day="30"></div>
