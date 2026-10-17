---
title: "cmd/todo-server — the finished app"
description: "The finished app, file by file: cmd/todo-server (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `cmd/todo-server/backup_test.go`

````go
// The backup job's contract: deploy/todo-backup.sh runs against a live
// server's database — while the sidecar log holds everything the .db file
// does not — and the copy it writes opens in a scratch store with the tasks
// the server held. The restore is the assertion that matters: a copy that
// lost the sidecars opens perfectly well and holds nothing, so "it opened"
// is not the test.
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
)

// backupScript is the job the timer runs, as this package's directory sees
// it.
const backupScript = "../../deploy/todo-backup.sh"

// buildCLI builds the todo CLI — the script's verification tool — into dir
// and returns its path.
func buildCLI(t *testing.T, dir string) string {
	t.Helper()

	bin := filepath.Join(dir, "todo")
	// #nosec G204 -- the command is a literal; only the output path, chosen
	// by the test, varies.
	cmd := exec.Command("go", "build", "-o", bin, "todo/cmd/todo")
	cmd.Stderr = os.Stderr
	require.NoError(t, cmd.Run(), "build the todo CLI")
	return bin
}

// TestBackupScript_Restores runs the backup job the way the timer does —
// against a server that is up and holding its database open — and restores
// the copy into a scratch store: the copy must open and hold the tasks that
// were created through the API, which live in the sidecar log until a
// checkpoint folds them into the .db file.
func TestBackupScript_Restores(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr

	// A user and two tasks, through the real routes: rows the .db file
	// alone would not have while the server runs.
	resp := postJSON(t, base+"/api/v1/auth/register", `{"email":"backup@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	var registered struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&registered))
	require.NoError(t, resp.Body.Close())
	owner, err := uuid.Parse(registered.ID)
	require.NoError(t, err)

	resp = postJSON(t, base+"/api/v1/auth/login", `{"email":"backup@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	cookies := resp.Cookies()
	require.NoError(t, resp.Body.Close())
	require.Len(t, cookies, 1, "login sets the session cookie")

	for _, title := range []string{"buy milk", "walk the dog"} {
		resp = postJSON(t, base+"/api/v1/tasks", `{"title":"`+title+`"}`, func(req *http.Request) {
			req.AddCookie(cookies[0])
		})
		require.Equal(t, http.StatusCreated, resp.StatusCode, "create %q", title)
		require.NoError(t, resp.Body.Close())
	}

	// The job, with the paths the unit would set: the live database, a
	// scratch backup directory, and the CLI for the verification.
	backupDir := t.TempDir()
	script := exec.Command("sh", backupScript)
	script.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"TODO_DB=" + filepath.Join(srv.dir, "todo.db"),
		"TODO_BACKUP_DIR=" + backupDir,
		"TODO_BIN=" + buildCLI(t, t.TempDir()),
	}
	out, err := script.CombinedOutput()
	require.NoError(t, err, "the backup job failed:\n%s", out)

	copies, err := filepath.Glob(filepath.Join(backupDir, "todo-*.db"))
	require.NoError(t, err)
	require.Len(t, copies, 1, "one copy per run; the directory holds:\n%s", out)

	// The verification's own open folds the sidecars into the copy: the log
	// the script copied is left truncated, so what the backup directory holds
	// is one portable file plus the empty sidecar the engine keeps. A copy
	// whose log still held bytes would mean the verification never ran.
	if info, err := os.Stat(copies[0] + "-log"); err == nil {
		assert.Zero(t, info.Size(), "the verification's open folds the log into the copy")
	}

	// The restore: the copy opened in a scratch store, scoped to the user
	// whose tasks it must hold.
	ctx := context.Background()
	restored, err := store.NewTursoStore(ctx, copies[0])
	require.NoError(t, err, "the copy opens")
	defer func() { require.NoError(t, restored.Close()) }()

	tasks, err := restored.Scoped(owner).List(ctx)
	require.NoError(t, err)
	titles := make([]string, 0, len(tasks))
	for _, task := range tasks {
		titles = append(titles, task.Title)
	}
	assert.ElementsMatch(t, []string{"buy milk", "walk the dog"}, titles,
		"the copy holds every task the live database held; stderr:\n%s", srv.stderr.String())
}
````


## `cmd/todo-server/drain_test.go`

````go
// The drain cases: chapter 48's contract for what a SIGTERM does to a
// running server. The in-flight request is held open at the transport level —
// the head and half the body arrive, so the handler parks in the body read —
// because a request that has not started cannot be in flight when the signal
// arrives, and a request that has finished proves nothing.
package main

import (
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// holdRequest opens a request that stops mid-body: the head and half the body
// are written, so the handler is inside the body read — an active request, by
// net/http's own connection accounting — when the test signals the process.
// The returned function writes the rest and reads the response, and the
// connection stays open until then, so the drain has something to wait for.
func holdRequest(t *testing.T, addr, path string, body []byte) (net.Conn, func() string) {
	t.Helper()

	conn, err := net.Dial("tcp", addr)
	require.NoError(t, err)
	half := len(body) / 2
	head := fmt.Sprintf("POST %s HTTP/1.1\r\nHost: %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
		path, addr, len(body))
	_, err = conn.Write(append([]byte(head), body[:half]...))
	require.NoError(t, err)

	// The server must have read the head before the signal: a connection it
	// has not read from is still "new" to net/http, and Shutdown closes new
	// connections as idle. The sleep is the only lever a black-box test has
	// for that state; the handler then blocks in the body read for as long
	// as the test keeps the rest unwritten.
	time.Sleep(200 * time.Millisecond)

	return conn, func() string {
		t.Helper()
		_, err := conn.Write(body[half:])
		require.NoError(t, err)
		require.NoError(t, conn.SetReadDeadline(time.Now().Add(10*time.Second)))
		raw, err := io.ReadAll(conn)
		require.NoError(t, err)
		require.NoError(t, conn.Close())
		status, _, _ := strings.Cut(string(raw), "\r\n")
		return status
	}
}

// waitForRecord polls the captured stderr for want: the lifecycle record is
// the process's own statement that the signal was received and the drain is
// under way, so a case synchronizes on it instead of sleeping.
func waitForRecord(t *testing.T, out *syncBuffer, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(out.String(), want) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no %q record; stderr:\n%s", want, out.String())
}

// TestGracefulShutdown_Drains is the chapter's drain contract, in the three
// properties a service manager depends on: a signal stops the process
// accepting while an in-flight request finishes and the process then exits
// clean; the drain budget outlasts the request deadline the stack itself
// arms, so a request the server would still have served is not cut by the
// drain; and a second signal is the operator's escape hatch when a drain
// hangs — the shape systemd's own two-stage stop has one level up.
func TestGracefulShutdown_Drains(t *testing.T) {
	t.Parallel()

	t.Run("an in-flight request completes", func(t *testing.T) {
		t.Parallel()

		srv := startServer(t)
		body := []byte(`{"email":"drain@example.com","password":"correct horse battery staple"}`)
		_, finish := holdRequest(t, srv.addr, "/api/v1/auth/register", body)

		require.NoError(t, srv.cmd.Process.Signal(syscall.SIGTERM))
		waitForRecord(t, srv.stderr, `"msg":"shutting down"`)

		// The request was in flight when the signal arrived; its body
		// finishes now, during the drain, and the response must arrive
		// whole — 201, the registration's own status.
		assert.Contains(t, finish(), "201 Created")

		select {
		case err := <-srv.wait:
			require.NoError(t, err, "a drained process exits 0; stderr:\n%s", srv.stderr.String())
		case <-time.After(10 * time.Second):
			_ = srv.cmd.Process.Kill()
			<-srv.wait
			t.Fatal("the server did not exit after the drain")
		}
	})

	t.Run("a second signal is the operator's escape hatch", func(t *testing.T) {
		t.Parallel()

		srv := startServer(t)
		body := []byte(`{"email":"stuck@example.com","password":"correct horse battery staple"}`)
		conn, _ := holdRequest(t, srv.addr, "/api/v1/auth/register", body)
		// The request never finishes; the drain has no way out on its own.
		defer func() { _ = conn.Close() }()

		require.NoError(t, srv.cmd.Process.Signal(syscall.SIGTERM))
		waitForRecord(t, srv.stderr, `"msg":"shutting down"`)

		// The first signal started a drain that will wait out the whole
		// budget for a request that is never going to finish. The second
		// signal must end the process now — and by signal, not by a clean
		// drain: the operator asked for it, and a systemd unit watching
		// the exit code must be able to tell the difference.
		require.NoError(t, srv.cmd.Process.Signal(syscall.SIGTERM))
		select {
		case <-srv.wait:
			ws, ok := srv.cmd.ProcessState.Sys().(syscall.WaitStatus)
			require.True(t, ok, "wait status")
			assert.True(t, ws.Signaled(), "the second signal must end the process, not be swallowed")
			assert.Equal(t, syscall.SIGTERM, ws.Signal())
		case <-time.After(3 * time.Second):
			_ = srv.cmd.Process.Kill()
			<-srv.wait
			t.Fatal("a second SIGTERM did not end the drain")
		}
	})

	t.Run("the drain budget outlasts the request deadline", func(t *testing.T) {
		t.Parallel()

		// internal/api arms a ten-second deadline on every request (its
		// requestTimeout); a request that was in flight when the signal
		// arrived can have that whole deadline left to run. A drain budget
		// below it cuts work the stack would still have served — and exits
		// non-zero, which a supervisor reads as a failed stop.
		assert.GreaterOrEqual(t, shutdownTimeout, 10*time.Second,
			"the drain must outlast internal/api's request deadline")
	})
}
````


## `cmd/todo-server/integration_test.go`

````go
// The black-box test: the real server binary TestMain built, run through
// exec.Command with a deliberately bare environment. testscript cannot
// background a long-running server — its scripts run commands to completion —
// so this package drives the process directly: start, poll, signal, wait,
// the way a service manager would.
package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// binPath is the server binary TestMain builds once for the tests below;
// binDir is the temporary directory holding it, removed after the suite.
var (
	binPath string
	binDir  string
)

// TestMain builds the real binary once, runs the suite, and removes the
// binary's directory. Unlike cmd/todo's, this TestMain has no testscript
// commands to register: the server is only ever exercised as a process.
func TestMain(m *testing.M) {
	if err := buildBinary(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	if binDir != "" {
		if err := os.RemoveAll(binDir); err != nil {
			fmt.Fprintln(os.Stderr, "remove test binary dir:", err)
		}
	}
	os.Exit(code)
}

// buildBinary builds the server once for the whole suite. `go test` runs
// this binary with the package directory as the working directory, so `.` is
// cmd/todo-server.
func buildBinary() error {
	dir, err := os.MkdirTemp("", "todo-server-bin-")
	if err != nil {
		return fmt.Errorf("build test binary: %w", err)
	}
	binDir = dir
	binPath = filepath.Join(dir, "todo-server")
	// #nosec G204 -- the command is a literal; only the output path, chosen
	// right here, varies.
	cmd := exec.Command("go", "build", "-o", binPath, ".")
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("build test binary: %w", err)
	}
	return nil
}

// syncBuffer is a bytes.Buffer whose writes and reads are guarded. exec's
// copying goroutines write while the test polls the process, and the race
// detector would flag an unguarded read; a plain buffer would race.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

// Write appends p, safely.
func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// String returns everything written so far, safely.
func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// serverProcess is one started server binary: the command, its address, the
// directory its files live in, its captured output, and the channel Wait's
// error arrives on.
type serverProcess struct {
	cmd    *exec.Cmd
	addr   string
	dir    string
	stdout *syncBuffer
	stderr *syncBuffer
	wait   chan error
}

// startServer starts the binary on a free port with a deliberately bare
// environment and polls liveness, so every case begins with a server that
// answers. The environment is PATH so the process starts, and the two
// variables that pin the app's paths. HOME and the XDG variables are absent
// on purpose; with TODO_DB and TODO_LOG set, and the listen address passed as
// a flag, the binary must not need either. extraEnv appends the variables a
// case is about — the admin key and the account it names — after the bare
// ones, so a case cannot lose the paths it needs.
func startServer(t *testing.T, extraEnv ...string) *serverProcess {
	t.Helper()
	dir := t.TempDir()

	// A free port: bind one, read it, release it. The release and the
	// server's bind race the rest of the machine — the kernel may hand the
	// port to someone else first — but the failure mode is loud: the server
	// exits with a bind error, and the poll below reports it.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())

	// #nosec G204 -- binPath is built by TestMain from this package's own
	// source, and the arguments are test-authored.
	cmd := exec.Command(binPath, "--listen", addr)
	cmd.Env = append([]string{
		"PATH=" + os.Getenv("PATH"),
		"TODO_DB=" + filepath.Join(dir, "todo.db"),
		"TODO_LOG=" + filepath.Join(dir, "todo.log"),
	}, extraEnv...)
	stdout, stderr := &syncBuffer{}, &syncBuffer{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	require.NoError(t, cmd.Start())

	// Wait runs in the background from here on: the poll below must notice a
	// server that died at startup instead of waiting out the deadline on a
	// corpse. Receiving from waitErr also means the process was reaped and
	// the output buffers are final, so reading them is safe.
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()

	// Poll liveness until the server answers. The first answer is normally
	// immediate; the loop exists so a slow start is a wait, not a flake.
	healthz := "http://" + addr + "/healthz"
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get(healthz) // #nosec G107 -- the URL is the test's own listener address
		if err == nil {
			require.NoError(t, resp.Body.Close())
			require.Equal(t, http.StatusOK, resp.StatusCode)
			break
		}
		select {
		case werr := <-waitErr:
			require.Failf(t, "server exited before answering /healthz", "wait: %v; stderr:\n%s", werr, stderr.String())
		case <-time.After(25 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			<-waitErr
			require.Failf(t, "no answer on /healthz", "stderr:\n%s", stderr.String())
		}
	}

	return &serverProcess{cmd: cmd, addr: addr, dir: dir, stdout: stdout, stderr: stderr, wait: waitErr}
}

// stop sends SIGTERM, the signal a service manager sends, and requires the
// process to drain and exit 0, not die by signal.
func (s *serverProcess) stop(t *testing.T) {
	t.Helper()
	require.NoError(t, s.cmd.Process.Signal(syscall.SIGTERM))
	select {
	case err := <-s.wait:
		require.NoError(t, err, "the server must exit 0 on SIGTERM; stderr:\n%s", s.stderr.String())
	case <-time.After(10 * time.Second):
		_ = s.cmd.Process.Kill()
		<-s.wait
		t.Fatal("the server did not exit after SIGTERM")
	}
}

// postJSON posts a JSON body to url and returns the response. Nothing here
// imports internal/api — the subject is the binary, exactly as a service
// manager sees it.
func postJSON(t *testing.T, url, body string, mutate func(*http.Request)) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	if mutate != nil {
		mutate(req)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return resp
}

// postForm posts an urlencoded form — the shape every page submits — and
// returns the response. The client does not follow redirects: a form's
// answer is the redirect itself, and following it would turn every status
// assertion into the target page's.
func postForm(t *testing.T, url string, values url.Values, cookies ...*http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(values.Encode()))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	resp, err := noRedirect.Do(req) // #nosec G107 -- the test's own listener address
	require.NoError(t, err)
	return resp
}

// fetchPage GETs url with the cookies presented and returns the response and
// its body. The cookie travels back by hand for the same reason as in the
// auth flow: it is marked Secure, and this is a plain-http socket. Like
// postForm, the client does not follow redirects.
func fetchPage(t *testing.T, url string, cookies ...*http.Cookie) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	resp, err := noRedirect.Do(req) // #nosec G107 -- the test's own listener address
	require.NoError(t, err)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
	return resp, string(body)
}

// noRedirect is the client the page flow drives: every page assertion is
// about the redirect itself — its 303 and its Location — so the client must
// not follow it. http.DefaultClient would follow a 303 to the target page
// and hand back its 200, which is what the first run of the process-level
// flow discovered.
var noRedirect = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// The regexps the flow reads out of a page: the token every form embeds,
// the first task row's edit link and version — the values a browser carries
// back in the row's forms — and the stylesheet's URL. templ renders
// attributes in source order.
var (
	csrfField      = regexp.MustCompile(`name="csrf_token" value="([^"]+)"`)
	editLink       = regexp.MustCompile(`href="/tasks/([0-9a-f-]+)/edit"`)
	versionField   = regexp.MustCompile(`name="version" value="(\d+)"`)
	stylesheetLink = regexp.MustCompile(`<link rel="stylesheet" href="([^"]+)">`)
)

// csrfFrom extracts the first CSRF token a page carries.
func csrfFrom(t *testing.T, body string) string {
	t.Helper()
	m := csrfField.FindStringSubmatch(body)
	require.Len(t, m, 2, "the page carries a CSRF token field")
	return m[1]
}

// firstTask extracts the id and version of the page's first task row.
func firstTask(t *testing.T, body string) (id, version string) {
	t.Helper()
	edit := editLink.FindStringSubmatch(body)
	require.Len(t, edit, 2, "the page lists a task")
	ver := versionField.FindStringSubmatch(body)
	require.Len(t, ver, 2, "the row carries the version")
	return edit[1], ver[1]
}

// sessionCookie returns the session cookie a response set, or nil when it
// set none. A cleared cookie — an empty value — names no session. The name
// is the production one, __Host- prefix included: the black-box test reads
// the cookie the way a browser would, and the prefix is part of its
// identity.
func sessionCookie(resp *http.Response) *http.Cookie {
	for _, cookie := range resp.Cookies() {
		if cookie.Name == "__Host-session" && cookie.Value != "" {
			return cookie
		}
	}
	return nil
}

// TestServer_Lifecycle is the process-level contract: the server starts,
// answers liveness, and exits 0 on SIGTERM, with structured records of the
// lifecycle on stderr and in the log file.
func TestServer_Lifecycle(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	srv.stop(t)

	// The structured record is the server's announcement: stdout stays empty
	// — chapter 29's channel rule; a server serves data over HTTP — and both
	// lifecycle events land on stderr as JSON.
	assert.Empty(t, srv.stdout.String(), "a server's stdout is data, and it serves data over HTTP")
	assert.Contains(t, srv.stderr.String(), `"msg":"server listening"`)
	assert.Contains(t, srv.stderr.String(), `"msg":"shutting down"`)
	assert.Contains(t, srv.stderr.String(), `"msg":"server stopped"`)

	// The log file is the durable half of the tee: the same records, on disk.
	logData, err := os.ReadFile(filepath.Join(srv.dir, "todo.log")) // #nosec G304 -- the test's own temp path
	require.NoError(t, err)
	assert.Contains(t, string(logData), `"msg":"server listening"`)
	assert.Contains(t, string(logData), `"msg":"server stopped"`)
}

// TestServer_IndexPage drives the web surface through the real binary: the
// page is mounted by main on the same instance the API serves, it sits
// behind the same gate, and it renders the logged-in user's tasks from the
// same store the API writes. The anonymous half is the only place a missing
// mount would show — the binary would answer 404 where the gate's redirect
// belongs — which is why this case exists at the process level: the mount is
// main's line, and nothing below main can test it. The redirect is chapter
// 37's seam: chapter 36's notes left the anonymous answer at the API's 401
// and said the login form would move it, and this is where it moved.
func TestServer_IndexPage(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr

	resp, _ := fetchPage(t, base+"/")
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
	require.Equal(t, "/login", resp.Header.Get("Location"))

	// A real session through the real login route, and a task through the
	// real API: the page reads what the API wrote.
	resp = postJSON(t, base+"/api/v1/auth/register", `{"email":"ada@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	require.NoError(t, resp.Body.Close())

	resp = postJSON(t, base+"/api/v1/auth/login", `{"email":"ada@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	cookies := resp.Cookies()
	require.NoError(t, resp.Body.Close())
	require.Len(t, cookies, 1, "login sets the session cookie")

	resp = postJSON(t, base+"/api/v1/tasks", `{"title":"buy milk"}`, func(req *http.Request) {
		req.AddCookie(cookies[0])
	})
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	require.NoError(t, resp.Body.Close())

	// The cookie travels back by hand for the same reason as in the auth
	// flow: it is marked Secure, and this is a plain-http socket.
	resp, body := fetchPage(t, base+"/", cookies[0])
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "text/html")
	assert.Contains(t, body, "<title>Tasks</title>")
	assert.Contains(t, body, "buy milk")
}

// TestServer_AuthFlow drives register, login, and logout through the real
// binary over a real socket: the chapter's whole wiring — the schema, the
// password hash, the session store, and the cookie — end to end, the way the
// TUI and the web pages will use it.
func TestServer_AuthFlow(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr + "/api/v1/auth"

	resp := postJSON(t, base+"/register", `{"email":"alice@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	require.NoError(t, resp.Body.Close())

	resp = postJSON(t, base+"/login", `{"email":"alice@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	cookies := resp.Cookies()
	require.NoError(t, resp.Body.Close())
	require.Len(t, cookies, 1, "login sets the session cookie")
	require.True(t, cookies[0].Secure)
	require.True(t, cookies[0].HttpOnly)

	// The cookie travels back by hand: it is marked Secure, and this is a
	// plain-http socket, so no cookie jar would send it — browsers and jars
	// enforce the flag, the server cannot.
	resp = postJSON(t, base+"/logout", "", func(req *http.Request) {
		req.AddCookie(cookies[0])
	})
	require.NoError(t, resp.Body.Close())
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

// TestServer_WebForms drives the chapter's whole browser-shaped flow through
// the real binary over a real socket: the anonymous redirect, the login form
// and its post, create → redirect → GET with the flash, edit, complete,
// delete, and logout — every post carrying the token the page embedded, and
// every write landing in the same store the JSON edge reads.
func TestServer_WebForms(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr

	// The API registers the account; the forms log it in.
	resp := postJSON(t, base+"/api/v1/auth/register", `{"email":"ada@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	require.NoError(t, resp.Body.Close())

	// An anonymous task page is a 303 to the login form.
	resp, _ = fetchPage(t, base+"/")
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
	require.Equal(t, "/login", resp.Header.Get("Location"))

	// The login page starts the session its token lives in.
	resp, body := fetchPage(t, base+"/login")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	cookie := sessionCookie(resp)
	require.NotNil(t, cookie, "the login page sets the session cookie")

	resp = postForm(t, base+"/login", url.Values{
		"csrf_token": {csrfFrom(t, body)},
		"email":      {"ada@example.com"},
		"password":   {"correct horse battery staple"},
	}, cookie)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
	if fresh := sessionCookie(resp); fresh != nil {
		cookie = fresh
	}

	// The redirect's target is the list, and the flash says who logged in.
	resp, body = fetchPage(t, base+"/", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body, "Logged in as ada@example.com.")

	// Create: the post is a 303, and the list shows the task and the flash.
	resp = postForm(t, base+"/tasks", url.Values{
		"csrf_token": {csrfFrom(t, body)},
		"title":      {"buy milk"},
	}, cookie)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
	require.Equal(t, "/", resp.Header.Get("Location"))

	resp, body = fetchPage(t, base+"/", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body, "Task created.")
	require.Contains(t, body, "buy milk")
	id, version := firstTask(t, body)

	// The JSON edge reads the same store the form wrote.
	resp, apiBody := fetchPage(t, base+"/api/v1/tasks", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, apiBody, "buy milk", "the forms and the API ride one store")

	// Edit: the form re-renders the stored values, and the post saves them.
	resp, body = fetchPage(t, base+"/tasks/"+id+"/edit", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body, `value="buy milk"`)

	resp = postForm(t, base+"/tasks/"+id, url.Values{
		"csrf_token": {csrfFrom(t, body)},
		"version":    {version},
		"title":      {"buy oat milk"},
		"priority":   {"5"},
		"due":        {"2026-11-01"},
		"tags":       {"errands, home"},
	}, cookie)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)

	resp, body = fetchPage(t, base+"/", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body, "Task saved.")
	require.Contains(t, body, "buy oat milk")
	require.Contains(t, body, "due 2026-11-01")
	require.Contains(t, body, "errands, home")
	id, version = firstTask(t, body)

	// Complete: the row's button is a post, and the redirect shows Done.
	resp = postForm(t, base+"/tasks/"+id+"/complete", url.Values{
		"csrf_token": {csrfFrom(t, body)},
		"version":    {version},
	}, cookie)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)

	resp, body = fetchPage(t, base+"/", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body, "Task completed.")
	require.Contains(t, body, `<span class="status">Done</span>`)
	_, version = firstTask(t, body)

	// Delete: the task goes from the page and from the API.
	resp = postForm(t, base+"/tasks/"+id+"/delete", url.Values{
		"csrf_token": {csrfFrom(t, body)},
		"version":    {version},
	}, cookie)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)

	resp, body = fetchPage(t, base+"/", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body, "Task deleted.")
	require.NotContains(t, body, "buy oat milk")

	resp, apiBody = fetchPage(t, base+"/api/v1/tasks", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.NotContains(t, apiBody, "buy oat milk")

	// Logout: the post destroys the session, the login page says so, and
	// the task pages are anonymous again.
	resp = postForm(t, base+"/logout", url.Values{"csrf_token": {csrfFrom(t, body)}}, cookie)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
	require.Equal(t, "/login", resp.Header.Get("Location"))
	if fresh := sessionCookie(resp); fresh != nil {
		cookie = fresh
	}

	resp, body = fetchPage(t, base+"/login", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body, "Logged out.")

	resp, _ = fetchPage(t, base+"/", cookie)
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
	require.Equal(t, "/login", resp.Header.Get("Location"))
}

// TestServer_WebFormsCSRF drives the refusal through the real binary: a form
// post with a live session but no token — or another token — is a 403 in the
// one error shape, and the store is untouched, which the API's own list
// confirms.
func TestServer_WebFormsCSRF(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr

	resp := postJSON(t, base+"/api/v1/auth/register", `{"email":"ada@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusCreated, resp.StatusCode)
	require.NoError(t, resp.Body.Close())

	resp = postJSON(t, base+"/api/v1/auth/login", `{"email":"ada@example.com","password":"correct horse battery staple"}`, nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	cookies := resp.Cookies()
	require.NoError(t, resp.Body.Close())
	require.Len(t, cookies, 1, "login sets the session cookie")
	cookie := cookies[0]

	// Render a page first: the session then holds a token, so both refusals
	// below are real compares, not an empty-session shortcut.
	resp, _ = fetchPage(t, base+"/", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	// No token: refused before the handler, in the house shape.
	resp = postForm(t, base+"/tasks", url.Values{"title": {"buy milk"}}, cookie)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusForbidden, resp.StatusCode)
	require.JSONEq(t, `{"code":"forbidden","message":"invalid CSRF token"}`, string(body))

	// A wrong token is the same answer.
	resp = postForm(t, base+"/tasks", url.Values{
		"csrf_token": {"not-the-session-token"},
		"title":      {"buy milk"},
	}, cookie)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusForbidden, resp.StatusCode)

	// Nothing was written: the API's own list is empty.
	resp, apiBody := fetchPage(t, base+"/api/v1/tasks", cookie)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.JSONEq(t, `{"tasks":[]}`, apiBody)
}

// TestServer_StaticAssets proves the embed travels in the binary: the
// process serves the design system's stylesheet out of its own executable —
// the temp directory holds only the database and the log, and the CSS is
// compiled in — with the cache policy's validators, and the conditional GET
// is the 304. The URL is the one the page's own output named, so the link
// and the asset cannot drift apart, and nothing below main could prove the
// deployable artifact carries the design system; this is that proof at the
// process level, the way the page tests prove the mount.
func TestServer_StaticAssets(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr

	resp, page := fetchPage(t, base+"/login")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	link := stylesheetLink.FindStringSubmatch(page)
	require.Len(t, link, 2, "the page links its stylesheet")

	resp, css := fetchPage(t, base+link[1])
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, resp.Header.Get("Content-Type"), "text/css")
	require.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
	tag := resp.Header.Get("ETag")
	require.NotEmpty(t, tag, "the stylesheet carries a validator")
	require.Contains(t, css, ":root")

	// The second visit is a revalidation: the tag travels back, the answer
	// is a 304, and the body is not sent again.
	req, err := http.NewRequest(http.MethodGet, base+link[1], nil)
	require.NoError(t, err)
	req.Header.Set("If-None-Match", tag)
	resp, err = http.DefaultClient.Do(req) // #nosec G107 -- the test's own listener address
	require.NoError(t, err)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
	require.Equal(t, http.StatusNotModified, resp.StatusCode)
	require.Empty(t, body, "a 304 carries no body")
}

// TestServer_AdminKeyBootstrap drives the chapter's boot path through the
// real binary: TODO_ADMIN_KEY seeds the admin account, the ordinary login
// route opens it, the admin gate the profile routes carry accepts it, a wrong
// key does not, and the key is in no record the boot wrote.
func TestServer_AdminKeyBootstrap(t *testing.T) {
	t.Parallel()

	const key = "todo-admin-key-that-never-reaches-the-log"
	srv := startServer(t,
		"TODO_ADMIN_EMAIL=Admin@Example.COM",
		"TODO_ADMIN_KEY="+key,
	)
	defer srv.stop(t)

	base := "http://" + srv.addr

	// The ordinary login opens the seeded account: the bootstrap adds no
	// second way in, it only makes sure the first one has an admin behind it.
	resp := postJSON(t, base+"/api/v1/auth/login",
		fmt.Sprintf(`{"email":"admin@example.com","password":%q}`, key), nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	cookies := resp.Cookies()
	require.NoError(t, resp.Body.Close())
	require.Len(t, cookies, 1, "a login sets the session cookie")

	// The admin gate answers the seeded account, so the profiles are
	// reachable without the CLI ever running.
	req, err := http.NewRequest(http.MethodGet, base+"/debug/pprof/", nil)
	require.NoError(t, err)
	req.AddCookie(cookies[0])
	profiles, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	require.NoError(t, profiles.Body.Close())
	assert.Equal(t, http.StatusOK, profiles.StatusCode)

	// A wrong key is a wrong password: the stored credential is a hash of the
	// key, so nothing else opens the account.
	resp = postJSON(t, base+"/api/v1/auth/login",
		`{"email":"admin@example.com","password":"not the key"}`, nil)
	require.NoError(t, resp.Body.Close())
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	// The boot's records say what it ensured and never what it ensured it
	// with: the key is in neither sink.
	logData, err := os.ReadFile(filepath.Join(srv.dir, "todo.log")) // #nosec G304 -- the test's own temp path
	require.NoError(t, err)
	assert.Contains(t, string(logData), `"msg":"admin credential ensured"`)
	assert.Contains(t, string(logData), `"created":true`)
	for _, sink := range []struct {
		name string
		data string
	}{
		{"stderr", srv.stderr.String()},
		{"the log file", string(logData)},
	} {
		assert.NotContains(t, sink.data, key, "%s carries the key", sink.name)
	}
}

// TestServer_AdminKeyFile drives the file variant through the real binary: a
// file every account can read is refused before the server starts, and the
// same file at 0600 boots and opens the account — with the trailing newline
// the file was written with trimmed off the key.
func TestServer_AdminKeyFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "admin-key")
	const key = "todo-admin-key-from-a-file"
	require.NoError(t, os.WriteFile(path, []byte(key+"\n"), 0o644)) // #nosec G306 -- the permissive mode is the case under test
	require.NoError(t, os.Chmod(path, 0o644))                       // #nosec G302 -- the permissive mode is the case under test

	t.Run("a world-readable file is refused", func(t *testing.T) {
		// The boot must fail, not serve: a credential the process could not
		// verify was private is a credential it must not use. The context is
		// the deadline a boot that wrongly started would be killed at, so a
		// regression fails the assertions instead of hanging the suite.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		// #nosec G204 -- binPath is built by TestMain from this package's own
		// source, and the arguments are test-authored.
		cmd := exec.CommandContext(ctx, binPath, "--listen", "127.0.0.1:0")
		cmd.Env = []string{
			"PATH=" + os.Getenv("PATH"),
			"TODO_DB=" + filepath.Join(dir, "todo.db"),
			"TODO_LOG=" + filepath.Join(dir, "todo.log"),
			"TODO_ADMIN_EMAIL=admin@example.com",
			"TODO_ADMIN_KEY_FILE=" + path,
		}
		out, err := cmd.CombinedOutput()
		require.Error(t, err, "the boot must fail; output:\n%s", out)
		assert.Contains(t, string(out), "0644", "the refusal names the mode it found")
		assert.NotContains(t, string(out), key, "the refusal does not echo the key")

		// The refusal runs before anything opens a file: a boot that cannot
		// honor the operator's secret leaves nothing behind — not the log it
		// would have written to, not the database.
		_, err = os.Stat(filepath.Join(dir, "todo.log"))
		assert.True(t, os.IsNotExist(err), "the refused boot created a log file")
		_, err = os.Stat(filepath.Join(dir, "todo.db"))
		assert.True(t, os.IsNotExist(err), "the refused boot created a database")
	})

	t.Run("a private file boots", func(t *testing.T) {
		require.NoError(t, os.Chmod(path, 0o600))

		srv := startServer(t,
			"TODO_ADMIN_EMAIL=admin@example.com",
			"TODO_ADMIN_KEY_FILE="+path,
		)
		defer srv.stop(t)

		resp := postJSON(t, "http://"+srv.addr+"/api/v1/auth/login",
			fmt.Sprintf(`{"email":"admin@example.com","password":%q}`, key), nil)
		require.NoError(t, resp.Body.Close())
		assert.Equal(t, http.StatusOK, resp.StatusCode, "the file's key opens the account, newline trimmed")
	})
}
````


## `cmd/todo-server/main.go`

````go
// Command todo-server is the todo application's HTTP server: the wiring
// around internal/api and internal/web — configuration, the process logger,
// the store's lifecycle, signals, and the exit code. The API routes live in
// internal/api, the server-rendered pages in internal/web, and main composes
// both onto one echo instance so they share the middleware stack, the
// session, and the store.
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
	"todo/internal/auth"
	"todo/internal/config"
	"todo/internal/logging"
	"todo/internal/secret"
	"todo/internal/store"
	"todo/internal/telemetry"
	"todo/internal/version"
	"todo/internal/web"
)

// shutdownTimeout bounds the drain: how long Shutdown waits for in-flight
// requests before giving up. Chapter 30 chose five seconds — "longer than
// anything this server serves" — and chapter 48's numbers make that wrong:
// the stack arms a ten-second deadline on every request (internal/api's
// requestTimeout), so a request that was in flight when the signal arrived
// can have its whole deadline left to run, and a five-second drain cuts work
// the server would still have served — and exits non-zero, which a
// supervisor reads as a failed stop. The budget is that deadline plus a
// five-second margin for the store's checkpoint and the process's last
// records; the unit's TimeoutStopSec outlasts both.
const shutdownTimeout = 15 * time.Second

// flushTimeout bounds the tracer's last export, and it is deliberately not
// the drain's budget: a batch export that has not finished in five seconds
// is not going to, and the requests were served either way.
const flushTimeout = 5 * time.Second

// The API's general documentation, as swaggo annotations. swag init reads
// this block — it has to be a comment group of its own — for the spec's
// title, version, and tags; the per-handler annotations live beside the
// handlers they describe, in internal/api. The generated spec and the
// Swagger UI that serves it are internal/api/docs.

//	@title			Todo API
//	@version		1.0
//	@description	The todo application's HTTP surface: the task CRUD routes
//	@description	and the auth routes that gate them.
//	@description
//	@description	The task routes require a session: log in through
//	@description	`POST /api/v1/auth/login` first, and the cookie it sets
//	@description	carries the identity on every following request. Every task
//	@description	is scoped to the authenticated user, so a task another user
//	@description	owns answers exactly what a missing task answers.
//	@description
//	@description		Every failure leaves in one shape — `code`, `message`, and,
//	@description		on a validation failure, `fields`. The responses named per
//	@description		operation are the ones its handler decides; the stack's own
//	@description		failures can arrive on any route in the same shape: 413 for
//	@description		a body over 64 KiB, 500 for an internal error, 504 for a
//	@description		request past its ten-second deadline.
//	@tag.name			tasks
//	@tag.description	The task CRUD surface. Every route requires a session and is scoped to the caller.
//	@tag.name			auth
//	@tag.description	Registration, login, and logout — the routes an anonymous caller can reach.
//	@tag.name			health
//	@tag.description	Liveness and readiness probes for supervisors, not clients.

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
	// accepting and drains within shutdownTimeout. stop is called at that
	// point rather than only deferred: with the handler unregistered, a
	// second signal reaches the process with the default disposition and
	// kills it — the operator's way out of a drain that will not finish.
	// main's os.Exit skips the defer, but the process is leaving anyway.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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

	// The admin bootstrap's key arrives through internal/secret, which
	// returns a value that cannot be printed: the key never enters Config —
	// a Config is a value callers may log — and never reaches a record. The
	// loader enforces the file's mode bits where the environment names a
	// file, and refuses a configuration that names two sources for one
	// credential. It runs before anything opens a file — the log included —
	// so a boot that refuses the operator's secret leaves nothing behind,
	// and the process never starts a logger it would only use to report the
	// refusal.
	adminKey, err := secret.Load(os.Getenv, config.EnvAdminKey, config.EnvAdminKeyFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if !adminKey.IsEmpty() && cfg.AdminEmail == "" {
		fmt.Fprintln(os.Stderr, "todo-server: the admin key is set but TODO_ADMIN_EMAIL is not; a credential has to name an account")
		return 1
	}

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
		// The process is leaving; a close error cannot change the exit
		// code and has nowhere better to go, so it is discarded
		// explicitly, like the CLI's.
		_ = closer.Close()
	}()

	// A canceled boot aborts before serving: NewTursoStore applies the
	// embedded migrations under ctx, so a signal during startup stops there.
	st, err := store.NewTursoStore(ctx, cfg.DBPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	// The trace pipeline and the metrics registry, built before the server
	// so the stack has them from the first request. The provider's off mode
	// (no endpoint configured) costs a small allocation per span and
	// exports nothing; with an endpoint, the deferred Shutdown below is
	// what flushes the batch processor's last batch before the process
	// leaves.
	tp, err := telemetry.NewTracerProvider(ctx, cfg.OTelEndpoint, logger)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() {
		// The flush gets its own, smaller budget: a batch export that has
		// not finished in flushTimeout is not going to, and a flush that
		// fails is recorded rather than fatal — the requests were served,
		// and losing the last spans is telemetry's problem, not the
		// process's.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), flushTimeout)
		defer cancel()
		if err := tp.Shutdown(shutdownCtx); err != nil {
			logger.Error("telemetry shutdown failed", "err", err)
		}
	}()

	// The registry the scrape endpoint serves: the runtime's and the
	// process's collectors, on top of which api.New registers the request
	// metrics.
	reg := telemetry.NewRegistry()

	// The auth material shares the store's database handle: one process, one
	// pool, one close. The session store sweeps its expired rows once, here
	// at boot — scs never does, and an expired row is otherwise only refused
	// by the expiry predicate, never removed. A sweep that fails is logged
	// and boot continues: readiness is where a broken database is reported,
	// and a boot that refuses to start over a cleanup would be a worse
	// trade.
	sqlDB := st.DB()
	sessionStore := auth.NewSessionStore(sqlDB)
	if n, err := sessionStore.DeleteExpired(ctx); err != nil {
		logger.Error("session sweep failed", "err", err)
	} else if n > 0 {
		logger.Info("expired sessions removed", "count", n)
	}

	sessions := api.NewSessionManager(sessionStore)

	// The auth service is built once and handed to both surfaces: the API's
	// auth routes and the pages' login form check the same credentials
	// against the same users table and record to the same trail.
	authn := auth.NewService(sqlDB)

	// The bootstrap runs before the server accepts a request, so the first
	// login finds the credential. A failure is a boot failure: the operator
	// set a secret and the process cannot honor it, and a server that came
	// up anyway would look healthy and be wrong. What the boot ensured is
	// recorded; what it ensured it with is not — the key is not an
	// attribute, a message, or a format string anywhere in this process.
	if !adminKey.IsEmpty() {
		res, err := authn.BootstrapAdmin(ctx, cfg.AdminEmail, adminKey)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		logger.Info("admin credential ensured",
			"email", cfg.AdminEmail,
			"created", res.Created, "rotated", res.Rotated, "granted", res.Granted)
	}

	e := api.New(st, authn, sessions, logger, tp, reg)

	// The server-rendered pages mount onto the instance the API just built:
	// one echo, one middleware stack, one session manager, one store. The
	// pages are registered here rather than inside api.New so the API
	// instance — and the OpenAPI coverage test that walks its route table —
	// stays free of page routes that are not API operations.
	web.New(st, authn, sessions, time.Now).Register(e)

	// Start blocks until the server stops, so it runs in its own goroutine
	// and the main goroutine stays free to receive the signal. The channel
	// carries a failure out: Start returns immediately when it cannot bind,
	// and without the select the process would wait for a signal it can
	// never serve.
	// The release stamp is part of the boot record: an operator looking at
	// a running host can read which tag built the binary, without asking
	// the deployment. "dev" on a release host is the honest signal that
	// the binary was built by hand.
	logger.Info("server listening", "addr", cfg.Listen, "version", version.Version)
	serveErr := make(chan error, 1)
	go func() { serveErr <- e.Start(cfg.Listen) }()

	select {
	case <-ctx.Done():
		// The first signal has canceled ctx. Unregistering the handler now
		// is what makes a second signal the escape hatch: it reaches the
		// process with the default disposition and ends a drain that will
		// not finish on its own. systemd's own stop is two-stage one level
		// up — SIGTERM, then SIGKILL after TimeoutStopSec — and this is the
		// same shape for an operator at a terminal or in a container.
		stop()
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
````
