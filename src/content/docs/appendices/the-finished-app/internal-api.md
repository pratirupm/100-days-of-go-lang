---
title: "internal/api — the finished app"
description: "The finished app, file by file: internal/api (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/api/api.go`

````go
// Package api is the application's HTTP surface. New builds an echo server
// around the store, the authenticator, the session manager, the process
// logger, the tracer provider, and the metrics registry: liveness and
// readiness endpoints, the task CRUD routes under /api/v1, the auth routes
// beside them, the ordered middleware stack — see middleware.go — a
// validator wired onto the echo instance, one error handler that renders
// every failure in one shape, the scrape endpoint at /metrics, the profiles
// behind the admin gate at /debug/pprof, and the generated OpenAPI spec
// served as Swagger UI at /swagger (see internal/api/docs).
package api

import (
	"log/slog"
	"net/http"
	"net/http/pprof"

	"github.com/alexedwards/scs/v2"
	"github.com/labstack/echo/v4"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	echoSwagger "github.com/swaggo/echo-swagger"
	"go.opentelemetry.io/otel/trace"

	// The generated spec, imported for its side effect: its init registers
	// the document with swag, which is where the UI handler reads it from.
	_ "todo/internal/api/docs"
	"todo/internal/store"
)

// New builds the API around a store, an authenticator, a session manager, and
// a logger.
//
// The two health endpoints split the two questions a supervisor asks.
// /healthz is liveness: is the process up and answering? It touches no
// dependency — a process whose database is briefly away is still alive, and
// reporting it dead makes a supervisor restart something that was working.
// /ready is readiness: can the process serve traffic? It pings the store with
// Stats and answers 503 when the dependency is unreachable, so a load
// balancer stops sending work until the dependency is back.
//
// The task routes are the chapter's CRUD surface: GET and POST on the
// collection, GET, PATCH, and DELETE on a task. Every write carries the
// version the caller read, which is the store's compare-and-swap on the wire
// (see tasks.go), and every failure leaves as one JSON shape (see error.go).
// The validator is wired here, once, because echo's c.Validate consults the
// instance and a request validated without one fails with echo's own
// "validator not registered" error.
//
// The auth routes (see auth.go) are three handlers over the authenticator,
// and the session layer they lean on is installed in the stack (see
// useStack). The manager arrives configured — NewSessionManager is where the
// cookie policy lives — so this constructor does not re-decide it.
//
// Echo's default JSON serializer is kept: one serializer, one wire format,
// no surprises. The middleware stack is installed on the instance rather
// than on the /api/v1 group: the health endpoints, and from chapter 36 the
// web pages, are the same process's requests and deserve the same ids,
// records, deadlines, and headers — a group-scoped stack would have to be
// installed a second time for them.
//
// The generated spec and its UI are served publicly, and the decision is
// deliberate. The spec documents routes an anonymous caller can already
// probe — every task route answers 401 without a session, and that refusal
// is itself the disclosure — and it carries no data, only shapes. Gating it
// would also break the UI's own login flow: the page a client would log in
// through is the page the gate would refuse. What a gate would buy — hiding
// the API's shape on a deployed instance — is a deployment question
// (chapter 48), and the route is registered here, in one line, so that
// answer has one place to change.
//
// The observability wiring is two parameters and the routes that expose
// them. tp is the tracer provider the stack's trace middleware starts spans
// with; reg is the metrics registry the request collectors register on and
// /metrics serves. Both are process-level pieces built by
// internal/telemetry, so this constructor receives them rather than
// creating them — a test builds a registry of its own and a provider with
// nothing to export, and the scrape endpoint shows exactly what the process
// registered.
func New(st store.Store, authn Authenticator, sessions *scs.SessionManager, logger *slog.Logger, tp trace.TracerProvider, reg *prometheus.Registry) *echo.Echo {
	s := &server{store: st, auth: authn, sessions: sessions}
	metrics := newRequestMetrics(reg)

	e := echo.New()
	e.Validator = newRequestValidator()
	e.HTTPErrorHandler = s.handleError

	// The client address, and the one trust decision the deployment makes
	// here: chapter 48's Caddy sits on loopback, so the transport peer every
	// request arrives from is the proxy — and a limiter keyed on the socket
	// would hand the whole internet one bucket. The extractor takes the
	// nearest untrusted entry of X-Forwarded-For instead (echo's rule, and
	// the reason it walks from the right: a client's own prefix sits left of
	// the address the proxy appended). The trust list is loopback and
	// nothing else — deliberately not echo's default of loopback, link-local
	// and private — because the unit binds 127.0.0.1 (see deploy/): the only
	// peer that may speak for a client is the proxy on this host, and a
	// topology that moves the proxy elsewhere is a deliberate edit to these
	// options, not a silent widening. The extractor is also what keeps
	// RealIP's legacy path — which believes X-Real-IP from any peer, the
	// thing chapter 39 rejected — out of the process entirely.
	e.IPExtractor = echo.ExtractIPFromXFFHeader(
		echo.TrustLoopback(true),
		echo.TrustLinkLocal(false),
		echo.TrustPrivateNet(false),
	)

	useStack(e, logger, sessions, tp, metrics)

	e.GET("/healthz", s.healthz)
	e.GET("/ready", s.ready)

	// The scrape endpoint: the registry's own text, through the library's
	// handler, under the same stack as every other route. The exposure
	// decision is the same one the health endpoints made — the default
	// listen address is loopback, the body is counters and gauges with no
	// task data in it, and a Prometheus server that had to authenticate
	// first would be a scraper configured with a session cookie. What a
	// scrape does leak — route names, traffic volumes, the runtime's
	// internals — is why chapter 48's deployment decides the network
	// boundary, and why the profiles below are gated while this is not:
	// a heap profile is process memory, and memory can hold anything.
	e.GET("/metrics", echo.WrapHandler(promhttp.HandlerFor(reg, promhttp.HandlerOpts{})))

	// The profiles, behind the admin gate. The standard library's handlers
	// are mounted explicitly — Index serves the runtime's profiles by name
	// (heap, goroutine, allocs, block, mutex, threadcreate), and the four
	// others are handlers of their own — rather than through the package's
	// global mux (whose init still registers them, but nothing serves it):
	// what this server serves is what this file names, and no other
	// package's registration can leak into the route table. The group
	// carries RequireUser then RequireAdmin, so an anonymous caller gets
	// the one 401 shape before any lookup runs and an authenticated
	// non-admin gets the named 403 (see RequireAdmin).
	//
	// The exposure decision is the chapter's risk beat: a heap profile is
	// the process's memory, and memory holds session tokens, password
	// material, and whatever a future handler leaves in it — so the
	// profiles are the one surface here that is never public, on any
	// deployment. The admin flag is the same one the CLI's grant sets,
	// which is how the first admin comes to exist.
	profiles := e.Group("/debug/pprof", RequireUser(sessions), RequireAdmin(authn))
	profiles.GET("", echo.WrapHandler(http.HandlerFunc(pprof.Index)))
	profiles.GET("/*", echo.WrapHandler(http.HandlerFunc(pprof.Index)))
	profiles.GET("/cmdline", echo.WrapHandler(http.HandlerFunc(pprof.Cmdline)))
	profiles.GET("/profile", echo.WrapHandler(http.HandlerFunc(pprof.Profile)))
	profiles.GET("/symbol", echo.WrapHandler(http.HandlerFunc(pprof.Symbol)))
	profiles.GET("/trace", echo.WrapHandler(http.HandlerFunc(pprof.Trace)))

	// The versioned API surface: the task routes and the auth routes, under
	// the stack above. The task routes sit behind RequireUser — the session
	// is the identity, and every handler scopes its store view to the
	// authenticated user (see authorization.go) — while the auth routes are
	// the ones an anonymous caller must be able to reach.
	g := e.Group("/api/v1")
	tasks := g.Group("/tasks", RequireUser(sessions))
	tasks.GET("", s.listTasks)
	tasks.POST("", s.createTask)
	tasks.GET("/:id", s.getTask)
	tasks.PATCH("/:id", s.updateTask)
	tasks.DELETE("/:id", s.deleteTask)

	g.POST("/auth/register", s.register)
	g.POST("/auth/login", s.login)
	g.POST("/auth/logout", s.logout)

	// The spec and the UI that renders it, under the same stack as every
	// other route: a documentation request gets an id, a record, a
	// deadline, and the security headers like any other. The handler
	// serves the spec the docs package registered at init — the same
	// document the tests read from disk — plus swagger-ui's assets. The
	// route's own middleware replaces the process CSP with the UI's (see
	// swaggerUIHeaders): swagger-ui is a JavaScript application, and the
	// pages' script-src 'none' would leave it blank. Every other header
	// rides the response unchanged.
	e.GET("/swagger/*", echoSwagger.WrapHandler, swaggerUIHeaders)

	// Echo's default logger writes its banner and startup line to stdout;
	// chapter 29's rule leaves no room for either there — the process
	// announces itself with the structured record main emits — so both are
	// hidden and stdout stays empty.
	e.HideBanner = true
	e.HidePort = true

	return e
}

// server carries the API's dependencies to its handlers. The logger is not
// one of them: since chapter 32 the request's logger travels in the request
// context — see LoggerFrom — so a handler that logs uses the logger that
// already carries the request's id.
type server struct {
	store    store.Store
	auth     Authenticator
	sessions *scs.SessionManager
}

// healthz answers liveness with a fixed body and touches nothing else.
//
//	@Summary		Liveness probe
//	@Description	Reports the process up. Touches no dependency, so a database that is briefly away does not fail it.
//	@Tags			health
//	@Produce		json
//	@Success		200	{object}	map[string]string	"status ok"
//	@Router			/healthz [get]
func (s *server) healthz(c echo.Context) error {
	return c.JSON(http.StatusOK, statusBody("ok"))
}

// ready answers readiness by pinging the store. A store error is 503, not
// 500: the process is fine, its dependency is not. The store's error is not
// echoed to the client — it would leak internals — but it is recorded,
// through the request's logger: why a dependency was away is the one thing
// the request record cannot know, and it belongs in the log next to that
// record, under the same request id.
//
//	@Summary		Readiness probe
//	@Description	Pings the store; answers 503 while the dependency is unreachable.
//	@Tags			health
//	@Produce		json
//	@Success		200	{object}	map[string]string	"status ok"
//	@Failure		503	{object}	map[string]string	"status unavailable"
//	@Router			/ready [get]
func (s *server) ready(c echo.Context) error {
	ctx := c.Request().Context()
	if _, err := s.store.Stats(ctx); err != nil {
		LoggerFrom(ctx).Error("readiness failed", "err", err)
		return c.JSON(http.StatusServiceUnavailable, statusBody("unavailable"))
	}
	return c.JSON(http.StatusOK, statusBody("ok"))
}

// statusBody is the one-key JSON body the health endpoints share.
func statusBody(status string) map[string]string {
	return map[string]string{"status": status}
}
````


## `internal/api/api_test.go`

````go
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

	"github.com/alexedwards/scs/v2"
	"github.com/alexedwards/scs/v2/memstore"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/trace"

	"todo/internal/api"
	"todo/internal/auth"
	"todo/internal/store"
	"todo/internal/telemetry"
)

// The store package's own mock, store_moq_test.go, is a test file of package
// store: it exists only inside store's test binary, so no other package can
// import it. This package generates its own mock of the same interface with
// the same pinned moq version — same generator, one interface, two test
// binaries.
//
//go:generate go run github.com/matryer/moq@v0.8.0 -out store_moq_test.go -pkg api_test ../store Store

// discardLogger is the api tests' logger. The error handler logs unexpected
// failures to it — nothing under test fails unexpectedly, except the case
// that asks it to — and chapter 32's request-logging middleware makes it the
// whole request's.
func discardLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// testTracerProvider returns the production trace pipeline in its off mode:
// spans carry real trace ids — which the record cases assert — and nothing
// is exported, so no test needs a collector. It is the same constructor main
// calls, so the tests exercise the production default rather than a copy of
// it. The off mode has no failure path (no exporter is built), so the helper
// needs no *testing.T.
func testTracerProvider() trace.TracerProvider {
	tp, err := telemetry.NewTracerProvider(context.Background(), "", discardLogger())
	if err != nil {
		panic(err)
	}
	return tp
}

// stubAuth is the api tests' Authenticator for the cases that never touch the
// auth routes: every method panics, the way an unconfigured StoreMock does,
// so a health, task, or middleware test that reached auth would fail loudly
// instead of quietly authenticating someone.
type stubAuth struct{}

// Register panics: no case that uses stubAuth registers users.
func (stubAuth) Register(context.Context, string, string) (auth.User, error) {
	panic("stubAuth.Register called")
}

// Authenticate panics: no case that uses stubAuth logs in.
func (stubAuth) Authenticate(context.Context, string, string) (auth.User, error) {
	panic("stubAuth.Authenticate called")
}

// UserByID panics: no case that uses stubAuth looks a user up by id — the
// profile cases build an authenticator that answers it.
func (stubAuth) UserByID(context.Context, uuid.UUID) (auth.User, error) {
	panic("stubAuth.UserByID called")
}

// Record panics: no case that uses stubAuth audits anything.
func (stubAuth) Record(context.Context, auth.AuditEvent) error {
	panic("stubAuth.Record called")
}

// testUserID is the fixed user the task and middleware cases act as. It is an
// arbitrary v7-shaped UUID: those cases run over an in-memory task store, so
// no users row has to exist for it — the auth cases that need real users
// register them.
var testUserID = uuid.MustParse("0199cafe-0042-7000-8000-000000000034")

// newTestAPI builds the API for the cases that are not about auth: the given
// store, a panicking authenticator, the production session manager over
// scs's in-memory store, the production tracer provider in its off mode, and
// the production registry. The auth cases build their own server — real
// service, real session store, real database — in auth_test.go.
func newTestAPI(st store.Store, logger *slog.Logger) *echo.Echo {
	sessions := api.NewSessionManager(memstore.New())
	return api.New(st, stubAuth{}, sessions, logger, testTracerProvider(), telemetry.NewRegistry())
}

// newTaskAPI builds the API for the task cases and returns it with the
// session cookie of the fixed test user — the session every task route
// requires since chapter 34.
func newTaskAPI(t *testing.T, st store.Store, logger *slog.Logger) (*echo.Echo, *http.Cookie) {
	t.Helper()
	sessions := api.NewSessionManager(memstore.New())
	e := api.New(st, stubAuth{}, sessions, logger, testTracerProvider(), telemetry.NewRegistry())
	return e, testSession(t, sessions)
}

// testSession mints a committed session for the fixed test user and returns
// the cookie that presents it. It goes through the manager's own Load and
// Commit — the two halves LoadAndSave drives — instead of a login route or a
// real login, so no request is logged and no password is hashed: the task and
// middleware cases are about the routes behind the session, not about how a
// session comes to exist, and that story is auth_test.go's. The cookie
// carries the production flags for the same reason the forged one does: it
// travels the way a genuine cookie would.
func testSession(t *testing.T, sessions *scs.SessionManager) *http.Cookie {
	t.Helper()
	ctx, err := sessions.Load(context.Background(), "")
	require.NoError(t, err)
	sessions.Put(ctx, auth.SessionUserID, testUserID.String())
	token, _, err := sessions.Commit(ctx)
	require.NoError(t, err)
	return &http.Cookie{
		Name:     sessions.Cookie.Name,
		Value:    token,
		Path:     "/",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
}

// get drives one request through the handler without a socket and returns
// the recorded response.
func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

// TestHealthz pins liveness: 200 and the exact JSON body. The store is a
// StoreMock with no functions configured, so every store method panics: if
// the handler touched the store at all — even to ping it — this test would
// panic instead of pass.
func TestHealthz(t *testing.T) {
	t.Parallel()

	e := newTestAPI(&StoreMock{}, discardLogger())

	rec := get(t, e, "/healthz")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
}

// TestReady_OK pins readiness with a reachable store: 200, the same body,
// and exactly one Stats call — the ping the endpoint promises.
func TestReady_OK(t *testing.T) {
	t.Parallel()

	st := &StoreMock{
		StatsFunc: func(context.Context) (store.Stats, error) {
			return store.Stats{ByTag: map[string]int{}}, nil
		},
	}
	e := newTestAPI(st, discardLogger())

	rec := get(t, e, "/ready")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"status":"ok"}`, rec.Body.String())
	assert.Len(t, st.StatsCalls(), 1)
}

// TestReady_StoreDown pins readiness with an unreachable store: 503 and the
// unavailable body. The store's own error is not echoed to the client — and
// it is recorded, through the request's logger, so the probe and its cause
// share one request id.
func TestReady_StoreDown(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	st := &StoreMock{
		StatsFunc: func(context.Context) (store.Stats, error) {
			return store.Stats{}, errors.New("database is away")
		},
	}
	e := newTestAPI(st, logger)

	rec := get(t, e, "/ready")

	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.JSONEq(t, `{"status":"unavailable"}`, rec.Body.String())
	assert.Len(t, st.StatsCalls(), 1)
	assert.NotContains(t, rec.Body.String(), "database is away")

	records := logRecords(t, buf)
	require.Len(t, records, 2)
	failure := findRecord(t, records, "readiness failed")
	assert.Equal(t, "database is away", failure.Err)
	assert.Equal(t, failure.RequestID, findRecord(t, records, "request").RequestID)
}

// TestServer_StartShutdown is the lifecycle as a real server lives it: a
// listener, a served request, a graceful shutdown. The listener is injected
// before Start — echo's documented seam — so the port is ephemeral and the
// test never races a bind.
func TestServer_StartShutdown(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	e.Listener = ln

	// Start blocks until Shutdown; the test's own goroutine stays free to
	// send the request and then ask for the shutdown. The listener is
	// already accepting, so the request cannot arrive too early.
	serveErr := make(chan error, 1)
	go func() { serveErr <- e.Start("") }()

	resp, err := http.Get("http://" + ln.Addr().String() + "/healthz")
	require.NoError(t, err)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.JSONEq(t, `{"status":"ok"}`, string(body))

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, e.Shutdown(shutdownCtx))

	// Serve returns http.ErrServerClosed once a clean Shutdown has stopped
	// the listener; anything else would be a real failure.
	require.ErrorIs(t, <-serveErr, http.ErrServerClosed)
}
````


## `internal/api/auth.go`

````go
package api

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"todo/internal/auth"
)

// The auth routes: register, login, and logout under /api/v1/auth. Three
// handlers over the Authenticator interface and the session manager — the
// service and the store live in todo/internal/auth, and the HTTP layer owns
// the shapes, the status codes, and the cookie's lifecycle.
//
// Register creates a user and does not log it in: a 201 means the account
// exists, and the client's next request is the login. The two steps stay
// separate on purpose — an account that was created but never used is a fact
// a client should be able to observe — and login is where a session comes
// into being.
//
// Login puts the user's id in the session under auth.SessionUserID. The
// session manager's LoadAndSave middleware (see useStack) has already loaded
// the session from the request's cookie into the request's context, and it
// commits the session — and sets the cookie — when the response is written.
//
// Logout destroys the session; the middleware answers with the cookie
// cleared, and the row is gone from the store. A logout with no session is
// still a 204: the endpoint's postcondition is "no session", and it is
// already true.

// Authenticator is what the auth handlers need from the auth package: the
// three operations, not the service's database or its hashing. The API is the
// consumer, so the interface is defined here; internal/auth.Service is the
// implementation, and the assertion below is where the two are kept from
// drifting apart.
type Authenticator interface {
	Register(ctx context.Context, email, password string) (auth.User, error)
	Authenticate(ctx context.Context, email, password string) (auth.User, error)
	// UserByID returns the user a session names. It is the admin gate's
	// lookup (see RequireAdmin): the profiles are reachable only by a user
	// whose flag says so, and the flag is read per request rather than
	// carried in the session, so a grant or a revoke takes effect on the
	// next request instead of the next login.
	UserByID(ctx context.Context, id uuid.UUID) (auth.User, error)
	// Record appends an event to the audit trail. The login and logout
	// handlers own happenings the service cannot see — a session's birth
	// and death are the HTTP layer's — and this is how they reach the
	// trail.
	Record(ctx context.Context, e auth.AuditEvent) error
}

// Authenticator's implementation is asserted here, not in auth: this package
// imports auth, and the reverse would be a cycle.
var _ Authenticator = (*auth.Service)(nil)

// registerRequest is the POST /api/v1/auth/register body. The rules are the
// wire shape's: an address the email rule accepts, a password long enough to
// be worth hashing. Both are checked before the service is reached, so a
// malformed registration never costs an argon2id hash.
type registerRequest struct {
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required,min=8,max=128"`
}

// loginRequest is the POST /api/v1/auth/login body. Only presence is checked:
// a login is a credential check, and a password that fails today's
// registration policy is still a wrong password — a 401, not a 422.
type loginRequest struct {
	Email    string `json:"email" validate:"required"`
	Password string `json:"password" validate:"required"`
}

// userResponse is the wire shape of a user: the public fields only. The hash
// has no field here, which makes "the hash never leaves" a property of the
// type rather than of a handler remembering to omit it. IsAdmin is the user's
// own flag, so it is public to the user themselves: it is what a client shows
// and what the CLI's grant makes visible through the next login. The format
// tag is swag's: created_at is an RFC 3339 instant, like every time this API
// speaks.
type userResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at" format:"date-time"`
	IsAdmin   bool      `json:"is_admin"`
}

// newUserResponse converts a domain user to its wire form.
func newUserResponse(u auth.User) userResponse {
	return userResponse{ID: u.ID.String(), Email: u.Email, CreatedAt: u.CreatedAt, IsAdmin: u.IsAdmin}
}

// register answers POST /api/v1/auth/register. A duplicate email is the
// service's ErrEmailTaken, which the one error handler renders as the 409
// with the email_taken code.
//
//	@Summary		Register a user
//	@Description	Creates an account. It does not log the new user in: a 201 means the account exists, and the next request is the login.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			credentials	body		registerRequest	true	"email and password"
//	@Success		201			{object}	userResponse	"the new account"
//	@Failure		400			{object}	errorResponse	"a malformed JSON body"
//	@Failure		409			{object}	errorResponse	"the email is taken"
//	@Failure		415			{object}	errorResponse	"a body that is not JSON"
//	@Failure		422			{object}	errorResponse	"a field failed validation"
//	@Router			/api/v1/auth/register [post]
func (s *server) register(c echo.Context) error {
	var req registerRequest
	if err := bindBody(c, &req); err != nil {
		return err
	}
	if err := c.Validate(&req); err != nil {
		return err
	}
	user, err := s.auth.Register(c.Request().Context(), req.Email, req.Password)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, newUserResponse(user))
}

// login answers POST /api/v1/auth/login. The session is where the login
// lands, and the login is where the session token is re-issued: RenewToken
// deletes the row the presented cookie named and generates a fresh token, so
// a session fixed before the login cannot ride it in — the response's cookie
// is the only live one. Renewal comes before the audit event and the Put: a
// login that cannot renew, or cannot reach the trail, is a failed login with
// nothing privileged left behind, and the trail never records a login that
// did not establish a session. The audit event is written before the session
// is put, and a failed authentication records nothing — no login happened.
//
//	@Summary		Log in
//	@Description	Checks credentials and starts a session. The session cookie rides Set-Cookie; send it back on every task route. The token is re-issued at login, so an earlier cookie for the same session stops working.
//	@Tags			auth
//	@Accept			json
//	@Produce		json
//	@Param			credentials	body		loginRequest	true	"email and password"
//	@Success		200			{object}	userResponse	"the authenticated user"
//	@Header			200			{string}	Set-Cookie		"the session cookie"
//	@Failure		400			{object}	errorResponse	"a malformed JSON body"
//	@Failure		401			{object}	errorResponse	"the credentials did not match"
//	@Failure		415			{object}	errorResponse	"a body that is not JSON"
//	@Failure		422			{object}	errorResponse	"a field failed validation"
//	@Failure		429			{object}	errorResponse	"too many login attempts from this address"
//	@Router			/api/v1/auth/login [post]
func (s *server) login(c echo.Context) error {
	var req loginRequest
	if err := bindBody(c, &req); err != nil {
		return err
	}
	if err := c.Validate(&req); err != nil {
		return err
	}

	ctx := c.Request().Context()
	user, err := s.auth.Authenticate(ctx, req.Email, req.Password)
	if err != nil {
		return err
	}
	if err := s.sessions.RenewToken(ctx); err != nil {
		return err
	}
	if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogin, UserID: user.ID, ActorID: user.ID}); err != nil {
		return err
	}
	s.sessions.Put(ctx, auth.SessionUserID, user.ID.String())
	return c.JSON(http.StatusOK, newUserResponse(user))
}

// logout answers POST /api/v1/auth/logout. Destroy deletes the row now and
// marks the session destroyed, which is what makes the middleware answer
// with a cleared cookie. The trail records the logout before the session is
// destroyed: an event that cannot be written leaves the session in place, so
// the client can retry, while an anonymous logout — no session to destroy —
// records nothing, because nothing happened. A session whose id is not a UUID
// is destroyed without an event: the row is garbage, and logout's
// postcondition is "no session" either way.
//
//	@Summary		Log out
//	@Description	Destroys the session. A logout with no session is still a 204, because the postcondition already holds; the cleared cookie rides Set-Cookie.
//	@Tags			auth
//	@Success		204	"no content"
//	@Header			204	{string}	Set-Cookie	"the cleared session cookie"
//	@Router			/api/v1/auth/logout [post]
func (s *server) logout(c echo.Context) error {
	ctx := c.Request().Context()
	if raw := s.sessions.GetString(ctx, auth.SessionUserID); raw != "" {
		if id, err := uuid.Parse(raw); err == nil {
			if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogout, UserID: id, ActorID: id}); err != nil {
				return err
			}
		}
	}
	if err := s.sessions.Destroy(ctx); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
````


## `internal/api/auth_test.go`

````go
// Package api_test — the auth cases live in this file, apart from the health,
// task, and middleware cases. Every case drives the routes through echo's own
// ServeHTTP entry point against a real auth service and session store over a
// fresh database: the contract is what a client sees — the status, the body,
// and the session cookie — and what reached the tables.
package api_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	_ "turso.tech/database/tursogo" // registers the "turso" driver with database/sql

	"todo/internal/api"
	"todo/internal/auth"
	"todo/internal/db"
	"todo/internal/store"
	"todo/internal/telemetry"
)

// newAuthAPI builds the API the auth cases exercise: a memory task store, the
// real auth service and session store over a fresh database, and the
// production session manager over that store. It returns the instance, the
// manager — the interop case reads the session through it — and the handle,
// for the cases that assert what reached the tables.
func newAuthAPI(t *testing.T, logger *slog.Logger) (*echo.Echo, *scs.SessionManager, *sql.DB) {
	t.Helper()
	sqlDB := openAuthDB(t)
	sessions := api.NewSessionManager(auth.NewSessionStore(sqlDB))
	e := api.New(store.NewMemoryStore(), auth.NewService(sqlDB), sessions, logger, testTracerProvider(), telemetry.NewRegistry())
	return e, sessions, sqlDB
}

// openAuthDB opens a fresh database in the store's open order — MVCC first,
// then the embedded migrations — for the auth cases. The service's writes
// ride BEGIN CONCURRENT, which the engine only accepts under MVCC.
func openAuthDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := sql.Open("turso", filepath.Join(t.TempDir(), "api-auth.db")+"?_busy_timeout=5000")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

	var mode string
	require.NoError(t, sqlDB.QueryRow(`PRAGMA journal_mode = mvcc`).Scan(&mode))
	require.Equal(t, "mvcc", mode)
	require.NoError(t, db.Up(context.Background(), sqlDB))
	return sqlDB
}

// register posts a registration. The registration's own contract is
// TestRegister's subject; the cases that follow only need a user to exist,
// so this helper asserts nothing about the response.
func register(t *testing.T, h http.Handler, email, password string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"email":%q,"password":%q}`, email, password)
	return send(t, h, http.MethodPost, "/api/v1/auth/register", body)
}

// login posts a login. Same posture as register: the caller asserts.
func login(t *testing.T, h http.Handler, email, password string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"email":%q,"password":%q}`, email, password)
	return send(t, h, http.MethodPost, "/api/v1/auth/login", body)
}

// loginAs posts a login presenting a cookie: the renewal case needs a
// session that exists before the login, so the login's re-issue has
// something to replace.
func loginAs(t *testing.T, h http.Handler, cookie *http.Cookie, email, password string) *httptest.ResponseRecorder {
	t.Helper()
	req := request(t, http.MethodPost, "/api/v1/auth/login", fmt.Sprintf(`{"email":%q,"password":%q}`, email, password))
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// loginUser registers and logs one user in through the real routes and
// returns the session cookie and the user's id. The ownership cases use it to
// hold two identities at once; each case gets its own database, so the fixed
// email is never taken.
func loginUser(t *testing.T, h http.Handler, email string) (*http.Cookie, string) {
	t.Helper()
	const password = "correct horse battery staple"
	require.Equal(t, http.StatusCreated, register(t, h, email, password).Code)
	rec := login(t, h, email, password)
	require.Equal(t, http.StatusOK, rec.Code)
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1, "a login sets the session cookie")
	var body struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.NotEmpty(t, body.ID)
	return cookies[0], body.ID
}

// TestRegister pins the registration contract: 201 with the new user's
// public shape — id, email, created_at — and no password material anywhere
// in the body.
func TestRegister(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())

	rec := register(t, e, "Alice@Example.COM", "correct horse battery staple")

	require.Equal(t, http.StatusCreated, rec.Code)
	var body struct {
		ID        string    `json:"id"`
		Email     string    `json:"email"`
		CreatedAt time.Time `json:"created_at"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.NotEmpty(t, body.ID)
	assert.Equal(t, "alice@example.com", body.Email, "the response carries the normalized email")
	assert.WithinDuration(t, time.Now(), body.CreatedAt, time.Minute)
	assert.NotContains(t, rec.Body.String(), "password")
	assert.NotContains(t, rec.Body.String(), "hash")
}

// TestRegister_DuplicateEmail pins the duplicate: 409 in the one error shape,
// with a code of its own so a client can put the message on the email field.
func TestRegister_DuplicateEmail(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	require.Equal(t, http.StatusCreated, register(t, e, "alice@example.com", "correct horse battery staple").Code)

	rec := register(t, e, "ALICE@example.com", "another long password")

	require.Equal(t, http.StatusConflict, rec.Code)
	assert.JSONEq(t, `{"code":"email_taken","message":"email is already registered"}`, rec.Body.String())
}

// TestRegister_Validation pins the 422 contract for registration: one table
// row per rule, each asserting the exact body. The email rules are the wire
// shape's; the password rules are the registration policy's — a login does
// not re-check them (TestLogin_WrongPassword is where a short password is
// simply wrong).
func TestRegister_Validation(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name    string
		body    string
		field   string
		message string
	}{
		{
			name:    "a missing email",
			body:    `{"password":"long enough password"}`,
			field:   "email",
			message: "is required",
		},
		{
			name:    "a malformed email",
			body:    `{"email":"not-an-email","password":"long enough password"}`,
			field:   "email",
			message: "must be a valid email address",
		},
		{
			name:    "a short password",
			body:    `{"email":"alice@example.com","password":"short"}`,
			field:   "password",
			message: "must be at least 8",
		},
		{
			name:    "a long password",
			body:    `{"email":"alice@example.com","password":"` + strings.Repeat("x", 129) + `"}`,
			field:   "password",
			message: "must be at most 128",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			e, _, _ := newAuthAPI(t, discardLogger())

			rec := send(t, e, http.MethodPost, "/api/v1/auth/register", tc.body)

			require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
			assert.JSONEq(t,
				`{"code":"validation_failed","message":"validation failed","fields":[{"field":"`+tc.field+`","message":"`+tc.message+`"}]}`,
				rec.Body.String())
		})
	}
}

// TestLogin_SetsSession is the chapter's first named contract: a correct
// login answers 200 with the user's public shape and sets the session
// cookie, and the cookie carries the hardened flags — Secure, HttpOnly,
// SameSite=Lax, Path=/, and the 24-hour lifetime as both Max-Age and
// Expires.
func TestLogin_SetsSession(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	rec := login(t, e, "alice@example.com", "correct horse battery staple")

	require.Equal(t, http.StatusOK, rec.Code)
	var body struct {
		ID    string `json:"id"`
		Email string `json:"email"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.NotEmpty(t, body.ID)
	assert.Equal(t, "alice@example.com", body.Email)

	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	cookie := cookies[0]
	assert.Equal(t, "__Host-session", cookie.Name)
	assert.NotEmpty(t, cookie.Value)
	assert.True(t, cookie.Secure, "the cookie must not travel over plain http")
	assert.True(t, cookie.HttpOnly, "scripts must not read the session")
	assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
	assert.Equal(t, "/", cookie.Path)
	assert.InDelta(t, int((24 * time.Hour).Seconds()), cookie.MaxAge, 5, "the cookie expires with the session")
	assert.False(t, cookie.Expires.IsZero(), "a persistent cookie carries Expires")
}

// TestLogin_CookieKeysTheStoredSession pins the two ends of the session
// together: the token the client receives in the cookie is the token the
// session was committed under — hashed, per the store's contract — and the
// raw value is nowhere in the table. The next request's cookie therefore
// names the row that this login wrote.
func TestLogin_CookieKeysTheStoredSession(t *testing.T) {
	t.Parallel()

	e, _, sqlDB := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")
	rec := login(t, e, "alice@example.com", "correct horse battery staple")
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)

	sum := sha256.Sum256([]byte(cookies[0].Value))
	var stored string
	require.NoError(t, sqlDB.QueryRow(`SELECT token_hash FROM sessions`).Scan(&stored))
	assert.Equal(t, hex.EncodeToString(sum[:]), stored, "the row is keyed by the hash of the cookie's token")

	var count int
	require.NoError(t, sqlDB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, cookies[0].Value).Scan(&count))
	assert.Zero(t, count, "the raw token is not a key")
}

// TestLogin_WrongPassword is the chapter's second named contract: a wrong
// password is a 401 in the one error shape, with no cookie — and an unknown
// email is the same response, so the endpoint cannot be used to enumerate
// accounts.
func TestLogin_WrongPassword(t *testing.T) {
	t.Parallel()

	for name, email := range map[string]string{
		"a wrong password": "alice@example.com",
		"an unknown email": "nobody@example.com",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			e, _, _ := newAuthAPI(t, discardLogger())
			register(t, e, "alice@example.com", "correct horse battery staple")

			rec := login(t, e, email, "wrong password")

			require.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.JSONEq(t, `{"code":"unauthorized","message":"invalid email or password"}`, rec.Body.String())
			assert.Empty(t, rec.Result().Cookies(), "a failed login sets no session")
		})
	}
}

// TestSession_VisibleToHandlers is the scs x echo interop proof: the session
// the middleware loaded from the request's cookie is readable inside the
// handler through the same manager, and a token nothing holds is an empty
// session, not a forged one. The route is built for the case — no production
// handler reads the session yet; chapter 34's RequireUser is the first — and
// it reads exactly what that middleware will.
func TestSession_VisibleToHandlers(t *testing.T) {
	t.Parallel()

	e, sessions, _ := newAuthAPI(t, discardLogger())
	e.GET("/test/whoami", func(c echo.Context) error {
		id := sessions.GetString(c.Request().Context(), auth.SessionUserID)
		if id == "" {
			return c.NoContent(http.StatusUnauthorized)
		}
		return c.JSON(http.StatusOK, map[string]string{"user_id": id})
	})

	register(t, e, "alice@example.com", "correct horse battery staple")
	loginRec := login(t, e, "alice@example.com", "correct horse battery staple")
	cookies := loginRec.Result().Cookies()
	require.Len(t, cookies, 1)

	var loggedIn struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(loginRec.Body.Bytes(), &loggedIn))

	// The cookie the login set is the cookie the next request presents, and
	// the handler reads the user the session carries.
	req := httptest.NewRequest(http.MethodGet, "/test/whoami", nil)
	req.AddCookie(cookies[0])
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	var body struct {
		UserID string `json:"user_id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	assert.Equal(t, loggedIn.ID, body.UserID, "the session carries the user the login authenticated")

	// A cookie nothing holds is an empty session. The flags and the name
	// match the real cookie's: a forged token travels the way the genuine
	// one would.
	forged := httptest.NewRequest(http.MethodGet, "/test/whoami", nil)
	forged.AddCookie(&http.Cookie{
		Name:     sessions.Cookie.Name,
		Value:    "not-a-real-token",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	rec = httptest.NewRecorder()
	e.ServeHTTP(rec, forged)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

// TestLogout pins the logout contract: 204, the session cookie cleared, the
// row gone — and the same answer whether or not a session was there to
// destroy.
func TestLogout(t *testing.T) {
	t.Parallel()

	t.Run("an existing session is cleared", func(t *testing.T) {
		t.Parallel()

		e, _, sqlDB := newAuthAPI(t, discardLogger())
		register(t, e, "alice@example.com", "correct horse battery staple")
		loginRec := login(t, e, "alice@example.com", "correct horse battery staple")
		cookies := loginRec.Result().Cookies()
		require.Len(t, cookies, 1)

		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
		req.AddCookie(cookies[0])
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		cleared := rec.Result().Cookies()
		require.Len(t, cleared, 1, "logout rewrites the cookie")
		assert.Empty(t, cleared[0].Value)
		assert.Equal(t, -1, cleared[0].MaxAge, "the cookie is expired, not merely emptied")

		var count int
		require.NoError(t, sqlDB.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&count))
		assert.Zero(t, count, "the session row the login wrote is gone")
	})

	t.Run("no session is still 204", func(t *testing.T) {
		t.Parallel()

		e, _, _ := newAuthAPI(t, discardLogger())

		rec := send(t, e, http.MethodPost, "/api/v1/auth/logout", "")

		assert.Equal(t, http.StatusNoContent, rec.Code)
	})
}

// TestAuditTrail pins the trail the three auth happenings leave: a
// registration, a login, and a logout each append one event naming the user
// as both the subject and the actor — and a failed login appends nothing,
// because no login happened.
func TestAuditTrail(t *testing.T) {
	t.Parallel()

	e, _, sqlDB := newAuthAPI(t, discardLogger())
	cookie, userID := loginUser(t, e, "alice@example.com")

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	require.Equal(t, http.StatusNoContent, rec.Code)

	type event struct {
		action string
		user   string
		actor  sql.NullString
	}
	readTrail := func(t *testing.T) []event {
		t.Helper()
		rows, err := sqlDB.Query(`SELECT action, user_id, actor_id FROM audit_events ORDER BY id`)
		require.NoError(t, err)
		defer func() { _ = rows.Close() }()
		var events []event
		for rows.Next() {
			var e event
			require.NoError(t, rows.Scan(&e.action, &e.user, &e.actor))
			events = append(events, e)
		}
		require.NoError(t, rows.Err())
		return events
	}

	events := readTrail(t)
	require.Len(t, events, 3)
	assert.Equal(t, []string{"register", "login", "logout"}, []string{events[0].action, events[1].action, events[2].action})
	for i, e := range events {
		assert.Equal(t, userID, e.user, "event %d names the user", i)
		require.True(t, e.actor.Valid, "event %d has the user as its actor", i)
		assert.Equal(t, userID, e.actor.String)
	}

	// A failed login is not a login: the trail does not move.
	failed := login(t, e, "alice@example.com", "wrong password")
	require.Equal(t, http.StatusUnauthorized, failed.Code)
	assert.Len(t, readTrail(t), 3, "a failed login records nothing")
}

// TestSessionCookie_HostPrefix pins the cookie audit's outcome: the session
// cookie carries the __Host- prefix, and the three constraints the prefix
// requires — Secure, Path=/, no Domain — hold on the cookie the login sets.
// The browser enforces the prefix; the test enforces that the server is
// eligible for it.
func TestSessionCookie_HostPrefix(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	rec := login(t, e, "alice@example.com", "correct horse battery staple")
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	cookie := cookies[0]

	assert.Equal(t, "__Host-session", cookie.Name)
	assert.True(t, cookie.Secure, "a __Host- cookie must be Secure")
	assert.Equal(t, "/", cookie.Path, "a __Host- cookie must be Path=/")
	assert.Empty(t, cookie.Domain, "a __Host- cookie must carry no Domain")
}

// TestLogin_RenewsSession is the fixation contract on the JSON edge: a
// session fixed before the login cannot ride it in — the login response's
// cookie names a different session, and the fixed one is dead.
func TestLogin_RenewsSession(t *testing.T) {
	t.Parallel()

	e, sessions, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	// An anonymous session, the way the login page starts one: the cookie a
	// client would have been given before the credentials ever arrived.
	ctx, err := sessions.Load(context.Background(), "")
	require.NoError(t, err)
	fixedToken, _, err := sessions.Commit(ctx)
	require.NoError(t, err)
	fixed := &http.Cookie{
		Name:     sessions.Cookie.Name,
		Value:    fixedToken,
		Path:     "/",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}

	rec := loginAs(t, e, fixed, "alice@example.com", "correct horse battery staple")
	require.Equal(t, http.StatusOK, rec.Code)

	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	renewed := cookies[0]
	assert.NotEqual(t, fixedToken, renewed.Value, "the login re-issues the session token")

	// The fixed cookie opens nothing; the renewed one opens the task routes.
	assert.Equal(t, http.StatusUnauthorized, sendAs(t, e, fixed, http.MethodGet, "/api/v1/tasks", "").Code)
	assert.Equal(t, http.StatusOK, sendAs(t, e, renewed, http.MethodGet, "/api/v1/tasks", "").Code)
}
````


## `internal/api/authorization.go`

````go
package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/alexedwards/scs/v2"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"todo/internal/auth"
)

// Authorization, apart from authentication. The auth routes (see auth.go)
// decide who a caller is; RequireUser is the gate in front of everything that
// needs to know: the task routes sit behind it, so an anonymous caller never
// reaches a handler, and the authenticated user's id travels in the request's
// context — UserFrom reads it — where every handler's store view is scoped to
// it. The chapter's rule is that the scope lives in the queries, not in the
// handlers: the handler chooses the view, and the store's SQL does the rest.

// RequireUser is the gate: a request without a live session is refused with
// the one 401 shape before any handler runs. The session is the authority —
// the session middleware (see useStack) has already loaded it and checked its
// expiry against the store — so a token that is absent, unknown, or carries an
// id that is not a UUID is the same answer: authentication required, with no
// detail about which half was wrong. A session whose user no longer exists is
// not a case: nothing deletes users, and the audit trail's foreign keys are
// what a deletion would have to answer to first.
func RequireUser(sessions *scs.SessionManager) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			ctx := c.Request().Context()
			id, ok := SessionUser(ctx, sessions)
			if !ok {
				return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
			}
			c.SetRequest(c.Request().WithContext(withUser(ctx, id)))
			return next(c)
		}
	}
}

// SessionUser returns the id of the user the request's session names, and
// whether it names one at all. It is the session-to-identity rule — the
// session middleware has already loaded the session and checked its expiry
// against the store, so the only question left is whether the payload carries
// a user id that parses — and both gates build on it: RequireUser, the JSON
// edge's 401, and internal/web's gate, the pages' redirect. The two edges
// refuse differently because their clients are different; they agree on who
// the caller is, because that answer must be one answer.
func SessionUser(ctx context.Context, sessions *scs.SessionManager) (uuid.UUID, bool) {
	id, err := uuid.Parse(sessions.GetString(ctx, auth.SessionUserID))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

// userKey is the request context's key for the authenticated user's id. It is
// a struct type rather than a string so it cannot collide with a key another
// package sets.
type userKey struct{}

// withUser returns a copy of ctx carrying the authenticated user's id.
// RequireUser is the only setter.
func withUser(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, userKey{}, id)
}

// UserFrom returns the authenticated user's id — the value RequireUser put in
// the request's context — and whether it was there at all. The second return
// is what keeps "no user" from being mistaken for the zero id: uuid.Nil is a
// real scope (the user-less one, the local CLI's tasks), so a helper that
// answered the zero value for an anonymous request would silently serve the
// wrong rows.
func UserFrom(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(userKey{}).(uuid.UUID)
	return id, ok
}

// userID returns the authenticated user's id for a handler behind
// RequireUser. A handler that reaches it without the middleware is a wiring
// bug, and the panic says so: the stack's Recover answers it with a 500, which
// is what a bug gets.
func userID(ctx context.Context) uuid.UUID {
	id, ok := UserFrom(ctx)
	if !ok {
		panic("api: task handler reached without RequireUser")
	}
	return id
}

// RequireAdmin is the gate in front of the profiles: it sits inside
// RequireUser, so the session's user id is already in the request's context,
// and it asks the auth service whether that user carries the admin flag.
// The answer is read from the database on every request, not carried in the
// session, so a grant or a revoke takes effect on the next request rather
// than the next login — a permission that outlives its revocation by a
// session lifetime is a permission the operator cannot take back. The
// lookup is the users table's primary key and the gated traffic is an
// operator's, so the read costs nothing worth counting.
//
// The refusals are the two ways a session can fail this gate, and they are
// different answers on purpose. An id no user holds is a corrupt session —
// nothing deletes users, so the identity is not real — and it gets the same
// 401 a missing session gets. A live user without the flag is authenticated
// and not authorized: a named 403, unlike chapter 34's foreign-task 404,
// because a task's existence is data worth hiding while the profile
// endpoint's existence is public knowledge and the refusal is the honest
// answer. A lookup failure is the server's: it leaves as an error, and the
// one error handler answers the fixed 500.
func RequireAdmin(authn Authenticator) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			ctx := c.Request().Context()
			id, ok := UserFrom(ctx)
			if !ok {
				// Reached without RequireUser above: a wiring bug, answered
				// like the anonymous request it resembles.
				return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
			}
			user, err := authn.UserByID(ctx, id)
			if errors.Is(err, auth.ErrUserNotFound) {
				return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
			}
			if err != nil {
				return err
			}
			if !user.IsAdmin {
				return echo.NewHTTPError(http.StatusForbidden, "admin required")
			}
			return next(c)
		}
	}
}
````


## `internal/api/docs/docs.go`

````go
// Package docs Code generated by swaggo/swag. DO NOT EDIT
package docs

import "github.com/swaggo/swag"

const docTemplate = `{
    "schemes": {{ marshal .Schemes }},
    "swagger": "2.0",
    "info": {
        "description": "{{escape .Description}}",
        "title": "{{.Title}}",
        "contact": {},
        "version": "{{.Version}}"
    },
    "host": "{{.Host}}",
    "basePath": "{{.BasePath}}",
    "paths": {
        "/api/v1/auth/login": {
            "post": {
                "description": "Checks credentials and starts a session. The session cookie rides Set-Cookie; send it back on every task route. The token is re-issued at login, so an earlier cookie for the same session stops working.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "auth"
                ],
                "summary": "Log in",
                "parameters": [
                    {
                        "description": "email and password",
                        "name": "credentials",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.loginRequest"
                        }
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the authenticated user",
                        "schema": {
                            "$ref": "#/definitions/api.userResponse"
                        },
                        "headers": {
                            "Set-Cookie": {
                                "type": "string",
                                "description": "the session cookie"
                            }
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "the credentials did not match",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "429": {
                        "description": "too many login attempts from this address",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/api/v1/auth/logout": {
            "post": {
                "description": "Destroys the session. A logout with no session is still a 204, because the postcondition already holds; the cleared cookie rides Set-Cookie.",
                "tags": [
                    "auth"
                ],
                "summary": "Log out",
                "responses": {
                    "204": {
                        "description": "no content",
                        "headers": {
                            "Set-Cookie": {
                                "type": "string",
                                "description": "the cleared session cookie"
                            }
                        }
                    }
                }
            }
        },
        "/api/v1/auth/register": {
            "post": {
                "description": "Creates an account. It does not log the new user in: a 201 means the account exists, and the next request is the login.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "auth"
                ],
                "summary": "Register a user",
                "parameters": [
                    {
                        "description": "email and password",
                        "name": "credentials",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.registerRequest"
                        }
                    }
                ],
                "responses": {
                    "201": {
                        "description": "the new account",
                        "schema": {
                            "$ref": "#/definitions/api.userResponse"
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "409": {
                        "description": "the email is taken",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/api/v1/tasks": {
            "get": {
                "description": "Lists the authenticated user's tasks. status and tag are filters and cannot be combined.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "List tasks",
                "parameters": [
                    {
                        "enum": [
                            "Todo",
                            "Done"
                        ],
                        "type": "string",
                        "description": "filter by status",
                        "name": "status",
                        "in": "query"
                    },
                    {
                        "type": "string",
                        "description": "filter by tag",
                        "name": "tag",
                        "in": "query"
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the caller's tasks",
                        "schema": {
                            "$ref": "#/definitions/api.taskListResponse"
                        }
                    },
                    "400": {
                        "description": "an invalid filter, or status and tag combined",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            },
            "post": {
                "description": "Creates a task owned by the authenticated user. The title is trimmed and length-checked; a new task starts in Todo with priority 3 unless the body says otherwise.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "Create a task",
                "parameters": [
                    {
                        "description": "the task to create",
                        "name": "task",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.createTaskRequest"
                        }
                    }
                ],
                "responses": {
                    "201": {
                        "description": "the stored task",
                        "schema": {
                            "$ref": "#/definitions/api.taskResponse"
                        },
                        "headers": {
                            "Location": {
                                "type": "string",
                                "description": "the new task's URL"
                            }
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/api/v1/tasks/{id}": {
            "get": {
                "description": "Returns one of the authenticated user's tasks.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "Get a task",
                "parameters": [
                    {
                        "type": "string",
                        "description": "task id (UUIDv7)",
                        "name": "id",
                        "in": "path",
                        "required": true
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the task",
                        "schema": {
                            "$ref": "#/definitions/api.taskResponse"
                        }
                    },
                    "400": {
                        "description": "an id that is not a UUID",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "404": {
                        "description": "no such task in the caller's scope",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            },
            "delete": {
                "description": "Deletes one of the authenticated user's tasks. The version is required on the query string — a DELETE body is not portable — and a stale one is a 409.",
                "tags": [
                    "tasks"
                ],
                "summary": "Delete a task",
                "parameters": [
                    {
                        "type": "string",
                        "description": "task id (UUIDv7)",
                        "name": "id",
                        "in": "path",
                        "required": true
                    },
                    {
                        "type": "integer",
                        "description": "the version the caller read",
                        "name": "version",
                        "in": "query",
                        "required": true
                    }
                ],
                "responses": {
                    "204": {
                        "description": "no content"
                    },
                    "400": {
                        "description": "a missing or unusable version",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "404": {
                        "description": "no such task in the caller's scope",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "409": {
                        "description": "the version is stale",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            },
            "patch": {
                "description": "PATCH semantics: absent fields keep their value, a null due clears the date, and the version the caller read is required. A stale version is a 409, not a lost update.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "Update a task",
                "parameters": [
                    {
                        "type": "string",
                        "description": "task id (UUIDv7)",
                        "name": "id",
                        "in": "path",
                        "required": true
                    },
                    {
                        "description": "the version the caller read, plus the fields to change",
                        "name": "patch",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.updateTaskRequest"
                        }
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the stored task",
                        "schema": {
                            "$ref": "#/definitions/api.taskResponse"
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body or an id that is not a UUID",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "404": {
                        "description": "no such task in the caller's scope",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "409": {
                        "description": "the version is stale",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/healthz": {
            "get": {
                "description": "Reports the process up. Touches no dependency, so a database that is briefly away does not fail it.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "health"
                ],
                "summary": "Liveness probe",
                "responses": {
                    "200": {
                        "description": "status ok",
                        "schema": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "string"
                            }
                        }
                    }
                }
            }
        },
        "/ready": {
            "get": {
                "description": "Pings the store; answers 503 while the dependency is unreachable.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "health"
                ],
                "summary": "Readiness probe",
                "responses": {
                    "200": {
                        "description": "status ok",
                        "schema": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "string"
                            }
                        }
                    },
                    "503": {
                        "description": "status unavailable",
                        "schema": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "string"
                            }
                        }
                    }
                }
            }
        }
    },
    "definitions": {
        "api.createTaskRequest": {
            "type": "object",
            "properties": {
                "due": {
                    "type": "string",
                    "format": "date-time"
                },
                "priority": {
                    "type": "integer",
                    "maximum": 5,
                    "minimum": 1
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                },
                "title": {
                    "type": "string"
                }
            }
        },
        "api.errorResponse": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string"
                },
                "fields": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/api.fieldError"
                    }
                },
                "message": {
                    "type": "string"
                }
            }
        },
        "api.fieldError": {
            "type": "object",
            "properties": {
                "field": {
                    "type": "string"
                },
                "message": {
                    "type": "string"
                }
            }
        },
        "api.loginRequest": {
            "type": "object",
            "required": [
                "email",
                "password"
            ],
            "properties": {
                "email": {
                    "type": "string"
                },
                "password": {
                    "type": "string"
                }
            }
        },
        "api.registerRequest": {
            "type": "object",
            "required": [
                "email",
                "password"
            ],
            "properties": {
                "email": {
                    "type": "string"
                },
                "password": {
                    "type": "string",
                    "maxLength": 128,
                    "minLength": 8
                }
            }
        },
        "api.taskListResponse": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/api.taskResponse"
                    }
                }
            }
        },
        "api.taskResponse": {
            "type": "object",
            "properties": {
                "due": {
                    "type": "string",
                    "format": "date-time"
                },
                "id": {
                    "type": "string"
                },
                "priority": {
                    "type": "integer"
                },
                "status": {
                    "type": "string"
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                },
                "title": {
                    "type": "string"
                },
                "version": {
                    "type": "integer"
                }
            }
        },
        "api.updateTaskRequest": {
            "type": "object",
            "required": [
                "version"
            ],
            "properties": {
                "due": {
                    "type": "string",
                    "format": "date-time"
                },
                "priority": {
                    "type": "integer",
                    "maximum": 5,
                    "minimum": 1
                },
                "status": {
                    "type": "string",
                    "enum": [
                        "Todo",
                        "Done"
                    ]
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                },
                "title": {
                    "type": "string"
                },
                "version": {
                    "type": "integer",
                    "minimum": 1
                }
            }
        },
        "api.userResponse": {
            "type": "object",
            "properties": {
                "created_at": {
                    "type": "string",
                    "format": "date-time"
                },
                "email": {
                    "type": "string"
                },
                "id": {
                    "type": "string"
                },
                "is_admin": {
                    "type": "boolean"
                }
            }
        }
    },
    "tags": [
        {
            "description": "The task CRUD surface. Every route requires a session and is scoped to the caller.",
            "name": "tasks"
        },
        {
            "description": "Registration, login, and logout — the routes an anonymous caller can reach.",
            "name": "auth"
        },
        {
            "description": "Liveness and readiness probes for supervisors, not clients.",
            "name": "health"
        }
    ]
}`

// SwaggerInfo holds exported Swagger Info so clients can modify it
var SwaggerInfo = &swag.Spec{
	Version:          "1.0",
	Host:             "",
	BasePath:         "",
	Schemes:          []string{},
	Title:            "Todo API",
	Description:      "The todo application's HTTP surface: the task CRUD routes\nand the auth routes that gate them.\n\nThe task routes require a session: log in through\n`POST /api/v1/auth/login` first, and the cookie it sets\ncarries the identity on every following request. Every task\nis scoped to the authenticated user, so a task another user\nowns answers exactly what a missing task answers.\n\nEvery failure leaves in one shape — `code`, `message`, and,\non a validation failure, `fields`. The responses named per\noperation are the ones its handler decides; the stack's own\nfailures can arrive on any route in the same shape: 413 for\na body over 64 KiB, 500 for an internal error, 504 for a\nrequest past its ten-second deadline.",
	InfoInstanceName: "swagger",
	SwaggerTemplate:  docTemplate,
	LeftDelim:        "{{",
	RightDelim:       "}}",
}

func init() {
	swag.Register(SwaggerInfo.InstanceName(), SwaggerInfo)
}
````


## `internal/api/docs/swagger.json`

````json
{
    "swagger": "2.0",
    "info": {
        "description": "The todo application's HTTP surface: the task CRUD routes\nand the auth routes that gate them.\n\nThe task routes require a session: log in through\n`POST /api/v1/auth/login` first, and the cookie it sets\ncarries the identity on every following request. Every task\nis scoped to the authenticated user, so a task another user\nowns answers exactly what a missing task answers.\n\nEvery failure leaves in one shape — `code`, `message`, and,\non a validation failure, `fields`. The responses named per\noperation are the ones its handler decides; the stack's own\nfailures can arrive on any route in the same shape: 413 for\na body over 64 KiB, 500 for an internal error, 504 for a\nrequest past its ten-second deadline.",
        "title": "Todo API",
        "contact": {},
        "version": "1.0"
    },
    "paths": {
        "/api/v1/auth/login": {
            "post": {
                "description": "Checks credentials and starts a session. The session cookie rides Set-Cookie; send it back on every task route. The token is re-issued at login, so an earlier cookie for the same session stops working.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "auth"
                ],
                "summary": "Log in",
                "parameters": [
                    {
                        "description": "email and password",
                        "name": "credentials",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.loginRequest"
                        }
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the authenticated user",
                        "schema": {
                            "$ref": "#/definitions/api.userResponse"
                        },
                        "headers": {
                            "Set-Cookie": {
                                "type": "string",
                                "description": "the session cookie"
                            }
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "the credentials did not match",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "429": {
                        "description": "too many login attempts from this address",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/api/v1/auth/logout": {
            "post": {
                "description": "Destroys the session. A logout with no session is still a 204, because the postcondition already holds; the cleared cookie rides Set-Cookie.",
                "tags": [
                    "auth"
                ],
                "summary": "Log out",
                "responses": {
                    "204": {
                        "description": "no content",
                        "headers": {
                            "Set-Cookie": {
                                "type": "string",
                                "description": "the cleared session cookie"
                            }
                        }
                    }
                }
            }
        },
        "/api/v1/auth/register": {
            "post": {
                "description": "Creates an account. It does not log the new user in: a 201 means the account exists, and the next request is the login.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "auth"
                ],
                "summary": "Register a user",
                "parameters": [
                    {
                        "description": "email and password",
                        "name": "credentials",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.registerRequest"
                        }
                    }
                ],
                "responses": {
                    "201": {
                        "description": "the new account",
                        "schema": {
                            "$ref": "#/definitions/api.userResponse"
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "409": {
                        "description": "the email is taken",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/api/v1/tasks": {
            "get": {
                "description": "Lists the authenticated user's tasks. status and tag are filters and cannot be combined.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "List tasks",
                "parameters": [
                    {
                        "enum": [
                            "Todo",
                            "Done"
                        ],
                        "type": "string",
                        "description": "filter by status",
                        "name": "status",
                        "in": "query"
                    },
                    {
                        "type": "string",
                        "description": "filter by tag",
                        "name": "tag",
                        "in": "query"
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the caller's tasks",
                        "schema": {
                            "$ref": "#/definitions/api.taskListResponse"
                        }
                    },
                    "400": {
                        "description": "an invalid filter, or status and tag combined",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            },
            "post": {
                "description": "Creates a task owned by the authenticated user. The title is trimmed and length-checked; a new task starts in Todo with priority 3 unless the body says otherwise.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "Create a task",
                "parameters": [
                    {
                        "description": "the task to create",
                        "name": "task",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.createTaskRequest"
                        }
                    }
                ],
                "responses": {
                    "201": {
                        "description": "the stored task",
                        "schema": {
                            "$ref": "#/definitions/api.taskResponse"
                        },
                        "headers": {
                            "Location": {
                                "type": "string",
                                "description": "the new task's URL"
                            }
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/api/v1/tasks/{id}": {
            "get": {
                "description": "Returns one of the authenticated user's tasks.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "Get a task",
                "parameters": [
                    {
                        "type": "string",
                        "description": "task id (UUIDv7)",
                        "name": "id",
                        "in": "path",
                        "required": true
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the task",
                        "schema": {
                            "$ref": "#/definitions/api.taskResponse"
                        }
                    },
                    "400": {
                        "description": "an id that is not a UUID",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "404": {
                        "description": "no such task in the caller's scope",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            },
            "delete": {
                "description": "Deletes one of the authenticated user's tasks. The version is required on the query string — a DELETE body is not portable — and a stale one is a 409.",
                "tags": [
                    "tasks"
                ],
                "summary": "Delete a task",
                "parameters": [
                    {
                        "type": "string",
                        "description": "task id (UUIDv7)",
                        "name": "id",
                        "in": "path",
                        "required": true
                    },
                    {
                        "type": "integer",
                        "description": "the version the caller read",
                        "name": "version",
                        "in": "query",
                        "required": true
                    }
                ],
                "responses": {
                    "204": {
                        "description": "no content"
                    },
                    "400": {
                        "description": "a missing or unusable version",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "404": {
                        "description": "no such task in the caller's scope",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "409": {
                        "description": "the version is stale",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            },
            "patch": {
                "description": "PATCH semantics: absent fields keep their value, a null due clears the date, and the version the caller read is required. A stale version is a 409, not a lost update.",
                "consumes": [
                    "application/json"
                ],
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "tasks"
                ],
                "summary": "Update a task",
                "parameters": [
                    {
                        "type": "string",
                        "description": "task id (UUIDv7)",
                        "name": "id",
                        "in": "path",
                        "required": true
                    },
                    {
                        "description": "the version the caller read, plus the fields to change",
                        "name": "patch",
                        "in": "body",
                        "required": true,
                        "schema": {
                            "$ref": "#/definitions/api.updateTaskRequest"
                        }
                    }
                ],
                "responses": {
                    "200": {
                        "description": "the stored task",
                        "schema": {
                            "$ref": "#/definitions/api.taskResponse"
                        }
                    },
                    "400": {
                        "description": "a malformed JSON body or an id that is not a UUID",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "401": {
                        "description": "no session",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "404": {
                        "description": "no such task in the caller's scope",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "409": {
                        "description": "the version is stale",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "415": {
                        "description": "a body that is not JSON",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    },
                    "422": {
                        "description": "a field failed validation",
                        "schema": {
                            "$ref": "#/definitions/api.errorResponse"
                        }
                    }
                }
            }
        },
        "/healthz": {
            "get": {
                "description": "Reports the process up. Touches no dependency, so a database that is briefly away does not fail it.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "health"
                ],
                "summary": "Liveness probe",
                "responses": {
                    "200": {
                        "description": "status ok",
                        "schema": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "string"
                            }
                        }
                    }
                }
            }
        },
        "/ready": {
            "get": {
                "description": "Pings the store; answers 503 while the dependency is unreachable.",
                "produces": [
                    "application/json"
                ],
                "tags": [
                    "health"
                ],
                "summary": "Readiness probe",
                "responses": {
                    "200": {
                        "description": "status ok",
                        "schema": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "string"
                            }
                        }
                    },
                    "503": {
                        "description": "status unavailable",
                        "schema": {
                            "type": "object",
                            "additionalProperties": {
                                "type": "string"
                            }
                        }
                    }
                }
            }
        }
    },
    "definitions": {
        "api.createTaskRequest": {
            "type": "object",
            "properties": {
                "due": {
                    "type": "string",
                    "format": "date-time"
                },
                "priority": {
                    "type": "integer",
                    "maximum": 5,
                    "minimum": 1
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                },
                "title": {
                    "type": "string"
                }
            }
        },
        "api.errorResponse": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string"
                },
                "fields": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/api.fieldError"
                    }
                },
                "message": {
                    "type": "string"
                }
            }
        },
        "api.fieldError": {
            "type": "object",
            "properties": {
                "field": {
                    "type": "string"
                },
                "message": {
                    "type": "string"
                }
            }
        },
        "api.loginRequest": {
            "type": "object",
            "required": [
                "email",
                "password"
            ],
            "properties": {
                "email": {
                    "type": "string"
                },
                "password": {
                    "type": "string"
                }
            }
        },
        "api.registerRequest": {
            "type": "object",
            "required": [
                "email",
                "password"
            ],
            "properties": {
                "email": {
                    "type": "string"
                },
                "password": {
                    "type": "string",
                    "maxLength": 128,
                    "minLength": 8
                }
            }
        },
        "api.taskListResponse": {
            "type": "object",
            "properties": {
                "tasks": {
                    "type": "array",
                    "items": {
                        "$ref": "#/definitions/api.taskResponse"
                    }
                }
            }
        },
        "api.taskResponse": {
            "type": "object",
            "properties": {
                "due": {
                    "type": "string",
                    "format": "date-time"
                },
                "id": {
                    "type": "string"
                },
                "priority": {
                    "type": "integer"
                },
                "status": {
                    "type": "string"
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                },
                "title": {
                    "type": "string"
                },
                "version": {
                    "type": "integer"
                }
            }
        },
        "api.updateTaskRequest": {
            "type": "object",
            "required": [
                "version"
            ],
            "properties": {
                "due": {
                    "type": "string",
                    "format": "date-time"
                },
                "priority": {
                    "type": "integer",
                    "maximum": 5,
                    "minimum": 1
                },
                "status": {
                    "type": "string",
                    "enum": [
                        "Todo",
                        "Done"
                    ]
                },
                "tags": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    }
                },
                "title": {
                    "type": "string"
                },
                "version": {
                    "type": "integer",
                    "minimum": 1
                }
            }
        },
        "api.userResponse": {
            "type": "object",
            "properties": {
                "created_at": {
                    "type": "string",
                    "format": "date-time"
                },
                "email": {
                    "type": "string"
                },
                "id": {
                    "type": "string"
                },
                "is_admin": {
                    "type": "boolean"
                }
            }
        }
    },
    "tags": [
        {
            "description": "The task CRUD surface. Every route requires a session and is scoped to the caller.",
            "name": "tasks"
        },
        {
            "description": "Registration, login, and logout — the routes an anonymous caller can reach.",
            "name": "auth"
        },
        {
            "description": "Liveness and readiness probes for supervisors, not clients.",
            "name": "health"
        }
    ]
}
````


## `internal/api/docs/swagger.yaml`

````yaml
definitions:
  api.createTaskRequest:
    properties:
      due:
        format: date-time
        type: string
      priority:
        maximum: 5
        minimum: 1
        type: integer
      tags:
        items:
          type: string
        type: array
      title:
        type: string
    type: object
  api.errorResponse:
    properties:
      code:
        type: string
      fields:
        items:
          $ref: '#/definitions/api.fieldError'
        type: array
      message:
        type: string
    type: object
  api.fieldError:
    properties:
      field:
        type: string
      message:
        type: string
    type: object
  api.loginRequest:
    properties:
      email:
        type: string
      password:
        type: string
    required:
    - email
    - password
    type: object
  api.registerRequest:
    properties:
      email:
        type: string
      password:
        maxLength: 128
        minLength: 8
        type: string
    required:
    - email
    - password
    type: object
  api.taskListResponse:
    properties:
      tasks:
        items:
          $ref: '#/definitions/api.taskResponse'
        type: array
    type: object
  api.taskResponse:
    properties:
      due:
        format: date-time
        type: string
      id:
        type: string
      priority:
        type: integer
      status:
        type: string
      tags:
        items:
          type: string
        type: array
      title:
        type: string
      version:
        type: integer
    type: object
  api.updateTaskRequest:
    properties:
      due:
        format: date-time
        type: string
      priority:
        maximum: 5
        minimum: 1
        type: integer
      status:
        enum:
        - Todo
        - Done
        type: string
      tags:
        items:
          type: string
        type: array
      title:
        type: string
      version:
        minimum: 1
        type: integer
    required:
    - version
    type: object
  api.userResponse:
    properties:
      created_at:
        format: date-time
        type: string
      email:
        type: string
      id:
        type: string
      is_admin:
        type: boolean
    type: object
info:
  contact: {}
  description: |-
    The todo application's HTTP surface: the task CRUD routes
    and the auth routes that gate them.

    The task routes require a session: log in through
    `POST /api/v1/auth/login` first, and the cookie it sets
    carries the identity on every following request. Every task
    is scoped to the authenticated user, so a task another user
    owns answers exactly what a missing task answers.

    Every failure leaves in one shape — `code`, `message`, and,
    on a validation failure, `fields`. The responses named per
    operation are the ones its handler decides; the stack's own
    failures can arrive on any route in the same shape: 413 for
    a body over 64 KiB, 500 for an internal error, 504 for a
    request past its ten-second deadline.
  title: Todo API
  version: "1.0"
paths:
  /api/v1/auth/login:
    post:
      consumes:
      - application/json
      description: Checks credentials and starts a session. The session cookie rides
        Set-Cookie; send it back on every task route. The token is re-issued at login,
        so an earlier cookie for the same session stops working.
      parameters:
      - description: email and password
        in: body
        name: credentials
        required: true
        schema:
          $ref: '#/definitions/api.loginRequest'
      produces:
      - application/json
      responses:
        "200":
          description: the authenticated user
          headers:
            Set-Cookie:
              description: the session cookie
              type: string
          schema:
            $ref: '#/definitions/api.userResponse'
        "400":
          description: a malformed JSON body
          schema:
            $ref: '#/definitions/api.errorResponse'
        "401":
          description: the credentials did not match
          schema:
            $ref: '#/definitions/api.errorResponse'
        "415":
          description: a body that is not JSON
          schema:
            $ref: '#/definitions/api.errorResponse'
        "422":
          description: a field failed validation
          schema:
            $ref: '#/definitions/api.errorResponse'
        "429":
          description: too many login attempts from this address
          schema:
            $ref: '#/definitions/api.errorResponse'
      summary: Log in
      tags:
      - auth
  /api/v1/auth/logout:
    post:
      description: Destroys the session. A logout with no session is still a 204,
        because the postcondition already holds; the cleared cookie rides Set-Cookie.
      responses:
        "204":
          description: no content
          headers:
            Set-Cookie:
              description: the cleared session cookie
              type: string
      summary: Log out
      tags:
      - auth
  /api/v1/auth/register:
    post:
      consumes:
      - application/json
      description: 'Creates an account. It does not log the new user in: a 201 means
        the account exists, and the next request is the login.'
      parameters:
      - description: email and password
        in: body
        name: credentials
        required: true
        schema:
          $ref: '#/definitions/api.registerRequest'
      produces:
      - application/json
      responses:
        "201":
          description: the new account
          schema:
            $ref: '#/definitions/api.userResponse'
        "400":
          description: a malformed JSON body
          schema:
            $ref: '#/definitions/api.errorResponse'
        "409":
          description: the email is taken
          schema:
            $ref: '#/definitions/api.errorResponse'
        "415":
          description: a body that is not JSON
          schema:
            $ref: '#/definitions/api.errorResponse'
        "422":
          description: a field failed validation
          schema:
            $ref: '#/definitions/api.errorResponse'
      summary: Register a user
      tags:
      - auth
  /api/v1/tasks:
    get:
      description: Lists the authenticated user's tasks. status and tag are filters
        and cannot be combined.
      parameters:
      - description: filter by status
        enum:
        - Todo
        - Done
        in: query
        name: status
        type: string
      - description: filter by tag
        in: query
        name: tag
        type: string
      produces:
      - application/json
      responses:
        "200":
          description: the caller's tasks
          schema:
            $ref: '#/definitions/api.taskListResponse'
        "400":
          description: an invalid filter, or status and tag combined
          schema:
            $ref: '#/definitions/api.errorResponse'
        "401":
          description: no session
          schema:
            $ref: '#/definitions/api.errorResponse'
      summary: List tasks
      tags:
      - tasks
    post:
      consumes:
      - application/json
      description: Creates a task owned by the authenticated user. The title is trimmed
        and length-checked; a new task starts in Todo with priority 3 unless the body
        says otherwise.
      parameters:
      - description: the task to create
        in: body
        name: task
        required: true
        schema:
          $ref: '#/definitions/api.createTaskRequest'
      produces:
      - application/json
      responses:
        "201":
          description: the stored task
          headers:
            Location:
              description: the new task's URL
              type: string
          schema:
            $ref: '#/definitions/api.taskResponse'
        "400":
          description: a malformed JSON body
          schema:
            $ref: '#/definitions/api.errorResponse'
        "401":
          description: no session
          schema:
            $ref: '#/definitions/api.errorResponse'
        "415":
          description: a body that is not JSON
          schema:
            $ref: '#/definitions/api.errorResponse'
        "422":
          description: a field failed validation
          schema:
            $ref: '#/definitions/api.errorResponse'
      summary: Create a task
      tags:
      - tasks
  /api/v1/tasks/{id}:
    delete:
      description: Deletes one of the authenticated user's tasks. The version is required
        on the query string — a DELETE body is not portable — and a stale one is a
        409.
      parameters:
      - description: task id (UUIDv7)
        in: path
        name: id
        required: true
        type: string
      - description: the version the caller read
        in: query
        name: version
        required: true
        type: integer
      responses:
        "204":
          description: no content
        "400":
          description: a missing or unusable version
          schema:
            $ref: '#/definitions/api.errorResponse'
        "401":
          description: no session
          schema:
            $ref: '#/definitions/api.errorResponse'
        "404":
          description: no such task in the caller's scope
          schema:
            $ref: '#/definitions/api.errorResponse'
        "409":
          description: the version is stale
          schema:
            $ref: '#/definitions/api.errorResponse'
      summary: Delete a task
      tags:
      - tasks
    get:
      description: Returns one of the authenticated user's tasks.
      parameters:
      - description: task id (UUIDv7)
        in: path
        name: id
        required: true
        type: string
      produces:
      - application/json
      responses:
        "200":
          description: the task
          schema:
            $ref: '#/definitions/api.taskResponse'
        "400":
          description: an id that is not a UUID
          schema:
            $ref: '#/definitions/api.errorResponse'
        "401":
          description: no session
          schema:
            $ref: '#/definitions/api.errorResponse'
        "404":
          description: no such task in the caller's scope
          schema:
            $ref: '#/definitions/api.errorResponse'
      summary: Get a task
      tags:
      - tasks
    patch:
      consumes:
      - application/json
      description: 'PATCH semantics: absent fields keep their value, a null due clears
        the date, and the version the caller read is required. A stale version is
        a 409, not a lost update.'
      parameters:
      - description: task id (UUIDv7)
        in: path
        name: id
        required: true
        type: string
      - description: the version the caller read, plus the fields to change
        in: body
        name: patch
        required: true
        schema:
          $ref: '#/definitions/api.updateTaskRequest'
      produces:
      - application/json
      responses:
        "200":
          description: the stored task
          schema:
            $ref: '#/definitions/api.taskResponse'
        "400":
          description: a malformed JSON body or an id that is not a UUID
          schema:
            $ref: '#/definitions/api.errorResponse'
        "401":
          description: no session
          schema:
            $ref: '#/definitions/api.errorResponse'
        "404":
          description: no such task in the caller's scope
          schema:
            $ref: '#/definitions/api.errorResponse'
        "409":
          description: the version is stale
          schema:
            $ref: '#/definitions/api.errorResponse'
        "415":
          description: a body that is not JSON
          schema:
            $ref: '#/definitions/api.errorResponse'
        "422":
          description: a field failed validation
          schema:
            $ref: '#/definitions/api.errorResponse'
      summary: Update a task
      tags:
      - tasks
  /healthz:
    get:
      description: Reports the process up. Touches no dependency, so a database that
        is briefly away does not fail it.
      produces:
      - application/json
      responses:
        "200":
          description: status ok
          schema:
            additionalProperties:
              type: string
            type: object
      summary: Liveness probe
      tags:
      - health
  /ready:
    get:
      description: Pings the store; answers 503 while the dependency is unreachable.
      produces:
      - application/json
      responses:
        "200":
          description: status ok
          schema:
            additionalProperties:
              type: string
            type: object
        "503":
          description: status unavailable
          schema:
            additionalProperties:
              type: string
            type: object
      summary: Readiness probe
      tags:
      - health
swagger: "2.0"
tags:
- description: The task CRUD surface. Every route requires a session and is scoped
    to the caller.
  name: tasks
- description: Registration, login, and logout — the routes an anonymous caller can
    reach.
  name: auth
- description: Liveness and readiness probes for supervisors, not clients.
  name: health
````


## `internal/api/docs_test.go`

````go
// Package api_test — the OpenAPI cases live in this file. The chapter's
// first failing test is TestSpec_DocumentsEveryRoute: the generated spec,
// internal/api/docs/swagger.json, must document every route the echo
// instance serves. A route the spec does not name is drift between the code
// and its documentation, and the test is what makes the drift fail instead
// of shipping.
package api_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/alexedwards/scs/v2/memstore"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/api"
	"todo/internal/store"
	"todo/internal/telemetry"
)

// swaggerPath is the Swagger UI's mount point. The UI is not part of the
// spec — it is the thing that renders the spec — so the coverage check
// skips it, by name, in one place.
const swaggerPath = "/swagger/*"

// metricsPath is the scrape endpoint. Its client is a Prometheus server and
// its vocabulary is the exposition format, not JSON, so it is operational
// surface rather than API surface, like the UI.
const metricsPath = "/metrics"

// pprofPath is the profiles' mount point, behind the admin gate. Their
// client is a profiler an operator runs, not an API caller, so the whole
// subtree is operational surface too.
const pprofPath = "/debug/pprof"

// swaggerDoc is the part of the generated spec the coverage check reads:
// paths, each mapping the HTTP method to its operation. The operation
// bodies are left as raw JSON — the check is that a method is documented,
// not what the operation says.
type swaggerDoc struct {
	Paths map[string]map[string]json.RawMessage `json:"paths"`
}

// readSpecFile reads the committed spec, byte for byte. It fails the test
// with the run that fixes it when the file is missing: the spec is
// generated by swag and committed, so a checkout without it is a checkout
// where make generate has not run.
func readSpecFile(t *testing.T) []byte {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("docs", "swagger.json"))
	require.NoError(t, err, "docs/swagger.json is generated and committed; run make generate")
	return data
}

// readSpec parses the committed spec.
func readSpec(t *testing.T) swaggerDoc {
	t.Helper()

	var doc swaggerDoc
	require.NoError(t, json.Unmarshal(readSpecFile(t), &doc), "docs/swagger.json must be valid JSON")
	return doc
}

// openAPIPath translates echo's path syntax into the spec's: a named
// parameter, ":id", is a template segment, "{id}". The two syntaxes are the
// only difference between the route echo registered and the path swag
// documents.
func openAPIPath(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if name, ok := strings.CutPrefix(part, ":"); ok {
			parts[i] = "{" + name + "}"
		}
	}
	return strings.Join(parts, "/")
}

// TestSpec_DocumentsEveryRoute is the chapter's first failing test: every
// route the echo instance serves must appear in the generated spec, under
// the same method. The check is deliberately the whole surface — it walks
// echo's own route table, so a route added without annotations fails here
// on the next run, which is what keeps the spec from silently falling
// behind the code.
func TestSpec_DocumentsEveryRoute(t *testing.T) {
	t.Parallel()

	doc := readSpec(t)
	e := api.New(store.NewMemoryStore(), stubAuth{}, api.NewSessionManager(memstore.New()), discardLogger(), testTracerProvider(), telemetry.NewRegistry())

	var missing []string
	for _, route := range e.Routes() {
		// Four kinds of route are not the spec's to document. /swagger/* is
		// the UI that renders the spec; /metrics is the scrape endpoint,
		// whose client is a Prometheus server and whose vocabulary is the
		// exposition format; /debug/pprof is the profiles, behind the admin
		// gate, whose client is an operator's profiler; echo's own
		// RouteNotFound entries are the group middleware's catch-alls — echo
		// registers them when a group carries middleware, so a 404 inside
		// /api/v1/tasks still runs RequireUser — and they name no endpoint a
		// client calls.
		if route.Path == swaggerPath || route.Path == metricsPath ||
			strings.HasPrefix(route.Path, pprofPath) || route.Method == echo.RouteNotFound {
			continue
		}
		method, path := strings.ToLower(route.Method), openAPIPath(route.Path)
		if _, ok := doc.Paths[path][method]; !ok {
			missing = append(missing, strings.ToUpper(method)+" "+path)
		}
	}
	sort.Strings(missing)

	assert.Empty(t, missing, "every echo route must be documented in docs/swagger.json")
}

// withoutEmptySpecKeys parses a spec document and drops the three keys swag's
// UI template renders even when empty. The committed file omits them; the
// document the UI reads carries them as "" and [] — a difference of encoding,
// not of spec.
func withoutEmptySpecKeys(t *testing.T, data []byte) map[string]any {
	t.Helper()

	var doc map[string]any
	require.NoError(t, json.Unmarshal(data, &doc), "the spec must be valid JSON")
	for _, key := range []string{"host", "basePath", "schemes"} {
		delete(doc, key)
	}
	return doc
}

// TestSwaggerUI_ServesTheDocs pins the serving decision: the docs are
// public — the spec describes routes whose existence any client can observe
// — and the UI serves the committed spec, not a second copy of it. The
// equality assertion is the point: what the browser renders is the file the
// coverage test checks.
func TestSwaggerUI_ServesTheDocs(t *testing.T) {
	t.Parallel()

	e := api.New(store.NewMemoryStore(), stubAuth{}, api.NewSessionManager(memstore.New()), discardLogger(), testTracerProvider(), telemetry.NewRegistry())

	index := get(t, e, "/swagger/index.html")
	require.Equal(t, http.StatusOK, index.Code)
	assert.Contains(t, index.Body.String(), "Swagger UI")

	spec := get(t, e, "/swagger/doc.json")
	require.Equal(t, http.StatusOK, spec.Code)
	assert.Contains(t, spec.Header().Get(echo.HeaderContentType), "application/json")
	assert.Equal(t, withoutEmptySpecKeys(t, readSpecFile(t)), withoutEmptySpecKeys(t, spec.Body.Bytes()))
}
````


## `internal/api/error.go`

````go
package api

import (
	"errors"
	"net/http"
	"slices"
	"strings"

	validator "github.com/go-playground/validator/v10"
	"github.com/labstack/echo/v4"

	"todo/internal/auth"
	"todo/internal/store"
	"todo/internal/task"
)

// The API's error contract, in one place. Every failure — a route that does
// not exist, a body the decoder rejects, a field that fails validation, a
// task that is gone or that changed under the caller — leaves through
// handleError and arrives as the same JSON object:
//
//	{"code":"...","message":"...","fields":[{"field":"...","message":"..."}]}
//
// code is the stable half: one token per failure class, safe to branch on.
// message is prose, for humans and for logs, and may change without notice.
// fields is present only on a 422, names every field that failed with a
// sentence about why, and is sorted by field name so the same failure always
// renders the same body.
type errorResponse struct {
	Code    string       `json:"code"`
	Message string       `json:"message"`
	Fields  []fieldError `json:"fields,omitempty"`
}

// fieldError is one field-level failure inside a 422.
type fieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// The error codes: one per failure class the API can report. The codes for
// the statuses echo itself produces are derived from the status by
// codeForStatus, so a 405 or a 415 renders in the same vocabulary without a
// handler having to think about it.
const (
	codeBadRequest           = "bad_request"
	codeUnauthorized         = "unauthorized"
	codeNotFound             = "not_found"
	codeMethodNotAllowed     = "method_not_allowed"
	codeConflict             = "conflict"
	codeEmailTaken           = "email_taken"
	codeUnsupportedMediaType = "unsupported_media_type"
	codeValidationFailed     = "validation_failed"
	codeGatewayTimeout       = "gateway_timeout"
	codeInternal             = "internal_error"
)

// handleError is the API's echo.HTTPErrorHandler: the single exit every
// handler error takes. A handler returns whatever failed and never writes an
// error response itself, which is what keeps the shape one shape.
//
// An unexpected failure is logged where it happens and answered with a fixed
// message: the error text is the one thing a client must not see, because it
// describes the inside of the process, while the log is where it belongs.
// The record goes through the request's logger, so it carries the request's
// id and joins the request record it belongs to. Chapter 32's request
// logging records every request; this records the ones that went wrong,
// which is the part a request record cannot reconstruct.
func (s *server) handleError(err error, c echo.Context) {
	// A handler that already wrote a response owns it; rewriting it here
	// would corrupt the body.
	if c.Response().Committed {
		return
	}

	logger := LoggerFrom(c.Request().Context())
	status, body := errorResponseFor(err)
	if status >= http.StatusInternalServerError {
		logger.Error("request failed",
			"method", c.Request().Method,
			"path", c.Request().URL.Path,
			"err", err)
	}
	if err := c.JSON(status, body); err != nil {
		logger.Error("error response failed", "err", err)
	}
}

// errorResponseFor classifies one error into its status and body. The order
// of the cases is the classification: the two validation shapes first (both
// are 422s with fields), then the stores' sentinels — the task store's two,
// which is how a stale snapshot becomes a 409 and a missing task a 404, and
// the auth service's two, which is how a duplicate email becomes a 409 of
// its own and a failed login a 401 — then echo's own HTTPError, which
// carries a status the handlers and the framework already agreed on.
// Anything left is a bug, and a bug is a 500 whose text stays in the process.
func errorResponseFor(err error) (int, errorResponse) {
	var (
		fieldErrors validator.ValidationErrors
		invalid     task.ValidationError
		he          *echo.HTTPError
	)
	switch {
	case errors.As(err, &fieldErrors):
		return http.StatusUnprocessableEntity, errorResponse{
			Code:    codeValidationFailed,
			Message: "validation failed",
			Fields:  validationFields(fieldErrors),
		}
	case errors.As(err, &invalid):
		// A rule the domain owns — the title's shape, the status
		// vocabulary — reported by the domain's own error type. The client
		// cannot tell this branch from the validator's: one shape, one
		// code.
		return http.StatusUnprocessableEntity, errorResponse{
			Code:    codeValidationFailed,
			Message: "validation failed",
			Fields:  []fieldError{{Field: invalid.Field, Message: invalid.Message}},
		}
	case errors.Is(err, store.ErrNotFound):
		return http.StatusNotFound, errorResponse{
			Code:    codeNotFound,
			Message: store.ErrNotFound.Error(),
		}
	case errors.Is(err, store.ErrConflict):
		return http.StatusConflict, errorResponse{
			Code:    codeConflict,
			Message: store.ErrConflict.Error(),
		}
	case errors.Is(err, auth.ErrEmailTaken):
		// A conflict of its own class: the version conflict above is a
		// stale snapshot, this one is an address already spoken for, and a
		// client that wants to put the message on the email field needs to
		// tell them apart. Hence the code of its own.
		return http.StatusConflict, errorResponse{
			Code:    codeEmailTaken,
			Message: auth.ErrEmailTaken.Error(),
		}
	case errors.Is(err, auth.ErrInvalidCredentials):
		// 401: the request carried credentials and they did not match. The
		// message is the sentinel's own and says nothing about which half
		// was wrong.
		return http.StatusUnauthorized, errorResponse{
			Code:    codeUnauthorized,
			Message: auth.ErrInvalidCredentials.Error(),
		}
	case errors.As(err, &he):
		return he.Code, errorResponse{Code: codeForStatus(he.Code), Message: httpErrorMessage(he)}
	default:
		return http.StatusInternalServerError, errorResponse{
			Code:    codeInternal,
			Message: "internal error",
		}
	}
}

// validationFields renders the validator's failures as field entries, sorted
// by field name so the body does not depend on the order the rules ran in.
func validationFields(errs validator.ValidationErrors) []fieldError {
	fields := make([]fieldError, 0, len(errs))
	for _, fe := range errs {
		fields = append(fields, fieldError{Field: fe.Field(), Message: validationMessage(fe)})
	}
	slices.SortFunc(fields, func(a, b fieldError) int { return strings.Compare(a.Field, b.Field) })
	return fields
}

// validationMessage turns one failed rule into a sentence. The messages are
// the API's own: go-playground's defaults name Go fields and tags ("Key:
// 'createTaskRequest.title' Error:Field validation for 'title' failed on the
// 'max' tag"), which is neither the wire spelling nor prose. The rules the
// DTOs use are the ones with a case; an untranslated rule falls back to "is
// invalid" rather than leaking the tag.
func validationMessage(fe validator.FieldError) string {
	switch fe.Tag() {
	case "required":
		return "is required"
	case "min":
		return "must be at least " + fe.Param()
	case "max":
		return "must be at most " + fe.Param()
	case "email":
		return "must be a valid email address"
	case "tags":
		return "must not contain empty tags"
	}
	return "is invalid"
}

// codeForStatus names the failure class of a status no handler classified:
// echo's own 404 and 405, the binder's 415, the body limit's 413, the
// deadline's 504. The rules: a status below 500 that the table does not name
// derives its token from the status text (413 becomes
// request_entity_too_large, which is why the body limit needs no case here),
// while a status at or above 500 that the table does not name is an internal
// error — an unclassified server failure is a bug, and internal_error is
// what a bug is called. The timeout's 504 and the login's 401 are below or
// above 500 and are not bugs, so they are named.
func codeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return codeBadRequest
	case http.StatusUnauthorized:
		return codeUnauthorized
	case http.StatusNotFound:
		return codeNotFound
	case http.StatusMethodNotAllowed:
		return codeMethodNotAllowed
	case http.StatusConflict:
		return codeConflict
	case http.StatusUnsupportedMediaType:
		return codeUnsupportedMediaType
	case http.StatusUnprocessableEntity:
		return codeValidationFailed
	case http.StatusGatewayTimeout:
		return codeGatewayTimeout
	}
	if status >= http.StatusInternalServerError {
		return codeInternal
	}
	return strings.ReplaceAll(strings.ToLower(http.StatusText(status)), " ", "_")
}

// httpErrorMessage reads the message off an echo.HTTPError. Handlers and echo
// itself put strings there; a message that is an error is its text, and a
// message of any other shape falls back to the status text.
func httpErrorMessage(he *echo.HTTPError) string {
	switch message := he.Message.(type) {
	case string:
		return message
	case error:
		return message.Error()
	default:
		return http.StatusText(he.Code)
	}
}

// badRequest is a 400 a handler raises itself, in the one error shape's
// vocabulary: an echo.HTTPError, which handleError renders like everything
// else. Handlers return it instead of writing a response, so there is one
// place that writes errors.
func badRequest(message string) error {
	return echo.NewHTTPError(http.StatusBadRequest, message)
}
````


## `internal/api/list_bench_test.go`

````go
package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alexedwards/scs/v2/memstore"
	"github.com/google/uuid"

	"todo/internal/api"
	"todo/internal/auth"
	"todo/internal/store"
	"todo/internal/task"
	"todo/internal/telemetry"
)

// This file is chapter 50's API-side workload: the list handler answering
// with a hundred thousand tasks. The store's own benchmarks measure the read;
// this one measures what the HTTP edge does with what it read — the response
// the handler builds and the bytes the client receives — which is where the
// JSON edge's allocation profile lives.

// benchListSize is the task count the list benchmarks answer with.
const benchListSize = 100_000

// benchBase is the fixed reference date for seeded due dates: the helper
// never reads the clock, so every run builds the same tasks.
var benchBase = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

// benchTags is the fixed tag pool the seeding helper draws from.
var benchTags = []string{"go", "book", "urgent", "home", "work"}

// benchTasks builds the deterministic task list every measurement answers
// with: the same shape internal/store's benchmarks seed, so the two suites
// measure one workload.
func benchTasks(n int) []task.Task {
	tasks := make([]task.Task, n)
	for i := range tasks {
		t := task.Task{
			ID:       uuid.MustParse(fmt.Sprintf("01a00000-0000-7000-8000-%012d", i)),
			Title:    fmt.Sprintf("task-%05d", i),
			Status:   task.StatusTodo,
			Priority: task.PriorityDefault,
			Version:  1,
		}
		if i%3 == 0 {
			t.Status = task.StatusDone
		}
		if i%2 == 0 {
			t.Due = benchBase.AddDate(0, 0, i%60)
		}
		if i%7 != 0 {
			t.Tags = []string{benchTags[i%len(benchTags)], benchTags[(i+1)%len(benchTags)]}
		}
		tasks[i] = t
	}
	return tasks
}

// benchStore is the list benchmark's store: the scoped view answers List with
// the prepared slice and every other method panics by way of the embedded nil
// interface. The handler's own work is what is under measurement; the read
// behind it is internal/store's benchmark.
type benchStore struct {
	store.Store
	tasks []task.Task
}

// Scoped returns the same view: the benchmark's tasks are one user's.
func (b *benchStore) Scoped(uuid.UUID) store.Store { return b }

// List returns the prepared tasks.
func (b *benchStore) List(context.Context) ([]task.Task, error) { return b.tasks, nil }

// discardWriter is the benchmark's response target: statuses are recorded,
// bodies are dropped. httptest.ResponseRecorder would buffer the whole
// response in a []byte — itself an allocation that grows with the page — and
// the point of the measurement is what the handler allocates before anything
// is written anywhere.
type discardWriter struct {
	status int
	bytes  int
	header http.Header
}

func (w *discardWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *discardWriter) WriteHeader(status int) { w.status = status }

func (w *discardWriter) Write(p []byte) (int, error) {
	w.bytes += len(p)
	return len(p), nil
}

// benchSink keeps the measured response reachable.
var benchSink int

func BenchmarkListTasks(b *testing.B) {
	tasks := benchTasks(benchListSize)
	sessions := api.NewSessionManager(memstore.New())
	e := api.New(&benchStore{tasks: tasks}, stubAuth{}, sessions, discardLogger(), testTracerProvider(), telemetry.NewRegistry())

	ctx, err := sessions.Load(context.Background(), "")
	if err != nil {
		b.Fatal(err)
	}
	sessions.Put(ctx, auth.SessionUserID, testUserID.String())
	token, _, err := sessions.Commit(ctx)
	if err != nil {
		b.Fatal(err)
	}
	cookie := &http.Cookie{Name: sessions.Cookie.Name, Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}

	b.Run(fmt.Sprintf("n=%d", benchListSize), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/tasks", nil)
			req.AddCookie(cookie)
			w := &discardWriter{}
			e.ServeHTTP(w, req)
			if w.status != http.StatusOK {
				b.Fatalf("status = %d, want 200", w.status)
			}
			benchSink = w.bytes
		}
	})
}
````


## `internal/api/middleware.go`

````go
package api

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"go.opentelemetry.io/otel/trace"
)

// The middleware stack is one ordered list around every route the server
// serves, and the order is the chapter's first decision:
//
//	RequestID -> tracing -> metrics -> request logging -> Secure -> Recover ->
//	login limiter -> Timeout -> sessions -> BodyLimit -> Gzip -> CORS
//
// Echo applies middleware in the order given, outermost first, so the list
// reads top-down as a request travels. RequestID comes first because
// everything after it may want to name the request: the span, the record, the
// recovered panic, the failure the error handler reports. Tracing comes
// second: the span sits outside everything that can fail or log, so it covers
// the whole request and ends with the status the client received. Metrics
// come third for the same reason: the RED collectors observe that same final
// status. Request logging comes fourth because it must see the whole request
// — it writes the one record per request, and that record's status is the
// status the client received, including the 500 a recovered panic produced or
// the 504 an expired deadline produced. Secure comes fifth: setting response
// headers has no dependency on any other layer, and the header map is written
// when the response is written — so the only thing its position decides is
// which refusals carry the headers. Sitting above every layer that can answer
// without calling next — the session layer's load failure, the body limit's
// 413, the CORS preflight — is what puts the headers on those responses too.
// Chapter 32 left Secure last and recorded the refusals that carried nothing;
// the header audit moved the layer and closed that edge. Recover comes sixth:
// outside everything that can panic, inside the logging middleware so a
// recovered panic is still a logged request. The login limiter comes seventh:
// it guards the two login routes (see ratelimit.go) and sits above every
// layer whose work a refused attempt must not cause — the deadline, the
// session load, the body read — so a refusal costs a map lookup and nothing
// else. Timeout comes eighth: the deadline is a property of the whole
// request, so it is armed as early as the layers that cannot be skipped
// allow. The session layer comes ninth: its load and its commit are database
// work, so they belong inside the deadline, and everything that might read a
// session — the auth handlers, RequireUser, and chapter 37's CSRF — sits
// inside it. BodyLimit comes tenth: nothing may read the body before the wall
// is in place. Gzip wraps the response writer for everything inside it, so it
// sits above the layers that shape responses — with one consequence worth
// knowing: an error response is written by the error handler at the logging
// middleware's level, above Gzip, so it leaves uncompressed, and Gzip's own
// cleanup keeps the headers consistent with that (no Content-Encoding, no
// compressed body). The header audit re-scoped that edge rather than closing
// it: error bodies are tens of bytes, a gzip frame would outweigh them, and
// the test pins the shape. CORS comes last: the cross-origin decision belongs
// to the request that arrived, and a preflight is answered there without
// reaching the handler — but inside the logging middleware, so a preflight is
// a logged request too, and inside Secure, so it carries the headers.
//
// Eight of the twelve layers are echo's, configured here; the custom ones are
// the span (see traceRequests), the RED collectors (see requestMetrics), and
// request logging (see requestLogger); the session layer is scs's, adapted by
// echo.WrapMiddleware. Two choices are worth naming. Timeout is
// ContextTimeout, not Timeout: v4.16 deprecates the latter — it swaps the
// response writer across goroutines, documents that it "causes more
// problems than it solves", and demands to be the first middleware, which
// the logging layer above it forbids — while ContextTimeout arms a deadline
// on the request's context and leaves the failing to the context-aware code
// inside. Recover stays echo's because its seams are the ones this stack
// needs: a LogErrorFunc for the record and an error returned into the one
// error handler.

// The stack's policy values, in one place. They are policy, not measurement:
// every route this API serves is a local database read or write, and the
// numbers are chosen from that shape.
const (
	// requestTimeout bounds a request's lifetime. Ten seconds is far longer
	// than a local query should ever take and far shorter than a client's
	// patience; chapter 45's duration histogram is the first data that could
	// move it.
	requestTimeout = 10 * time.Second

	// bodyLimit caps the request body at 64 KiB. The largest legitimate
	// body this API serves is a task — a title of at most 200 characters, a
	// due date, a tag list — so even a hundred tags is under 2 KiB: the
	// limit is over thirty times the contract, and still small enough that
	// the worst case a body can cause (a tag list, each tag a row) stays
	// bounded. The decoder streams, so this limit is also the bound on how
	// much of a request the process can be made to hold.
	bodyLimit = "64K"

	// gzipMinLength is the response size below which gzip does not run.
	// Below a kilobyte the gzip frame's overhead — header, trailer,
	// dictionary — can outweigh the saving; the threshold also bounds how
	// much of a response the middleware buffers while it decides, and keeps
	// a health check's twenty bytes out of the compressor.
	gzipMinLength = 1024

	// maxRequestIDLength bounds a client-supplied X-Request-ID. Echo's own
	// generator makes 32 characters; 64 is twice that, so a caller with a
	// longer id has built one, not quoted one, and the id is replaced with
	// a generated one. The bound is the audit's answer to chapter 32's
	// parked question — the id was trusted unbounded in size, and every
	// record about the request carries it.
	maxRequestIDLength = 64
)

// contentSecurityPolicy is the process policy — the pages, the API's JSON,
// the refusals — and it is written from the pages' own inventory, which is
// empty by design: the pages load one stylesheet and no scripts, no images,
// no fonts, and every form posts to this origin. Directive by directive:
//
//   - default-src 'none' is the floor: a resource kind the policy does not
//     name is refused, so adding one is a deliberate edit here, not a
//     default.
//   - script-src 'none' is the chapter's central claim: there is no
//     JavaScript anywhere in the pages, inline or external, and the policy
//     says so rather than leaving it to the templates to stay true. (The
//     docs UI is the one exception and has its own policy below.)
//   - style-src 'self' allows /static/app.css and nothing else. The pages
//     carry no style attributes and no <style> blocks — the stylesheet is
//     external on purpose — which is what keeps 'unsafe-inline' out.
//   - img-src 'none': the pages embed no images at all. A favicon or an
//     icon later is a one-line policy edit, which is the point of naming
//     it now.
//   - form-action 'self' keeps every form's submission on this origin: the
//     destination is policy, not markup.
//   - base-uri 'none' refuses a <base> tag, so a URL in a page cannot be
//     re-rooted under an injected one.
//   - frame-ancestors 'none' is clickjacking's rule: no page may be framed
//     at all. X-Frame-Options: DENY below is its legacy twin, kept for
//     browsers that never learned the directive, and the two must not
//     drift.
const contentSecurityPolicy = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

// swaggerContentSecurityPolicy is the docs UI's policy, applied by
// swaggerUIHeaders on the /swagger routes where the exception lives.
// swagger-ui is a JavaScript application — it ships its own bundle and an
// inline bootstrap script, an inline <style> block, data: icons in its
// stylesheet, and fetches the spec over XHR — so the pages' policy would
// leave it a blank page. The directives that differ are script-src,
// style-src, img-src, and connect-src; everything else keeps the pages'
// shape. 'unsafe-inline' is confined to this route, and the route serves
// the generated spec and swagger-ui's own assets: no user input.
const swaggerContentSecurityPolicy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

// swaggerUIHeaders replaces the process policy on the docs UI's routes. It
// runs as route middleware, inside the stack, so the response already
// carries every other header; this call changes one value, and the
// exception is spelled where the route is registered (see api.go).
func swaggerUIHeaders(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		c.Response().Header().Set(echo.HeaderContentSecurityPolicy, swaggerContentSecurityPolicy)
		return next(c)
	}
}

// useStack installs the ordered stack on e. It is one call so the order is
// one list, and each layer carries its own reason.
func useStack(e *echo.Echo, logger *slog.Logger, sessions *scs.SessionManager, tp trace.TracerProvider, metrics *requestMetrics) {
	e.Use(
		// The id's owner: it reads X-Request-ID from the client or
		// generates one, and sets it on the response — where the client
		// reads it back, where requestLogger, below, finds it, and where
		// the tracing layer takes it onto the span. A client-supplied id
		// is trusted on purpose: correlating a caller's report with the
		// server's records is the whole point, and the id reaches nothing
		// but a log field, a span attribute, and the response header. The
		// trust is bounded in effect — the JSON handler escapes the value
		// and it names nothing — and the audit bounded it in size: an id
		// over maxRequestIDLength is not a correlation id, it is a payload
		// headed for every record about the request, so it is replaced with
		// a generated one before anything reads it. The replacement happens
		// through RequestIDHandler, which echo calls after it has set the
		// header and before the chain runs; the response header is the
		// canonical copy, so the client reads the id that will be logged.
		middleware.RequestIDWithConfig(middleware.RequestIDConfig{
			RequestIDHandler: func(c echo.Context, id string) {
				if len(id) > maxRequestIDLength {
					c.Response().Header().Set(echo.HeaderXRequestID, rand.Text())
				}
			},
		}),

		// The span, and the trace id the record below joins on. It sits
		// outside everything that can fail or log, so the span covers the
		// whole request and ends with the status the client received.
		traceRequests(tp),

		// The two RED collectors, above the logging middleware for the
		// same reason the span is: the status they observe must be final.
		metrics.middleware(),

		requestLogger(logger),

		// The header policy, and the reason it is third: setting response
		// headers has no dependency on any other layer, and the header map
		// is written when the response is written — so the position decides
		// only which refusals carry the headers. Above every layer that can
		// answer without calling next (the session load's failure, the body
		// limit's 413, the CORS preflight), the set lands on those responses
		// too; chapter 32 left the layer last and recorded the refusals that
		// carried nothing. SecureWithConfig applies no header defaults of
		// its own — unlike CORS and Gzip, it defaults only the skipper — so
		// every header the process sends is named here. X-Frame-Options is
		// DENY, not SAMEORIGIN: the policy's frame-ancestors 'none' says the
		// pages are never framed, and the legacy twin must not disagree.
		// X-XSS-Protection is "0": the filter the header once enabled is
		// gone from current browsers and was abused where it existed, so the
		// header's only honest job left is to switch it off. HSTS is set
		// only when the request's scheme is https — echo believes a
		// forwarded X-Forwarded-Proto only from a trusted peer (loopback,
		// link-local, private), which is the rule chapter 48's Caddy will
		// satisfy and a public client cannot spoof — and it is excluded from
		// subdomains because the app does not know what else lives on its
		// domain. Referrer-Policy stays no-referrer: nothing here needs to
		// leak a referrer.
		middleware.SecureWithConfig(middleware.SecureConfig{
			XSSProtection:         "0",
			ContentTypeNosniff:    "nosniff",
			XFrameOptions:         "DENY",
			HSTSMaxAge:            31536000,
			HSTSExcludeSubdomains: true,
			ContentSecurityPolicy: contentSecurityPolicy,
			ReferrerPolicy:        "no-referrer",
		}),

		// Panics become the one error shape. The record goes through the
		// request's logger, so a panic is correlated with the request that
		// caused it, and the stack is the panicking goroutine's only:
		// every other goroutine's is noise in a log record, and mostly
		// truncation in the 4 KiB the middleware captures. Returning the
		// error hands the panic to the one error handler, which answers
		// 500 with its text kept in the process; echo's Recover re-panics
		// http.ErrAbortHandler before any of this, which keeps net/http's
		// abort semantics.
		middleware.RecoverWithConfig(middleware.RecoverConfig{
			DisableStackAll: true,
			LogErrorFunc: func(c echo.Context, err error, stack []byte) error {
				LoggerFrom(c.Request().Context()).Error("panic recovered",
					"err", err, "stack", string(stack))
				return err
			},
		}),

		// The login limiter. Its skipper is a route predicate — the two
		// login paths and nothing else (see ratelimit.go) — because the
		// budget must be one budget per source address across both edges,
		// and the instance-level list is the one place that sees both. It
		// sits here, above Timeout and the session layer, so a refused
		// attempt never costs a deadline, a session load, or a body read.
		loginLimiter(),

		// The deadline is armed on the request's context; nothing is
		// interrupted. A handler — and the store under it — that respects
		// the context fails when the deadline passes, and the failure
		// arrives here as an error wrapping context.DeadlineExceeded, which
		// becomes 504 rather than echo's default 503: the request did not
		// reach an answer in time, and that is a gateway's failure. Any
		// other error, a client's own cancellation included, falls through
		// to the one error handler unchanged.
		middleware.ContextTimeoutWithConfig(middleware.ContextTimeoutConfig{
			Timeout: requestTimeout,
			ErrorHandler: func(err error, c echo.Context) error {
				if errors.Is(err, context.DeadlineExceeded) {
					return echo.NewHTTPError(http.StatusGatewayTimeout, "request timed out")
				}
				return err
			},
		}),

		// The session layer. scs's LoadAndSave is net/http middleware —
		// echo.WrapMiddleware adapts it — and it reads the session cookie,
		// loads the payload through our store into the request's context,
		// and commits it, writing the cookie, when the response is written.
		// It sits inside Timeout because the load and the commit are
		// database work and belong under the request's deadline, and above
		// the layers below because they shape a response or a body and have
		// nothing to say about a session. The layer is scs's, configured by
		// NewSessionManager; what this list owns is its position.
		echo.WrapMiddleware(sessions.LoadAndSave),

		// The wall is two checks, and both are wanted: the Content-Length
		// header catches an honest client before a byte of the body is
		// read, and the counting reader catches one that lies. The 413 it
		// returns is echo's own HTTPError, which the one error handler
		// renders in the one shape; the code derives from the status text
		// like every other status the classifier does not name. The headers
		// land on it because Secure sits above this layer.
		middleware.BodyLimit(bodyLimit),

		// The level stays echo's default (gzip.DefaultCompression, the
		// balance between CPU and size); the threshold is the knob that
		// matters here.
		middleware.GzipWithConfig(middleware.GzipConfig{
			MinLength: gzipMinLength,
		}),

		// The MPA is served from the same origin and the TUI is not a
		// browser, so no cross-origin browser client exists and the policy
		// is closed — written down rather than implied, because echo's
		// default is "*" for every origin. A future consumer arrives as an
		// allowlist in this one function. Worth naming while it is here:
		// CORS is a browser read-permission mechanism, not access control —
		// it stops a page from reading a response, not from causing one,
		// and cross-site writes are chapter 37's CSRF problem, not this
		// one. A preflight is answered here without calling next, and the
		// headers still ride it because Secure sits above.
		middleware.CORSWithConfig(middleware.CORSConfig{
			AllowOriginFunc: func(string) (bool, error) { return false, nil },
		}),
	)
}

// requestLogger is the stack's custom middleware: it gives every request a
// logger carrying the request's id and — when a span is in the context, which
// the tracing layer above guarantees — its trace id, puts that logger in the
// request's context so handlers and the error handler log through it
// (LoggerFrom), and writes the request's one record when the response is
// done.
//
// Getting the record's status right is the reason the middleware calls
// c.Error itself: echo's ServeHTTP calls the error handler only after the
// whole chain has returned, so a middleware that logged first would record
// the 200 the response held before the error handler wrote the failure.
// Calling it here — the same call echo's own Logger middleware makes —
// renders the error inside the chain, where the record can see it; the
// second call, from ServeHTTP, is a no-op because the response is committed.
// The error is returned unchanged: this middleware observes and answers, it
// does not swallow.
func requestLogger(logger *slog.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()
			req := c.Request()

			// The method and the path are read now, before the handler
			// runs: they are the request as the client sent it, and a
			// handler may rewrite its own copy of the URL — the Swagger
			// UI's asset handler rewrites it to the embedded file's
			// relative name — which must not leak into the record.
			method, path := req.Method, req.URL.Path

			// The response header is the id's home: RequestID set it above
			// this middleware, and it is what the client reads back, so the
			// record and the client cannot disagree about it.
			id := c.Response().Header().Get(echo.HeaderXRequestID)
			reqLogger := logger.With("request_id", id)

			// The trace id is the join between the signals: the span the
			// tracing layer started above this one is in the context, and
			// its id is the same 32 hex characters the trace backend
			// indexes and the span carries. A provider that records
			// nothing still gives the span a real trace id; only a no-op
			// provider has none, and then the field is absent rather than
			// an empty string pretending to be an id.
			if sc := trace.SpanContextFromContext(req.Context()); sc.IsValid() {
				reqLogger = reqLogger.With("trace_id", sc.TraceID().String())
			}
			c.SetRequest(req.WithContext(withLogger(req.Context(), reqLogger)))

			err := next(c)
			if err != nil {
				c.Error(err)
			}

			reqLogger.LogAttrs(c.Request().Context(), requestLevel(c.Response().Status), "request",
				slog.String("method", method),
				slog.String("path", path),
				slog.Int("status", c.Response().Status),
				slog.Duration("duration", time.Since(start)),
			)
			return err
		}
	}
}

// requestLevel is the record's level discipline: the client's failures are
// warnings — a 404 named nothing, a 422 broke a rule — the server's own
// failures are errors, and everything else is the normal record. The cost is
// that a scanner's 404s are warnings; the alternative, one level for
// everything, hides the requests an operator wants to see move.
func requestLevel(status int) slog.Level {
	switch {
	case status >= http.StatusInternalServerError:
		return slog.LevelError
	case status >= http.StatusBadRequest:
		return slog.LevelWarn
	default:
		return slog.LevelInfo
	}
}

// loggerKey is the request context's logger key. It is a struct type rather
// than a string so it cannot collide with a key another package sets.
type loggerKey struct{}

// withLogger returns a copy of ctx carrying logger. requestLogger is the
// only setter.
func withLogger(ctx context.Context, logger *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey{}, logger)
}

// LoggerFrom returns the logger the request's middleware put in ctx: the
// process logger with the request's id attached, so every record logged
// through it is correlated with the request that produced it. A context
// without one — a boot path, a test, a background job that has no request —
// gets slog.Default() rather than nil, so a call site never has to decide
// whether logging is available.
func LoggerFrom(ctx context.Context) *slog.Logger {
	if logger, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok {
		return logger
	}
	return slog.Default()
}
````


## `internal/api/middleware_test.go`

````go
// Package api_test — the middleware cases live in this file, apart from the
// health, lifecycle, and CRUD cases. Every case drives the stack through
// echo's ServeHTTP entry point, because the stack is what New installs and
// the property under test is what a client sees: the id, the record, the
// recovered panic, the deadline, and the wall a too-large body hits.
package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/api"
	"todo/internal/store"
	"todo/internal/task"
)

// logRecord is one record as the JSON sink writes it: the request record's
// fields plus the two the failure records add. A field the middleware did
// not write decodes to its zero value, so every assertion on one is also an
// assertion that it was written.
type logRecord struct {
	Level     string `json:"level"`
	Msg       string `json:"msg"`
	Method    string `json:"method"`
	Path      string `json:"path"`
	Status    int    `json:"status"`
	Duration  int64  `json:"duration"`
	RequestID string `json:"request_id"`
	TraceID   string `json:"trace_id"`
	Err       string `json:"err"`
	Stack     string `json:"stack"`
}

// captureLogger returns a logger that writes JSON records into a buffer —
// the machine shape the file sink keeps — and the buffer they land in.
func captureLogger() (*slog.Logger, *bytes.Buffer) {
	buf := new(bytes.Buffer)
	return slog.New(slog.NewJSONHandler(buf, nil)), buf
}

// logRecords decodes every record the logger wrote. The writes are
// synchronous — the middleware logs inside the request's goroutine — so no
// lock is needed.
func logRecords(t *testing.T, buf *bytes.Buffer) []logRecord {
	t.Helper()
	var records []logRecord
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var rec logRecord
		require.NoError(t, json.Unmarshal([]byte(line), &rec), "record: %s", line)
		records = append(records, rec)
	}
	return records
}

// findRecord returns the single record with msg, failing when there is none
// or more than one.
func findRecord(t *testing.T, records []logRecord, msg string) logRecord {
	t.Helper()
	var found []logRecord
	for _, rec := range records {
		if rec.Msg == msg {
			found = append(found, rec)
		}
	}
	require.Len(t, found, 1, "records with msg %q", msg)
	return found[0]
}

// TestRequestID_Propagated pins the correlation contract: the id a client
// sends travels into the response and into the request's records, and a
// request without one gets an id generated and echoed the same way.
func TestRequestID_Propagated(t *testing.T) {
	t.Parallel()

	t.Run("the client's id travels", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)

		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		req.Header.Set(echo.HeaderXRequestID, "trace-42")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "trace-42", rec.Header().Get(echo.HeaderXRequestID))
		records := logRecords(t, buf)
		require.Len(t, records, 1)
		assert.Equal(t, "request", records[0].Msg)
		assert.Equal(t, "trace-42", records[0].RequestID)
	})

	t.Run("a missing id is generated and echoed", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)

		rec := get(t, e, "/healthz")

		id := rec.Header().Get(echo.HeaderXRequestID)
		require.Len(t, id, 32, "echo's generator makes a 32-character id")
		records := logRecords(t, buf)
		require.Len(t, records, 1)
		assert.Equal(t, id, records[0].RequestID)
	})

	t.Run("the handler's logger carries the id", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)
		// A route that logs the way a handler does: through the logger the
		// middleware put in the request's context.
		e.GET("/test/logger", func(c echo.Context) error {
			api.LoggerFrom(c.Request().Context()).Info("handler record")
			return c.NoContent(http.StatusNoContent)
		})

		req := httptest.NewRequest(http.MethodGet, "/test/logger", nil)
		req.Header.Set(echo.HeaderXRequestID, "trace-7")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		records := logRecords(t, buf)
		require.Len(t, records, 2)
		assert.Equal(t, "trace-7", findRecord(t, records, "handler record").RequestID)
		assert.Equal(t, "trace-7", findRecord(t, records, "request").RequestID)
	})
}

// TestLoggerFrom_Fallback pins the helper's never-nil rule: a context no
// request has touched still answers with a logger, so a call site outside a
// request — a boot path, a background job — never has to decide whether
// logging is available.
func TestLoggerFrom_Fallback(t *testing.T) {
	t.Parallel()

	assert.Same(t, slog.Default(), api.LoggerFrom(context.Background()))
}

// TestRequestLog_Fields pins the one record per request: its message, the
// method, the path, the status, a duration, and the id — read from the JSON
// sink, which is the shape the file keeps.
func TestRequestLog_Fields(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	e, cookie := newTaskAPI(t, store.NewMemoryStore(), logger)

	rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks", "")

	require.Equal(t, http.StatusOK, rec.Code)
	records := logRecords(t, buf)
	require.Len(t, records, 1)
	got := records[0]
	assert.Equal(t, "INFO", got.Level)
	assert.Equal(t, "request", got.Msg)
	assert.Equal(t, http.MethodGet, got.Method)
	assert.Equal(t, "/api/v1/tasks", got.Path)
	assert.Equal(t, http.StatusOK, got.Status)
	assert.Positive(t, got.Duration)
	assert.Equal(t, rec.Header().Get(echo.HeaderXRequestID), got.RequestID)
}

// TestRequestLog_PathAsRequested pins that the record names the path the
// client sent, not one a handler rewrote. The Swagger UI's asset handler is
// the real case: it rewrites its request's URL to the embedded file's
// relative name before handing it to the file server, and a record that read
// the URL afterwards would log "swagger-ui.css" as the path.
func TestRequestLog_PathAsRequested(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	e := newTestAPI(store.NewMemoryStore(), logger)

	// A route that rewrites its URL the way the UI's handler does.
	e.GET("/rewrite", func(c echo.Context) error {
		c.Request().URL.Path = "relative-name.css"
		return c.NoContent(http.StatusNoContent)
	})

	rec := get(t, e, "/rewrite")

	require.Equal(t, http.StatusNoContent, rec.Code)
	records := logRecords(t, buf)
	require.Len(t, records, 1)
	assert.Equal(t, "/rewrite", records[0].Path)
}

// TestRequestLog_Levels pins the level discipline — the client's failures
// are warnings, the server's are errors — and that the error handler's own
// record carries the same request id as the request's: one correlation id
// per request, on every record it produced.
func TestRequestLog_Levels(t *testing.T) {
	t.Parallel()

	t.Run("a 404 is a warning", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)

		rec := get(t, e, "/api/v1/nope")

		require.Equal(t, http.StatusNotFound, rec.Code)
		records := logRecords(t, buf)
		require.Len(t, records, 1)
		assert.Equal(t, "WARN", records[0].Level)
		assert.Equal(t, http.StatusNotFound, records[0].Status)
	})

	t.Run("a 500 is an error, on both records", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		st := &StoreMock{}
		st.ScopedFunc = func(uuid.UUID) store.Store { return st }
		st.ListFunc = func(context.Context) ([]task.Task, error) {
			return nil, errors.New("database is away")
		}
		e, cookie := newTaskAPI(t, st, logger)

		rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks", "")

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		records := logRecords(t, buf)
		require.Len(t, records, 2)

		// The failure record is where the store's own text lives: the
		// client got the fixed 500 body, the log got the reason.
		failure := findRecord(t, records, "request failed")
		assert.Equal(t, "ERROR", failure.Level)
		assert.Equal(t, "database is away", failure.Err)

		request := findRecord(t, records, "request")
		assert.Equal(t, "ERROR", request.Level)
		assert.Equal(t, http.StatusInternalServerError, request.Status)
		assert.Equal(t, request.RequestID, failure.RequestID)
		assert.NotEmpty(t, request.RequestID)
	})
}

// TestPanic_Recovered pins the panic contract: the client gets the one 500
// shape with none of the panic's text, and the log gets the panic and its
// stack. The route that panics is the test's own — no production handler may
// panic, so forcing one is a job for a route built for the case.
func TestPanic_Recovered(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	e := newTestAPI(store.NewMemoryStore(), logger)
	e.GET("/test/panic", func(echo.Context) error {
		panic("boom")
	})

	rec := get(t, e, "/test/panic")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.JSONEq(t, `{"code":"internal_error","message":"internal error"}`, rec.Body.String())
	assert.NotContains(t, rec.Body.String(), "boom")

	records := logRecords(t, buf)
	panicRecord := findRecord(t, records, "panic recovered")
	assert.Equal(t, "ERROR", panicRecord.Level)
	assert.Equal(t, "boom", panicRecord.Err)
	assert.Contains(t, panicRecord.Stack, "TestPanic_Recovered",
		"the stack names the frame the panic came from")

	request := findRecord(t, records, "request")
	assert.Equal(t, http.StatusInternalServerError, request.Status)
	assert.Equal(t, panicRecord.RequestID, request.RequestID)
}

// TestTimeout_504 pins the deadline contract in two halves: the stack arms a
// deadline on the request's context, and a deadline that expires while the
// store is working becomes the one 504 shape. The test's own deadline
// expires first — so the wait is deterministic and short — while the
// server's deadline is asserted, not waited out.
func TestTimeout_504(t *testing.T) {
	t.Parallel()

	t.Run("the stack arms a deadline", func(t *testing.T) {
		t.Parallel()

		var armed bool
		st := &StoreMock{}
		st.ScopedFunc = func(uuid.UUID) store.Store { return st }
		st.ListFunc = func(ctx context.Context) ([]task.Task, error) {
			_, armed = ctx.Deadline()
			return nil, nil
		}
		e, cookie := newTaskAPI(t, st, discardLogger())

		rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks", "")

		require.Equal(t, http.StatusOK, rec.Code)
		assert.True(t, armed, "the request's context must carry the stack's deadline")
	})

	t.Run("an expired deadline is a 504", func(t *testing.T) {
		t.Parallel()

		st := &StoreMock{}
		st.ScopedFunc = func(uuid.UUID) store.Store { return st }
		st.ListFunc = func(ctx context.Context) ([]task.Task, error) {
			// Wait for the deadline and report it the way the real
			// store's ctxErr does: the operation names the cause it
			// saw.
			<-ctx.Done()
			return nil, fmt.Errorf("list tasks: %w", context.Cause(ctx))
		}
		e, cookie := newTaskAPI(t, st, discardLogger())

		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/tasks", nil).WithContext(ctx)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusGatewayTimeout, rec.Code)
		assert.JSONEq(t, `{"code":"gateway_timeout","message":"request timed out"}`, rec.Body.String())
	})
}

// TestBodyLimit_413 pins the wall: a body past the limit is refused with the
// one error shape before any handler sees it, and the refused request is
// still a logged request.
func TestBodyLimit_413(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	e := newTestAPI(store.NewMemoryStore(), logger)

	// A body past the 64 KiB limit: the title alone is 64 KiB, plus the
	// JSON around it. The wall is a size check, not a parse — the body is
	// never decoded, which is the point of having it.
	body := `{"title":"` + strings.Repeat("x", 64<<10) + `"}`
	rec := send(t, e, http.MethodPost, "/api/v1/tasks", body)

	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	assert.JSONEq(t, `{"code":"request_entity_too_large","message":"Request Entity Too Large"}`, rec.Body.String())

	records := logRecords(t, buf)
	require.Len(t, records, 1)
	assert.Equal(t, http.StatusRequestEntityTooLarge, records[0].Status)
}
````


## `internal/api/observability.go`

````go
package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"
)

// Observability, in the two layers a request touches: a span that traces it
// and two collectors that count it. The third signal — the profiles — is a
// gate, in authorization.go, and the record that joins all three is the
// request logger's (see requestLogger, which carries the trace id).
//
// Both layers sit above requestLogger in the stack, and both for the same
// reason: the status they observe must be the status the client received.
// The error handler runs inside the logging middleware (which calls c.Error
// itself), so a 404 or a 500 written by that handler is only final once the
// logging middleware returns — a layer below it would record the 200 the
// response held before the failure was rendered.

// unmatchedRoute is the route label for a request no route pattern matched.
// The empty c.Path() would be a valid label value, but an empty label is
// indistinguishable in a scrape from a missing one, so the unmatched bucket
// has a name — and it is one series, not one per path an unknown client
// probes.
const unmatchedRoute = "unmatched"

// routePattern is the bounded-cardinality name of the route a request
// reached: the pattern echo's router matched, never the concrete path. The
// record wants the path — which task, which filter — while a metric label
// or a span name wants the pattern, because a series or a span per task id
// is unbounded. Chapter 32 promised the labels would use the pattern; this
// is where the two part company.
func routePattern(c echo.Context) string {
	if path := c.Path(); path != "" {
		return path
	}
	return unmatchedRoute
}

// traceRequests starts one server span per request and puts it in the
// request's context, where the request record reads its trace id (see
// requestLogger) and anything inside the request — the store calls, a
// future outbound client — can start child spans.
//
// The span's name is the route pattern, for the same reason the metric
// labels are: a span name per task id is unbounded. The span carries the
// request id as an attribute, so the join runs both ways — the trace names
// the request and the record names the trace — and it ends with the status
// the client received, marked an error when the failure was the server's.
func traceRequests(tp trace.TracerProvider) echo.MiddlewareFunc {
	tracer := tp.Tracer("todo/internal/api")
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			req := c.Request()
			ctx, span := tracer.Start(req.Context(), req.Method+" "+routePattern(c),
				trace.WithSpanKind(trace.SpanKindServer))
			defer span.End()
			c.SetRequest(req.WithContext(ctx))

			span.SetAttributes(
				semconv.HTTPRequestMethodKey.String(req.Method),
				semconv.URLPath(req.URL.Path),
				attribute.String("request_id", c.Response().Header().Get(echo.HeaderXRequestID)),
			)

			err := next(c)

			status := c.Response().Status
			span.SetAttributes(semconv.HTTPResponseStatusCode(status))
			if status >= http.StatusInternalServerError {
				span.SetStatus(codes.Error, http.StatusText(status))
			}
			return err
		}
	}
}

// requestMetrics is the RED loop in two collectors: requests_total carries
// the rate and the errors (the status is a label), and
// request_duration_seconds carries the duration. Both are bounded by
// construction — the labels are the method, the route pattern, and the
// status — which is what makes them safe to keep forever.
type requestMetrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

// newRequestMetrics builds the two collectors and registers them on reg,
// the process registry telemetry.NewRegistry built. The histogram keeps
// prometheus's default bucket ladder (5 ms to 10 s), which brackets both a
// local query and the stack's ten-second deadline; the buckets are the
// first knob to tune once a scrape says where requests land.
func newRequestMetrics(reg prometheus.Registerer) *requestMetrics {
	m := &requestMetrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "todo",
			Subsystem: "http",
			Name:      "requests_total",
			Help:      "Requests served, by method, route pattern, and status.",
		}, []string{"method", "route", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: "todo",
			Subsystem: "http",
			Name:      "request_duration_seconds",
			Help:      "Request duration in seconds, by method and route pattern.",
			Buckets:   prometheus.DefBuckets,
		}, []string{"method", "route"}),
	}
	reg.MustRegister(m.requests, m.duration)
	return m
}

// middleware observes every request that reaches it: one counter increment
// and one histogram observation, both after the chain has run, so the
// status is the client's. The scrape's own request is not in the numbers it
// serves — the body is written during the chain, the observation after it —
// which is what makes a scrape deterministic: the counter a scrape reports
// is the counter as of before the scrape.
func (m *requestMetrics) middleware() echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()
			err := next(c)

			method, route := c.Request().Method, routePattern(c)
			m.requests.WithLabelValues(method, route, strconv.Itoa(c.Response().Status)).Inc()
			m.duration.WithLabelValues(method, route).Observe(time.Since(start).Seconds())
			return err
		}
	}
}
````


## `internal/api/observability_test.go`

````go
// Package api_test — the observability cases live in this file. Three
// signals, three subjects: the request counter and the duration histogram
// the scrape endpoint serves, the trace id the request record carries, and
// the admin gate in front of the profiles. Every case drives the stack
// through echo's ServeHTTP entry point, because the stack is what New
// installs and the property under test is what a scraper, a log reader, and
// a caller see.
package api_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/alexedwards/scs/v2/memstore"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/api"
	"todo/internal/auth"
	"todo/internal/store"
	"todo/internal/task"
	"todo/internal/telemetry"
)

// scrapeMetrics performs the scrape the way Prometheus does: one GET
// /metrics, then the exposition text through the format's own parser. The
// assertions read metric families, not substrings, so a label order or an
// escaping a string comparison would forgive cannot hide.
func scrapeMetrics(t *testing.T, e *echo.Echo) map[string]*dto.MetricFamily {
	t.Helper()

	rec := get(t, e, "/metrics")
	require.Equal(t, http.StatusOK, rec.Code, "the scrape endpoint must answer; body: %s", rec.Body.String())

	parser := expfmt.NewTextParser(model.LegacyValidation)
	families, err := parser.TextToMetricFamilies(rec.Body)
	require.NoError(t, err, "the scrape must be valid exposition text")
	return families
}

// counterValue returns the value of the one counter series carrying labels.
func counterValue(t *testing.T, families map[string]*dto.MetricFamily, name string, labels map[string]string) float64 {
	t.Helper()

	family := families[name]
	require.NotNil(t, family, "the scrape must carry %s", name)
	for _, m := range family.GetMetric() {
		if labelsMatch(m, labels) {
			return m.GetCounter().GetValue()
		}
	}
	require.Failf(t, "series not found", "%s with labels %v", name, labels)
	return 0
}

// histogramCount returns the observation count of the one histogram series
// carrying labels.
func histogramCount(t *testing.T, families map[string]*dto.MetricFamily, name string, labels map[string]string) uint64 {
	t.Helper()

	family := families[name]
	require.NotNil(t, family, "the scrape must carry %s", name)
	for _, m := range family.GetMetric() {
		if labelsMatch(m, labels) {
			return m.GetHistogram().GetSampleCount()
		}
	}
	require.Failf(t, "series not found", "%s with labels %v", name, labels)
	return 0
}

// labelsMatch reports whether m carries exactly the given label set. The
// families under test are ours, so the sets are small and complete — an
// extra label is a mismatch, not a detail to skip.
func labelsMatch(m *dto.Metric, labels map[string]string) bool {
	if len(m.GetLabel()) != len(labels) {
		return false
	}
	for _, pair := range m.GetLabel() {
		if labels[pair.GetName()] != pair.GetValue() {
			return false
		}
	}
	return true
}

// TestMetrics_RequestCounter is the chapter's scrape-shaped test: one
// request, one scrape, and the counter the scrape reports has moved. The
// counter and the histogram are the RED loop closed over the wire — the
// rate, the errors, and the duration — and the scrape is the same text a
// Prometheus server would ingest.
func TestMetrics_RequestCounter(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	rec := get(t, e, "/healthz")
	require.Equal(t, http.StatusOK, rec.Code)

	families := scrapeMetrics(t, e)
	assert.Equal(t, 1.0, counterValue(t, families, "todo_http_requests_total", map[string]string{
		"method": http.MethodGet,
		"route":  "/healthz",
		"status": "200",
	}), "the scrape must count the request it followed")
	assert.Equal(t, uint64(1), histogramCount(t, families, "todo_http_request_duration_seconds", map[string]string{
		"method": http.MethodGet,
		"route":  "/healthz",
	}), "the same request must be one observation in the duration histogram")
}

// TestMetrics_RoutePattern pins the bounded-cardinality rule chapter 32
// promised the metric labels: the route label is the pattern the router
// matched, not the path the client sent. The concrete id would be a series
// per task; the pattern is one series per route, which is what makes the
// counter safe to keep.
func TestMetrics_RoutePattern(t *testing.T) {
	t.Parallel()

	e, cookie := newTaskAPI(t, store.NewMemoryStore(), discardLogger())

	// A 404 from a matched route: the task does not exist, and the route
	// pattern is what the label must say.
	rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks/"+uuid.NewString(), "")
	require.Equal(t, http.StatusNotFound, rec.Code)

	families := scrapeMetrics(t, e)
	assert.Equal(t, 1.0, counterValue(t, families, "todo_http_requests_total", map[string]string{
		"method": http.MethodGet,
		"route":  "/api/v1/tasks/:id",
		"status": "404",
	}))

	// An unknown path is one series, not one per path a scanner probes.
	require.Equal(t, http.StatusNotFound, get(t, e, "/nope").Code)
	families = scrapeMetrics(t, e)
	assert.Equal(t, 1.0, counterValue(t, families, "todo_http_requests_total", map[string]string{
		"method": http.MethodGet,
		"route":  "unmatched",
		"status": "404",
	}))
}

// TestMetrics_RuntimeCollectors pins the registry's composition: the
// runtime's own numbers ride the same scrape. go_gc_duration_seconds and
// process_resident_memory_bytes are the memory thread's production readings
// — the GC's own cost and the process's footprint — and go_goroutines is
// the first number an operator checks during an incident.
func TestMetrics_RuntimeCollectors(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	families := scrapeMetrics(t, e)
	for _, name := range []string{"go_gc_duration_seconds", "go_goroutines", "process_resident_memory_bytes"} {
		assert.Contains(t, families, name, "the scrape must carry the runtime's %s", name)
	}
}

// TestRequestLog_TraceID pins the join between the signals: the request's
// record carries the span's trace id, so a log line names the trace a reader
// can open, and every request is its own trace. The failure case pins the
// other half of the join — a request's records all carry the same trace id,
// so an incident is one trace and one request id.
func TestRequestLog_TraceID(t *testing.T) {
	t.Parallel()

	t.Run("the record carries the span's trace id", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)

		rec := get(t, e, "/healthz")

		require.Equal(t, http.StatusOK, rec.Code)
		records := logRecords(t, buf)
		require.Len(t, records, 1)
		assert.Regexp(t, `^[0-9a-f]{32}$`, records[0].TraceID, "a W3C trace id is 32 lowercase hex characters")
	})

	t.Run("each request is its own trace", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)

		require.Equal(t, http.StatusOK, get(t, e, "/healthz").Code)
		require.Equal(t, http.StatusOK, get(t, e, "/healthz").Code)

		records := logRecords(t, buf)
		require.Len(t, records, 2)
		assert.Regexp(t, `^[0-9a-f]{32}$`, records[0].TraceID)
		assert.Regexp(t, `^[0-9a-f]{32}$`, records[1].TraceID)
		assert.NotEqual(t, records[0].TraceID, records[1].TraceID)
	})

	t.Run("a failure's records share the trace", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		st := &StoreMock{}
		st.ScopedFunc = func(uuid.UUID) store.Store { return st }
		st.ListFunc = func(context.Context) ([]task.Task, error) {
			return nil, errors.New("database is away")
		}
		e, cookie := newTaskAPI(t, st, logger)

		rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks", "")
		require.Equal(t, http.StatusInternalServerError, rec.Code)

		records := logRecords(t, buf)
		require.Len(t, records, 2)
		request := findRecord(t, records, "request")
		failure := findRecord(t, records, "request failed")
		require.Regexp(t, `^[0-9a-f]{32}$`, request.TraceID)
		assert.Equal(t, request.TraceID, failure.TraceID)
	})
}

// adminLookup is the pprof cases' authenticator: every method stubAuth
// panics on except UserByID, which answers with the fixed user — the gate
// under test is the one that reads that flag.
type adminLookup struct {
	stubAuth
	user auth.User
	err  error
}

// UserByID answers with the fixed user, or the fixed error.
func (a adminLookup) UserByID(context.Context, uuid.UUID) (auth.User, error) {
	return a.user, a.err
}

// newPprofAPI builds the API over the given lookup and returns it with the
// fixed test user's session cookie: the profiles sit behind RequireUser, so
// every case that gets past the 401 presents the session.
func newPprofAPI(t *testing.T, lookup adminLookup) (*echo.Echo, *http.Cookie) {
	t.Helper()

	sessions := api.NewSessionManager(memstore.New())
	e := api.New(store.NewMemoryStore(), lookup, sessions, discardLogger(), testTracerProvider(), telemetry.NewRegistry())
	return e, testSession(t, sessions)
}

// TestPprof_RequiresAdmin pins the exposure rule: the profiles are reachable
// only by an authenticated admin. Anonymous callers get the one 401 shape
// before the gate is even consulted; an authenticated non-admin gets a 403;
// an admin gets the index, which is where a heap or CPU profile starts.
func TestPprof_RequiresAdmin(t *testing.T) {
	t.Parallel()

	t.Run("anonymous callers are refused", func(t *testing.T) {
		t.Parallel()

		e, _ := newPprofAPI(t, adminLookup{user: auth.User{ID: testUserID, IsAdmin: true}})

		rec := get(t, e, "/debug/pprof/")

		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.JSONEq(t, `{"code":"unauthorized","message":"authentication required"}`, rec.Body.String())
	})

	t.Run("a non-admin is refused", func(t *testing.T) {
		t.Parallel()

		e, cookie := newPprofAPI(t, adminLookup{user: auth.User{ID: testUserID}})

		rec := sendAs(t, e, cookie, http.MethodGet, "/debug/pprof/", "")

		require.Equal(t, http.StatusForbidden, rec.Code)
		assert.JSONEq(t, `{"code":"forbidden","message":"admin required"}`, rec.Body.String())
	})

	t.Run("a session naming no user is refused", func(t *testing.T) {
		t.Parallel()

		e, cookie := newPprofAPI(t, adminLookup{err: fmt.Errorf("user %s: %w", testUserID, auth.ErrUserNotFound)})

		rec := sendAs(t, e, cookie, http.MethodGet, "/debug/pprof/", "")

		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.JSONEq(t, `{"code":"unauthorized","message":"authentication required"}`, rec.Body.String())
	})

	t.Run("a lookup failure is the server's", func(t *testing.T) {
		t.Parallel()

		e, cookie := newPprofAPI(t, adminLookup{err: errors.New("database is away")})

		rec := sendAs(t, e, cookie, http.MethodGet, "/debug/pprof/", "")

		require.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.JSONEq(t, `{"code":"internal_error","message":"internal error"}`, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), "database is away")
	})

	t.Run("an admin reaches the profiles", func(t *testing.T) {
		t.Parallel()

		e, cookie := newPprofAPI(t, adminLookup{user: auth.User{ID: testUserID, IsAdmin: true}})

		rec := sendAs(t, e, cookie, http.MethodGet, "/debug/pprof/", "")

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "goroutine")
		assert.Contains(t, rec.Body.String(), "heap")
	})
}
````


## `internal/api/ownership_test.go`

````go
// Package api_test — the authorization cases live in this file, apart from
// the authentication ones in auth_test.go. The chapter's first failing test
// is TestTask_Foreign_Returns404, the IDOR table: the API must answer 404 —
// not 403 — for every probe of another user's task, because a 403 would leak
// that the task exists.
package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
)

// TestTask_Foreign_Returns404 is the chapter's first failing test: two real
// users, one task owned by the second, and four probes by the first. Every
// probe must answer 404 with the one error shape — the same answer a task
// that does not exist gets — and the owner's task must come out of the
// gauntlet untouched. The 404-not-403 choice is the point: a refusal that
// says "exists, but not yours" is an existence oracle, and an id is the only
// thing an attacker needs to enumerate.
func TestTask_Foreign_Returns404(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	aliceCookie, _ := loginUser(t, e, "alice@example.com")
	bobCookie, _ := loginUser(t, e, "bob@example.com")

	// Bob creates the task Alice must not reach.
	created := sendAs(t, e, bobCookie, http.MethodPost, "/api/v1/tasks", `{"title":"bob's task","tags":["secret"]}`)
	require.Equal(t, http.StatusCreated, created.Code)
	id := createdID(t, created)
	assert.JSONEq(t, taskJSON(id, "bob's task", "Todo", 3, "null", `["secret"]`, 1), created.Body.String())
	target := "/api/v1/tasks/" + id

	// The IDOR table: read, update, complete, delete — every probe answers
	// the same 404, so Alice cannot even tell that the task exists.
	probes := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"see it", http.MethodGet, target, ""},
		{"update it", http.MethodPatch, target, `{"version":1,"title":"stolen"}`},
		{"complete it", http.MethodPatch, target, `{"version":1,"status":"Done"}`},
		{"delete it", http.MethodDelete, target + "?version=1", ""},
	}
	for _, probe := range probes {
		t.Run(probe.name, func(t *testing.T) {
			t.Parallel()

			rec := sendAs(t, e, aliceCookie, probe.method, probe.target, probe.body)

			require.Equal(t, http.StatusNotFound, rec.Code, "a foreign task is a miss, not a refusal")
			assert.JSONEq(t, errorJSON("not_found", "task not found"), rec.Body.String())
		})
	}

	// The collection does not carry it either: the list is scoped in the
	// query, so the foreign task is not filtered out — it was never read.
	list := sendAs(t, e, aliceCookie, http.MethodGet, "/api/v1/tasks", "")
	require.Equal(t, http.StatusOK, list.Code)
	assert.JSONEq(t, tasksJSON(), list.Body.String())

	// The owner's view is untouched: the probes changed nothing.
	got := sendAs(t, e, bobCookie, http.MethodGet, target, "")
	require.Equal(t, http.StatusOK, got.Code)
	assert.JSONEq(t, taskJSON(id, "bob's task", "Todo", 3, "null", `["secret"]`, 1), got.Body.String())

	// Alice's own tasks are reachable through the same routes: the scope is
	// a filter, not a wall.
	own := sendAs(t, e, aliceCookie, http.MethodPost, "/api/v1/tasks", `{"title":"alice's task"}`)
	require.Equal(t, http.StatusCreated, own.Code)
	ownID := createdID(t, own)
	rec := sendAs(t, e, aliceCookie, http.MethodGet, "/api/v1/tasks/"+ownID, "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "alice's task")
}

// TestTaskRoutes_RequireUser pins the gate: every task route refuses an
// anonymous caller with the one 401 shape, before anything else runs — no
// id is parsed, no body is read, no store is touched — while the auth routes
// stay open, and their own 401 (a failed login) keeps its own message.
func TestTaskRoutes_RequireUser(t *testing.T) {
	t.Parallel()

	e, session := newTaskAPI(t, store.NewMemoryStore(), discardLogger())
	missing := "00000000-0000-0000-0000-000000000042"

	probes := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"list", http.MethodGet, "/api/v1/tasks", ""},
		{"create", http.MethodPost, "/api/v1/tasks", `{"title":"write tests"}`},
		{"get", http.MethodGet, "/api/v1/tasks/" + missing, ""},
		{"update", http.MethodPatch, "/api/v1/tasks/" + missing, `{"version":1,"title":"write tests"}`},
		{"delete", http.MethodDelete, "/api/v1/tasks/" + missing + "?version=1", ""},
	}

	for _, probe := range probes {
		t.Run(probe.name, func(t *testing.T) {
			t.Parallel()

			rec := send(t, e, probe.method, probe.target, probe.body)

			require.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.JSONEq(t, errorJSON("unauthorized", "authentication required"), rec.Body.String())
		})
	}

	t.Run("a forged cookie is anonymous", func(t *testing.T) {
		t.Parallel()

		// A token nothing holds is an empty session, not a forged one: the
		// gate answers exactly as it does with no cookie at all. The name
		// and the flags match the genuine cookie's, so the forgery is the
		// token and nothing else.
		forged := &http.Cookie{
			Name:     session.Name,
			Value:    "not-a-real-token",
			Secure:   true,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		}

		rec := sendAs(t, e, forged, http.MethodGet, "/api/v1/tasks", "")

		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.JSONEq(t, errorJSON("unauthorized", "authentication required"), rec.Body.String())
	})

	t.Run("the auth routes stay open", func(t *testing.T) {
		t.Parallel()

		authAPI, _, _ := newAuthAPI(t, discardLogger())

		rec := send(t, authAPI, http.MethodPost, "/api/v1/auth/login",
			`{"email":"nobody@example.com","password":"wrong password"}`)

		// A 401 either way, but the other one: the login route is reachable
		// anonymously, and its 401 is the credentials check's.
		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.JSONEq(t, errorJSON("unauthorized", "invalid email or password"), rec.Body.String())
	})
}
````


## `internal/api/ratelimit.go`

````go
package api

import (
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/time/rate"
)

// The login limiter: the stack's guard on the two routes that check
// credentials — the form edge's POST /login and the JSON edge's POST
// /api/v1/auth/login. The shape, and why it is this one:
//
//   - One budget per source address, shared by both routes. A per-route
//     limiter would hand an attacker two budgets for alternating edges; a
//     per-account limiter would hand them a weapon — burn a victim's bucket
//     and the victim cannot log in, so the account dimension needs a shape
//     that does not deny (progressive delays, a challenge) and is future
//     material. The source address is the dimension that costs an attacker
//     something to change, and it is the one this limiter keys on.
//   - The key is the client's address as the instance's IPExtractor resolves
//     it (peerAddress; the extractor is configured in New). A client can
//     write X-Forwarded-For, and echo's legacy RealIP believes it — a
//     limiter keyed on a spoofable header is a limiter an attacker evades by
//     editing a string. Chapter 48 puts Caddy on loopback, and the extractor
//     is where a forwarded address becomes trustworthy: the transport peer
//     stays the key unless that peer is the loopback proxy, and then the
//     nearest untrusted entry of X-Forwarded-For is — the address the proxy
//     appended, never the client's own prefix.
//   - echo's middleware.RateLimiter over its memory store, not a hand-rolled
//     map of x/time/rate limiters: the store is the same token bucket
//     (x/time/rate underneath), and echo's layer adds the two seams this
//     needs — the identifier extractor and the deny handler that renders the
//     house 429. The memory cost, named rather than hidden: the store keeps
//     one map entry and one rate.Limiter per address seen in the last
//     loginBucketTTL, swept lazily on the next attempt, so the steady size
//     is the addresses that attempted a login in the window — a handful at
//     human rates, and a botnet spray grows it until the sweep. Chapter 45's
//     metrics would show that first; a capped store is the answer if it ever
//     arrives.
//   - Every attempt spends a token, not just failures: the limiter sits in
//     front of the handler, so it cannot know the outcome, and a legitimate
//     login rarely notices a bucket that refills one token per interval. The
//     burst is five — a person who mistypes a password five times waits ten
//     seconds, and a script gets five argon2id hashes (~95 ms of CPU) per
//     ten seconds per address.
//
// The 429 leaves through the one error handler like every other refusal —
// {"code":"too_many_requests",...}, the code derived from the status text —
// with Retry-After: the bucket refills one token every loginRefill, so a
// token is at most one interval away, and that interval is the honest bound.
const (
	// webLoginPath and apiLoginPath are the routes the limiter guards, as
	// echo's route patterns: c.Path() answers the registered pattern, so
	// the predicate names the routes rather than any URL that resembles
	// them. The form edge's path is web's; the coupling is this constant
	// and one sentence in web's Register comment.
	webLoginPath = "/login"
	apiLoginPath = "/api/v1/auth/login"

	// loginBurst is the number of attempts a source may make back to back
	// before the bucket empties.
	loginBurst = 5

	// loginRefill is the interval at which one attempt returns to the
	// bucket: five attempts, then one per ten seconds per address.
	loginRefill = 10 * time.Second

	// loginRetryAfter is what the refusal advertises. One refill interval
	// is the longest wait a token can be away, so it is the honest bound.
	loginRetryAfter = "10"

	// loginBucketTTL is how long an idle address keeps its bucket. The
	// window bounds the store's steady size to the addresses seen in the
	// last three minutes, and it is the other half of the memory cost.
	loginBucketTTL = 3 * time.Minute
)

// loginLimiter builds the limiter the stack installs (see useStack). It is
// one instance per process, so the budget is one budget.
func loginLimiter() echo.MiddlewareFunc {
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		// The predicate is the route and the verb: the budget is for
		// attempts, and an attempt is a POST that carries credentials. A
		// GET of the login page renders the form (and mints the session
		// its token lives in) and is not a guess, so a browser that opens
		// the form, backs out, and opens it again never spends a token.
		Skipper: func(c echo.Context) bool {
			if c.Request().Method != http.MethodPost {
				return true
			}
			switch c.Path() {
			case webLoginPath, apiLoginPath:
				return false
			}
			return true
		},
		IdentifierExtractor: peerAddress,
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(loginRefill),
			Burst:     loginBurst,
			ExpiresIn: loginBucketTTL,
		}),
		DenyHandler: func(c echo.Context, _ string, _ error) error {
			c.Response().Header().Set(echo.HeaderRetryAfter, loginRetryAfter)
			return echo.NewHTTPError(http.StatusTooManyRequests, "too many login attempts")
		},
	})
}

// peerAddress keys the bucket on the client's address as the stack resolves
// it: the instance's IPExtractor (configured in New), which takes the nearest
// untrusted entry of X-Forwarded-For when the peer is the loopback proxy and
// the transport peer itself otherwise. Chapter 39's rule is unchanged where
// it matters — an untrusted peer's header moves nothing — and chapter 48
// widens it exactly once, for the proxy the deployment puts on loopback. A
// RemoteAddr the extractor cannot parse falls back to its raw text, so a key
// is always available; echo's extractor error path exists for extractors
// that can fail to decide, and this one does not.
func peerAddress(c echo.Context) (string, error) {
	if ip := c.RealIP(); ip != "" {
		return ip, nil
	}
	return c.Request().RemoteAddr, nil
}
````


## `internal/api/security_test.go`

````go
// Package api_test — the hardening cases live in this file, apart from the
// health, task, auth, middleware, and docs cases. Every case drives the
// stack through echo's own ServeHTTP entry point, because the chapter's
// subject is what a client sees: the header policy on every response, the
// policy's exact text, the refusals that used to leave without headers, the
// transport-security rule, and the login limiter's 429.
package api_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
)

// The policies the cases pin, spelled here rather than read from the
// implementation: a test that reads the constant it tests cannot catch the
// constant changing. TestCSP_Snapshot is the review surface for an edit —
// any policy change lands as a diff in this file.
const (
	// wantCSP is the process policy: the pages' and the API's, the one the
	// MPA's inventory produced.
	wantCSP = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

	// wantSwaggerCSP is the docs UI's policy: swagger-ui ships a script
	// bundle and an inline bootstrap script, an inline style block, and
	// data: icons in its stylesheet, so the process policy would leave it
	// blank.
	wantSwaggerCSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
)

// securityHeaderSet is the policy set every response the process writes
// must carry. TestSecurityHeaders asserts it one header per subtest — a
// missing header fails by name — and the refusal cases assert the same set
// on the responses that used to leave without it.
var securityHeaderSet = []struct{ header, want string }{
	{echo.HeaderContentSecurityPolicy, wantCSP},
	{echo.HeaderXContentTypeOptions, "nosniff"},
	{echo.HeaderXFrameOptions, "DENY"},
	{echo.HeaderReferrerPolicy, "no-referrer"},
	{echo.HeaderXXSSProtection, "0"},
}

// assertSecurityHeaderSet asserts the whole set, one header per assertion.
func assertSecurityHeaderSet(t *testing.T, header http.Header) {
	t.Helper()
	for _, tc := range securityHeaderSet {
		assert.Equalf(t, tc.want, header.Get(tc.header), "header %s", tc.header)
	}
}

// TestSecurityHeaders pins the surrounding headers, one assertion per
// header, on a response the handler writes.
func TestSecurityHeaders(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	for _, tc := range securityHeaderSet {
		t.Run(tc.header, func(t *testing.T) {
			t.Parallel()

			rec := get(t, e, "/healthz")

			require.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, tc.want, rec.Header().Get(tc.header))
		})
	}
}

// TestCSP_Snapshot is the chapter's snapshot: the policy pinned as one
// exact string — an edit is a diff a reviewer sees, not a runtime surprise —
// and, below it, the same policy as a directive map, so a failure names the
// directive that moved instead of quoting two long strings at each other.
func TestCSP_Snapshot(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	policy := get(t, e, "/healthz").Header().Get(echo.HeaderContentSecurityPolicy)

	assert.Equal(t, wantCSP, policy)
	assert.Equal(t, map[string]string{
		"default-src":     "'none'",
		"script-src":      "'none'",
		"style-src":       "'self'",
		"img-src":         "'none'",
		"form-action":     "'self'",
		"base-uri":        "'none'",
		"frame-ancestors": "'none'",
	}, cspDirectives(policy))
}

// cspDirectives splits a policy into its directive → sources pairs.
func cspDirectives(policy string) map[string]string {
	directives := make(map[string]string)
	for _, part := range strings.Split(policy, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, sources, _ := strings.Cut(part, " ")
		directives[name] = sources
	}
	return directives
}

// TestCSP_SwaggerUI pins the docs UI's own policy: the route replaces the
// process policy where the exception lives, and every other header still
// rides the response.
func TestCSP_SwaggerUI(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	rec := get(t, e, "/swagger/index.html")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, wantSwaggerCSP, rec.Header().Get(echo.HeaderContentSecurityPolicy))
	assert.Equal(t, "nosniff", rec.Header().Get(echo.HeaderXContentTypeOptions))
	assert.Equal(t, "DENY", rec.Header().Get(echo.HeaderXFrameOptions))
}

// TestHSTS pins the transport-security rule in four cases: the header rides
// an https request and nothing else. A plain-http response carries none —
// a browser ignores HSTS on http anyway — and a forwarded proto counts only
// when the peer that sent it is trusted, which is echo's own rule and the
// one chapter 48's proxy will sit inside.
func TestHSTS(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	t.Run("an https request carries it", func(t *testing.T) {
		t.Parallel()

		rec := get(t, e, "https://todo.example/healthz")

		assert.Equal(t, "max-age=31536000", rec.Header().Get(echo.HeaderStrictTransportSecurity))
	})

	t.Run("a plain-http request carries none", func(t *testing.T) {
		t.Parallel()

		rec := get(t, e, "http://todo.example/healthz")

		assert.Empty(t, rec.Header().Get(echo.HeaderStrictTransportSecurity))
	})

	t.Run("a forwarded proto from an untrusted peer is ignored", func(t *testing.T) {
		t.Parallel()

		req := httptest.NewRequest(http.MethodGet, "http://todo.example/healthz", nil)
		req.RemoteAddr = "203.0.113.9:5312" // TEST-NET-3: not loopback, not private
		req.Header.Set(echo.HeaderXForwardedProto, "https")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		assert.Empty(t, rec.Header().Get(echo.HeaderStrictTransportSecurity),
			"an internet peer cannot claim TLS")
	})

	t.Run("a trusted peer's forwarded proto is believed", func(t *testing.T) {
		t.Parallel()

		req := httptest.NewRequest(http.MethodGet, "http://todo.example/healthz", nil)
		req.RemoteAddr = "127.0.0.1:5312"
		req.Header.Set(echo.HeaderXForwardedProto, "https")
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		assert.Equal(t, "max-age=31536000", rec.Header().Get(echo.HeaderStrictTransportSecurity),
			"the loopback peer is the proxy chapter 48 will put here")
	})
}

// TestRefusals_CarrySecurityHeaders closes chapter 32's second order edge:
// the refusals decided above the old Secure position — the body limit's 413
// and the CORS preflight's 204 — carry the header set like every other
// response, because Secure now sits above both.
func TestRefusals_CarrySecurityHeaders(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	t.Run("the body limit's 413", func(t *testing.T) {
		t.Parallel()

		body := `{"title":"` + strings.Repeat("x", 64<<10) + `"}`
		rec := send(t, e, http.MethodPost, "/api/v1/tasks", body)

		require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
		assertSecurityHeaderSet(t, rec.Header())
	})

	t.Run("the CORS preflight's 204", func(t *testing.T) {
		t.Parallel()

		req := httptest.NewRequest(http.MethodOptions, "/api/v1/tasks", nil)
		req.Header.Set(echo.HeaderOrigin, "https://evil.example")
		req.Header.Set(echo.HeaderAccessControlRequestMethod, http.MethodGet)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		require.Equal(t, http.StatusNoContent, rec.Code)
		assert.Empty(t, rec.Header().Get(echo.HeaderAccessControlAllowOrigin), "the CORS policy is still closed")
		assertSecurityHeaderSet(t, rec.Header())
	})
}

// TestErrorResponse_Uncompressed re-scopes chapter 32's first order edge
// rather than closing it: the error handler runs at the logging middleware's
// level, above Gzip, so an error body is written to the raw writer. The
// chapter keeps that shape — error bodies are tens of bytes and a gzip
// frame would outweigh them — and this case pins it, so a reorder that
// silently starts compressing refusals is a visible diff.
func TestErrorResponse_Uncompressed(t *testing.T) {
	t.Parallel()

	e := newTestAPI(store.NewMemoryStore(), discardLogger())

	req := httptest.NewRequest(http.MethodGet, "/api/v1/nope", nil)
	req.Header.Set(echo.HeaderAcceptEncoding, "gzip")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.Empty(t, rec.Header().Get(echo.HeaderContentEncoding), "the body is not compressed")
	assert.JSONEq(t, `{"code":"not_found","message":"Not Found"}`, rec.Body.String())
	assert.Contains(t, rec.Header().Values(echo.HeaderVary), echo.HeaderAcceptEncoding,
		"the Vary contract still rides the response")
}

// TestLoginLimiter_429 pins the login budget: the burst's worth of attempts
// reaches the credential check, the next one is refused with the house 429 —
// Retry-After included, and a WARN record like every client failure.
func TestLoginLimiter_429(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	e, _, _ := newAuthAPI(t, logger)
	register(t, e, "alice@example.com", "correct horse battery staple")

	// The burst: five attempts that reach the check and fail it. The sixth
	// never reaches it.
	for i := range 5 {
		rec := login(t, e, "alice@example.com", "wrong password")
		require.Equal(t, http.StatusUnauthorized, rec.Code, "attempt %d", i+1)
	}

	rec := login(t, e, "alice@example.com", "wrong password")

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.JSONEq(t, `{"code":"too_many_requests","message":"too many login attempts"}`, rec.Body.String())
	assert.Equal(t, "10", rec.Header().Get(echo.HeaderRetryAfter))

	records := logRecords(t, buf)
	var refused *logRecord
	for i := range records {
		if records[i].Status == http.StatusTooManyRequests {
			refused = &records[i]
		}
	}
	require.NotNil(t, refused, "the refusal is a logged request")
	assert.Equal(t, "WARN", refused.Level)
}

// TestLoginLimiter_KeyedOnPeerAddress pins the trust boundary for a peer the
// deployment does not trust: the bucket is the transport peer's, and
// X-Forwarded-For — which any client can write — moves nothing. The one peer
// whose forwarded address is believed is the loopback proxy, and
// TestLoginLimiter_TrustedProxy is that half.
func TestLoginLimiter_KeyedOnPeerAddress(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	// Five attempts from one peer, each claiming a different forwarded
	// address: if the claim were the key, every attempt would get a fresh
	// bucket.
	for i := range 5 {
		rec := loginFrom(t, e, "198.51.100.7:4000", fmt.Sprintf("203.0.113.%d", i+1))
		require.Equal(t, http.StatusUnauthorized, rec.Code, "attempt %d", i+1)
	}
	refused := loginFrom(t, e, "198.51.100.7:4000", "203.0.113.99")
	require.Equal(t, http.StatusTooManyRequests, refused.Code)

	// A different peer still has its own budget: the key is the address,
	// not the credential.
	other := loginFrom(t, e, "198.51.100.8:4000", "")
	assert.Equal(t, http.StatusUnauthorized, other.Code)
}

// TestLoginLimiter_TrustedProxy is chapter 48's half of the trust boundary:
// the deployment puts Caddy on loopback in front, so every request's
// transport peer is the proxy — one bucket for the whole internet if the
// limiter kept keying on the socket. The stack's extractor takes the nearest
// untrusted entry of X-Forwarded-For instead (see api.New), and the cases
// pin the three properties that make it safe: the address the proxy appended
// is the key, a client-supplied prefix is not, and a second client behind
// the same proxy has a bucket of its own.
func TestLoginLimiter_TrustedProxy(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	// Five attempts from one client behind the proxy. The header is what
	// Caddy writes: the client's own claim first, then the address Caddy
	// saw — and the claim changes on every attempt while the truth does
	// not.
	for i := range 5 {
		rec := loginFrom(t, e, "127.0.0.1:5555", fmt.Sprintf("203.0.113.%d, 198.51.100.9", i+1))
		require.Equal(t, http.StatusUnauthorized, rec.Code, "attempt %d", i+1)
	}

	// The sixth attempt from the same client — a different claim, the same
	// forwarded address — is refused: the bucket is the forwarded client's.
	refused := loginFrom(t, e, "127.0.0.1:5555", "203.0.113.99, 198.51.100.9")
	require.Equal(t, http.StatusTooManyRequests, refused.Code)

	// A second client behind the same proxy still has its own budget. If
	// the limiter keyed on the proxy's socket — chapter 39's rule before
	// this chapter — this attempt would already be refused.
	other := loginFrom(t, e, "127.0.0.1:5555", "198.51.100.10")
	assert.Equal(t, http.StatusUnauthorized, other.Code)
}

// TestLoginLimiter_RealIPHeaderIgnored pins the half of chapter 39's
// decision that must survive the proxy: X-Real-IP is not consulted, trusted
// peer or not. Caddy does not set it, so a client that does must not get a
// fresh bucket by editing a header — the legacy RealIP path stays closed
// even where a forwarded address is believed.
func TestLoginLimiter_RealIPHeaderIgnored(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	// Five attempts from the proxy's socket, each carrying a different
	// X-Real-IP and no X-Forwarded-For: the socket is the only fact, so the
	// sixth attempt is refused.
	for i := range 5 {
		rec := loginWithHeaders(t, e, "127.0.0.1:5555", map[string]string{
			echo.HeaderXRealIP: fmt.Sprintf("203.0.113.%d", i+1),
		})
		require.Equal(t, http.StatusUnauthorized, rec.Code, "attempt %d", i+1)
	}
	rec := loginWithHeaders(t, e, "127.0.0.1:5555", map[string]string{
		echo.HeaderXRealIP: "203.0.113.99",
	})
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
}

// TestLoginLimiter_PrivatePeerUntrusted pins the trust rule's boundary: the
// extractor trusts loopback and nothing else, so a peer on a private network
// — echo's default trust set would believe it — cannot move the key by
// claiming a forwarded address. The deployment binds loopback (see the
// unit); a topology that puts the proxy somewhere else is a deliberate edit
// to the trust options, not a silent widening.
func TestLoginLimiter_PrivatePeerUntrusted(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	for i := range 5 {
		rec := loginFrom(t, e, "10.0.0.5:5555", fmt.Sprintf("203.0.113.%d", i+1))
		require.Equal(t, http.StatusUnauthorized, rec.Code, "attempt %d", i+1)
	}
	rec := loginFrom(t, e, "10.0.0.5:5555", "203.0.113.99")
	assert.Equal(t, http.StatusTooManyRequests, rec.Code, "a private peer's forwarded address moves nothing")
}

// TestLoginLimiter_OtherRoutesUnaffected pins the skipper's scope: only the
// two login routes spend the budget — probes, page fetches, and the task
// routes do not — so a browser reloading a form is not an attempt.
func TestLoginLimiter_OtherRoutesUnaffected(t *testing.T) {
	t.Parallel()

	e, _, _ := newAuthAPI(t, discardLogger())
	register(t, e, "alice@example.com", "correct horse battery staple")

	for range 6 {
		require.Equal(t, http.StatusOK, get(t, e, "/healthz").Code)
	}

	rec := login(t, e, "alice@example.com", "wrong password")

	assert.Equal(t, http.StatusUnauthorized, rec.Code, "no non-login request spends the login budget")
}

// loginFrom sends a login attempt from a given transport peer, with an
// X-Forwarded-For the client chose: the peer is the transport's fact, the
// header is the client's claim, and the limiter's key is the difference.
func loginFrom(t *testing.T, h http.Handler, remoteAddr, forwardedFor string) *httptest.ResponseRecorder {
	t.Helper()
	headers := map[string]string{}
	if forwardedFor != "" {
		headers[echo.HeaderXForwardedFor] = forwardedFor
	}
	return loginWithHeaders(t, h, remoteAddr, headers)
}

// loginWithHeaders sends a login attempt from a given transport peer with
// the headers a case is about.
func loginWithHeaders(t *testing.T, h http.Handler, remoteAddr string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"alice@example.com","password":"wrong password"}`))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	req.RemoteAddr = remoteAddr
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestRequestID_LengthCapped is the audit's third parked item: chapter 32
// trusted a client-supplied id without a size bound, and every record about
// the request carries it. An id over the cap is not a correlation id, so it
// is replaced with a generated one — and the client reads the replacement
// back from the response header, which is the canonical copy.
func TestRequestID_LengthCapped(t *testing.T) {
	t.Parallel()

	t.Run("a plausible id is kept", func(t *testing.T) {
		t.Parallel()

		logger, _ := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)
		id := strings.Repeat("a", 64)

		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		req.Header.Set(echo.HeaderXRequestID, id)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		assert.Equal(t, id, rec.Header().Get(echo.HeaderXRequestID))
	})

	t.Run("an over-long id is replaced", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := newTestAPI(store.NewMemoryStore(), logger)
		tooLong := strings.Repeat("a", 65)

		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		req.Header.Set(echo.HeaderXRequestID, tooLong)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)

		got := rec.Header().Get(echo.HeaderXRequestID)
		assert.NotEqual(t, tooLong, got, "an over-long id is not a correlation id")
		assert.NotEmpty(t, got)
		records := logRecords(t, buf)
		require.Len(t, records, 1)
		assert.Equal(t, got, records[0].RequestID, "the record carries the id the client can quote")
	})
}
````


## `internal/api/sessions.go`

````go
package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/labstack/echo/v4"
)

// hostCookieName is the session cookie's name: the __Host- prefix plus the
// name the cookie has carried since chapter 33.
const hostCookieName = "__Host-session"

// NewSessionManager builds the session manager over store, with the cookie
// policy in one place.
//
// scs's defaults are already the hardened baseline — HttpOnly on, SameSite
// Lax, Path "/", a 24-hour absolute lifetime, a persistent cookie — so the
// two values this constructor decides beyond that are Secure and the name.
// The rest are spelled out anyway, because a default is not a decision:
// every value a reader would ask "why?" about is written here with its
// reason.
//
// The manager is built here, in the HTTP layer, because every knob is an HTTP
// policy — and because the tests must assert the production policy, not a
// copy of it: main and the api tests both call this constructor, and the
// store underneath is the only part they choose differently.
func NewSessionManager(store scs.Store) *scs.SessionManager {
	m := scs.New()
	m.Store = store

	// The name carries the __Host- prefix, which is the browser's rule and
	// not the server's: a cookie that claims it must be Secure, have Path
	// "/", and carry no Domain — all three already true of this policy,
	// which is why the audit's rename is the whole change. What the browser
	// enforces in return is origin-scoping: a sibling application on a
	// parent domain cannot write a "__Host-session" cookie that this origin
	// would read, so cookie shadowing and fixation-by-subdomain are closed
	// by the name. The cost is one logged-out visit per browser that holds
	// an older "session" cookie: the old name is simply ignored from now
	// on.
	m.Cookie.Name = hostCookieName

	// The session's absolute lifetime: a session cannot outlive a day,
	// however active it is. Sliding expiry would be kinder to daily users
	// and kinder to a thief at the same time — an attacker who keeps using
	// the cookie keeps it alive — so the window is fixed, and the cookie's
	// Max-Age and Expires say so.
	m.Lifetime = 24 * time.Hour

	// Secure: the cookie never travels over plain http. The flag is
	// enforced by the user agent, not the server — a plain-http client that
	// sends the cookie back anyway is accepted, which is why the tests and
	// the live capture can drive the flow over http, and what makes
	// production's TLS (chapter 48) the thing the flag actually relies on.
	m.Cookie.Secure = true
	// HttpOnly: scripts cannot read the session. This application has no
	// JavaScript at all — chapter 36's stance — which makes the flag free,
	// and exactly the kind of free defense that matters the day a page
	// embeds a third-party script.
	m.Cookie.HttpOnly = true
	// SameSite Lax: the cookie rides top-level GET navigations but not
	// cross-site form posts or subresource requests. Strict would break the
	// everyday "follow a link into the app" flow — the first request from
	// elsewhere would arrive logged out — while Lax's remaining hole (a
	// top-level GET) is a read, not a write, and state-changing requests
	// get chapter 37's CSRF tokens on top.
	m.Cookie.SameSite = http.SameSiteLaxMode
	// Path "/": the API and, from chapter 36, the web pages share one
	// session; a narrower path would make the pages a second, separate
	// login.
	m.Cookie.Path = "/"

	// The failure handler for both halves of the middleware's work, loading
	// and committing. scs's default writes a plain-text 500 and logs through
	// the standard library logger; wired here, the failure is the one error
	// shape and the record goes through the request's logger, so it carries
	// the request id like every other record about that request.
	m.ErrorFunc = sessionErrorFunc
	return m
}

// sessionErrorFunc renders a session load or commit failure in the one error
// shape. The write's own error has nowhere useful to go — the client is being
// told the request failed either way — so the record above is the report.
func sessionErrorFunc(w http.ResponseWriter, r *http.Request, err error) {
	LoggerFrom(r.Context()).Error("session failed", "err", err)
	w.Header().Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(errorResponse{Code: codeInternal, Message: "internal error"})
}
````


## `internal/api/tasks.go`

````go
package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"todo/internal/task"
)

// The task routes: five handlers over the Store contract, and the request and
// response shapes they speak. The DTOs are separate from the domain on
// purpose — the wire is a contract of its own, and a domain rename must not
// change it — while the response keeps the shape the CLI's --json output
// already established: id, title, status, priority, due, tags, version.
//
// Every handler begins by scoping the store to the authenticated user — the
// route is behind RequireUser, so the id is there — and then speaks to that
// view exactly as it spoke to the store before. The owner never reaches the
// SQL from a handler's filter: it is part of every query the view runs, so a
// task another user owns is a miss, not a refusal, and a handler cannot
// forget to filter a result it never sees.
//
// Every write carries the version the caller read. That is the store's
// compare-and-swap surfacing on the wire: the version travels out with the
// task and back with the write, and a write whose snapshot moved on is a 409
// rather than a lost update.

// createTaskRequest is the POST /api/v1/tasks body. The title is the domain's
// to validate — task.NewTask trims it and checks its length — so the DTO
// leaves it untagged; priority and tags are wire-shape rules and are tagged.
// A status is not accepted: a new task starts in Todo, like the CLI's add.
//
// The format tag is swag's: time.Time reaches the spec as a bare string, and
// the tag records the shape the wire actually uses — RFC 3339, the encoding
// chapter 23 settled on.
type createTaskRequest struct {
	Title    string     `json:"title"`
	Priority *int       `json:"priority,omitempty" validate:"omitempty,min=1,max=5"`
	Due      *time.Time `json:"due,omitempty" format:"date-time"`
	Tags     []string   `json:"tags,omitempty" validate:"tags"`
}

// updateTaskRequest is the PATCH /api/v1/tasks/:id body: the version the
// caller read — the value the store's compare-and-swap compares — plus any
// subset of the fields to change. Absent fields are left alone, and a body
// that names no fields is a legal write that bumps the version like any
// other: the version is the API's one precondition, and a patch of nothing
// patches nothing. A null due clears the due date; for the other fields null
// reads as absent, because there is no task without a title, a status, or a
// priority, and a client that serializes every field should not have to omit
// the ones it is not changing.
//
// Two tags here are swag's, not the validator's: due carries
// swaggertype:"string" because swag cannot see through the generic wrapper —
// its wire shape is an RFC 3339 string, or null — and status carries
// enums:"Todo,Done", the vocabulary the domain's own parser enforces.
type updateTaskRequest struct {
	Version  *int                `json:"version" validate:"required,min=1"`
	Title    *string             `json:"title,omitempty"`
	Status   *string             `json:"status,omitempty" enums:"Todo,Done"`
	Priority *int                `json:"priority,omitempty" validate:"omitempty,min=1,max=5"`
	Due      optional[time.Time] `json:"due" swaggertype:"string" format:"date-time"`
	Tags     *[]string           `json:"tags,omitempty" validate:"omitempty,tags"`
}

// optional is a request field that tells "the client did not send this" from
// "the client sent null". A pointer cannot: encoding/json decodes both to
// nil. In a PATCH the two mean different things — absent leaves the field
// alone, null clears it — so the field records presence while decoding. T is
// the field's value type.
type optional[T any] struct {
	set   bool
	value *T
}

// UnmarshalJSON records that the field was present and decodes its value. A
// JSON null leaves the value nil, which is what "clear" means.
func (o *optional[T]) UnmarshalJSON(data []byte) error {
	o.set = true
	if string(data) == "null" {
		o.value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	o.value = &v
	return nil
}

// taskResponse is the wire shape of a task, the same one the CLI's --json
// output carries: keys lowercase, due null when the task has no due date,
// tags always an array, and version the optimistic-concurrency counter the
// next write must carry back. Change it additively — a renamed or retyped
// key is a breaking change. The format tag is swag's, for the reason
// createTaskRequest's is: the spec says the string is an RFC 3339 instant.
type taskResponse struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Status   string     `json:"status"`
	Priority int        `json:"priority"`
	Due      *time.Time `json:"due" format:"date-time"`
	Tags     []string   `json:"tags"`
	Version  int        `json:"version"`
}

// newTaskResponse converts a domain task to its wire form. The copy owns the
// key names and the null rules, so the domain type can change shape without
// changing the API.
func newTaskResponse(t task.Task) taskResponse {
	r := taskResponse{
		ID:       t.ID.String(),
		Title:    t.Title,
		Status:   t.Status.String(),
		Priority: int(t.Priority),
		Tags:     t.Tags,
		Version:  t.Version,
	}
	if r.Tags == nil {
		r.Tags = []string{}
	}
	if !t.Due.IsZero() {
		due := t.Due
		r.Due = &due
	}
	return r
}

// taskListResponse is the collection's envelope. The tasks key is always an
// array — an empty store lists [] — and the envelope is what leaves room for
// pagination later without changing the shape of what is already there.
type taskListResponse struct {
	Tasks []taskResponse `json:"tasks"`
}

// taskResponses maps tasks to their wire form, always non-nil.
func taskResponses(tasks []task.Task) []taskResponse {
	out := make([]taskResponse, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, newTaskResponse(t))
	}
	return out
}

// bindBody decodes the request body into dst. It is c.Bind — the content type
// picks the decoder, so anything but JSON is echo's 415, and a request with
// no body binds nothing and leaves validation to say what is missing — with
// one adjustment: a body the decoder rejects would otherwise reach the client
// in the decoder's own words ("json: cannot unmarshal string into Go struct
// field ..."), which name Go types the API does not otherwise expose. A body
// failure is answered with one fixed message; the decoder's text belongs in a
// log, not in the contract.
func bindBody(c echo.Context, dst any) error {
	if err := c.Bind(dst); err != nil {
		var he *echo.HTTPError
		if errors.As(err, &he) && he.Code == http.StatusBadRequest {
			return badRequest("invalid JSON body")
		}
		return err
	}
	return nil
}

// taskID parses the :id path parameter. An id that is not a UUID names no
// resource that could exist, so it is a 400 — the request is malformed —
// rather than a 404 that pretends the route was understood.
func taskID(c echo.Context) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return uuid.Nil, badRequest("invalid task id")
	}
	return id, nil
}

// taskPath is the resource path of a task, the value of a create's Location
// header.
func taskPath(id uuid.UUID) string {
	return "/api/v1/tasks/" + id.String()
}

// listTasks answers GET /api/v1/tasks. The two filters map onto the store's
// own queries — status onto ByStatus, tag onto ByTag — and the combination
// the store has no query for is refused instead of answered with one filter
// silently dropped. An unknown status goes through the domain's own parser,
// so the API cannot drift from the statuses the domain knows.
//
//	@Summary		List tasks
//	@Description	Lists the authenticated user's tasks. status and tag are filters and cannot be combined.
//	@Tags			tasks
//	@Produce		json
//	@Param			status	query		string				false	"filter by status"	Enums(Todo, Done)
//	@Param			tag		query		string				false	"filter by tag"
//	@Success		200		{object}	taskListResponse	"the caller's tasks"
//	@Failure		400		{object}	errorResponse		"an invalid filter, or status and tag combined"
//	@Failure		401		{object}	errorResponse		"no session"
//	@Router			/api/v1/tasks [get]
func (s *server) listTasks(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))
	status, tag := c.QueryParam("status"), c.QueryParam("tag")

	var (
		tasks []task.Task
		err   error
	)
	switch {
	case status != "" && tag != "":
		return badRequest("status and tag cannot be combined")
	case status != "":
		var filter task.Status
		if err := filter.UnmarshalText([]byte(status)); err != nil {
			return err
		}
		tasks, err = view.ByStatus(ctx, filter)
	case tag != "":
		tasks, err = view.ByTag(ctx, tag)
	default:
		tasks, err = view.List(ctx)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, taskListResponse{Tasks: taskResponses(tasks)})
}

// createTask answers POST /api/v1/tasks. The body becomes a domain task
// through the same constructor the CLI uses — the title is trimmed and
// checked there — and the store assigns the id and the version. 201 with the
// new resource's Location is what tells a client where the task lives without
// a second request.
//
//	@Summary		Create a task
//	@Description	Creates a task owned by the authenticated user. The title is trimmed and length-checked; a new task starts in Todo with priority 3 unless the body says otherwise.
//	@Tags			tasks
//	@Accept			json
//	@Produce		json
//	@Param			task	body		createTaskRequest	true	"the task to create"
//	@Success		201		{object}	taskResponse		"the stored task"
//	@Header			201		{string}	Location			"the new task's URL"
//	@Failure		400		{object}	errorResponse		"a malformed JSON body"
//	@Failure		401		{object}	errorResponse		"no session"
//	@Failure		415		{object}	errorResponse		"a body that is not JSON"
//	@Failure		422		{object}	errorResponse		"a field failed validation"
//	@Router			/api/v1/tasks [post]
func (s *server) createTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))

	var req createTaskRequest
	if err := bindBody(c, &req); err != nil {
		return err
	}
	if err := c.Validate(&req); err != nil {
		return err
	}

	t, err := task.NewTask(req.Title)
	if err != nil {
		return err
	}
	if req.Priority != nil {
		t.Priority = task.Priority(*req.Priority)
	}
	if req.Due != nil {
		t.Due = req.Due.UTC()
	}
	t.Tags = req.Tags

	stored, err := view.Add(ctx, t)
	if err != nil {
		return err
	}
	c.Response().Header().Set(echo.HeaderLocation, taskPath(stored.ID))
	return c.JSON(http.StatusCreated, newTaskResponse(stored))
}

// getTask answers GET /api/v1/tasks/:id.
//
//	@Summary		Get a task
//	@Description	Returns one of the authenticated user's tasks.
//	@Tags			tasks
//	@Produce		json
//	@Param			id	path		string			true	"task id (UUIDv7)"
//	@Success		200	{object}	taskResponse	"the task"
//	@Failure		400	{object}	errorResponse	"an id that is not a UUID"
//	@Failure		401	{object}	errorResponse	"no session"
//	@Failure		404	{object}	errorResponse	"no such task in the caller's scope"
//	@Router			/api/v1/tasks/{id} [get]
func (s *server) getTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))

	id, err := taskID(c)
	if err != nil {
		return err
	}
	t, err := view.Get(ctx, id)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newTaskResponse(t))
}

// updateTask answers PATCH /api/v1/tasks/:id. The read is the merge base, not
// the compare-and-swap: the version the body carries is the caller's
// snapshot, and handing it to Update unchanged is what makes a lost update
// impossible — a task that changed since the caller read it fails with
// ErrConflict instead of being overwritten. The merged task is written whole,
// which is the store's contract.
//
//	@Summary		Update a task
//	@Description	PATCH semantics: absent fields keep their value, a null due clears the date, and the version the caller read is required. A stale version is a 409, not a lost update.
//	@Tags			tasks
//	@Accept			json
//	@Produce		json
//	@Param			id		path		string				true	"task id (UUIDv7)"
//	@Param			patch	body		updateTaskRequest	true	"the version the caller read, plus the fields to change"
//	@Success		200		{object}	taskResponse		"the stored task"
//	@Failure		400		{object}	errorResponse		"a malformed JSON body or an id that is not a UUID"
//	@Failure		401		{object}	errorResponse		"no session"
//	@Failure		404		{object}	errorResponse		"no such task in the caller's scope"
//	@Failure		409		{object}	errorResponse		"the version is stale"
//	@Failure		415		{object}	errorResponse		"a body that is not JSON"
//	@Failure		422		{object}	errorResponse		"a field failed validation"
//	@Router			/api/v1/tasks/{id} [patch]
func (s *server) updateTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))

	id, err := taskID(c)
	if err != nil {
		return err
	}
	var req updateTaskRequest
	if err := bindBody(c, &req); err != nil {
		return err
	}
	if err := c.Validate(&req); err != nil {
		return err
	}

	merged, err := view.Get(ctx, id)
	if err != nil {
		return err
	}
	if req.Title != nil {
		// The domain constructor is also the title rule: it trims and
		// checks the length, so the API and the CLI cannot drift.
		normalized, err := task.NewTask(*req.Title)
		if err != nil {
			return err
		}
		merged.Title = normalized.Title
	}
	if req.Status != nil {
		var status task.Status
		if err := status.UnmarshalText([]byte(*req.Status)); err != nil {
			return err
		}
		merged.Status = status
	}
	if req.Priority != nil {
		merged.Priority = task.Priority(*req.Priority)
	}
	if req.Due.set {
		// A present due is the client's answer either way: null clears the
		// date, a value sets it.
		merged.Due = time.Time{}
		if req.Due.value != nil {
			merged.Due = req.Due.value.UTC()
		}
	}
	if req.Tags != nil {
		merged.Tags = *req.Tags
	}
	merged.Version = *req.Version

	stored, err := view.Update(ctx, merged)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newTaskResponse(stored))
}

// deleteTask answers DELETE /api/v1/tasks/:id?version=N: the same
// compare-and-swap the other writes use, with 204 on success because there is
// nothing left to describe. The version is required — a delete that did not
// say which snapshot it was deleting would be the one write without the
// guarantee every other write makes — and it rides the query string, because
// a DELETE body is not portable across proxies. That is also why the handler
// parses it itself: the version is a query parameter, and a missing or
// unusable one is a 400 that names it, not a body field's 422.
//
//	@Summary		Delete a task
//	@Description	Deletes one of the authenticated user's tasks. The version is required on the query string — a DELETE body is not portable — and a stale one is a 409.
//	@Tags			tasks
//	@Param			id		path	string	true	"task id (UUIDv7)"
//	@Param			version	query	integer	true	"the version the caller read"
//	@Success		204		"no content"
//	@Failure		400		{object}	errorResponse	"a missing or unusable version"
//	@Failure		401		{object}	errorResponse	"no session"
//	@Failure		404		{object}	errorResponse	"no such task in the caller's scope"
//	@Failure		409		{object}	errorResponse	"the version is stale"
//	@Router			/api/v1/tasks/{id} [delete]
func (s *server) deleteTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))

	id, err := taskID(c)
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(c.QueryParam("version"))
	if err != nil || version < 1 {
		return badRequest("version must be a positive integer")
	}
	if err := view.Delete(ctx, id, version); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
````


## `internal/api/tasks_test.go`

````go
// Package api_test — the task CRUD cases live in this file, apart from
// api_test.go's health and lifecycle cases. Every case drives the routes
// through echo's own ServeHTTP entry point and seeds its store through the
// Store contract, so the tests say what the API does, not how the handler
// happens to call the store.
package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/task"
)

// dueDay is the fixed due date the wire-shape cases share: midnight UTC on
// November 5, 2026, which is what the API emits for a dated task.
var dueDay = time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)

// request builds one request without a socket: a non-empty body is sent as
// application/json, the content type every JSON body case needs; the
// content-type case builds its own request instead.
func request(t *testing.T, method, target, body string) *http.Request {
	t.Helper()
	if body == "" {
		return httptest.NewRequest(method, target, nil)
	}
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

// send drives one request through the handler without a socket.
func send(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request(t, method, target, body))
	return rec
}

// sendAs is send with a session cookie: since chapter 34 the task routes sit
// behind RequireUser, so every task case presents the session its helper
// minted.
func sendAs(t *testing.T, h http.Handler, cookie *http.Cookie, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := request(t, method, target, body)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// seedTask adds one task to the test user's scope and returns it with its
// assigned id and version — the snapshot a client would have read. The scope
// is the one the API's task routes serve, so a fixture seeded here is
// reachable through the routes; the store's user-less scope — where a fixture
// seeded without the scope would land — is not.
func seedTask(t *testing.T, st store.Store, tt task.Task) task.Task {
	t.Helper()
	added, err := st.Scoped(testUserID).Add(context.Background(), tt)
	require.NoError(t, err)
	return added
}

// storedTask returns the task with the given id from the test user's scope.
func storedTask(t *testing.T, st store.Store, id string) task.Task {
	t.Helper()
	tasks, err := st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	for _, tt := range tasks {
		if tt.ID.String() == id {
			return tt
		}
	}
	t.Fatalf("task %s is not in the store", id)
	return task.Task{}
}

// taskJSON renders the wire shape of one task. Every key is spelled out —
// including the null due and the empty tags — because the shape is the
// contract: assert.JSONEq requires both documents to carry the same keys, so
// a renamed or dropped field fails the case that pins it.
func taskJSON(id, title, status string, priority int, due, tags string, version int) string {
	return fmt.Sprintf(`{"id":%q,"title":%q,"status":%q,"priority":%d,"due":%s,"tags":%s,"version":%d}`,
		id, title, status, priority, due, tags, version)
}

// tasksJSON wraps task objects in the list response's envelope.
func tasksJSON(tasks ...string) string {
	return `{"tasks":[` + strings.Join(tasks, ",") + `]}`
}

// errorJSON renders the API's one error shape. fields are fieldJSON strings.
func errorJSON(code, message string, fields ...string) string {
	body := fmt.Sprintf(`{"code":%q,"message":%q`, code, message)
	if len(fields) > 0 {
		body += `,"fields":[` + strings.Join(fields, ",") + `]`
	}
	return body + "}"
}

// fieldJSON renders one field-level failure.
func fieldJSON(field, message string) string {
	return fmt.Sprintf(`{"field":%q,"message":%q}`, field, message)
}

// createdID reads the id out of a create response.
func createdID(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var got struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.NotEmpty(t, got.ID, "a created task carries its id")
	return got.ID
}

// TestCreateTask pins the happy path: 201, the Location header, the task
// shape on the wire, and the task in the store at version 1.
func TestCreateTask(t *testing.T) {
	t.Parallel()

	t.Run("every field", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		e, cookie := newTaskAPI(t, st, discardLogger())

		rec := sendAs(t, e, cookie, http.MethodPost, "/api/v1/tasks",
			`{"title":"write tests","priority":5,"due":"2026-11-05T00:00:00Z","tags":["go","book"]}`)

		require.Equal(t, http.StatusCreated, rec.Code)
		assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))

		id := createdID(t, rec)
		assert.Equal(t, "/api/v1/tasks/"+id, rec.Header().Get("Location"))
		assert.JSONEq(t, taskJSON(id, "write tests", "Todo", 5, `"2026-11-05T00:00:00Z"`, `["go","book"]`, 1), rec.Body.String())

		stored := storedTask(t, st, id)
		assert.Equal(t, "write tests", stored.Title)
		assert.Equal(t, task.PriorityMax, stored.Priority)
		assert.Equal(t, dueDay, stored.Due)
		assert.Equal(t, []string{"go", "book"}, stored.Tags)
		assert.Equal(t, 1, stored.Version)
	})

	t.Run("defaults", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		e, cookie := newTaskAPI(t, st, discardLogger())

		// The title is the domain constructor's: it trims, and it assigns
		// the default status and priority.
		rec := sendAs(t, e, cookie, http.MethodPost, "/api/v1/tasks", `{"title":"  buy milk  "}`)

		require.Equal(t, http.StatusCreated, rec.Code)
		id := createdID(t, rec)
		assert.JSONEq(t, taskJSON(id, "buy milk", "Todo", 3, "null", "[]", 1), rec.Body.String())
	})
}

// TestCreateTask_Validation pins the 422 body contract: one shape, one entry
// per failed field, and a rejected create that changes nothing. The messages
// come from two sources — the validator's tags for the wire-shape rules and
// the domain's own errors for the rules the domain owns — and the client
// cannot tell them apart, which is the point.
func TestCreateTask_Validation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		body  string
		field string
		want  string
	}{
		{name: "missing title", body: `{}`, field: "title", want: "cannot be empty"},
		{name: "no body at all", body: "", field: "title", want: "cannot be empty"},
		{name: "blank title", body: `{"title":"   "}`, field: "title", want: "cannot be empty"},
		{name: "title too long", body: `{"title":"` + strings.Repeat("x", 201) + `"}`, field: "title", want: "must be at most 200 characters"},
		{name: "priority too low", body: `{"title":"write tests","priority":0}`, field: "priority", want: "must be at least 1"},
		{name: "priority too high", body: `{"title":"write tests","priority":6}`, field: "priority", want: "must be at most 5"},
		{name: "empty tag", body: `{"title":"write tests","tags":["go",""]}`, field: "tags", want: "must not contain empty tags"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			st := store.NewMemoryStore()
			e, cookie := newTaskAPI(t, st, discardLogger())

			rec := sendAs(t, e, cookie, http.MethodPost, "/api/v1/tasks", tt.body)

			require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
			assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
			assert.JSONEq(t,
				errorJSON("validation_failed", "validation failed", fieldJSON(tt.field, tt.want)),
				rec.Body.String())

			tasks, err := st.Scoped(testUserID).List(context.Background())
			require.NoError(t, err)
			assert.Empty(t, tasks, "a rejected create changes nothing")
		})
	}
}

// TestCreateTask_UnusableBody pins the 400s: a body the decoder rejects is a
// bad request, and the API answers with its own words instead of the
// decoder's, which name Go types. A content type the binder cannot read is
// echo's own 415, rendered in the same shape as everything else.
func TestCreateTask_UnusableBody(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		contentType string
		body        string
		wantStatus  int
		wantBody    string
	}{
		{
			name:        "truncated JSON",
			contentType: "application/json",
			body:        `{"title":`,
			wantStatus:  http.StatusBadRequest,
			wantBody:    errorJSON("bad_request", "invalid JSON body"),
		},
		{
			name:        "wrong type for a field",
			contentType: "application/json",
			body:        `{"title":42}`,
			wantStatus:  http.StatusBadRequest,
			wantBody:    errorJSON("bad_request", "invalid JSON body"),
		},
		{
			name:        "unreadable content type",
			contentType: "text/plain",
			body:        `{"title":"write tests"}`,
			wantStatus:  http.StatusUnsupportedMediaType,
			wantBody:    errorJSON("unsupported_media_type", "Unsupported Media Type"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			st := store.NewMemoryStore()
			e, cookie := newTaskAPI(t, st, discardLogger())

			req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", tt.contentType)
			req.AddCookie(cookie)
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)

			require.Equal(t, tt.wantStatus, rec.Code)
			assert.JSONEq(t, tt.wantBody, rec.Body.String())

			tasks, err := st.Scoped(testUserID).List(context.Background())
			require.NoError(t, err)
			assert.Empty(t, tasks, "a rejected create changes nothing")
		})
	}
}

// TestListTasks pins the collection shape and the two filters: the store's
// own queries, selected by the query string, and an empty list that is an
// empty array, never null.
func TestListTasks(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		target string
		want   []string
	}{
		{name: "no filter", target: "/api/v1/tasks", want: []string{"write tests", "review code", "ship it"}},
		{name: "by status", target: "/api/v1/tasks?status=Todo", want: []string{"write tests", "ship it"}},
		{name: "by done status", target: "/api/v1/tasks?status=Done", want: []string{"review code"}},
		{name: "by tag", target: "/api/v1/tasks?tag=go", want: []string{"write tests", "review code"}},
		{name: "nothing matches", target: "/api/v1/tasks?tag=urgent", want: []string{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			st := store.NewMemoryStore()
			seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: dueDay, Tags: []string{"go", "book"}})
			seedTask(t, st, task.Task{Title: "review code", Status: task.StatusDone, Priority: task.PriorityMax, Tags: []string{"go"}})
			seedTask(t, st, task.Task{Title: "ship it", Status: task.StatusTodo, Priority: task.PriorityMin})
			e, cookie := newTaskAPI(t, st, discardLogger())

			rec := sendAs(t, e, cookie, http.MethodGet, tt.target, "")

			require.Equal(t, http.StatusOK, rec.Code)

			var got struct {
				Tasks []struct {
					Title string `json:"title"`
				} `json:"tasks"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
			titles := make([]string, 0, len(got.Tasks))
			for _, listed := range got.Tasks {
				titles = append(titles, listed.Title)
			}
			assert.Equal(t, tt.want, titles)
		})
	}

	t.Run("the shape is the contract", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		first := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: dueDay, Tags: []string{"go", "book"}})
		second := seedTask(t, st, task.Task{Title: "ship it", Status: task.StatusTodo, Priority: task.PriorityMin})
		e, cookie := newTaskAPI(t, st, discardLogger())

		rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks", "")

		require.Equal(t, http.StatusOK, rec.Code)
		assert.JSONEq(t, tasksJSON(
			taskJSON(first.ID.String(), "write tests", "Todo", 3, `"2026-11-05T00:00:00Z"`, `["go","book"]`, 1),
			taskJSON(second.ID.String(), "ship it", "Todo", 1, "null", "[]", 1),
		), rec.Body.String())
	})
}

// TestListTasks_FilterErrors pins the two filter failures: a status the
// domain does not know is the domain's own error in the 422 shape, and the
// combination the store has no query for is a 400 that says so instead of
// silently dropping a filter.
func TestListTasks_FilterErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		target     string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "unknown status",
			target:     "/api/v1/tasks?status=Blocked",
			wantStatus: http.StatusUnprocessableEntity,
			wantBody:   errorJSON("validation_failed", "validation failed", fieldJSON("status", `unknown status "Blocked"`)),
		},
		{
			name:       "status and tag together",
			target:     "/api/v1/tasks?status=Todo&tag=go",
			wantStatus: http.StatusBadRequest,
			wantBody:   errorJSON("bad_request", "status and tag cannot be combined"),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			e, cookie := newTaskAPI(t, store.NewMemoryStore(), discardLogger())

			rec := sendAs(t, e, cookie, http.MethodGet, tt.target, "")

			require.Equal(t, tt.wantStatus, rec.Code)
			assert.JSONEq(t, tt.wantBody, rec.Body.String())
		})
	}
}

// TestGetTask pins the single-task read, its miss, and its malformed id.
func TestGetTask(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: dueDay, Tags: []string{"go"}})
	e, cookie := newTaskAPI(t, st, discardLogger())

	t.Run("found", func(t *testing.T) {
		t.Parallel()

		rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks/"+seeded.ID.String(), "")

		require.Equal(t, http.StatusOK, rec.Code)
		assert.JSONEq(t, taskJSON(seeded.ID.String(), "write tests", "Todo", 3, `"2026-11-05T00:00:00Z"`, `["go"]`, 1), rec.Body.String())
	})

	t.Run("missing", func(t *testing.T) {
		t.Parallel()

		rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks/00000000-0000-0000-0000-000000000042", "")

		require.Equal(t, http.StatusNotFound, rec.Code)
		assert.JSONEq(t, errorJSON("not_found", "task not found"), rec.Body.String())
	})

	t.Run("malformed id", func(t *testing.T) {
		t.Parallel()

		rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks/not-a-uuid", "")

		require.Equal(t, http.StatusBadRequest, rec.Code)
		assert.JSONEq(t, errorJSON("bad_request", "invalid task id"), rec.Body.String())
	})
}

// TestUpdateTask pins the PATCH contract: the body carries the version the
// caller read plus the fields to change, absent fields are left alone, and
// the response is the stored task at the bumped version.
func TestUpdateTask(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: dueDay, Tags: []string{"go", "old"}})
	e, cookie := newTaskAPI(t, st, discardLogger())

	rec := sendAs(t, e, cookie, http.MethodPatch, "/api/v1/tasks/"+seeded.ID.String(),
		`{"version":1,"title":"  write more tests  ","priority":5,"tags":["go","review"]}`)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t,
		taskJSON(seeded.ID.String(), "write more tests", "Todo", 5, `"2026-11-05T00:00:00Z"`, `["go","review"]`, 2),
		rec.Body.String())

	stored := storedTask(t, st, seeded.ID.String())
	assert.Equal(t, "write more tests", stored.Title, "the title is trimmed like the domain constructor's")
	assert.Equal(t, task.StatusTodo, stored.Status, "an absent status is left alone")
	assert.Equal(t, dueDay, stored.Due, "an absent due is left alone")
	assert.Equal(t, []string{"go", "review"}, stored.Tags, "the tag set is replaced, not merged")
	assert.Equal(t, 2, stored.Version)
}

// TestUpdateTask_ClearsDue pins the one field a PATCH can clear: a JSON null
// means "remove the due date", which a plain pointer cannot express because
// absent and null both decode to nil.
func TestUpdateTask_ClearsDue(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Due: dueDay})
	e, cookie := newTaskAPI(t, st, discardLogger())

	rec := sendAs(t, e, cookie, http.MethodPatch, "/api/v1/tasks/"+seeded.ID.String(), `{"version":1,"due":null}`)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t,
		taskJSON(seeded.ID.String(), "write tests", "Todo", 3, "null", "[]", 2),
		rec.Body.String())

	stored := storedTask(t, st, seeded.ID.String())
	assert.True(t, stored.Due.IsZero(), "the due date is cleared")
}

// TestUpdateTask_ClearsTags pins the tag set's empty case: an empty array is
// the client saying "no tags", and the store's Update replaces the set rather
// than merging into it, so the old tags disappear.
func TestUpdateTask_ClearsTags(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityDefault, Tags: []string{"go", "book"}})
	e, cookie := newTaskAPI(t, st, discardLogger())

	rec := sendAs(t, e, cookie, http.MethodPatch, "/api/v1/tasks/"+seeded.ID.String(), `{"version":1,"tags":[]}`)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t,
		taskJSON(seeded.ID.String(), "write tests", "Todo", 3, "null", "[]", 2),
		rec.Body.String())

	stored := storedTask(t, st, seeded.ID.String())
	assert.Empty(t, stored.Tags)
}

// TestUpdateTask_Validation pins the 422s of a PATCH body, including the
// version the compare-and-swap needs and the status vocabulary the domain
// owns.
func TestUpdateTask_Validation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		body   string
		fields []string
	}{
		{
			name:   "missing version",
			body:   `{"title":"write more tests"}`,
			fields: []string{fieldJSON("version", "is required")},
		},
		{
			name:   "version zero",
			body:   `{"version":0,"title":"write more tests"}`,
			fields: []string{fieldJSON("version", "must be at least 1")},
		},
		{
			name:   "unknown status",
			body:   `{"version":1,"status":"Blocked"}`,
			fields: []string{fieldJSON("status", `unknown status "Blocked"`)},
		},
		{
			name:   "blank title",
			body:   `{"version":1,"title":"   "}`,
			fields: []string{fieldJSON("title", "cannot be empty")},
		},
		{
			name:   "priority too high",
			body:   `{"version":1,"priority":9}`,
			fields: []string{fieldJSON("priority", "must be at most 5")},
		},
		{
			name:   "empty tag",
			body:   `{"version":1,"tags":["go",""]}`,
			fields: []string{fieldJSON("tags", "must not contain empty tags")},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			st := store.NewMemoryStore()
			seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo})
			e, cookie := newTaskAPI(t, st, discardLogger())

			rec := sendAs(t, e, cookie, http.MethodPatch, "/api/v1/tasks/"+seeded.ID.String(), tt.body)

			require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
			assert.JSONEq(t, errorJSON("validation_failed", "validation failed", tt.fields...), rec.Body.String())

			stored := storedTask(t, st, seeded.ID.String())
			assert.Equal(t, "write tests", stored.Title, "a rejected update changes nothing")
			assert.Equal(t, 1, stored.Version)
		})
	}
}

// TestUpdateTask_Conflict pins the stale-version answer: 409, the store's own
// sentinel rendered in the one error shape, and the winner's state untouched.
func TestUpdateTask_Conflict(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo})
	e, cookie := newTaskAPI(t, st, discardLogger())
	target := "/api/v1/tasks/" + seeded.ID.String()

	first := sendAs(t, e, cookie, http.MethodPatch, target, `{"version":1,"title":"first write"}`)
	require.Equal(t, http.StatusOK, first.Code)

	// The same snapshot again: the version moved on, so the write loses.
	second := sendAs(t, e, cookie, http.MethodPatch, target, `{"version":1,"title":"second write"}`)

	require.Equal(t, http.StatusConflict, second.Code)
	assert.JSONEq(t, errorJSON("conflict", "task was modified"), second.Body.String())

	stored := storedTask(t, st, seeded.ID.String())
	assert.Equal(t, "first write", stored.Title)
	assert.Equal(t, 2, stored.Version)
}

// TestUpdateTask_NotFound pins the miss: 404, not a conflict.
func TestUpdateTask_NotFound(t *testing.T) {
	t.Parallel()

	e, cookie := newTaskAPI(t, store.NewMemoryStore(), discardLogger())

	rec := sendAs(t, e, cookie, http.MethodPatch, "/api/v1/tasks/00000000-0000-0000-0000-000000000042",
		`{"version":1,"title":"write tests"}`)

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.JSONEq(t, errorJSON("not_found", "task not found"), rec.Body.String())
}

// TestDeleteTask pins the delete contract: the version rides the query
// string, success is 204 with no body, and the task is gone from the store.
func TestDeleteTask(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo, Tags: []string{"go"}})
	e, cookie := newTaskAPI(t, st, discardLogger())
	target := "/api/v1/tasks/" + seeded.ID.String()

	rec := sendAs(t, e, cookie, http.MethodDelete, target+"?version=1", "")

	require.Equal(t, http.StatusNoContent, rec.Code)
	assert.Empty(t, rec.Body.String())

	tasks, err := st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, tasks)

	// The same snapshot again finds no task: a miss, not a conflict.
	again := sendAs(t, e, cookie, http.MethodDelete, target+"?version=1", "")
	require.Equal(t, http.StatusNotFound, again.Code)
	assert.JSONEq(t, errorJSON("not_found", "task not found"), again.Body.String())
}

// TestDeleteTask_Conflict pins the stale-version delete: the task stays.
func TestDeleteTask_Conflict(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	seeded := seedTask(t, st, task.Task{Title: "write tests", Status: task.StatusTodo})
	e, cookie := newTaskAPI(t, st, discardLogger())
	target := "/api/v1/tasks/" + seeded.ID.String()

	updated := sendAs(t, e, cookie, http.MethodPatch, target, `{"version":1,"status":"Done"}`)
	require.Equal(t, http.StatusOK, updated.Code)

	rec := sendAs(t, e, cookie, http.MethodDelete, target+"?version=1", "")

	require.Equal(t, http.StatusConflict, rec.Code)
	assert.JSONEq(t, errorJSON("conflict", "task was modified"), rec.Body.String())

	stored := storedTask(t, st, seeded.ID.String())
	assert.Equal(t, task.StatusDone, stored.Status)
	assert.Equal(t, 2, stored.Version)
}

// TestDeleteTask_BadVersion pins the query parameter's failures: the version
// is not a body field, so a missing or unusable one is a 400 that names the
// parameter, and a malformed id is a 400 like every other route's.
func TestDeleteTask_BadVersion(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		target string
		body   string
	}{
		{name: "missing version", target: "/api/v1/tasks/00000000-0000-0000-0000-000000000042", body: errorJSON("bad_request", "version must be a positive integer")},
		{name: "version zero", target: "/api/v1/tasks/00000000-0000-0000-0000-000000000042?version=0", body: errorJSON("bad_request", "version must be a positive integer")},
		{name: "version not a number", target: "/api/v1/tasks/00000000-0000-0000-0000-000000000042?version=one", body: errorJSON("bad_request", "version must be a positive integer")},
		{name: "malformed id", target: "/api/v1/tasks/not-a-uuid?version=1", body: errorJSON("bad_request", "invalid task id")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			e, cookie := newTaskAPI(t, store.NewMemoryStore(), discardLogger())

			rec := sendAs(t, e, cookie, http.MethodDelete, tt.target, "")

			require.Equal(t, http.StatusBadRequest, rec.Code)
			assert.JSONEq(t, tt.body, rec.Body.String())
		})
	}
}

// TestListTasks_StoreFailure pins the 500: an unexpected failure is the one
// error whose text does not reach the client — it describes the inside of
// the process — while the shape stays the one shape and the store call is
// still exactly one.
func TestListTasks_StoreFailure(t *testing.T) {
	t.Parallel()

	st := &StoreMock{}
	// The handler scopes the store to the authenticated user before it
	// lists; the view it asks for is this same mock, so the failure below
	// is what the handler sees.
	st.ScopedFunc = func(uuid.UUID) store.Store { return st }
	st.ListFunc = func(context.Context) ([]task.Task, error) {
		return nil, errors.New("database is away")
	}
	e, cookie := newTaskAPI(t, st, discardLogger())

	rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/tasks", "")

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.JSONEq(t, errorJSON("internal_error", "internal error"), rec.Body.String())
	assert.NotContains(t, rec.Body.String(), "database is away")
	assert.Len(t, st.ListCalls(), 1)
}

// TestUnknownRoute_ErrorShape pins that the error handler owns the whole
// surface: a route the API does not serve answers in the same shape as
// everything else, echo's own 404 included.
func TestUnknownRoute_ErrorShape(t *testing.T) {
	t.Parallel()

	e, cookie := newTaskAPI(t, store.NewMemoryStore(), discardLogger())

	rec := sendAs(t, e, cookie, http.MethodGet, "/api/v1/nope", "")

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.JSONEq(t, errorJSON("not_found", "Not Found"), rec.Body.String())
}
````


## `internal/api/testdata/bench/baseline.txt`

````text
goos: linux
goarch: amd64
pkg: todo/internal/api
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
# control-ref: 8787d107f68542231244cd9afe5019dcdc28a55b
BenchmarkListTasks/n=100000-16         	      16	  64480921 ns/op	34810262 B/op	  200298 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/api
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkListTasks/n=100000-16         	      19	  65385978 ns/op	35693374 B/op	  200299 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/api
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkListTasks/n=100000-16         	      19	  61939179 ns/op	30392655 B/op	  200292 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/api
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkListTasks/n=100000-16         	      18	  60096305 ns/op	34810001 B/op	  200298 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/api
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkListTasks/n=100000-16         	      18	  61048827 ns/op	27351128 B/op	  200290 allocs/op
PASS
````


## `internal/api/validator.go`

````go
package api

import (
	"fmt"
	"reflect"
	"strings"

	validator "github.com/go-playground/validator/v10"
)

// The validator hook. echo calls the registered echo.Validator from
// c.Validate, after a handler has bound the request into its DTO, and the
// DTOs carry their wire-shape rules as struct tags: a request that violates
// one never reaches a store call. The hook is one go-playground/validator
// instance built per server, with the application's own rules registered on
// it, so the rules travel with the shapes they constrain.

// requestValidator is the API's echo.Validator.
type requestValidator struct {
	validate *validator.Validate
}

// newRequestValidator builds the validator: a fresh go-playground instance
// with the two customizations the API needs.
func newRequestValidator() *requestValidator {
	v := validator.New()

	// A failure is reported under the name the client used, not the Go
	// field's: the DTOs' json tags are the wire spelling, and the
	// validator's default is the struct field's own name. The mapping is
	// what lets validationMessage's prose and the field entry agree with
	// the request that failed.
	v.RegisterTagNameFunc(func(field reflect.StructField) string {
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			return field.Name
		}
		return name
	})

	// RegisterValidation's only failure is an invalid tag name, and the
	// name is a constant here: a typo is a programming error that fails
	// every test run at construction, not a runtime condition to report.
	if err := v.RegisterValidation("tags", validateTags); err != nil {
		panic(fmt.Sprintf("api: register validator: %v", err))
	}
	return &requestValidator{validate: v}
}

// Validate implements echo.Validator. c.Validate is the only caller: a
// handler binds the request into its DTO and hands the DTO here.
func (v *requestValidator) Validate(i any) error {
	return v.validate.Struct(i)
}

// validateTags accepts a []string whose elements are all non-empty. The rule
// fails once for the whole slice rather than once per element, which keeps
// the 422 body bounded by the DTO's shape instead of by the request's
// contents: a body with a thousand empty tags is still one field entry. It
// also gives the wire one sentence for "a tag must not be empty" instead of
// one per offending index.
func validateTags(fl validator.FieldLevel) bool {
	tags, ok := fl.Field().Interface().([]string)
	if !ok {
		return false
	}
	for _, tag := range tags {
		if tag == "" {
			return false
		}
	}
	return true
}
````
