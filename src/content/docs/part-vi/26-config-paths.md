---
title: Configuration
day: 31
time: "3 hours"
description: Let the database path come from a flag, an environment variable, or a sensible default instead of living in the code.
sidebar:
  order: 26
---

The app's database is called `todo.db`, and that name is written into the
program. It opens relative to the folder you run the command from, so the same
command run from two folders can find two different databases — or none at all.

Configuration is the settings an app needs to run: the values that change from
one machine, or one run, to the next. Ours has two — where the database lives,
and where logs will someday live — and this chapter turns both from a constant
into a decision.

The decision gets three sources and one order: a `--db` flag beats an
environment variable, which beats a sensible default. When it works, the same
built program can use any database you point it at.

## One setting, three sources

The sources differ in how far they reach. A flag is one run:
`todo --db /tmp/work.db list` uses that file for that command only. An
environment variable is one shell or one machine: `TODO_DB=/tmp/work.db` in
front of a command — or exported once in your shell — tells every run in that
shell where the database is. A default is everyone: when nothing is set, the
app picks a standard place.

When more than one source is set, the narrower one wins. The flag beats the
environment, and the environment beats the default; the more specifically you
said something, the more you meant it.

The default follows the XDG base directory convention, a rule most Linux
programs follow for the files they own. User data — files worth keeping, like
our tasks — lives under `$XDG_DATA_HOME`, which defaults to `~/.local/share`.
So the database's default is `$XDG_DATA_HOME/todo/todo.db`, or
`$HOME/.local/share/todo/todo.db` when the variable is unset.

Logs are not data; they are state, notes that survive between runs, and state
lives under `$XDG_STATE_HOME` (`~/.local/state`). The log path defaults to
`$XDG_STATE_HOME/todo/logs/todo.log`. Nothing writes that file yet — the path
is resolved now so the logging setup later has it ready.

One rule keeps the sources reading alike: an empty value counts as not set.
`--db ""` falls through to the environment exactly like a flag you never
passed. The standard environment lookup `os.Getenv` cannot tell "unset" from
"set to empty", so the flag adopts the same convention.

The XDG convention adds one more rule: its variables must name absolute paths.
A relative value like `relative/data` is invalid, and we treat it like an
unset one.

## The test comes first

The resolution is a small piece of logic with a lot of cases — three sources,
two paths, empty values falling through — which makes it a natural table test.
It belongs in a package of its own, `internal/config`, so the command tree can
call it by name. Create the folder `internal/config` and, inside it, a file
called `config_test.go`. The finished app's appendix holds this file in full —
read the parts behind the `...` there as you type them.

The file opens with a helper. `Load`, the function we're about to write, will
take the environment as a parameter: a function that looks up a name and
returns its value. Production passes `os.Getenv`; the tests pass this adapter
over a plain map.

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
package config_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/config"
)

// getenvFrom adapts a map to the getenv seam Load takes. Production passes
// os.Getenv; the tests pass this, so every case is a plain map — no process
// environment is read or written, and the cases can run in parallel.
func getenvFrom(env map[string]string) func(string) string {
	return func(key string) string { return env[key] }
}
```

That parameter is the seam — the point where the test's version of the outside
world plugs in, the same idea as the store's interface. The test hands the code
a lookup it controls, so no case touches the real environment of the machine
running it, and the cases can run in parallel.

Now the table. Each row holds an environment map, the flag's value, and the
`Config` we expect back. The fixture home is `/home/user` — any path works,
because the test injects it — and every expected path below derives from it.
Here is the head and the first row:

```go title="internal/config/config_test.go"
// TestLoad is the precedence truth table: flags > environment > XDG defaults,
// with the defaults themselves pinned against an injected HOME and injected
// XDG variables. Each case is one row, and the injected getenv is the whole
// mechanism — nothing here depends on the machine's environment.
func TestLoad(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		env    map[string]string
		dbFlag string
		want   config.Config
	}{
		{
			name: "the defaults follow HOME when no XDG variable is set",
			env:  map[string]string{"HOME": "/home/user"},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
			},
		},
```

The first row is the simplest world: only `HOME` is set, and both paths land in
their `.local` defaults. The rest of the table walks up the ladder — the XDG
variables replacing the `HOME` fallback, `TODO_DB` and `TODO_LOG` overriding
both, an empty flag falling through. Two rows are worth looking at closely:

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
		{
			name: "a non-empty flag beats TODO_DB",
			env: map[string]string{
				"HOME":    "/home/user",
				"TODO_DB": "/tmp/env.db",
			},
			dbFlag: "/tmp/flag.db",
			want: config.Config{
				DBPath:  "/tmp/flag.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
			},
		},
		// ...
		{
			name: "a relative XDG_DATA_HOME is ignored, as the spec says",
			env: map[string]string{
				"HOME":          "/home/user",
				"XDG_DATA_HOME": "relative/data",
			},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
			},
		},
```

The first of those rows pins the top of the ladder: with both the flag and
`TODO_DB` set, the flag wins. The second pins the XDG rule from a moment ago:
`relative/data` is not absolute, so it is ignored and the `HOME` default wins.
Ten rows in all, and every one is data — nothing reads the machine's
environment.

The loop runs every row as a subtest:

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := config.Load(getenvFrom(tt.env), tt.dbFlag)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}
```

And one more test covers the failure: a default that needs `HOME` and finds
none must return an error, not a half-built path.

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
// TestLoad_NoHome pins the error path: a default that needs HOME and finds
// neither HOME nor an XDG variable is an error, not a half-built relative
// path, and no partial config comes back.
func TestLoad_NoHome(t *testing.T) {
	t.Parallel()

	got, err := config.Load(getenvFrom(nil), "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "HOME")
	assert.Empty(t, got)
}
```

The test asks for a resolution with no environment at all and pins two things:
the error names `HOME`, and no partial config comes back.

## The CLI tests learn about the opener

The command tree is about to change shape. Until now, `New` took a store and
the tests handed it a memory store. But the store cannot exist before the path
is known, and the path is not known until the flags are parsed — so the tree
will take a way to build the store, and call it at the right moment. The tests
move first. The finished app's appendix holds the whole test file in full —
read the parts behind the `...` there as you type them.

Their fake is an **opener**: a function that records the path it was asked to
open and returns the store the test seeded.

<!-- verify: internal/cli/cli_test.go at=config -->
```go title="internal/cli/cli_test.go"
// opener is a fake OpenFunc: it records every path the tree resolves, hands
// the commands the store the test seeded, and counts the cleanup runs. The
// precedence tests assert on the recorded path, so no database file has to
// exist anywhere for them.
type opener struct {
	store store.Store
	err   error

	paths    []string
	cleanups int
}

// open matches cli.OpenFunc.
func (o *opener) open(_ context.Context, dbPath string) (store.Store, func() error, error) {
	o.paths = append(o.paths, dbPath)
	if o.err != nil {
		return nil, nil, o.err
	}
	return o.store, func() error {
		o.cleanups++
		return nil
	}, nil
}

// The fake and the production opener are the same seam: if OpenFunc's
// signature moves, this line stops compiling.
var _ cli.OpenFunc = (&opener{}).open
```

The fake never opens anything. It appends the path to a list, returns the
memory store, and counts how many times its cleanup ran. The
`var _ cli.OpenFunc = (&opener{}).open` line is a promise to the compiler: if
the real type ever changes shape, this file stops building and names every test
to fix.

The old `runCLI` helper built the tree around a store. Now it builds one around
the fake opener, and keeps its old signature as a wrapper, so the existing
tests don't move:

<!-- verify: internal/cli/cli_test.go at=config -->
```go title="internal/cli/cli_test.go"
// runCLIWith is the test seam. New takes the opener and the writers, so
// exercising the CLI is an ordinary function call: build a fresh tree around
// o, point it at the arguments, run it, and hand back everything it printed.
// No process, no os.Stdout, no package-level state between cases.
func runCLIWith(t *testing.T, o *opener, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	root := cli.New(o.open, &out, &errOut)
	root.SetArgs(args)
	err = root.ExecuteContext(context.Background())
	return out.String(), errOut.String(), err
}

// runCLI runs one command against a fresh tree over st.
func runCLI(t *testing.T, st store.Store, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	return runCLIWith(t, &opener{store: st}, args...)
}
```

Then a new test drives the whole chain — flag parser, resolution, opener —
through the real command tree:

<!-- verify: internal/cli/cli_test.go at=config -->
```go title="internal/cli/cli_test.go"
// TestDBPathPrecedence drives the resolution end-to-end through SetArgs: the
// --db flag beats TODO_DB, TODO_DB beats the XDG default, and an empty flag
// falls through to the next source. The opener records the path it would
// have opened, so each case asserts the resolved path without a database
// existing. The test is not parallel: t.Setenv writes the process
// environment, and Go forbids that next to t.Parallel.
func TestDBPathPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	t.Run("the flag beats the environment", func(t *testing.T) {
		t.Setenv("TODO_DB", filepath.Join(home, "env.db"))
		flag := filepath.Join(home, "flag.db")

		o := &opener{store: store.NewMemoryStore()}
		_, _, err := runCLIWith(t, o, "--db", flag, "list")
		require.NoError(t, err)
		assert.Equal(t, []string{flag}, o.paths)
	})
	// ...
	t.Run("an empty flag falls through to the environment", func(t *testing.T) {
		env := filepath.Join(home, "env.db")
		t.Setenv("TODO_DB", env)

		o := &opener{store: store.NewMemoryStore()}
		_, _, err := runCLIWith(t, o, "--db", "", "list")
		require.NoError(t, err)
		assert.Equal(t, []string{env}, o.paths)
	})
}
```

Each subtest sets an environment variable for the test's duration with
`t.Setenv`, runs one command, and checks the single path the opener recorded.
The test is not parallel, and that is the point: `t.Setenv` writes the process
environment, and Go forbids that next to `t.Parallel`.

Two more tests pin the store's life: one open per command, and the cleanup runs
when the command finishes.

<!-- verify: internal/cli/cli_test.go at=config -->
```go title="internal/cli/cli_test.go"
// TestRun_OpensResolvedPathAndCleansUp pins the other half of the seam: the
// commands' store comes from the opener — the path is resolved, not
// hard-coded — and the cleanup the opener returned runs when the command
// finishes.
func TestRun_OpensResolvedPathAndCleansUp(t *testing.T) {
	t.Setenv("TODO_DB", filepath.Join(t.TempDir(), "todo.db"))

	st := store.NewMemoryStore()
	o := &opener{store: st}
	out, _, err := runCLIWith(t, o, "add", "buy milk")
	require.NoError(t, err)
	assert.Len(t, o.paths, 1, "one command opens the store once")
	assert.Equal(t, 1, o.cleanups, "the cleanup runs when the command finishes")

	list, err := st.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1, "the command wrote through the opened store")
	assert.Equal(t, list[0].ID.String()+"\n", out)
}
```

And a store that refuses to open stops the command before its body runs:

<!-- verify: internal/cli/cli_test.go at=config -->
```go title="internal/cli/cli_test.go"
// TestRun_OpenError pins that a store that cannot be opened stops the
// command before its body runs.
func TestRun_OpenError(t *testing.T) {
	t.Parallel()

	o := &opener{err: errors.New("disk on fire")}
	_, _, err := runCLIWith(t, o, "list")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "disk on fire")
}
```

One last test guards the quiet. The app installs goose's silent logger when it
applies migrations — a library opening a database is not worth printing about —
and this test keeps it that way: it runs the real opener and the real store, and
checks that nothing reached stderr or Go's standard log output.

<!-- verify: internal/cli/cli_test.go at=config -->
```go title="internal/cli/cli_test.go"
func TestRun_RealStoreIsQuiet(t *testing.T) {
	var noise bytes.Buffer
	log.SetOutput(&noise)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })

	dir := t.TempDir()
	open := func(ctx context.Context, dbPath string) (store.Store, func() error, error) {
		st, err := store.NewTursoStore(ctx, dbPath)
		if err != nil {
			return nil, nil, err
		}
		return st, st.Close, nil
	}

	var out, errOut bytes.Buffer
	root := cli.New(open, &out, &errOut)
	root.SetArgs([]string{"--db", filepath.Join(dir, "todo.db"), "add", "buy milk"})
	require.NoError(t, root.ExecuteContext(context.Background()))

	assert.NotEmpty(t, out.String(), "add printed the id")
	assert.Empty(t, errOut.String(), "cobra's stderr stays clean")
	assert.Empty(t, noise.String(), "the store's open is silent on stderr")
}
```

The test is sequential because `log`'s output is process-global, and it uses
the real store so that an open which starts printing again fails it right
away. The file's imports also gain `errors` and `log`.

## Watch it fail

Both test files are in place, and neither package has the code they describe.
Run everything:

```bash
$ go test -count=1 ./...
todo/internal/config: no non-test Go files in …/internal/config
# todo/internal/cli_test [todo/internal/cli.test]
internal/cli/cli_test.go:48:11: undefined: cli.OpenFunc
internal/cli/cli_test.go:57:18: cannot use o.open (value of type func(_ context.Context, dbPath string) ("todo/internal/store".Store, func() error, error)) as "todo/internal/store".Store value in argument to cli.New: func(_ context.Context, dbPath string) ("todo/internal/store".Store, func() error, error) does not implement "todo/internal/store".Store (missing method Add)
internal/cli/cli_test.go:175:18: cannot use open (variable of type func(ctx context.Context, dbPath string) ("todo/internal/store".Store, func() error, error)) as "todo/internal/store".Store value in argument to cli.New: func(ctx context.Context, dbPath string) ("todo/internal/store".Store, func() error, error) does not implement "todo/internal/store".Store (missing method Add)
?   	todo/cmd/todo	[no test files]
FAIL	todo/internal/cli [build failed]
FAIL	todo/internal/config [build failed]
ok  	todo/internal/db	0.017s
ok  	todo/internal/store	0.086s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.003s
FAIL
```

Two failures, two stories. `todo/internal/config: no non-test Go files` means
the folder holds only a test — there is no package to build yet. The CLI errors
are the compiler pointing at the seam: `undefined: cli.OpenFunc` says the type
does not exist, and the long lines say a function is being handed to `New`
where a store is expected. `missing method Add` is the compiler's way of
showing that the function is not a store: it has none of the store's methods.
Your line numbers will differ; the shapes will not.

The rest of the output is the other packages still passing, and
`[no test files]` for `cmd/todo`, which has no tests of its own.

## The resolver

Now the code the tests describe. Create `internal/config/config.go`. The
finished app's appendix holds this file in full; the pieces quoted here are
the ones that carry the idea. It opens with the package comment, two imports,
and the `Config` type — the pair of resolved paths:

<!-- verify: internal/config/config.go at=config -->
```go title="internal/config/config.go"
// Package config resolves the application's runtime configuration: where the
// SQLite database lives and where the log file will live. Resolution is a
// pure function of an injected environment lookup and the command line's
// --db value, so every precedence case is a table test and nothing here
// touches os.Getenv or the filesystem itself.
package config

import (
	"fmt"
	"path/filepath"
)

// Config is the resolved runtime configuration.
type Config struct {
	// DBPath is where the SQLite database lives.
	DBPath string
	// ...
	LogPath string
}
```

The constants name every variable the resolution reads, once, so no string is
typed twice:

<!-- verify: internal/config/config.go at=config -->
```go title="internal/config/config.go"
// The environment variables the resolution reads, spelled once. An empty
// value means "not set": os.Getenv cannot tell unset from set-to-empty, and
// treating both as absent is the convention the flag follows too.
const (
	envDB  = "TODO_DB"
	envLog = "TODO_LOG"
)

// The XDG base-directory variables the defaults fall back through. DATA
// holds the database because it is user data; STATE holds the logs because
// ...
const (
	xdgDataHome  = "XDG_DATA_HOME"
	xdgStateHome = "XDG_STATE_HOME"
)
```

`Load` is the whole rule, written as two ladders — one for the database, one
for the log. Each rung asks whether the previous one came back empty:

<!-- verify: internal/config/config.go at=config -->
```go title="internal/config/config.go"
// Load resolves the configuration with the precedence flags > environment >
// XDG defaults:
//
//   - DBPath: a non-empty dbFlag, else $TODO_DB, else
//     $XDG_DATA_HOME/todo/todo.db, else $HOME/.local/share/todo/todo.db;
//   - LogPath: $TODO_LOG, else $XDG_STATE_HOME/todo/logs/todo.log, else
//     $HOME/.local/state/todo/logs/todo.log.
//
// getenv is the environment seam: production passes os.Getenv and tests pass
// a map lookup, so no case needs the process environment. A default that
// needs HOME — because no XDG variable and no environment override supplied
// the path — is an error rather than a half-built relative path.
func Load(getenv func(string) string, dbFlag string) (Config, error) {
	dbPath := dbFlag
	if dbPath == "" {
		dbPath = getenv(envDB)
	}
	if dbPath == "" {
		var err error
		dbPath, err = xdgDefault(getenv, xdgDataHome, filepath.Join(".local", "share"), filepath.Join("todo", "todo.db"))
		if err != nil {
			return Config{}, fmt.Errorf("config: database path: %w", err)
		}
	}

	logPath := getenv(envLog)
	if logPath == "" {
		var err error
		logPath, err = xdgDefault(getenv, xdgStateHome, filepath.Join(".local", "state"), filepath.Join("todo", "logs", "todo.log"))
		if err != nil {
			return Config{}, fmt.Errorf("config: log path: %w", err)
		}
	}

	return Config{DBPath: dbPath, LogPath: logPath}, nil
}
```

Read the database ladder: start with the flag's value; if it is empty, ask the
environment; if that is empty too, build the default. The log ladder skips the
flag — there is no `--log` flag — and starts at `$TODO_LOG`. Each failure is
wrapped with the path it belongs to, so a bare environment reports
`config: database path: ...` and names what was missing.

The helper that builds defaults is where the XDG rules live, so the two paths
cannot drift apart:

<!-- verify: internal/config/config.go at=config -->
```go title="internal/config/config.go"
// xdgDefault resolves one file below an XDG base directory: $name joined
// with fileRel when the environment sets it to an absolute path,
// $HOME/homeRel/fileRel otherwise. A relative $name is invalid per the XDG
// spec and is ignored like an unset variable; the error names what was
// missing so a bare environment fails with a reason, not with a path rooted
// in the working directory.
func xdgDefault(getenv func(string) string, name, homeRel, fileRel string) (string, error) {
	if base := getenv(name); base != "" && filepath.IsAbs(base) {
		return filepath.Join(base, fileRel), nil
	}
	home := getenv("HOME")
	if home == "" {
		return "", fmt.Errorf("neither $%s nor $HOME names an absolute directory", name)
	}
	return filepath.Join(home, homeRel, fileRel), nil
}
```

`xdgDefault` takes the variable's name, the folder to use under `HOME`, and the
file to place inside it. If the variable is set to an absolute path, that path
wins. Otherwise it falls back to `HOME` — and with no `HOME` either, it returns
an error instead of a relative path. A database nobody can find later is worse
than a first run that refuses to guess. Notice what this file never does: touch
the disk. `Load` returns strings; making a path real is the opener's job.

## The opener seam

One wrinkle remains. The store cannot be built until the path is resolved, the
path cannot be resolved until the flags are parsed, and the command tree is
what parses them. So the tree cannot receive a store; it must receive a way to
build one.

`internal/cli` gains a type and a small session:

<!-- verify: internal/cli/cli.go at=config -->
```go title="internal/cli/cli.go"
// OpenFunc creates the store at the resolved path; the returned cleanup runs
// when the command finishes.
type OpenFunc func(ctx context.Context, dbPath string) (store.Store, func() error, error)

// session is the state the commands share: the store the pre-run opened and
// the cleanup the post-run will call. One session per New call, reached
// through a pointer, so nothing about a run lives in a package global.
type session struct {
	store   store.Store
	cleanup func() error
}

// close runs the session's cleanup at most once. The post-run calls it after
// a successful command; nil-ing the field first makes a second call — the
// same tree executed twice — a no-op instead of a double close.
func (s *session) close() error {
	if s.cleanup == nil {
		return nil
	}
	cleanup := s.cleanup
	s.cleanup = nil
	return cleanup()
}
```

`OpenFunc` is the shape of an opener: given a context and a resolved path, it
returns a store, a cleanup function, and an error. The session holds what one
run needs — the store the pre-run opened, and the cleanup the post-run will
call — and `close` runs that cleanup at most once. Clearing the field first
means even a second call cannot close the store twice.

`New` takes the opener instead of the store, and keeps the flag beside it:

<!-- verify: internal/cli/cli.go at=config -->
```go title="internal/cli/cli.go"
// New builds the todo command tree around an opener. The store is not passed
// in: the tree resolves the database path at run time — the persistent --db
// flag over $TODO_DB over the XDG default — and hands the resolved path to
// open, which builds the store the commands then share. Output goes to out
// and errOut so tests can capture it.
func New(open OpenFunc, out, errOut io.Writer) *cobra.Command {
	var (
		dbFlag string
		sess   session
	)
	root := &cobra.Command{
		Use:   "todo",
```

The flag is declared on the root command and inherited by every command. Its
help text states the precedence, because an empty value means fall through, not
open the empty path:

<!-- verify: internal/cli/cli.go at=config -->
```go title="internal/cli/cli.go"
	// The flag's help states the precedence, because the flag is the top of
	// it: an empty value means "fall through to the environment", not
	// "open the empty path".
	root.PersistentFlags().StringVar(&dbFlag, "db", "",
		"path to the Turso database; overrides $TODO_DB and the XDG default")
```

Cobra calls a hook — a function it runs at a fixed moment in a command's life.
The resolution and the open happen in the pre-run hook, before any command body
runs; the cleanup happens in the post-run hook, after a command succeeds. The
appendix holds this file in full — the lines behind the `...` are there as you
type them:

<!-- verify: internal/cli/cli.go at=config -->
```go title="internal/cli/cli.go"
		// The pre-run hook is inherited by every command that executes, so
		// the resolution and the open happen once per run, before any
		// command body touches the store. config.Load is the precedence
		// rule; the opener is the seam that turns the resolved path into a
		// store, and it receives the resolved path, never the flag alone.
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load(os.Getenv, dbFlag)
			if err != nil {
				return err
			}
			st, cleanup, err := open(cmd.Context(), cfg.DBPath)
			if err != nil {
				return err
			}
			sess.store, sess.cleanup = st, cleanup
			return nil
		},
		// ...
		PersistentPostRunE: func(*cobra.Command, []string) error {
			return sess.close()
		},
```

`config.Load` gets `os.Getenv` — the one place in the whole program that reads
the process environment — and the opener gets the resolved path. The commands
see neither the flag nor the environment; they see the store the session holds.

That leaves one mechanical change through the file. Each command constructor
takes `sess *session` instead of a store, and every store call gains the
session in front of it — `s.Add(...)` becomes `sess.store.Add(...)`. The
registrations change too:

<!-- verify: internal/cli/cli.go at=config -->
```go title="internal/cli/cli.go"
	root.AddCommand(
		newAddCmd(&sess),
		newListCmd(&sess),
		newDoneCmd(&sess),
		newStatsCmd(&sess),
		newImportCmd(&sess),
	)
```

The import list also gains `todo/internal/config`.

## Main becomes wiring

`cmd/todo/main.go` gets simpler. The store's handle has one owner now — the
session — so `main` stops opening the store and stops closing it. It hands the
tree the real opener and lets the tree do the work. The finished app's appendix
holds this file in full — the lines behind the `...` are there as you type
them:

<!-- verify: cmd/todo/main.go at=config -->
```go title="cmd/todo/main.go"
func main() {
	// ...
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The CLI owns the store's lifecycle now: it resolves the path, calls
	// openStore, and runs the returned cleanup when the command finishes.
	// ...
	root := cli.New(openStore, os.Stdout, os.Stderr)
	if err := root.ExecuteContext(ctx); err != nil {
		// ...
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
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
```

The file's imports gain `path/filepath`, which `openStore` uses to find the
path's parent.

`openStore` is the production `OpenFunc`, and it does the two things the tests'
fake does not: it creates the parent folder of the resolved path — `0o700`
means readable and writable by you alone — and it opens the real Turso store.
The engine creates the database file but never the folders around it — and the
XDG default nests `todo/` under `$XDG_DATA_HOME`, which a fresh account does
not have. The store's `Close` is the cleanup the session will run.

The `defer st.Close()` that used to sit in `main` is gone with it. Keeping it
would give one handle two owners. A second close does not fail loudly —
`database/sql` quietly returns no error — and that quietness is exactly why it
is worth removing: the program would be correct by an accident of the library
instead of by its own rule.

## Run it green

Run everything again:

```bash
$ go test -count=1 ./...
?   	todo/cmd/todo	[no test files]
ok  	todo/internal/cli	0.012s
ok  	todo/internal/config	0.004s
ok  	todo/internal/db	0.017s
ok  	todo/internal/store	0.078s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
```

Every package passes. The ten precedence rows, the four end-to-end cases, the
lifecycle pair, and the quiet test all passed on the first run.

## Watch it choose a database

Build the program the way you have before —
`CGO_ENABLED=0 go build -o ./todo ./cmd/todo` — then copy the `todo` file
into an empty scratch folder and run it from there.
Start with the default, giving the run its own XDG data folder so the
experiment cannot touch your real one:

```bash
$ XDG_DATA_HOME=$PWD/xdg-data ./todo add "buy milk" --tag home 2>err.txt
01a13757-7367-7054-89aa-743a3cf2ec9e
$ wc -c < err.txt
0
$ XDG_DATA_HOME=$PWD/xdg-data ./todo list
01a13757-7367-7054-89aa-743a3cf2ec9e  [Todo] buy milk (tags: home)
```

The `add` printed the new task's id, the `list` found it, and `wc -c` reports
zero bytes in `err.txt`: the open printed nothing at all. The database landed
where the default says:

```bash
$ find xdg-data -type f
xdg-data/todo/todo.db
```

Your `find` will also list `todo.db-log` and `todo.db-wal`, the database's
`-log` and `-wal` sidecars.

`TODO_DB` selects a different database, and the list proves it — the task from
the default store is not there:

```bash
$ TODO_DB=$PWD/env.db ./todo add "write the book" --priority 5
01a13757-7374-76a8-9cc6-67daa2109cca
$ TODO_DB=$PWD/env.db ./todo list
01a13757-7374-76a8-9cc6-67daa2109cca  [Todo] write the book
```

The flag selects a third database, and when both are set, the flag wins:

```bash
$ ./todo --db $PWD/flag.db add "ship it"
01a13757-7380-7025-9031-a01a9f0ac4f3
$ TODO_DB=$PWD/env.db ./todo --db $PWD/flag.db list
01a13757-7380-7025-9031-a01a9f0ac4f3  [Todo] ship it
```

Three files, three stores, one rule: each source selected its own path, and
the flag had the last word.

The help states the rule too. The flag appears on the root command:

```bash
$ ./todo --help
todo keeps a task list in a local Turso database.
...
Flags:
      --db string   path to the Turso database; overrides $TODO_DB and the XDG default
  -h, --help        help for todo
```

And every leaf inherits it without any code of its own — `todo add --help`
prints its own flags and then:

```bash
$ ./todo add --help | tail -3

Global Flags:
      --db string   path to the Turso database; overrides $TODO_DB and the XDG default
```

`add` never declares `--db`, yet it accepts the flag: the root declared it as
persistent, so every command carries it. Finally, the case with nothing to
fall back on. With neither `HOME` nor the XDG variable set, the app refuses to
guess:

```bash
$ env -u HOME -u XDG_DATA_HOME ./todo list
config: database path: neither $XDG_DATA_HOME nor $HOME names an absolute directory
$ echo $?
1
```

One line, one exit code: the error names the variable that was missing.

## If something went wrong

**`entity not found` when the database's folder does not exist.** The engine
creates the database file, but it never creates folders. Point `--db` into a
path whose parent is missing and the open fails with:

<!-- transcripts: authored -->
```bash
open turso store /tmp/…/nested/todo.db: enable mvcc: turso: error: I/O error (open): entity not found
```

The fix is in `openStore`: `os.MkdirAll(filepath.Dir(dbPath), 0o700)` creates
the parent before the store opens. If you see this, your opener is missing that
line — the XDG default needs it, because a fresh account has no `todo/` folder
under `$XDG_DATA_HOME`.

**A relative `XDG_DATA_HOME` seems ignored.** It is, on purpose. The convention
requires absolute paths, so a relative value falls through to `HOME` exactly
like an unset one:

```bash
$ HOME=$PWD/home XDG_DATA_HOME=relative/data ./todo add "buy milk"
01a13c33-40c5-76f3-81f8-176423a758fa
$ find . -type f
./home/.cache/turso-go/fb4685f8/libturso_sync_sdk_kit.so
./home/.local/share/todo/todo.db-log
./home/.local/share/todo/todo.db-wal
./home/.local/share/todo/todo.db
./todo
```

The database landed under `home/.local/share/todo/` — the `HOME` default —
while `relative/data` was never created. This is the rule doing its job. A
database rooted in whichever folder you happened to run from is a file you
could never find again; use an absolute path.

**The store gets closed twice.** Nothing crashes. `database/sql`'s second
`Close` returns no error, which makes the mistake quiet:

```bash
first close: <nil>
second close: <nil>
```

If you left the old `defer st.Close()` in `main` alongside the session's
cleanup, remove the defer. One handle, one owner: the opener returns the
store's `Close`, the tree runs it once, and `session.close` clears it first so
even a second execution of the same tree cannot repeat it.

**`unknown flag: --db`.** You added the flag, but the store still opens in
`main` before the command tree runs, so the parser never sees `--db`. The fix
is the seam itself: resolve the path and open the store in the pre-run hook,
after parsing — the only moment the flag, the environment, and the default are
all known.

<details>
<summary>Going deeper: what is XDG?</summary>

XDG is a convention, not a program: a short specification that says where
desktop programs should keep their files. It defines four variables, one per
purpose — `XDG_DATA_HOME` for user data worth keeping, `XDG_STATE_HOME` for
state that survives between runs, `XDG_CONFIG_HOME` for settings files, and
`XDG_CACHE_HOME` for data that can always be regenerated.

Ours uses two of them, for reasons that are really promises. The database is
user data — losing it means losing work — so DATA. A log is the textbook
example of state, so STATE. CONFIG is deliberately not consulted: the app has
no settings file, and resolving a path nothing reads would be a promise the
code does not keep. CACHE stays empty for the same reason.

Each variable has a `$HOME` fallback in the spec — `.local/share`,
`.local/state`, `.config`, `.cache` — so a machine that sets none of them
behaves like one that set the defaults.

</details>

<details>
<summary>Going deeper: why `Load` takes the environment as a parameter</summary>

`Load` could have called `os.Getenv` itself. Taking it as a parameter buys
three things. The tests hand it a map and check ten environments without
touching the machine's own, which is what makes the truth table a table. The
program has exactly one place that reads the process environment — the pre-run
hook's `config.Load(os.Getenv, dbFlag)` — so it is easy to see where outside
values enter. And the resolution stays a pure function of its inputs: same
inputs, same result, no hidden state.

The alternative, a package variable read at startup, would freeze the
environment before any flag or test could influence it. A function passed in
keeps the decision at the moment of the call.

</details>

<details>
<summary>Going deeper: why the flag's path is used verbatim</summary>

Every default is built with `filepath.Join`, which tidies the pieces it is
given. The flag's value is different: it is used exactly as typed.
`--db data/todo.db` stays `data/todo.db`, relative to the folder you ran from,
because a path a person typed is a value to open, not a string to rewrite. The
table pins it in a row named "the flag's path is used verbatim".

There is a library for reading configuration from the environment,
`github.com/caarlos0/env`, and reaching for it was tempting. It parses typed
fields — durations, lists — which would earn its keep the day the configuration
grows those. For two string paths with fallbacks, it would add a dependency and
a layer without removing a line of logic, so the lookups stay hand-written.

</details>

The database path is a decision now, and the app resolves it before anything
else runs. Next, the output becomes a decision too: `list` and `stats` learn
formats — a table for people, JSON for programs.
