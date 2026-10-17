---
title: "cmd/todo — the finished app"
description: "The finished app, file by file: cmd/todo (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `cmd/todo/integration_test.go`

````go
// The black-box tests: the real binary TestMain built, run through
// exec.Command with a deliberately bare environment. Everything a user
// sees — stdout, stderr, exit codes — is what these tests read; no package
// under internal/ is called directly.
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/task"
)

// binaryEnv is the whole environment the black-box tests give the binary:
// PATH, so the process starts, and the two variables that pin the CLI's two
// paths. HOME and the XDG variables are absent on purpose: TODO_DB and
// TODO_LOG are the app's own overrides, and with them set the binary must
// not need either.
func binaryEnv(dbPath string) []string {
	return []string{
		"PATH=" + os.Getenv("PATH"),
		"TODO_DB=" + dbPath,
		"TODO_LOG=" + dbPath + ".log",
	}
}

// binaryResult is one black-box run: the two captured streams and the exit
// code. A non-zero code is a result to assert on, not a test failure.
type binaryResult struct {
	stdout string
	stderr string
	code   int
}

// runBinary runs TestMain's binary with the given environment and returns
// what the process printed and how it exited.
func runBinary(t *testing.T, env []string, args ...string) binaryResult {
	t.Helper()
	return runBinaryAt(t, binPath, env, args...)
}

// runBinaryAt runs the binary at bin — TestMain's or one a test built for
// itself — with the given environment and returns what the process printed
// and how it exited.
func runBinaryAt(t *testing.T, bin string, env []string, args ...string) binaryResult {
	t.Helper()
	// #nosec G204 -- bin is built by TestMain or by the calling test from
	// this package's own source, and args are test-authored literals.
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		require.ErrorAs(t, err, &exitErr, "todo %s", strings.Join(args, " "))
		code = exitErr.ExitCode()
	}
	return binaryResult{stdout: stdout.String(), stderr: stderr.String(), code: code}
}

// wireTask is the test's own copy of the --json contract: the seven keys
// chapter 27 documented. Owning the shape here is the point of a black-box
// test — a renamed key fails this struct even though no code in the module
// moved.
type wireTask struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Status   string     `json:"status"`
	Priority int        `json:"priority"`
	Due      *time.Time `json:"due"`
	Tags     []string   `json:"tags"`
	Version  int        `json:"version"`
}

// TestBinary_RoundTrip is the black-box happy path: the id add prints is
// the handle done takes, list reflects the change, and stats --json counts
// it. Everything travels through the process boundary exactly as a shell
// script would use it.
func TestBinary_RoundTrip(t *testing.T) {
	t.Parallel()

	env := binaryEnv(filepath.Join(t.TempDir(), "todo.db"))

	add := runBinary(t, env, "add", "buy milk")
	require.Equal(t, 0, add.code, "add failed: %s", add.stderr)
	id, err := uuid.Parse(strings.TrimSpace(add.stdout))
	require.NoError(t, err, "add prints the id it assigned, got %q", add.stdout)

	done := runBinary(t, env, "done", id.String())
	require.Equal(t, 0, done.code, "done failed: %s", done.stderr)
	assert.Empty(t, done.stdout, "the human done reports nothing on success")

	list := runBinary(t, env, "list")
	require.Equal(t, 0, list.code, "list failed: %s", list.stderr)
	assert.Contains(t, list.stdout, "buy milk")
	assert.Contains(t, list.stdout, "Done")

	// --json is where the status and version can be read exactly: the human
	// table is for eyes, the JSON is for this test.
	jsonList := runBinary(t, env, "list", "--json")
	require.Equal(t, 0, jsonList.code, "list --json failed: %s", jsonList.stderr)
	var got wireTask
	require.NoError(t, json.Unmarshal([]byte(jsonList.stdout), &got), "one task, one line: %q", jsonList.stdout)
	assert.Equal(t, id.String(), got.ID)
	assert.Equal(t, "Done", got.Status)
	assert.Equal(t, 2, got.Version, "done bumps the version")

	stats := runBinary(t, env, "stats", "--json")
	require.Equal(t, 0, stats.code, "stats failed: %s", stats.stderr)
	assert.JSONEq(t, `{"total":1,"done":1,"pending":0}`, stats.stdout)
}

// TestBinary_AddDueTomorrow checks that the relative word survives the
// process boundary: `add --due tomorrow` goes in, and the due date that
// comes back out of `list --json` is the domain's own ParseDue answer for
// "tomorrow". The date is computed on both sides of the run, so a midnight
// crossing between the command's time.Now and the test's is accepted rather
// than flaky.
func TestBinary_AddDueTomorrow(t *testing.T) {
	t.Parallel()

	env := binaryEnv(filepath.Join(t.TempDir(), "todo.db"))

	before, err := task.ParseDue("tomorrow", time.Now())
	require.NoError(t, err)

	add := runBinary(t, env, "add", "call mom", "--due", "tomorrow")
	require.Equal(t, 0, add.code, "add failed: %s", add.stderr)

	after, err := task.ParseDue("tomorrow", time.Now())
	require.NoError(t, err)

	out := runBinary(t, env, "list", "--json")
	require.Equal(t, 0, out.code, "list --json failed: %s", out.stderr)
	var got wireTask
	require.NoError(t, json.Unmarshal([]byte(out.stdout), &got))
	require.NotNil(t, got.Due, "the task has a due date")
	assert.True(t, got.Due.Equal(before) || got.Due.Equal(after),
		"due = %s, want %s or %s (midnight may cross mid-test)", got.Due, before, after)
}

// TestBinary_ErrorExit pins the error contract at the process level: exit
// code 1, the message on stderr, and not one byte on stdout. The binary is
// built with -cover, so an unset GOCOVERDIR adds the runtime's warning to
// stderr; the assertion matches the message rather than the whole stream,
// while the stdout half of the contract stays exact.
func TestBinary_ErrorExit(t *testing.T) {
	t.Parallel()

	env := binaryEnv(filepath.Join(t.TempDir(), "todo.db"))

	res := runBinary(t, env, "done", "not-a-uuid")
	assert.Equal(t, 1, res.code, "a bad id is a failure")
	assert.Empty(t, res.stdout, "the error goes to stderr, not stdout")
	assert.Contains(t, res.stderr, `invalid id "not-a-uuid"`)
}

// TestBinary_Coverage is the cross-process coverage check: the binary was
// built with -cover, so running it with GOCOVERDIR set leaves counter data
// in the directory, and `go tool covdata percent` reads it back. This is
// coverage of the CLI as a real process, collected through the environment
// variable alone — not coverage of the test binary.
func TestBinary_Coverage(t *testing.T) {
	t.Parallel()

	covDir := t.TempDir()
	env := append(binaryEnv(filepath.Join(t.TempDir(), "todo.db")), "GOCOVERDIR="+covDir)

	// Three ordinary commands in three processes; covdata reads every
	// counter file the directory holds, so the report below is their
	// merged view.
	require.Equal(t, 0, runBinary(t, env, "add", "buy milk").code)
	require.Equal(t, 0, runBinary(t, env, "list").code)
	require.Equal(t, 0, runBinary(t, env, "stats").code)

	// #nosec G204 -- the tool is a literal; covDir is the temp directory
	// this test just made.
	out, err := exec.Command("go", "tool", "covdata", "percent", "-i="+covDir).CombinedOutput()
	if err != nil {
		t.Skipf("go tool covdata unavailable: %v\n%s", err, out)
	}
	t.Logf("go tool covdata percent:\n%s", out)

	for _, pkg := range []string{"todo/cmd/todo", "todo/internal/cli"} {
		re := regexp.MustCompile(regexp.QuoteMeta(pkg) + `\s+coverage: ([\d.]+)% of statements`)
		m := re.FindStringSubmatch(string(out))
		require.NotNil(t, m, "no coverage line for %s:\n%s", pkg, out)
		pct, err := strconv.ParseFloat(m[1], 64)
		require.NoError(t, err)
		assert.Positive(t, pct, "%s ran no statements", pkg)
	}
}

// TestBinary_Version is the version contract: the release stamps the tag
// into the binary with -ldflags -X and the binary reports it. The two builds
// are the two halves — the injected stamp, and the honest default every
// plain `go build` carries — and both must answer without a database, which
// is the one thing `todo version` may not need.
func TestBinary_Version(t *testing.T) {
	t.Parallel()

	// TestMain's binary is what `go build ./cmd/todo` produces, version-wise:
	// -cover instruments it, but no ldflags reach it, so the default must
	// come out and no store may be opened to print it.
	dbPath := filepath.Join(t.TempDir(), "todo.db")
	plain := runBinary(t, binaryEnv(dbPath), "version")
	require.Equal(t, 0, plain.code, "version failed: %s", plain.stderr)
	assert.Equal(t, "dev\n", plain.stdout, "a build without a stamp reports the honest default")
	assert.NoFileExists(t, dbPath, "version answers without opening a store")

	// The stamped build uses the release's own invocation: -X names
	// internal/version's variable, the same string .goreleaser.yaml passes.
	// The test spells the import path out rather than sharing a constant
	// with the code, because the path is the contract — a rename that moved
	// the stamp would fail here exactly as it would fail the release.
	stamped := buildStampedBinary(t, "v9.9.9-test")

	env := binaryEnv(filepath.Join(t.TempDir(), "todo.db"))
	res := runBinaryAt(t, stamped, env, "version")
	require.Equal(t, 0, res.code, "stamped version failed: %s", res.stderr)
	assert.Equal(t, "v9.9.9-test\n", res.stdout)

	json := runBinaryAt(t, stamped, env, "version", "--json")
	require.Equal(t, 0, json.code, "version --json failed: %s", json.stderr)
	assert.JSONEq(t, `{"version":"v9.9.9-test"}`, json.stdout)
}

// buildStampedBinary builds cmd/todo with the release's ldflags shape and
// returns the binary's path. `go test` runs the suite with cmd/todo as the
// working directory, so `.` is the package GoReleaser's main field names.
func buildStampedBinary(t *testing.T, version string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "todo")
	// #nosec G204 -- the command is a literal; the stamp and the output
	// path are test-authored.
	cmd := exec.Command("go", "build", "-o", bin,
		"-ldflags", "-X todo/internal/version.Version="+version, ".")
	cmd.Stderr = os.Stderr
	require.NoError(t, cmd.Run(), "build with the release's ldflags")
	return bin
}
````


## `cmd/todo/main.go`

````go
// Command todo is the todo application's CLI: a cobra command tree over the
// Turso store. The tree itself lives in internal/cli; this file is the
// wiring — signals, the real opener, the process logger, and the exit code.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"golang.org/x/term"

	"todo/internal/cli"
	"todo/internal/config"
	"todo/internal/logging"
	"todo/internal/store"
)

// main is the process's only job: exit with run's code.
func main() {
	os.Exit(run())
}

// run executes the command tree and returns the process's exit code: 0 on
// success, 1 after printing the one error line. It reads os.Args and writes
// to os.Stdout and os.Stderr, so the real binary and testscript's
// re-executed test binary — which needs a func() int to call — run the same
// function.
func run() int {
	// A first interrupt or SIGTERM cancels ctx, so every store call aborts
	// with a context error instead of the process dying mid-write. stop
	// unregisters the handler; the defer covers the normal return, while
	// main's os.Exit skips it — the process is leaving anyway.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
	defer func() {
		// The process is leaving; a close error cannot change the exit
		// code and has nowhere better to go, so it is discarded
		// explicitly, like the import handle in the CLI.
		_ = closer.Close()
	}()

	// The CLI owns the store's lifecycle now: it resolves the path, calls
	// openStore, and runs the returned cleanup when the command finishes.
	// main does not close the store itself — that defer from chapter 25
	// would close the handle a second time on the success path.
	root := cli.New(openStore, logger, os.Stdout, os.Stderr)
	if err := root.ExecuteContext(ctx); err != nil {
		// The tree silences cobra's own error reporting, so this is the one
		// place an error is printed: once, on stderr, the way a Unix tool
		// reports it. It is deliberately not logged as well: the one line
		// and the exit code are the error contract, and a second copy would
		// be noise.
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// openStore is the production OpenFunc: it opens the Turso store at the
// path the CLI resolved and hands the store's Close back as the cleanup.
// The resolved path's parent may not exist yet — the XDG default nests
// todo/ under $XDG_DATA_HOME — so the opener creates it first; the path's
// location is configuration's decision, and making it real is the opener's.
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
````


## `cmd/todo/main_test.go`

````go
// The binary's black-box tests live in package main: TestMain builds the
// real binary once for the exec.Command tests and registers the binary's
// main with testscript, so the txtar scenarios execute the same command
// tree a shell would — through a process boundary, with real exit codes.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/rogpeppe/go-internal/testscript"
)

// commands is the testscript command table: main, under the name the
// scripts exec, so a scripted `todo` is exactly what the binary runs —
// os.Exit(run()). TestMain reads the map to tell a re-executed command from
// the top-level `go test` process, which is the only one with a module to
// build.
var commands = map[string]func(){"todo": main}

// binPath is the CLI binary TestMain builds once for the exec.Command tests
// in integration_test.go; binDir is the temporary directory holding it,
// removed after the suite.
var (
	binPath string
	binDir  string
)

// TestMain builds the real binary once and then hands the suite to
// testscript.Main — the testscript contract for in-process commands.
// Main decides whether this process is `go test` or a re-executed command:
// in the first case it registers commands, runs the tests through suite,
// and exits; in the second it calls the command function, which exits with
// run's code. The build runs only in the first case, because a script's
// `exec todo` starts this binary with the script's work directory as its
// working directory, where there is nothing to build.
func TestMain(m *testing.M) {
	if !isCommandInvocation() {
		if err := buildBinary(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	testscript.Main(suite{m}, commands)
}

// suite adapts *testing.M for testscript.Main. Main always leaves through
// os.Exit, so the wrapper's Run is the last code before that exit — the
// place to remove the built binary's directory.
type suite struct {
	m *testing.M
}

// Run runs the tests, removes the binary's directory, and returns the exit
// code for Main to exit with.
func (s suite) Run() int {
	code := s.m.Run()
	if binDir != "" {
		if err := os.RemoveAll(binDir); err != nil {
			fmt.Fprintln(os.Stderr, "remove test binary dir:", err)
		}
	}
	return code
}

// isCommandInvocation reports whether this process was re-executed as one
// of the commands in commands rather than as `go test`. It mirrors Main's
// own detection rule, including the Windows .exe suffix.
func isCommandInvocation() bool {
	name := filepath.Base(os.Args[0])
	if runtime.GOOS == "windows" {
		name = strings.TrimSuffix(name, ".exe")
	}
	_, ok := commands[name]
	return ok
}

// buildBinary builds the CLI once for the whole suite. -cover instruments
// every package in the module, so a run with GOCOVERDIR set writes data
// `go tool covdata` reads back — TestBinary_Coverage's subject. One build
// serves every black-box test; rebuilding per test would dominate the
// suite's runtime.
func buildBinary() error {
	dir, err := os.MkdirTemp("", "todo-bin-")
	if err != nil {
		return fmt.Errorf("build test binary: %w", err)
	}
	binDir = dir
	binPath = filepath.Join(dir, "todo")
	// `go test` runs this binary with the package directory as the working
	// directory, so `.` is cmd/todo.
	// #nosec G204 -- the command is a literal; only the output path, chosen
	// right here, varies.
	cmd := exec.Command("go", "build", "-cover", "-o", binPath, ".")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("build test binary: %w", err)
	}
	return nil
}

// TestScripts runs the scenarios under testdata/script. Each script drives
// `todo` through testscript's shell; `exec todo` re-executes this test
// binary, which testscript.Main routes to main.
func TestScripts(t *testing.T) {
	testscript.Run(t, testscript.Params{
		Dir: "testdata/script",
		// The engine extracts its native library on first open. testscript
		// runs every script under an unwritable HOME, so point the
		// extraction at the script's own work directory instead.
		Setup: func(env *testscript.Env) error {
			env.Setenv("TURSO_GO_CACHE_DIR", filepath.Join(env.WorkDir, ".turso-cache"))
			return nil
		},
	})
}
````


## `cmd/todo/testdata/script/add_list.txtar`

````text
# add prints the id it assigned; list shows the task; stats counts it.

env TODO_DB=$WORK/todo.db
env TODO_LOG=$WORK/todo.log

# add: one line on stdout, a UUIDv7 (version nibble 7, RFC 4122 variant); the
# record goes to stderr as JSON — stdout is data, stderr is logs.
exec todo add 'buy milk'
stdout '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
stderr '"msg":"task added"'
stderr '"title":"buy milk"'

# list: the task is there and still Todo.
exec todo list
stdout 'Todo  buy milk'

# stats: one task total, none done.
exec todo stats
stdout 'Total:   1'
stdout 'Done:    0'
stdout 'Pending: 1'
````


## `cmd/todo/testdata/script/errors.txtar`

````text
# Failures share one shape: a non-zero exit, one line on stderr, stdout
# untouched. testscript's ! checks the exit is non-zero; the exact code 1 is
# pinned in TestBinary_ErrorExit.

env TODO_DB=$WORK/todo.db
env TODO_LOG=$WORK/todo.log

# done: a malformed id is refused before the store is touched.
! exec todo done not-a-uuid
stderr 'invalid id "not-a-uuid"'
! stdout .

# an unknown command is a usage error, not a crash.
! exec todo frobnicate
stderr 'unknown command "frobnicate"'

# list: --status is validated by the domain's own UnmarshalText.
! exec todo list --status Bogus
stderr 'unknown status "Bogus"'
! stdout .
````


## `cmd/todo/testdata/script/import.txtar`

````text
# import reads a v3 document and prints how many tasks landed. The document
# ships in the archive; cp gives the script the file to name on the command
# line.

env TODO_DB=$WORK/todo.db
env TODO_LOG=$WORK/todo.log

cp doc.v3.json doc.json

exec todo import doc.json
stdout 'imported 2 tasks'

# The imported tasks are readable through the ordinary commands.
exec todo list
stdout 'write tests'
stdout 'review code'

exec todo stats --json
cmp stdout stats.json

-- doc.v3.json --
{"version":3,"tasks":[
	{"ID":"0199c0de-0000-7000-8000-000000000001","Title":"write tests","Status":"Todo","Priority":3,"Due":"2026-11-01T00:00:00Z","Tags":["go","book"],"Version":2},
	{"ID":"0199c0de-0000-7000-8000-000000000002","Title":"review code","Status":"Done","Priority":5,"Due":"0001-01-01T00:00:00Z","Tags":["review"],"Version":4}
]}

-- stats.json --
{"total":2,"done":1,"pending":1}
````


## `cmd/todo/testdata/script/json.txtar`

````text
# --json is the machine format: one object per line on stdout, and stdout is
# the only channel it uses for data — log records go to stderr. list logs
# nothing, so its stderr stays empty; add's record is covered by add_list.

env TODO_DB=$WORK/todo.db
env TODO_LOG=$WORK/todo.log

exec todo add 'buy milk'
stdout '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

# list --json: one line with the seven documented keys. The stdout command
# is testscript's grep over the captured output; cp + grep reads the same
# bytes back through a file.
exec todo list --json
stdout '"title":"buy milk"'
stdout '"status":"Todo"'
stdout '"due":null'
stdout '"tags":\[\]'
stdout '"version":1'
! stderr .
cp stdout list.jsonl
grep -count=1 '"id":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"' list.jsonl
grep '"priority":3' list.jsonl

# stats --json: one object, exact bytes.
exec todo stats --json
cmp stdout stats.json

-- stats.json --
{"total":1,"done":0,"pending":1}
````
