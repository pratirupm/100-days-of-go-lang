---
title: "internal/client — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/client/client.go`

````go
// Package client is the TUI's typed client over the application's REST API:
// login, list, create, and complete — the four operations the task list
// performs — with the session cookie carried in a jar, a timeout on every
// attempt, and a retry policy that knows reads from writes.
//
// The client is the API's consumer, so it speaks the API's contract exactly:
// the one error shape decodes into Error — code for branching, message for
// showing — a task's version rides out with the read and back with the
// write, and a stale write's 409, the API's rendering of the store's
// compare-and-swap, comes back as the domain's store.ErrConflict, so a
// caller keeps the branch it had when the store answered directly. The
// routes, statuses, and envelopes are internal/api's; this package consumes
// them without a second vocabulary.
//
// The one consumer is internal/tui, which defines the interface it needs at
// the seam; this package is the implementation behind it, and cmd/todo-tui
// wires the two. The rest of the API's surface — update, delete, register —
// arrives when a consumer needs it, not before.
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

// codeConflict is the one API code the client branches on. The codes are the
// API's stable vocabulary (internal/api/error.go); the client spells the one
// it uses so the wire contract is visible where it is consumed.
const codeConflict = "conflict"

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

// Login signs in and leaves the session in the jar: the API sets the session
// cookie on the response, the jar stores it, and every request after this
// one carries it. A failed login returns the API's *Error — the 401 whose
// message names neither half of the credentials, on purpose. The response
// body — the user — is not decoded: the session is what the caller needs,
// and the jar is where it lands.
func (c *Client) Login(ctx context.Context, email, password string) error {
	return c.doWrite(ctx, http.MethodPost, "/api/v1/auth/login", loginRequest{Email: email, Password: password}, nil)
}

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

// doWrite performs a write — POST or PATCH — and never retries. A write that
// timed out may have been applied: a retry would be a second write whose
// answer cannot say whether the first one landed, and the API's
// compare-and-swap would refuse the retry as a stale snapshot — a conflict
// reported for a write that succeeded. So a failed write is reported, once,
// and the caller decides; the TUI's answer is a reload and a notice.
func (c *Client) doWrite(ctx context.Context, method, path string, body, out any) error {
	return c.attempt(ctx, method, path, body, out)
}

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

// isConflict reports whether a failure is the API's stale-snapshot conflict.
// The code is the half of the error contract that is safe to branch on; the
// message is prose.
func isConflict(err error) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && apiErr.Code == codeConflict
}

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

// taskListResponse is the collection's envelope: the tasks key is always an
// array, so an empty list decodes to an empty slice, not to a missing key.
type taskListResponse struct {
	Tasks []taskResponse `json:"tasks"`
}

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
````


## `internal/client/client_test.go`

````go
// Package client_test exercises the client the TUI speaks through. The
// contract cases run against the real API — the real middleware stack, the
// real session manager, the real auth service over a fresh database — behind
// a real listener, and the client goes over TCP to reach it: nothing here
// calls ServeHTTP directly, because the client's whole job is the wire. The
// policy cases (retries, the context's budget) run against scripted handlers,
// which is the instrument for a policy rather than a route.
package client_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"

	_ "turso.tech/database/tursogo" // registers the "turso" driver with database/sql

	"todo/internal/api"
	"todo/internal/auth"
	"todo/internal/client"
	"todo/internal/db"
	"todo/internal/store"
	"todo/internal/task"
	"todo/internal/telemetry"
)

// openAuthDB opens a fresh database in the store's open order — MVCC first,
// then the embedded migrations — for the cases that need a real auth service.
// The service's writes ride BEGIN CONCURRENT, which the engine only accepts
// under MVCC.
func openAuthDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := sql.Open("turso", filepath.Join(t.TempDir(), "client.db")+"?_busy_timeout=5000")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

	var mode string
	require.NoError(t, sqlDB.QueryRow(`PRAGMA journal_mode = mvcc`).Scan(&mode))
	require.Equal(t, "mvcc", mode)
	require.NoError(t, db.Up(context.Background(), sqlDB))
	return sqlDB
}

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
		otel.GetTracerProvider(),
		telemetry.NewRegistry(),
	))
	t.Cleanup(srv.Close)
	return srv, st
}

// The fixed credentials every case registers and logs in with. Each case
// gets its own database, so the email is never taken.
const (
	testEmail    = "alice@example.com"
	testPassword = "correct horse battery staple"
)

// signUp registers the user through the API's own route and returns the new
// id. The client has no register — the TUI's flow is login-only — so the
// case drives the route the way a browser would: one POST, checked.
func signUp(t *testing.T, srv *httptest.Server, email, password string) uuid.UUID {
	t.Helper()
	body := fmt.Sprintf(`{"email":%q,"password":%q}`, email, password)
	resp, err := http.Post(srv.URL+"/api/v1/auth/register", "application/json", strings.NewReader(body))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var user struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&user))
	id, err := uuid.Parse(user.ID)
	require.NoError(t, err)
	return id
}

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

// seed writes one Todo task per title through a store view and returns what
// the store stored.
func seed(t *testing.T, s store.Store, titles ...string) []task.Task {
	t.Helper()
	var stored []task.Task
	for _, title := range titles {
		added, err := s.Add(context.Background(), task.Task{Title: title, Status: task.StatusTodo, Priority: task.PriorityDefault})
		require.NoError(t, err)
		stored = append(stored, added)
	}
	return stored
}

// titles maps tasks to their titles, for order-sensitive assertions.
func titles(tasks []task.Task) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.Title
	}
	return out
}

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

// TestClient_Login pins both ends of the login: a wrong password is the
// API's 401 in the one error shape, and a right one leaves the session in
// the jar — proven by the next call, which the API answers as the
// authenticated user.
func TestClient_Login(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	signUp(t, srv, testEmail, testPassword)
	c := client.New(srv.URL)

	err := c.Login(context.Background(), testEmail, "wrong password")
	var apiErr *client.Error
	require.ErrorAs(t, err, &apiErr, "the API's failure decodes into the one error type")
	assert.Equal(t, http.StatusUnauthorized, apiErr.StatusCode)
	assert.Equal(t, "unauthorized", apiErr.Code)
	assert.Equal(t, "invalid email or password", err.Error())

	require.NoError(t, c.Login(context.Background(), testEmail, testPassword))
	_, err = c.ListTasks(context.Background())
	assert.NoError(t, err, "the session cookie rides every request after the login")
}

// TestClient_Unauthorized pins the gate from the client's side: a client
// that never logged in gets the API's 401, decoded, not a bare status.
func TestClient_Unauthorized(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	c := client.New(srv.URL)

	_, err := c.ListTasks(context.Background())

	var apiErr *client.Error
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusUnauthorized, apiErr.StatusCode)
	assert.Equal(t, "unauthorized", apiErr.Code)
	assert.Equal(t, "authentication required", err.Error())
}

// TestClient_CreateTask pins the write and its round trip: the API assigns
// the id and the version, the client decodes them, and the task the store
// holds is the one the request described — due date and tags included.
func TestClient_CreateTask(t *testing.T) {
	t.Parallel()

	srv, st := newTestServer(t)
	c, userID := signedIn(t, srv)
	due := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)

	created, err := c.CreateTask(context.Background(), task.Task{
		Title:    "water the plants",
		Status:   task.StatusTodo,
		Priority: 4,
		Due:      due,
		Tags:     []string{"home"},
	})

	require.NoError(t, err)
	assert.NotEqual(t, uuid.Nil, created.ID)
	assert.Equal(t, 1, created.Version, "the API assigns the version")
	assert.Equal(t, "water the plants", created.Title)
	assert.Equal(t, task.Priority(4), created.Priority)
	assert.Equal(t, due, created.Due.UTC())
	assert.Equal(t, []string{"home"}, created.Tags)

	stored, err := st.Scoped(userID).Get(context.Background(), created.ID)
	require.NoError(t, err)
	assert.Equal(t, "water the plants", stored.Title, "the write reached the store the API serves")
}

// TestClient_Complete pins the compare-and-swap end to end: the write
// carries the version the caller read, the store marks the task done, and
// the version moves — which is what the next read must carry back.
func TestClient_Complete(t *testing.T) {
	t.Parallel()

	srv, st := newTestServer(t)
	c, userID := signedIn(t, srv)
	stored := seed(t, st.Scoped(userID), "write the chapter")

	err := c.Complete(context.Background(), stored[0].ID, stored[0].Version)

	require.NoError(t, err)
	got, err := st.Scoped(userID).Get(context.Background(), stored[0].ID)
	require.NoError(t, err)
	assert.Equal(t, task.StatusDone, got.Status)
	assert.Equal(t, stored[0].Version+1, got.Version)
}

// TestClient_CompleteConflict pins the chapter's conflict story from the
// consumer's side: a write whose snapshot moved on is a 409 on the wire, and
// the client hands it back as the domain's stale-snapshot sentinel, so a
// caller that branched on store.ErrConflict when the store answered directly
// keeps the same branch.
func TestClient_CompleteConflict(t *testing.T) {
	t.Parallel()

	srv, st := newTestServer(t)
	c, userID := signedIn(t, srv)
	stored := seed(t, st.Scoped(userID), "write the chapter")

	// Someone else completes the task between the read and the write —
	// the CLI, or another TUI. The version the client holds is now stale.
	require.NoError(t, st.Scoped(userID).Complete(context.Background(), stored[0].ID, stored[0].Version))

	err := c.Complete(context.Background(), stored[0].ID, stored[0].Version)

	require.ErrorIs(t, err, store.ErrConflict, "the wire's 409 is the domain's conflict")

	got, err := st.Scoped(userID).Get(context.Background(), stored[0].ID)
	require.NoError(t, err)
	assert.Equal(t, task.StatusDone, got.Status, "the other writer's write stands")
	assert.Equal(t, stored[0].Version+1, got.Version)
}

// TestClient_ValidationFields pins the 422's shape: the code is stable, and
// the field failures arrive as data — and as prose, because Error() is what
// a caller shows a user.
func TestClient_ValidationFields(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	c, _ := signedIn(t, srv)

	_, err := c.CreateTask(context.Background(), task.Task{Title: "", Priority: task.PriorityDefault})

	var apiErr *client.Error
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusUnprocessableEntity, apiErr.StatusCode)
	assert.Equal(t, "validation_failed", apiErr.Code)
	require.Len(t, apiErr.Fields, 1)
	assert.Equal(t, "title", apiErr.Fields[0].Field)
	assert.Equal(t, "cannot be empty", apiErr.Fields[0].Message)
	assert.Equal(t, "validation failed: title cannot be empty", err.Error())
}

// TestClient_ErrorFallback pins the error shape's fallback: a response that
// is not the API's JSON — a proxy's HTML, a truncated stream — still becomes
// an *Error, with the status text for a message. The client never hands a
// caller a raw decode failure for a response that arrived.
func TestClient_ErrorFallback(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("<html>not the api's shape</html>"))
	}))
	t.Cleanup(srv.Close)

	_, err := client.New(srv.URL).ListTasks(context.Background())

	var apiErr *client.Error
	require.ErrorAs(t, err, &apiErr)
	assert.Equal(t, http.StatusInternalServerError, apiErr.StatusCode)
	assert.Equal(t, "Internal Server Error", err.Error())
}

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

// TestClient_RetryBoundedByTheCallersDeadline pins the retry loop's budget:
// the caller's context, not the client's constants, decides how many
// attempts fit. A deadline that leaves room for one retry ends the loop
// there — the third attempt never leaves the process.
func TestClient_RetryBoundedByTheCallersDeadline(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	_, err := client.New(srv.URL).ListTasks(ctx)

	require.Error(t, err)
	assert.LessOrEqual(t, calls.Load(), int32(2), "the deadline, not maxAttempts, ended the retries")
}

// TestClient_ContextDeadlineStopsTheRead pins the other end of the budget: a
// read against a server that does not answer is cut off when the caller's
// deadline passes, not when the server finally would have — and no retry is
// attempted with a budget that is already gone.
func TestClient_ContextDeadlineStopsTheRead(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		time.Sleep(500 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := client.New(srv.URL).ListTasks(ctx)

	require.Error(t, err)
	assert.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Equal(t, int32(1), calls.Load(), "a caller whose budget is gone gets no retry")
	assert.Less(t, time.Since(start), 400*time.Millisecond, "the deadline, not the handler, ended the wait")
}
````
