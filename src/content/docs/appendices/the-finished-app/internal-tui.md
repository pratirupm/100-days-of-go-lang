---
title: "internal/tui — the finished app"
description: "The finished app, file by file: internal/tui (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/tui/keys.go`

````go
package tui

import "github.com/charmbracelet/bubbles/key"

// listKeys is the list mode's key map: the bindings Update matches with
// key.Matches, and — through ShortHelp and FullHelp — the help the view
// renders. One map, two readers: a key cannot do one thing and be advertised
// as another, and a binding the model disables (a completion with no tasks,
// any action after a failed load) is neither matched nor shown.
type listKeys struct {
	Up       key.Binding
	Down     key.Binding
	Add      key.Binding
	Complete key.Binding
	Reload   key.Binding
	Quit     key.Binding
}

// defaultListKeys returns the list mode's bindings.
func defaultListKeys() listKeys {
	return listKeys{
		Up:       key.NewBinding(key.WithKeys("k", "up"), key.WithHelp("↑/k", "move up")),
		Down:     key.NewBinding(key.WithKeys("j", "down"), key.WithHelp("↓/j", "move down")),
		Add:      key.NewBinding(key.WithKeys("a"), key.WithHelp("a", "add")),
		Complete: key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "complete")),
		Reload:   key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "reload")),
		Quit:     key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q", "quit")),
	}
}

// ShortHelp is the one-line help: the keys a first-time user needs, in the
// order they reach for them. Bindings the model has disabled drop out, so
// the line follows the state.
func (k listKeys) ShortHelp() []key.Binding {
	return []key.Binding{k.Add, k.Complete, k.Reload, k.Quit}
}

// FullHelp is the wide terminal's reference card: the movement keys and the
// one-line keys in two columns.
func (k listKeys) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Add, k.Complete},
		{k.Down, k.Up, k.Reload, k.Quit},
	}
}

// inputKeys is the add mode's key map: while the input has focus it owns the
// letter keys — q types a q — so only the keys that leave the mode are
// bindings, plus ctrl+c, which quits from anywhere. The help follows the
// focus: the frame's last line names the input's keys, not the list's.
type inputKeys struct {
	Submit key.Binding
	Cancel key.Binding
	Quit   key.Binding
}

// defaultInputKeys returns the add mode's bindings.
func defaultInputKeys() inputKeys {
	return inputKeys{
		Submit: key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "add")),
		Cancel: key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "cancel")),
		Quit:   key.NewBinding(key.WithKeys("ctrl+c"), key.WithHelp("ctrl+c", "quit")),
	}
}

// ShortHelp is the add mode's one-line help.
func (k inputKeys) ShortHelp() []key.Binding {
	return []key.Binding{k.Submit, k.Cancel, k.Quit}
}

// inputKeys is the add mode's wide-terminal help: each key is its own
// column, so the line reads like the short help with room between the keys.
func (k inputKeys) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Submit},
		{k.Cancel},
		{k.Quit},
	}
}

// loginKeys is the login form's key map: enter submits from either field,
// tab switches the focused field, and ctrl+c quits. The letter keys belong to
// the focused field, so — like the add mode — only the keys that act on the
// form are bindings.
type loginKeys struct {
	Submit key.Binding
	Next   key.Binding
	Quit   key.Binding
}

// defaultLoginKeys returns the login form's bindings.
func defaultLoginKeys() loginKeys {
	return loginKeys{
		Submit: key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "sign in")),
		Next:   key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "next field")),
		Quit:   key.NewBinding(key.WithKeys("ctrl+c"), key.WithHelp("ctrl+c", "quit")),
	}
}

// ShortHelp is the login form's one-line help.
func (k loginKeys) ShortHelp() []key.Binding {
	return []key.Binding{k.Submit, k.Next, k.Quit}
}

// FullHelp is the login form's wide-terminal help: each key is its own
// column, like the input's.
func (k loginKeys) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Submit},
		{k.Next},
		{k.Quit},
	}
}
````


## `internal/tui/program_test.go`

````go
package tui_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/logging"
	"todo/internal/task"
	"todo/internal/tui"
)

// The program tests in this file deliberately do not call t.Parallel: each
// drives a real program through bubbletea's input parser, and the pinned
// bubbletea hands every space key the same package-level []rune — which
// bubbles' textinput sanitizes in place. Two programs processing a space at
// the same time is therefore a data race, a race the library has and one
// process running one program cannot hit. The tests take turns instead.
//
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

// TestProgram_EntersAndLeavesAltScreen runs the program the binary runs —
// NewProgram's options included — over injected IO, so the terminal-mode
// decision is pinned by the escape sequences the program writes: the
// alternate screen is entered before the first frame and left when the
// program stops. The session signs in first, because the model starts at
// the login form: the typed keys are the email, tab, the password, and
// enter, the same sequence a terminal would send.
func TestProgram_EntersAndLeavesAltScreen(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter")

	in, keyboard := io.Pipe()
	out := &lockedBuffer{}

	done := make(chan error, 1)
	go func() {
		_, err := tui.NewProgram(tui.New(context.Background(), f),
			tea.WithInput(in),
			tea.WithOutput(out),
			tea.WithoutSignals(),
		).Run()
		done <- err
	}()

	waitForOutput(t, out, "todo: sign in")

	_, err := keyboard.Write([]byte("alice@example.com\tcorrect horse battery staple\r"))
	require.NoError(t, err)

	waitForOutput(t, out, "> [ ] write the chapter")

	_, err = keyboard.Write([]byte("q"))
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

// TestProgram_LogsToTheFile is the chapter's log-file assertion: the program
// runs with the file-only logger the binary builds, a load fails, and the
// command's error is a JSON record in the file while the frame carries no
// log line. The terminal is the frame's; the file is the record's.
func TestProgram_LogsToTheFile(t *testing.T) {
	f := &fakeClient{listErr: errors.New("the API is down")}
	logPath := filepath.Join(t.TempDir(), "state", "todo", "logs", "todo.log")
	logger, closer, err := logging.NewFile(logPath, slog.LevelDebug)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer.Close() })

	in, keyboard := io.Pipe()
	out := &lockedBuffer{}

	done := make(chan error, 1)
	go func() {
		_, err := tui.NewProgram(tui.New(context.Background(), f, tui.WithLogger(logger)),
			tea.WithInput(in),
			tea.WithOutput(out),
			tea.WithoutSignals(),
		).Run()
		done <- err
	}()

	waitForOutput(t, out, "todo: sign in")

	_, err = keyboard.Write([]byte("alice@example.com\tcorrect horse battery staple\r"))
	require.NoError(t, err)

	// The failure frame and the record arrive together: the command logs
	// before it reports the message.
	waitForOutput(t, out, "could not load tasks")

	_, err = keyboard.Write([]byte("q"))
	require.NoError(t, err)

	select {
	case err := <-done:
		require.NoError(t, err, "q must stop the program cleanly")
	case <-time.After(5 * time.Second):
		t.Fatal("the program did not stop after q")
	}

	data, err := os.ReadFile(logPath) // #nosec G304 -- logPath is built by this test from t.TempDir
	require.NoError(t, err)
	assert.Contains(t, string(data), `"msg":"tasks load failed"`, "the failure is a record")
	assert.Contains(t, string(data), "the API is down", "the record carries the command's error")
	assert.NotContains(t, out.String(), "tasks load failed", "no log line reaches the frame")
}

// panickingModel is the real model with one injected fault: the first key
// press panics in Update, the way a bug would. It is why NewProgram takes a
// tea.Model and not the concrete model — the test wraps the model under test
// with the fault, and the program's options are the ones the binary runs
// with.
type panickingModel struct{ tui.Model }

// Update panics on the first key press and delegates everything else.
func (m panickingModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if _, ok := msg.(tea.KeyMsg); ok {
		panic("injected: the model's Update panicked")
	}
	return m.Model.Update(msg)
}

// panickingClient is the seam with a bug: the list call panics, the way a
// nil map write or an out-of-range index in the client would. Login still
// works — a session has to exist before a load can fail.
type panickingClient struct{ *fakeClient }

// ListTasks panics where the fake would answer.
func (*panickingClient) ListTasks(context.Context) ([]task.Task, error) {
	panic("injected: the client's ListTasks panicked")
}

// TestProgram_PanicRestoresTheTerminal pins the panic contract: a panic in
// the model's Update or in a command is recovered by the program, which
// restores the terminal before Run returns — the alternate screen is left
// and the cursor is shown — and reports the panic as an error. The recovery
// is Bubble Tea's; the test exists so the wiring that keeps it — no
// WithoutCatchPanics, no os.Exit before Run returns — cannot silently go
// away.
func TestProgram_PanicRestoresTheTerminal(t *testing.T) {
	tests := []struct {
		name  string
		model func() tea.Model
		keys  string
	}{
		{
			name:  "a panic in the model's Update",
			model: func() tea.Model { return panickingModel{tui.New(context.Background(), &fakeClient{})} },
			keys:  "x",
		},
		{
			name:  "a panic in a command",
			model: func() tea.Model { return tui.New(context.Background(), &panickingClient{&fakeClient{}}) },
			keys:  "alice@example.com\tcorrect horse battery staple\r",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in, keyboard := io.Pipe()
			out := &lockedBuffer{}

			done := make(chan error, 1)
			go func() {
				_, err := tui.NewProgram(tt.model(),
					tea.WithInput(in),
					tea.WithOutput(out),
					tea.WithoutSignals(),
				).Run()
				done <- err
			}()

			// The program is up and in the alternate screen before the
			// fault is injected.
			waitForOutput(t, out, "todo: sign in")
			_, err := keyboard.Write([]byte(tt.keys))
			require.NoError(t, err)

			select {
			case err := <-done:
				require.ErrorIs(t, err, tea.ErrProgramPanic, "Run reports the recovered panic")
			case <-time.After(5 * time.Second):
				t.Fatal("the program did not stop after the panic")
			}

			stream := out.String()
			entered := strings.Index(stream, "\x1b[?1049h")
			left := strings.Index(stream, "\x1b[?1049l")
			require.NotEqual(t, -1, entered, "the program entered the alternate screen")
			require.NotEqual(t, -1, left, "and left it when the panic was recovered")
			assert.Less(t, entered, left, "the alternate screen was left after it was entered")
			assert.Contains(t, stream, "\x1b[?25h", "the cursor is shown again")
		})
	}
}
````


## `internal/tui/styles.go`

````go
package tui

import "github.com/charmbracelet/lipgloss"

// styles is the view's style layer: every lipgloss style the frame uses,
// built in one place. The styles inherit a base style — lipgloss's
// composition primitive — so the frame agrees on its foreground and each
// style names only what it changes.
type styles struct {
	header   lipgloss.Style // "todo: N tasks"
	selected lipgloss.Style // the row the cursor is on
	done     lipgloss.Style // a completed task
	notice   lipgloss.Style // the last write's outcome, and the empty state
	problem  lipgloss.Style // a failed load, a lost compare-and-swap
	prompt   lipgloss.Style // the add input's prompt
}

// defaultStyles is the style layer the view renders with. It is built once:
// lipgloss styles are values, and a frame renders the same look every time.
var defaultStyles = newStyles()

// newStyles builds the style layer. The colors are adaptive — lipgloss picks
// the light or the dark variant from the terminal's background, so the frame
// stays readable on either — and a terminal without color (NO_COLOR set, or
// output that is not a terminal) renders the same frame without them: the
// layout lives in the strings, not in the escape codes.
func newStyles() styles {
	base := lipgloss.NewStyle().
		Foreground(lipgloss.AdaptiveColor{Light: "#1F1F1F", Dark: "#E4E4E4"})
	accent := lipgloss.AdaptiveColor{Light: "#5A3FD6", Dark: "#A79BFF"}
	problem := lipgloss.AdaptiveColor{Light: "#B00020", Dark: "#FF7A85"}

	return styles{
		header:   lipgloss.NewStyle().Inherit(base).Bold(true),
		selected: lipgloss.NewStyle().Inherit(base).Foreground(accent).Bold(true),
		done:     lipgloss.NewStyle().Inherit(base).Faint(true).Strikethrough(true),
		notice:   lipgloss.NewStyle().Inherit(base).Faint(true),
		problem:  lipgloss.NewStyle().Inherit(base).Foreground(problem),
		prompt:   lipgloss.NewStyle().Foreground(accent).Bold(true),
	}
}
````


## `internal/tui/teatest_test.go`

````go
package tui_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/exp/teatest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
	"todo/internal/tui"
)

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

// signIn drives the login form through the real event loop: the email, tab,
// the password, enter. The frame that follows — the list — is the caller's
// to wait for; the session itself lands in the client's jar, which is the
// client's business, not the model's.
func signIn(tm *teatest.TestModel) {
	tm.Type("alice@example.com")
	tm.Send(tea.KeyMsg{Type: tea.KeyTab})
	tm.Type("correct horse battery staple")
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
}

// goldenFrame drives a session through the real loop and commits the frame
// the program ended with: the last view the renderer wrote before it left
// the alternate screen. The golden is the frame, not the raw terminal
// stream, because the stream's shape is the renderer's timing — a burst of
// messages coalesces into however many frames the 60fps ticks produced —
// while the frame is a pure function of the model the session reached.
// teatest's helper writes testdata/<TestName>.golden on `go test -update`
// and diffs on a mismatch, which is the ritual: review the diff, update on
// purpose, commit the golden.
//
// The session ends with the program's Quit, not a q key: the frame committed
// is the state the session ended in, the notice included — a q would clear
// it on the way out.
func goldenFrame(t *testing.T, f *fakeClient, drive func(tm *teatest.TestModel)) {
	t.Helper()

	tm := teatest.NewTestModel(t, tui.New(context.Background(), f), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	drive(tm)

	require.NoError(t, tm.Quit(), "the program must quit cleanly")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	teatest.RequireEqualOutput(t, []byte(frame(final.View())))
}

// frame is the view as the golden commits it: the frame's lines, with the
// trailing padding dropped and one newline at the end. lipgloss pads every
// line of the frame to its widest one — the renderer erases to the end of
// the line, so the padding is invisible on a terminal — but it is very
// visible to an editor and to git: a golden that depended on trailing
// whitespace would break the moment someone saved the file, which most
// editors do with the whitespace stripped, and every diff would carry a
// "no newline at end of file" marker. What the golden pins is the frame's
// content; the padding is a rendering detail, and the width rule has its own
// tests.
func frame(view string) string {
	lines := strings.Split(view, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " ")
	}
	return strings.Join(lines, "\n") + "\n"
}

// TestTUI_LoginFlow is the chapter's flow through the real loop: the form
// the model starts at, the masked password, and the list the login loads.
func TestTUI_LoginFlow(t *testing.T) {
	t.Parallel()

	f := &fakeClient{}
	seed(f, "write the chapter", "buy milk")

	tm := teatest.NewTestModel(t, tui.New(context.Background(), f), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	// The first frame is the form: the fields, the placeholder, and the
	// keys that leave it.
	waitForFrame(t, tm, "todo: sign in", "email: ", "enter sign in • tab next field • ctrl+c quit")

	// The email lands in the first field; tab moves the keys to the
	// password, which the frame shows masked.
	tm.Type("alice@example.com")
	waitForFrame(t, tm, "email: alice@example.com")
	tm.Send(tea.KeyMsg{Type: tea.KeyTab})
	tm.Type("hunter2")
	waitForFrame(t, tm, "password: *******")

	// Enter signs in; the list the login asked for ends the flow.
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	waitForFrame(t, tm, "todo: 2 tasks", "> [ ] write the chapter")

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	assert.Equal(t, []string{"write the chapter", "buy milk"}, titles(final.Tasks()))
	email, password := f.LastLogin()
	assert.Equal(t, "alice@example.com", email)
	assert.Equal(t, "hunter2", password)
}

// TestTUI_KeysDriveTheFrame drives the session after the login: the cursor
// walks down and back up, a reload shows a task another client wrote, and
// quit ends the session — the final model is the state it ended in.
func TestTUI_KeysDriveTheFrame(t *testing.T) {
	t.Parallel()

	f := &fakeClient{}
	seed(f, "write the chapter", "buy milk", "ship it")

	tm := teatest.NewTestModel(t, tui.New(context.Background(), f), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	// The login first; the frame that follows carries the list, the cursor
	// on the first row, and the list's keys in the help line.
	signIn(tm)
	waitForFrame(t, tm, "todo: 3 tasks", "> [ ] write the chapter", "a add • enter complete • r reload • q quit")

	// j steps the cursor down; each frame moves the marker.
	tm.Type("j")
	waitForFrame(t, tm, "> [ ] buy milk")

	tm.Type("j")
	waitForFrame(t, tm, "> [ ] ship it")

	// k steps back up.
	tm.Type("k")
	waitForFrame(t, tm, "> [ ] buy milk")

	// r reloads: a task written behind the model's back shows up, and the
	// cursor stays where it was.
	seed(f, "water the plants")
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

// TestTUI_AddFlow is chapter 42's first failing test over the client seam:
// a message sequence — a, the title, enter — that ends in a new visible
// item. The input takes the keys while it has focus, the write is a
// command, and the frame that follows the reload shows the task, the cursor
// on it, and the notice saying what happened.
func TestTUI_AddFlow(t *testing.T) {
	t.Parallel()

	f := &fakeClient{}
	seed(f, "write the chapter", "ship it")

	tm := teatest.NewTestModel(t, tui.New(context.Background(), f), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	signIn(tm)
	waitForFrame(t, tm, "todo: 2 tasks", "> [ ] write the chapter")

	// a opens the input; the frame names the mode, the placeholder, and
	// the keys that leave it.
	tm.Type("a")
	waitForFrame(t, tm, "add: task title", "enter add • esc cancel • ctrl+c quit")

	// The letters land in the input, not in the list.
	tm.Type("buy milk")
	waitForFrame(t, tm, "add: buy milk")

	// Enter stores the task; the answer asks for a fresh list, and the
	// frame that follows carries all three: the count, the new row with
	// the cursor on it, and the notice.
	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	waitForFrame(t, tm, "todo: 3 tasks", "> [ ] buy milk", `added "buy milk"`)

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	assert.Equal(t, []string{"write the chapter", "ship it", "buy milk"}, titles(final.Tasks()))
	assert.Equal(t, 2, final.Cursor(), "the cursor lands on the task just added")
}

// TestTUI_CompleteFlow is the write the compare-and-swap exists for: enter
// completes the selected task, the answer refreshes the list, and the frame
// shows the check and the notice.
func TestTUI_CompleteFlow(t *testing.T) {
	t.Parallel()

	f := &fakeClient{}
	seed(f, "write the chapter", "ship it")

	tm := teatest.NewTestModel(t, tui.New(context.Background(), f), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	signIn(tm)
	waitForFrame(t, tm, "> [ ] write the chapter")

	tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
	waitForFrame(t, tm, "> [x] write the chapter", `completed "write the chapter"`)

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	require.Len(t, final.Tasks(), 2)
	assert.Equal(t, task.StatusDone, final.Tasks()[0].Status)
	assert.Equal(t, task.StatusTodo, final.Tasks()[1].Status)
}

// TestTUI_Width drives the same session through two terminal sizes: the row
// is cut at 24 columns and the full help appears at 100, without a key
// press — the size is the only thing that changed.
func TestTUI_Width(t *testing.T) {
	t.Parallel()

	f := &fakeClient{}
	seed(f, "write a title long enough to be cut")

	tm := teatest.NewTestModel(t, tui.New(context.Background(), f), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	signIn(tm)
	waitForFrame(t, tm, "> [ ] write a title long enough to be cut")

	tm.Send(tea.WindowSizeMsg{Width: 24, Height: 20})
	waitForFrame(t, tm, "> [ ] write a title lon…")

	tm.Send(tea.WindowSizeMsg{Width: 100, Height: 20})
	waitForFrame(t, tm, "move down", "reload")

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))
}

// TestTUI_EmptyStore is the same loop over a user with no tasks: the
// load's answer replaces the loading frame with the empty state — and a
// help line that does not offer a completion there is nothing to complete —
// and q still quits.
func TestTUI_EmptyStore(t *testing.T) {
	t.Parallel()

	tm := teatest.NewTestModel(t, tui.New(context.Background(), &fakeClient{}), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	signIn(tm)
	waitForFrame(t, tm, "todo: 0 tasks", "No tasks yet.", "a add • r reload • q quit")

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	assert.Empty(t, final.Tasks())
}

// TestTUI_LoadFailure shows the error frame the loop produces when the API
// will not answer the list.
func TestTUI_LoadFailure(t *testing.T) {
	t.Parallel()

	f := &fakeClient{listErr: errors.New("the API is down")}

	tm := teatest.NewTestModel(t, tui.New(context.Background(), f), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

	signIn(tm)
	waitForFrame(t, tm, "could not load tasks", "the API is down")

	tm.Type("q")
	tm.WaitFinished(t, teatest.WithFinalTimeout(5*time.Second))

	final := tm.FinalModel(t).(tui.Model)
	assert.Error(t, final.Err())
}

// TestTUI_GoldenLogin commits the first frame a user sees: the sign-in form,
// the typed email, and the password the component masks.
func TestTUI_GoldenLogin(t *testing.T) {
	t.Parallel()

	goldenFrame(t, &fakeClient{}, func(tm *teatest.TestModel) {
		tm.Type("alice@example.com")
		waitForFrame(t, tm, "email: alice@example.com")
		tm.Send(tea.KeyMsg{Type: tea.KeyTab})
		tm.Type("hunter2")
		waitForFrame(t, tm, "password: *******")
	})
}

// TestTUI_GoldenList commits the reference frame: three tasks, one done, and
// the cursor moved to the second row.
func TestTUI_GoldenList(t *testing.T) {
	t.Parallel()

	f := &fakeClient{}
	seed(f, "write the chapter", "buy milk", "ship it")
	f.mu.Lock()
	f.tasks[2].Status = task.StatusDone
	f.mu.Unlock()

	goldenFrame(t, f, func(tm *teatest.TestModel) {
		signIn(tm)
		waitForFrame(t, tm, "todo: 3 tasks", "> [ ] write the chapter")
		tm.Type("j")
		waitForFrame(t, tm, "> [ ] buy milk")
	})
}

// TestTUI_GoldenNotice commits a write's outcome: the notice line, the new
// row with the cursor on it, and the count that moved.
func TestTUI_GoldenNotice(t *testing.T) {
	t.Parallel()

	f := &fakeClient{}
	seed(f, "write the chapter", "ship it")

	goldenFrame(t, f, func(tm *teatest.TestModel) {
		signIn(tm)
		waitForFrame(t, tm, "todo: 2 tasks")
		tm.Type("a")
		waitForFrame(t, tm, "add: task title")
		tm.Type("buy milk")
		tm.Send(tea.KeyMsg{Type: tea.KeyEnter})
		waitForFrame(t, tm, `added "buy milk"`, "> [ ] buy milk")
	})
}

// TestTUI_GoldenProblem commits the failure frame: the load's error replaces
// the list, and the help shrinks to the keys that still act.
func TestTUI_GoldenProblem(t *testing.T) {
	t.Parallel()

	f := &fakeClient{listErr: errors.New("the API is down")}

	goldenFrame(t, f, func(tm *teatest.TestModel) {
		signIn(tm)
		waitForFrame(t, tm, "could not load tasks", "the API is down")
	})
}
````


## `internal/tui/testdata/TestTUI_GoldenList.golden`

````text
todo: 3 tasks

  [ ] write the chapter
> [ ] buy milk
  [x] ship it

a add • enter complete • r reload • q quit
````


## `internal/tui/testdata/TestTUI_GoldenLogin.golden`

````text
todo: sign in

email: alice@example.com
password: *******

enter sign in • tab next field • ctrl+c quit
````


## `internal/tui/testdata/TestTUI_GoldenNotice.golden`

````text
todo: 3 tasks

  [ ] write the chapter
  [ ] ship it
> [ ] buy milk

added "buy milk"

a add • enter complete • r reload • q quit
````


## `internal/tui/testdata/TestTUI_GoldenProblem.golden`

````text
todo: could not load tasks

  the API is down

r reload • q quit
````


## `internal/tui/tui.go`

````go
// Package tui is the todo application's terminal UI: the Bubble Tea model
// that signs in to the API, shows the user's tasks, adds to them, and
// completes them, and the program that runs it. The model follows the Elm
// architecture — a value, one Update function, a pure View — and every API
// call happens in a command, never in the event loop.
//
// The model does not know HTTP. It holds a Client — the interface it defines
// below, the API calls the list performs — and internal/client is the
// implementation the binary wires in; the tests' fakes are the others. The
// session, the cookie jar, the timeouts, and the retries all live on the
// client's side of that seam; what the model sees is an error or a task.
//
// The commands also record. A login, a load, a write, and the error each can
// carry go to the logger the binary hands in — a file under the state
// directory, never the frame — so a session that went wrong can be read
// after the terminal has been given back.
package tui

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/google/uuid"

	"todo/internal/store"
	"todo/internal/task"
)

// Client is what the model needs from the API, defined here by its consumer:
// the login the session comes from and the three task operations the list
// performs. internal/client is the implementation; the tests' fakes are the
// others. The interface is deliberately narrow — the model cannot reach a
// route the list does not use — and the conflict it branches on is the
// domain's sentinel, store.ErrConflict, which both the store and the client
// translate their stale-snapshot failures to.
type Client interface {
	// Login authenticates and leaves the session in the client's cookie
	// jar, so every call after it is the authenticated user's.
	Login(ctx context.Context, email, password string) error
	// ListTasks returns the authenticated user's tasks, in the API's order.
	ListTasks(ctx context.Context) ([]task.Task, error)
	// CreateTask stores a new task and returns the stored copy: the id and
	// the version are the API's to assign.
	CreateTask(ctx context.Context, t task.Task) (task.Task, error)
	// Complete marks the task done, but only while it is still at the given
	// version; a stale snapshot is an error that wraps store.ErrConflict.
	Complete(ctx context.Context, id uuid.UUID, version int) error
}

// mode is what the keyboard is talking to.
type mode int

const (
	// modeLogin is where the model starts: the login form's mode, before
	// any session exists.
	modeLogin mode = iota
	// modeList is the default once signed in: the keys move the cursor and
	// start actions.
	modeList
	// modeAdd is the add input's mode. The input owns the letter keys while
	// it has focus, so the frame's help switches to the input's key map.
	modeAdd
)

// loginField names which of the login form's two inputs has the focus.
type loginField int

const (
	fieldEmail loginField = iota
	fieldPassword
)

// loggedInMsg is a login's success. The session itself needs no message —
// it lands in the client's cookie jar — so the message carries nothing but
// the fact; the model's answer is the list the login made reachable.
type loggedInMsg struct{}

// loginErrMsg is a login's failure, arriving as a message. The form stays
// on screen — the mode is the state until a session exists — and the notice
// says what the API said.
type loginErrMsg struct{ err error }

// tasksMsg is a load's success, arriving as a message: the tasks the API
// returned, in the order it returned them.
type tasksMsg struct{ tasks []task.Task }

// loadErrMsg is a load's failure, arriving as a message. The model never
// panics on an API error and never shows a half-loaded list: the error
// replaces the frame, and the tasks from before the failed load are left
// behind the error until a retry answers.
type loadErrMsg struct{ err error }

// addedMsg is an add's success: the task the API stored, with the id and
// the version it assigned. The model's own copy of the task has neither, so
// the message carries the API's copy and the reload that follows puts it
// on screen.
type addedMsg struct{ task task.Task }

// completedMsg is a complete's success. The API's write reports the stored
// task, but the model needs only the title — the write bumped the version,
// and the follow-up load is where the new state, and the fresh version the
// next compare-and-swap must carry, arrives.
type completedMsg struct{ title string }

// conflictMsg is a write that lost the compare-and-swap: the task changed
// between the model's read and the write. The command recognises
// store.ErrConflict — the client hands the API's 409 back as that sentinel —
// and reports it apart from other failures, because the answer is different:
// re-read the task and show the latest, the store's own advice, where a
// plain failure leaves the list alone.
type conflictMsg struct{ title string }

// opErrMsg is a write that failed for any other reason: a validation error,
// a cancelled context, an API failure. The list stays as it was and the
// notice says what happened.
type opErrMsg struct{ err error }

// notice is the last write's outcome: the line under the list that reports
// what just happened, and whether it is a failure (rendered as a problem) or
// a confirmation. The next key press clears it.
type notice struct {
	text    string
	problem bool
}

// Model is the TUI's whole state: the client to call, the last snapshot of
// the user's tasks, the cursor, the load's outcome, the login form, the
// terminal's width, and the keyboard's current owner. The fields are
// unexported and every Update returns a new Model by value — the model is
// data, the program is the loop — and the tests read the state through the
// accessors below.
//
// ctx is the context the model's commands call the client with. Storing a
// context in a struct is the exception the context package warns about; a
// tea.Cmd is func() tea.Msg and has nowhere to receive one, so the model
// carries the program's context — main's signal context — and a request a
// command makes is cancellable with it.
type Model struct {
	ctx    context.Context
	client Client
	// logger receives the commands' records — a login, a load, a write,
	// and the error each can carry. A full-screen program has no terminal
	// sink to give: the binary hands the file-only logger
	// logging.NewFile builds, and a model a test builds logs into
	// slog.DiscardHandler. The logger is never the program's output
	// writer, whichever model is running.
	logger *slog.Logger

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

	// width is the terminal's width from the last WindowSizeMsg. Zero
	// means no size has been announced — a model built by a test — and
	// the view renders whole lines; a running program gets a size before
	// its first frame.
	width int

	// keys, inputKeys, and loginKeys are the three modes' key maps, and
	// help is the bubble that renders the active one. The help follows the
	// focus through activeKeys.
	keys      listKeys
	inputKeys inputKeys
	loginKeys loginKeys
	help      help.Model

	// mode is what the keyboard is talking to, and input is the add
	// mode's text input, focused exactly while mode is modeAdd.
	mode  mode
	input textinput.Model

	// email and password are the login form's fields, and focus says which
	// one owns the keys. The password renders masked; the text never
	// reaches a frame.
	email    textinput.Model
	password textinput.Model
	focus    loginField

	// notice is the last write's outcome, shown under the list until the
	// next key press.
	notice notice

	// pending is the task the next successful load should put the cursor
	// on: an add sets it to the task the API stored, so the new row is
	// the selected one. uuid.Nil — the zero value — means no task is
	// pending.
	pending uuid.UUID
}

// Option adjusts the model New builds. There is one option, the logger,
// because the logger is the one dependency the binary has and a test does
// not: a model a test builds records nowhere, and the binary's records go to
// the file main opened.
type Option func(*Model)

// WithLogger gives the model the logger its commands record through. The
// logger never shares the program's output — a full-screen app's stdout is
// the frame, and a record written into it would corrupt the frame — so the
// binary passes the file-only logger logging.NewFile builds.
func WithLogger(l *slog.Logger) Option {
	return func(m *Model) { m.logger = l }
}

// New returns the model the program starts with: the client its commands
// call, the key maps, the help bubble, the login form, and the add input.
// The model starts at the login form — no session exists yet, and the first
// list is the login's follow-up — with the form's first field focused, so
// the first keystroke lands where the frame's cursor is.
func New(ctx context.Context, c Client, opts ...Option) Model {
	email := textinput.New()
	email.Prompt = "email: "
	email.Placeholder = "you@example.com"
	email.PromptStyle = defaultStyles.prompt
	// The focus is set here, where the model value is returned: Bubble Tea
	// keeps the model New returned and hands Init a copy, so a field
	// focused in Init would be focused in a value the program discards.
	email.Focus()

	password := textinput.New()
	password.Prompt = "password: "
	password.EchoMode = textinput.EchoPassword
	password.PromptStyle = defaultStyles.prompt

	input := textinput.New()
	input.Prompt = "add: "
	input.Placeholder = "task title"
	input.PromptStyle = defaultStyles.prompt

	m := Model{
		ctx:       ctx,
		client:    c,
		logger:    slog.New(slog.DiscardHandler),
		keys:      defaultListKeys(),
		inputKeys: defaultInputKeys(),
		loginKeys: defaultLoginKeys(),
		help:      help.New(),
		email:     email,
		password:  password,
		input:     input,
	}
	for _, opt := range opts {
		opt(&m)
	}
	// Nothing has loaded yet, so there is nothing to complete; a is live
	// already, because the first task can arrive while the load is in
	// flight.
	return m.syncKeys()
}

// NewProgram builds the program the binary runs: the model, and the
// terminal modes the model must not know about. The alternate screen is the
// program's decision, not the model's — a model renders the same frames to
// a terminal and to a test's buffer — and the variadic options exist so
// tests can build the same program over injected IO. m is a tea.Model and
// not the concrete model so a test can wrap the model under test with a
// fault — the panic test injects one where the program's recovery must
// catch it — while the binary's call passes a tui.Model unchanged.
func NewProgram(m tea.Model, opts ...tea.ProgramOption) *tea.Program {
	return tea.NewProgram(m, append([]tea.ProgramOption{tea.WithAltScreen()}, opts...)...)
}

// Init implements tea.Model: the login form's cursor blink. The model starts
// at the form, so there is no load to run — the first list is the login's
// follow-up — and the only startup work is the focused field's cursor. The
// focus itself is set in New; Init's receiver is a copy the program
// discards, so its only job is the command.
func (m Model) Init() tea.Cmd { return m.email.Focus() }

// Update implements tea.Model: the whole of the model's behaviour, one
// message in, the next state and an optional command out. Key presses are
// the only input; the API never reaches the model except through the
// messages its commands produce.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return m.resize(msg.Width), nil
	case loggedInMsg:
		// The session is in the client's jar; the list it makes reachable
		// is the login's follow-up. The notice of a failed attempt goes
		// with the failure.
		m.mode = modeList
		m.notice = notice{}
		return m, loadTasks(m.ctx, m.client, m.logger)
	case loginErrMsg:
		m.notice = notice{text: msg.err.Error(), problem: true}
		return m, nil
	case tasksMsg:
		m.tasks = msg.tasks
		m.loaded = true
		m.err = nil
		// A reload can find a shorter list than the one on screen; the
		// cursor must not point past the end. min(max(n-1, 0), cursor)
		// keeps an empty list at 0.
		m.cursor = min(m.cursor, max(len(m.tasks)-1, 0))
		// An add's reload lands the cursor on the task the API stored, so
		// the row that just appeared is the selected one.
		if m.pending != uuid.Nil {
			for i, t := range m.tasks {
				if t.ID == m.pending {
					m.cursor = i
					break
				}
			}
			m.pending = uuid.Nil
		}
		return m.syncKeys(), nil
	case loadErrMsg:
		m.loaded = true
		m.err = msg.err
		return m.syncKeys(), nil
	case addedMsg:
		m.notice = notice{text: fmt.Sprintf("added %q", msg.task.Title)}
		m.pending = msg.task.ID
		return m, loadTasks(m.ctx, m.client, m.logger)
	case completedMsg:
		m.notice = notice{text: fmt.Sprintf("completed %q", msg.title)}
		// The write bumped the version the model holds, so the snapshot is
		// stale even though the write won: re-read before the next
		// compare-and-swap.
		return m, loadTasks(m.ctx, m.client, m.logger)
	case conflictMsg:
		m.notice = notice{
			text:    fmt.Sprintf("%q changed elsewhere; list refreshed", msg.title),
			problem: true,
		}
		return m, loadTasks(m.ctx, m.client, m.logger)
	case opErrMsg:
		m.notice = notice{text: msg.err.Error(), problem: true}
		return m, nil
	case tea.KeyMsg:
		return m.updateKey(msg)
	}
	// Everything else — the inputs' cursor blinks, their paste results —
	// belongs to the focused text input.
	switch m.mode {
	case modeLogin:
		return m.updateLogin(msg)
	case modeAdd:
		return m.updateInput(msg)
	}
	return m, nil
}

// updateKey is Update's key half: the keyboard contract, one switch over the
// modes' key maps. A key the current mode has no binding for changes
// nothing.
func (m Model) updateKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// The notice reports the last write; a key press is the reader moving
	// on, so it clears.
	m.notice = notice{}

	switch m.mode {
	case modeLogin:
		return m.updateLoginKey(msg)
	case modeAdd:
		return m.updateInputKey(msg)
	}

	switch {
	case key.Matches(msg, m.keys.Quit):
		return m, tea.Quit
	case key.Matches(msg, m.keys.Up):
		if m.cursor > 0 {
			m.cursor--
		}
	case key.Matches(msg, m.keys.Down):
		if m.cursor < len(m.tasks)-1 {
			m.cursor++
		}
	case key.Matches(msg, m.keys.Add):
		return m.startAdd()
	case key.Matches(msg, m.keys.Complete):
		return m.startComplete()
	case key.Matches(msg, m.keys.Reload):
		return m, loadTasks(m.ctx, m.client, m.logger)
	}
	return m, nil
}

// updateLoginKey is the login form's keyboard: enter submits from either
// field, tab switches the focused field, ctrl+c quits, and every other key
// is the focused input's own.
func (m Model) updateLoginKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.loginKeys.Quit):
		return m, tea.Quit
	case key.Matches(msg, m.loginKeys.Next):
		return m.switchField()
	case key.Matches(msg, m.loginKeys.Submit):
		return m.submitLogin()
	}
	return m.updateLogin(msg)
}

// updateLogin hands the login form's traffic to the focused field and keeps
// what it returns: the cursor's blink schedule rides the commands it
// produces.
func (m Model) updateLogin(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	if m.focus == fieldPassword {
		m.password, cmd = m.password.Update(msg)
	} else {
		m.email, cmd = m.email.Update(msg)
	}
	return m, cmd
}

// switchField moves the focus between the login form's two fields: the
// focused field owns the keys, and the frame's cursor follows. The command
// it returns is the newly focused field's blink schedule.
func (m Model) switchField() (tea.Model, tea.Cmd) {
	if m.focus == fieldEmail {
		m.focus = fieldPassword
		m.email.Blur()
		return m, m.password.Focus()
	}
	m.focus = fieldEmail
	m.password.Blur()
	return m, m.email.Focus()
}

// submitLogin hands the credentials to the API as a command. The form stays
// — the mode is the state until a session exists — and keeps its text, so a
// failed attempt is a notice and a fix, not a retype.
func (m Model) submitLogin() (tea.Model, tea.Cmd) {
	return m, login(m.ctx, m.client, m.logger, m.email.Value(), m.password.Value())
}

// updateInputKey is the add mode's keyboard: enter submits, esc leaves the
// mode without a task, ctrl+c quits from anywhere, and every other key is
// the input's own — the letters, the arrows, the editing keys.
func (m Model) updateInputKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.inputKeys.Quit):
		return m, tea.Quit
	case key.Matches(msg, m.inputKeys.Cancel):
		return m.stopAdd(), nil
	case key.Matches(msg, m.inputKeys.Submit):
		return m.submitAdd()
	}
	return m.updateInput(msg)
}

// updateInput hands the input's own traffic to the input and keeps what it
// returns: the cursor's blink schedule rides the commands it produces.
func (m Model) updateInput(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

// startAdd focuses the input: the list keeps its state, the frame gains the
// input line, and the help switches to the input's keys. The command the
// focus returns is the cursor's blink schedule.
func (m Model) startAdd() (tea.Model, tea.Cmd) {
	m.mode = modeAdd
	m.input.Reset()
	return m, m.input.Focus()
}

// stopAdd leaves the add mode: the input is cleared and blurred, and the
// keyboard belongs to the list again.
func (m Model) stopAdd() Model {
	m.mode = modeList
	m.input.Reset()
	m.input.Blur()
	return m
}

// submitAdd turns the input's text into a task. The domain's constructor
// validates it: an empty or overlong title becomes a notice, the input keeps
// its text and its focus so the reader can fix it, and the next keystroke
// clears the notice. A valid title leaves the mode and goes to the API as a
// command.
func (m Model) submitAdd() (tea.Model, tea.Cmd) {
	t, err := task.NewTask(m.input.Value())
	if err != nil {
		m.notice = notice{text: err.Error(), problem: true}
		return m, nil
	}
	return m.stopAdd(), addTask(m.ctx, m.client, m.logger, t)
}

// startComplete completes the selected task. The compare-and-swap carries
// the id and the version the model read, so a task that changed since the
// read is refused — the conflict path — rather than overwritten. A task
// already done is not written again, because the API would only bump its
// version; the notice says so instead.
func (m Model) startComplete() (tea.Model, tea.Cmd) {
	t := m.tasks[m.cursor]
	if t.Status == task.StatusDone {
		m.notice = notice{text: fmt.Sprintf("%q is already done", t.Title)}
		return m, nil
	}
	return m, completeTask(m.ctx, m.client, m.logger, t)
}

// resize applies a terminal size: the width rows and notices are cut to, the
// width the inputs scroll in, and the help's truncation width and its
// short-or-full choice. A zero width — no size announced — leaves the model
// as it is.
func (m Model) resize(width int) Model {
	if width <= 0 {
		return m
	}
	m.width = width
	m.help.Width = width
	m.help.ShowAll = width >= fullHelpMin
	// An input's width is its text's viewport: the terminal width minus
	// the prompt, minus one cell for the cursor the component pads with.
	m.input.Width = max(width-lipgloss.Width(m.input.Prompt)-1, 0)
	m.email.Width = max(width-lipgloss.Width(m.email.Prompt)-1, 0)
	m.password.Width = max(width-lipgloss.Width(m.password.Prompt)-1, 0)
	return m
}

// syncKeys points the list's key map at what the current state can do: with
// no tasks there is nothing to complete, and a failed load leaves nothing to
// act on but the reload. A disabled binding is neither matched nor rendered,
// so the keyboard and the help line cannot disagree.
func (m Model) syncKeys() Model {
	m.keys.Add.SetEnabled(m.err == nil)
	m.keys.Complete.SetEnabled(m.err == nil && len(m.tasks) > 0)
	return m
}

// activeKeys is the key map the help renders: the login form's while it is
// the mode, the input's while the add mode has focus, the list's otherwise.
func (m Model) activeKeys() help.KeyMap {
	switch m.mode {
	case modeLogin:
		return m.loginKeys
	case modeAdd:
		return m.inputKeys
	}
	return m.keys
}

// Cursor returns the index of the selected task.
func (m Model) Cursor() int { return m.cursor }

// Tasks returns the tasks the model is showing. The slice is a copy: a
// caller cannot reach the model's own state by mutating what it was handed,
// the same rule the client's decoded answers follow.
func (m Model) Tasks() []task.Task { return slices.Clone(m.tasks) }

// Err returns the last load's failure, or nil when the last load succeeded.
func (m Model) Err() error { return m.err }

// login is the login command: authenticate and report back as a loggedInMsg
// or a loginErrMsg. The command is where the request lives — the model
// itself never blocks on the API — and the session needs no message: it
// lands in the client's cookie jar. The command is also where the record
// lives: a login the API refused is the first thing a TUI debugging session
// wants in the file, and it is written before the message is returned, so
// the frame that reports the failure and the file that explains it agree.
func login(ctx context.Context, c Client, logger *slog.Logger, email, password string) tea.Cmd {
	return func() tea.Msg {
		if err := c.Login(ctx, email, password); err != nil {
			logger.Warn("sign in failed", "email", email, "err", err)
			return loginErrMsg{err: fmt.Errorf("sign in: %w", err)}
		}
		logger.Debug("signed in", "email", email)
		return loggedInMsg{}
	}
}

// loadTasks is the model's load command: read the API and report the result
// back to Update as a tasksMsg or a loadErrMsg. Commands are where the IO
// lives — the model itself never blocks — and a command runs on the
// program's command goroutine, so the event loop stays free to draw the
// loading frame and to handle a quit while a slow API answers. The success
// is a debug record — loads are the chattiest thing a TUI does, and a count
// is what makes "the list is empty" and "the load failed" distinguishable
// after the fact — while the failure is a warning, because it is the record
// a report of a broken session starts from.
func loadTasks(ctx context.Context, c Client, logger *slog.Logger) tea.Cmd {
	return func() tea.Msg {
		tasks, err := c.ListTasks(ctx)
		if err != nil {
			logger.Warn("tasks load failed", "err", err)
			return loadErrMsg{err: err}
		}
		logger.Debug("tasks loaded", "count", len(tasks))
		return tasksMsg{tasks: tasks}
	}
}

// addTask is the add's command: store the task and report the stored copy —
// the id and the version are the API's to assign — back to Update, which
// then asks for a fresh list. The record carries the title, the same handle
// the CLI's records use, so one grep finds a task's writes across both
// binaries.
func addTask(ctx context.Context, c Client, logger *slog.Logger, t task.Task) tea.Cmd {
	return func() tea.Msg {
		stored, err := c.CreateTask(ctx, t)
		if err != nil {
			logger.Warn("task add failed", "title", t.Title, "err", err)
			return opErrMsg{err: fmt.Errorf("add %q: %w", t.Title, err)}
		}
		logger.Info("task added", "id", stored.ID.String(), "title", stored.Title)
		return addedMsg{task: stored}
	}
}

// completeTask is the complete's command: the compare-and-swap with the id
// and the version the model read. A stale snapshot arrives as
// store.ErrConflict — the sentinel the compare-and-swap exists for, which
// the client hands back for the API's 409 — and the command reports it
// apart, because the model's answer is to re-read. The record does the same:
// the conflict is its own warning, not a failure, because the API refused
// the write for a reason the user can act on.
func completeTask(ctx context.Context, c Client, logger *slog.Logger, t task.Task) tea.Cmd {
	return func() tea.Msg {
		if err := c.Complete(ctx, t.ID, t.Version); err != nil {
			if errors.Is(err, store.ErrConflict) {
				logger.Warn("task complete conflicted", "id", t.ID.String(), "title", t.Title)
				return conflictMsg{title: t.Title}
			}
			logger.Warn("task complete failed", "id", t.ID.String(), "title", t.Title, "err", err)
			return opErrMsg{err: fmt.Errorf("complete %q: %w", t.Title, err)}
		}
		logger.Info("task completed", "id", t.ID.String(), "title", t.Title)
		return completedMsg{title: t.Title}
	}
}
````


## `internal/tui/tui_test.go`

````go
// Package tui_test is the TUI's test package: the model's unit tests against
// a fake API at the client seam, the teatest runs that drive the real event
// loop, and the program test that pins the terminal modes. It is external —
// the tests see exactly the API cmd/todo-tui sees — and it reads the model's
// state through the accessors the model publishes for its callers.
package tui_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/google/uuid"
	"github.com/muesli/termenv"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/client"
	"todo/internal/store"
	"todo/internal/task"
	"todo/internal/tui"
)

// TestMain pins the profile the frames render in. The tests assert on plain
// text, and lipgloss decides between color and no color by looking at the
// terminal it would render to — so without the pin the same frame could
// match on one machine and not another. SetColorProfile is lipgloss's hook
// for exactly this; the running program still colors its frames.
func TestMain(m *testing.M) {
	lipgloss.SetColorProfile(termenv.Ascii)
	os.Exit(m.Run())
}

// fakeClient is the model's seam: the API as the tests script it. It
// implements tui.Client with one field per answer — the tasks a list serves,
// the error each call fails with — so a test states the API's behaviour as
// data and the model's reaction is what is under test. The mutex guards the
// state because the teatest runs call the fake from the program's command
// goroutine while the test goroutine reads the counters.
type fakeClient struct {
	mu sync.Mutex

	tasks []task.Task

	loginErr    error
	listErr     error
	createErr   error
	completeErr error

	logins    int
	creates   int
	completes int
	email     string
	password  string
}

// Login records the credentials and answers with the scripted error.
func (f *fakeClient) Login(_ context.Context, email, password string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logins++
	f.email, f.password = email, password
	return f.loginErr
}

// ListTasks serves the fake's tasks, or the scripted error. The slice is a
// copy: the model cannot reach the fake's state by mutating what it was
// served, the same rule the API's decoded answer follows.
func (f *fakeClient) ListTasks(context.Context) ([]task.Task, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]task.Task(nil), f.tasks...), nil
}

// CreateTask stands in for the API's write: it assigns an id and version 1,
// stores the task, and returns the stored copy — the same division of
// labour the real API has.
func (f *fakeClient) CreateTask(_ context.Context, t task.Task) (task.Task, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates++
	if f.createErr != nil {
		return task.Task{}, f.createErr
	}
	t.ID = uuid.New()
	t.Version = 1
	f.tasks = append(f.tasks, t)
	return t, nil
}

// Complete applies the write — the status and the version — or answers with
// the scripted error, the conflict case included.
func (f *fakeClient) Complete(_ context.Context, id uuid.UUID, version int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completes++
	if f.completeErr != nil {
		return f.completeErr
	}
	for i, t := range f.tasks {
		if t.ID == id {
			f.tasks[i].Status = task.StatusDone
			f.tasks[i].Version = version + 1
		}
	}
	return nil
}

// Logins returns how many login calls the fake has seen.
func (f *fakeClient) Logins() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.logins
}

// LastLogin returns the credentials of the most recent login call.
func (f *fakeClient) LastLogin() (email, password string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.email, f.password
}

// Completes returns how many complete calls the fake has seen.
func (f *fakeClient) Completes() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.completes
}

// seed gives the fake one Todo task per title — the state a signed-in user's
// API would serve — and returns what the fake stored. Titles are the tests'
// whole vocabulary: the frames never show ids, so nothing here depends on the
// id or version values.
func seed(f *fakeClient, titles ...string) []task.Task {
	f.mu.Lock()
	defer f.mu.Unlock()
	var stored []task.Task
	for _, title := range titles {
		t := task.Task{
			ID:       uuid.New(),
			Version:  1,
			Title:    title,
			Status:   task.StatusTodo,
			Priority: task.PriorityDefault,
		}
		f.tasks = append(f.tasks, t)
		stored = append(stored, t)
	}
	return stored
}

// signedIn returns a model signed in to f, holding the tasks f serves: the
// state every model test after the login cases starts from. The helper
// drives the real message sequence — email, tab, password, enter, the
// login's answer, the load it asks for — so the seam is the model's own
// flow, not a constructor shortcut.
func signedIn(t *testing.T, f *fakeClient) tui.Model {
	t.Helper()
	m := tui.New(context.Background(), f)
	m, _ = update(t, m, typed("alice@example.com"))
	m, _ = update(t, m, key("tab"))
	m, _ = update(t, m, typed("correct horse battery staple"))

	var cmd tea.Cmd
	m, cmd = update(t, m, key("enter"))
	require.NotNil(t, cmd, "enter must return the login command")

	m, cmd = update(t, m, cmd())
	require.NotNil(t, cmd, "a successful login must ask for the list")

	m, _ = update(t, m, cmd())
	return m
}

// update feeds one message to the model and returns the next model and the
// command, asserting the model type the whole way.
func update(t *testing.T, m tui.Model, msg tea.Msg) (tui.Model, tea.Cmd) {
	t.Helper()
	next, cmd := m.Update(msg)
	got, ok := next.(tui.Model)
	require.True(t, ok, "Update must return the same model type")
	return got, cmd
}

// key builds the KeyMsg a terminal would deliver for the given key name:
// the runes for the letters, the special types for the named keys.
func key(name string) tea.KeyMsg {
	switch name {
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "tab":
		return tea.KeyMsg{Type: tea.KeyTab}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(name)}
	}
}

// typed builds the KeyMsg a terminal delivers for a run of characters: one
// message with every rune, the way a paste arrives.
func typed(s string) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

// titles maps tasks to their titles, for order-sensitive assertions.
func titles(tasks []task.Task) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.Title
	}
	return out
}

// assertFrameFits pins the width rule: no rendered line is wider than the
// terminal, whatever the state produced. lipgloss.Width counts cells, so a
// line of wide runes is measured the way the terminal measures it.
func assertFrameFits(t *testing.T, view string, width int) {
	t.Helper()
	for i, line := range strings.Split(view, "\n") {
		assert.LessOrEqualf(t, lipgloss.Width(line), width,
			"line %d of the frame is wider than the %d-column terminal:\n%q", i+1, width, line)
	}
}

// TestModel_LoginFlow is the model's login path end to end: the form the
// model starts at, the fields the keys land in, and the list the login asks
// for. The session itself is the client's — the jar is where the cookie
// lands — so the model's only trace of the success is the list it loads.
func TestModel_LoginFlow(t *testing.T) {
	f := &fakeClient{}
	m := tui.New(context.Background(), f)

	// The model starts at the form: the frame names it and the fields, and
	// the help offers the login keys.
	view := m.View()
	assert.Contains(t, view, "todo: sign in")
	assert.Contains(t, view, "email: ")
	assert.Contains(t, view, "password: ")
	assert.Contains(t, view, "enter sign in • tab next field • ctrl+c quit")

	// The email lands in the first field; tab moves the keys to the
	// password, which renders masked.
	m, _ = update(t, m, typed("alice@example.com"))
	assert.Contains(t, m.View(), "email: alice@example.com")

	m, _ = update(t, m, key("tab"))
	m, _ = update(t, m, typed("hunter2"))
	view = m.View()
	assert.Contains(t, view, "password: *******")
	assert.NotContains(t, view, "hunter2", "the password never reaches the frame")

	// Enter submits: the model leaves the form to the API and the command
	// is the login.
	var cmd tea.Cmd
	m, cmd = update(t, m, key("enter"))
	require.NotNil(t, cmd, "enter must return the login command")

	// The login's answer asks for the list; the frame says a load is in
	// flight until it lands.
	m, cmd = update(t, m, cmd())
	require.NotNil(t, cmd, "a successful login must ask for the list")
	assert.Contains(t, m.View(), "loading tasks")

	m, _ = update(t, m, cmd())
	assert.Contains(t, m.View(), "todo: 0 tasks")
	assert.Equal(t, 1, f.Logins())
	email, password := f.LastLogin()
	assert.Equal(t, "alice@example.com", email)
	assert.Equal(t, "hunter2", password)
}

// TestModel_LoginFailure pins the error UX of the form: the API's failure
// becomes a notice, the form stays — the fields keep their text, so a typo
// is fixable — and the next keystroke clears the notice.
func TestModel_LoginFailure(t *testing.T) {
	f := &fakeClient{loginErr: &client.Error{
		StatusCode: 401,
		Code:       "unauthorized",
		Message:    "invalid email or password",
	}}
	m := tui.New(context.Background(), f)
	m, _ = update(t, m, typed("alice@example.com"))
	m, _ = update(t, m, key("tab"))
	m, _ = update(t, m, typed("wrong password"))

	var cmd tea.Cmd
	m, cmd = update(t, m, key("enter"))
	m, cmd = update(t, m, cmd())

	assert.Nil(t, cmd, "a failed login asks for nothing")
	view := m.View()
	assert.Contains(t, view, "sign in: invalid email or password")
	assert.Contains(t, view, "todo: sign in", "the form is still the mode")
	assert.Contains(t, view, "email: alice@example.com", "the form keeps what was typed")

	m, _ = update(t, m, typed("x"))
	assert.NotContains(t, m.View(), "invalid email or password", "the next keystroke clears the notice")
}

// TestModel_LoginValidation pins the API's field failures as the login
// form's error surface: the 422's field sentences reach the notice, because
// the client's Error renders them.
func TestModel_LoginValidation(t *testing.T) {
	f := &fakeClient{loginErr: &client.Error{
		StatusCode: 422,
		Code:       "validation_failed",
		Message:    "validation failed",
		Fields:     []client.FieldError{{Field: "email", Message: "is required"}},
	}}
	m := tui.New(context.Background(), f)

	var cmd tea.Cmd
	m, cmd = update(t, m, key("enter"))
	m, _ = update(t, m, cmd())

	assert.Contains(t, m.View(), "sign in: validation failed: email is required")
}

// TestModel_FieldSwitch pins the focus rule: the focused field owns the
// keys, and tab moves the focus both ways.
func TestModel_FieldSwitch(t *testing.T) {
	m := tui.New(context.Background(), &fakeClient{})

	m, _ = update(t, m, typed("a"))
	m, _ = update(t, m, key("tab"))
	m, _ = update(t, m, typed("b"))
	view := m.View()
	assert.Contains(t, view, "email: a")
	assert.Contains(t, view, "password: *")

	// Tab again returns to the email field: the next rune lands there.
	m, _ = update(t, m, key("tab"))
	m, _ = update(t, m, typed("c"))
	assert.Contains(t, m.View(), "email: ac")
}

// TestModel_LoginFormOwnsTheKeys pins the keyboard contract of the form:
// while it is the mode, the letter keys belong to the focused field — q
// types a q — and ctrl+c quits from anywhere.
func TestModel_LoginFormOwnsTheKeys(t *testing.T) {
	m := tui.New(context.Background(), &fakeClient{})

	m, _ = update(t, m, key("q"))
	assert.Contains(t, m.View(), "email: q", "q must type, not quit")

	_, cmd := update(t, m, key("ctrl+c"))
	require.NotNil(t, cmd, "ctrl+c quits from the form too")
	assert.Equal(t, tea.QuitMsg{}, cmd())
}

// TestModel_LoadFailure pins the list's failure state: a failed load after a
// successful login replaces the frame with the error and leaves only the
// keys that still act.
func TestModel_LoadFailure(t *testing.T) {
	f := &fakeClient{listErr: errors.New("the API is down")}

	m := signedIn(t, f)

	require.Error(t, m.Err())
	assert.Contains(t, m.Err().Error(), "the API is down")
	assert.Empty(t, m.Tasks())

	view := m.View()
	assert.Contains(t, view, "could not load tasks")
	assert.Contains(t, view, "the API is down")
	assert.Contains(t, view, "r reload • q quit", "a failed load leaves only the keys that still act")
}

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
			f := &fakeClient{}
			seed(f, "write the chapter", "buy milk", "ship it")

			m := signedIn(t, f)
			for _, name := range tt.keys {
				m, _ = update(t, m, key(name))
			}
			assert.Equal(t, tt.want, m.Cursor())
		})
	}
}

func TestModel_NavigationEmpty(t *testing.T) {
	// An empty list has nowhere to move: the cursor stays put and the view
	// stays renderable.
	m := signedIn(t, &fakeClient{})

	for _, name := range []string{"j", "down", "k", "up"} {
		m, _ = update(t, m, key(name))
	}
	assert.Equal(t, 0, m.Cursor())
	assert.Contains(t, m.View(), "No tasks yet.")
}

func TestModel_QuitKeys(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"q", "ctrl+c"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			m := signedIn(t, &fakeClient{})

			_, cmd := m.Update(key(name))
			require.NotNil(t, cmd, "%s must return the quit command", name)
			assert.Equal(t, tea.QuitMsg{}, cmd(), "q and ctrl+c both leave through tea.Quit")
		})
	}
}

func TestModel_Reload(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter")
	m := signedIn(t, f)

	// The API changes behind the model's back, the way another client
	// writes while the TUI is open.
	seed(f, "buy milk")

	var cmd tea.Cmd
	m, cmd = update(t, m, key("r"))
	require.NotNil(t, cmd, "r must return a load command")

	// The old snapshot is still on screen until the command lands.
	assert.Equal(t, []string{"write the chapter"}, titles(m.Tasks()))

	m, _ = update(t, m, cmd())
	assert.Equal(t, []string{"write the chapter", "buy milk"}, titles(m.Tasks()))
}

func TestModel_ReloadClampsTheCursor(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter", "buy milk", "ship it")
	m := signedIn(t, f)

	m, _ = update(t, m, key("j"))
	m, _ = update(t, m, key("j"))
	require.Equal(t, 2, m.Cursor())

	// A reload that finds a shorter list must not leave the cursor past
	// the end.
	f.mu.Lock()
	f.tasks = f.tasks[:1]
	f.mu.Unlock()

	var cmd tea.Cmd
	m, cmd = update(t, m, key("r"))
	m, _ = update(t, m, cmd())
	assert.Equal(t, 0, m.Cursor(), "a one-task list clamps the cursor to its only row")
}

func TestModel_View(t *testing.T) {
	t.Run("before the login", func(t *testing.T) {
		t.Parallel()
		assert.Contains(t, tui.New(context.Background(), &fakeClient{}).View(), "todo: sign in")
	})

	t.Run("empty list", func(t *testing.T) {
		t.Parallel()
		m := signedIn(t, &fakeClient{})
		view := m.View()
		assert.Contains(t, view, "todo: 0 tasks")
		assert.Contains(t, view, "No tasks yet.")
		assert.Contains(t, view, "a add • r reload • q quit",
			"there is nothing to complete, so the help does not offer it")
	})

	t.Run("tasks", func(t *testing.T) {
		t.Parallel()
		f := &fakeClient{}
		seed(f, "write the chapter", "buy milk", "ship it")
		f.mu.Lock()
		f.tasks[2].Status = task.StatusDone
		f.mu.Unlock()

		m := signedIn(t, f)
		view := m.View()
		assert.Contains(t, view, "todo: 3 tasks")
		assert.Contains(t, view, "> [ ] write the chapter")
		assert.Contains(t, view, "  [ ] buy milk")
		assert.Contains(t, view, "  [x] ship it")
		assert.Contains(t, view, "a add • enter complete • r reload • q quit")
	})
}

func TestModel_Width(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write a title long enough to be cut")
	m := signedIn(t, f)

	// A narrow terminal cuts the row with an ellipsis, keeps the one-line
	// help, and never lets a line past the width.
	m, _ = update(t, m, tea.WindowSizeMsg{Width: 24, Height: 20})
	view := m.View()
	assert.Contains(t, view, "> [ ] write a title lon…")
	assert.NotContains(t, view, "move down", "the full help is for terminals with room")
	assertFrameFits(t, view, 24)

	// A roomy terminal renders the reference card instead.
	m, _ = update(t, m, tea.WindowSizeMsg{Width: 100, Height: 20})
	assert.Contains(t, m.View(), "move down")
	assert.Contains(t, m.View(), "reload")

	// The input scrolls inside the width as well: the tail of a long title
	// stays visible, and the frame still fits.
	m, _ = update(t, m, tea.WindowSizeMsg{Width: 30, Height: 20})
	m, _ = update(t, m, key("a"))
	m, _ = update(t, m, typed("a task title that will not fit at all"))
	view = m.View()
	assert.Contains(t, view, "add: that will not fit at all")
	assertFrameFits(t, view, 30)

	// The login form is cut to the width too.
	m = tui.New(context.Background(), &fakeClient{})
	m, _ = update(t, m, tea.WindowSizeMsg{Width: 24, Height: 20})
	m, _ = update(t, m, typed("alice@example.com"))
	assertFrameFits(t, m.View(), 24)
}

func TestModel_AddFlow(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter")
	m := signedIn(t, f)

	// a opens the input: the frame names the mode, its placeholder, and
	// the keys that leave it.
	m, _ = update(t, m, key("a"))
	view := m.View()
	assert.Contains(t, view, "add: task title")
	assert.Contains(t, view, "enter add • esc cancel • ctrl+c quit")

	// The letters land in the input, not in the list.
	m, _ = update(t, m, typed("buy milk"))
	assert.Contains(t, m.View(), "add: buy milk")

	// Enter submits: the model leaves the input and hands the task to the
	// API as a command.
	var cmd tea.Cmd
	m, cmd = update(t, m, key("enter"))
	require.NotNil(t, cmd, "enter must return the add command")
	assert.NotContains(t, m.View(), "add:", "submitting leaves the input")

	// The add's answer asks for a fresh list; the notice says what
	// happened, and the old snapshot is still on screen until it lands.
	m, cmd = update(t, m, cmd())
	require.NotNil(t, cmd, "the add's answer must ask for a fresh list")
	assert.Contains(t, m.View(), `added "buy milk"`)
	assert.Equal(t, []string{"write the chapter"}, titles(m.Tasks()))

	m, _ = update(t, m, cmd())
	assert.Equal(t, []string{"write the chapter", "buy milk"}, titles(m.Tasks()))
	assert.Equal(t, 1, m.Cursor(), "the cursor lands on the task just added")
	assert.Contains(t, m.View(), "> [ ] buy milk")
}

func TestModel_AddCancel(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter")
	m := signedIn(t, f)

	m, _ = update(t, m, key("a"))
	m, _ = update(t, m, typed("half a thought"))
	m, _ = update(t, m, key("esc"))

	assert.NotContains(t, m.View(), "add:", "esc leaves the input")
	assert.Equal(t, []string{"write the chapter"}, titles(m.Tasks()), "a cancelled add writes nothing")

	// Reopening the input finds it empty: the cancelled text is gone.
	m, _ = update(t, m, key("a"))
	assert.Contains(t, m.View(), "add: task title")
}

func TestModel_AddValidatesTitle(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter")
	m := signedIn(t, f)

	// Submitting an empty input runs the domain's constructor, which
	// refuses the title: the notice says why and the input keeps its focus.
	m, _ = update(t, m, key("a"))
	m, cmd := update(t, m, key("enter"))
	assert.Nil(t, cmd, "an invalid title must not reach the API")
	assert.Contains(t, m.View(), "invalid title: cannot be empty")
	assert.Contains(t, m.View(), "add: task title", "the input is still there to fix")

	// The next keystroke clears the notice.
	m, _ = update(t, m, typed("b"))
	assert.NotContains(t, m.View(), "cannot be empty")
	assert.Contains(t, m.View(), "add: b")
}

func TestModel_InputOwnsTheKeys(t *testing.T) {
	m := signedIn(t, &fakeClient{})
	m, _ = update(t, m, key("a"))

	// q types a q while the input has focus: the letter keys belong to the
	// input, and a quit is not among its bindings.
	m, _ = update(t, m, key("q"))
	assert.Contains(t, m.View(), "add: q", "q must type, not quit")

	// ctrl+c quits from the input too.
	_, cmd := update(t, m, key("ctrl+c"))
	require.NotNil(t, cmd, "ctrl+c quits from the input too")
	assert.Equal(t, tea.QuitMsg{}, cmd())
}

func TestModel_Complete(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter", "buy milk")
	m := signedIn(t, f)

	// Enter completes the selected task: the command carries the id and
	// the version the model read.
	var cmd tea.Cmd
	m, cmd = update(t, m, key("enter"))
	require.NotNil(t, cmd, "enter must return the complete command")

	// The answer reports the write and asks for a fresh list — the write
	// bumped the version, so the snapshot on screen is stale.
	m, cmd = update(t, m, cmd())
	require.NotNil(t, cmd, "the complete's answer must ask for a fresh list")
	assert.Contains(t, m.View(), `completed "write the chapter"`)

	m, _ = update(t, m, cmd())
	assert.Equal(t, task.StatusDone, m.Tasks()[0].Status)
	assert.Contains(t, m.View(), "> [x] write the chapter")
	assert.Equal(t, 0, m.Cursor())
}

func TestModel_CompleteConflict(t *testing.T) {
	f := &fakeClient{completeErr: store.ErrConflict}
	seed(f, "write the chapter")
	m := signedIn(t, f)

	// Someone else completes the task between the model's read and its
	// write — the CLI, or another TUI. The API's compare-and-swap refuses
	// the stale version, the client hands the refusal back as the domain's
	// conflict, and the model re-reads.
	f.mu.Lock()
	f.tasks[0].Status = task.StatusDone
	f.tasks[0].Version++
	f.mu.Unlock()

	m, cmd := update(t, m, key("enter"))
	require.NotNil(t, cmd)
	m, cmd = update(t, m, cmd())
	require.NotNil(t, cmd, "a lost compare-and-swap must refresh the list")

	view := m.View()
	assert.Contains(t, view, "changed elsewhere", "the notice names the conflict")
	assert.NotContains(t, view, "[x]", "the stale snapshot is still on screen until the load lands")

	m, _ = update(t, m, cmd())
	assert.Contains(t, m.View(), "> [x] write the chapter", "the refresh shows the other writer's write")
}

func TestModel_CompleteDoneTask(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter")
	f.mu.Lock()
	f.tasks[0].Status = task.StatusDone
	f.mu.Unlock()
	m := signedIn(t, f)

	var cmd tea.Cmd
	m, cmd = update(t, m, key("enter"))
	assert.Nil(t, cmd, "a done task is not written again")
	assert.Contains(t, m.View(), `"write the chapter" is already done`)
	assert.Zero(t, f.Completes(), "the API never saw the write")
}

func TestModel_TasksAreACopy(t *testing.T) {
	f := &fakeClient{}
	seed(f, "write the chapter")
	m := signedIn(t, f)

	got := m.Tasks()
	got[0].Title = "renamed"
	assert.Equal(t, []string{"write the chapter"}, titles(m.Tasks()), "callers cannot reach the model's own slice")
}
````


## `internal/tui/view.go`

````go
package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"todo/internal/task"
)

// fullHelpMin is the width from which the help renders its full form. The
// one-liner fits almost anywhere; the two-column grid is for terminals with
// room to spare, where the extra lines do not crowd the list.
const fullHelpMin = 70

// View implements tea.Model: the frame the program renders. It is a pure
// function of the model — no IO, no API call, no terminal query — which is
// what makes every frame a string the tests can assert on.
//
// The frame is composed with lipgloss: a header, the list, the notice of the
// last write, the add input while it has focus, and the help — joined
// vertically, every block left-aligned. The blocks whose text can grow — the
// rows, the notice, the inputs, the help — are cut to the terminal's width
// with an ellipsis, so the frame stays inside the terminal however long a
// title or a notice is; the width also chooses the help's short or full
// form. Before a session exists the login form is the whole frame.
func (m Model) View() string {
	switch {
	case m.mode == modeLogin:
		return m.loginView()
	case m.err != nil:
		return m.problemView()
	case !m.loaded:
		return defaultStyles.header.Render("todo: loading tasks...")
	}

	blocks := []string{
		defaultStyles.header.Render(fmt.Sprintf("todo: %d tasks", len(m.tasks))),
		"",
	}
	if len(m.tasks) == 0 {
		blocks = append(blocks, defaultStyles.notice.Render("No tasks yet."))
	} else {
		blocks = append(blocks, m.listView())
	}
	if m.notice.text != "" {
		blocks = append(blocks, "", m.noticeView())
	}
	if m.mode == modeAdd {
		blocks = append(blocks, "", truncate(m.input.View(), m.width))
	}
	// The help bubble truncates its own items, but only when its ellipsis
	// fits too — at a few widths it prefers to overflow — so the line is
	// cut here as well and the frame's rule holds either way.
	blocks = append(blocks, "", truncate(m.help.View(m.activeKeys()), m.width))
	return lipgloss.JoinVertical(lipgloss.Left, blocks...)
}

// loginView is the frame before a session exists: the sign-in header, the
// form's two fields — the password rendered masked by the component, so the
// text never reaches a frame — the notice a failed attempt leaves, and the
// login keys.
func (m Model) loginView() string {
	blocks := []string{
		defaultStyles.header.Render("todo: sign in"),
		"",
		truncate(m.email.View(), m.width),
		truncate(m.password.View(), m.width),
	}
	if m.notice.text != "" {
		blocks = append(blocks, "", m.noticeView())
	}
	blocks = append(blocks, "", truncate(m.help.View(m.loginKeys), m.width))
	return lipgloss.JoinVertical(lipgloss.Left, blocks...)
}

// problemView is the frame a failed load renders: the list gives way to the
// error, and the help shrinks to the keys that still do something — reload
// and quit, because the model disabled the rest.
func (m Model) problemView() string {
	return lipgloss.JoinVertical(lipgloss.Left,
		defaultStyles.problem.Render("todo: could not load tasks"),
		"",
		"  "+truncate(m.err.Error(), m.width-2),
		"",
		truncate(m.help.View(m.keys), m.width),
	)
}

// listView renders the tasks, one row each.
func (m Model) listView() string {
	rows := make([]string, len(m.tasks))
	for i, t := range m.tasks {
		rows[i] = m.rowView(i, t)
	}
	return strings.Join(rows, "\n")
}

// rowView renders one task row: the cursor marker, the status check, and the
// title, cut to the terminal's width. The whole row is one styled string, so
// the frame's text stays contiguous — what the tests read and what the
// terminal shows are the same characters — and the style names the row's
// state: selected rows are bold and accented, done rows faint and struck
// through.
func (m Model) rowView(i int, t task.Task) string {
	row := truncate(marker(i == m.cursor)+check(t.Status)+" "+t.Title, m.width)
	switch {
	case i == m.cursor:
		return defaultStyles.selected.Render(row)
	case t.Status == task.StatusDone:
		return defaultStyles.done.Render(row)
	}
	return row
}

// noticeView is the last write's outcome: one line, a confirmation in the
// quiet style or a failure in the problem style.
func (m Model) noticeView() string {
	line := truncate(m.notice.text, m.width)
	if m.notice.problem {
		return defaultStyles.problem.Render(line)
	}
	return defaultStyles.notice.Render(line)
}

// truncate cuts a block to the width, marking each cut with an ellipsis. A
// width of zero means no size has been announced, and the block is returned
// whole. The cut is per line: ansi.Truncate counts cells rather than bytes,
// so a wide rune is cut at the cell it would cross and the escape codes of a
// styled line survive, and a line that already fits is returned unchanged.
func truncate(block string, width int) string {
	if width <= 0 {
		return block
	}
	lines := strings.Split(block, "\n")
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, width, "…")
	}
	return strings.Join(lines, "\n")
}

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
````
