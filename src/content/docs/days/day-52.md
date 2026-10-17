---
title: "Day 52 — Testing the terminal UI"
description: "Give the full-screen interface a memory — records in a log file that outlives the session, and whole frames recorded in files its tests compare against."
sidebar:
  order: 52
chapter: 44
---

**About 3 hours** · Part IX, day 4 of 4.

**You'll be able to:**

- test the interface with teatest and golden frames;
- read its debug log when a session goes wrong.

---

The interface signs in, lists the user's tasks, adds to them, and completes
them. On a good run you watch it work, press `q`, and the terminal is exactly
as you left it. On a bad run something goes wrong, you leave, and there is
nothing left to read: the frame is gone, and the record that would explain it
had nowhere to go.

A full-screen program has a problem the command-line tool never had: no
second channel. The CLI writes its records to stderr and keeps stdout for
data, but the interface owns the whole terminal — a record printed anywhere
but a file would land inside the picture it is drawing.

So the interface gets a memory. Its commands write records to a log file that
outlives the session, and its tests record whole frames in files, so a change
to the screen has to be looked at and agreed with. One more promise gets its
test too: a crash must give the terminal back.

## The tests come first

The habit holds: describe the behavior before building it. Four test files
grow, and the first test is the centerpiece — it runs the real program, then
reads the log file.

Add this case to `internal/tui/program_test.go`:

<!-- verify: internal/tui/program_test.go at=tui-tests -->
```go title="internal/tui/program_test.go"
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
```

Read it as three promises. The program runs with the file-only logger the
binary builds. The failed load leaves `tasks load failed` in the file, with
the API's error beside it. And the frame — everything the program wrote to
the terminal — carries no log line at all. The comment above the second wait
says why there is no sleep: the command writes the record before it reports
the message, so the file and the frame arrive together.

The file's imports grow with the test: `log/slog`, `os`, `path/filepath`,
`errors`, `todo/internal/logging`, and `todo/internal/task` are the new
names, and the compiler names any you miss.

The logger gets its own small test. Add this to
`internal/logging/logging_test.go`:

<!-- verify: internal/logging/logging_test.go at=tui-tests -->
```go title="internal/logging/logging_test.go"
// TestNewFile pins the full-screen program's logger: the file is the only
// sink — there is no terminal handler to corrupt a frame with — and it keeps
// New's file discipline: parents created, 0600, JSON records, appended to.
// The level is the build-time one; the file logger has no SetLevel knob
// because the TUI has no --log-level flag to turn.
func TestNewFile(t *testing.T) {
	t.Parallel()

	logPath := filepath.Join(t.TempDir(), "state", "todo", "logs", "todo.log")
	logger, closer, err := logging.NewFile(logPath, slog.LevelInfo)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer.Close() })

	logger.Debug("dropped")
	logger.Warn("tasks load failed", "err", "the API is down")

	data := readLog(t, logPath)
	assert.NotContains(t, data, "dropped", "the build-time level filters")
	assert.Contains(t, data, `"msg":"tasks load failed"`)
	assert.Contains(t, data, "the API is down")

	info, err := os.Stat(logPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "the log file is 0600")

	// A second logger over the same path appends: a TUI session does not
	// truncate the log the CLI wrote.
	logger2, closer2, err := logging.NewFile(logPath, slog.LevelDebug)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer2.Close() })
	logger2.Debug("config resolved", "api", "http://127.0.0.1:8080")

	data = readLog(t, logPath)
	assert.Contains(t, data, "tasks load failed")
	assert.Contains(t, data, `"msg":"config resolved"`)
	assert.Equal(t, 2, strings.Count(data, "\n"), "one line per record")
}
```

The file is the only destination there is, and the test pins the discipline:
the level filters, the record is JSON, the file is private, and a second
logger appends rather than truncating.

The path's rule gets a table. Add this to `internal/config/config_test.go`:

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
// TestLogPath is the log path's precedence table: the TUI's --debug-log flag
// beats $TODO_LOG, which beats $XDG_STATE_HOME/todo/logs/todo.log, which
// falls back to HOME. Load applies the same rule with no flag — the
// environment and default rows are shared with TestLoad — and this table
// owns the flag, the same split TestListen and TestAPIURL have for their
// settings. The last row owns the error: a default that needs HOME and finds
// neither HOME nor an XDG variable fails instead of returning a relative
// path.
func TestLogPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
		flag string
		want string
	}{
		{
			name: "nothing set follows HOME",
			env:  map[string]string{"HOME": "/home/user"},
			want: "/home/user/.local/state/todo/logs/todo.log",
		},
		{
			name: "XDG_STATE_HOME replaces the HOME fallback",
			env:  map[string]string{"HOME": "/home/user", "XDG_STATE_HOME": "/xdg/state"},
			want: "/xdg/state/todo/logs/todo.log",
		},
		{
			name: "TODO_LOG beats the default",
			env:  map[string]string{"HOME": "/home/user", "TODO_LOG": "/tmp/env.log"},
			want: "/tmp/env.log",
		},
		...
		{
			name: "the flag's path is used verbatim",
			flag: "logs/tui.log",
			want: "logs/tui.log",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := config.LogPath(getenvFrom(tt.env), tt.flag)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}

	t.Run("no HOME and no XDG variable is an error", func(t *testing.T) {
		t.Parallel()

		got, err := config.LogPath(getenvFrom(nil), "")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "HOME")
		assert.Empty(t, got)
	})
}
```

The rows are the rule from top to bottom: a flag, then `$TODO_LOG`, then the
state folder, then HOME. The elided rows are the empty values — an empty flag
falls through to the environment variable, and an empty variable falls
through to the default. The last case is the error row — a default that needs
HOME and finds neither HOME nor the XDG variable fails with a reason instead
of handing the logger a relative path.

The frames get tests of their own. A **golden file** is a recorded copy of
expected output that a test compares against — the snapshot files from
earlier in the book are the same idea, with the tool writing the file on the
first run. Two helpers make the interface's goldens. Add them to
`internal/tui/teatest_test.go`:

<!-- verify: internal/tui/teatest_test.go at=tui-tests -->
```go title="internal/tui/teatest_test.go"
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

// ...
func frame(view string) string {
	lines := strings.Split(view, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " ")
	}
	return strings.Join(lines, "\n") + "\n"
}
```

`goldenFrame` starts a real program around the model, lets one function drive
the session, ends it, and hands the last frame to
`teatest.RequireEqualOutput`, the library's golden comparison. `frame` trims
the padding the styling library adds to every line: the terminal erases to
the end of each line, so the padding is invisible there — but an editor shows
it, and a file that changes the moment you save it is no file to compare
against. The file's imports gain `strings` for the trim.

Then the four sessions, one per shape the screen can take:

<!-- verify: internal/tui/teatest_test.go at=tui-tests -->
```go title="internal/tui/teatest_test.go"
// ...
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

// ...
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

// ...
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

// ...
func TestTUI_GoldenProblem(t *testing.T) {
	t.Parallel()

	f := &fakeClient{listErr: errors.New("the API is down")}

	goldenFrame(t, f, func(tm *teatest.TestModel) {
		signIn(tm)
		waitForFrame(t, tm, "could not load tasks", "the API is down")
	})
}
```

Each of the four drives the interface to one state: the sign-in form with a
typed email and a masked password, the list with three tasks and the cursor
moved down, a write's notice, and the problem frame. Each session stops
there. They end through the program's own `Quit`, not a `q` key press: a key
press clears the notice, and the notice frame is exactly the state one of the
four records.

The last test is about crashes. A **panic** is a bug so bad the program stops
itself in the middle of whatever it was doing. Add the two faults and the
test to `internal/tui/program_test.go`:

<!-- verify: internal/tui/program_test.go at=tui-tests -->
```go title="internal/tui/program_test.go"
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
```

`panickingModel` is the real model with one injected fault: the first key
press panics inside `Update`. `panickingClient` is the fake API with one
injected fault: the list call panics where the fake would answer. Both wrap
the real thing rather than replacing it — the test runs the program the
binary runs.

<!-- verify: internal/tui/program_test.go at=tui-tests -->
```go title="internal/tui/program_test.go"
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
```

Two sessions, one promise: whether the panic happens in the model's `Update`
or in a command, `Run` must report it and give the terminal back — the
alternate screen left, the cursor shown. The test reads the program's output
stream for both escape sequences and asks `Run` for the error.

## Watch it fail

None of that exists yet. Run the two small packages:

```bash
$ go test -count=1 ./internal/config ./internal/logging
# todo/internal/config_test [todo/internal/config.test]
internal/config/config_test.go:355:23: undefined: config.LogPath
internal/config/config_test.go:364:22: undefined: config.LogPath
FAIL	todo/internal/config [build failed]
# todo/internal/logging_test [todo/internal/logging.test]
internal/logging/logging_test.go:160:33: undefined: logging.NewFile
internal/logging/logging_test.go:178:35: undefined: logging.NewFile
FAIL	todo/internal/logging [build failed]
FAIL
```

The config test and the logging test are speaking about functions that do not
exist — `config.LogPath` and `logging.NewFile`. The interface's package has
more to say:

```bash
$ go test ./internal/tui
# todo/internal/tui_test [todo/internal/tui.test]
internal/tui/program_test.go:115:33: undefined: logging.NewFile
internal/tui/program_test.go:124:61: too many arguments in call to tui.New
	have (context.Context, *fakeClient, unknown type)
	want (context.Context, tui.Client)
internal/tui/program_test.go:124:65: undefined: tui.WithLogger
internal/tui/program_test.go:219:30: cannot use tt.model() (value of interface type tea.Model) as tui.Model value in argument to tui.NewProgram: need type assertion
FAIL	todo/internal/tui [build failed]
FAIL
```

Every line names a seam the tests specify: the config function, the logging
constructor, the model's option, and the constructor's parameter type. Your
line numbers will differ — the names are the point.

One failure is still hidden. The interface's package stops at its first
errors, so the golden tests never get to run; once the code compiles, they
fail for their own reason:

```bash
$ go test ./internal/tui -run TestTUI_Golden
--- FAIL: TestTUI_GoldenProblem (0.06s)
    golden.go:22: open testdata/TestTUI_GoldenProblem.golden: no such file or directory
--- FAIL: TestTUI_GoldenLogin (0.11s)
    golden.go:22: open testdata/TestTUI_GoldenLogin.golden: no such file or directory
--- FAIL: TestTUI_GoldenList (0.11s)
    golden.go:22: open testdata/TestTUI_GoldenList.golden: no such file or directory
--- FAIL: TestTUI_GoldenNotice (0.16s)
    golden.go:22: open testdata/TestTUI_GoldenNotice.golden: no such file or directory
FAIL
FAIL	todo/internal/tui	0.162s
FAIL
```

The four golden files do not exist yet, so the tests cannot pass — by design.
They are written with `-update`, a deliberate step, and then read before
anything else happens.

## The log path, resolved on its own

Start with the path. The rule already exists for the command-line tool:
`$TODO_LOG` beats the state folder, which falls back to HOME. The interface
needs the same rule with one addition on top — its own `--debug-log` flag —
and nothing else from the configuration; it opens no database, so the rule
moves into a function of its own. In `internal/config/config.go`:

<!-- verify: internal/config/config.go at=tui-tests -->
```go title="internal/config/config.go"
// LogPath resolves the log file's path: a non-empty flag beats $TODO_LOG,
// which beats $XDG_STATE_HOME/todo/logs/todo.log, else
// $HOME/.local/state/todo/logs/todo.log. Load resolves the same rule with no
// flag; the TUI resolves it with its --debug-log flag, the same split Listen
// and APIURL have for their settings. It is deliberately the whole of what
// the TUI needs from Load: the TUI writes no log until this chapter, and now
// that it does, the setting is resolved on its own — the database path and
// the rest of Load stay the CLI's, so requiring HOME for a database the TUI
// never opens is not part of starting the TUI.
//
// The path's parent may not exist; making it exist is the logger's job, not
// this function's — resolution stays pure.
func LogPath(getenv func(string) string, flag string) (string, error) {
	if flag != "" {
		return flag, nil
	}
	if logPath := getenv(envLog); logPath != "" {
		return logPath, nil
	}
	return xdgDefault(getenv, xdgStateHome, filepath.Join(".local", "state"), filepath.Join("todo", "logs", "todo.log"))
}
```

Read the precedence from the top: a non-empty flag wins, then the environment
variable, then the default under the state folder. The comment's last lines
say what the function is not: resolving the path does not create it — making
it exist is the logger's job.

`Load`, the CLI's resolver, now calls this function instead of doing the work
inline:

<!-- verify: internal/config/config.go at=tui-tests -->
```go title="internal/config/config.go"
	logPath, err := LogPath(getenv, "")
	if err != nil {
		return Config{}, fmt.Errorf("config: log path: %w", err)
	}
```

The interface's binary calls the same function with its `--debug-log` flag.
The default is the same file the command-line tool writes: one application,
one log, so "where did it go wrong" has one answer. `--debug-log` exists for
the one-off case — point one session's records at a scratch file without
touching the log the rest of the app uses.

## A logger with no terminal

The CLI's logger writes two copies of every record: one to stderr for
whoever is watching, one to the file for later. The interface cannot have
the stderr copy — stderr is behind the frame — and the tempting design is a
"quiet" option on the existing constructor, an option the next caller could
forget to pass. Instead, the new constructor has no terminal parameter at
all. In `internal/logging/logging.go`:

<!-- verify: internal/logging/logging.go at=tui-tests -->
```go title="internal/logging/logging.go"
// NewFile builds the logger a full-screen program runs with: one sink, the
// log file, JSON, at a fixed level. It exists because a TUI has no terminal
// sink to give — stderr is behind the frame the program is drawing, and a
// record written there would corrupt it — so the file discipline New's file
// side has is the whole logger. The level is fixed because there is no
// --log-level flag to retune it after construction; the TUI's records are
// what a session left behind, not what a running process tunes.
func NewFile(logPath string, level slog.Level) (*slog.Logger, io.Closer, error) {
	f, err := openLogFile(logPath)
	if err != nil {
		return nil, nil, err
	}
	return slog.New(slog.NewJSONHandler(f, &slog.HandlerOptions{Level: level})), f, nil
}

// openLogFile makes the log destination real, for both loggers: the parent
// directories first — the XDG default nests todo/logs under a directory a
// fresh account does not have — then the file, appended to, created 0600.
// The path is configuration's decision; making it exist is the logger's.
func openLogFile(logPath string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return nil, fmt.Errorf("logging: create log directory: %w", err)
	}
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) // #nosec G304 -- the path is the configured log destination, not caller-supplied input
	if err != nil {
		return nil, fmt.Errorf("logging: open log file: %w", err)
	}
	return f, nil
}
```

The shape is the guarantee: there is no sink to route a record into the
frame, and no option to forget. Both constructors share `openLogFile`, so
the file discipline — parents created, private, appended to — stays one
implementation. The old `New` loses its four inline lines and calls the same
helper:

<!-- verify: internal/logging/logging.go at=tui-tests -->
```go title="internal/logging/logging.go"
	f, err := openLogFile(logPath)
	if err != nil {
		return nil, nil, err
	}
	fileHandler := slog.NewJSONHandler(f, &slog.HandlerOptions{Level: levelVar})
```

The constructor takes a level and has no knob to move it afterwards. The
binary builds it at debug, and it stays there: the file is read after the
session, and the session you are debugging cannot be re-run.

## The model's option, and the records

The logger reaches the model as its one option — the one dependency the
binary has and a test does not. In `internal/tui/tui.go` (whose imports gain
`log/slog`):

<!-- verify: internal/tui/tui.go at=tui-tests -->
```go title="internal/tui/tui.go"
	// logger receives the commands' records — a login, a load, a write,
	// and the error each can carry. A full-screen program has no terminal
	// sink to give: the binary hands the file-only logger
	// logging.NewFile builds, and a model a test builds logs into
	// slog.DiscardHandler. The logger is never the program's output
	// writer, whichever model is running.
	logger *slog.Logger
// ...
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
```

`New` gives every model a logger that throws its records away, then applies
the options on top, so the binary's file logger lands in the same field a
test's silence would have:

<!-- verify: internal/tui/tui.go at=tui-tests -->
```go title="internal/tui/tui.go"
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
```

Now the commands — the place where the work, and therefore the errors, live.
Each one writes its record before it hands back its message:

<!-- verify: internal/tui/tui.go at=tui-tests -->
```go title="internal/tui/tui.go"
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
```

The two write commands follow the same shape. The add records the title it
sent and the id the API assigned; the complete records the id and the title,
and gives the refused write its own warning:

<!-- verify: internal/tui/tui.go at=tui-tests -->
```go title="internal/tui/tui.go"
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
```

The levels carry meaning. Successes are debug records — a load's count is
what tells "the list was empty" from "the load failed" after the fact — the
writes are info, and every failure is a warning carrying the command's
error. The conflict gets its own warning, `task complete conflicted`, because
it is not a failure: the API refused a stale write, and the model's answer is
to re-read.

Every call site passes the logger, and the compiler points at each one:

<!-- verify: internal/tui/tui.go at=tui-tests -->
```go title="internal/tui/tui.go"
		return m, loadTasks(m.ctx, m.client, m.logger)
// ...
	return m, login(m.ctx, m.client, m.logger, m.email.Value(), m.password.Value())
// ...
	return m.stopAdd(), addTask(m.ctx, m.client, m.logger, t)
// ...
	return m, completeTask(m.ctx, m.client, m.logger, t)
```

The order — record first, message second — is what lets the log-file test
assert both halves without a sleep. By the time the frame that reports a
failure is on screen, the file already explains it.

## The binary's second flag

The binary is where the logger is built and the records begin. In
`cmd/todo-tui/main.go`, `run` resolves the two settings it needs and opens
the file-only logger before the program starts:

<!-- verify: cmd/todo-tui/main.go at=tui-tests -->
```go title="cmd/todo-tui/main.go"
	// Two flags, so the stdlib flag package is still enough — the same
	// choice cmd/todo-server made. A parse error exits 2 with the usage,
	// the convention Go's own tools follow.
	apiFlag := flag.String("api", "", "API base URL; overrides $TODO_API_URL and the "+config.DefaultAPIURL+" default")
	debugLogFlag := flag.String("debug-log", "", "path to the debug log; overrides $TODO_LOG and the XDG state default")
	flag.Parse()

	// The TUI resolves the two settings it needs, each with its own flag on
	// top of the shared precedence rule. It deliberately does not call
	// config.Load: the database path is not the TUI's to resolve, and
	// requiring HOME for a database the TUI never opens would be a promise
	// the binary does not keep.
	apiURL := config.APIURL(os.Getenv, *apiFlag)
	logPath, err := config.LogPath(os.Getenv, *debugLogFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	// The logger is the file-only one, and it is built before the program
	// starts: a failure here is printed on the still-normal terminal, and a
	// logger built afterwards could miss the records of the very startup
	// that failed. The level is debug — the file is the TUI's only
	// diagnostic surface, and there is no second run of the session being
	// debugged.
	logger, closer, err := logging.NewFile(logPath, slog.LevelDebug)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() {
		// The process is leaving; a close error cannot change the exit code
		// and has nowhere better to go, so it is discarded explicitly, like
		// the CLI's.
		_ = closer.Close()
	}()
```

A second flag, `--debug-log`, rides the shared path rule exactly the way
`--api` rides the API rule. Building the logger before the program means a
failure to open it is printed on the still-normal terminal — a logger built
later could miss the records of the very startup that failed. The resolved
paths become the first debug record, and the program's exit is recorded
before its one line goes to stderr:

<!-- verify: cmd/todo-tui/main.go at=tui-tests -->
```go title="cmd/todo-tui/main.go"
	// The resolved paths are the first debug record, the CLI's own
	// "why is my data not where I thought" answer, on the TUI's side of the
	// pair.
	logger.Debug("config resolved", "api", apiURL, "log", logPath)

	c := client.New(apiURL)

	// q and ctrl+c both leave through tea.Quit, and Run returns nil. A
	// SIGINT that reaches the process outside the raw terminal — input is
	// not a TTY — arrives as ErrInterrupted, which is the same request to
	// stop, not a failure. Everything else — a recovered panic, a renderer
	// error — is an error, and the one line and the exit code are the
	// report. Bubble Tea restores the terminal before Run returns it, so
	// this line lands on a usable terminal, and the record lands in the file
	// the session was already writing to.
	if _, err := tui.NewProgram(tui.New(ctx, c, tui.WithLogger(logger))).Run(); err != nil && !errors.Is(err, tea.ErrInterrupted) {
		logger.Error("todo-tui exited with an error", "err", err)
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
```

The error branch is the crash path's record: a recovered panic or a renderer
error is written to the file before the one line goes to stderr. Bubble Tea
restores the terminal before `Run` returns, so that line lands on a usable
terminal — and the record lands in the file the session was already writing
to.

The binary's flags, from `--help`:

```text
Usage of ./todo-tui:
  -api string
    	API base URL; overrides $TODO_API_URL and the http://127.0.0.1:8080 default
  -debug-log string
    	path to the debug log; overrides $TODO_LOG and the XDG state default
```

`--api` was already there; `--debug-log` is the new one.

## The frames written down

Now the goldens themselves. `teatest.RequireEqualOutput` writes
`testdata/<TestName>.golden` when the test binary runs with `-update`, and
compares against the file otherwise. Write the four:

```bash
$ go test ./internal/tui -run TestTUI_Golden -update
```

The run passes and four files appear under `internal/tui/testdata/` — one
file per shape the screen can take. The sign-in form:

<!-- verify: internal/tui/testdata/TestTUI_GoldenLogin.golden at=tui-tests -->
```text title="internal/tui/testdata/TestTUI_GoldenLogin.golden"
todo: sign in

email: alice@example.com
password: *******

enter sign in • tab next field • ctrl+c quit
```

The list, with one task done and the cursor on the second row:

<!-- verify: internal/tui/testdata/TestTUI_GoldenList.golden at=tui-tests -->
```text title="internal/tui/testdata/TestTUI_GoldenList.golden"
todo: 3 tasks

  [ ] write the chapter
> [ ] buy milk
  [x] ship it

a add • enter complete • r reload • q quit
```

A write's notice — the new row selected, the count moved, and the line saying
what happened:

<!-- verify: internal/tui/testdata/TestTUI_GoldenNotice.golden at=tui-tests -->
```text title="internal/tui/testdata/TestTUI_GoldenNotice.golden"
todo: 3 tasks

  [ ] write the chapter
  [ ] ship it
> [ ] buy milk

added "buy milk"

a add • enter complete • r reload • q quit
```

And the problem frame, where the load's error replaces the list and the help
line shrinks to the keys that still act:

<!-- verify: internal/tui/testdata/TestTUI_GoldenProblem.golden at=tui-tests -->
```text title="internal/tui/testdata/TestTUI_GoldenProblem.golden"
todo: could not load tasks

  the API is down

r reload • q quit
```

Read them the way you read the snapshot files: line by line, asking whether
this is what the screen should show. These four are now the suite's
reference — a change to any of them has to show up as a difference.

## When a frame changes

The files are only worth having if a change to the screen has to face them.
Change one word in the list's help line — say, `reload` to `refresh` — and
the next run fails:

```bash
$ go test ./internal/tui -run TestTUI_GoldenList
--- FAIL: TestTUI_GoldenList (0.11s)
    golden.go:22: output does not match, expected:
...
        diff:
        --- golden
        +++ run
        @@ -4,4 +4,4 @@
         > [ ] buy milk
           [x] ship it

        -a add • enter complete • r reload • q quit
        +a add • enter complete • r refresh • q quit
FAIL
FAIL	todo/internal/tui	0.109s
FAIL
```

Read the report the way the tool wrote it: the `-` line is the recorded
golden, the `+` line is what the screen renders now, and the difference is
exactly the one you made. When the change is on purpose, accept it with
`go test ./internal/tui -run TestTUI_GoldenList -update` — and then read the
rewritten file before moving on. That is the whole routine, the same one the
snapshot files taught: update deliberately, review the result, and never
accept a difference you cannot explain.

## A crash must give the terminal back

The last piece is one small change to `NewProgram` — it takes a `tea.Model`
instead of the concrete model:

<!-- verify: internal/tui/tui.go at=tui-tests -->
```go title="internal/tui/tui.go"
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
```

A `tea.Model` parameter lets the test wrap the real model with a fault, while
the binary passes its own model unchanged. The rest of the comment is the
argument: the alternate screen is the program's decision, not the model's,
and the options exist so tests can build the same program over their own
input and output.

The recovery itself belongs to Bubble Tea. A panic in `Update` happens on the
program's own goroutine; a panic in a command happens on the command's
goroutine. Both are recovered, both make `Run` return `tea.ErrProgramPanic`,
and both restore the terminal before `Run` returns. What the code must not do
is defeat the recovery — there is no option that turns it off, and nothing
exits before `Run` returns.

On the way out, the program's output ends with the restore:

```text
\x1b[2K\r\x1b[?2004l\x1b[?25h\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h
```

The error both sessions get back is the same:

```text
program was killed: program experienced a panic
```

And Bubble Tea prints its own report, with the panic value and a stack trace:

```text
Caught goroutine panic:

injected: the client's ListTasks panicked

Restoring terminal...
```

The test pins all three: the sequences, the error, and — through the two
faults — the two places a panic can start.

## Run it all

The code is complete. The two small packages first:

```bash
$ NO_COLOR=true go test -count=1 ./internal/config ./internal/logging
ok  	todo/internal/config	0.004s
ok  	todo/internal/logging	0.004s
```

Run `go test -count=1 -v ./internal/tui` and the case list comes back — the
four goldens, the log-file test, and the panic test among them:

```text
--- PASS: TestModel_AddCancel
--- PASS: TestModel_AddFlow
--- PASS: TestModel_AddValidatesTitle
...
--- PASS: TestModel_View
--- PASS: TestModel_Width
--- PASS: TestProgram_EntersAndLeavesAltScreen
--- PASS: TestProgram_LogsToTheFile
--- PASS: TestProgram_PanicRestoresTheTerminal
--- PASS: TestTUI_AddFlow
--- PASS: TestTUI_CompleteFlow
--- PASS: TestTUI_EmptyStore
--- PASS: TestTUI_GoldenList
--- PASS: TestTUI_GoldenLogin
--- PASS: TestTUI_GoldenNotice
--- PASS: TestTUI_GoldenProblem
--- PASS: TestTUI_KeysDriveTheFrame
--- PASS: TestTUI_LoadFailure
--- PASS: TestTUI_LoginFlow
--- PASS: TestTUI_Width
```

The order here is sorted for reading; the parallel cases finish in whatever
order they finish.

Every case passes. The whole module agrees:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	1.849s
ok  	todo/cmd/todo-server	1.907s
?   	todo/cmd/todo-tui	[no test files]
ok  	todo/internal/api	0.754s
?   	todo/internal/api/docs	[no test files]
...
ok  	todo/internal/logging	0.008s
...
ok  	todo/internal/tui	0.639s
```

Every package is in the list, and nothing fails.

## Watch the records arrive

The test proves the split; a real terminal shows it. Start the interface with
`--debug-log` pointed at a scratch file and `--api` at a port with nothing
behind it, then sign in. The failure is the record this section wants, and
the frame carries no log line:

```text
todo: sign in

email: alice@example.com
password: ****************************

sign in: POST /api/v1/auth/login: Post "http://127.0.0.1:1/api/v1/auth/login": …

enter sign in    tab next field    ctrl+c quit
```

The capture's terminal was wide, so the help line is the full help — one key
per column, with the column spacing between the groups. On a narrow terminal
the same keys fall back to the one-line help, separated by bullets. And the
file the session left behind holds both records:

<!-- transcripts: authored -->
```text
{"time":"2026-10-15T16:03:24.244790337+05:30","level":"DEBUG","msg":"config resolved","api":"http://127.0.0.1:1","log":"/tmp/…/tui-debug.log"}
{"time":"2026-10-15T16:03:25.239800842+05:30","level":"WARN","msg":"sign in failed","email":"alice@example.com","err":"POST /api/v1/auth/login: Post \"http://127.0.0.1:1/api/v1/auth/login\": dial tcp 127.0.0.1:1: connect: connection refused"}
```

The resolved settings at the start, and the failed sign-in with the client's
error — the same error the frame showed, in the file rather than on the
screen. Your times and paths will differ; the shape is the point.

## If something went wrong

**`open testdata/TestTUI_GoldenProblem.golden: no such file or directory` on
the first golden run.** The file does not exist yet, so the test cannot
pass — that is the design, not a bug. Write the goldens with `-update`, then
read every line of what was written. A golden nobody read is a picture of a
bug, and the suite will defend it from then on.

**`no Go files in …` — the `-update` flag before the package list.**
Test-binary flags go after the packages. Written the other way around, the
command tests the folder you are standing in:

```bash
$ go test -run TestTUI_GoldenList -update ./internal/tui
# .
no Go files in …
FAIL	. [setup failed]
```

The go tool reads `-update` as a build flag with the package as its value.
Put the flag after the package:
`go test ./internal/tui -run TestTUI_GoldenList -update`.

**`WARNING: DATA RACE` when the program tests run together.** The race
detector — the tool that watches for two parts of a program touching the
same memory at the same time — can fire inside the libraries:

```text
WARNING: DATA RACE
Read at 0x000000c50780 by goroutine 64:
  github.com/charmbracelet/bubbles/runeutil.(*sanitizer).Sanitize()
      .../bubbles@v1.0.0/runeutil/runeutil.go:65
...
  todo/internal/tui_test.TestProgram_LogsToTheFile.func2()
      internal/tui/program_test.go:128

Previous write at 0x000000c50780 by goroutine 63:
  ...runeutil.(*sanitizer).Sanitize()
      .../runeutil/runeutil.go:93
...
```

Two programs processing a space key at the same time race on memory the
libraries share. The program tests in the file therefore do not run in
parallel — they drive real programs and take turns. Delete the
`t.Parallel()` line from `TestProgram_EntersAndLeavesAltScreen` — the file
still carries it from earlier. The binary cannot hit this: one process runs
one program. The last "Going deeper" box has the whole mechanism.

<details>
<summary>Going deeper: why the golden is the frame, not the terminal stream</summary>

The tempting golden is the program's whole output stream — every byte the
terminal saw. Its shape, though, is the renderer's timing: views written
between two of the renderer's ticks coalesce, so how many frames appear, and
where their boundaries land, depends on scheduling. A golden that depends on
timing is a golden that flakes.

The frame — what `View` returns — is a pure function of the model, and the
session reaches the model through the real loop, so the recorded artifact is
the last frame the program drew, without depending on when it drew it. What
the golden pins is the frame's content, not the padding `frame` trims, and
the four shapes of `View` — not the empty list or the cut frame, which have
their own tests.

There is one boundary worth knowing. A session drives itself by waiting for
the frames it expects, so a change to a frame the session waits for fails
the session first, seconds before the golden is ever compared. The sessions
pin the states they reach; the goldens pin the whole frame. That split is
why the mismatch in this chapter changes the help line — a line the sessions
never wait for.

</details>

<details>
<summary>Going deeper: why the logger has no terminal</summary>

A full-screen program's stderr is behind the frame the program is drawing,
so a record written there would corrupt the picture — which is why the CLI's
two-sink logger cannot be the TUI's. The tempting design is a "quiet" option
on `New` that skips the stderr sink; the next caller could forget to pass
it, and the frame would be corruptible by omission. `NewFile` has no stderr
parameter at all, so the shape of the constructor is the guarantee.

And the file is the same one the CLI writes — one application, one log — with
`--debug-log` as the escape hatch for a single session. The level is fixed
because there is no live consumer to retune for: you read the file after the
session, and you cannot re-run the session you are debugging.

</details>

<details>
<summary>Going deeper: the panic contract</summary>

Bubble Tea recovers panics on both of the goroutines where they can start. A
panic in `Init` or `Update` happens on the program's own goroutine: `Run` has
a deferred recovery that signals `tea.ErrProgramPanic` and shuts the program
down. A panic in a command happens on the command's goroutine: its recovery
signals the same error and cancels the program.

Both paths end in the same restore — bracketed paste off, the cursor shown,
the mouse modes off, and the alternate screen left — before `Run` returns.
Two things could silently defeat that, and the test exists to catch both: an
option that turns the recovery off (`WithoutCatchPanics`), and an exit that
runs before `Run` returns.

The program uses neither, and because the test wraps the real model instead
of rebuilding the program, it would notice if that changed. What the binary
adds on top is the record: the error is logged before the one line goes to
stderr.

</details>

<details>
<summary>Going deeper: the race two programs found</summary>

Bubble Tea's input parser turns a space into its own key message and hands
every one of them the same shared list of runes. The text field component
then cleans that list in place — it reuses the same memory as it removes
characters it will not keep. One program processing a space is fine. Two
programs in one test process processing a space at the same moment are not:
both write to the shared memory, and the race detector reports it.

It is a race in the libraries, not in the app's code, and one process running
one program cannot hit it. No lock on the test side can fix a mutation that
happens inside the libraries' event loops, so the program tests take turns
instead. If the libraries ever fix it, the tests can go back to running in
parallel.

</details>

The interface has a memory now — records in a file that outlives the
session, and frames recorded in files that hold the screen still. Next, the
book turns to the other end of the wire: the server, where traces, metrics,
and profiles explain its runs.

<div class="day-tracker" data-day="52"></div>
