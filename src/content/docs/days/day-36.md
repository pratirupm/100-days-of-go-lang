---
title: "Day 36 — The first API endpoint"
sidebar:
  order: 36
chapter: 30
---

**About 3 hours** · Part VII, day 1 of 6.

**You'll be able to:**

- serve the first HTTP endpoints with echo: liveness and readiness;
- shut the server down gracefully, and test it black-box.

---

The app has been a program you run: type a command, read the answer, done. Now
it becomes a program that waits — one that keeps running and answers questions
from other programs.

The questions travel over a network, and the convention for asking them is
called **HTTP**. A question is a **request**; the answer is a **response**. By
the end of this page the todo app will answer two of them — "are you running?"
and "can you do your job?" — and stop politely when it's asked to.

Everything we've built comes along: the same store, the same configuration,
the same logs. The command-line app keeps working too. This is a second
program in the same project.

## A question and an answer

When your browser loads a page, it sends a **request** to a program somewhere
— a **server** — and the server sends back a **response**. That's HTTP: a
request is a question, a response is the answer, and both are just text with a
shape everyone agrees on.

A request names an address and a **method** — what kind of question it is.
`GET` means "tell me about this"; it's the method a browser uses to load a
page. A response carries a **status code**, a number that says how it went,
and usually a body: the text of the answer, often in JSON, the curly-brace
format from the output work.

An **endpoint** is one address a server answers at, together with the job it
does there. Our first two are `/healthz` and `/ready`. The addresses are short
on purpose: the server's job is to answer questions, and the address says
which question.

An address like `127.0.0.1:8080` has two parts. `127.0.0.1` is **loopback** —
the name a machine uses for itself, the machine talking to itself. `8080` is
the **port**, the number that names one program among the many running on a
machine. A server **binds** an address: it claims the port and starts
listening there.

The tool we'll use to ask questions by hand is `curl`. It sends one request
and prints the response exactly as it arrives: the status line, a few
**headers** (small labels about the response — its type, its length), a blank
line, and the body. The status code comes first: `200` means it worked, `404`
means there is nothing at that address, and `503` means the server is running
but can't do its job right now.

## Add echo

Writing an HTTP server from scratch means parsing requests, matching
addresses, and writing well-formed responses. The standard library can do it,
but the edges are sharp. We'll use a library that does that part for us:
**echo**, a web framework for Go. A framework is a library that hands you the
shape of a program; in echo's case, that's one function per address, with the
request and the response already in hand.

Echo arrives in a moment, together with the code that uses it — and the
ordering matters in both directions. The tests we're about to write never
import echo; they talk to the package through echo's own `http.Handler` entry
point. And `go mod tidy` removes a requirement that nothing imports, so
fetching the library before its code exists would tidy itself away. The fetch
happens in the section where `internal/api/api.go` appears.

## Write the endpoint tests

Create a folder `internal/api`: ours alone, because it sits under `internal`,
and named for what it is — the app's HTTP surface. Inside it, create
`api_test.go`. It opens with the package, the imports, and a note about how
the tests run:

<!-- verify: internal/api/api_test.go at=api-skeleton -->
```go title="internal/api/api_test.go"
// Package api_test exercises the HTTP surface through echo's own ServeHTTP
// entry point — no sockets for the endpoint cases — and once through a real
// listener for the lifecycle, which is a property of Start and Shutdown
// rather than of any handler.
package api_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/api"
	"todo/internal/store"
)
```

The package is `api_test`, a test-only package like the one we built for the
config. The imports say what the file will reach for: the real API package,
the store, the test toolkit, and Go's own helpers for testing HTTP without a
network. The comment above the package states the file's shape — the endpoint
cases never open a socket, and the lifecycle case gets a real listener.

Next comes the marker that generates the store's mock for this package, a
logger that throws its records away, and the helper every case shares:

<!-- verify: internal/api/api_test.go at=api-skeleton -->
```go title="internal/api/api_test.go"
// The store package's own mock, store_moq_test.go, is a test file of package
// store: it exists only inside store's test binary, so no other package can
// import it. This package generates its own mock of the same interface with
// the same pinned moq version — same generator, one interface, two test
// binaries.
//
//go:generate go run github.com/matryer/moq@v0.8.0 -out store_moq_test.go -pkg api_test ../store Store

// ...
func discardLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// get drives one request through the handler without a socket and returns
// the recorded response.
func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}
```

The `//go:generate` line is the marker we've used before: it names the
generator, the interface to mock, and the output file. Running `go generate
./internal/api` writes `store_moq_test.go` into this folder — a fresh mock of
`store.Store`, usable only inside `internal/api`'s tests. `discardLogger`
builds a logger that throws its records away; nothing under test logs yet, so
the logger exists only because `New` will ask for one.

The generated file opens by saying so:

<!-- verify: internal/api/store_moq_test.go at=api-skeleton -->
```go title="internal/api/store_moq_test.go"
// Code generated by moq; DO NOT EDIT.
// github.com/matryer/moq

package api_test
```

Its lines are the generator's, not yours. Leave the file alone, and regenerate
it if the store's interface ever changes.

`get` is the interesting half. `ServeHTTP` is the exact function a real
network listener calls when a request arrives — the same routing, the same
handlers — with the socket left out. `httptest.NewRequest` builds the request
and the recorder captures the response, so an endpoint case is a plain
function call: no port to pick, nothing to wait for.

Then liveness, as a test:

<!-- verify: internal/api/api_test.go at=api-skeleton -->
```go title="internal/api/api_test.go"
// TestHealthz pins liveness: 200 and the exact JSON body. The store is a
// StoreMock with no functions configured, so every store method panics: if
// the handler touched the store at all — even to ping it — this test would
// panic instead of pass.
func TestHealthz(t *testing.T) {
	t.Parallel()

	e := api.New(&StoreMock{}, discardLogger())

	rec := get(t, e, "/healthz")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
}
```

`api.New` doesn't exist yet — that's the point of writing this first. The
store handed to it is a `StoreMock` with nothing filled in: every one of its
methods panics unless the test provides it. So if `/healthz` ever reached for
the store, this test would blow up instead of passing quietly. Liveness means
"the process is up", and touching nothing is the promise made checkable.

Readiness gets a failure case too:

<!-- verify: internal/api/api_test.go at=api-skeleton -->
```go title="internal/api/api_test.go"
	st := &StoreMock{
		StatsFunc: func(context.Context) (store.Stats, error) {
			return store.Stats{}, errors.New("database is away")
		},
	}
	e := api.New(st, discardLogger())

	rec := get(t, e, "/ready")

	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.JSONEq(t, `{"status":"unavailable"}`, rec.Body.String())
	assert.Len(t, st.StatsCalls(), 1)
	assert.NotContains(t, rec.Body.String(), "database is away")
```

Here the store's `Stats` fails — `StatsFunc` is the mock's answer for this one
case — and `/ready` must reply 503 with a fixed body. The store's own words,
`database is away`, describe the inside of the process, so the last line pins
that they never reach the client. `StatsCalls()` is the mock's log of calls:
exactly one ping, no more.

The file holds two more cases. `TestReady_OK` is the same shape with the store
answering. `TestServer_StartShutdown` gives the server a real listener and
shuts it down for real:

<!-- verify: internal/api/api_test.go at=api-skeleton -->
```go title="internal/api/api_test.go"
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	e.Listener = ln

	// Start blocks until Shutdown; the test's own goroutine stays free to
	// send the request and then ask for the shutdown. The listener is
	// already accepting, so the request cannot arrive too early.
	serveErr := make(chan error, 1)
	go func() { serveErr <- e.Start("") }()
	// ...
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, e.Shutdown(shutdownCtx))

	// Serve returns http.ErrServerClosed once a clean Shutdown has stopped
	// the listener; anything else would be a real failure.
	require.ErrorIs(t, <-serveErr, http.ErrServerClosed)
```

`127.0.0.1:0` means "any free port": the `0` asks the operating system to pick
one, so the test can't collide with a real server. The listener is handed to
echo before starting — echo's own test seam — so the test drives the real
start-and-shutdown path instead of a copy of it. The finished app's appendix
holds the whole file; the pieces above are the ones that carry the idea.

## The other two test files

The config test grows a third setting. Every row of the truth table gains a
`Listen` line, and a new table owns the flag:

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
		{
			name: "TODO_LISTEN overrides the default",
			env: map[string]string{
				"HOME":        "/home/user",
				"TODO_LISTEN": "0.0.0.0:9090",
			},
			want: config.Config{
				DBPath:  "/home/user/.local/share/todo/todo.db",
				LogPath: "/home/user/.local/state/todo/logs/todo.log",
				Listen:  "0.0.0.0:9090",
			},
		},
```

That row is the shape of all of them now: the environment can set the address
with `TODO_LISTEN`, and every expected config carries it. The new table pins
the whole rule — a flag beats the environment, which beats the default — and
these are the rows that matter:

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
func TestListen(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		env  map[string]string
		flag string
		want string
	}{
		{
			name: "nothing set gets the loopback default",
			want: config.DefaultListen,
		},
		// ...
		{
			name: "a non-empty flag beats TODO_LISTEN",
			env:  map[string]string{"TODO_LISTEN": "0.0.0.0:9090"},
			flag: "127.0.0.1:8081",
			want: "127.0.0.1:8081",
		},
		{
			name: "an empty flag falls through to TODO_LISTEN",
			env:  map[string]string{"TODO_LISTEN": "0.0.0.0:9090"},
			flag: "",
			want: "0.0.0.0:9090",
		},
```

Each row runs through the same loop as before, with `config.Listen` in place
of `config.Load`:

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tt.want, config.Listen(getenvFrom(tt.env), tt.flag))
		})
	}
}
```

One case per row, all in parallel — the same loop that walks every other
table in the project. Now the server's own test. Create
`cmd/todo-server/integration_test.go`:

<!-- verify: cmd/todo-server/integration_test.go at=api-skeleton -->
```go title="cmd/todo-server/integration_test.go"
// The black-box test: the real server binary TestMain built, run through
// exec.Command with a deliberately bare environment. testscript cannot
// background a long-running server — its scripts run commands to completion —
// so this package drives the process directly: start, poll, signal, wait,
// the way a service manager would.
package main
```

A **black-box test** looks at a program from the outside, the way a user
would: it builds the real binary and drives it as a process, not as functions.
The scripts we've used for the command-line app run one command to completion
and can't keep a server alive while another command talks to it, so this test
does the work by hand. Here is its start, its signal, and its final checks:

<!-- verify: cmd/todo-server/integration_test.go at=api-skeleton -->
```go title="cmd/todo-server/integration_test.go"
	cmd := exec.Command(binPath, "--listen", addr)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"TODO_DB=" + filepath.Join(dir, "todo.db"),
		"TODO_LOG=" + filepath.Join(dir, "todo.log"),
	}
	// ...
	require.NoError(t, cmd.Process.Signal(syscall.SIGTERM))
	// ...
	assert.Empty(t, stdout.String(), "a server's stdout is data, and it serves data over HTTP")
	assert.Contains(t, stderr.String(), `"msg":"server listening"`)
	assert.Contains(t, stderr.String(), `"msg":"shutting down"`)
	assert.Contains(t, stderr.String(), `"msg":"server stopped"`)
```

The environment is deliberately bare: `PATH` so the process can start, and the
two variables that pin the database and the log file. `HOME` is absent on
purpose — with those two set, the server must not need it.

The test waits for `/healthz` to answer, sends SIGTERM, and checks the result.
SIGTERM is a message from the operating system asking a program to stop — the
signal a service manager sends. The assertions are the contract: exit cleanly,
print nothing on stdout, and record the three lifecycle events on stderr and
in the log file.

## Watch it fail

All four test files are in place — `api_test.go`, the generated mock, the
config table, and the black-box test — and none of the code they describe
exists. Run everything:

```bash
$ go test -count=1 ./...
todo/internal/api: no non-test Go files in …/internal/api
# todo/internal/config_test [todo/internal/config.test]
internal/config/config_test.go:40:5: unknown field Listen in struct literal of type config.Config
internal/config/config_test.go:40:21: undefined: config.DefaultListen
internal/config/config_test.go:53:5: unknown field Listen in struct literal of type config.Config
internal/config/config_test.go:53:21: undefined: config.DefaultListen
internal/config/config_test.go:65:5: unknown field Listen in struct literal of type config.Config
internal/config/config_test.go:65:21: undefined: config.DefaultListen
internal/config/config_test.go:78:5: unknown field Listen in struct literal of type config.Config
internal/config/config_test.go:78:21: undefined: config.DefaultListen
internal/config/config_test.go:90:5: unknown field Listen in struct literal of type config.Config
internal/config/config_test.go:102:21: undefined: config.DefaultListen
internal/config/config_test.go:102:21: too many errors
ok  	todo/cmd/todo	0.457s
todo/cmd/todo-server: no non-test Go files in …/cmd/todo-server
build test binary: exit status 1
FAIL	todo/cmd/todo-server	0.025s
FAIL	todo/internal/api [build failed]
ok  	todo/internal/cli	0.011s
FAIL	todo/internal/config [build failed]
ok  	todo/internal/db	0.016s
ok  	todo/internal/logging	0.003s
ok  	todo/internal/store	0.107s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
FAIL
```

Read the three failures in order. `no non-test Go files in …/internal/api`
means the folder holds only tests — there is no package for them to test yet.
The config errors are the compiler meeting `Listen` and `config.DefaultListen`
for the first time; it gives up after five rows, which is as far as it gets.
And `todo/cmd/todo-server: no non-test Go files` is the black-box test
reporting that the binary it exists to build has no code yet. Your line
numbers will differ; the shapes will not.

## The API package

Create `internal/api/api.go`. It opens with the package comment, the imports,
and nothing else:

<!-- verify: internal/api/api.go at=api-skeleton -->
```go title="internal/api/api.go"
// Package api is the application's HTTP surface. New builds an echo server
// around the store and the process logger: liveness and readiness endpoints
// ...
package api

import (
	"log/slog"
	"net/http"

	"github.com/labstack/echo/v4"

	"todo/internal/store"
)
```

The imports name what the file leans on: the standard library's `net/http`
for the status codes, echo itself, and the store. `New` builds the server
around its two dependencies — the store and the logger — and registers the
endpoints:

<!-- verify: internal/api/api.go at=api-skeleton -->
```go title="internal/api/api.go"
func New(st store.Store, logger *slog.Logger) *echo.Echo {
	s := &server{store: st, logger: logger}

	e := echo.New()
	e.GET("/healthz", s.healthz)
	e.GET("/ready", s.ready)

	// ...
	e.Group("/api/v1")

	// ...
	e.HideBanner = true
	e.HidePort = true

	return e
}
```

`echo.New()` builds an empty server. Each `e.GET(...)` line says: when a `GET`
request arrives for this address, call this handler. A **handler** is the
function that answers one request. The handler's shape is echo's:
`func(c echo.Context) error` — the context carries the request and the
response, and the returned error is how a handler hands trouble back to echo.

`e.Group("/api/v1")` registers nothing by itself; it pins a prefix that the
task routes will hang off soon. `HideBanner` and `HidePort` are there because
of the rule from the logging work: stdout carries data, stderr carries notes.
Echo, left alone, prints a banner and a startup line on stdout — a server's
stdout carries no data, so both prints are hidden and the process announces
itself with its own record instead.

The handlers are five lines each, and the asymmetry between them is the
design:

<!-- verify: internal/api/api.go at=api-skeleton -->
```go title="internal/api/api.go"
// ...
type server struct {
	store  store.Store
	logger *slog.Logger
}

// healthz answers liveness with a fixed body and touches nothing else.
func (s *server) healthz(c echo.Context) error {
	return c.JSON(http.StatusOK, statusBody("ok"))
}

// ready answers readiness by pinging the store. A store error is 503, not
// 500: the process is fine, its dependency is not. The store's error is not
// echoed to the client — it would leak internals — and it is not logged yet;
// ...
func (s *server) ready(c echo.Context) error {
	if _, err := s.store.Stats(c.Request().Context()); err != nil {
		return c.JSON(http.StatusServiceUnavailable, statusBody("unavailable"))
	}
	return c.JSON(http.StatusOK, statusBody("ok"))
}

// statusBody is the one-key JSON body the health endpoints share.
func statusBody(status string) map[string]string {
	return map[string]string{"status": status}
}
```

The `server` struct carries the store and the logger to the handlers. Nothing
is a package-level variable, so the API's dependencies are visible in one
place. `healthz` answers with a fixed body and never looks at the store.

`ready` looks at nothing else: it asks the store one question with `Stats`,
and a failure becomes 503 — "not right now" — rather than 500, "the server is
broken". `c.JSON` writes the status code and turns the map into JSON. The
store call takes `c.Request().Context()`, the request's own cancellation, so a
client that walks away stops the work it started.

With the code in place, fetch the library from the app's root folder:

<!-- transcripts: authored -->
```bash
$ go get github.com/labstack/echo/v4@v4.16.0
$ go mod tidy
```

On its first run, `go get` prints a few `go: downloading` lines while it
fetches the library; `go mod tidy` then fills in the checksums and marks
echo's own dependencies as indirect — eight small modules we never call
directly. The relevant part of `go.mod` now reads:

<!-- verify: go.mod at=api-skeleton -->
```text title="go.mod"
require (
	github.com/gkampitakis/go-snaps v0.5.23
	...
	github.com/labstack/echo/v4 v4.16.0
	...
)
```

The first `require` block lists echo at v4.16.0, beside the libraries we
already had.

## The listen address

The server needs to know where to listen. That's a third setting in
`internal/config`, resolved by the same rule as the other two. First the
field, and the variable that can set it:

<!-- verify: internal/config/config.go at=api-skeleton -->
```go title="internal/config/config.go"
// Config is the resolved runtime configuration.
type Config struct {
	// DBPath is where the Turso database lives.
	DBPath string
	// ...
	LogPath string
	// Listen is the HTTP server's bind address. The CLI never reads it; the
	// server binary resolves its --listen flag on top with Listen.
	Listen string
}

// The environment variables the resolution reads, spelled once. An empty
// value means "not set": os.Getenv cannot tell unset from set-to-empty, and
// treating both as absent is the convention the flag follows too.
const (
	envDB     = "TODO_DB"
	envLog    = "TODO_LOG"
	envListen = "TODO_LISTEN"
)
```

The new field joins the other two, and `TODO_LISTEN` joins the variables the
resolution reads — an empty value still means "not set". Then the default —
loopback, so a freshly started server is reachable by its owner and not by
the network until the owner says otherwise — and the one function that
resolves the rule:

<!-- verify: internal/config/config.go at=api-skeleton -->
```go title="internal/config/config.go"
// DefaultListen is the address the server binds when neither the flag nor
// the environment says otherwise. Loopback: a freshly started server is
// reachable by its owner, not by the network, until the owner says so.
const DefaultListen = "127.0.0.1:8080"
```

Every resolution that finds no flag and no variable ends up here. `Listen`
lives beside `Load`, and `Load` calls it for the configuration it returns;
the server binary calls it again with its own `--listen` flag, which `Load`
cannot see:

<!-- verify: internal/config/config.go at=api-skeleton -->
```go title="internal/config/config.go"
	return Config{DBPath: dbPath, LogPath: logPath, Listen: Listen(getenv, "")}, nil
}

// Listen resolves the HTTP server's listen address: a non-empty flag beats
// $TODO_LISTEN, which beats DefaultListen. Load resolves the same rule for
// the configuration it returns; the server binary calls Listen itself with
// its --listen flag, which Load cannot see. An empty flag and an empty
// environment value both mean "not set", the convention every other setting
// follows.
func Listen(getenv func(string) string, flag string) string {
	if flag != "" {
		return flag
	}
	if listen := getenv(envListen); listen != "" {
		return listen
	}
	return DefaultListen
}
```

One rule, one function, two callers: the rule can't drift between the
configuration and the flag. The flag's value is used exactly as typed, because
the address is the listener's business — a bad address gets a better complaint
from the network layer than we could write here.

## The server binary

Now the program itself. Create the folder `cmd/todo-server`, and inside it
`main.go`. A module can hold more than one program; `cmd/todo` is the command,
and this is the server, sharing the store, the configuration, and the logging
setup. It opens with the package comment and its imports:

<!-- verify: cmd/todo-server/main.go at=api-skeleton -->
```go title="cmd/todo-server/main.go"
// Command todo-server is the todo application's HTTP server: the wiring
// around internal/api — configuration, the process logger, the store's
// lifecycle, signals, and the exit code. The routes live in internal/api.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/term"

	"todo/internal/api"
	"todo/internal/config"
	"todo/internal/logging"
	"todo/internal/store"
)
```

`main` is one line — the process's only job is to exit with the code `run`
returns — and `run` starts by arranging to hear a stop signal:

<!-- verify: cmd/todo-server/main.go at=api-skeleton -->
```go title="cmd/todo-server/main.go"
// main is the process's only job: exit with run's code.
func main() {
	os.Exit(run())
}

// run starts the server and returns the process's exit code: 0 after a clean
// shutdown, 1 after printing the one error line. It reads os.Args and writes
// to os.Stderr, so the real binary and the integration test run the same
// function.
func run() int {
	// A first interrupt or SIGTERM cancels ctx: the server then stops
	// accepting and drains within shutdownTimeout. stop unregisters the
	// handler; main's os.Exit skips the defer, but the process is leaving
	// anyway.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// ...
```

`signal.NotifyContext` returns a context that is canceled when the process
receives an interrupt (Ctrl-C) or SIGTERM. The rest of `run` uses that context
as its "please stop" switch.

Next the flag, the configuration, and the logger. The server has exactly one
flag, so it uses the standard library's flag package — the command tree's
cobra stays with the command tree:

<!-- verify: cmd/todo-server/main.go at=api-skeleton -->
```go title="cmd/todo-server/main.go"
	// The server has exactly one flag, so the stdlib flag package is
	// enough; cobra stays where the command tree is. A parse error exits 2
	// with the usage, the convention Go's own tools follow.
	listenFlag := flag.String("listen", "", "listen address; overrides $TODO_LISTEN and the 127.0.0.1:8080 default")
	flag.Parse()

	cfg, err := config.Load(os.Getenv, "")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// The --listen flag is the last word, resolved through the same rule
	// the environment and the default went through.
	cfg.Listen = config.Listen(os.Getenv, *listenFlag)
```

`config.Load` resolves the database path, the log path, and the address from
the environment and the defaults; `config.Listen` then applies the flag on
top. Every failure prints one line to stderr and returns 1 — the same shape
the command-line app uses.

Then the logger, the store, and the API, each one construction:

<!-- verify: cmd/todo-server/main.go at=api-skeleton -->
```go title="cmd/todo-server/main.go"
	// The TTY decision belongs here, where the real stderr is: a terminal
	// gets tint's human-readable records, anything else JSON. The file sink
	// is JSON either way.
	isTTY := term.IsTerminal(int(os.Stderr.Fd()))
	logger, closer, err := logging.New(os.Stderr, isTTY, cfg.LogPath, slog.LevelInfo)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() {
		// ...
		_ = closer.Close()
	}()

	// A canceled boot aborts before serving: NewTursoStore applies the
	// embedded migrations under ctx, so a signal during startup stops there.
	st, err := store.NewTursoStore(ctx, cfg.DBPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	e := api.New(st, logger)
```

The logger is the same one the command builds: a terminal gets human-readable
records, anything else JSON, and the log file is written either way. The store
is opened under the signal context, so a stop during startup aborts before the
server begins serving. And the API is one call — the whole HTTP surface,
built around the store and the logger.

Then the lifecycle — the part that makes a server a server:

<!-- verify: cmd/todo-server/main.go at=api-skeleton -->
```go title="cmd/todo-server/main.go"
	// Start blocks until the server stops, so it runs in its own goroutine
	// and the main goroutine stays free to receive the signal. The channel
	// carries a failure out: Start returns immediately when it cannot bind,
	// and without the select the process would wait for a signal it can
	// never serve.
	logger.Info("server listening", "addr", cfg.Listen)
	serveErr := make(chan error, 1)
	go func() { serveErr <- e.Start(cfg.Listen) }()

	select {
	case <-ctx.Done():
		logger.Info("shutting down")
	case err := <-serveErr:
		// Start failed before any signal arrived: the address is taken or
		// otherwise unusable. ErrServerClosed cannot happen here — nothing
		// has called Shutdown yet.
		if !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
```

`e.Start` doesn't return until the server stops, so it runs beside the main
flow, in a goroutine; the main flow has to stay free to hear the signal. The
`select` waits on two things at once: the context, which fires when we're
asked to stop, and the error channel, which fires when `Start` itself fails.
That second branch matters: a server that can't claim its port fails
immediately, and without it the program would sit waiting for a signal it can
never serve.

The signal has arrived, so it's time to stop — carefully:

<!-- verify: cmd/todo-server/main.go at=api-skeleton -->
```go title="cmd/todo-server/main.go"
	// Shutdown stops accepting, then waits — up to shutdownTimeout — for
	// in-flight requests to finish. A request that outlives the timeout is
	// cut off rather than holding the process open forever.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := e.Shutdown(shutdownCtx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	logger.Info("server stopped")

	// The store closes last: requests still in flight during Shutdown may
	// have been reading from it.
	if err := st.Close(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
```

`Shutdown` is a graceful stop: it stops accepting new requests, then waits for
the ones already in flight to finish. The wait is bounded by a context, so one
stalled client can't hold the process open forever — the timeout cuts it off.
The store closes last, after the drain, because requests finishing during the
shutdown may still be reading from it. This is the same timeout the file
defines above `run`:

<!-- verify: cmd/todo-server/main.go at=api-skeleton -->
```go title="cmd/todo-server/main.go"
// shutdownTimeout bounds how long Shutdown waits for in-flight requests
// before giving up. Five seconds is honest for now — nothing this server
// ...
const shutdownTimeout = 5 * time.Second
```

Five seconds is the whole budget: enough for the requests this server serves,
and not long enough to hang forever behind one stalled client.

## Make it pass

The code exists now, so the tests can meet it. The API package first:

```bash
$ go test -count=1 -v ./internal/api
=== RUN   TestHealthz
=== PAUSE TestHealthz
=== RUN   TestReady_OK
=== PAUSE TestReady_OK
=== RUN   TestReady_StoreDown
=== PAUSE TestReady_StoreDown
=== RUN   TestServer_StartShutdown
=== PAUSE TestServer_StartShutdown
=== CONT  TestHealthz
=== CONT  TestReady_StoreDown
--- PASS: TestHealthz (0.00s)
=== CONT  TestReady_OK
--- PASS: TestReady_StoreDown (0.00s)
=== CONT  TestServer_StartShutdown
--- PASS: TestReady_OK (0.00s)
--- PASS: TestServer_StartShutdown (0.00s)
PASS
ok  	todo/internal/api	0.004s
```

Four tests, four passes. The interleaved `PAUSE` and `CONT` lines are the test
runner juggling parallel tests; the `PASS` lines are the ones that matter. The
config tables pass the same way — every row of both, the flag's precedence
included. Then the black-box test, which builds and drives the real binary:

```bash
$ go test -count=1 -v ./cmd/todo-server
=== RUN   TestServer_Lifecycle
=== PAUSE TestServer_Lifecycle
=== CONT  TestServer_Lifecycle
--- PASS: TestServer_Lifecycle (0.03s)
PASS
ok  	todo/cmd/todo-server	0.518s
```

That `PASS` is a real process — built, started, asked, and stopped — not a
function call. And the whole module:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.602s
ok  	todo/cmd/todo-server	0.583s
ok  	todo/internal/api	0.005s
ok  	todo/internal/cli	0.020s
ok  	todo/internal/config	0.005s
ok  	todo/internal/db	0.023s
ok  	todo/internal/logging	0.005s
ok  	todo/internal/store	0.097s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.006s
```

Every package passes, and the server package's line is the one that matters
most: a real process started, answered, and stopped, with its records on
stderr and in the log file.

## Talk to the server

Time to ask it a question by hand. Build the server the way we built the
command — `go build -o todo-server ./cmd/todo-server` — then copy the
`todo-server` file into an empty scratch folder and run the commands from
there. Start it in the background, with a database and a log file of its own:

```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ./todo-server --listen 127.0.0.1:18080 > stdout.txt 2> stderr.txt &
$ pid=$!   # 3497036
```

The `&` runs the server in the background, and the redirections send its
stdout and stderr into files so the terminal stays free. `$!` is the shell's
name for the background process's id; the number in the comment is the one
that machine happened to get, and yours will differ. Now ask the server how it
is:

```bash
$ curl -i http://127.0.0.1:18080/healthz
HTTP/1.1 200 OK
Content-Type: application/json
Date: Wed, 14 Oct 2026 08:01:43 GMT
Content-Length: 16

{"status":"ok"}
```

Status line, headers, blank line, body: `200` and `{"status":"ok"}`. The
readiness endpoint answers the same way while the database is reachable:

```bash
$ curl -i http://127.0.0.1:18080/ready
HTTP/1.1 200 OK
Content-Type: application/json
Date: Wed, 14 Oct 2026 08:01:43 GMT
Content-Length: 16

{"status":"ok"}
```

Ask for an address that doesn't exist and echo answers for us:

```bash
$ curl -i http://127.0.0.1:18080/nope
HTTP/1.1 404 Not Found
Content-Type: application/json
Date: Wed, 14 Oct 2026 08:01:43 GMT
Content-Length: 24

{"message":"Not Found"}
```

A 404 in echo's own shape, because no handler claimed that address. Now stop
the server the way a service manager would, and look at what it left behind:

```bash
$ kill -TERM $pid; wait $pid; echo "exit: $?"
exit: 0
```

Exit code 0: the graceful path, not a crash. Its stdout is empty — a server
serves its data over HTTP, not on stdout — and its stderr holds the three
lifecycle records:

```bash
$ wc -c < stdout.txt
0
$ cat stderr.txt
{"time":"2026-10-14T13:31:43.34022358+05:30","level":"INFO","msg":"server listening","addr":"127.0.0.1:18080"}
{"time":"2026-10-14T13:31:43.361927812+05:30","level":"INFO","msg":"shutting down"}
{"time":"2026-10-14T13:31:43.362004467+05:30","level":"INFO","msg":"server stopped"}
```

The durable copy, the log file, carries the same three records:

```bash
$ cat todo.log
{"time":"2026-10-14T13:31:43.34022358+05:30","level":"INFO","msg":"server listening","addr":"127.0.0.1:18080"}
{"time":"2026-10-14T13:31:43.361927812+05:30","level":"INFO","msg":"shutting down"}
{"time":"2026-10-14T13:31:43.362004467+05:30","level":"INFO","msg":"server stopped"}
```

The process announced itself, answered questions, and went quiet in the same
shape the command-line app's records have. Nothing about the logging needed to
change to carry a server.

## If something went wrong

**`undefined: store.StoreMock`.** The mock the store package uses lives in its
own test files, and test files exist only inside the package they belong to —
so no other package can see it. The error looks like this:

```text
# todo/internal/api_test [todo/internal/api.test]
internal/api/api_test.go:40:15: undefined: store.StoreMock
FAIL	todo/internal/api [build failed]
FAIL
```

The fix is already in `api_test.go`: the `//go:generate` marker builds the
same mock from the same interface into this package's own test files. Run `go
generate ./internal/api` and the error goes away.

**Echo's banner appears on stdout.** If `HideBanner` and `HidePort` are
missing from `New`, echo prints its banner and a startup line where a server's
data is supposed to be — and the black-box test is the first to notice:

```bash
$ cat stdout.txt

   ____    __
  / __/___/ /  ___
 / _// __/ _ \/ _ \
/___/\__/_//_/\___/ v4.16.0
High performance, minimalist Go web framework
https://echo.labstack.com
____________________________________O/_______
                                    O\
⇨ http server started on 127.0.0.1:18089
```

Set both fields back to `true` in `New`. The banner is decoration; the
structured record from `main` is the announcement.

**`bind: address already in use`.** Something already holds the port — usually
an older copy of the server still running:

```bash
$ TODO_DB=b.db TODO_LOG=b.log ./todo-server --listen 127.0.0.1:18086 > b.out 2> b.err
$ echo "exit: $?"
exit: 1
$ cat b.err
{"time":"2026-10-15T03:31:41.141423701+05:30","level":"INFO","msg":"server listening","addr":"127.0.0.1:18086"}
listen tcp 127.0.0.1:18086: bind: address already in use
```

The announcement comes first because `Start` binds inside its own goroutine —
the record states the intent, the error states the truth. Stop the other copy,
or pick another port with `--listen`. Exit code 1, not a hang, is the select's
second branch doing its job.

**A bare environment refuses to start.** The server resolves the same database
and log paths as the command, so with neither the variables nor `HOME` set, it
can't choose a default:

```bash
$ env -i PATH="$PATH" ./todo-server
config: database path: neither $XDG_DATA_HOME nor $HOME names an absolute directory
$ echo "exit: $?"
exit: 1
```

Set `TODO_DB` and `TODO_LOG`, as the black-box test does, and the server
starts. The error names the variable it looked for; that's the configuration
work paying off.

<details>
<summary>Going deeper: what the status numbers mean</summary>

Every response opens with a three-digit number, and the first digit says who
is at fault. `2xx` means it worked — `200 OK` is the plain yes. `4xx` means
the request was the problem: `404 Not Found` is an address the server doesn't
answer at. `5xx` means the server was the problem: `500 Internal Server Error`
is a bug, and `503 Service Unavailable` is "not right now".

`/ready` answers 503, not 500, on purpose. The process is fine; the database
is not. A 500 would tell the tools watching the server that the server itself
is broken — and they would respond by restarting a program that is working
fine.

</details>

<details>
<summary>Going deeper: liveness, readiness, and the programs that ask</summary>

A service manager is a program that keeps other programs running: it starts
them, watches them, restarts them when they die, and asks before sending work
their way. It asks `/healthz` to decide "is this process alive?" — and that
answer must not depend on the database. If liveness checked the database, a
brief database hiccup would make the manager kill and restart a perfectly
healthy process, turning a small problem into a bigger one.

`/ready` answers a different question: "should work be sent here right now?"
It does check the database, and a load balancer — the thing that spreads
requests across copies of a server — reads the answer before choosing one.
Two questions, two endpoints, on purpose.

</details>

<details>
<summary>Going deeper: why echo, and what the dependency costs</summary>

Go's own toolkit can serve these two endpoints; the standard library has a
router and a way to stop a server cleanly. Echo brings the parts we'll want as
the API grows: reading request bodies into structs, validation, middleware
(code that wraps every request), one place for error handling, and helpers for
serving files and documentation.

The cost is stated plainly: one dependency, seven small modules it brings
along, and a server binary a few megabytes larger than the command's. That's
the trade — less plumbing now, one library to keep updated later.

</details>

The app listens now. Next it learns to answer for its tasks — the routes that
hang off `/api/v1`.

<div class="day-tracker" data-day="36"></div>
