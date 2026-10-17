---
title: "internal/logging — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/logging/logging.go`

````go
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

	f, err := openLogFile(logPath)
	if err != nil {
		return nil, nil, err
	}
	fileHandler := slog.NewJSONHandler(f, &slog.HandlerOptions{Level: levelVar})

	return slog.New(newTeeHandler(levelVar, stderrHandler, fileHandler)), f, nil
}

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
````


## `internal/logging/logging_test.go`

````go
package logging_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/logging"
)

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

// TestNew_LevelFiltering pins the threshold: records below the level reach
// neither sink; records at and above it reach both. The second case moves
// the level after the logger exists — the shared knob the CLI's --log-level
// flag rides on.
func TestNew_LevelFiltering(t *testing.T) {
	t.Parallel()

	t.Run("the build-time level filters", func(t *testing.T) {
		t.Parallel()

		logger, stderr, logPath := newProcessLogger(t, false, slog.LevelWarn)
		logger.Info("dropped")
		logger.Warn("kept")

		assert.NotContains(t, stderr.String(), "dropped")
		assert.Contains(t, stderr.String(), `"msg":"kept"`)

		data := readLog(t, logPath)
		assert.NotContains(t, data, "dropped")
		assert.Contains(t, data, `"msg":"kept"`)
	})

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

	data := readLog(t, logPath)
	var rec struct {
		Time  string `json:"time"`
		Level string `json:"level"`
		Msg   string `json:"msg"`
		ID    string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(bytes.TrimSuffix([]byte(data), []byte("\n")), &rec),
		"the record is JSON: %q", data)
	assert.Equal(t, "INFO", rec.Level)
	assert.Equal(t, "task added", rec.Msg)
	assert.Equal(t, "42", rec.ID)
	assert.NotEmpty(t, rec.Time, "every record carries a timestamp")

	// A second logger over the same path appends: the first record stays.
	logger2, closer2, err := logging.New(&stderr, false, logPath, slog.LevelInfo)
	require.NoError(t, err)
	t.Cleanup(func() { _ = closer2.Close() })
	logger2.Info("second run")

	data = readLog(t, logPath)
	assert.Contains(t, data, "task added")
	assert.Contains(t, data, "second run")
	assert.Equal(t, 2, strings.Count(data, "\n"), "one line per record")
}

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

	t.Run("a pipe gets JSON", func(t *testing.T) {
		t.Parallel()

		logger, stderr, _ := newProcessLogger(t, false, slog.LevelInfo)
		logger.Info("task added", "id", "42")

		line := strings.TrimSpace(stderr.String())
		var rec map[string]any
		require.NoError(t, json.Unmarshal([]byte(line), &rec), "the pipe shape is JSON: %q", line)
		assert.Equal(t, "INFO", rec["level"])
		assert.Equal(t, "task added", rec["msg"])
		assert.Equal(t, "42", rec["id"])
	})
}
````
