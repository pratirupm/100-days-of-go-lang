---
title: "Day 51 — Talking to the API"
description: "Point the terminal interface at the HTTP API, so it signs in and asks the server for everything it shows. — Day 51 of 100 Days of Go Lang."
sidebar:
  order: 51
chapter: 43
---

**About 3 hours** · Part IX, day 3 of 4.

**You'll be able to:**

- give the interface an HTTP client that talks to the API;
- handle the live conflict and sign in from the TUI.

---

The terminal interface works, but it opens the database file itself — the
same file the command-line tool and the server write. Only one program can
hold that file at a time, so no second writer can appear while the interface
is open. The conflict the store's compare-and-swap exists for has never been
seen live.

Today the interface stops touching the file. It asks the server for
everything instead: the list it shows, the tasks it adds, the completions it
sends. The server stays the one program that owns the database, and the
interface becomes one more of its clients — the same relationship the
browser pages already have with it.

That change brings two things the interface didn't have: a sign-in screen,
because the server only serves each account its own tasks, and a real
conflict — with two clients talking to one server, a task really can change
between a read and a write.

The keys don't change once you're in: `j` and `k` move, `a` adds, `enter`
completes, `r` reloads. They just travel to the server as requests now.

## The interface becomes a customer

A **client** is a program that asks another program to do work for it. The
browser is the pattern to copy: it asks, and the server answers with a page.
The interface is about to work the same way — it asks for the task list and
asks the server to make changes.

The interface's only way to the file is the server now: one writer, many
askers. The arrangement buys two habits.

First, the list on screen is a snapshot — the server handed it over at the
moment of the request. When something else changes the tasks, the interface
asks again: that's `r`, and the fresh load after every write. Second, a
write can arrive too late. If the task changed since the interface read it,
the server refuses the stale write instead of overwriting, and the interface
says so. That refusal is the compare-and-swap from the store, now happening
across the network.

Signing in works the browser way too. The server hands back a small note
called a **cookie**; the client shows that note on every later request, and
the server checks it. Go's standard library includes a **cookie jar** — a
store that keeps cookies and attaches them to the right requests — so our
client never handles the note by hand.

The plan: a new package, `internal/client`, that speaks to the API — four
operations: sign in, list, create, complete. The model holds it behind a
small interface it defines itself, so the model never learns about HTTP. The
interface gets a sign-in form, and the binary swaps its store for the client.

## The client's tests come first

The habit holds: describe what the client must do before writing it. Create
`internal/client/client_test.go`.

The client's whole job is the wire, so the tests use the real thing.
`httptest.NewServer` starts the real API — the same handlers, sessions, and
database layer — behind a real listener, and the client reaches it over the
network. A **test server** is a real server on a port the test picks, shut
down when the test ends.

Two helpers set the stage: one builds the server, and the other signs a
client in and hands back the user's id, so a case can seed tasks the way
another writer would.

<!-- verify: internal/client/client_test.go at=tui-client -->
```go title="internal/client/client_test.go"
// newTestServer builds the API the client's contract cases exercise: the
// real stack over a memory task store and a real auth service, behind a real
// listener. The store comes back so a case can seed and inspect it the way
// another writer would; the session cookie the client's login sets is what
// scopes every request to the registered user.
func newTestServer(t *testing.T) (*httptest.Server, store.Store) {
	t.Helper()
	sqlDB := openAuthDB(t)
	st := store.NewMemoryStore()
	srv := httptest.NewServer(api.New(
		st,
		auth.NewService(sqlDB),
		api.NewSessionManager(auth.NewSessionStore(sqlDB)),
		slog.New(slog.DiscardHandler),
	))
	t.Cleanup(srv.Close)
	return srv, st
}

// ...

// signedIn returns a client with a live session — registered, logged in, the
// cookie in its jar — and the user's id, so a case can scope the store the
// API reads through exactly the way the API scopes it.
func signedIn(t *testing.T, srv *httptest.Server) (*client.Client, uuid.UUID) {
	t.Helper()
	id := signUp(t, srv, testEmail, testPassword)
	c := client.New(srv.URL)
	require.NoError(t, c.Login(context.Background(), testEmail, testPassword))
	return c, id
}
```

`signUp` — elided above — registers the user through the API's register
route with one POST, because the client itself has no register: the
interface only signs in. `seed` and `titles` are the helpers the earlier
test files already have.

Now the first case. It has the shape every contract case shares: set up,
sign in, seed, act, assert.

<!-- verify: internal/client/client_test.go at=tui-client -->
```go title="internal/client/client_test.go"
// TestClient_ListTasks is the chapter's first failing test: the client
// speaks the list route and decodes the API's envelope into domain tasks.
func TestClient_ListTasks(t *testing.T) {
	t.Parallel()

	srv, st := newTestServer(t)
	c, userID := signedIn(t, srv)
	seed(t, st.Scoped(userID), "write the chapter", "buy milk")

	tasks, err := c.ListTasks(context.Background())

	require.NoError(t, err)
	assert.Equal(t, []string{"write the chapter", "buy milk"}, titles(tasks))
	first := tasks[0]
	assert.NotEqual(t, uuid.Nil, first.ID, "the wire's id decodes to a uuid")
	assert.Equal(t, task.StatusTodo, first.Status)
	assert.Equal(t, task.PriorityDefault, first.Priority)
	assert.Equal(t, 1, first.Version, "the version rides the wire: the next write must carry it back")
}
```

Read it as a promise: after a sign-in and two seeded tasks, `ListTasks`
returns both, in the API's order, with the id, the status, the priority, and
the version decoded from the API's JSON.

The policy cases are the other half of the file. A read that fails
transiently is retried; a write never is:

<!-- verify: internal/client/client_test.go at=tui-client -->
```go title="internal/client/client_test.go"
// TestClient_RetriesReads pins the read half of the retry policy: a
// transient failure — here a 503 — is retried, and the second answer is the
// one that lands.
func TestClient_RetriesReads(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "try later", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tasks":[]}`))
	}))
	t.Cleanup(srv.Close)

	tasks, err := client.New(srv.URL).ListTasks(context.Background())

	require.NoError(t, err)
	assert.Empty(t, tasks)
	assert.Equal(t, int32(2), calls.Load(), "the first read failed transiently and the retry answered")
}
```

The write half keeps the shape and flips the policy:

<!-- verify: internal/client/client_test.go at=tui-client -->
```go title="internal/client/client_test.go"
// TestClient_WritesAreNotRetried pins the write half: a failed write is
// reported, once. A retry would be a second write whose answer cannot say
// whether the first one landed — and the API's compare-and-swap would refuse
// it as a stale snapshot, a conflict reported for a write that succeeded.
func TestClient_WritesAreNotRetried(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "try later", http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)

	_, err := client.New(srv.URL).CreateTask(context.Background(), task.Task{Title: "write the chapter", Priority: task.PriorityDefault})

	var apiErr *client.Error
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusServiceUnavailable, apiErr.StatusCode)
	assert.Equal(t, int32(1), calls.Load(), "a write gets exactly one attempt")
}
```

The first handler fails once and answers on the retry. The second handler
always fails, and the test counts exactly one call.

The file holds twelve cases in all. The rest follow the same shape: the
four operations, the 401s a stranger gets, the 422's field failures, a
response that is not the API's JSON, and the caller's deadline bounding the
retries. Run them, and Go stops at the folder:

```bash
$ go test -count=1 ./...
...
todo/internal/client: no non-test Go files in …/internal/client
FAIL	todo/internal/client [build failed]
FAIL
```

Write the client, and the tests get something to run against.

## The client's shape

Create `internal/client/client.go`. It opens with the package's description
and its imports — the standard library, plus the two app packages the wire
meets: `store`, for the one sentinel, and `task`, for the domain type.

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// Package client is the TUI's typed client over the application's REST API:
// login, list, create, and complete — the four operations the task list
// performs — with the session cookie carried in a jar, a timeout on every
// attempt, and a retry policy that knows reads from writes.
//
// ...
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"time"

	"github.com/google/uuid"

	"todo/internal/store"
	"todo/internal/task"
)
```

Then the three constants that bound the client, in one place, so the policy
reads in one block:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// The client's policy values, in one place.
const (
	// attemptTimeout bounds one HTTP exchange — connect, send, headers,
	// body — inside the caller's context. It is the client's only timeout:
	// a second, coarser bound with the same scope would be a knob that
	// never fires, and the caller's context (the TUI's signal context has
	// no deadline of its own) is the outer budget the retry loop respects.
	attemptTimeout = 5 * time.Second

	// maxAttempts is the total number of tries a read gets, the first
	// included. Writes get exactly one; see doWrite.
	maxAttempts = 3

	// retryBackoff is the pause between two read attempts. Fixed, not
	// exponential: three attempts a hundred milliseconds apart are a blip
	// the caller does not see, and the caller's context — not the client —
	// owns the overall budget.
	retryBackoff = 100 * time.Millisecond
)
```

`attemptTimeout` bounds one exchange — connect, send, headers, body — and it
is the client's only timeout. `maxAttempts` is what a read gets, the first
try included. `retryBackoff` is the pause between two read tries.

Next, the one failure code the client branches on, spelled where it is used:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// codeConflict is the one API code the client branches on. The codes are the
// API's stable vocabulary (internal/api/error.go); the client spells the one
// it uses so the wire contract is visible where it is consumed.
const codeConflict = "conflict"
```

Then the client itself and its constructor. The struct is two fields — the
API's address and one `http.Client` — and the constructor is where the
cookie jar, the future home of the session, is built:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// Client is a typed client over the todo API. It is safe for concurrent use:
// the http.Client and its jar are, and the client holds no other state.
// Build one with New and reuse it — the jar is where the session lives, so a
// second client is a second login.
type Client struct {
	// baseURL is the API root, without a trailing slash.
	baseURL string

	// http is the shared HTTP client. The transport is the default one:
	// it pools connections per host — the discipline a chatty TUI wants —
	// and the one host it talks to is the API. The jar is where the login
	// sticks: the session cookie the API sets rides Set-Cookie, the jar
	// stores it, and every later request carries it back.
	http *http.Client
}

// New builds a client for the API at baseURL — "http://127.0.0.1:8080", the
// value config resolves. The jar is net/http's, which follows the browser
// rule that loopback is a secure origin: the API's session cookie is Secure,
// and the local flow over http works while a deployed client must be https
// — the same rule the server's cookie policy leans on.
func New(baseURL string) *Client {
	// cookiejar.New with no options cannot fail; the error return exists
	// for the public-suffix list a browser would pass.
	jar, _ := cookiejar.New(nil)
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Jar: jar},
	}
}
```

`cookiejar.New(nil)` cannot fail — the error return exists for a
browser-style list we don't pass — so the jar is assigned with the error
discarded on purpose. The base URL loses any trailing slash once, here, so
every later path can start with a slash. And the `http.Client` carries no
timeout of its own: the deadline is armed per attempt, a few functions down.

## The four operations

Each operation is a route, a method, and a body — the API's contract,
consumed. `Login` posts the credentials and throws the response away: the
session is what the caller needs, and the jar is where it lands.

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// Login signs in and leaves the session in the jar: the API sets the session
// cookie on the response, the jar stores it, and every request after this
// one carries it. A failed login returns the API's *Error — the 401 whose
// message names neither half of the credentials, on purpose. The response
// body — the user — is not decoded: the session is what the caller needs,
// and the jar is where it lands.
func (c *Client) Login(ctx context.Context, email, password string) error {
	return c.doWrite(ctx, http.MethodPost, "/api/v1/auth/login", loginRequest{Email: email, Password: password}, nil)
}
```

`ListTasks` asks for the list and converts each task from the wire's shape
to the domain's:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// ListTasks returns the authenticated user's tasks, in the API's order.
func (c *Client) ListTasks(ctx context.Context) ([]task.Task, error) {
	var list taskListResponse
	if err := c.doRead(ctx, "/api/v1/tasks", &list); err != nil {
		return nil, err
	}
	tasks := make([]task.Task, len(list.Tasks))
	for i, r := range list.Tasks {
		tasks[i] = r.task()
	}
	return tasks, nil
}
```

`CreateTask` maps the domain fields onto the wire's: a due date the task
doesn't have is left out, and a priority outside the valid range is left out
too, leaving the API's default. It returns the stored copy, because the id
and the version are the API's to assign:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// CreateTask creates a task for the authenticated user and returns the
// stored copy — the id and the version are the API's to assign. The domain
// fields map onto the wire's: a zero due date is omitted, because the API
// reads absent as "no due date", and a priority outside the valid range is
// omitted too, leaving the API's default.
func (c *Client) CreateTask(ctx context.Context, t task.Task) (task.Task, error) {
	body := createTaskRequest{Title: t.Title, Tags: t.Tags}
	if t.Priority.Valid() {
		priority := int(t.Priority)
		body.Priority = &priority
	}
	if !t.Due.IsZero() {
		due := t.Due
		body.Due = &due
	}

	var created taskResponse
	if err := c.doWrite(ctx, http.MethodPost, "/api/v1/tasks", body, &created); err != nil {
		return task.Task{}, err
	}
	return created.task(), nil
}
```

`Complete` is the compare-and-swap from this side. The version the caller
read travels with the write, and a task that changed since is refused with a
409 — which the API renders as the store's own conflict sentence. The client
turns that refusal back into the domain's sentinel, so the caller keeps the
branch it already had:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// Complete marks the task done through the API's compare-and-swap: the
// version the caller read travels with the write, and a task that changed
// since is refused with a 409. That refusal is the domain's stale-snapshot
// conflict — the API renders store.ErrConflict's own sentence as the 409's
// message — so the client hands the sentinel back and the caller keeps the
// branch it had: errors.Is(err, store.ErrConflict).
func (c *Client) Complete(ctx context.Context, id uuid.UUID, version int) error {
	err := c.doWrite(ctx, http.MethodPatch, "/api/v1/tasks/"+id.String(), updateTaskRequest{Version: version, Status: "Done"}, nil)
	if err != nil && isConflict(err) {
		return store.ErrConflict
	}
	return err
}
```

Between the operations and the wire sit the shapes the JSON maps onto — the
request bodies first:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// loginRequest is the POST /api/v1/auth/login body.
type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// createTaskRequest is the POST /api/v1/tasks body. Priority and due are
// pointers because the API reads absent as "the default" and "no due date";
// the client omits what the domain task does not carry.
type createTaskRequest struct {
	Title    string     `json:"title"`
	Priority *int       `json:"priority,omitempty"`
	Due      *time.Time `json:"due,omitempty"`
	Tags     []string   `json:"tags,omitempty"`
}

// updateTaskRequest is the PATCH /api/v1/tasks/:id body the client sends:
// the version it read and the status it is writing. The API's DTO makes
// every field but version optional, because any subset may change; this
// client only completes, so both fields are always present.
type updateTaskRequest struct {
	Version int    `json:"version"`
	Status  string `json:"status"`
}
```

And the API's task as Go structs, with the one conversion between the two
worlds:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// taskResponse is the API's task shape. The id and the status decode through
// the domain types' text unmarshaling — uuid.UUID and task.Status both
// implement encoding.TextUnmarshaler — so a malformed id or an unknown
// status fails at the edge, where the wire meets the domain, not later.
type taskResponse struct {
	ID       uuid.UUID     `json:"id"`
	Title    string        `json:"title"`
	Status   task.Status   `json:"status"`
	Priority task.Priority `json:"priority"`
	Due      *time.Time    `json:"due"`
	Tags     []string      `json:"tags"`
	Version  int           `json:"version"`
}

// task converts the wire shape to the domain task. The due date is the one
// translation: the wire spells "no due date" as null, the domain as the zero
// time.
func (r taskResponse) task() task.Task {
	t := task.Task{
		ID:       r.ID,
		Version:  r.Version,
		Title:    r.Title,
		Status:   r.Status,
		Priority: r.Priority,
		Tags:     r.Tags,
	}
	if r.Due != nil {
		t.Due = *r.Due
	}
	return t
}
```

The collection arrives in one small envelope:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// taskListResponse is the collection's envelope: the tasks key is always an
// array, so an empty list decodes to an empty slice, not to a missing key.
type taskListResponse struct {
	Tasks []taskResponse `json:"tasks"`
}
```

That is the whole wire layer: four small request or response shapes and one
conversion between the API's task and the domain's.

## Reads retry; writes never do

Two doors lead to one exchange. `doRead` is the retry loop; `doWrite` is
the absence of one. The policy's two halves, side by side:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// doRead performs a GET under the read retry policy: a transient failure is
// retried up to maxAttempts, with retryBackoff between tries, as long as the
// caller's context has budget. The context is the budget — the loop never
// waits past the caller's deadline, and a cancellation ends it with the
// context's cause.
func (c *Client) doRead(ctx context.Context, path string, out any) error {
	var err error
	for attempt := 1; ; attempt++ {
		err = c.attempt(ctx, http.MethodGet, path, nil, out)
		if err == nil {
			return nil
		}
		// The caller's context is checked first: a deadline that passed or
		// a cancellation is the caller's decision, not a transient failure
		// — and either way there is no budget left for another try.
		if ctx.Err() != nil || attempt >= maxAttempts || !retryable(err) {
			return err
		}
		timer := time.NewTimer(retryBackoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("%s %s: %w", http.MethodGet, path, context.Cause(ctx))
		case <-timer.C:
		}
	}
}
```

A read that fails is a read that did not happen, so it gets up to
`maxAttempts` tries, `retryBackoff` apart, while the caller's context still
has budget. The context is checked first: a cancellation or a passed
deadline is the caller's decision, and there is no budget left for another
try. The pause is a `select` against the context, so the loop never waits
past the caller's deadline.

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// doWrite performs a write — POST or PATCH — and never retries. A write that
// timed out may have been applied: a retry would be a second write whose
// answer cannot say whether the first one landed, and the API's
// compare-and-swap would refuse the retry as a stale snapshot — a conflict
// reported for a write that succeeded. So a failed write is reported, once,
// and the caller decides; the TUI's answer is a reload and a notice.
func (c *Client) doWrite(ctx context.Context, method, path string, body, out any) error {
	return c.attempt(ctx, method, path, body, out)
}
```

A write gets exactly one attempt: a write that timed out may have been
applied, and a retry cannot say whether the first one landed. So a failed
write is reported once, and the caller decides; the interface's answer is a
notice and a reload.

`retryable` is the classification the loop asks: a transport failure is
worth another try, and a response is only worth one when its status asks for
it — 502, 503, or 504. A 4xx would fail identically, and a 500 is a bug a
hundred milliseconds will not heal.

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// retryable reports whether a failed read attempt is worth another try. A
// transport failure is — no answer arrived, and a retry costs one round
// trip. A response is not, unless its status says so: 502, 503, and 504 are
// the server or a proxy in front of it asking for another try later, while a
// 4xx is the client's own failure (a retry would fail identically) and a 500
// is a bug (a retry would make noise, not an answer). The caller's context is
// checked before this, so a cancellation never reaches here as a transient
// failure.
func retryable(err error) bool {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			return true
		}
		return false
	}
	return true
}
```

The loop asks it once per failed attempt.

## One exchange, with a deadline

`attempt` is the only place a request is made. Two rules inside it are easy
to miss. First, the deadline: `attemptTimeout` is armed on a context derived
from the caller's, once per attempt, so a hung connection costs one attempt,
not the whole budget.

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// attempt is one HTTP exchange: build the request, arm the attempt's
// deadline inside the caller's, send it, and decode the answer. It is the
// only place a request is made; doRead's loop calls it up to maxAttempts
// times, doWrite exactly once.
func (c *Client) attempt(ctx context.Context, method, path string, body, out any) error {
	ctx, cancel := context.WithTimeout(ctx, attemptTimeout)
	defer cancel()

	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("%s %s: encode request: %w", method, path, err)
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, payload)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
```

Then the response. A status outside 200–299 becomes the one error type; a
2xx answer decodes into the caller's value. And before the body closes, it
is drained — read to its end and thrown away — because a connection whose
body was closed early cannot go back to the transport's idle pool for reuse:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer func() {
		// The decoder stops at the end of the value it read; draining the
		// remainder before closing is what lets the transport return the
		// connection to its idle pool instead of discarding it.
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return decodeAPIError(resp)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("%s %s: decode response: %w", method, path, err)
	}
	return nil
}
```

That is one exchange, start to finish.

## One error shape

Every failure the API reports arrives in the same shape, and the client
decodes it once. The type has four parts: the status, the stable code a
caller branches on, the message a caller shows, and the field failures a 422
carries.

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// Error is one failure as the API reports it: the HTTP status, the stable
// code, the human message, and the field failures of a 422. A caller that
// branches uses Code — the contract's stable half — reached through
// errors.As; a caller that shows a message uses Error().
type Error struct {
	// StatusCode is the response's HTTP status.
	StatusCode int `json:"-"`
	// Code is the API's stable failure token, safe to branch on.
	Code string `json:"code"`
	// Message is the API's prose, for humans and logs.
	Message string `json:"message"`
	// Fields names the failures of a 422, sorted by field name.
	Fields []FieldError `json:"fields"`
}

// FieldError is one field-level failure inside a 422: the field's wire name
// and the sentence about why it failed.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}
```

`Error()` is what the sign-in notice will show. A plain failure renders the
API's message; a validation failure appends the field sentences, so the
whole line reads `validation failed: title cannot be empty`:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// Error renders the failure for a human: the API's message, with the field
// failures appended when the 422 named any — "validation failed: email is
// required".
func (e *Error) Error() string {
	if len(e.Fields) == 0 {
		return e.Message
	}
	parts := make([]string, len(e.Fields))
	for i, f := range e.Fields {
		parts[i] = f.Field + " " + f.Message
	}
	return e.Message + ": " + strings.Join(parts, "; ")
}
```

`decodeAPIError` reads that shape off a failed response, and falls back to
the status text when the body is not it — a proxy's HTML page, a truncated
stream — so the caller always gets an error it can show:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// decodeAPIError reads the one error shape off a failed response. A body
// that is not that shape — a proxy's HTML, a truncated stream — falls back
// to the status text: the caller still gets an *Error, and a sentence it can
// show.
func decodeAPIError(resp *http.Response) *Error {
	apiErr := &Error{StatusCode: resp.StatusCode}
	if err := json.NewDecoder(resp.Body).Decode(apiErr); err != nil || apiErr.Message == "" {
		apiErr.Message = http.StatusText(resp.StatusCode)
		apiErr.Fields = nil
	}
	return apiErr
}
```

And `isConflict` is the client's one branch on a code — the code, never the
message, because the message is prose:

<!-- verify: internal/client/client.go at=tui-client -->
```go title="internal/client/client.go"
// isConflict reports whether a failure is the API's stale-snapshot conflict.
// The code is the half of the error contract that is safe to branch on; the
// message is prose.
func isConflict(err error) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && apiErr.Code == codeConflict
}
```

That is the whole client. Run the suite, and every case passes — the
contract cases and the policy cases alike:

```bash
$ go test -count=1 ./...
...
ok  	todo/internal/client	0.603s
...
```

The client is complete. Next, its one setting.

## The one setting the interface needs

`internal/config` gains the interface's single setting, resolved with the
same rule the server's listen address already uses. The environment variable
joins the others, and the default is the server's default address as a URL —
the address a freshly started client can reach:

<!-- verify: internal/config/config.go at=tui-client -->
```go title="internal/config/config.go"
const (
	envDB     = "TODO_DB"
	envLog    = "TODO_LOG"
	envListen = "TODO_LISTEN"
	envAPI    = "TODO_API_URL"
)
```

The default is its own constant:

<!-- verify: internal/config/config.go at=tui-client -->
```go title="internal/config/config.go"
// DefaultAPIURL is the API base URL the TUI calls when neither its --api
// flag nor $TODO_API_URL says otherwise. It is DefaultListen as a URL: the
// address the server binds by default is the one a freshly started client
// can reach, and it is loopback for the same reason.
const DefaultAPIURL = "http://127.0.0.1:8080"
```

`APIURL` follows `Listen`'s precedence story: a non-empty `--api` flag beats
`$TODO_API_URL`, which beats the default. The binary calls it with its flag,
because `Load` cannot see the command line:

<!-- verify: internal/config/config.go at=tui-client -->
```go title="internal/config/config.go"
// APIURL resolves the TUI's API base URL: a non-empty flag beats
// $TODO_API_URL, which beats DefaultAPIURL. The TUI binary calls it with its
// --api flag, which Load cannot see — the same split Listen has, on the
// client side of the same pair — and the rule is Listen's deliberately: two
// binaries, two settings, one precedence story. The TUI resolves this one
// setting and not Load: the database path and the log path are not the TUI's
// to resolve, and requiring HOME for a database the TUI never opens would be
// a promise the binary does not keep.
func APIURL(getenv func(string) string, flag string) string {
	if flag != "" {
		return flag
	}
	if url := getenv(envAPI); url != "" {
		return url
	}
	return DefaultAPIURL
}
```

The interface resolves this one setting and deliberately does not call
`Load`: `Load` resolves the database path and the log path, and its defaults
need a home folder, while the interface opens no database and writes no log.
The config test file gains `TestAPIURL`, the same precedence table
`TestListen` has — the flag, the environment, the default, and the
empty-value rows.

## The model's tests move to a fake

The model's tests speak to a store today; the seam they speak to is now the
client. They move to a **fake** — a small type that implements the four
calls and answers with whatever a case scripts:

<!-- verify: internal/tui/tui_test.go at=tui-client -->
```go title="internal/tui/tui_test.go"
// fakeClient is the model's seam: the API as the tests script it. It
// implements tui.Client with one field per answer — the tasks a list serves,
// the error each call fails with — so a test states the API's ... as
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
```

The four methods are a few lines each: `Login` records the credentials and
answers with the scripted error; `ListTasks` serves the tasks or the
scripted error; `CreateTask` assigns an id and version 1 the way the API
does; and `Complete` applies the write or answers with the scripted error.

`signedIn` drives the real message sequence — email, tab, password, enter,
the login's answer, the load it asks for — so every case after the login
cases starts from a state the model really reaches:

<!-- verify: internal/tui/tui_test.go at=tui-client -->
```go title="internal/tui/tui_test.go"
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
```

Then the new cases. The first pins the whole login path: the form, the
fields the keys land in, the mask over the password, and the list the login
asks for.

<!-- verify: internal/tui/tui_test.go at=tui-client -->
```go title="internal/tui/tui_test.go"
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
```

The rest of the case submits and reads the answers:

<!-- verify: internal/tui/tui_test.go at=tui-client -->
```go title="internal/tui/tui_test.go"
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
```

The other new cases are the form's edges: a failed login is a notice and the
form keeps its text, a 422's field sentence reaches the notice, `tab` moves
the focus both ways, and `q` types while `ctrl+c` quits. The existing cases
keep their assertions and gain `signedIn` in front. The teatest runs sign in
first through a small helper:

<!-- verify: internal/tui/teatest_test.go at=tui-client -->
```go title="internal/tui/teatest_test.go"
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
```

The program test types the same sequence through its pipe. Run the tests
now, before the model changes, and the compiler names the seam — `tui.New`
takes a store today, and the tests hand it a fake client:

```bash
$ go test -count=1 ./...
...
# todo/internal/tui_test [todo/internal/tui.test]
internal/tui/program_test.go:71:58: cannot use f (variable of type *fakeClient) as "todo/internal/store".Store value in argument to tui.New: *fakeClient does not implement "todo/internal/store".Store (missing method Add)
...
internal/tui/tui_test.go:246:37: too many errors
FAIL	todo/internal/tui [build failed]
FAIL
```

The `"todo/internal/store".Store` spelling is the toolchain's — current Go
prints the same type as `store.Store`; the missing method is the point
either way.

One line of the target API, said once per call site. The model changes next.

## The seam: what the model asks for

The model doesn't need to know any of this. It needs four things done, so it
says so, in its own package:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
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
```

This is the lesson's central trick: the consumer defines the interface. The
model lists the calls it makes and nothing else — no update, no delete, no
register, because the list never uses them. `internal/client` is one
implementation; the tests' fake is another.

The three task commands change the same way: `loadTasks` asks
`c.ListTasks`, `addTask` calls `c.CreateTask`, and `completeTask` carries the
id and version into `c.Complete`.

A login has two outcomes, and two small messages carry them back to the
model. Success carries nothing — the session is in the client's jar, not in
the model — and failure carries the API's error:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
// loggedInMsg is a login's success. The session itself needs no message —
// it lands in the client's cookie jar — so the message carries nothing but
// the fact; the model's answer is the list the login made reachable.
type loggedInMsg struct{}

// loginErrMsg is a login's failure, arriving as a message. The form stays
// on screen — the mode is the state until a session exists — and the notice
// says what the API said.
type loginErrMsg struct{ err error }
```

The model also starts in a new mode. Before a session exists, the keyboard
belongs to the sign-in form:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
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
```

`modeLogin` is first, so a fresh model starts at the form.

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
// loginField names which of the login form's two inputs has the focus.
type loginField int

const (
	fieldEmail loginField = iota
	fieldPassword
)
```

`New` focuses the email field; `tab` moves to the password.

## The sign-in form

The form is two text inputs and a focus that says which one owns the keys.
`New` builds them — the password's `EchoMode` is the whole reason the typed
text never reaches a frame — and focuses the email field where the model
value is returned, not in `Init`, because Bubble Tea keeps the model `New`
returned and hands `Init` a copy:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
func New(ctx context.Context, c Client) Model {
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

	// ...
	m := Model{
		ctx:       ctx,
		client:    c,
		keys:      defaultListKeys(),
		inputKeys: defaultInputKeys(),
		loginKeys: defaultLoginKeys(),
		help:      help.New(),
		email:     email,
		password:  password,
		input:     input,
	}
	// ...
	return m.syncKeys()
}
```

The model struct gains those two fields and the focus, its `client` field
replaces `store`, and `loginKeys` joins the key maps. `Init` now returns
only the focused field's cursor blink — there is no load to run, because the
first list is the login's follow-up:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
// Init implements tea.Model: the login form's cursor blink. The model starts
// at the form, so there is no load to run — the first list is the login's
// follow-up — and the only startup work is the focused field's cursor. The
// focus itself is set in New; Init's receiver is a copy the program
// discards, so its only job is the command.
func (m Model) Init() tea.Cmd { return m.email.Focus() }
```

The form's keyboard is three bindings. `enter` submits from either field,
`tab` switches the focus, `ctrl+c` quits, and every other key belongs to the
focused field — so `q` types a q on this screen:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
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
```

`Update` answers the two login messages. Success leaves the form for the
list and asks for the list the login made reachable; failure becomes a
notice and nothing else, so the form stays and keeps its text:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
	case loggedInMsg:
		// The session is in the client's jar; the list it makes reachable
		// is the login's follow-up. The notice of a failed attempt goes
		// with the failure.
		m.mode = modeList
		m.notice = notice{}
		return m, loadTasks(m.ctx, m.client)
	case loginErrMsg:
		m.notice = notice{text: msg.err.Error(), problem: true}
		return m, nil
```

The request itself lives in a command, where every request lives — the model
never blocks on the API:

<!-- verify: internal/tui/tui.go at=tui-client -->
```go title="internal/tui/tui.go"
// login is the login command: authenticate and report back as a loggedInMsg
// or a loginErrMsg. The command is where the request lives — the model
// itself never blocks on the API — and the session needs no message: it
// lands in the client's cookie jar.
func login(ctx context.Context, c Client, email, password string) tea.Cmd {
	return func() tea.Msg {
		if err := c.Login(ctx, email, password); err != nil {
			return loginErrMsg{err: fmt.Errorf("sign in: %w", err)}
		}
		return loggedInMsg{}
	}
}
```

`switchField` blurs the focused field and focuses the other; `updateLogin`
hands every other message to whichever field has the focus; and `submitLogin`
hands the two field values to the login command. The keyboard dispatch gains
the form too: `updateKey` sends a key to `updateLoginKey` while the form is
the mode, and `Update`'s fall-through sends everything else to `updateLogin`.

The frame before a session exists is a view of its own: the sign-in header,
the two fields, the notice a failed attempt leaves, and the form's keys.
`View` returns it while the form is the mode:

<!-- verify: internal/tui/view.go at=tui-client -->
```go title="internal/tui/view.go"
	switch {
	case m.mode == modeLogin:
		return m.loginView()
```

<!-- verify: internal/tui/view.go at=tui-client -->
```go title="internal/tui/view.go"
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
```

The help line follows the focus, the way it already did in the add mode:
`activeKeys` returns the form's key map, and `resize` gives the two new
inputs widths the same way it gives the add input one. `keys.go` gains the
form's map:

<!-- verify: internal/tui/keys.go at=tui-client -->
```go title="internal/tui/keys.go"
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
```

The map's short and full help follow the same shape as the input's.

## The wiring shrinks

The binary loses its store opener and gains the client. The package comment
says what changed:

<!-- verify: cmd/todo-tui/main.go at=tui-client -->
```go title="cmd/todo-tui/main.go"
// Command todo-tui is the todo application's terminal UI: a Bubble Tea
// program over the HTTP API. It signs in like any other API client — the
// session cookie lands in internal/client's jar — and every list, add, and
// complete is one request to the server the CLI's database lives behind. The
// wiring is this file — configuration, the client, the program — and the
// model lives in internal/tui.
package main
```

The imports trade `store` and `filepath` for `client`; the `--db` flag
becomes `--api`; and the signal context that made store calls cancellable
now makes requests cancellable:

<!-- verify: cmd/todo-tui/main.go at=tui-client -->
```go title="cmd/todo-tui/main.go"
// run resolves the configuration, builds the client, and runs the program.
// It returns the process's exit code: 0 after a clean quit, 1 after printing
// the one error line.
func run() int {
	// A first interrupt or SIGTERM cancels ctx: a request in flight — a
	// login, a load — aborts with a context error instead of the process
	// dying mid-call. The program's own exit on a signal is Bubble Tea's —
	// it quits the event loop and restores the terminal — so this context
	// is only the commands'.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// One flag, so the stdlib flag package is enough — the same choice
	// cmd/todo-server made. A parse error exits 2 with the usage, the
	// convention Go's own tools follow.
	apiFlag := flag.String("api", "", "API base URL; overrides $TODO_API_URL and the "+config.DefaultAPIURL+" default")
	flag.Parse()

	// The TUI resolves the one setting it needs. It deliberately does not
	// call config.Load: the database path and the log path are not the
	// TUI's to resolve, and requiring HOME for a database the TUI never
	// opens would be a promise the binary does not keep.
	c := client.New(config.APIURL(os.Getenv, *apiFlag))
```

The rest of `run` is the program and the exit rules:

<!-- verify: cmd/todo-tui/main.go at=tui-client -->
```go title="cmd/todo-tui/main.go"
	// q and ctrl+c both leave through tea.Quit, and Run returns nil. A
	// SIGINT that reaches the process outside the raw terminal — input is
	// not a TTY — arrives as ErrInterrupted, which is the same request to
	// stop, not a failure. Everything else — a kill, a renderer error — is
	// an error, and the one line and the exit code are the report.
	if _, err := tui.NewProgram(tui.New(ctx, c)).Run(); err != nil && !errors.Is(err, tea.ErrInterrupted) {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}
```

The store opener is gone entirely — no database is opened, no folder is
created. The one setting the binary resolves is the API's address, and the
program runs exactly as before.

## Run it

Start the server as before, with an account registered and a few tasks in
it, then start the interface. The first frame is the sign-in form — the
email placeholder showing, the cursor sitting on it, the form's keys on the
last line:

```text
todo: sign in

email: you@example.com
password:

enter sign in    tab next field    ctrl+c quit
```

Type the email, press `tab`, type the password — the component masks it, so
the text never reaches a frame — and press `enter`:

```text
todo: sign in

email: alice@example.com
password: ****************************

enter sign in    tab next field    ctrl+c quit
```

The list the login loaded: four tasks, one done, the cursor on the first
row. On an 80-column terminal the help renders as columns; on a narrow one,
as one line:

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

`a` opens the input, the add travels to the server, and the answer selects
the new row. Then the moment the store could never show us: another client
completes a task between our read and our write. The interface still holds
the older version, presses `enter`, and the server refuses the stale write:

```text
todo: 5 tasks

  [ ] write the chapter
> [x] buy milk
  [x] ship it
  [ ] water the plants
  [ ] call the plumber

"buy milk" changed elsewhere; list refreshed

a     add         ↓/j move down
enter complete    ↑/k move up
                  r   reload
                  q   quit
```

The refresh that follows shows the other client's write — `[x] buy milk` —
and the cursor stayed on the row. A complete of our own confirms with a
notice:

```text
todo: 5 tasks

> [x] write the chapter
  [x] buy milk
  [x] ship it
  [ ] water the plants
  [ ] call the plumber

completed "write the chapter"

a     add         ↓/j move down
enter complete    ↑/k move up
                  r   reload
                  q   quit
```

Read the final state back through the client: the conflict left the other
writer's write in place, our own write landed, and the two untouched tasks
are still at version 1:

```text
write the chapter  Done v2
buy milk           Done v2
ship it            Done v2
water the plants   Todo v1
call the plumber   Todo v1
```

The binary's one flag, from `--help`:

```text
Usage of ./todo-tui:
  -api string
    	API base URL; overrides $TODO_API_URL and the http://127.0.0.1:8080 default
```

Quit with `q`, and the terminal is as you left it. The whole suite passes:

```bash
$ go test -count=1 ./...
...
ok  	todo/internal/client	0.603s
ok  	todo/internal/config	0.007s
...
ok  	todo/internal/tui	2.195s
```

Everything passes together.

## If something went wrong

**`todo/internal/client: no non-test Go files in …/internal/client`.** Go
refuses to build a package that is only a test. The message:

```text
todo/internal/client: no non-test Go files in …/internal/client
FAIL	todo/internal/client [build failed]
```

Write `client.go` — the package clause alone moves the error to its next
layer.

**`*fakeClient does not implement "todo/internal/store".Store (missing
method Add)`.** The tests now hand `tui.New` a fake client, and `New` still
asks for a store. The message:

```text
# todo/internal/tui_test [todo/internal/tui.test]
internal/tui/program_test.go:71:58: cannot use f (variable of type *fakeClient) as "todo/internal/store".Store value in argument to tui.New: *fakeClient does not implement "todo/internal/store".Store (missing method Add)
...
internal/tui/tui_test.go:246:37: too many errors
FAIL	todo/internal/tui [build failed]
FAIL
```

The seam hasn't moved. Fix: the interface belongs to the consumer —
`New(ctx, Client)` — and the compiler goes quiet.

**`undefined: config.DefaultAPIURL`.** The precedence table arrived with the
tests, and the names don't exist yet. The message:

```text
internal/config/config_test.go:256:17: undefined: config.DefaultAPIURL
internal/config/config_test.go:278:17: undefined: config.DefaultAPIURL
internal/config/config_test.go:291:36: undefined: config.APIURL
```

Fix: `DefaultAPIURL` — `DefaultListen` as a URL — and `APIURL`, which
mirrors `Listen`'s rule. Those two names are the whole of config's change.

**The sign-in lands on a dead port, and the notice carries the whole
sentence.** Point the interface at a port nothing listens on —
`./todo-tui --api http://127.0.0.1:1` — and sign in. The notice is the
wrapped error, cut to the terminal's width:

```text
sign in: POST /api/v1/auth/login: Post "http://127.0.0.1:1/api/v1/auth/login": …
```

The full error the notice is cut from:

```text
POST /api/v1/auth/login: Post "http://127.0.0.1:1/api/v1/auth/login": dial tcp 127.0.0.1:1: connect: connection refused
```

Nothing listens where the flag points; `attempt` reports the exchange and
the login command wraps it as `sign in: …`. The login is a write, so it is
not retried. Fix: point `--api` at the running server. The form kept its
text, so the fix is a keystroke, not a retype.

<details>
<summary>Going deeper: why a failed write is never retried</summary>

A read that fails is a read that did not happen, so trying it again is free.
A write that fails is a write that may have happened: the request can reach
the server and be applied after the connection breaks.

The compare-and-swap makes the second write safe — it would be refused as a
stale snapshot — but not truthful: it would report a conflict for a write
that succeeded. So the policy has a direction, not a symmetry: reads retry,
writes are reported once.

</details>

<details>
<summary>Going deeper: where the session lives</summary>

The session is the cookie jar, not the model and not a message. The login's
response carries the session cookie; the jar stores it and shows it on every
later request. The API marks the cookie `Secure`, which browsers read as
"https only" — but Go's jar follows the browser rule that loopback addresses
are secure origins, so the local flow over `http://127.0.0.1:8080` works
while a deployed client must be https.

And because the jar is the session, a second client is a second login.

</details>

<details>
<summary>Going deeper: why the model defines the interface</summary>

The model could have imported `internal/client` and called it directly.
Instead it declares the four calls it needs, and the client happens to fit.
That keeps the dependency pointing one way — the implementation depends on
the consumer's contract, not the other way around — and it is what lets the
tests hand the model a fake instead of a server.

The interface is narrow on purpose. The API has more routes — update,
delete, register — and a client that mirrored all of them would be a second
copy of the API's surface to keep in step. A consumer widens the interface
when it needs to, and the compiler points at every implementation that must
grow with it.

</details>

The interface speaks the API now, and its model never learned how. Next it
gets something the screen can't show: a quiet log of its own.

<div class="day-tracker" data-day="51"></div>
