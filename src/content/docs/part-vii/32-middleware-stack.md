---
title: Middleware
description: Wrap every request in one ordered stack — an id, a log record, a panic catcher, a time limit, a size limit, compression, and security headers.
sidebar:
  order: 32
---

Every request the server answers is a stranger. It arrives with no name, leaves no record, and can ask the process to do as much work as it likes, with a body as large as it likes. When something goes wrong later, the only evidence is whatever the handler happened to write.

The fix has a name: **middleware** — code that runs *around* a request instead of answering it. Picture a road with a line of inspection posts. Every traveler passes each post on the way in, and passes the same posts again on the way out. One post names the traveler, one writes them down, one catches a fall.

We'll build eight such posts for every request the server serves — the two health checks included. Seven are echo's, configured in one list. The eighth we write ourselves: the post that names the request and writes the one record about it.

By the end, a request you send by hand comes back with its own name in a header, the log holds a line about it, and a body over the size limit is turned away before any handler sees it.

## A line of posts around every request

Echo installs middleware with `e.Use(...)`, and every request the server handles walks through the list. The order is the point: echo runs the middleware in the order it is given, outermost first, so the list reads top-down as one request travels.

Here is our line of posts, in order, in plain words:

- **RequestID** names the request. A client may send an id in the `X-Request-ID` header; if it doesn't, one is generated. Either way the id is set on the response, so the client can quote it later.
- **request logging** — ours — writes one record per request, at the end: the method, the path, the status the client received, how long it took, and the id.
- **Recover** catches a **panic** — Go's word for a crash inside a function — and turns it into the app's one 500 shape instead of a dropped connection.
- **Timeout** arms a ten-second deadline on the request's **context**: the value Go carries alongside a call to say which request it belongs to.
- **BodyLimit** turns away any request body over 64 KiB — about 65,000 characters — before a handler runs.
- **Gzip** compresses responses over a kilobyte, so fewer bytes travel the network.
- **CORS** decides whether a page from another site may read a response. Ours says no.
- **Secure** adds the baseline security headers to every response a handler writes.

Each position answers a question: the name must exist before anything can mention it; the record must see the whole request; Recover must stand outside the code that can crash; the size limit must stand before anything reads the body. A box at the end walks through the edges.

## The tests come first

The tests for all this live in a new file, `internal/api/middleware_test.go`, beside the other API tests. Every case drives the stack through `ServeHTTP` — the same entry point a real listener calls — and reads the records back from a buffer, because the record's shape is half of what the tests are about.

First the helpers. `logRecord` is one record as the JSON sink writes it; a field the middleware didn't write decodes to its zero value, so every assertion is also a promise that the field was written. `captureLogger` builds a logger over a buffer — the machine shape the log file keeps.

<!-- verify: internal/api/middleware_test.go at=api-middleware -->
```go title="internal/api/middleware_test.go"
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
	Err       string `json:"err"`
	Stack     string `json:"stack"`
}

// captureLogger returns a logger that writes JSON records into a buffer —
// the machine shape the file sink keeps — and the buffer they land in.
func captureLogger() (*slog.Logger, *bytes.Buffer) {
	buf := new(bytes.Buffer)
	return slog.New(slog.NewJSONHandler(buf, nil)), buf
}
```

`logRecords` decodes every line the logger wrote, and `findRecord` picks out the one record with a given message, failing if there is none or more than one.

<!-- verify: internal/api/middleware_test.go at=api-middleware -->
```go title="internal/api/middleware_test.go"
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
```

Then the correlation case: the id a client sends travels into the response and into the request's record.

<!-- verify: internal/api/middleware_test.go at=api-middleware -->
```go title="internal/api/middleware_test.go"
// TestRequestID_Propagated pins the correlation contract: the id a client
// sends travels into the response and into the request's records, and a
// request without one gets an id generated and echoed the same way.
func TestRequestID_Propagated(t *testing.T) {
	t.Parallel()

	t.Run("the client's id travels", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := api.New(store.NewMemoryStore(), logger)

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
```

Five more cases follow the same shape: a generated 32-character id, echoed and recorded the same way; the record's fields; the level rule — a 404 is a warning, a 500 is an error; a forced panic, where the client gets the fixed 500 and the log gets the stack; and the deadline in two halves — armed, then expired into a 504. The last is the wall:

<!-- verify: internal/api/middleware_test.go at=api-middleware -->
```go title="internal/api/middleware_test.go"
// TestBodyLimit_413 pins the wall: a body past the limit is refused with the
// one error shape before any handler sees it, and the refused request is
// still a logged request.
func TestBodyLimit_413(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	e := api.New(store.NewMemoryStore(), logger)

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
```

The finished app's appendix holds the whole test file; the pieces above are the ones that carry the idea. Run the tests — `go test -count=1 -v ./internal/api` — and watch what the app does not do yet.

## Watch it fail

```bash
--- FAIL: TestRequestID_Propagated (0.00s)
    --- FAIL: TestRequestID_Propagated/the_client's_id_travels (0.00s)
        middleware_test.go:102: 
            	Error:      	Not equal: 
            	            	expected: "trace-42"
            	            	actual  : ""
...
--- FAIL: TestRequestLog_Levels (0.00s)
    --- FAIL: TestRequestLog_Levels/a_500_is_an_error,_on_both_records (0.00s)
        middleware_test.go:186: 
            	Error:      	"[{ERROR request failed GET /api/v1/tasks 0 0  database is away }]" should have 2 item(s), but has 1
...
--- FAIL: TestBodyLimit_413 (0.00s)
    middleware_test.go:299: 
        	Error:      	Not equal: 
        	            	expected: 413
        	            	actual  : 422
...
--- FAIL: TestTimeout_504 (0.00s)
    --- FAIL: TestTimeout_504/an_expired_deadline_is_a_504 (0.02s)
        middleware_test.go:279: 
            	Error:      	Not equal: 
            	            	expected: 504
            	            	actual  : 500
FAIL
FAIL	todo/internal/api	0.026s
FAIL
```

Read the failures in order; each one names a missing post. The response header and the record list are empty — `[]` should have 1 item — because nothing sets an id and nothing writes a record. The 500 case is worth reading twice: the error handler *does* log `request failed`, and that record shows what's missing — no `request_id`, and a `status` of 0. The body-limit case answers 422, not 413: without the wall, the 64 KiB title reaches the domain's 200-character rule — the trip the wall exists to prevent. And the deadline case answers 500 where 504 is owed: nothing arms a deadline, and nothing classifies one.

One case doesn't report at all. The panic case takes the whole test run down with it; that crash, and its fix, are in "If something went wrong" below.

## The stack, one list

Create `internal/api/middleware.go`. It opens with the package, the imports, and the first lines of a long comment that states the stack's order:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// The middleware stack is one ordered list around every route the server
// serves, and the order is the chapter's first decision:
//
//	RequestID -> request logging -> Recover -> Timeout -> BodyLimit -> Gzip -> CORS -> Secure
//
// ...
```

The comment continues with a reason for every position, and two choices worth naming: the deadline layer is echo's `ContextTimeout`, not its older `Timeout`, and the crash catcher stays echo's for its seams. Then the three policy values, in one place:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
// The stack's policy values, in one place. They are policy, not measurement:
// every route this API serves is a local database read or write, and the
// numbers are chosen from that shape.
const (
	// requestTimeout bounds a request's lifetime. Ten seconds is far longer
	// than a local query should ever take and far shorter than a client's
	// ...
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
)
```

Ten seconds per request, because every route here is a local database read or write. 64 KiB for bodies, over thirty times the largest legitimate one — a task with a title, a due date, and a handful of labels. And gzip starts at a kilobyte: below that, the frame around the compressed data can weigh more than the saving.

`useStack` is the whole stack in one function — one `e.Use` call, one list, and each layer's reason in a comment above it. Here is the first half:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
// useStack installs the ordered stack on e. It is one call so the order is
// one list, and each layer carries its own reason.
func useStack(e *echo.Echo, logger *slog.Logger) {
	e.Use(
		// The id's owner: it reads X-Request-ID from the client or
		// generates one, and sets it on the response — where the client
		// reads it back and where requestLogger, below, finds it. A
		// client-supplied id is trusted on purpose: correlating a caller's
		// report with the server's records is the whole point, and the id
		// reaches nothing but a log field and the response header. It is
		// ...
		middleware.RequestID(),

		requestLogger(logger),
```

RequestID is the id's owner: it reads the client's header or generates an id, and sets it on the response — where the client reads it back and where our logging layer, just below, finds it. `requestLogger(logger)` is our layer, and it comes second so it can see everything under it. Then the crash catcher:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
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
```

`RecoverWithConfig` receives the panic, the error it becomes, and the captured stack. Its `LogErrorFunc` writes one record — `panic recovered`, with the panic and the stack — through the request's logger, then returns the error. Returning it hands the panic to the one error handler, which answers with the fixed 500 and keeps the text in the process. The stack is the panicking goroutine's only; other goroutines' traces would be noise. And echo's handling of `http.ErrAbortHandler` — the panic net/http uses to abort a connection — is kept, because that one isn't a bug.

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
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
```

`ContextTimeout` arms the deadline on the request's context and nothing else — a box at the end explains what that does and doesn't mean. When the deadline passes and the code inside respects the context, the failure arrives wrapping `context.DeadlineExceeded`, and this layer's error handler turns it into a 504: the wait for an answer ran out. Any other error falls through to the one error handler unchanged.

Then the four layers that bound and shape what the request can do:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
		// The wall is two checks, and both are wanted: the Content-Length
		// header catches an honest client before a byte of the body is
		// read, and the counting reader catches one that lies. The 413 it
		// returns is echo's own HTTPError, which the one error handler
		// renders in the one shape; the code derives from the status text
		// like every other status the classifier does not name.
		middleware.BodyLimit(bodyLimit),

		// The level stays echo's default (gzip.DefaultCompression, the
		// balance between CPU and size); the threshold is the knob that
		// matters here.
		middleware.GzipWithConfig(middleware.GzipConfig{
			MinLength: gzipMinLength,
		}),
```

The wall checks twice: the `Content-Length` header catches an honest client before a byte of the body is read, and a counting reader catches one that lies about the length. Gzip's level stays echo's default — the balance between CPU and size — and the threshold is the knob that matters. The last two layers close the origin policy and set the headers. CORS first:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
		// The MPA is served from the same origin and the TUI is not a
		// browser, so no cross-origin browser client exists and the policy
		// is closed — written down rather than implied, because echo's
		// default is "*" for every origin. A future consumer arrives as an
		// allowlist in this one function. Worth naming while it is here:
		// CORS is a browser read-permission mechanism, not access control —
		// it stops a page from reading a response, not from causing one,
		// ...
		middleware.CORSWithConfig(middleware.CORSConfig{
			AllowOriginFunc: func(string) (bool, error) { return false, nil },
		}),
```

then Secure, whose config spells out every header it sets, because the layer applies no defaults of its own:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
		// The baseline headers. SecureWithConfig applies no header defaults
		// of its own — unlike CORS and Gzip, it defaults only the skipper —
		// so every header the API sends is named here, and the three
		// defaults from echo's DefaultSecureConfig are spelled out to keep
		// them. HSTS is set only on an https request, which is why the
		// transcript on plain http shows no Strict-Transport-Security; it
		// is excluded from subdomains because the app does not know what
		// ...
		middleware.SecureWithConfig(middleware.SecureConfig{
			XSSProtection:         "1; mode=block",
			ContentTypeNosniff:    "nosniff",
			XFrameOptions:         "SAMEORIGIN",
			HSTSMaxAge:            31536000,
			HSTSExcludeSubdomains: true,
			ReferrerPolicy:        "no-referrer",
		}),
	)
}
```

CORS is closed by policy: no browser page from another site may read these responses. That is written down rather than left to echo's default, which allows every origin. Worth knowing: CORS is a browser *read* permission, not access control — it stops a page from reading a response, not from causing one. And `SecureWithConfig` applies no header defaults of its own, so every header the API sends is named right here — nosniff, SAMEORIGIN, no-referrer, and the legacy XSS protection. HSTS is set only when the request already arrived over https, which is why the plain-http transcript later shows none.

Echo's middleware package pulls in one small helper library of its own, so record it in the project's list of dependencies:

```bash
$ go mod tidy
```

Silence is success. The tidy records one new indirect dependency — a small time-keeping library echo's middleware package uses:

<!-- verify: go.mod at=api-middleware -->
```text title="go.mod"
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	golang.org/x/time v0.15.0 // indirect
	golang.org/x/tools v0.51.0 // indirect
)
```

Indirect means it is a library echo uses that we never call directly.

## One record per request

The plumbing comes first. The request's logger travels inside the request's context, and three small functions make that safe: a key that can't collide, the one setter, and a getter that never comes back empty.

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
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
```

`loggerKey{}` is a struct type rather than a string, so no other package can set the same key by accident. `withLogger` is the only setter, and our middleware is its only caller. `LoggerFrom` returns the request's logger when there is one and `slog.Default()` when there isn't, so a call site never has to decide whether logging is available.

Then the middleware itself. It has echo's shape — it takes the next handler and returns one — and two halves: work before the chain runs, and work after it finishes.

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
// requestLogger is the stack's custom middleware: it gives every request a
// logger carrying the request's id, puts that logger in the request's
// context so handlers and the error handler log through it (LoggerFrom), and
// writes the request's one record when the response is done.
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

			// The response header is the id's home: RequestID set it above
			// this middleware, and it is what the client reads back, so the
			// record and the client cannot disagree about it.
			id := c.Response().Header().Get(echo.HeaderXRequestID)
			reqLogger := logger.With("request_id", id)
			c.SetRequest(req.WithContext(withLogger(req.Context(), reqLogger)))
```

Walk through a request. Before the chain: the id is read from the *response* header, not the request's — RequestID set it there just above, and it's what the client will read back, so the record and the client cannot disagree about it. `logger.With("request_id", id)` derives a request-scoped logger — one clone per request — and `c.SetRequest` puts it in the request's context, where handlers and the error handler reach it through `LoggerFrom`.

After the chain: one record, written with `LogAttrs` — the same key/value shape from the logging work, with each attribute's type named, so nothing is boxed into a generic list. The level comes from one small rule:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
			err := next(c)
			if err != nil {
				c.Error(err)
			}

			reqLogger.LogAttrs(c.Request().Context(), requestLevel(c.Response().Status), "request",
				slog.String("method", req.Method),
				slog.String("path", req.URL.Path),
				slog.Int("status", c.Response().Status),
				slog.Duration("duration", time.Since(start)),
			)
			return err
		}
	}
}
```

500 and above is the server's failure: an error. 400 and above is the client's: a warning. Everything else is the ordinary record. One function decides, so every record that wants the same discipline can ask it:

<!-- verify: internal/api/middleware.go at=api-middleware -->
```go title="internal/api/middleware.go"
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
```

One line in the middle makes the record honest: `c.Error(err)`. Echo runs its error handler only after the whole chain has returned — so a middleware that just logged the status after `next(c)` would write the 200 the response held *before* the error handler wrote the 404 or the 500. Calling `c.Error` inside the chain renders the error where the record can see it; echo's own later call does nothing, because the response is already committed. The error is returned unchanged: this layer observes and answers, it doesn't swallow.

Two more test cases belong with this helper, and they join the file now: a handler's own record carrying the request's id, and the fallback's never-nil rule.

<!-- verify: internal/api/middleware_test.go at=api-middleware -->
```go title="internal/api/middleware_test.go"
	t.Run("the handler's logger carries the id", func(t *testing.T) {
		t.Parallel()

		logger, buf := captureLogger()
		e := api.New(store.NewMemoryStore(), logger)
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
```

Two records, one id — and the fallback has its own case:

<!-- verify: internal/api/middleware_test.go at=api-middleware -->
```go title="internal/api/middleware_test.go"
// TestLoggerFrom_Fallback pins the helper's never-nil rule: a context no
// request has touched still answers with a logger, so a call site outside a
// request — a boot path, a background job — never has to decide whether
// logging is available.
func TestLoggerFrom_Fallback(t *testing.T) {
	t.Parallel()

	assert.Same(t, slog.Default(), api.LoggerFrom(context.Background()))
}
```

Outside a request, the helper answers with Go's default logger instead of nothing — the rule that lets any call site log without asking first.

## Wire it into the server

`New` gets one new line:

<!-- verify: internal/api/api.go at=api-middleware -->
```go title="internal/api/api.go"
func New(st store.Store, logger *slog.Logger) *echo.Echo {
	s := &server{store: st}

	e := echo.New()
	e.Validator = newRequestValidator()
	e.HTTPErrorHandler = s.handleError
	useStack(e, logger)
```

and the `server` struct loses a field:

<!-- verify: internal/api/api.go at=api-middleware -->
```go title="internal/api/api.go"
// server carries the API's dependencies to its handlers. The logger is not
// ...
type server struct {
	store store.Store
}
```

`useStack(e, logger)` installs the stack on the echo instance, once, so the health checks and the task routes get the same treatment. The `server` struct no longer carries the logger: it travels in the request's context now, so a handler that logs uses the logger that already has the request's id. That is what `ready` does — the client still gets the fixed `{"status":"unavailable"}` body, and the log gets the reason:

<!-- verify: internal/api/api.go at=api-middleware -->
```go title="internal/api/api.go"
func (s *server) ready(c echo.Context) error {
	ctx := c.Request().Context()
	if _, err := s.store.Stats(ctx); err != nil {
		LoggerFrom(ctx).Error("readiness failed", "err", err)
		return c.JSON(http.StatusServiceUnavailable, statusBody("unavailable"))
	}
	return c.JSON(http.StatusOK, statusBody("ok"))
}
```

The error handler goes through `LoggerFrom` too, so its `request failed` record joins the request's own record instead of standing alone:

<!-- verify: internal/api/error.go at=api-middleware -->
```go title="internal/api/error.go"
func (s *server) handleError(err error, c echo.Context) {
	// A handler that already wrote a response owns it; rewriting it here
	// would corrupt the body.
	if c.Response().Committed {
		return
	}

	logger := LoggerFrom(c.Request().Context())
	status, body := errorResponseFor(err)
```

And the classifier gains one case. The codes table grows a constant:

<!-- verify: internal/api/error.go at=api-middleware -->
```go title="internal/api/error.go"
const (
	codeBadRequest           = "bad_request"
	codeNotFound             = "not_found"
	codeMethodNotAllowed     = "method_not_allowed"
	codeConflict             = "conflict"
	codeUnsupportedMediaType = "unsupported_media_type"
	codeValidationFailed     = "validation_failed"
	codeGatewayTimeout       = "gateway_timeout"
	codeInternal             = "internal_error"
)
```

and the switch grows a case for 504:

<!-- verify: internal/api/error.go at=api-middleware -->
```go title="internal/api/error.go"
	case http.StatusUnprocessableEntity:
		return codeValidationFailed
	case http.StatusGatewayTimeout:
		return codeGatewayTimeout
	}
```

The rule the case preserves: a status below 500 that the table doesn't name derives its code from the status text — that's how the wall's 413 becomes `request_entity_too_large` with no case of its own — while an unnamed status at or above 500 is a bug, and `internal_error` is what a bug is called. A timeout is above 500 and is not a bug, so it is named.

Last, the readiness test grows. It captures the logger instead of discarding it:

<!-- verify: internal/api/api_test.go at=api-middleware -->
```go title="internal/api/api_test.go"
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
	e := api.New(st, logger)
```

and pins that the probe and its cause share one id:

<!-- verify: internal/api/api_test.go at=api-middleware -->
```go title="internal/api/api_test.go"
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
```

That answers a question the readiness work left open: what a readiness failure records. The client still gets the fixed body, and the probe's cause now sits in the log, under the request's id.

## Run it green

Run the API's tests again — `go test -count=1 -v ./internal/api` — and the whole suite is green:

```bash
--- PASS: TestBodyLimit_413 (0.00s)
--- PASS: TestCreateTask (0.00s)
--- PASS: TestCreateTask_UnusableBody (0.00s)
--- PASS: TestCreateTask_Validation (0.00s)
--- PASS: TestDeleteTask (0.00s)
--- PASS: TestDeleteTask_BadVersion (0.00s)
--- PASS: TestDeleteTask_Conflict (0.00s)
--- PASS: TestGetTask (0.00s)
--- PASS: TestHealthz (0.00s)
--- PASS: TestListTasks (0.00s)
--- PASS: TestListTasks_FilterErrors (0.00s)
--- PASS: TestListTasks_StoreFailure (0.00s)
--- PASS: TestLoggerFrom_Fallback (0.00s)
--- PASS: TestPanic_Recovered (0.00s)
--- PASS: TestReady_OK (0.00s)
--- PASS: TestReady_StoreDown (0.00s)
--- PASS: TestRequestID_Propagated (0.00s)
--- PASS: TestRequestLog_Fields (0.00s)
--- PASS: TestRequestLog_Levels (0.00s)
--- PASS: TestServer_StartShutdown (0.00s)
--- PASS: TestTimeout_504 (0.00s)
...
PASS
ok  	todo/internal/api	0.029s
```

Every case passes — the middleware cases beside the CRUD cases. Then the whole module, one package at a time:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.916s
ok  	todo/cmd/todo-server	1.074s
ok  	todo/internal/api	0.030s
ok  	todo/internal/cli	0.039s
ok  	todo/internal/config	0.003s
ok  	todo/internal/db	0.051s
ok  	todo/internal/logging	0.004s
ok  	todo/internal/store	0.219s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
```

Every package passes, and the api line is the one that matters here: the same suite that failed a moment ago, now green.

## Talk to the server

Start the server as before — the `todo-server` binary, in a scratch folder with `TODO_DB` and `TODO_LOG` — and give the list a few tasks to carry. Then one request per claim. First, a request that names itself:

```bash
$ curl -s -i -H "X-Request-ID: live-42" http://127.0.0.1:18083/api/v1/tasks
HTTP/1.1 200 OK
Content-Type: application/json
Referrer-Policy: no-referrer
Vary: Accept-Encoding
Vary: Origin
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
X-Request-Id: live-42
X-Xss-Protection: 1; mode=block
Date: Thu, 15 Oct 2026 06:13:08 GMT
Content-Length: 1100

{"tasks":[{"id":"01a13e31-6aac-796d-a921-ecc75e3d7d15","title":"live task 1","status":"Todo","priority":3,"due":null,"tags":["live"],"version":1},…]}
```

The client's id, `live-42`, comes back in the `X-Request-Id` header, and the security headers ride on the response. A request without an id gets a generated 32-character one, echoed the same way — so any client can quote an id in a report and the log will hold the same string. Now the compression:

```bash
$ curl -s -D - -o body.gz -H "Accept-Encoding: gzip" http://127.0.0.1:18083/api/v1/tasks
HTTP/1.1 200 OK
Content-Encoding: gzip
Content-Type: application/json
...
Content-Length: 299

$ wc -c < body.gz
299
$ gzip -dc body.gz | head -c 96
{"tasks":[{"id":"01a13e31-6aac-796d-a921-ecc75e3d7d15","title":"live task 1","status":"Todo","pr
```

The same list is 1100 bytes plain and 299 bytes compressed, and the plain response still carries `Vary: Accept-Encoding`, so a cache cannot serve the wrong form. Below a kilobyte, gzip stays out of the way — a health check's sixteen bytes never see the compressor. Now the wall, and a browser's first question:

```bash
$ { printf "{\"title\":\""; head -c 65536 /dev/zero | tr "\0" x; printf "\"}"; } > big.json
$ curl -s -i -X POST -H "Content-Type: application/json" --data-binary @big.json http://127.0.0.1:18083/api/v1/tasks
HTTP/1.1 413 Request Entity Too Large
Content-Type: application/json
X-Request-Id: UiScnkwvoetwgISRBPhKRjkuKobHjHrJ
Date: Thu, 15 Oct 2026 06:13:08 GMT
Content-Length: 73

{"code":"request_entity_too_large","message":"Request Entity Too Large"}

$ curl -s -i -X OPTIONS -H "Origin: https://evil.example" -H "Access-Control-Request-Method: GET" http://127.0.0.1:18083/api/v1/tasks
HTTP/1.1 204 No Content
Allow: OPTIONS, GET, POST
Vary: Accept-Encoding
Vary: Origin
X-Request-Id: VRvrATGTjZYVfTGpFNQnrNGxViPeORBE
Date: Thu, 15 Oct 2026 06:13:08 GMT
```

The first command writes a 64 KiB body to a file; the second sends it. The 413 is refused before any handler sees the body — the wall is a size check, not a parse. The 204 is a **preflight**: the question a browser asks before a cross-origin request, answered by the closed CORS policy without ever reaching the route. Then the records the run left behind. stdout stays empty, and stderr holds the lifecycle records plus one `request` line per request, with the readiness poll and the task creates elided:

```bash
$ wc -c < stdout.txt
0
$ cat stderr.txt
{"time":"2026-10-15T11:43:08.296961801+05:30","level":"INFO","msg":"server listening","addr":"127.0.0.1:18083"}
...
{"time":"2026-10-15T11:43:08.448584372+05:30","level":"INFO","msg":"request","request_id":"live-42","method":"GET","path":"/api/v1/tasks","status":200,"duration":558111}
{"time":"2026-10-15T11:43:08.454270098+05:30","level":"INFO","msg":"request","request_id":"YWdtIlUOIvUBrooRhmDkJvqSWEAJqZga","method":"GET","path":"/api/v1/tasks","status":200,"duration":457300}
{"time":"2026-10-15T11:43:08.461890133+05:30","level":"INFO","msg":"request","request_id":"KeHYyTJWmYIMJQOCKhzDrwpFtHlWDxqI","method":"GET","path":"/api/v1/tasks","status":200,"duration":1137641}
{"time":"2026-10-15T11:43:08.475643543+05:30","level":"WARN","msg":"request","request_id":"UiScnkwvoetwgISRBPhKRjkuKobHjHrJ","method":"POST","path":"/api/v1/tasks","status":413,"duration":66319}
{"time":"2026-10-15T11:43:08.48106246+05:30","level":"INFO","msg":"request","request_id":"VRvrATGTjZYVfTGpFNQnrNGxViPeORBE","method":"OPTIONS","path":"/api/v1/tasks","status":204,"duration":19236}
{"time":"2026-10-15T11:43:08.486630551+05:30","level":"WARN","msg":"request","request_id":"xGacDBYsCJAnhcxixnwVFwHjqtCtgKqm","method":"GET","path":"/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d","status":404,"duration":262145}
{"time":"2026-10-15T11:43:08.48742896+05:30","level":"INFO","msg":"shutting down"}
{"time":"2026-10-15T11:43:08.487478883+05:30","level":"INFO","msg":"server stopped"}
```

Read the record for `live-42`: the id the client sent is in the response header and in the record, so a report quoting it joins exactly this line. The 413's record is a WARN, not an ERROR — the client sent too much, the server was fine — and the 404's is a WARN for the same reason. The same records are in the log file, because our middleware writes through the process logger's tee.

:::note
HSTS is absent from every response here on purpose: `Secure` sets `Strict-Transport-Security` only when the request arrived over https, and these are plain http. A header that tells a browser to stay on https, arriving over http, would be a lie.
:::

## If something went wrong

**The panic takes the test run down with it.** Before `Recover` is installed, the panic case doesn't fail like the others — it ends the whole run:

```bash
--- FAIL: TestPanic_Recovered (0.00s)
panic: boom [recovered, repanicked]

goroutine 15 [running]:
...
todo/internal/api_test.TestPanic_Recovered.func1({0xb468c2?, 0x0?})
	…/internal/api/middleware_test.go:212 +0x25
github.com/labstack/echo/v4.(*Echo).add.func1({0x1f4fa40, 0xcc03834d360})
	…/go/pkg/mod/github.com/labstack/echo/v4@v4.16.0/echo.go:611 +0x45
github.com/labstack/echo/v4.(*Echo).ServeHTTP(0xcc038516b48, {0x1f3f038, 0xcc0382a53c0}, 0xcc03841f180)
	…/go/pkg/mod/github.com/labstack/echo/v4@v4.16.0/echo.go:698 +0x323
...
FAIL	todo/internal/api	0.007s
FAIL
```

The route panics and nothing catches it, so the panic unwinds the test, and the testing package's own re-panic ends the binary with no test results at all. In a real server the process would survive — `net/http` catches panics per connection — but the client gets a dropped connection instead of a 500, and the trace never reaches the log. The fix is the `RecoverWithConfig` layer, with `DisableStackAll` and the `LogErrorFunc` that logs and returns the error.

**`expected "gateway_timeout", actual "internal_error"` — the classifier needed the 504.** If the case is missing from `codeForStatus`, the deadline test fails:

```bash
--- FAIL: TestTimeout_504 (0.00s)
    --- FAIL: TestTimeout_504/an_expired_deadline_is_a_504 (0.02s)
        middleware_test.go:314: 
            	Error:      	Not equal: 
            	            	expected: map[string]interface {}{"code":"gateway_timeout", "message":"request timed out"}
            	            	actual  : map[string]interface {}{"code":"internal_error", "message":"request timed out"}
            	Test:       	TestTimeout_504/an_expired_deadline_is_a_504
FAIL
FAIL	todo/internal/api	0.024s
FAIL
```

The message was right — "request timed out" — and only the code was wrong: the 504 fell into the `>= 500` fallback, and a timeout is not a bug. The fix is the case and its constant. The test found it, not a review, which is what writing the test first is for.

**The record says 200 while the client got 404.** If the `c.Error(err)` call is missing from `requestLogger`, the level test fails:

```bash
--- FAIL: TestRequestLog_Levels (0.00s)
    --- FAIL: TestRequestLog_Levels/a_404_is_a_warning (0.00s)
        middleware_test.go:201: 
            	Error:      	Not equal: 
            	            	expected: "WARN"
            	            	actual  : "INFO"
            	Test:       	TestRequestLog_Levels/a_404_is_a_warning
        middleware_test.go:202: 
            	Error:      	Not equal: 
            	            	expected: 404
            	            	actual  : 200
...
FAIL
FAIL	todo/internal/api	0.004s
FAIL
```

Echo's `ServeHTTP` calls the error handler only after the whole chain has returned, so a record written right after `next(c)` holds the 200 from before the failure was written — while the client still gets the 404 or the 500. The fix is `c.Error(err)` inside the chain: it renders the error where the record can see it, and echo's later call is a no-op because the response is committed.

<details>
<summary>Going deeper: why the order is a decision</summary>

Echo applies the list outermost first, and every position is the answer to a question. Two consequences are visible on the wire. First, an error response leaves uncompressed: the error handler runs at the logging layer's level, above Gzip. Second, a refusal decided above a layer doesn't get that layer's treatment — the body limit's 413 and a browser preflight's 204 carry no security headers, because both are answered above Secure. Both are fixed bodies with no user content, so nothing is lost, and moving Secure would be a one-line change if the answer ever changes.

</details>

<details>
<summary>Going deeper: what the time limit does — and doesn't — do</summary>

`ContextTimeout` arms a deadline on the request's context and nothing else. It does not interrupt anything. A handler that ignores the context keeps running past the deadline, and its late response is still served. What makes the deadline real is that the code inside respects it: the store checks the context before every operation and carries it into the database query, so an expired deadline surfaces as a failed operation — which is what the 504 reports. Two honest limits: the deadline doesn't bound a slow body read, because a request body doesn't consult the context, and ten seconds is a policy number, not a measurement — every route here is a local database read or write, and nothing has timed it yet.

</details>

<details>
<summary>Going deeper: why the logger travels in the request's context</summary>

A handler needs to log with the request's id attached, and it doesn't receive a logger — it receives the request. So the middleware puts the logger *in* the request's context, the same way the deadline travels, and `LoggerFrom` is how any code gets it back. Two details make it safe: the context key is a struct type, so it cannot collide with a key another package sets, and `LoggerFrom` falls back to `slog.Default()` when there is no request — a call site never has to ask whether logging is available. The id itself lives in the response header rather than the request's: RequestID sets it there, the client reads it back from there, and the record reads it from there too, so the two copies can't drift. A client-supplied id is trusted on purpose — correlating a caller's report with the server's records is the whole point.

</details>

Every request now has a name, a record, a time limit, and a size limit — next, the app learns who is asking.
