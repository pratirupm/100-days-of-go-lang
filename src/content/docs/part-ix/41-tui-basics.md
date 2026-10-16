---
title: A terminal interface
description: Build a full-screen terminal interface for the task list — a program that waits for a key, redraws, and waits again.
sidebar:
  order: 41
---

The todo app answers commands and serves pages now, but every run of it starts, does one job, and ends. A **terminal interface** is the other kind of program: it takes over the terminal window, draws a screen of its own, and stays open until you tell it to leave. If you have ever used `top` or a full-screen editor, you have used one.

Today the task list gets one. The new program is `todo-tui`, and it reads the same database the command-line tool writes: add tasks with `todo add` before you start it, and the interface lists them when it opens. The keys are few on purpose — move, reload, quit — and the whole screen is drawn from one value.

The engine under the screen is an **event loop**, and the loop itself comes from a library called **Bubble Tea**. Our job is to give it the data and the rules.

## Wait, draw, repeat

Start with the loop in plain words, before any code.

When you press a key, the program wakes up, changes what it knows — the marker moves down one row — draws the screen again, and goes back to waiting. It repeats that cycle for as long as it runs. Between key presses it is not checking the keyboard over and over; the terminal hands it a key when one is pressed, and until then the program is asleep. That endless wait, respond, draw cycle is the event loop.

Bubble Tea runs the loop. Our share is three pieces:

- the **model** — one value holding everything the screen needs: the tasks, the marker's position, the last error;
- **Update** — a function that takes one message and returns the next model;
- **View** — a function that turns the model into the text of the screen.

The pattern has a name — the **Elm architecture**, after the language it comes from — but the shape is just those three pieces. And it buys the property this chapter leans on: **View is a pure function**, so the same model always draws the same frame, with no database call and no terminal involved. A frame is a string, and a string can be checked without a terminal.

Two more words complete the vocabulary. A **message** is anything that arrives at `Update`: a key press, a window resize, or an answer to a question the program asked. A **command** is a piece of work the loop must not wait for — like reading the database. `Update` can return a command with the next model; the program runs it in the background and delivers its answer back as another message.

That split matters: the first frame is drawn — and a quit is handled — before the database has answered, because the read is a command, not a step in startup.

## The model's tests come first

The habit from the very first page still holds: describe the behavior before building it. The new package is `internal/tui`, and its first file is the model's unit test. Create `internal/tui/tui_test.go`:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
// Package tui_test is the TUI's test package: the model's unit tests, the
// teatest run that drives the real event loop, and the program test that
// pins the terminal modes. It is external — the tests see exactly the API
// cmd/todo-tui sees — and it reads the model's state through the accessors
// the model publishes for its callers.
package tui_test

import (
	"context"
	"errors"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/task"
	"todo/internal/tui"
)
```

The package is `tui_test` — the tests stand outside the model and see exactly what the binary sees. The imports bring in the model, the store, and the task type, plus Bubble Tea's message type and the assertion helpers the earlier test files already use.

Next, the helpers every case starts from:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
// seed adds one Todo task per title to the store and returns what the store
// stored. Titles are the tests' whole vocabulary: the frames never show ids,
// so nothing here depends on the store's id or version assignment.
func seed(t *testing.T, s store.Store, titles ...string) []task.Task {
	t.Helper()
	var stored []task.Task
	for _, title := range titles {
		added, err := s.Add(context.Background(), task.Task{Title: title, Status: task.StatusTodo})
		require.NoError(t, err)
		stored = append(stored, added)
	}
	return stored
}

// complete marks a stored task done through the store — the same
// compare-and-swap the CLI's done command uses.
func complete(t *testing.T, s store.Store, tk task.Task) {
	t.Helper()
	require.NoError(t, s.Complete(context.Background(), tk.ID, tk.Version))
}
```

`seed` adds one task per title and returns what the store stored; `complete` marks one done through the store. The tests speak in titles, because the frames never show ids.

The next two helpers are the testing trick of this whole chapter:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
// load runs the model's initial command and applies its result, the
// synchronous stand-in for the program's first message. Every model test
// starts from a loaded list this way, without a terminal or an event loop.
func load(t *testing.T, m tui.Model) tui.Model {
	t.Helper()
	next, _ := m.Update(m.Init()())
	loaded, ok := next.(tui.Model)
	require.True(t, ok, "Update must return the same model type")
	return loaded
}

// key builds the KeyMsg a terminal would deliver for the given key name:
// the runes for the letters, the arrow types for "down" and "up".
func key(name string) tea.KeyMsg {
	switch name {
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(name)}
	}
}
```

`load` runs the model's first command by hand and feeds the answer back — the synchronous stand-in for the program's first message, so a model test needs no terminal and no event loop. `key` builds the key message a terminal would deliver: the letters as runes, the two arrows as their own types. A key press is a value here, and that is what makes a keyboard program testable without a keyboard.

Then the fake store, and one small helper for assertions:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
// failingStore is a store whose reads fail. The embedded nil interface
// supplies every method but List, and List is the only one the model ever
// calls — a two-line fake is all the model's contract needs.
type failingStore struct {
	store.Store
}

// List always fails; the model must show the error, not panic.
func (failingStore) List(context.Context) ([]task.Task, error) {
	return nil, errors.New("store is down")
}

// titles maps tasks to their titles, for order-sensitive assertions.
func titles(tasks []task.Task) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.Title
	}
	return out
}
```

`failingStore` is the whole fake: it embeds the store interface, which supplies every method but `List`, and `List` is the only method the model ever calls. `titles` flattens tasks to their titles for order-sensitive checks.

Now the cases. The first two pin the load:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
func TestModel_InitLoadsTheStore(t *testing.T) {
	st := store.NewMemoryStore()
	seed(t, st, "write the chapter", "buy milk")

	m := load(t, tui.New(context.Background(), st))

	assert.Equal(t, []string{"write the chapter", "buy milk"}, titles(m.Tasks()))
	assert.Equal(t, 0, m.Cursor())
	assert.NoError(t, m.Err())
}

func TestModel_LoadFailure(t *testing.T) {
	m := load(t, tui.New(context.Background(), failingStore{}))

	require.Error(t, m.Err())
	assert.Contains(t, m.Err().Error(), "store is down")
	assert.Empty(t, m.Tasks())

	view := m.View()
	assert.Contains(t, view, "could not load tasks")
	assert.Contains(t, view, "store is down")
	assert.Contains(t, view, "r: retry, q: quit")
}
```

The first loads two tasks and checks the tasks, the cursor, and the absence of an error. The second runs the same load against a failing store: the error must reach `Err()`, the list must stay empty, and the frame must name the retry key.

The keyboard contract is a table:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
func TestModel_Navigation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		keys []string
		want int
	}{
		{"j moves down", []string{"j"}, 1},
		{"down moves down", []string{"down"}, 1},
		{"k stays at the top", []string{"k"}, 0},
		{"up stays at the top", []string{"up"}, 0},
		{"j past the last task clamps", []string{"j", "j", "j", "j"}, 2},
		{"k moves back up", []string{"j", "j", "k"}, 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			st := store.NewMemoryStore()
			seed(t, st, "write the chapter", "buy milk", "ship it")

			m := load(t, tui.New(context.Background(), st))
			for _, name := range tt.keys {
				next, _ := m.Update(key(name))
				m = next.(tui.Model)
			}
			assert.Equal(t, tt.want, m.Cursor())
		})
	}
}
```

Read it as a promise: keys in, expected cursor out. Both ends are clamped.

Two more edges follow, plus the quit keys:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
func TestModel_NavigationEmpty(t *testing.T) {
	// An empty list has nowhere to move: the cursor stays put and the view
	// stays renderable.
	m := load(t, tui.New(context.Background(), store.NewMemoryStore()))

	for _, name := range []string{"j", "down", "k", "up"} {
		next, _ := m.Update(key(name))
		m = next.(tui.Model)
	}
	assert.Equal(t, 0, m.Cursor())
	assert.Contains(t, m.View(), "No tasks yet.")
}

func TestModel_QuitKeys(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"q", "ctrl+c"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			m := tui.New(context.Background(), store.NewMemoryStore())

			_, cmd := m.Update(key(name))
			require.NotNil(t, cmd, "%s must return the quit command", name)
			assert.Equal(t, tea.QuitMsg{}, cmd(), "q and ctrl+c both leave through tea.Quit")
		})
	}
}
```

An empty list has nowhere to move, so the cursor stays at 0 and the frame still renders. And both quit keys return the library's quit command — the value that stops the loop.

Reload is the command round trip in two beats:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
func TestModel_Reload(t *testing.T) {
	st := store.NewMemoryStore()
	seed(t, st, "write the chapter")
	m := load(t, tui.New(context.Background(), st))

	// The store changes behind the model's back ...
	// ...
	seed(t, st, "buy milk")

	next, cmd := m.Update(key("r"))
	require.NotNil(t, cmd, "r must return a load command")
	m = next.(tui.Model)

	// The old snapshot is still on screen until the command lands.
	assert.Equal(t, []string{"write the chapter"}, titles(m.Tasks()))

	next, _ = m.Update(cmd())
	m = next.(tui.Model)
	assert.Equal(t, []string{"write the chapter", "buy milk"}, titles(m.Tasks()))
}
```

The store changes behind the model's back; `r` returns a command; the old list stays on screen until the command's answer arrives, and then the new task appears. That two-beat shape is the event loop in miniature.

A reload can also find a shorter list, and the cursor must be pulled back inside it:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
func TestModel_ReloadClampsTheCursor(t *testing.T) {
	st := store.NewMemoryStore()
	seed(t, st, "write the chapter", "buy milk", "ship it")
	m := load(t, tui.New(context.Background(), st))

	next, _ := m.Update(key("j"))
	m = next.(tui.Model)
	next, _ = m.Update(key("j"))
	m = next.(tui.Model)
	require.Equal(t, 2, m.Cursor())

	// A reload that finds a shorter list must not leave the cursor past
	// the end.
	shorter := store.NewMemoryStore()
	seed(t, shorter, "write the chapter")
	next, cmd := m.Update(key("r"))
	m = next.(tui.Model)
	next, _ = m.Update(cmd()) // the old store answers with three tasks...
	m = next.(tui.Model)
	require.Equal(t, 2, m.Cursor())

	next, _ = m.Update(tui.New(context.Background(), shorter).Init()())
	m = next.(tui.Model)
	assert.Equal(t, 0, m.Cursor(), "a one-task list clamps the cursor to its only row")
}
```

The test walks the cursor down twice, reloads against a one-task store, and asks for cursor 0.

The last two cases pin the frames and the copy rule:

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
func TestModel_View(t *testing.T) {
	t.Run("before the load", func(t *testing.T) {
		t.Parallel()
		assert.Contains(t, tui.New(context.Background(), store.NewMemoryStore()).View(), "loading tasks")
	})

	t.Run("empty store", func(t *testing.T) {
		t.Parallel()
		m := load(t, tui.New(context.Background(), store.NewMemoryStore()))
		view := m.View()
		assert.Contains(t, view, "todo: 0 tasks")
		assert.Contains(t, view, "No tasks yet.")
	})

	t.Run("tasks", func(t *testing.T) {
		t.Parallel()
		st := store.NewMemoryStore()
		stored := seed(t, st, "write the chapter", "buy milk", "ship it")
		complete(t, st, stored[2])

		m := load(t, tui.New(context.Background(), st))
		view := m.View()
		assert.Contains(t, view, "todo: 3 tasks")
		assert.Contains(t, view, "> [ ] write the chapter")
		assert.Contains(t, view, "  [ ] buy milk")
		assert.Contains(t, view, "  [x] ship it")
		assert.Contains(t, view, "j/k: move, r: reload, q: quit")
	})
}
```

Three frames as strings: the loading frame before any answer, the empty state, and the list with a done row and the selected row's marker. `complete` is what makes the third row `[x]`.

<!-- verify: internal/tui/tui_test.go at=tui-event-loop -->
```go title="internal/tui/tui_test.go"
func TestModel_TasksAreACopy(t *testing.T) {
	st := store.NewMemoryStore()
	seed(t, st, "write the chapter")
	m := load(t, tui.New(context.Background(), st))

	got := m.Tasks()
	got[0].Title = "renamed"
	assert.Equal(t, []string{"write the chapter"}, titles(m.Tasks()), "callers cannot reach the model's own slice")
}
```

And the copy discipline, the same rule the store's reads follow: a caller that changes what `Tasks()` returned must not reach the model's own slice.

## A session through the real loop

Those cases call `Update` by hand. The second test file drives the real thing: a real event loop around the model, over a terminal the test owns. Create `internal/tui/teatest_test.go`:

<!-- verify: internal/tui/teatest_test.go at=tui-event-loop -->
```go title="internal/tui/teatest_test.go"
package tui_test

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/charmbracelet/x/exp/teatest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/tui"
)
```

The new import is `teatest`, a companion library for testing Bubble Tea programs: it starts a program around your model, lets a test type keys into it, and reads the terminal stream out.

The one helper every session shares:

<!-- verify: internal/tui/teatest_test.go at=tui-event-loop -->
```go title="internal/tui/teatest_test.go"
// waitForFrame waits until one rendered frame contains every want. teatest
// reads the terminal stream, so the assertion is on what the renderer
// wrote, not on the model's state — the two together are what the chapter
// pins. Every want of one call must match one frame: the renderer rewrites
// only the lines that changed, and a frame boundary is where "what the
// program just drew" is. The duration is a failure bound, not a sleep:
// WaitFor returns the moment the frame arrives.
func waitForFrame(t *testing.T, tm *teatest.TestModel, wants ...string) {
	t.Helper()
	teatest.WaitFor(t, tm.Output(), func(out []byte) bool {
		for _, want := range wants {
			if !bytes.Contains(out, []byte(want)) {
				return false
			}
		}
		return true
	}, teatest.WithDuration(5*time.Second))
}
```

`waitForFrame` waits until one rendered frame contains every want. Two mechanics matter here. The check is on what the renderer wrote, not on the model's state — and because the renderer rewrites only the lines that changed, every want of one call must match a single frame. The five-second duration is a failure bound, not a pause: the helper returns the moment the frame arrives.

Now the session itself:

<!-- verify: internal/tui/teatest_test.go at=tui-event-loop -->
```go title="internal/tui/teatest_test.go"
// TestTUI_KeysDriveTheFrame is the chapter's teatest run: the real event
// loop around the model, keys typed into it, and the frames asserted out.
// The session walks the cursor down and back up, reloads after a task
// appears behind the model's back, and quits — and the final model is the
// state the session ended in.
func TestTUI_KeysDriveTheFrame(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seed(t, st, "write the chapter", "buy milk", "ship it")

	tm := teatest.NewTestModel(t, tui.New(context.Background(), st), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	// The first frame: the load's tasks, the cursor on the first row.
	waitForFrame(t, tm, "todo: 3 tasks", "> [ ] write the chapter")

	// j steps the cursor down; each frame moves the marker.
	tm.Type("j")
	waitForFrame(t, tm, "> [ ] buy milk")

	tm.Type("j")
	waitForFrame(t, tm, "> [ ] ship it")
```

The session starts a program around a loaded model and waits for the first frame: the tasks, with the marker on the first row. Then each `j` steps the marker down, and the assertion names the row that moved. `k` steps back up.

<!-- verify: internal/tui/teatest_test.go at=tui-event-loop -->
```go title="internal/tui/teatest_test.go"
	// k steps back up.
	tm.Type("k")
	waitForFrame(t, tm, "> [ ] buy milk")

	// r reloads: a task added behind the model's back shows up, and the
	// cursor stays where it was.
	seed(t, st, "water the plants")
	tm.Type("r")
	waitForFrame(t, tm, "todo: 4 tasks", "water the plants")

	// q quits; the final model is where the session ended.
	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final, ok := tm.FinalModel(t).(tui.Model)
	require.True(t, ok, "the final model must be the TUI's")
	assert.Equal(t, 1, final.Cursor())
	assert.Equal(t, []string{"write the chapter", "buy milk", "ship it", "water the plants"}, titles(final.Tasks()))
	assert.NoError(t, final.Err())
}
```

A task appears behind the model's back — the test seeds it straight into the store — `r` reloads, and the new row shows up while the cursor stays where it was. `q` quits, and the final model is the state the session ended in: cursor 1, four tasks, no error.

The other two sessions cover the empty store and the failure frame:

<!-- verify: internal/tui/teatest_test.go at=tui-event-loop -->
```go title="internal/tui/teatest_test.go"
// TestTUI_EmptyStore is the same loop over an empty store: the load's
// answer replaces the loading frame with the empty state, and q still
// quits.
func TestTUI_EmptyStore(t *testing.T) {
	t.Parallel()

	tm := teatest.NewTestModel(t, tui.New(context.Background(), store.NewMemoryStore()), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	waitForFrame(t, tm, "todo: 0 tasks", "No tasks yet.")

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	assert.Empty(t, final.Tasks())
}
```

Over an empty store, the load's answer replaces the loading frame with the empty state, and `q` still quits.

<!-- verify: internal/tui/teatest_test.go at=tui-event-loop -->
```go title="internal/tui/teatest_test.go"
// TestTUI_LoadFailure shows the error frame the loop produces when the
// store will not answer.
func TestTUI_LoadFailure(t *testing.T) {
	t.Parallel()

	tm := teatest.NewTestModel(t, tui.New(context.Background(), failingStore{}), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	waitForFrame(t, tm, "could not load tasks", "store is down")

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	assert.Error(t, final.Err())
}
```

When the store will not answer at all, the loop produces the error frame — and the session still ends cleanly.

## The program's terminal modes

Two test files describe the model. The third describes the program that runs it, and its subject is the terminal itself. Create `internal/tui/program_test.go`:

<!-- verify: internal/tui/program_test.go at=tui-event-loop -->
```go title="internal/tui/program_test.go"
package tui_test

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/tui"
)
```

The imports add `io`, `strings`, `sync`, and `time` — all plumbing for this file.

The program renders from its own goroutine while the test reads what it wrote, so the buffer needs a guard:

<!-- verify: internal/tui/program_test.go at=tui-event-loop -->
```go title="internal/tui/program_test.go"
// lockedBuffer is a bytes.Buffer whose reads and writes are guarded: the
// program renders from its own goroutine while the test polls what has been
// written, and an unguarded read would race under -race.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
```

`lockedBuffer` is a bytes buffer whose reads and writes take a lock — without it, the race detector would flag the test's reads.

`waitForOutput` polls with a deadline, so a broken program fails the test instead of hanging it:

<!-- verify: internal/tui/program_test.go at=tui-event-loop -->
```go title="internal/tui/program_test.go"
// waitForOutput polls the program's output until it contains want. The
// frame is produced asynchronously, so the poll is the wait; the deadline
// exists so a broken program fails the test instead of hanging it.
func waitForOutput(t *testing.T, out *lockedBuffer, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("no frame containing %q within the deadline; output so far:\n%q", want, out.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
}
```

Now the case. It builds the exact program the binary will build — `NewProgram` — and hands it a pipe for keys and a guarded buffer for output:

<!-- verify: internal/tui/program_test.go at=tui-event-loop -->
```go title="internal/tui/program_test.go"
// TestProgram_EntersAndLeavesAltScreen runs the program the binary runs —
// NewProgram's options included — over injected IO, so the terminal-mode
// decision is pinned by the escape sequences the program writes: the
// alternate screen is entered before the first frame and left when the
// program stops.
func TestProgram_EntersAndLeavesAltScreen(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seed(t, st, "write the chapter")

	in, keyboard := io.Pipe()
	out := &lockedBuffer{}

	done := make(chan error, 1)
	go func() {
		_, err := tui.NewProgram(tui.New(context.Background(), st),
			tea.WithInput(in),
			tea.WithOutput(out),
			tea.WithoutSignals(),
		).Run()
		done <- err
	}()

	waitForOutput(t, out, "> [ ] write the chapter")
```

It waits for the first frame, task row and marker included. Then one key goes down the pipe:

<!-- verify: internal/tui/program_test.go at=tui-event-loop -->
```go title="internal/tui/program_test.go"
	_, err := keyboard.Write([]byte("q"))
	require.NoError(t, err)

	select {
	case err := <-done:
		require.NoError(t, err, "q must stop the program cleanly")
	case <-time.After(5 * time.Second):
		t.Fatal("the program did not stop after q")
	}

	assert.Contains(t, out.String(), "\x1b[?1049h", "the program enters the alternate screen")
	assert.Contains(t, out.String(), "\x1b[?1049l", "and leaves it on exit")
}
```

`q` must stop the program cleanly, and the output must contain two escape sequences — the invisible codes a terminal uses to switch screens. `\x1b[?1049h` enters the **alternate screen**, the terminal's second screen; `\x1b[?1049l` leaves it. A terminal interface draws on that second screen so your scrollback is exactly as you left it when the program exits. This test pins both directions.

## Watch it fail

Three test files exist, and nothing they test exists. Run the suite:

```bash
$ go test -count=1 ./...
# todo/internal/tui
internal/tui/program_test.go:12:2: no required module provides package github.com/charmbracelet/bubbletea; to add it:
	go get github.com/charmbracelet/bubbletea
FAIL	todo/internal/tui [setup failed]
...
FAIL
```

The module is missing the library the tests import, and Go stops before it can say anything about the code. Fetch the two libraries at the exact versions this chapter was built with — `go get github.com/charmbracelet/bubbletea@v1.3.10` and `go get github.com/charmbracelet/x/exp/teatest@v0.0.0-20261012121918-43427fdbad12` — and `go.mod` gains two lines:

<!-- verify: go.mod at=tui-event-loop -->
```text title="go.mod"
require (
...
	github.com/charmbracelet/bubbletea v1.3.10
	github.com/charmbracelet/x/exp/teatest v0.0.0-20261012121918-43427fdbad12
...
)
```

The two lines land in the `require` block with the app's other direct dependencies.

:::note
teatest has no numbered releases, so its version is a long timestamped one. It is exact and unchangeable like any other.
:::

Run again:

```bash
$ go test -count=1 ./...
todo/internal/tui: no non-test Go files in …/internal/tui
FAIL	todo/internal/tui [build failed]
FAIL
```

The package exists as a contract — three test files — but a folder of test files is not a package: Go builds the package before it runs anything in it. Create `internal/tui/tui.go` with the package line alone:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
package tui
```

Run again, and the compiler finally names what the tests need:

```bash
$ go test -count=1 ./...
# todo/internal/tui_test [todo/internal/tui.test]
internal/tui/tui_test.go:46:31: undefined: tui.Model
internal/tui/tui_test.go:94:19: undefined: tui.New
internal/tui/program_test.go:70:17: undefined: tui.NewProgram
internal/tui/program_test.go:70:32: undefined: tui.New
internal/tui/teatest_test.go:47:36: undefined: tui.New
internal/tui/teatest_test.go:74:37: undefined: tui.Model
internal/tui/teatest_test.go:87:36: undefined: tui.New
internal/tui/teatest_test.go:95:33: undefined: tui.Model
internal/tui/teatest_test.go:104:36: undefined: tui.New
internal/tui/teatest_test.go:112:33: undefined: tui.Model
internal/tui/tui_test.go:94:19: too many errors
FAIL	todo/internal/tui [build failed]
FAIL
```

Three names — the model type, the constructor the program starts with, and the program constructor the binary runs — plus the methods and accessors the tests call. The compiler is reading the specification aloud. Write the model, and every name in that list comes to life.

## The model

Create the rest of `internal/tui/tui.go`. It opens with the package's own description, its imports, and the two messages a load can produce:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// Package tui is the todo application's terminal UI: the Bubble Tea model
// that shows the store's tasks, and the program that runs it. The model
// follows the Elm architecture — a value, one Update function, a pure View —
// and every store call happens in a command, never in the event loop.
package tui

import (
	"context"
	"fmt"
	"slices"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"todo/internal/store"
	"todo/internal/task"
)
```

The package comment states the pattern: a value, one `Update`, a pure `View`, and every store call in a command. The imports are the standard library plus Bubble Tea and the app's own store and task packages.

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// tasksMsg is a load's success, arriving as a message: the tasks the store
// returned, in the order it returned them.
type tasksMsg struct{ tasks []task.Task }

// loadErrMsg is a load's failure, arriving as a message. The model never
// panics on a store error and never shows a half-loaded list: the error
// replaces the frame, and the tasks from before the failed load are left
// behind the error until a retry answers.
type loadErrMsg struct{ err error }
```

Two message types, tiny on purpose: they carry one load's answer back to `Update`. A load succeeds with `tasksMsg` or fails with `loadErrMsg`, and the model never shows half a list — the error replaces the frame.

Next, the model itself:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// Model is the TUI's whole state: the store to read, the last snapshot of
// its tasks, the cursor, and the load's outcome. The fields are unexported
// and every Update returns a new Model by value — the model is data, the
// program is the loop — and the tests read the state through the accessors
// below.
//
// ctx is the context the model's commands call the store with. Storing a
// context in a struct is the exception the context package warns about; a
// tea.Cmd is func() tea.Msg and has nowhere to receive one, so the model
// carries the program's context — main's signal context — and a store call
// a command makes is cancellable with it.
type Model struct {
	ctx   context.Context
	store store.Store

	// tasks is the last load's answer. It is never written in place: a
	// new load replaces the slice, and View only reads it.
	tasks []task.Task
	// cursor is the index of the selected task. It is an index into
	// tasks, clamped on every load, so it is always inside the slice —
	// or 0 when the slice is empty.
	cursor int
	// err is the last load's failure, nil after a successful one.
	err error
	// loaded reports whether any load has answered. Before the first
	// answer the view says so, because an empty list and a load in
	// flight are different states.
	loaded bool
}
```

The model is the whole state: the store, the context its commands call it with, the last load's tasks, the cursor, the error, and a flag for whether a load has answered. It is a plain value — every `Update` returns a new one — and every field is private; the tests read state through the accessors below. The comment on `ctx` names an exception: a command is a function with no arguments, so it has nowhere to receive a context, and the model carries the program's.

The constructor and the two pieces the library calls first:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// New returns the model the program starts with: the store its commands
// read and the context they call it with. The model starts empty and
// unloaded; Init's command fills it.
func New(ctx context.Context, s store.Store) Model {
	return Model{ctx: ctx, store: s}
}

// NewProgram builds the program the binary runs: the model, and the
// terminal modes the model must not know about. The alternate screen is the
// program's decision, not the model's — a model renders the same frames to
// a terminal and to a test's buffer — and the variadic options exist so
// tests can build the same program over injected IO.
func NewProgram(m Model, opts ...tea.ProgramOption) *tea.Program {
	return tea.NewProgram(m, append([]tea.ProgramOption{tea.WithAltScreen()}, opts...)...)
}

// Init implements tea.Model: the model's one startup command, the load. The
// program runs it asynchronously and delivers the result to Update as a
// message, so the first frame is drawn — and a quit is handled — before the
// store has answered.
func (m Model) Init() tea.Cmd { return loadTasks(m.ctx, m.store) }
```

`New` builds the empty model — filling it is not a constructor's job. `NewProgram` builds the program the binary runs: the alternate screen is the first option, so it cannot be dropped, and the options after it are the seam the tests use to inject their own input and output. `Init` returns the one startup command: load the tasks. The program runs it in the background, so the first frame is drawn — and a quit is handled — before the store answers.

`Update` is the whole behavior:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// Update implements tea.Model: the whole of the model's behaviour, one
// message in, the next state and an optional command out. Key presses are
// the only input; the store never reaches the model except through the
// messages its commands produce.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tasksMsg:
		m.tasks = msg.tasks
		m.loaded = true
		m.err = nil
		// A reload can find a shorter list than the one on screen; the
		// cursor must not point past the end. min(max(n-1, 0), cursor)
		// keeps an empty list at 0.
		m.cursor = min(m.cursor, max(len(m.tasks)-1, 0))
		return m, nil
	case loadErrMsg:
		m.loaded = true
		m.err = msg.err
		return m, nil
	case tea.KeyMsg:
		return m.updateKey(msg)
	}
// ...
	return m, nil
}
```

Three cases. The tasks arrive: store them, mark the model loaded, clear the error, and pull the cursor back inside the list. An error arrives: show it. A key arrives: hand it to `updateKey`. Everything else is ignored for now, deliberately — the program sends window-size messages from the start, and the frame does not need them yet.

The key half is one switch, and each arm is one promise:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// updateKey is Update's key half: the keyboard contract in one switch. q
// and ctrl+c quit, j/k and the arrows move the cursor within the list, and
// r reloads. A key the model does not know changes nothing.
func (m Model) updateKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch key.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "j", "down":
		if m.cursor < len(m.tasks)-1 {
			m.cursor++
		}
	case "k", "up":
		if m.cursor > 0 {
			m.cursor--
		}
	case "r":
		return m, loadTasks(m.ctx, m.store)
	}
	return m, nil
}
```

`q` and `ctrl+c` return `tea.Quit`, the command that stops the loop. `j`/`down` and `k`/`up` move the cursor, with a guard at each end so it never leaves the list. `r` returns the same load command `Init` returned. A key the model does not know changes nothing — no error, no message.

`View` is the frame:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// View implements tea.Model: the frame the program renders. It is a pure
// function of the model — no IO, no store call, no terminal query — which
// is what makes every frame a string the tests can assert on. The layout is
// ...
func (m Model) View() string {
	switch {
	case m.err != nil:
		return strings.Join([]string{
			"todo: could not load tasks",
			"",
			"  " + m.err.Error(),
			"",
			"r: retry, q: quit",
		}, "\n")
	case !m.loaded:
		return "todo: loading tasks..."
	}

	lines := []string{fmt.Sprintf("todo: %d tasks", len(m.tasks)), ""}
	if len(m.tasks) == 0 {
		lines = append(lines, "No tasks yet.")
	}
	for i, t := range m.tasks {
		lines = append(lines, marker(i == m.cursor)+check(t.Status)+" "+t.Title)
	}
	lines = append(lines, "", "j/k: move, r: reload, q: quit")
	return strings.Join(lines, "\n")
}
```

Three shapes: the error frame, the loading frame, and the list. It is a pure function — no store call, no terminal query — which is exactly why a frame can be checked as a string. The last line of the list frame teaches the keys, because a screen whose keys are discoverable only in the source is a screen with no users. (The elided comment notes the layout is plain on purpose.)

Three one-line accessors are the surface the tests read:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// Cursor returns the index of the selected task.
func (m Model) Cursor() int { return m.cursor }

// Tasks returns the tasks the model is showing. The slice is a copy: a
// caller cannot reach the model's own state by mutating what it was handed,
// the same rule the store's reads follow.
func (m Model) Tasks() []task.Task { return slices.Clone(m.tasks) }

// Err returns the last load's failure, or nil when the last load succeeded.
func (m Model) Err() error { return m.err }
```

`Tasks` returns a copy, the same rule the store's reads follow: a caller cannot reach the model's own slice by changing what it was handed.

The one command is the only place the store is read:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// loadTasks is the model's one command: read the store and report the
// result back to Update as a tasksMsg or a loadErrMsg. Commands are where
// the IO lives — the model itself never blocks on the store — and a command
// runs on the program's command goroutine, so the event loop stays free to
// draw the loading frame and to handle a quit while a slow store answers.
func loadTasks(ctx context.Context, s store.Store) tea.Cmd {
	return func() tea.Msg {
		tasks, err := s.List(ctx)
		if err != nil {
			return loadErrMsg{err: err}
		}
		return tasksMsg{tasks: tasks}
	}
}
```

A command is a function that returns a message; the program runs it on its own goroutine, so the loop stays free to draw and to handle a quit while the store answers. The store call takes the model's context, so a signal can cancel it.

Two column helpers finish the file:

<!-- verify: internal/tui/tui.go at=tui-event-loop -->
```go title="internal/tui/tui.go"
// marker is the cursor column: "> " on the selected row, two spaces on
// every other, so the title column stays aligned.
func marker(selected bool) string {
	if selected {
		return "> "
	}
	return "  "
}

// check is the status column: "[x]" for a done task, "[ ]" for one still to
// do. Any status other than Done — the zero value included — renders as not
// done.
func check(status task.Status) string {
	if status == task.StatusDone {
		return "[x]"
	}
	return "[ ]"
}
```

`marker` is two characters wide — `> ` on the selected row, two spaces elsewhere — so titles line up. `check` is the status column: `[x]` for a done task, `[ ]` for anything else.

## Run the tests

The model is complete. Run the TUI's tests with verbose output:

```bash
$ go test -count=1 -v ./internal/tui
--- PASS: TestModel_InitLoadsTheStore
--- PASS: TestModel_LoadFailure
--- PASS: TestModel_Navigation
    --- PASS: TestModel_Navigation/down_moves_down
    --- PASS: TestModel_Navigation/j_moves_down
    --- PASS: TestModel_Navigation/j_past_the_last_task_clamps
    --- PASS: TestModel_Navigation/k_moves_back_up
    --- PASS: TestModel_Navigation/k_stays_at_the_top
    --- PASS: TestModel_Navigation/up_stays_at_the_top
--- PASS: TestModel_NavigationEmpty
--- PASS: TestModel_QuitKeys
    --- PASS: TestModel_QuitKeys/ctrl+c
    --- PASS: TestModel_QuitKeys/q
--- PASS: TestModel_Reload
--- PASS: TestModel_ReloadClampsTheCursor
--- PASS: TestModel_TasksAreACopy
--- PASS: TestModel_View
    --- PASS: TestModel_View/before_the_load
    --- PASS: TestModel_View/empty_store
    --- PASS: TestModel_View/tasks
--- PASS: TestProgram_EntersAndLeavesAltScreen
--- PASS: TestTUI_EmptyStore
--- PASS: TestTUI_KeysDriveTheFrame
--- PASS: TestTUI_LoadFailure
PASS
ok  	todo/internal/tui	0.276s
```

Every case is there: the model's rules, the sessions through the real loop, and the terminal-mode pin.

## The binary, and the screen it draws

The model package is done. The last file is the binary that runs it: `cmd/todo-tui/main.go`. It is all wiring — configuration, the store's lifecycle, the program. Create it:

<!-- verify: cmd/todo-tui/main.go at=tui-event-loop -->
```go title="cmd/todo-tui/main.go"
// Command todo-tui is the todo application's terminal UI: a Bubble Tea
// program over the same Turso store the CLI reads and writes. The wiring is
// this file — configuration, the store's lifecycle, the program — and the
// model lives in internal/tui.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	tea "github.com/charmbracelet/bubbletea"

	"todo/internal/config"
	"todo/internal/store"
	"todo/internal/tui"
)
```

The package comment says what the file is: a Bubble Tea program over the same database the CLI reads and writes. The imports bring in the config and store packages the CLI also uses, and the model's package.

`main` is one line:

<!-- verify: cmd/todo-tui/main.go at=tui-event-loop -->
```go title="cmd/todo-tui/main.go"
// main is the process's only job: exit with run's code.
func main() {
	os.Exit(run())
}
```

Exit with `run`'s code. `run` is where the decisions live, and it starts with the context and the one flag:

<!-- verify: cmd/todo-tui/main.go at=tui-event-loop -->
```go title="cmd/todo-tui/main.go"
// run resolves the configuration, opens the store, and runs the program. It
// returns the process's exit code: 0 after a clean quit, 1 after printing
// the one error line.
func run() int {
	// A first interrupt or SIGTERM cancels ctx: a store call in flight
	// aborts with a context error instead of the process dying mid-read.
	// The program's own exit on a signal is Bubble Tea's — it quits the
	// event loop and restores the terminal — so this context is only the
	// commands'.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// One flag, so the stdlib flag package is enough — the same choice
	// cmd/todo-server made. A parse error exits 2 with the usage, the
	// convention Go's own tools follow.
	dbFlag := flag.String("db", "", "path to the Turso database; overrides $TODO_DB and the XDG default")
	flag.Parse()
```

A first interrupt or SIGTERM cancels the context, so a store call in flight stops instead of the process dying mid-read; the program's own exit on a signal is the library's job. Then the flag: `--db` overrides `$TODO_DB` and the default location.

The configuration and the store come next, opened exactly the way the CLI opens it:

<!-- verify: cmd/todo-tui/main.go at=tui-event-loop -->
```go title="cmd/todo-tui/main.go"
	cfg, err := config.Load(os.Getenv, *dbFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	st, cleanup, err := openStore(ctx, cfg.DBPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() {
		// The program has returned by the time this runs, so the store is
		// no longer read; a close error cannot change the exit code and
		// has nowhere better to go, so it is discarded explicitly.
		_ = cleanup()
	}()
```

Any failure here is the app's one error line and exit code 1. The cleanup runs after the program returns, when nothing can read the store anymore.

Then the program itself, and the exit rules:

<!-- verify: cmd/todo-tui/main.go at=tui-event-loop -->
```go title="cmd/todo-tui/main.go"
	// q and ctrl+c both leave through tea.Quit, and Run returns nil. A
	// SIGINT that reaches the process outside the raw terminal — input is
	// not a TTY — arrives as ErrInterrupted, which is the same request to
	// stop, not a failure. Everything else — a kill, a renderer error — is
	// an error, and the one line and the exit code are the report.
	if _, err := tui.NewProgram(tui.New(ctx, st)).Run(); err != nil && !errors.Is(err, tea.ErrInterrupted) {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
```

Both quit keys leave through the quit command, so `Run` returns nothing. A ctrl+c that arrives outside the raw terminal — when input is not a terminal at all — is the same request to stop, not a failure. Anything else is an error: one line on stderr, exit code 1.

One helper remains, the store's opener:

<!-- verify: cmd/todo-tui/main.go at=tui-event-loop -->
```go title="cmd/todo-tui/main.go"
// openStore is the production opener: it creates the resolved path's parent
// directory (the XDG default nests todo/ under $XDG_DATA_HOME, which does
// not exist on a fresh account) and hands the store's Close back as the
// cleanup. It is cmd/todo's opener, in this binary's own main: both open
// ...
func openStore(ctx context.Context, dbPath string) (store.Store, func() error, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o700); err != nil {
		return nil, nil, fmt.Errorf("open store: %w", err)
	}
	st, err := store.NewTursoStore(ctx, dbPath)
	if err != nil {
		return nil, nil, err
	}
	return st, st.Close, nil
}
```

It creates the database's folder if it does not exist and hands back the store with its close function. It is the CLI's opener, in this binary's own main: both open the same database the same way. (The elided comment records that a later change replaces this side of the program with the API client.)

Start it in a terminal the way you start the other binaries — `go run ./cmd/todo-tui`. The tasks are the ones the CLI added: both read the same database. The frame is the one `View` builds — a header counting the tasks, the rows with their markers, and the keys on the last line.

```text
todo: 3 tasks

> [ ] write the chapter
  [x] buy milk
  [ ] ship it

j/k: move, r: reload, q: quit

  [ ] write the chapter
> [x] buy milk
```

Move with `j` and `k`: the marker follows, and the renderer rewrites only the rows that changed. Press `r` and the list is read again from the database — the tasks added with the CLI before the interface started. `q` leaves, and the terminal is exactly as it was. With nothing in the database, the frame says so:

```text
todo: 0 tasks

No tasks yet.

j/k: move, r: reload, q: quit
```

The header counts what is there, and an empty list says so in words instead of leaving a blank screen.

## If something went wrong

**`no required module provides package github.com/charmbracelet/bubbletea`.** The tests import the library and the module does not name it yet:

```bash
$ go test -count=1 ./...
# todo/internal/tui
internal/tui/program_test.go:12:2: no required module provides package github.com/charmbracelet/bubbletea; to add it:
	go get github.com/charmbracelet/bubbletea
FAIL	todo/internal/tui [setup failed]
```

Fetch both libraries with the two `go get` commands above, and the error moves to the next layer.

**`could not open a new TTY: open /dev/tty: no such device or address`.** The program's keys come from the terminal; this run's input was redirected, so the library went looking for one and found none:

```bash
$ TODO_DB=scratch.db ./todo-tui < /dev/null
could not open a new TTY: open /dev/tty: no such device or address
exit: 1
```

Run it in a real terminal window. A process without a terminal has nothing to open.

**`WaitFor: condition not met after 5s. Last output:`.** A session waited for a frame that never arrived:

<!-- transcripts: authored -->
```text
--- FAIL: TestTUI_KeysDriveTheFrame (5.06s)
    teatest_test.go:26: WaitFor: condition not met after 5s. Last output:

FAIL
FAIL	todo/internal/tui	5.064s
FAIL
```

`WaitFor` reads the stream as the renderer writes it, and each call consumes what it read — a second call only sees what is written after the first matched. Give each frame one call, with every want that frame must contain in the same call.

**`config: log path: neither $XDG_STATE_HOME nor $HOME names an absolute directory`.** The program resolves the log path even though nothing writes to it yet, so a run with no home folder refuses to start before the first frame:

```bash
$ env -u HOME -u XDG_DATA_HOME -u XDG_STATE_HOME ./todo-tui --db scratch.db
config: log path: neither $XDG_STATE_HOME nor $HOME names an absolute directory
exit: 1
```

Run it from your usual shell, or point `TODO_LOG` at a path of your own.

<details>
<summary>Going deeper: why the first load is a command</summary>

The obvious place to read the store would be the constructor or `View`: build the model with the tasks already in it. That version blocks the first frame — a slow database is a blank screen. It puts a database call in the render path, where a frame is supposed to be pure. And it makes quitting wait for a read nobody needs anymore.

The command version costs one field — the loaded flag — and buys the loading frame, an instant first paint, and a quit that works while the store is slow. And `r` proves that nothing about the first load is special: it is the same command any message can return.

</details>

<details>
<summary>Going deeper: the alternate screen</summary>

Most terminals keep two screens. The first holds your shell session and its scrollback; the second is blank, and programs borrow it for full-screen work. The escape sequence `?1049h` switches to it, and `?1049l` switches back — the two sequences the program test pins. When the program exits, your scrollback is exactly where you left it.

The mode belongs to the program, not the model: a model renders the same frame strings to a terminal and to a test's buffer, so a terminal mode is not something it could express. `NewProgram` makes the decision once, before the first frame.

</details>

<details>
<summary>Going deeper: the context on the model</summary>

Storing a context in a struct is the exception the context package warns about, and the model does it on purpose. A command is `func() tea.Msg` — a function with no arguments — so it has nowhere to receive a context. If a command made one of its own, every store call would be uncancellable: the store's contract is context-first precisely so callers can stop a call.

So the model carries the program's context — the signal context the binary creates — and passes it to the store in every command. Signals stay the library's job: the program restores the terminal on its own, and the context only reaches the store calls.

</details>

The plain frame is in place; next it gets color, a scrolling list, and the keys that add and complete a task.
