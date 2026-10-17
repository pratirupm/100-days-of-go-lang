---
title: Styling the terminal UI
day: 50
time: "3 hours"
description: Give the terminal interface a face — color, a text input, and the keys that add and complete tasks.
sidebar:
  order: 42
---

The interface works, but it is plain and it only looks: one color, no way to
add a task, no way to finish one. Today it gets a face — color and emphasis
that say what each line is — and hands: `a` opens a text input for a new
task, and `enter` marks the selected task done.

The frame also learns the terminal's width. A long title is cut with an
ellipsis instead of spilling out of the window, and on a wide terminal the
help line unfolds into a small reference card. The keys the screen
advertises come from the same place as the keys it answers, so the two
cannot disagree.

When it works, the app looks finished: a bold header, the selected row in
the accent color, done tasks faint and struck through, and a line under the
list that says what just happened — `added "call the plumber"`,
`completed "water the plants"`.

## The tests come first

The habit holds: describe the behavior before building it. The new cases
cover three things — the width rules, the add flow, and the two writes — and
they run against the real model and the real in-memory store, reading frames
as strings.

Two new helpers carry the bookkeeping. `update` feeds one message to the
model and hands back the next model and its command; `assertFrameFits` is
the width rule as an assertion:

<!-- verify: internal/tui/tui_test.go at=tui-styling -->
```go title="internal/tui/tui_test.go"
// update feeds one message to the model and returns the next model and the
// command, asserting the model type the whole way.
func update(t *testing.T, m tui.Model, msg tea.Msg) (tui.Model, tea.Cmd) {
	t.Helper()
	next, cmd := m.Update(msg)
	got, ok := next.(tui.Model)
	require.True(t, ok, "Update must return the same model type")
	return got, cmd
}
...
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
```

A third helper, `typed`, builds the message a terminal delivers for a run of
characters — one message with every rune, the way a paste arrives.
`assertFrameFits` is the interesting one: it measures cells, the way the
terminal measures them.

The strongest new case is the conflict, and it is real, not a stand-in: the
test completes the task through the store after the model has read it, so
the model's write loses against the real `MemoryStore`.

<!-- verify: internal/tui/tui_test.go at=tui-styling -->
```go title="internal/tui/tui_test.go"
func TestModel_CompleteConflict(t *testing.T) {
	st := store.NewMemoryStore()
	stored := seed(t, st, "write the chapter")
	m := load(t, tui.New(context.Background(), st))

	// Someone else completes the task between the model's read and its
	// write — the CLI, or another TUI. The store's compare-and-swap is
	// what notices: the model's snapshot carries the version it read.
	complete(t, st, stored[0])

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
```

Read the middle assertions twice: the notice names the conflict, the stale
snapshot is still on screen until the load lands, and the last lines pin the
refresh — the other writer's write.

The same behaviors get a session through the real event loop.
`TestTUI_AddFlow`'s core is the message sequence — `a`, the title, `enter` —
and every step has a frame it must produce:

<!-- verify: internal/tui/teatest_test.go at=tui-styling -->
```go title="internal/tui/teatest_test.go"
	tm := teatest.NewTestModel(t, tui.New(context.Background(), st), teatest.WithInitialTermSize(60, 20))
	t.Cleanup(func() { _ = tm.Quit() })

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
```

Each `waitForFrame` is also a barrier: the renderer writes a frame for the
state before the next key is sent, so the transient input line is a state
the run really saw, not one the next frame overwrote.

The other new cases follow the same shape: cancelling the input, an invalid
title, the input owning the letter keys, the complete flow, and a done task
that is not written again. The existing cases change shape a little, too:
every step goes through the new `update` helper, and `key` learns `enter`
and `esc`. Two assertions change with the new help line:

<!-- verify: internal/tui/tui_test.go at=tui-styling -->
```go title="internal/tui/tui_test.go"
	assert.Contains(t, view, "r reload • q quit", "a failed load leaves only the keys that still act")
...
		assert.Contains(t, view, "a add • enter complete • r reload • q quit")
```

The first says a failed load leaves only the keys that still act; the second
is the list's help line, with the completion it now offers. The test file's
imports grow by four — `os`, `strings`, `lipgloss`, and `termenv` — and a
new `TestMain` pins the profile the frames render in:

<!-- verify: internal/tui/tui_test.go at=tui-styling -->
```go title="internal/tui/tui_test.go"
// TestMain pins the profile the frames render in. The tests assert on plain
// text, and lipgloss decides between color and no color by looking at the
// terminal it would render to — so without the pin the same frame could
// match on one machine and not another. SetColorProfile is lipgloss's hook
// for exactly this; the running program still colors its frames.
func TestMain(m *testing.M) {
	lipgloss.SetColorProfile(termenv.Ascii)
	os.Exit(m.Run())
}
```

Without the pin, whether a frame assertion sees plain text or escape codes
would depend on the terminal the tests happen to run in. The running program
still colors its frames; only the tests are pinned.

The appendix holds the whole test file; the cases here are the ones that
carry the idea. Run them and watch them fail:

```bash
$ go test -count=1 -v ./internal/tui
--- FAIL: TestModel_Width (0.00s)
    tui_test.go:300:
        	Error:      	"41" is not less than or equal to "24"
        	Test:       	TestModel_Width
        	Messages:   	line 3 of the frame is wider than the 24-column terminal:
        	            	"> [ ] write a title long enough to be cut"
...
--- FAIL: TestTUI_AddFlow (5.07s)
    teatest_test.go:103: WaitFor: condition not met after 5s. Last output:
FAIL
FAIL	todo/internal/tui	5.070s
FAIL
```

The failures are the frames themselves — the width assertion measures the
plain row the interface draws today — and the tests compile on the first
run, because the two libraries are already in the project's dependency
graph through Bubble Tea. The failure is behavior, not a missing name.

## A face for the frame

Two libraries join the project. **lipgloss** draws styled text — colors,
weight, decorations — and **bubbles** is a set of ready-made interface
components; we take two of them, a text input and the help line.

Fetch the exact versions this lesson was built with, one command per
library: `go get github.com/charmbracelet/lipgloss@v1.1.0` and `go get
github.com/charmbracelet/bubbles@v1.0.0`. Two modules the project already
had indirectly move up as well: `x/ansi`, for the width-aware cut, and
`termenv`, which the tests use. All four lines sit in `go.mod`'s main
block:

<!-- verify: go.mod at=tui-styling -->
```text title="go.mod"
require (
...
	github.com/charmbracelet/bubbles v1.0.0
	github.com/charmbracelet/bubbletea v1.3.10
	github.com/charmbracelet/lipgloss v1.1.0
	github.com/charmbracelet/x/ansi v0.11.6
	github.com/charmbracelet/x/exp/teatest v0.0.0-20261012121918-43427fdbad12
...
	github.com/muesli/termenv v0.16.0
...
)
```

`bubbles` and `lipgloss` are the new arrivals; `x/ansi` and `termenv` were
already in the project's list, one block down, and move up because the
project's own code imports them directly now.

Create `internal/tui/styles.go`. A **style** is a value that knows how to
decorate text: a color, a weight, a decoration. The file builds the frame's
whole style layer in one place:

<!-- verify: internal/tui/styles.go at=tui-styling -->
```go title="internal/tui/styles.go"
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
```

Six styles, one per job: the header, the selected row, a done row, the
notice line, a problem line, and the input's prompt. Each names only what it
changes.

<!-- verify: internal/tui/styles.go at=tui-styling -->
```go title="internal/tui/styles.go"
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
```

Every style but the prompt inherits the base — lipgloss's word for "start
from this style and change only what I name" — so the frame agrees on its
foreground in one place. The colors are **adaptive**: a light and a dark
variant, and lipgloss picks the one that fits the terminal's background.

A terminal without color — `NO_COLOR` set, or output that is not a terminal
— renders the same frame in plain text, because the layout lives in the
strings, not in the escape codes (the invisible instructions a terminal
reads to color text).

## One map for the keyboard and the help

The old help line was a hand-written string, and the keys were a switch of
their own. The two can drift apart — change a key, forget the line — so this
lesson gives both the same source: a **key map**. A `key.Binding` is one
key (or a few) with a name and a description; a key map is a struct of
bindings.

`key.Matches` asks a binding whether a key press is one of its keys, and the
help bubble renders the same bindings as its lines. One map, two readers: a
key cannot do one thing and be advertised as another.

Create `internal/tui/keys.go`:

<!-- verify: internal/tui/keys.go at=tui-styling -->
```go title="internal/tui/keys.go"
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
```

Six bindings — the arrows and j/k, `a` to add, `enter` to complete, `r` to
reload, `q` and `ctrl+c` to quit — each carrying the keys it answers and the
words the help shows. The two render lists are the same bindings in two
orders:

<!-- verify: internal/tui/keys.go at=tui-styling -->
```go title="internal/tui/keys.go"
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
```

Those two methods are what the help bubble asks for: the one-liner, and the
two-column reference card a wide terminal gets. Nothing is rendered that is
not also matched.

The add mode's map is deliberately short:

<!-- verify: internal/tui/keys.go at=tui-styling -->
```go title="internal/tui/keys.go"
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
```

While the input has focus it owns the letter keys — `q` types a q — so only
the keys that leave the mode are bindings, plus `ctrl+c`, which quits from
anywhere.

## The frame, block by block

The frame moves to its own file, `internal/tui/view.go`. `View` is still a
pure function — the same model draws the same frame — and the frame is now
composed of blocks: a header, the list, the notice, the input while it is
open, and the help line. **lipgloss.JoinVertical** stacks them,
left-aligned, with empty strings for the gaps.

The old `View` in `tui.go`, and its two column helpers `marker` and `check`,
leave that file — delete them there — and this file owns them from now on.
Create it:

<!-- verify: internal/tui/view.go at=tui-styling -->
```go title="internal/tui/view.go"
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
```

`fullHelpMin` is the width from which the help switches to its full form:
seventy columns. The other new import, `x/ansi`, is the cell-aware cut the
next blocks use.

<!-- verify: internal/tui/view.go at=tui-styling -->
```go title="internal/tui/view.go"
// View implements tea.Model: the frame the program renders. It is a pure
// function of the model — no IO, no store call, no terminal query — which
// is what makes every frame a string the tests can assert on.
//
// The frame is composed with lipgloss: a header, the list, the notice of the
// last write, the add input while it has focus, and the help — joined
// vertically, every block left-aligned. The blocks whose text can grow — the
// rows, the notice, the input, the help — are cut to the terminal's width
// with an ellipsis, so the frame stays inside the terminal however long a
// title or a notice is; the width also chooses the help's short or full
// form.
func (m Model) View() string {
	switch {
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
```

Read the last block twice: the help bubble truncates its own items, but at a
few widths it prefers to overflow rather than drop one, so the view cuts the
help line as well and the frame's rule holds either way.

The two frames that never change come first:

<!-- verify: internal/tui/view.go at=tui-styling -->
```go title="internal/tui/view.go"
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
```

The failed-load frame replaces the list with the error and shrinks the help
to the keys that still act — reload and quit — because the model disabled
the rest. `listView` is one row per task:

<!-- verify: internal/tui/view.go at=tui-styling -->
```go title="internal/tui/view.go"
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
```

A row is one styled string: `rowView` cuts the line first, so the ellipsis
lands inside the row's own color, then styles it whole — selected rows bold
and accented, done rows faint and struck through.

<!-- verify: internal/tui/view.go at=tui-styling -->
```go title="internal/tui/view.go"
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
```

The notice is one line — a confirmation in the quiet style, or a failure in
the problem color. `truncate` is the one cut every growing block passes
through: per line, counting cells rather than bytes, so a wide character is
cut at the cell it would cross and the escape codes of a styled line survive
the cut. A width of zero — no size announced — returns the block whole.

<!-- verify: internal/tui/view.go at=tui-styling -->
```go title="internal/tui/view.go"
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

`marker` and `check` are the two fixed columns of every row: the cursor, and
the `[x]`/`[ ]` state.

## The model grows a mode and an input

`internal/tui/tui.go` grows the state the frame needs, and its import list
grows with it: `errors`, the three bubbles packages — `help`, `key`,
`textinput` — `lipgloss`, and `uuid` arrive; `strings` leaves with the view.
The keyboard now has two owners, so the model gets a **mode**: `modeList` is
the default — keys move the cursor and start actions — and `modeAdd` is the
input's:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// mode is what the keyboard is talking to.
type mode int

const (
	// modeList is the default: the keys move the cursor and start actions.
	modeList mode = iota
	// modeAdd is the add input's mode. The input owns the letter keys while
	// it has focus, so the frame's help switches to the input's key map.
	modeAdd
)
```

Every key press is routed by the mode before either key map is consulted.
Four new messages carry the outcomes a write can have:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// addedMsg is an add's success: the task the store stored, with the id and
// the version it assigned. The model's own copy of the task has neither, so
// the message carries the store's copy and the reload that follows puts it
// on screen.
type addedMsg struct{ task task.Task }

// completedMsg is a complete's success. Store.Complete reports only an error,
// so the message carries what the model sent, not what the store holds: the
// write bumped the version, and the follow-up load is where the new state —
// and the fresh version the next compare-and-swap must carry — arrives.
type completedMsg struct{ title string }

// conflictMsg is a write that lost the compare-and-swap: the task changed
// between the model's read and the write. The command recognises the store's
// ErrConflict and reports it apart from other failures, because the answer
// is different — re-read the task and show the latest, the store's own
// advice — where a plain failure leaves the list alone.
type conflictMsg struct{ title string }

// opErrMsg is a write that failed for any other reason: a validation error,
// a ... context, an engine failure. The list stays as it was and the
// notice says what happened.
type opErrMsg struct{ err error }
```

One per outcome: the task the store stored, a completion, a lost
compare-and-swap, and any other failure. Each carries only what the model
needs to say what happened.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// notice is the last write's outcome: the line under the list that reports
// what just happened, and whether it is a failure (rendered as a problem) or
// a confirmation. The next key press clears it.
type notice struct {
	text    string
	problem bool
}
```

The notice is the line under the list: its text, and whether it renders as a
problem.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
	// width is the terminal's width from the last WindowSizeMsg. Zero
	// means no size has been announced — a model built by a test — and
	// the view renders whole lines; a running program gets a size before
	// its first frame.
	width int

	// keys and help are the list mode's key map and the bubble that
	// renders it; inputKeys is the add mode's map. The help follows the
	// focus through activeKeys.
	keys      listKeys
	inputKeys inputKeys
	help      help.Model

	// mode is what the keyboard is talking to, and input is the add
	// mode's text input, focused exactly while mode is modeAdd.
	mode  mode
	input textinput.Model

	// notice is the last write's outcome, shown under the list until the
	// next key press.
	notice notice

	// pending is the task the next successful load should put the cursor
	// on: an add sets it to the task the store stored, so the new row is
	// the selected one. uuid.Nil — the zero value — means no task is
	// pending.
	pending uuid.UUID
```

The model's new fields: the terminal's width, the two key maps and the help
bubble, the mode and the input, the notice, and `pending` — the id of the
task an add just stored, so the reload that follows can put the cursor on
it. `uuid.Nil` means nothing is pending.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// New returns the model the program starts with: the store its commands read
// and write, the key maps, the help bubble, and the add input. The model
// starts empty and unloaded; Init's command fills it.
func New(ctx context.Context, s store.Store) Model {
	input := textinput.New()
	input.Prompt = "add: "
	input.Placeholder = "task title"
	input.PromptStyle = defaultStyles.prompt

	m := Model{
		ctx:       ctx,
		store:     s,
		keys:      defaultListKeys(),
		inputKeys: defaultInputKeys(),
		help:      help.New(),
		input:     input,
	}
	// Nothing has loaded yet, so there is nothing to complete; a is live
	// already, because the first task can arrive while the load is in
	// flight.
	return m.syncKeys()
}
```

`New` builds the input with its prompt, its placeholder, and the prompt
style, plus the two key maps and the help bubble, and returns the model
already synced to its empty state.

## Two keyboards, one mode check

`Update` gains the window-size arm, the four write messages, and the
mode-aware key half. The first half:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		return m.resize(msg.Width), nil
	case tasksMsg:
		m.tasks = msg.tasks
		m.loaded = true
		m.err = nil
		// A reload can find a shorter list than the one on screen; the
		// cursor must not point past the end. min(max(n-1, 0), cursor)
		// keeps an empty list at 0.
		m.cursor = min(m.cursor, max(len(m.tasks)-1, 0))
		// An add's reload lands the cursor on the task the store stored,
		// so the row that just appeared is the selected one.
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
...
```

A size message sets the width; a load's answer stores the tasks, clamps the
cursor inside the list, and — after an add — lands it on the task the store
stored. The second half:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
	case addedMsg:
		m.notice = notice{text: fmt.Sprintf("added %q", msg.task.Title)}
		m.pending = msg.task.ID
		return m, loadTasks(m.ctx, m.store)
	case completedMsg:
		m.notice = notice{text: fmt.Sprintf("completed %q", msg.title)}
		// The write bumped the version the model holds, so the snapshot is
		// stale even though the write won: re-read before the next
		// compare-and-swap.
		return m, loadTasks(m.ctx, m.store)
	case conflictMsg:
		m.notice = notice{
			text:    fmt.Sprintf("%q changed elsewhere; list refreshed", msg.title),
			problem: true,
		}
		return m, loadTasks(m.ctx, m.store)
	case opErrMsg:
		m.notice = notice{text: msg.err.Error(), problem: true}
		return m, nil
	case tea.KeyMsg:
		return m.updateKey(msg)
	}
	// Everything else — the input's cursor blinks, its paste results —
	// belongs to the input while the add mode has focus.
	if m.mode == modeAdd {
		return m.updateInput(msg)
	}
	return m, nil
}
```

Each write's answer sets the notice and asks for a fresh list, except a
plain failure, which leaves the list alone. Everything that is not a key
press falls through to the input while the add mode has focus, because the
input's cursor blinks on a command of its own.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// updateKey is Update's key half: the keyboard contract, one switch over the
// two modes' key maps. A key the current mode has no binding for changes
// nothing.
func (m Model) updateKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// The notice reports the last write; a key press is the reader moving
	// on, so it clears.
	m.notice = notice{}

	if m.mode == modeAdd {
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
		return m, loadTasks(m.ctx, m.store)
	}
	return m, nil
}
```

`updateKey` consults the mode first — in the add mode it routes to the
input's half — and then matches one arm per binding. The notice clears on
the first line, because a key press is the reader moving on.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
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
```

The add mode's half is three bindings and a fallthrough: `enter` submits,
`esc` leaves, `ctrl+c` quits, and every other key is the input's own. The
fallthrough is what makes `q` type a q — and the command the input returns
is the cursor's blink schedule, so it rides back out.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
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
```

The mode's two doors: `startAdd` focuses the input — and returns the focus's
blink command — and `stopAdd` clears and blurs it, so reopening the input
finds it empty.

## Adding and completing from the list

`submitAdd` splits the decision from the work. The domain's constructor
validates the title inside `Update`: an invalid title becomes a notice on
the same frame, with no round trip, and the input keeps its text and its
focus so the reader can fix it. Only a valid task goes to the store, as a
command:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// submitAdd turns the input's text into a task. The domain's constructor
// validates it: an empty or overlong title becomes a notice, the input keeps
// its text and its focus so the reader can fix it, and the next keystroke
// clears the notice. A valid title leaves the mode and goes to the store as
// a command.
func (m Model) submitAdd() (tea.Model, tea.Cmd) {
	t, err := task.NewTask(m.input.Value())
	if err != nil {
		m.notice = notice{text: err.Error(), problem: true}
		return m, nil
	}
	return m.stopAdd(), addTask(m.ctx, m.store, t)
}
```

The next keystroke clears the notice, because every key press does.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// startComplete completes the selected task. The compare-and-swap carries
// the id and the version the model read, so a task that changed since the
// read is refused — the conflict path — rather than overwritten. A task
// already done is not written again, because the store would only bump its
// version; the notice says so instead.
func (m Model) startComplete() (tea.Model, tea.Cmd) {
	t := m.tasks[m.cursor]
	if t.Status == task.StatusDone {
		m.notice = notice{text: fmt.Sprintf("%q is already done", t.Title)}
		return m, nil
	}
	return m, completeTask(m.ctx, m.store, t)
}
```

`startComplete` is the compare-and-swap's model side. A **compare-and-swap**
is a write that only succeeds if the task is still the version you read: the
model sends the id and the version from its snapshot, so a task that changed
since the read is refused instead of overwritten. A task already done is
refused before the store ever sees it — the notice says so.

Both writes are commands:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// addTask is the add's command: store the task and report the stored copy —
// the id and the version are the store's to assign — back to Update, which
// then asks for a fresh list.
func addTask(ctx context.Context, s store.Store, t task.Task) tea.Cmd {
	return func() tea.Msg {
		stored, err := s.Add(ctx, t)
		if err != nil {
			return opErrMsg{err: fmt.Errorf("add %q: %w", t.Title, err)}
		}
		return addedMsg{task: stored}
	}
}
```

`addTask` reports the store's own copy of the task back — the id and the
version are the store's to assign.

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// completeTask is the complete's command: the compare-and-swap with the id
// and the version the model read. A stale snapshot is the store's
// ErrConflict — the sentinel the compare-and-swap exists for — and the
// command reports it apart, because the model's answer is to re-read.
func completeTask(ctx context.Context, s store.Store, t task.Task) tea.Cmd {
	return func() tea.Msg {
		if err := s.Complete(ctx, t.ID, t.Version); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return conflictMsg{title: t.Title}
			}
			return opErrMsg{err: fmt.Errorf("complete %q: %w", t.Title, err)}
		}
		return completedMsg{title: t.Title}
	}
}
```

`completeTask` is where a lost compare-and-swap is recognized: the store's
`ErrConflict` becomes a `conflictMsg`, because the model's answer is
different — re-read the task and show the latest, the store's own advice.

Both answers end in a fresh load. A successful write bumps the version the
model holds, so the snapshot on screen is stale even when the write won; a
conflict must reload because the store says so. The two paths differ only in
what the notice says.

## The width rules

The terminal's width arrives as a message, and the model keeps it in
`width`. Zero means no size has been announced — a model a test built — and
the view renders whole lines. `resize` is the whole bookkeeping:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// resize applies a terminal size: the width rows and notices are cut to, the
// width the input scrolls in, and the help's truncation width and its
// short-or-full choice. A zero width — no size announced — leaves the model
// as it is.
func (m Model) resize(width int) Model {
	if width <= 0 {
		return m
	}
	m.width = width
	m.help.Width = width
	m.help.ShowAll = width >= fullHelpMin
	// The input's width is its text's viewport: the terminal width minus
	// the prompt, minus one cell for the cursor the component pads with.
	m.input.Width = max(width-lipgloss.Width(m.input.Prompt)-1, 0)
	return m
}
```

The rows and notices are cut to the width, the input scrolls inside it, and
the help gets its truncation width and its short-or-full choice. `syncKeys`
and `activeKeys` are the two policies that keep the help honest — what the
state can do, and who has the keyboard:

<!-- verify: internal/tui/tui.go at=tui-styling -->
```go title="internal/tui/tui.go"
// syncKeys points the list's key map at what the current state can do: with
// no tasks there is nothing to complete, and a failed load leaves nothing to
// act on but the reload. A disabled binding is neither matched nor rendered,
// so the keyboard and the help line cannot disagree.
func (m Model) syncKeys() Model {
	m.keys.Add.SetEnabled(m.err == nil)
	m.keys.Complete.SetEnabled(m.err == nil && len(m.tasks) > 0)
	return m
}

// activeKeys is the key map the help renders: the input's while the add mode
// has focus, the list's otherwise.
func (m Model) activeKeys() help.KeyMap {
	if m.mode == modeAdd {
		return m.inputKeys
	}
	return m.keys
}
```

A disabled binding is neither matched nor shown, so an empty list stops
offering `enter`, and a failed load stops offering `a` — the keyboard and
the help line change together. `activeKeys` picks the map the help renders:
the input's while the add mode has focus, the list's otherwise.

## Run the tests

The model, the frame, and the writes are in. Run the suite:

```bash
$ go test -count=1 -v ./internal/tui
--- PASS: TestModel_AddCancel
--- PASS: TestModel_AddFlow
--- PASS: TestModel_AddValidatesTitle
--- PASS: TestModel_Complete
--- PASS: TestModel_CompleteConflict
--- PASS: TestModel_CompleteDoneTask
...
--- PASS: TestTUI_LoadFailure
--- PASS: TestTUI_Width
ok  	todo/internal/tui	0.279s
```

Every case passes: the model's rules, the sessions through the real event
loop, and the width runs.

## The screen in a terminal

The frames on this page are plain text because the page can only show text.
In a real terminal the same frame is colored: the header is bold, the
selected row is bold in the accent color, done rows are faint and struck
through, and the input's prompt is accented. Here is a session, four tasks
seeded and one marked done:

```text
todo: 4 tasks

> [ ] write the chapter
  [ ] buy milk
  [x] ship it
  [ ] water the plants

a     add         ↓/j move down
enter complete    ↑/k move up
                  r   reload
                  q   quit
```

The help's keys and descriptions are two grays, and the columns line up
because the frame is built from blocks, not from one long string.

`a` opens the input, and the letters land in it. `enter` stores the task;
the answer asks for a fresh list, and the frame that follows carries the
count, the new row with the cursor on it, and the notice:

```text
todo: 5 tasks

  [ ] write the chapter
  [ ] buy milk
  [x] ship it
  [ ] water the plants
> [ ] call the plumber

added "call the plumber"

a     add         ↓/j move down
enter complete    ↑/k move up
                  r   reload
                  q   quit
```

The new row is selected — an add's reload puts the cursor on the task the
store stored. `k` moves the cursor up to a row, and `enter` completes it:

```text
todo: 5 tasks

  [ ] write the chapter
  [ ] buy milk
  [x] ship it
> [x] water the plants
  [ ] call the plumber

completed "water the plants"

a     add         ↓/j move down
enter complete    ↑/k move up
                  r   reload
                  q   quit
```

The row says `[x]`, the notice says what happened, and both stay on screen
until the next key press. Resize the terminal to forty columns and the frame
adapts:

```text
todo: 5 tasks

  [ ] write the chapter
  [ ] buy milk
  [x] ship it
> [x] water the plants
  [ ] call the plumber

completed "water the plants"

a add • enter complete • r reload …
```

The rows still fit, the help falls back to its one-liner and is cut to the
width, and the frame never grows wider than the terminal. Submitting an
empty input runs the domain's constructor, which refuses the title; the
notice says why, in the problem color, and the input keeps its text and its
focus:

```text
...
invalid title: cannot be empty

add: task title

enter add    esc cancel    ctrl+c quit
```

The next keystroke clears the notice.

## If something went wrong

**The frame comes back with escape codes in it, and an assertion fails on a
machine with a color terminal.** The message:

```text
        Error:      	"\x1b[1;38;2;227;227;227mtodo: 3 tasks\x1b[0m ..." does not contain "a add • enter complete • r reload • q quit"
```

The help's keys and descriptions are styled segments, so with a color
profile the plain substring is broken by the invisible codes — and whether a
profile is set depends on the terminal the tests happen to run in. The fix
is the `TestMain` pin above: one setting, before any test runs. The profile
is process-wide and lipgloss caches it, so a per-test setting would be a lie
about a cached value.

**The help line is wider than the terminal at a few widths.** The message:

```text
    tui_test.go:300:
        	Error:      	"42" is not less than or equal to "24"
        	Test:       	TestModel_Width
        	Messages:   	line 5 of the frame is wider than the 24-column terminal:
        	            	"a add • enter complete • r reload • q quit"
```

The bubble's truncation only drops an item when the ellipsis that marks the
drop fits in the remaining width; when there is no room even for that, it
renders the item anyway, so at a few widths the one-liner comes back whole.
That is why `View`'s last `truncate` call wraps `m.help.View(...)` — the
frame's rule holds whichever path produced the line.

**`q` quits while you are typing a title.** The message:

```text
--- FAIL: TestModel_InputOwnsTheKeys (0.00s)
    tui_test.go:396:
        	Error:      	"todo: 0 tasks …\nadd: task title …\nenter add • esc cancel • ctrl+c quit" does not contain "add: q"
        	Test:       	TestModel_InputOwnsTheKeys
        	Messages:   	q must type, not quit
```

The list's key map is consulted before the mode is known, and `q` is the
list's quit — so the first letter of a task title ends the program. Check
the mode first, and give each mode its own map: the add mode's bindings are
only the keys that leave it, and everything else goes to the input.

**`File is locked by another process` while you try to reproduce a conflict
live.** The message:

```text
holder: store open

$ go run ./cmd/todo add --db scratch.db "written behind the TUI's back"
open turso store scratch.db: enable mvcc: turso: error: Locking error: Failed locking file 'scratch.db'. File is locked by another process
exit status 1
```

The store allows one process at a time — a second process is refused at the
file lock — so the CLI behind the interface's back cannot be the other
writer. That is why the conflict is pinned in a test instead: the test
completes the task through the same in-memory store between the model's read
and its write.

<details>
<summary>Going deeper: why the frame keeps its own list</summary>

The bubbles library ships a full list component, and we looked at it and
said no. It is an entire sub-model — its own items, cursor, filtering, and
pagination — so adopting it would move the tasks into the component and put
the store's versions out of the model's reach; the compare-and-swap needs
the version the model *read*. The lesson takes what the component's own
docs teach — a cursor row, a per-item rendering, width awareness — and
writes the thirty lines itself, where the tests can see every frame.

</details>

<details>
<summary>Going deeper: why a write that wins still reloads</summary>

It looks wasteful: the write succeeded, so why re-read? Because the store
bumped the task's version on the write, and the model's snapshot still
carries the old one. The next `enter` on that row would lose its
compare-and-swap against a change the model itself made. Reloading keeps the
next write's version fresh, and it costs one read.

The notice lives until the next key press for a related reason: clearing it
when the load lands would make it a race the live program usually loses,
since the load runs on another goroutine. The line reports what just
happened, not what is happening.

</details>

<details>
<summary>Going deeper: why the cut counts cells, not bytes</summary>

A terminal is a grid of cells, and most characters fill one. Some fill two —
the wide characters of Japanese and Chinese scripts — and a byte slice cut
cannot know that: cutting by bytes can split a character in half and leave
the replacement glyph a terminal draws. `ansi.Truncate` walks the line
counting cells, stops at the cell the next character would cross, and leaves
the escape codes of a styled line intact, so the ellipsis lands inside the
row's own color.

</details>

The interface has a face and hands now; next, its commands stop reading the
database directly and talk to the API instead.
