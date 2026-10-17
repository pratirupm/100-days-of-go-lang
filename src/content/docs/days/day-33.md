---
title: "Day 33 — Integration tests"
sidebar:
  order: 33
chapter: 28
---

**About 3 hours** · Part VI, day 4 of 5.

**You'll be able to:**

- black-box test the real binary with testscript;
- keep scenarios in txtar files and measure the binary’s coverage.

---

Everything the app does now has a test watching it. But every one of those
tests calls the app's code directly: build a command tree, hand it a fake
store, read the buffers it wrote into. Nobody runs a function. People run the
program.

Today we test the program. We build the real thing once, start it as a
separate process, and check what it prints and what it exits with — the way
you would check a tool you just installed. A test that works this way is
called an **integration test**: it runs the real program and looks at what
comes out.

The suite comes in two layers. Small script files drive the program through
ordinary sessions: add a task, list it, count it. Go tests handle the flows a
script cannot write, like feeding one command's printed id into the next
command. And by the end, the same runs report which lines of the app they
actually touched.

## Testing the program, not the code

Every test we have written so far lives inside the app: it calls a function,
hands it a value, and checks what comes back, sometimes with a fake store
standing in for the real one. Those tests are fast and exact, and they are
still the right home for most checks. But they all begin from the assumption
that the code already runs.

A user starts from the other end. They have a program on disk. They run it
with arguments; it prints something, or nothing; it exits with a code — 0
for a job done, 1 for a job that failed. That is the whole surface: you
cannot see the functions from there, only what comes out. Tests written this
way are called **black-box** tests — the program is a closed box.

Those edges are exactly what the in-process tests cannot see. Does the
program build and start at all? Does it exit with the code the code decided
on? Do its two streams carry what they should — results on stdout, the one
error line on stderr? Does it resolve its paths from the environment with no
help from a test? That list is this suite's whole job.

## The exit code becomes a value

The exit code is the one thing a process says that no in-process test can
read. Today that code is produced deep inside `main`: the error path calls
`os.Exit(1)`, and the success path simply falls off the end of the function.
Before the tests arrive, we give the program a cleaner shape. `main`'s body
moves into a function called `run`, which returns the code instead of
exiting, and `main` becomes one line that exits with it.

<!-- verify: cmd/todo/main.go at=cli-tests -->
```go title="cmd/todo/main.go"
// main is the process's only job: exit with run's code.
func main() {
	os.Exit(run())
}

// run executes the command tree and returns the process's exit code: 0 on
// success, 1 after printing the one error line. It reads os.Args and writes
// to os.Stdout and os.Stderr, so the real binary and testscript's
// re-executed test binary ... run the same
// function.
func run() int {
	// ...
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The CLI owns the store's lifecycle now: it resolves the path, calls
	// openStore, and runs the returned cleanup when the command finishes.
	// ...
	root := cli.New(openStore, os.Stdout, os.Stderr)
	if err := root.ExecuteContext(ctx); err != nil {
		// The tree silences cobra's own error reporting, so this is the one
		// place an error is printed: once, on stderr, the way a Unix tool
		// reports it.
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
```

Read the two functions as one sentence: `main` leaves the process, and `run`
decides with what. `run` returns 0 when the command finished and 1 after
printing the one error line — the same behavior as before, with the decision
turned into a value. Nothing else moved: the signal setup, the command tree,
and the error line are unchanged.

## One build for the whole suite

Create `cmd/todo/main_test.go`. It opens with the usual testing imports plus
one package from outside the app — a library of helpers for running a program
from a test:

<!-- verify: cmd/todo/main_test.go at=cli-tests -->
```go title="cmd/todo/main_test.go"
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
```

The last line is the only new name: `testscript`, the package the scripts
will run through. Next comes the file's heart. `TestMain` is a special name
in Go's testing toolkit: when a package has one, the toolkit calls it instead
of running the tests directly, and hands it the machinery that runs them.
Ours uses that moment to build the real binary once, then hands the suite to
testscript:

<!-- verify: cmd/todo/main_test.go at=cli-tests -->
```go title="cmd/todo/main_test.go"
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
// ...
func TestMain(m *testing.M) {
	if !isCommandInvocation() {
		if err := buildBinary(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	testscript.Main(suite{m}, commands)
}
```

Three things to notice. `commands` is the table the scripts look up: the name
a script types — `todo` — mapped to the function that runs it, which is the
program's own `main`. The build runs only when this process is an ordinary
test run; when the process is a script's re-executed command, there is
nothing to build. And `testscript.Main` takes over from there — it either
runs the tests or runs the registered command, and it always leaves through
`os.Exit`.

That exit explains the next type. Code placed after `testscript.Main` would
never run, so the file wraps the testing machinery in a small `suite` type
whose `Run` is the last code to execute before the process leaves — which
makes it the place to delete the temporary folder holding the built binary:

<!-- verify: cmd/todo/main_test.go at=cli-tests -->
```go title="cmd/todo/main_test.go"
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
```

The cleanup runs even when tests fail, because `Run` always returns after
the test machinery does.

The check that tells the two roles apart reads the name the process was
started under and asks the command table whether that name is a command:

<!-- verify: cmd/todo/main_test.go at=cli-tests -->
```go title="cmd/todo/main_test.go"
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
```

It is deliberately the same rule `Main` applies one line later.

The build itself is one command, with the binary's path kept in the two
package variables:

<!-- verify: cmd/todo/main_test.go at=cli-tests -->
```go title="cmd/todo/main_test.go"
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
```

`-cover` is the flag that pays off later: it makes the built binary record
which of its own lines run and write that record to the folder the
environment names. The `#nosec` comment is a note to the code checker; it
names why starting a subprocess with a path that varies is safe here — the
path is one this function just chose. One build serves every test; building
per test would dominate the suite's runtime.

Last, the test that runs the scripts:

<!-- verify: cmd/todo/main_test.go at=cli-tests -->
```go title="cmd/todo/main_test.go"
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
```

`testscript.Run` runs every `.txtar` file under `testdata/script` as its own
subtest. The `Setup` line is the one piece that has nothing to do with the
program's behavior: the database engine unpacks a native library on its first
open, and testscript runs each script with an unwritable `HOME`, so the
extraction is pointed at the script's own work folder instead. Without it,
every script dies in the library loader before any of our code runs.

## Scripts that drive the program

A script is a plain text file with a `.txtar` extension. Everything before
the first `-- name --` line is the script; every section after one is a file,
unpacked into the script's work folder before anything runs. That is how a
script can ship a document for `import` to read, or a golden file to compare
against.

The language inside is shell-shaped: `exec todo add 'buy milk'` runs the
command; `stdout 'pattern'` checks the last command's output with a pattern
match; a line starting with `!` says the command must fail; `env
TODO_DB=$WORK/todo.db` sets a variable for every command that follows.
`$WORK` is the script's own scratch folder, fresh for each run.

Two rules keep scripts honest. Quoting is literal — the line is split on
spaces, and single quotes group words; there is no shell to interpret
anything else. And comments are `#`. A `//` on its own line is read as a
command name, and the run stops with `unknown command "//"`.

Here is the first script:

<!-- verify: cmd/todo/testdata/script/add_list.txtar at=cli-tests -->
```text title="cmd/todo/testdata/script/add_list.txtar"
# add prints the id it assigned; list shows the task; stats counts it.

env TODO_DB=$WORK/todo.db

# add: one line on stdout, a UUIDv7 (version nibble 7, RFC 4122 variant).
exec todo add 'buy milk'
stdout '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

# list: the task is there and still Todo.
exec todo list
stdout 'Todo  buy milk'

# stats: one task total, none done.
exec todo stats
stdout 'Total:   1'
stdout 'Done:    0'
stdout 'Pending: 1'
```

Read it top to bottom as a session. It sets the database path, adds a task,
and checks that what `add` printed is a UUID — the pattern pins the dashed
shape and the version `7`. Then `list` shows the task with its status, and
`stats` counts it. Each `stdout` line is checked against the output of the
command above it.

The second script pins the failure shape, a contract of its own: a failing
command exits non-zero, writes one line to stderr, and leaves stdout
untouched.

<!-- verify: cmd/todo/testdata/script/errors.txtar at=cli-tests -->
```text title="cmd/todo/testdata/script/errors.txtar"
# Failures share one shape: a non-zero exit, one line on stderr, stdout
# untouched. testscript's ! checks the exit is non-zero; the exact code 1 is
# pinned in TestBinary_ErrorExit.

env TODO_DB=$WORK/todo.db

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
```

The `!` before `exec` says the command must fail; `! stdout .` says stdout
must stay empty — the dot matches anything, and `!` inverts it. The exact
exit code, 1, is checked later in a Go test, because a script can only say
"not zero".

## Scripts that read the machine format

The next two scripts cover the formats the app offers to other programs.
`json.txtar` reads the `--json` line shape, then reads the same bytes back
through a file:

<!-- verify: cmd/todo/testdata/script/json.txtar at=cli-tests -->
```text title="cmd/todo/testdata/script/json.txtar"
# --json is the machine format: one object per line on stdout, and stdout is
# the only channel it uses.

env TODO_DB=$WORK/todo.db

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
```

`cp stdout list.jsonl` materializes the last command's output as a real file
— `stdout` and `stderr` are names testscript understands in these commands —
because `grep` reads files only. The last comparison checks `stats --json`
byte for byte against the golden object shipped in the archive's second
section.

`import.txtar` uses the archive to ship an input document, and checks that a
whole file of tasks lands in the store:

<!-- verify: cmd/todo/testdata/script/import.txtar at=cli-tests -->
```text title="cmd/todo/testdata/script/import.txtar"
# import reads a v3 document and prints how many tasks landed. The document
# ships in the archive; cp gives the script the file to name on the command
# line.

env TODO_DB=$WORK/todo.db

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
```

The `-- doc.v3.json --` section is a version 3 export document, the format
the app writes. `cp` gives it the name to pass on the command line, `import`
reports how many tasks it read, and the ordinary `list` and `stats` prove the
tasks are really there.

## Go tests that own the process

Scripts can check output, but they cannot capture it: there is no way to take
the id `add` printed and hand it to the next command. Flows like that belong
in Go, where running the program hands us the streams directly. Create
`cmd/todo/integration_test.go`:

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
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
```

The uuid, assert, and require packages are the ones the earlier test files
already use; `todo/internal/task` is imported for the date test. Every test
in this file starts from the same two helpers. The first builds the
environment the binary runs in — and the environment is part of the
contract:

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
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
```

Three variables, and deliberately nothing else: `PATH`, so the process
starts, and `TODO_DB` and `TODO_LOG`, which pin the two paths the app
resolves. No `HOME`, no XDG variables. If the app needed any of them, this
suite would fail — exactly the claim worth testing. `binaryResult` is the
record each run produces: both streams, and the exit code.

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
// runBinary runs the built binary with the given environment and returns
// what the process printed and how it exited.
func runBinary(t *testing.T, env []string, args ...string) binaryResult {
	t.Helper()
	// #nosec G204 -- binPath is built by TestMain from this package's own
	// source, and args are test-authored literals.
	cmd := exec.Command(binPath, args...)
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
```

`runBinary` runs the built binary with that environment, captures both
streams, and returns the record. A non-zero exit is not an error here — it is
a result to assert on — so the function reads the exit code out of the
failure instead.

Next, the test's own copy of the `--json` shape. Keeping a separate copy here
is the point of a black-box test: if someone renames a key in the app, this
struct stops matching, even though no code in the test package moved.

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
// wireTask is the test's own copy of the --json contract: the seven keys
// ...
type wireTask struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Status   string     `json:"status"`
	Priority int        `json:"priority"`
	Due      *time.Time `json:"due"`
	Tags     []string   `json:"tags"`
	Version  int        `json:"version"`
}
```

The struct mirrors the format the app writes, field for field.

Now the tests. The round trip is the flow a script cannot write: take the id
`add` printed, feed it to `done`, and read the stored state back.
`t.TempDir()` gives each test its own folder for the database, and
`t.Parallel()` lets the tests share the one built binary without waiting in
line.

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
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
```

The test parses the printed id, hands it to `done`, and checks the human
`list`. The second half of the same test reads the machine format, where the
status and the version number can be compared exactly:

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
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
```

`done` bumps the stored version to 2, and the test pins that number. Dates
get their own test, because time does not stand still. `add --due tomorrow`
sends the word; the answer must be the day after today — whichever side of
midnight the clock is on. So the test computes the answer on both sides of
the run and accepts either:

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
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
```

Either answer is accepted, so the test cannot fail just because midnight
passed between the two calls.

Finally, the exit contract in ten lines:

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
func TestBinary_ErrorExit(t *testing.T) {
	t.Parallel()

	env := binaryEnv(filepath.Join(t.TempDir(), "todo.db"))

	res := runBinary(t, env, "done", "not-a-uuid")
	assert.Equal(t, 1, res.code, "a bad id is a failure")
	assert.Empty(t, res.stdout, "the error goes to stderr, not stdout")
	assert.Contains(t, res.stderr, `invalid id "not-a-uuid"`)
}
```

Exit code 1, nothing on stdout, the message on stderr — the same shape the
scripts asserted, now pinned to the exact number.

## Measure what the runs touched

The last test asks a question you may have had while reading: the binary was
built with `-cover`, so what did those runs actually touch? The flag makes
every package count the lines it executes and write the counts, when the
process ends, to the folder named by `GOCOVERDIR`. The test opens the same
way its siblings do, sets `GOCOVERDIR` to a folder of its own, runs three
ordinary commands, then asks the toolchain to read it:

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
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
```

Three separate processes wrote into one folder; `covdata` merges everything
it finds and reports coverage per package. The test skips with a message if
the tool is missing, rather than failing — a toolchain without `covdata` is a
missing feature, not a broken app.

<!-- verify: cmd/todo/integration_test.go at=cli-tests -->
```go title="cmd/todo/integration_test.go"
	for _, pkg := range []string{"todo/cmd/todo", "todo/internal/cli"} {
		re := regexp.MustCompile(regexp.QuoteMeta(pkg) + `\s+coverage: ([\d.]+)% of statements`)
		m := re.FindStringSubmatch(string(out))
		require.NotNil(t, m, "no coverage line for %s:\n%s", pkg, out)
		pct, err := strconv.ParseFloat(m[1], 64)
		require.NoError(t, err)
		assert.Positive(t, pct, "%s ran no statements", pkg)
	}
}
```

The tail requires a positive percentage for the program's own package and
for `internal/cli`: proof that those numbers came from runs of the real
program, not from the test process.

## Run the suite

Everything is in place: the two test files, the four scripts, and the split
in `main`. Run the package:

<!-- transcripts: authored -->
```bash
$ go test ./cmd/todo
missing go.sum entry for module providing package golang.org/x/tools/txtar (imported by github.com/rogpeppe/go-internal/txtar); to add:
	go get github.com/rogpeppe/go-internal/txtar@v1.13.1
```

The module's list is the first thing to object, and it objects before any
code compiles. The test files import the testscript package, and the module
does not name it directly yet — it sits in the list only because another test
tool dragged it in. The run stops on the missing module: testscript reaches
`golang.org/x/tools/txtar`, and `go.sum` holds no checksum for it. The `go get`
line the message prints is pinned to the old version; the commands below ask
for the current version instead:

```bash
$ go get github.com/rogpeppe/go-internal@latest
$ go mod tidy
```

Now the module names the test driver in its first block — the packages the
app and its tests ask for directly:

<!-- verify: go.mod at=cli-tests -->
```text title="go.mod"
require (
	github.com/gkampitakis/go-snaps v0.5.23
	github.com/google/go-cmp v0.7.0
	github.com/google/uuid v1.6.0
	github.com/pressly/goose/v3 v3.29.0
	github.com/rogpeppe/go-internal v1.16.0
	...
)
```

Run the scripts on their own with verbose output — `go test -count=1 -v -run
TestScripts ./cmd/todo` — and testscript prints a report per scenario: the
environment, every command, and the output it matched. Trimmed to one script:

```text
=== RUN   TestScripts
=== RUN   TestScripts/add_list
...
=== NAME  TestScripts/add_list
    testscript.go:609: WORK=$WORK
        ...
        > exec todo add 'buy milk'
        [stdout]
        01a1377c-8457-7a92-ba59-050bdd615f04
        > stdout '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        > exec todo list
        [stdout]
        01a1377c-8457-7a92-ba59-050bdd615f04  Todo  buy milk
        ...
--- PASS: TestScripts (0.00s)
    --- PASS: TestScripts/errors (0.02s)
    --- PASS: TestScripts/import (0.02s)
    --- PASS: TestScripts/add_list (0.02s)
    --- PASS: TestScripts/json (0.02s)
PASS
ok  	todo/cmd/todo	0.451s
```

Then the Go tests — `go test -count=1 -v -run TestBinary ./cmd/todo` — which
end with the coverage report from inside the run:

```text
=== RUN   TestBinary_RoundTrip
=== PAUSE TestBinary_RoundTrip
=== RUN   TestBinary_AddDueTomorrow
=== PAUSE TestBinary_AddDueTomorrow
...
--- PASS: TestBinary_ErrorExit (0.01s)
--- PASS: TestBinary_AddDueTomorrow (0.01s)
--- PASS: TestBinary_RoundTrip (0.03s)
=== NAME  TestBinary_Coverage
    integration_test.go:188: go tool covdata percent:
        	todo/cmd/todo		coverage: 71.4% of statements
        	todo/internal/cli		coverage: 48.9% of statements
        	todo/internal/config		coverage: 33.3% of statements
        	todo/internal/db		coverage: 32.7% of statements
        	todo/internal/store		coverage: 19.4% of statements
        	todo/internal/task		coverage: 20.0% of statements
--- PASS: TestBinary_Coverage (0.07s)
PASS
ok  	todo/cmd/todo	0.473s
```

Read the coverage table slowly, because it is the whole point. The binary is
the test subject, and yet `internal/store` — a package the test file never
imports — reports 19.4%: those statements ran inside the three processes the
test started, and `-cover` instruments every package in the program. The
percentage is not a grade; it is a trace of what actually ran.

And the whole module, one last time:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.716s
ok  	todo/internal/cli	0.074s
ok  	todo/internal/config	0.004s
ok  	todo/internal/db	0.277s
ok  	todo/internal/store	2.405s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.005s
```

Every package passes. The new tests add well under a second, because the
binary is built once and shared — and the new dependency never reaches the
shipped program, because only files whose names end in `_test.go` import it.

## Watch the numbers move

The report the test printed is a snapshot of three commands. You can watch
the same mechanism by hand: build a copy of the program with the measuring
flag on — `go build -cover -o todo-cover ./cmd/todo` — point `GOCOVERDIR` at
a scratch folder, and run ordinary commands. Every process leaves its own
counter file:

```bash
$ export GOCOVERDIR=$PWD/coverdir TODO_DB=$PWD/session.db TODO_LOG=$PWD/session.log
$ ./todo-cover add "buy milk"
01a1377f-6756-71a5-86e9-8d3bdd37c3e4
$ ./todo-cover add "write the book"
01a1377f-675a-722e-9c26-f5cf9a587fc0
$ ./todo-cover add "ship it"
01a1377f-675e-791c-9a77-d5f709cc3c69
$ id=$(./todo-cover list --json | head -1 | sed 's/.*"id":"\([^"]*\)".*/\1/')
$ ./todo-cover done "$id"
$ ./todo-cover list
01a1377f-6756-71a5-86e9-8d3bdd37c3e4  Done  buy milk
01a1377f-675a-722e-9c26-f5cf9a587fc0  Todo  write the book
01a1377f-675e-791c-9a77-d5f709cc3c69  Todo  ship it
$ ./todo-cover stats
Total:   3
Done:    1
Pending: 2
$ ls coverdir
covcounters.8a8a696f987eb098c12bd19f5c4cf1b7.3439168.1791932458838295698
covcounters.8a8a696f987eb098c12bd19f5c4cf1b7.3439179.1791932458842413973
...
covmeta.8a8a696f987eb098c12bd19f5c4cf1b7
$ go tool covdata percent -i=coverdir
	todo/cmd/todo		coverage: 71.4% of statements
	todo/internal/cli		coverage: 64.7% of statements
	todo/internal/config		coverage: 33.3% of statements
	todo/internal/db		coverage: 34.7% of statements
	todo/internal/store		coverage: 20.5% of statements
	todo/internal/task		coverage: 20.0% of statements
```

The fourth command uses a shell tool to pull the first task's id out of the
JSON and hand it to `done`. Seven commands, seven counter files, one meta
file describing the build. The final
report is higher than the test's for `internal/cli` — 64.7% against 48.9% —
because this session ran the `--json` and `done` paths the test's three
commands never touched. That is the honest shape of runtime coverage: the
number measures what ran.

## If something went wrong

**`accepts 1 arg(s), received 2`.** A script line written the way a shell
would accept it:

```text
> exec todo add buy milk
[stderr]
accepts 1 arg(s), received 2
[exit status 1]
FAIL: testdata/script/add_list.txtar:6: unexpected command failure
```

testscript is not a shell: it splits a command line on spaces and honors
single quotes, so `add` received two arguments where it accepts exactly one.
Quote the argument, as every script above does, and the same for any other
value with spaces.

**`unknown command "//"`.** The comment habit from Go. testscript's comment
character is `#`; anything else on its own line is taken as a command name:

```text
> // cache probe
FAIL: testdata/script/add_list.txtar:18: unknown command "//"
```

Write `#` for comments; the message names the file and the line, so the fix
is quick to spot.

**`config: log path: neither $XDG_STATE_HOME nor $HOME names an absolute
directory`.** The app resolves the log path eagerly, so a run with the
database pinned but no log path refuses to start:

```bash
$ env -i PATH="$PATH" TODO_DB=$PWD/bare/todo.db ./todo list
config: log path: neither $XDG_STATE_HOME nor $HOME names an absolute directory
$ echo $?
1
```

The fix is to pin `TODO_LOG` too — which is what `binaryEnv` does. And mind
the inverse: a test that inherits your real `HOME` would pass while proving
nothing about the bare case, which is why the environment is passed
explicitly.

**`failed to create cache dir` before any script code runs.** Without the
`Setup` line in `TestScripts`, the first open of every script fails in the
engine's library loader, before any CLI code runs: `failed to create cache
dir '/no-home/.cache/turso-go/fb4685f8' for library extraction: mkdir
/no-home: permission denied`.

testscript runs scripts under `HOME=/no-home`, an unwritable path, so the
extraction falls back to a folder that cannot be created. Pointing
`TURSO_GO_CACHE_DIR` at the script's work folder is the fix, and it is
already in the file above.

**`warning: GOCOVERDIR not set, no coverage data emitted`.** The binary was
built with `-cover`, so every run wants somewhere to write its counts; this
one had none:

```bash
$ ./todo-cover add x
warning: GOCOVERDIR not set, no coverage data emitted
01a1377d-024c-7558-944b-ba6d3837f8d3
```

The command still works; only the data is lost. Export a `GOCOVERDIR` for
manual sessions. The tests never have the problem: their folders come from
`t.TempDir()` and die with the test.

**`ok todo/cmd/todo (cached)`.** Go caches successful test results and
answers with the previous verdict when nothing it can see has changed:

```bash
$ go test ./cmd/todo
ok  	todo/cmd/todo	(cached)
```

For this package a script edit does invalidate the cache — the files are part
of what Go hashes. But `(cached)` means exactly what it says: no process
started, nothing ran now. The habit from earlier tests is `-count=1`; this
package is where its absence is most convincing, because so much of the work
the `ok` line summarizes is invisible in the timings.

**`--due tomorrow` and the midnight boundary.** The expectation involves two
computations of "now": one inside the binary, one in the test. If the clock
crosses midnight between them, a test that insists on a single date fails
once a day — often enough to pass every local run and fail later. Accept
either answer, the way `TestBinary_AddDueTomorrow` does.

<details>
<summary>Going deeper: how a script runs your program</summary>

A script's `exec todo` does not start the binary `TestMain` built. It starts
the *test binary*, which testscript has copied into a folder it puts first on
`PATH`, under the name `todo`. When that copy starts and sees `os.Args[0]`
naming `todo`, `testscript.Main` matches the name against the command table
and calls the registered function instead of running tests.

Registering `main` itself is what makes the scripted command the real entry
point — the same function the shipped binary starts — with the test process
as the vehicle.

That re-execution is also why `TestMain` skips the build when it is invoked
as a command: the script's work folder is not the app's folder, so there
would be nothing to build.

The older shape of this pattern had each command return its exit code, in a
table typed `map[string]func() int`, passed to a function called `RunMain`.
The package's authors retired it, and an older example will show you the
call they warn about:

```text
cmd/todo/main_test.go:48:10: SA1019: github.com/rogpeppe/go-internal/testscript.RunMain is deprecated: use [Main], as the only reason for returning exit codes was to collect full code coverage, which Go does automatically now: https://go.dev/blog/integration-test-coverage (staticcheck)
```

Our table uses `Main` with a `func()` command, which is why `main` can exit
with `run`'s code itself.

</details>

<details>
<summary>Going deeper: how coverage crosses the process boundary</summary>

`go build -cover` instruments every package in the main module — not just
`package main` — so the built program carries a counter for each statement.
When the program runs and `GOCOVERDIR` names a folder, each process writes
one counter file into it, named by the build's id, the process id, and the
start time, plus one meta file on the first run describing the instrumented
code. `go tool covdata` treats the folder as one dataset: `percent` merges
every counter file it finds and reports per-package statement coverage.

That is why `internal/store` appears in the report even though the test file
never imports it: the three commands ran its code inside real processes, and
the counters traveled out through the folder. The numbers move with the
commands run — the longer session above reaches further into `internal/cli`
than the test's three commands do — which is the honest shape of runtime
coverage: it measures what executed.

</details>

<details>
<summary>Going deeper: what this suite deliberately leaves alone</summary>

The in-process tests still own the details: the exact padded table rows, the
JSON keys, the error text. Those tests run in milliseconds and can reach
states a real process cannot, like a store that refuses to open.

This suite only owns the process seam: that the program builds, starts,
exits with the right code, keeps its streams in order, and resolves its
paths from a bare environment. Where a script's check could become a format
pin — the full padded row instead of `Todo  buy milk` — it stays shape-level
on purpose. Duplicating the exact bytes here would buy a second copy to
maintain and a slower suite.

</details>

The program is tested as a program now, and the runs report what they
touched. Next, the app starts keeping a record of what it did: logs, written
somewhere that cannot be confused with results.

<div class="day-tracker" data-day="33"></div>
