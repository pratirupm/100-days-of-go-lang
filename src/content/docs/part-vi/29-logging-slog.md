---
title: Logging
description: Give the app a diary — records of what it did, on stderr for the moment and in a JSON log file that outlives the run.
sidebar:
  order: 29
---

The app can already do things: add a task, mark one done, list what's left. What it can't do is tell you what it did. When a command misbehaves — a task seems to have vanished, a script gets garbage — the only evidence is the output you happened to be watching.

A **log** is the app's diary: one line for each thing it did, written as it happens. Ours will keep two copies of every line — one on the terminal, and one in a file that survives the run.

One rule comes first, and everything else hangs off it: the diary never shares stdout. stdout carries the data someone asked for — the id, the table, the JSON — and records go to stderr, the second output channel. A record that lands on stdout isn't extra output; it's corrupted output.

By the end, `add` will print its one id line and quietly write a record naming the task, and a log file under the state folder the app already knows how to find will hold the same record as JSON.

## A diary of what the program did

A log line records one thing the program did, at the moment it did it. A good line carries a short message — what happened — plus the values involved: which task, which id. `task added`, with an `id` and a `title` beside it, is a complete entry. A week later, that line answers "what did this run actually do?" without running it again.

Programs have two output channels, and Unix tools have split them for decades. **stdout** is for data: what the caller asked for. **stderr** is for everything else: the program's own commentary. A shell can keep the two apart — `>out.txt 2>err.txt` sends the first channel to one file and the second to another.

Ours makes that split a rule. `add` prints exactly one line on stdout — the id it assigned — and the record about the add goes to stderr. `list` writes zero bytes to stderr, because reading changes nothing and there is nothing to record. The rule has a practical reason: a script that reads `list --json` expects one JSON object per line, and a stray record in the middle turns a clean stream into a parse error.

The stderr copy is for the moment; the log file is for later. Every record is also appended to a file, never overwriting it, so the file remembers across runs. Both copies carry the same fields — only the rendering differs.

## Records for people and for machines

Every record has a **level**, and the level says how much it matters. From most talkative to most serious: `debug`, `info`, `warn`, `error`. Ours writes `info` for state changes — a task was added, completed, or imported — and `debug` for the resolved configuration, because "why is my data not where I thought" is exactly what a careful run is asking. Reads record nothing at all.

Not every run wants the same amount of talk, so the command tree gets a `--log-level` flag: `debug`, `info`, `warn`, or `error`, with `info` as the default. A typo fails the command instead of silently changing verbosity — `--log-level loud` is an error, not a fallback.

The two copies render differently on purpose. On a terminal — where a person is watching — the record is compact and colored: `INF task added id=… title=…`. Everywhere else — a pipe, a file, a service manager — it is one JSON object per line, because the reader is a machine. The log file is always JSON, even when the terminal gets the colorful form.

Go's standard library ships this whole idea as `log/slog`. A `slog.Logger` is the front door; a **handler** decides what a record looks like and where it goes. The call shape is `logger.Info("task added", "id", id, "title", title)` — a short message plus key/value pairs. Nothing is formatted into the message: no timestamps, no text building. The handler owns the time and the shape, and that is what lets one record render two ways.

## The test comes first

True to the habit, we describe the behavior before writing it. The new package is `internal/logging`, and its test file is `internal/logging/logging_test.go`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them. It opens with a helper that builds the logger with a buffer standing in for stderr and a real file in the test's own temp folder.

<!-- verify: internal/logging/logging_test.go at=logging -->
```go title="internal/logging/logging_test.go"
// newProcessLogger builds the process logger with the test's buffer standing
// in for stderr and a real file in the test's temp directory. It returns the
// logger and both sinks, so a case can read the record back from either.
func newProcessLogger(t *testing.T, isTTY bool, level slog.Level) (*slog.Logger, *bytes.Buffer, string) {
	t.Helper()
	var stderr bytes.Buffer
	logPath := filepath.Join(t.TempDir(), "todo.log")
	logger, closer, err := logging.New(&stderr, isTTY, logPath, level)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer.Close() })
	return logger, &stderr, logPath
}

// readLog returns the log file's contents. The path is test-owned — built
// from t.TempDir, never from input — so the inclusion warning is answered
// here once instead of at every read.
func readLog(t *testing.T, logPath string) string {
	t.Helper()
	data, err := os.ReadFile(logPath) // #nosec G304 -- logPath is built by this test from t.TempDir
	require.NoError(t, err)
	return string(data)
}
```

`logging.New` doesn't exist yet. The test calls the function we're about to write, exactly like the very first test in the book called a function that wasn't there yet.

The first case pins the fan-out: one record must reach both destinations, even when the logger is decorated with extra fields.

<!-- verify: internal/logging/logging_test.go at=logging -->
```go title="internal/logging/logging_test.go"
// TestNew_TeeFanOut pins the tee: one record reaches both sinks, and the
// logger's derived forms — WithAttrs, WithGroup — reach both too, so a
// logger decorated at one call site does not drift between terminal and file.
func TestNew_TeeFanOut(t *testing.T) {
	t.Parallel()

	logger, stderr, logPath := newProcessLogger(t, false, slog.LevelInfo)
	logger.With("component", "store").WithGroup("task").Info("task added", "id", "42")

	assert.Contains(t, stderr.String(), `"msg":"task added"`)
	assert.Contains(t, stderr.String(), `"component":"store"`)

	line := strings.TrimSuffix(readLog(t, logPath), "\n")
	require.NotContains(t, line, "\n", "the file is JSONL: one record per line")

	var rec map[string]any
	require.NoError(t, json.Unmarshal([]byte(line), &rec), "the file record is JSON: %q", line)
	assert.Equal(t, "INFO", rec["level"])
	assert.Equal(t, "task added", rec["msg"])
	assert.Equal(t, "store", rec["component"], "WithAttrs reached the file")
	group, ok := rec["task"].(map[string]any)
	require.True(t, ok, "WithGroup nested the record's attributes: %v", rec)
	assert.Equal(t, "42", group["id"])
	assert.NotEmpty(t, rec["time"], "every record carries a timestamp")
}
```

Both destinations hold the same record, with the extra `component` field attached to the logger in both — one call, two shapes.

The second case pins the threshold — records below the level reach neither destination, and the level can move after the logger exists.

<!-- verify: internal/logging/logging_test.go at=logging -->
```go title="internal/logging/logging_test.go"
// TestNew_LevelFiltering pins the threshold: records below the level reach
// neither sink; records at and above it reach both. The second case moves
// the level after the logger exists — the shared knob the CLI's --log-level
// flag rides on.
func TestNew_LevelFiltering(t *testing.T) {
	t.Parallel()

	// ...
	t.Run("SetLevel retunes both sinks", func(t *testing.T) {
		t.Parallel()

		logger, stderr, logPath := newProcessLogger(t, false, slog.LevelInfo)

		setter, ok := logger.Handler().(interface{ SetLevel(slog.Level) })
		require.True(t, ok, "the process logger's handler can be retuned")
		setter.SetLevel(slog.LevelDebug)

		logger.Debug("config resolved", "db", "/tmp/todo.db")

		assert.Contains(t, stderr.String(), `"msg":"config resolved"`)
		assert.Contains(t, readLog(t, logPath), `"msg":"config resolved"`)
	})
}
```

The elided case pins the same threshold at build time. The `SetLevel` interface is how the flag will work: the handler has the method, or it doesn't, and the logger still runs either way.

Two more cases finish the file. `TestNew_LogFile` builds a logger whose path is several folders deep, then checks three promises.

<!-- verify: internal/logging/logging_test.go at=logging -->
```go title="internal/logging/logging_test.go"
// TestNew_LogFile pins the file sink: the parent directories are created (the
// XDG default nests todo/logs under $XDG_STATE_HOME), the file is private
// (0600), its records are JSON, and a second New over the same path appends
// instead of truncating.
func TestNew_LogFile(t *testing.T) {
	t.Parallel()

	logPath := filepath.Join(t.TempDir(), "state", "todo", "logs", "todo.log")
	var stderr bytes.Buffer
	logger, closer, err := logging.New(&stderr, false, logPath, slog.LevelInfo)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer.Close() })

	logger.Info("task added", "id", "42")

	info, err := os.Stat(logPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm(), "the log file is 0600")
```

The rest of the case parses the file's line as JSON, then builds a second logger over the same path and checks the first record is still there. Appending is what makes a log a log.

`TestNew_HandlerSelection` pins the two renderings of one call. The terminal half needs a tiny pattern first — tint colors its output, and the pattern strips the colors so the test can read the line the way a terminal renders it.

<!-- verify: internal/logging/logging_test.go at=logging -->
```go title="internal/logging/logging_test.go"
// ansiPattern matches the color escape sequences tint emits on a TTY, so the
// shape assertion can read the line the way a terminal renders it.
var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// TestNew_HandlerSelection pins the two human/machine shapes: on a TTY the
// stderr sink is tint's line ("INF task added id=42"); off a TTY it is JSON.
// The file stays JSON in both cases — stderr is for whoever is watching, the
// file is for whatever reads it later.
func TestNew_HandlerSelection(t *testing.T) {
	t.Parallel()

	t.Run("a TTY gets tint", func(t *testing.T) {
		t.Parallel()

		logger, stderr, logPath := newProcessLogger(t, true, slog.LevelInfo)
		logger.Info("task added", "id", "42")

		plain := ansiPattern.ReplaceAllString(stderr.String(), "")
		assert.Contains(t, plain, "INF task added")
		assert.Contains(t, plain, "id=42")
		assert.NotContains(t, plain, `"msg":`, "the TTY shape is not JSON")

		assert.Contains(t, readLog(t, logPath), `"msg":"task added"`, "the file stays JSON")
	})
```

The other half runs the same call with `isTTY` false and parses the line as JSON — the call site never knows which rendering it got.

## The CLI tests learn about the logger

The command tree takes a logger now, so its test seam grows one too. `runCLIWith` keeps its signature and routes through a new `runCLIWithLogger`.

<!-- verify: internal/cli/cli_test.go at=logging -->
```go title="internal/cli/cli_test.go"
// runCLIWith is the test seam. New takes the opener, the logger, and the
// writers, so exercising the CLI is an ordinary function call: build a fresh
// tree around o, point it at the arguments, run it, and hand back everything
// it printed. The logger discards its records here — these cases are about
// what the commands print and return; the logging section below reads
// records back from a buffer instead. No process, no os.Stdout, no
// package-level state between cases.
func runCLIWith(t *testing.T, o *opener, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	return runCLIWithLogger(t, o, slog.New(slog.DiscardHandler), args...)
}

// runCLIWithLogger is runCLIWith with a caller-supplied logger: the seam the
// logging cases use to capture records in a buffer.
func runCLIWithLogger(t *testing.T, o *opener, logger *slog.Logger, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	root := cli.New(o.open, logger, &out, &errOut)
	root.SetArgs(args)
	err = root.ExecuteContext(context.Background())
	return out.String(), errOut.String(), err
}
```

Every existing case keeps its old signature and gets `slog.New(slog.DiscardHandler)`; the one test that builds the tree by hand passes the same logger to `cli.New`. The file's imports gain `log/slog` and `todo/internal/logging`.

Then the new cases. `newJSONLogger` builds the real process logger over a buffer — a buffer is not a terminal, so the buffer half is JSON, which is the shape these cases parse.

<!-- verify: internal/cli/cli_test.go at=logging -->
```go title="internal/cli/cli_test.go"
// newJSONLogger builds the process logger over a buffer: the stderr half is
// JSON, because a buffer is not a TTY — the format these cases parse — and
// the file half lands in a test-owned path. It returns the buffer both sinks
// are mirrored to.
func newJSONLogger(t *testing.T, level slog.Level) (*slog.Logger, *bytes.Buffer) {
	t.Helper()
	buf := new(bytes.Buffer)
	logger, closer, err := logging.New(buf, false, filepath.Join(t.TempDir(), "todo.log"), level)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer.Close() })
	return logger, buf
}
```

`TestLogging_AddEmitsRecord` runs `add` through the tree and reads both channels back.

<!-- verify: internal/cli/cli_test.go at=logging -->
```go title="internal/cli/cli_test.go"
	st := store.NewMemoryStore()
	out, errOut, err := runCLIWithLogger(t, &opener{store: st}, logger, "add", "buy milk")
	require.NoError(t, err)

	list, err := st.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1)

	var rec struct {
		Level string `json:"level"`
		Msg   string `json:"msg"`
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec), "one JSON record: %q", buf.String())
	assert.Equal(t, "INFO", rec.Level)
	assert.Equal(t, "task added", rec.Msg)
	assert.Equal(t, list[0].ID.String(), rec.ID)
	assert.Equal(t, "buy milk", rec.Title)

	assert.Equal(t, list[0].ID.String()+"\n", out, "stdout carries the id and only the id")
	assert.Empty(t, errOut, "cobra's stderr stays clean; the record went to the logger")
}
```

The last two lines are the contract in miniature: stdout carries the id and only the id, and the record went to the logger, not an output writer.

`TestLogging_LevelFlag` pins the flag in both directions: `warn` suppresses the info record, and `debug` emits the resolved-path line even though the logger was built at `info` — the flag retunes the logger rather than dropping a single call. `TestLogging_InvalidLevel` pins the failure.

<!-- verify: internal/cli/cli_test.go at=logging -->
```go title="internal/cli/cli_test.go"
// TestLogging_InvalidLevel pins the flag's validation: an unknown name is an
// error raised while the flag is parsed, not a silent fallback to the
// default.
func TestLogging_InvalidLevel(t *testing.T) {
	t.Parallel()

	_, _, err := runCLI(t, store.NewMemoryStore(), "--log-level", "loud", "list")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unknown level")
}
```

The black-box scenarios need one line each. Every script names a log file inside its own work folder, so a test run never writes to your real state folder. `add_list` also pins the new record.

<!-- verify: cmd/todo/testdata/script/add_list.txtar at=logging -->
```text title="cmd/todo/testdata/script/add_list.txtar"
# add prints the id it assigned; list shows the task; stats counts it.

env TODO_DB=$WORK/todo.db
env TODO_LOG=$WORK/todo.log

# add: one line on stdout, a UUIDv7 (version nibble 7, RFC 4122 variant); the
# record goes to stderr as JSON — stdout is data, stderr is logs.
exec todo add 'buy milk'
stdout '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
stderr '"msg":"task added"'
stderr '"title":"buy milk"'
```

The other three scenarios — `errors`, `json`, `import` — gain the same `env TODO_LOG=$WORK/todo.log` line and nothing else.

## Watch it fail

None of the new code exists yet. Run everything.

```bash
$ go test -count=1 ./...
todo/internal/logging: no non-test Go files in …/internal/logging
--- FAIL: TestScripts (0.00s)
    --- FAIL: TestScripts/add_list (0.01s)
...
FAIL	todo/internal/cli [build failed]
FAIL	todo/internal/logging [build failed]
FAIL
```

Three things fail at once. `no non-test Go files` is the folder holding only a test — there is no package to build yet. The script failure is a new expectation meeting the old binary: `add_list` now wants the `task added` record on stderr, and the app prints nothing there. And `internal/cli` fails to build because its tests call the four-argument `New`.

That last layer hides a detail. The logging package stops the build before the compiler reaches the CLI tests; once the logging package compiles, the CLI's error shows itself.

```bash
$ go test -count=1 ./internal/cli
# todo/internal/cli_test [todo/internal/cli.test]
internal/cli/cli_test.go:75:40: too many arguments in call to cli.New
	have (func(_ context.Context, dbPath string) ("todo/internal/store".Store, func() error, error), *slog.Logger, *bytes.Buffer, *bytes.Buffer)
	want (cli.OpenFunc, io.Writer, io.Writer)
FAIL	todo/internal/cli [build failed]
FAIL
```

The test file is speaking the whole new constructor: an opener, a logger, and two writers. Your line numbers will differ; the shapes will not.

## The logging package

Two small libraries do the rendering work: `tint` turns records into terminal lines, and `golang.org/x/term` answers whether stderr is a terminal. Fetch them with `go get github.com/lmittmann/tint@v1.2.1` and `go get golang.org/x/term@v0.47.0`; `go get` records them in `go.mod` and `go.sum`.

<!-- verify: go.mod at=logging -->
```text title="go.mod"
require (
	github.com/gkampitakis/go-snaps v0.5.23
	...
	github.com/lmittmann/tint v1.2.1
	...
	golang.org/x/term v0.47.0
	...
)
```

Now the package itself, `internal/logging/logging.go`. The finished app's appendix holds this file in full — the lines behind the `...` are there as you type them. It opens with the rule written down as a comment, plus the imports.

<!-- verify: internal/logging/logging.go at=logging -->
```go title="internal/logging/logging.go"
// Package logging builds the process logger: one handler for the terminal —
// tinted when stderr is a TTY, JSON otherwise — and one JSON handler that
// appends to the log file, both filtered at the same level and fed by a
// small tee handler so every record reaches both sinks.
//
// The logger never shares the process's stdout: stdout is the commands'
// output — the id, the table, the JSON — and a log record must not corrupt a
// pipe that consumes it. main hands os.Stderr to New and os.Stdout to the
// command tree, and the two channels stay separate all the way down.
package logging

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/lmittmann/tint"
)
```

A **TTY** is an old name for a terminal, short for "teletype", and "tinted" is `tint`'s job: the library renders records for a person to read. The comment also states the rule the whole file obeys.

The constructor builds both destinations and hands back the logger.

<!-- verify: internal/logging/logging.go at=logging -->
```go title="internal/logging/logging.go"
// New builds the process logger. stderr receives human-readable records when
// isTTY is true and JSON records otherwise; logPath receives JSON records at
// the same level, appended to, created 0600, with any missing parent
// directories created first (the XDG default nests todo/logs under
// $XDG_STATE_HOME). The returned closer closes the log file and belongs to
// the caller.
//
// level is the threshold both sinks start at. The handler New returns also
// implements SetLevel, so the CLI's --log-level flag can retune both sinks
// after the logger exists.
func New(stderr io.Writer, isTTY bool, logPath string, level slog.Level) (*slog.Logger, io.Closer, error) {
	// One LevelVar feeds both handlers: two sinks, one threshold, and the
	// flag can move it after construction. Enabled reads it on every
	// record, so no handler needs a lock or a rebuild of its own.
	levelVar := new(slog.LevelVar)
	levelVar.Set(level)

	var stderrHandler slog.Handler
	if isTTY {
		stderrHandler = tint.NewTextHandler(stderr, &tint.Options{Level: levelVar})
	} else {
		stderrHandler = slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: levelVar})
	}
```

The shared `LevelVar` is the movable threshold: two destinations, one setting, changeable after construction. The handler choice is a single `if` on a bool the caller computed.

<!-- verify: internal/logging/logging.go at=logging -->
```go title="internal/logging/logging.go"
	// ...
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return nil, nil, fmt.Errorf("logging: create log directory: %w", err)
	}
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) // #nosec G304 -- the path is the configured log destination, not caller-supplied input
	if err != nil {
		return nil, nil, fmt.Errorf("logging: open log file: %w", err)
	}
	fileHandler := slog.NewJSONHandler(f, &slog.HandlerOptions{Level: levelVar})

	return slog.New(newTeeHandler(levelVar, stderrHandler, fileHandler)), f, nil
}
```

Configuration decides where the log lives; the writer makes that location real. The parent folders are created first — `0700` means only you can enter them — and the file is opened to append with mode `0600` (only you can read it). The file comes back as a closer, because the caller owns its lifetime.

The fan-out itself is a handler like any other.

<!-- verify: internal/logging/logging.go at=logging -->
```go title="internal/logging/logging.go"
// teeHandler fans a record out to every sink and owns the level knob they
// share. It is what makes "stderr gets the story, the file keeps the record"
// one logger instead of two: WithAttrs and WithGroup propagate to every
// sink, so a logger decorated at a call site cannot drift between them.
type teeHandler struct {
	level    *slog.LevelVar
	handlers []slog.Handler
}

// newTeeHandler returns a handler that writes every enabled record to each
// of handlers.
func newTeeHandler(level *slog.LevelVar, handlers ...slog.Handler) *teeHandler {
	return &teeHandler{level: level, handlers: handlers}
}

// SetLevel retunes the threshold every sink filters at. It is the method the
// CLI's --log-level flag reaches through its levelSetter interface; both
// sinks consult the shared LevelVar on every record, so one call moves both.
func (h *teeHandler) SetLevel(level slog.Level) { h.level.Set(level) }

// Enabled reports whether any sink wants a record at level.
func (h *teeHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, handler := range h.handlers {
		if handler.Enabled(ctx, level) {
			return true
		}
	}
	return false
}
```

`SetLevel` is the method the flag will reach for later. `Enabled` answers for the union of the two destinations: if either wants a record at this level, the record must be built.

<!-- verify: internal/logging/logging.go at=logging -->
```go title="internal/logging/logging.go"
// Handle writes the record to every sink that enabled it. Each sink gets its
// own clone: a handler is allowed to retain a record only for the duration
// of the call, and one sink's use must not disturb the next.
func (h *teeHandler) Handle(ctx context.Context, record slog.Record) error {
	var errs []error
	for _, handler := range h.handlers {
		if !handler.Enabled(ctx, record.Level) {
			continue
		}
		if err := handler.Handle(ctx, record.Clone()); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
```

Each destination gets its own copy of the record — a rule of the handler contract: a record's fields are valid only for the duration of the call, so one destination's rendering must not disturb the next. Failures from both destinations are joined and returned.

<!-- verify: internal/logging/logging.go at=logging -->
```go title="internal/logging/logging.go"
// WithAttrs returns a tee whose sinks have all been given attrs.
func (h *teeHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		next[i] = handler.WithAttrs(attrs)
	}
	return &teeHandler{level: h.level, handlers: next}
}

// WithGroup returns a tee whose sinks have all entered the group.
func (h *teeHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(h.handlers))
	for i, handler := range h.handlers {
		next[i] = handler.WithGroup(name)
	}
	return &teeHandler{level: h.level, handlers: next}
}

// The seam stays honest: the tee is a slog.Handler, whatever the sinks are.
var _ slog.Handler = (*teeHandler)(nil)
```

`WithAttrs` and `WithGroup` map over the destinations, so a logger decorated at a call site cannot drift between the terminal and the file. The last line is a promise to the compiler: a forgotten method is a build failure instead of a surprise.

## The CLI takes a logger

`New` grows a parameter, and the session learns to carry it.

<!-- verify: internal/cli/cli.go at=logging -->
```go title="internal/cli/cli.go"
type session struct {
	store   store.Store
	cleanup func() error
	// logger receives the commands' action records. It is never the stdout
	// writer: logs and data are separate channels (see the package comment).
	logger *slog.Logger
	// json is the resolved --json flag. The flag is parsed before any RunE
	// runs, so the commands read this bool instead of the flag itself.
	json bool
}
```

<!-- verify: internal/cli/cli.go at=logging -->
```go title="internal/cli/cli.go"
// New builds the todo command tree around an opener and a logger. The store
// is not passed in: the tree resolves the database path at run time — the
// persistent --db flag over $TODO_DB over the XDG default — and hands the
// resolved path to open, which builds the store the commands then share.
// Output goes to out and errOut so tests can capture it; log records go to
// logger, and never to out.
func New(open OpenFunc, logger *slog.Logger, out, errOut io.Writer) *cobra.Command {
	var (
		dbFlag   string
		logLevel logLevelFlag
		sess     session
	)
	sess.logger = logger
```

The logger is one more dependency of the tree. The flag is the interesting part: `--log-level` accepts four names, and its value type validates while the flag parses.

<!-- verify: internal/cli/cli.go at=logging -->
```go title="internal/cli/cli.go"
	// The log threshold is validated while the flag is parsed: a typo must
	// fail the command, not silently change verbosity.
	root.PersistentFlags().Var(&logLevel, "log-level",
		"log threshold: debug, info, warn, or error")
```

The flag's value is not a plain string: `pflag` asks for three methods, and `logLevelFlag` implements them, so the level is parsed and validated as it is set.

<!-- verify: internal/cli/cli.go at=logging -->
```go title="internal/cli/cli.go"
// levelSetter is the capability --log-level needs from the logger's handler:
// internal/logging's tee handler owns the LevelVar its two sinks share, so
// one SetLevel call retunes stderr and the log file together. Naming the
// interface here, at the user, keeps cli from importing the logging package.
type levelSetter interface {
	SetLevel(slog.Level)
}

// logLevelFlag is --log-level's pflag.Value. Its zero value is info — slog's
// own zero — so an unset flag reads as the default in help and in the
// pre-run. Set parses and validates; the resolved level is applied at
// pre-run time, not while parsing, so a second execution of one tree
// re-applies the flag's value instead of inheriting the last run's.
type logLevelFlag struct {
	level slog.Level
}

// String spells the level the way the flag does, so pflag prints
// "(default info)" and the help names the type it accepts.
func (f *logLevelFlag) String() string { return logLevelName(f.level) }

// Set parses one --log-level occurrence.
func (f *logLevelFlag) Set(value string) error {
	level, err := parseLogLevel(value)
	if err != nil {
		return err
	}
	f.level = level
	return nil
}

// Type names the value type in help: --log-level level.
func (f *logLevelFlag) Type() string { return "level" }
```

A typo has to fail the command, never quietly change verbosity, so the parsing is strict.

<!-- verify: internal/cli/cli.go at=logging -->
```go title="internal/cli/cli.go"
// parseLogLevel maps the flag's four names to slog levels. Anything else is
// an error, not a fallback: a typo must fail the command, never silently
// change verbosity.
func parseLogLevel(value string) (slog.Level, error) {
	switch value {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return 0, fmt.Errorf("unknown level %q: want debug, info, warn, or error", value)
}
```

`logLevelName` is the inverse, for the help text: it turns a level back into the flag's word, which is what prints `(default info)` and names the type the flag takes.

The level reaches the handler in the pre-run hook, before anything logs.

<!-- verify: internal/cli/cli.go at=logging -->
```go title="internal/cli/cli.go"
			// The flag's level is applied before anything logs. The
			// process logger's handler (internal/logging's tee) exposes
			// SetLevel; a logger without it keeps the level it was built
			// with, and the flag is validated but inert.
			if setter, ok := sess.logger.Handler().(levelSetter); ok {
				setter.SetLevel(logLevel.level)
			}
			cfg, err := config.Load(os.Getenv, dbFlag)
			if err != nil {
				return err
			}
			// The resolved paths are the first debug record: "why is my
			// data not where I thought" is exactly what a debug run is
			// for.
			sess.logger.Debug("config resolved", "db", cfg.DBPath, "log", cfg.LogPath)
```

The `ok` in that `if` is the whole conversation: the process logger's handler has a `SetLevel`, so it gets retuned; any other logger keeps the level it was built with, and the flag is validated but inert. That fallback is deliberate.

The commands log their writes, and only their writes. The finished app's
appendix holds `internal/cli/cli.go` in full; the pieces quoted here are the
ones that carry the idea.

<!-- verify: internal/cli/cli.go at=logging -->
```go title="internal/cli/cli.go"
			sess.logger.Info("task added", "id", stored.ID.String(), "title", stored.Title)
			// ...
			sess.logger.Info("task completed", "id", id.String(), "title", t.Title)
			// ...
			sess.logger.Info("imported", "count", n)
```

No command logs a read, and no command writes a record to its output writer. Each value rides as its own field, so a reader can pull it out without parsing the message.

## Main builds the logger before the tree

There is a circle to break. The logger needs the log path, the log path comes from configuration, and the tree — which is what parses flags — needs the logger at construction. So `main` resolves the configuration first, before the tree runs. The finished app's appendix holds this file in full — the lines behind the `...` are there as you type them.

<!-- verify: cmd/todo/main.go at=logging -->
```go title="cmd/todo/main.go"
	// The logger must exist before the tree runs — every command takes it —
	// so the log path is resolved here, before cobra has seen any flag. The
	// database path this Load also produces is discarded: the tree resolves
	// again in its pre-run with --db, the flag this function cannot see yet.
	// The log path does not depend on --db, so the two resolutions agree on
	// it.
	cfg, err := config.Load(os.Getenv, "")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	// The TTY decision belongs here, where the real stderr is: a terminal
	// gets tint's human-readable records, anything else JSON — machines
	// parse. The file sink is JSON either way.
	isTTY := term.IsTerminal(int(os.Stderr.Fd()))
	logger, closer, err := logging.New(os.Stderr, isTTY, cfg.LogPath, slog.LevelInfo)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
```

One resolution happens twice — here and in the tree's pre-run — and the comment names why: `--db` can change the database path but not the log path, so the two agree. The terminal check is one line, and it belongs here, where the real stderr is: `term.IsTerminal(int(os.Stderr.Fd()))` asks the operating system whether the stream is a terminal.

<!-- verify: cmd/todo/main.go at=logging -->
```go title="cmd/todo/main.go"
	defer func() {
		// The process is leaving; a close error cannot change the exit
		// code and has nowhere better to go, so it is discarded
		// explicitly, like the import handle in the CLI.
		_ = closer.Close()
	}()

	// The CLI owns the store's lifecycle now: it resolves the path, calls
	// openStore, and runs the returned cleanup when the command finishes.
	// ...
	root := cli.New(openStore, logger, os.Stdout, os.Stderr)
```

The logger starts at `info`, so a run with no flag is quiet, and the file's closer is deferred — the process is leaving, and a close error has nowhere better to go. The file's imports gain `log/slog`, `golang.org/x/term`, `todo/internal/config`, and `todo/internal/logging`.

## Run it green

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.551s
ok  	todo/internal/cli	0.010s
ok  	todo/internal/config	0.004s
ok  	todo/internal/db	0.021s
ok  	todo/internal/logging	0.004s
ok  	todo/internal/store	0.099s
?   	todo/internal/store/storetest	[no test files]
```

Every package passes — the fan-out, the threshold, the file, and both renderings among them. The script scenarios pass too, because the binary now writes the record `add_list` asks for.

## Watch the records arrive

Build the binary the way you have before, copy it into an empty scratch folder, and work from a subfolder inside it — that's why the commands say `../todo`. Name the database and the log file explicitly, so the experiment stays inside the scratch folder.

```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ../todo add 'buy milk' >out.txt 2>err.txt; echo "exit: $?"
exit: 0
$ cat out.txt
01a13791-b031-7dca-bcb6-86c83b18fe6a
$ cat err.txt
{"time":"2026-10-14T04:50:57.137954805+05:30","level":"INFO","msg":"task added","id":"01a13791-b031-7dca-bcb6-86c83b18fe6a","title":"buy milk"}
```

Read the two files: stdout carries exactly one line, the id — the data the caller asked for — and stderr carries the record. `done` prints nothing on stdout at all, and its record is the only trace of the write.

```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ../todo done 01a13791-b031-7dca-bcb6-86c83b18fe6a >out.txt 2>err.txt
$ cat err.txt
{"time":"2026-10-14T04:50:57.144723939+05:30","level":"INFO","msg":"task completed","id":"01a13791-b031-7dca-bcb6-86c83b18fe6a","title":"buy milk"}
```

Reads stay silent. `list --json` writes its JSON lines to stdout and zero bytes to stderr, and `--log-level debug` adds one debug record while the JSON stays byte-clean.

```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ../todo list --json >out.jsonl 2>err.txt; echo "exit: $?"
exit: 0
$ cat out.jsonl
...
{"id":"01a13791-b031-7dca-bcb6-86c83b18fe6a","title":"buy milk","status":"Done","priority":3,"due":null,"tags":[],"version":2}
$ wc -c < err.txt
0

$ TODO_DB=todo.db TODO_LOG=todo.log ../todo list --json --log-level debug >out.jsonl 2>err.txt
$ cat err.txt
{"time":"2026-10-14T04:50:57.162714134+05:30","level":"DEBUG","msg":"config resolved","db":"todo.db","log":"todo.log"}
```

:::tip
When something isn't where you expected, run the command again with `--log-level debug`. The first record names the resolved database and log paths — the two decisions the app makes before anything else runs.
:::

The log file is the durable channel. Every run appended to the same file, so it holds the records from all of them, oldest first: the record from the add, the one from the done, and the debug record the last run added. The info runs didn't write the debug record, and the debug run didn't lose the earlier ones.

```bash
$ cat todo.log
{"time":"2026-10-14T04:50:57.137954805+05:30","level":"INFO","msg":"task added","id":"01a13791-b031-7dca-bcb6-86c83b18fe6a","title":"buy milk"}
{"time":"2026-10-14T04:50:57.144723939+05:30","level":"INFO","msg":"task completed","id":"01a13791-b031-7dca-bcb6-86c83b18fe6a","title":"buy milk"}
{"time":"2026-10-14T04:50:57.162714134+05:30","level":"DEBUG","msg":"config resolved","db":"todo.db","log":"todo.log"}
```

Now the default path. With neither variable set, the run resolves both paths through the XDG folders — and the log lands exactly where the configuration work promised, with its parent folders created on the way. (This run starts one folder deeper, so the binary is `../../todo`.)

```bash
$ XDG_DATA_HOME=$PWD/xdg-data XDG_STATE_HOME=$PWD/xdg-state ../../todo add 'call mom' >out.txt 2>err.txt
$ find . -type f | sort
./err.txt
./out.txt
./xdg-data/todo/todo.db
./xdg-data/todo/todo.db-log
./xdg-data/todo/todo.db-wal
./xdg-state/todo/logs/todo.log
$ cat xdg-state/todo/logs/todo.log
{"time":"2026-10-14T04:50:57.178799532+05:30","level":"INFO","msg":"task added","id":"01a13791-b05a-7a4d-83b8-c06ca9b6f583","title":"call mom"}
```

One more shape, for when a person is watching: on a terminal the record is a single colored line (colors stripped here), and the id still lands on stdout.

```text
Oct 14 04:50:57.196 INF task added id=01a13791-b06c-7a04-980a-05f52fb99aba title="write the book"
01a13791-b06c-7a04-980a-05f52fb99aba
```

An unknown level fails while the flag is parsed, naming the four names that work.

```bash
$ ../todo --log-level loud list
invalid argument "loud" for "--log-level" flag: unknown level "loud": want debug, info, warn, or error
$ echo "exit: $?"
exit: 1
```

And the help states the flag once for the whole tree, on the root and on every command under it. The `sed` part just trims the help to its flags section.

```bash
$ ./todo --help | sed -n '/^Flags:/,/^$/p'
Flags:
      --db string         path to the Turso database; overrides $TODO_DB and the XDG default
  -h, --help              help for todo
      --json              output JSON instead of the human-readable format
      --log-level level   log threshold: debug, info, warn, or error (default info)
```

`add`, `done`, and the rest inherit the flag without declaring it, because the root declared it as persistent — the same way they inherited `--db` and `--json`.

## If something went wrong

**The record lands on stdout and breaks a `--json` pipe.** The command succeeds; the script reading it doesn't. With the logger wired to stdout instead of stderr, a run of `add --json` looks like this.

```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ./todo-stdout add 'buy milk' --json >out.txt 2>err.txt
$ cat out.txt
{"time":"2026-10-14T04:47:49.996465265+05:30","level":"INFO","msg":"task added","id":"01a1378e-d52c-765e-804a-1574c862e833","title":"buy milk"}
{"id":"01a1378e-d52c-765e-804a-1574c862e833","title":"buy milk","status":"Todo","priority":3,"due":null,"tags":[],"version":1}
$ python3 -m json.tool < out.txt
Extra data: line 2 column 1 (char 144)
```

`Extra data` is the JSON reader finding a second kind of line where only JSON should be. The record isn't wrong; its destination is. The fix is one argument: `logging.New` gets `os.Stderr`, and `cli.New` keeps `os.Stdout` for the tree. The two channels stay separate all the way down.

**`--log-level` is accepted but nothing changes.** The command exits 0, and no debug record appears, because the handler has no `SetLevel` to reach.

```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ./todo-inert --log-level debug list --json >out.txt 2>err.txt
$ echo "exit: $?"
exit: 0
$ wc -c < err.txt
0
```

Building the logger from a plain JSON handler leaves the flag validated but inert: nothing was built to move. The fix is the process logger from `internal/logging` — its tee owns the shared `LevelVar` — and the pre-run's `levelSetter` check. A logger without the method still works; that fallback is the documented behavior, not a failure.

**`logging: open log file: ... no such file or directory`.** The first run on a fresh account fails before the command starts.

```bash
$ XDG_DATA_HOME=$PWD/xdg-data XDG_STATE_HOME=$PWD/xdg-state ../todo-nomkdir add 'call mom' >out.txt 2>err.txt
$ cat err.txt
logging: open log file: open /tmp/opencode/wt-logging-scratch/nomkdir/xdg-state/todo/logs/todo.log: no such file or directory
$ echo "exit: $?"
exit: 1
```

The default nests `todo/logs` under `$XDG_STATE_HOME`, which a fresh account does not have, and opening a file does not create the folders around it. The fix is `os.MkdirAll(filepath.Dir(logPath), 0o700)` before the open — configuration decides where, the writer makes it real. A log file that cannot be created fails the run on purpose: quietly logging nowhere would hide exactly the misconfiguration this chapter makes visible.

<details>
<summary>Going deeper: what is a TTY?</summary>

A **TTY** is an old name for a terminal — it started as an abbreviation of "teletype". When a program's stderr is connected to one, a person is watching. When it is connected to a pipe, a file, or a service manager, a program is reading.

That difference is why the app asks. The check is one line in `main`: `term.IsTerminal(int(os.Stderr.Fd()))`. `os.Stderr.Fd()` is the number the operating system uses for the open stream, and `IsTerminal` asks the system whether that number names a terminal. The answer is a plain bool, and `logging.New` takes it as a parameter — so the package itself never looks at the process around it, and the tests can pin both shapes with buffers.

A terminal gets the human shape because a person reads `INF task added id=42` faster than `{"level":"INFO",...}`. Everything else gets JSON because the reader is a machine. The file is JSON in both cases, because the file's reader is never a person.

</details>

<details>
<summary>Going deeper: why one logger instead of two?</summary>

The obvious alternative is two loggers: one for stderr, one for the file. It fails on decoration. `logger.With("component", "store")` makes a derived logger with an extra field; with two loggers, the field lands on one and not the other, and every call site has to choose which logger to use. One handler that fans out keeps one logger as the unit of use: `WithAttrs` and `WithGroup` run over both destinations, so a decorated logger cannot drift between them.

The fan-out itself is small because `slog.Handler` is an ordinary interface — four methods. `Enabled` answers for the union of the two destinations: if either wants a record at this level, the record is built. `Handle` checks each destination again and gives each its own copy of the record, because a record's fields are only valid during the call. The tee owns the shared `LevelVar`, so one `SetLevel` moves both thresholds at once.

</details>

<details>
<summary>Going deeper: why key/value pairs instead of sentences?</summary>

A record could be a sentence: `fmt.Sprintf("added %s (%s)", id, title)`. It reads fine, and it is terrible to search. The id is buried in the text, and finding every record about one task means matching against a format that will change.

Key/value pairs make each fact addressable. The message stays short and stable — `task added` — and the values ride beside it as fields. On the terminal a field renders as `id=…`; in the file it renders as `"id":"…"`. `grep '"msg":"task added"' todo.log` finds the records, and the reader of the JSON picks out the fields. That is what "structured logging" means: the structure is part of the record, not something a reader has to reconstruct. Levels work the same way — every record carries its own level, so a filter can drop the debug noise without touching the calls that made it.

</details>

The app has a diary now — data on stdout, records on stderr, and a file that remembers. Next, the app grows a web face, and the requests that hit it will write to this same log.
