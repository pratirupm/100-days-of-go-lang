---
title: "Day 54 — Tracing and metrics"
description: "Follow every request with a trace, count the traffic on a metrics endpoint, and keep the memory profiles admin-only."
sidebar:
  order: 54
chapter: 45
---

**About 3 hours** · Part X, day 1 of 6.

**You'll be able to:**

- trace requests and expose Prometheus metrics;
- profile the server with pprof when the numbers look wrong.

---

The server keeps one record per request, and each record carries a request id, so a single request can be followed through the log. What the log cannot answer is the shape of the traffic: how many requests arrived, how many failed, which one was slow. Nothing says where the process's memory goes, either.

Three signals answer those questions. A **trace** is a stopwatch that records each request's journey: when it started, what happened inside it, and when it ended. A **metric** is a counter or a timer you can chart — requests served, failures, how long they took. A **profile** is a snapshot of where the process is spending its memory or its processor time.

The signals meet on ids. Each request's stopwatch mints a **trace id**, and the log record starts carrying it beside the request id — so a slow line can be walked to its trace, and a trace back to its exact record.

By the end, one endpoint answers numbers a monitoring tool can chart, every record names its trace, and the memory profiles open only for an admin.

## The tests come first

The new behavior gets its tests first, in `internal/api/observability_test.go`, beside the other API tests. Five cases: the scrape endpoint answers and counts; the route label is the pattern, not the path; the runtime's own numbers ride the same scrape; the record carries a trace id; and the profiles refuse callers who are not admins.

The first helper performs the **scrape**: one GET of `/metrics`, whose body is plain text in a documented layout called the **exposition format**. The helper reads it with the format's own parser, so the assertions talk about numbers, not substrings.

<!-- verify: internal/api/observability_test.go at=api-observability -->
```go title="internal/api/observability_test.go"
func scrapeMetrics(t *testing.T, e *echo.Echo) map[string]*dto.MetricFamily {
	t.Helper()

	rec := get(t, e, "/metrics")
	require.Equal(t, http.StatusOK, rec.Code, "the scrape endpoint must answer; body: %s", rec.Body.String())

	parser := expfmt.NewTextParser(model.LegacyValidation)
	families, err := parser.TextToMetricFamilies(rec.Body)
	require.NoError(t, err, "the scrape must be valid exposition text")
	return families
}
```

The parser turns the text into named families of measurements. The finished app's appendix holds the new files in full; the pieces quoted here are the ones that carry the idea.

The first case is the whole idea on one page — one request, one scrape:

<!-- verify: internal/api/observability_test.go at=api-observability -->
```go title="internal/api/observability_test.go"
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
```

`todo_http_requests_total` gained one series with three labels — `GET`, `/healthz`, `200` — and the duration histogram recorded the same request as one observation. The counter carries the rate and the errors: the status is one of its labels.

The second case pins the label rule. The client asks for a task id that does not exist, and the scrape must name the pattern — never the id:

<!-- verify: internal/api/observability_test.go at=api-observability -->
```go title="internal/api/observability_test.go"
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
```

The id the client sent is nowhere in the scrape. The 404 is one series of the counter under `route="/api/v1/tasks/:id"`, and a path no route matches becomes the one `unmatched` series.

The third case is the join between the record and the stopwatch:

<!-- verify: internal/api/observability_test.go at=api-observability -->
```go title="internal/api/observability_test.go"
		rec := get(t, e, "/healthz")

		require.Equal(t, http.StatusOK, rec.Code)
		records := logRecords(t, buf)
		require.Len(t, records, 1)
		assert.Regexp(t, `^[0-9a-f]{32}$`, records[0].TraceID, "a W3C trace id is 32 lowercase hex characters")
```

A W3C trace id — the format every trace backend indexes — is 32 lowercase hex characters, and the record must carry one. The case also asserts that two requests get two different ids, and that a failure's records share one trace: an incident is one trace and one request id.

The last case is the exposure rule:

<!-- verify: internal/api/observability_test.go at=api-observability -->
```go title="internal/api/observability_test.go"
	t.Run("anonymous callers are refused", func(t *testing.T) {
		t.Parallel()

		e, _ := newPprofAPI(t, adminLookup{user: auth.User{ID: testUserID, IsAdmin: true}})

		rec := get(t, e, "/debug/pprof/")

		require.Equal(t, http.StatusUnauthorized, rec.Code)
		assert.JSONEq(t, `{"code":"unauthorized","message":"authentication required"}`, rec.Body.String())
	})
```

The other four subtests walk the rest of the check: a non-admin gets the named 403, a session naming no user gets 401, a lookup failure the fixed 500, and an admin the index.

Run the five cases:

```bash
$ go test -count=1 -run 'TestMetrics_RequestCounter|TestMetrics_RoutePattern|TestMetrics_RuntimeCollectors|TestRequestLog_TraceID|TestPprof_RequiresAdmin' ./internal/api
--- FAIL: TestMetrics_RequestCounter (0.00s)
    observability_test.go:107: 
        	Error:      	Not equal: 
        	            	expected: 200
        	            	actual  : 404
        	Test:       	TestMetrics_RequestCounter
        	Messages:   	the scrape endpoint must answer; body: {"code":"not_found","message":"Not Found"}
...
--- FAIL: TestRequestLog_TraceID (0.00s)
    --- FAIL: TestRequestLog_TraceID/the_record_carries_the_span's_trace_id (0.00s)
        observability_test.go:177: 
            	Error:      	Expect "" to match "^[0-9a-f]{32}$"
            	Messages:   	a W3C trace id is 32 lowercase hex characters
...
--- FAIL: TestPprof_RequiresAdmin (0.00s)
    --- FAIL: TestPprof_RequiresAdmin/anonymous_callers_are_refused (0.00s)
        observability_test.go:257: 
            	Error:      	Not equal: 
            	            	expected: 401
            	            	actual  : 404
...
FAIL
FAIL	todo/internal/api	0.036s
FAIL
```

Every failure is one of two sentences: nothing serves `/metrics` or `/debug/pprof` yet — echo answers its own 404 — or the record has no trace id, and `""` matches nothing. Nothing is broken; the app does not do this yet.

## A home for the plumbing

The process-level pieces live in a new package, `internal/telemetry`: the pipeline that starts and ships spans — a **span** is one unit of a trace, a named stretch with a start and an end — and the **registry**, the set of measurements the scrape endpoint serves.

The libraries come first. Fetch them with two commands — `go get go.opentelemetry.io/otel@v1.47.0 go.opentelemetry.io/otel/trace@v1.47.0 go.opentelemetry.io/otel/sdk@v1.47.0 go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.47.0` and `go get github.com/prometheus/client_golang@v1.25.0 github.com/prometheus/common@v0.72.1 github.com/prometheus/client_model@v0.6.3` — then let `go mod tidy` settle the rest. OpenTelemetry is the standard toolkit these traces and metrics are built on; the Prometheus client is the metrics library. The `require` block gains seven lines:

<!-- verify: go.mod at=api-observability -->
```text title="go.mod"
require (
...
	github.com/prometheus/client_golang v1.25.0
	github.com/prometheus/client_model v0.6.3
	github.com/prometheus/common v0.72.1
...
	go.opentelemetry.io/otel v1.47.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.47.0
	go.opentelemetry.io/otel/sdk v1.47.0
	go.opentelemetry.io/otel/trace v1.47.0
)
```

Five are libraries the app calls directly; `common` and `client_model` arrive for the tests' parser.

Now the package:

<!-- verify: internal/telemetry/telemetry.go at=api-observability -->
```go title="internal/telemetry/telemetry.go"
// Package telemetry builds the process's observability plumbing: the tracer
// provider the HTTP stack starts spans with, and the metrics registry the
// scrape endpoint serves. Both are constructed once, at boot, and handed to
// the parts that use them — the package owns the process-level pieces, and
// the HTTP layer owns what a request contributes to them.
...
package telemetry
```

The off mode is the first three lines of the constructor, and it is the honest default:

<!-- verify: internal/telemetry/telemetry.go at=api-observability -->
```go title="internal/telemetry/telemetry.go"
func NewTracerProvider(ctx context.Context, endpoint string, logger *slog.Logger) (*sdktrace.TracerProvider, error) {
	if endpoint == "" {
		return sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample())), nil
	}
	...
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("telemetry: endpoint %q: want a URL with scheme and host, like http://collector:4318", endpoint)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = defaultTracesPath
	}
```

Without an endpoint the provider samples nothing — `NeverSample` — so no span is recorded and no batch is buffered. Every span still gets a real trace id, minted before the sampling decision; that id is what the records join on, so the default works on a laptop with no collector anywhere.

The endpoint is validated at boot, so a typo stops the process with one sentence instead of costing a failed export every batch. A URL with no path — or the root — is given `/v1/traces`, the **signal path** traces travel on: the standard environment variable's handling appends that path, while the option used here takes a URL as given, and two spellings of one base URL must not reach two different places.

The library's own failures go through the process logger:

<!-- verify: internal/telemetry/telemetry.go at=api-observability -->
```go title="internal/telemetry/telemetry.go"
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		logger.Error("telemetry export failed", "err", err)
	}))

	return sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		...
	), nil
}
```

A collector that is away produces one structured record, through the same channel as every other record, rather than a line on the standard library's error stream. The second constructor composes the scrape:

<!-- verify: internal/telemetry/telemetry.go at=api-observability -->
```go title="internal/telemetry/telemetry.go"
func NewRegistry() *prometheus.Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return reg
}
```

The Go collector is where `go_gc_duration_seconds`, the heap families, and `go_goroutines` come from; the process collector is where `process_resident_memory_bytes` — the process's memory footprint — comes from. A fresh registry per server is what lets a scrape expose exactly what this process registered.

## A span for every request

The HTTP half lives in `internal/api/observability.go`, and it starts with the rule the span and the metrics share:

<!-- verify: internal/api/observability.go at=api-observability -->
```go title="internal/api/observability.go"
// unmatchedRoute is the route label for a request no route pattern matched.
// The empty c.Path() would be a valid label value, but an empty label is
// indistinguishable in a scrape from a missing one, so the unmatched bucket
// has a name — and it is one series, not one per path an unknown client
// probes.
const unmatchedRoute = "unmatched"

...
func routePattern(c echo.Context) string {
	if path := c.Path(); path != "" {
		return path
	}
	return unmatchedRoute
}
```

The label is the pattern the router matched — `/api/v1/tasks/:id`, never the id the client sent. A series per task id would grow without bound, while a pattern is one series per route. A request no pattern matched gets the one `unmatched` series.

Then the layer that starts one span per request:

<!-- verify: internal/api/observability.go at=api-observability -->
```go title="internal/api/observability.go"
func traceRequests(tp trace.TracerProvider) echo.MiddlewareFunc {
	tracer := tp.Tracer("todo/internal/api")
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			req := c.Request()
			ctx, span := tracer.Start(req.Context(), req.Method+" "+routePattern(c),
				trace.WithSpanKind(trace.SpanKindServer))
			defer span.End()
			c.SetRequest(req.WithContext(ctx))
```

The span's name is the method plus the pattern, computed before the rest of the chain runs: `c.Path()` is what the router matched, and these layers run inside the route's handler. The span is put into the request's context, so everything inside the request can start child spans on it.

<!-- verify: internal/api/observability.go at=api-observability -->
```go title="internal/api/observability.go"
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
```

After the chain returns, the span records the status the client received, and a failure of 500 or above is marked as an error — a 404 is the client's miss, but a 500 is what a trace backend should surface. The `request_id` attribute is read from the response header the id layer set above, so the trace names its request while the record names its trace.

The record's half of the join is a few lines in the logging layer:

<!-- verify: internal/api/middleware.go at=api-observability -->
```go title="internal/api/middleware.go"
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
```

The guard is the difference between "no tracing here" and "tracing that produced nothing": an empty string would be a field someone chases, while an absent field is the truth. In the default mode the span is always valid, so the field is always present.

The stack grows two entries, both between the id and the logging layer:

<!-- verify: internal/api/middleware.go at=api-observability -->
```go title="internal/api/middleware.go"
//	RequestID -> tracing -> metrics -> request logging -> Secure -> Recover ->
//	login limiter -> Timeout -> sessions -> BodyLimit -> Gzip -> CORS
...
func useStack(e *echo.Echo, logger *slog.Logger, sessions *scs.SessionManager, tp trace.TracerProvider, metrics *requestMetrics) {
```

<!-- verify: internal/api/middleware.go at=api-observability -->
```go title="internal/api/middleware.go"
		// The span, and the trace id the record below joins on. It sits
		// outside everything that can fail or log, so the span covers the
		// whole request and ends with the status the client received.
		traceRequests(tp),

		// The two RED collectors, above the logging middleware for the
		// same reason the span is: the status they observe must be final.
		metrics.middleware(),

		requestLogger(logger),
```

Both sit above the logging middleware for the same reason: the status they observe must be final. The error handler runs inside the logging layer — that layer renders the failure itself — so a span or a counter below it would see the 200 the response held before the failure was written.

## Two collectors and a scrape endpoint

The metrics are two collectors, built and registered in one constructor:

<!-- verify: internal/api/observability.go at=api-observability -->
```go title="internal/api/observability.go"
type requestMetrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

...
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
```

The names are the exposition format's, spelled by the options: namespace `todo`, subsystem `http`, name `requests_total` renders as `todo_http_requests_total`. It is labelled by method, route pattern, and status, so the counter carries both the rate and the errors. The histogram, `todo_http_request_duration_seconds`, is labelled by method and route only: a duration per status would split one route's latency into as many histograms as it has outcomes, and the counter is where statuses belong. Its default buckets run from 5 milliseconds to 10 seconds.

The middleware observes after the chain has run:

<!-- verify: internal/api/observability.go at=api-observability -->
```go title="internal/api/observability.go"
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
```

The status it counts is the client's final status. And the scrape's own request is not in the numbers it serves: the body is written during the chain, the observation after it. That is what makes a scrape deterministic — the counter a scrape reports is the counter as of before the scrape.

One route serves the registry, under the same stack as every other route:

<!-- verify: internal/api/api.go at=api-observability -->
```go title="internal/api/api.go"
	e.GET("/metrics", echo.WrapHandler(promhttp.HandlerFor(reg, promhttp.HandlerOpts{})))
```

The handler serves the registry the process built, not a global default, and the route is not under `/api/v1` — it is the process's numbers, not a versioned API operation. `/metrics` is public on purpose: the default listen address is loopback, the body is counters and gauges with no task data in it, and a monitoring server that had to hold a session cookie is a scraper nobody configures.

## The profiles, behind the admin check

The third signal's surface is `/debug/pprof` — the standard library's profile handlers, mounted on this server. It is the one surface here that is never public: a heap profile is the process's memory, and memory can hold session tokens, password material, and whatever a future handler leaves in it.

The check sits inside the session check and reads the admin flag from the database on every request:

<!-- verify: internal/api/authorization.go at=api-observability -->
```go title="internal/api/authorization.go"
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
```

An id no user holds is answered like a missing session — 401 — and a live user without the flag gets the named 403: the profile endpoint's existence is public knowledge, so the refusal is the honest answer. A lookup failure is the server's, so it leaves as an error and the one error handler answers the fixed 500. Reading the flag per request means a grant or a revoke takes effect on the next request, not the next login.

The lookup is a new query and one service method:

<!-- verify: internal/auth/auth.go at=api-observability -->
```go title="internal/auth/auth.go"
func (s *Service) UserByID(ctx context.Context, id uuid.UUID) (User, error) {
	row, err := s.queries.GetUserByID(ctx, id.String())
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, fmt.Errorf("user %s: %w", id, ErrUserNotFound)
	}
	if err != nil {
		return User{}, fmt.Errorf("get user %s: %w", id, err)
	}
	user, err := userFromRow(row)
	if err != nil {
		return User{}, fmt.Errorf("get user %s: %w", id, err)
	}
	return user, nil
}
```

A missing row becomes the service's own `ErrUserNotFound`; everything else is wrapped and reported. The query is the users table's primary key:

<!-- verify: internal/db/queries/auth.sql at=api-observability -->
```sql title="internal/db/queries/auth.sql"
-- name: GetUserByID :one
SELECT id, email, password_hash, created_at, is_admin
FROM users
WHERE id = ?;
```

After adding the query, regenerate the code built from it with `go generate ./...`; the file under `internal/db` is generated every time and never edited by hand. The API's `Authenticator` interface grows the method, and the compile-time assertion beside it keeps the service and the interface from drifting apart:

<!-- verify: internal/api/auth.go at=api-observability -->
```go title="internal/api/auth.go"
	// UserByID returns the user a session names. It is the admin gate's
	// lookup (see RequireAdmin): the profiles are reachable only by a user
	// whose flag says so, and the flag is read per request rather than
	// carried in the session, so a grant or a revoke takes effect on the
	// next request instead of the next login.
	UserByID(ctx context.Context, id uuid.UUID) (auth.User, error)
```

The mount is six routes in one group:

<!-- verify: internal/api/api.go at=api-observability -->
```go title="internal/api/api.go"
	profiles := e.Group("/debug/pprof", RequireUser(sessions), RequireAdmin(authn))
	profiles.GET("", echo.WrapHandler(http.HandlerFunc(pprof.Index)))
	profiles.GET("/*", echo.WrapHandler(http.HandlerFunc(pprof.Index)))
	profiles.GET("/cmdline", echo.WrapHandler(http.HandlerFunc(pprof.Cmdline)))
	profiles.GET("/profile", echo.WrapHandler(http.HandlerFunc(pprof.Profile)))
	profiles.GET("/symbol", echo.WrapHandler(http.HandlerFunc(pprof.Symbol)))
	profiles.GET("/trace", echo.WrapHandler(http.HandlerFunc(pprof.Trace)))
```

`Index` serves both the directory page and the runtime's named profiles beneath it — heap, goroutine, allocs, block, mutex, threadcreate — which is why the mount is shorter than the full list looks. The group carries `RequireUser` then `RequireAdmin`, so an anonymous caller gets the one 401 shape before any lookup runs.

One more check needs to know about the new routes. The OpenAPI coverage test demands the spec document every route; `/metrics` and `/debug/pprof` are operational surface — their clients are a monitoring server and a profiler — so they are skipped by name:

<!-- verify: internal/api/docs_test.go at=api-observability -->
```go title="internal/api/docs_test.go"
// metricsPath is the scrape endpoint. Its client is a Prometheus server and
// its vocabulary is the exposition format, not JSON, so it is operational
// surface rather than API surface, like the UI.
const metricsPath = "/metrics"

// pprofPath is the profiles' mount point, behind the admin gate. Their
// client is a profiler an operator runs, not an API caller, so the whole
// subtree is operational surface too.
const pprofPath = "/debug/pprof"
```

<!-- verify: internal/api/docs_test.go at=api-observability -->
```go title="internal/api/docs_test.go"
		if route.Path == swaggerPath || route.Path == metricsPath ||
			strings.HasPrefix(route.Path, pprofPath) || route.Method == echo.RouteNotFound {
			continue
		}
```

The skip is by name and prefix: a spec that documented `/metrics` would invite API clients to scrape it, and the profile routes are the runtime's, not this application's.

## The setting and the wiring

Configuration gains one setting:

<!-- verify: internal/config/config.go at=api-observability -->
```go title="internal/config/config.go"
const (
	envDB     = "TODO_DB"
	envLog    = "TODO_LOG"
	envListen = "TODO_LISTEN"
	envAPI    = "TODO_API_URL"
	envOTel   = "TODO_OTEL_ENDPOINT"
)
```

<!-- verify: internal/config/config.go at=api-observability -->
```go title="internal/config/config.go"
	// OTelEndpoint is the OTLP HTTP endpoint traces are exported to. Empty
	// means export is off: spans still carry trace ids — the logs and the
	// traces stay joined — but nothing leaves the process. There is no
	// default: a collector on localhost is an assumption, and a wrong one
	// costs a failed export per batch in the log.
	OTelEndpoint string
```

`TODO_OTEL_ENDPOINT` is read through the same environment seam as every other setting. The empty value is the design decision: there is no default, because a collector on localhost is an assumption, and a wrong one costs a failed export per batch in the log rather than a boot error. Empty means export is off; the spans still carry trace ids, so the logs and the traces stay joined.

`main` builds the provider before the server and defers its shutdown:

<!-- verify: cmd/todo-server/main.go at=api-observability -->
```go title="cmd/todo-server/main.go"
	tp, err := telemetry.NewTracerProvider(ctx, cfg.OTelEndpoint, logger)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer func() {
		// The flush gets the same budget as the drain: five seconds is
		// longer than a batch export should take, and a flush that fails is
		// recorded rather than fatal — the requests were served, and losing
		// the last spans is telemetry's problem, not the process's.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := tp.Shutdown(shutdownCtx); err != nil {
			logger.Error("telemetry shutdown failed", "err", err)
		}
	}()
```

The provider is built first so the stack has it from the first request. Its shutdown is deferred, so it runs when the process is leaving — after the server has drained the in-flight requests — and gives the last batch five seconds to ship. A boot that cannot build the provider prints one line and exits; a flush that fails is recorded, not fatal.

The registry is the process's own, and the constructor hands both pieces to the API:

<!-- verify: cmd/todo-server/main.go at=api-observability -->
```go title="cmd/todo-server/main.go"
	reg := telemetry.NewRegistry()
	...
	e := api.New(st, authn, sessions, logger, tp, reg)
```

`api.New` grew two parameters, so every test constructor moves with it — and the helpers pass the production constructors, so the tests exercise the real default rather than a copy of it.

<!-- verify: internal/api/api_test.go at=api-observability -->
```go title="internal/api/api_test.go"
func testTracerProvider() trace.TracerProvider {
	tp, err := telemetry.NewTracerProvider(context.Background(), "", discardLogger())
	if err != nil {
		panic(err)
	}
	return tp
}
```

The helper builds the provider in its off mode, which has no failure path; the registry is the production one, which lets the runtime-collector case assert on a scrape. Three smaller edits ride along: `logRecord` grows `TraceID`, the config table grows the `TODO_OTEL_ENDPOINT` row, and the auth suite grows `TestUserByID`.

## The pipeline's own tests

With the package built, its two modes get tests of their own, over a real stand-in for a collector: an `httptest` server that records what it receives. The off mode first:

<!-- verify: internal/telemetry/telemetry_test.go at=api-observability -->
```go title="internal/telemetry/telemetry_test.go"
	_, span := tp.Tracer("telemetry-test").Start(context.Background(), "op")
	defer span.End()

	assert.True(t, span.SpanContext().IsValid(), "a non-recording span still carries a trace id")
	assert.False(t, span.IsRecording(), "the off mode records nothing")
	assert.False(t, span.SpanContext().IsSampled(), "nothing is sampled for export")
```

A span from the off-mode provider is not recording and not sampled — nothing will be exported — and its context is still valid: it carries the trace id the records join on. That is the mode every laptop lives in.

The export case ends a span and calls `Shutdown`; the call is what ships the batch, with no waiting on the timer:

<!-- verify: internal/telemetry/telemetry_test.go at=api-observability -->
```go title="internal/telemetry/telemetry_test.go"
	// No wait: the batch timer is five seconds, and this call is what ships
	// the span.
	require.NoError(t, tp.Shutdown(context.Background()))

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []string{"/v1/traces"}, paths, "a path-less endpoint gets the signal path")
	require.Positive(t, sizes[0], "the batch carries the span")
```

The collector received one POST at `/v1/traces` — the signal path, on the wire — and the body was not empty. Both cases ran red against the pipeline as it first landed, and the failures are in "If something went wrong".

## Watch the server explain itself

Run the new cases, then the whole module:

```bash
$ go test -count=1 -v -run 'TestMetrics_|TestRequestLog_TraceID|TestPprof_RequiresAdmin|TestTracerProvider' ./internal/api ./internal/telemetry
--- PASS: TestRequestLog_TraceID (0.00s)
--- PASS: TestPprof_RequiresAdmin (0.00s)
--- PASS: TestMetrics_RuntimeCollectors (0.00s)
--- PASS: TestMetrics_RequestCounter (0.00s)
--- PASS: TestMetrics_RoutePattern (0.00s)
ok  	todo/internal/api	0.053s
--- PASS: TestTracerProvider_BadEndpoint (0.00s)
--- PASS: TestTracerProvider_OffMode (0.00s)
--- PASS: TestTracerProvider_ExportAndFlush (0.00s)
ok  	todo/internal/telemetry	0.007s
```

The api line is the suite that failed a moment ago, and the telemetry line is the new package.

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	1.636s
ok  	todo/cmd/todo-server	2.162s
ok  	todo/internal/api	0.684s
?   	todo/internal/api/docs	[no test files]
ok  	todo/internal/auth	0.655s
ok  	todo/internal/cli	0.237s
...
ok  	todo/internal/store	0.597s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.006s
ok  	todo/internal/telemetry	0.007s
```

Every package passes.

Then a real server, started as before — a scratch folder with `TODO_DB` and `TODO_LOG` inside it, two users registered, one granted admin by the command line — with the base URL in `$B` and each login's cookie in a file (`alice.jar`, `bob.jar`).

The first scrape finds no request series at all, and the runtime's numbers already there:

<!-- transcripts: authored -->
```bash
$ curl -s $B/metrics | grep -cE "^todo_http"
0
```

```bash
$ curl -s $B/metrics | grep -E "^(go_gc_duration_seconds_count|process_resident_memory_bytes|go_goroutines) "
go_gc_duration_seconds_count 1
go_goroutines 11
process_resident_memory_bytes 6.180864e+07
```

A counter family has no series until a label set is used, so before any traffic the request families do not exist — while the runtime's own readings, `go_gc_duration_seconds_count`, `go_goroutines`, and `process_resident_memory_bytes`, are already there.

Now six requests of five kinds, three of them failures:

<!-- transcripts: authored -->
```bash
$ curl -s $B/healthz ; curl -s $B/healthz
{"status":"ok"}
{"status":"ok"}

$ curl -s -b alice.jar $B/api/v1/tasks
{"tasks":[]}

$ curl -s -b alice.jar $B/api/v1/tasks/01a13ec6-0000-7000-8000-000000000000
{"code":"not_found","message":"task not found"}

$ curl -s $B/api/v1/tasks          # no session
{"code":"unauthorized","message":"authentication required"}

$ curl -s -X POST -H "Content-Type: application/json" --data '{"title":""}' -b alice.jar $B/api/v1/tasks
{"code":"validation_failed","message":"validation failed","fields":[{"field":"title","message":"cannot be empty"}]}
```

The 404 is a matched route answering a missing task, the 401 is the session check, and the 422 is a failed validation: three failure classes a scraper can tell apart.

And the next scrape counts them:

```bash
$ curl -s $B/metrics | grep -E "^todo_http_requests_total|^todo_http_request_duration_seconds_count"
todo_http_request_duration_seconds_count{method="GET",route="/api/v1/tasks"} 2
todo_http_request_duration_seconds_count{method="GET",route="/api/v1/tasks/:id"} 1
todo_http_request_duration_seconds_count{method="GET",route="/healthz"} 2
todo_http_request_duration_seconds_count{method="GET",route="/metrics"} 2
todo_http_request_duration_seconds_count{method="POST",route="/api/v1/tasks"} 1
todo_http_requests_total{method="GET",route="/api/v1/tasks/:id",status="404"} 1
todo_http_requests_total{method="GET",route="/api/v1/tasks",status="200"} 1
todo_http_requests_total{method="GET",route="/api/v1/tasks",status="401"} 1
todo_http_requests_total{method="GET",route="/healthz",status="200"} 2
todo_http_requests_total{method="GET",route="/metrics",status="200"} 2
todo_http_requests_total{method="POST",route="/api/v1/tasks",status="422"} 1
```

Read the labels. The 404 names `route="/api/v1/tasks/:id"` — the id the client sent is nowhere in the scrape — and the failure classes are separate series of one counter (`status="404"`, `"401"`, `"422"`). The scrape's own request is not in the numbers it serves: `/metrics` shows 2, from the two earlier scrapes, not 3. That is what makes a scrape deterministic.

The log holds the join:

```bash
$ grep trace_id todo.log | tail -4
{"time":"2026-10-15T14:27:41.204493489+05:30","level":"WARN","msg":"request","request_id":"miYYOMspphUlcxahkwDWsQvuiMzTHnWu","trace_id":"3d5eabef39a78f1934c95b53f404383d","method":"GET","path":"/api/v1/tasks/01a13ec6-0000-7000-8000-000000000000","status":404,"duration":367822}
...
{"time":"2026-10-15T14:27:41.221898324+05:30","level":"INFO","msg":"request","request_id":"EWlAVbjehoVcUKpvlzAvuPVNrXqXRGwQ","trace_id":"1a507309e063994fea76ba517df6e841","method":"GET","path":"/metrics","status":200,"duration":561605}
```

Every record carries one request id and one trace id, traveling together.

Now the profiles, three answers:

<!-- transcripts: authored -->
```bash
$ curl -s -o /dev/null -w "%{http_code}\n" $B/debug/pprof/          # anonymous
401

$ curl -s -b bob.jar -w " [%{http_code}]\n" $B/debug/pprof/     # bob, not an admin
{"code":"forbidden","message":"admin required"}
 [403]

$ curl -s -b alice.jar -w " [%{http_code}]\n" $B/debug/pprof/ | grep -oE "<a href=.[a-z]+"
<a href='allocs
<a href='block
<a href='cmdline
<a href='goroutine
...
```

The check answers three ways: anonymous is 401; the non-admin is the named 403; the admin gets the index, whose links are the runtime's profiles. One profile comes down as a file:

<!-- transcripts: authored -->
```bash
$ curl -s -b alice.jar -o heap.prof -w "%{http_code} %{size_download} bytes\n" $B/debug/pprof/heap
200 2286 bytes
```

The heap profile is the process's memory. Name the biggest retention in it:

```bash
$ go tool pprof -top heap.prof | sed -n '1,12p'
File: todo-server
Type: inuse_space
Showing nodes accounting for 22531.08kB, 100% of 22531.08kB total
...
      flat  flat%   sum%        cum   cum%
   19456kB 86.35% 86.35% 19968.19kB 88.63%  golang.org/x/crypto/argon2.initBlocks
 2050.81kB  9.10% 95.45%  2050.81kB  9.10%  runtime.mallocgc
         0     0%   100% 19968.19kB 88.63%  golang.org/x/crypto/argon2.IDKey
```

The largest block is the password hashing's 19 MiB working set, left behind by a login — the kind of thing a heap profile shows, and the reason the profiles are not public. Your numbers will differ; the shape is the point.

## The export, end to end

The scrape proves the metrics. The export path — the other half of tracing
— is proven by the package's own test, and that test is the proof you can
reproduce. The capture below is not part of the app: it came from the
author's own rig — a small script standing in for a trace backend — with the
server started against it and three requests served:

<!-- transcripts: authored -->
```bash
$ python3 collector.py otlp.bin &
$ TODO_OTEL_ENDPOINT=http://127.0.0.1:4318 ./todo-server --listen 127.0.0.1:18045 &
$ curl -s $B/healthz ; curl -s -b alice.jar $B/api/v1/tasks ; curl -s -b alice.jar $B/api/v1/tasks/… 
...
$ cat collector.txt
POST /v1/traces 795 bytes
$ strings otlp.bin | grep -E "todo-server|GET /" | sort -u
GET /api/v1/tasks0
GET /api/v1/tasks/:id0
GET /healthz0
todo-server
```

The batch arrived at `/v1/traces` — the normalization, on the wire — and it names the service and the span names. `GET /api/v1/tasks/:id` is the pattern again, not the id; the stray characters after the names are bytes from the encoded body, and the names are the point.

When the process leaves, the deferred `Shutdown` flushes the last batch. What that looks like when the collector is already gone is the last entry below.

## If something went wrong

**`not enough arguments in call to api.New` — the signature change reaches every test constructor.** The moment `New` grows its two parameters, before the callers move:

```bash
vet: internal/api/api_test.go:100:49: not enough arguments in call to api.New
	have (store.Store, stubAuth, *scs.SessionManager, *slog.Logger)
	want (store.Store, api.Authenticator, *scs.SessionManager, *slog.Logger, "go.opentelemetry.io/otel/trace".TracerProvider, *prometheus.Registry)
```

`api.New` takes the tracer provider and the metrics registry now, and the test helpers still call the old shape. The helpers move with it — `newTestAPI`, `newTaskAPI`, `newAuthAPI`, the docs cases, the profile helper — passing the provider in its off mode and `telemetry.NewRegistry()`, the production constructors, so the tests exercise the real default.

**`expected: []string{"/v1/traces"} actual: []string{"/"}` — the batch lands on the root.** The export case against the pipeline as it first landed:

```bash
--- FAIL: TestTracerProvider_ExportAndFlush (0.00s)
    telemetry_test.go:85: 
        	Error:      	Not equal: 
        	            	expected: []string{"/v1/traces"}
        	            	actual  : []string{"/"}
...
FAIL	todo/internal/telemetry	0.007s
```

The option that takes the endpoint URL uses it as given — a path-less URL targets the root on purpose — while the standard environment variable's handling appends the signal path. The fix is the code quoted above: append `/v1/traces` when the path is empty or the root, and the collector shows `POST /v1/traces`.

**`An error is expected but got nil.` — the library swallowed the bad URL.** The boot-time case against the same first version:

```bash
--- FAIL: TestTracerProvider_BadEndpoint (0.00s)
    telemetry_test.go:97: 
        	Error:      	An error is expected but got nil.
...
FAIL	todo/internal/telemetry	0.007s
```

The exporter's own handling of an endpoint it cannot parse is to log it and keep its localhost default, so a typo produced no boot error and one failed export per batch — a log line every five seconds is the worst place to find a configuration mistake. The fix is the check in the constructor: scheme and host, or an error, so the typo is one sentence and exit 1 at boot:

<!-- transcripts: authored -->
```bash
$ TODO_OTEL_ENDPOINT=collector:4318 ./todo-server --listen 127.0.0.1:18046
telemetry: endpoint "collector:4318": want a URL with scheme and host, like http://collector:4318
$ echo $?
1
```

**`telemetry export failed` after the drain — the failure that is the feature.** With the collector dead and one span pending:

```bash
{"time":"2026-10-15T14:35:02.584505144+05:30","level":"INFO","msg":"shutting down"}
{"time":"2026-10-15T14:35:02.584551649+05:30","level":"INFO","msg":"server stopped"}
{"time":"2026-10-15T14:35:02.585118248+05:30","level":"ERROR","msg":"telemetry export failed","err":"traces export: Post \"http://127.0.0.1:4318/v1/traces\": dial tcp 127.0.0.1:4318: connect: connection refused"}
```

The deferred `Shutdown` runs after the drain and flushes the last batch; the collector is gone, so the export fails. Nothing needs fixing — this is the wiring working: one structured record through the process logger, and exit 0. The requests were served; losing the last spans is telemetry's problem, not the process's.

<details>
<summary>Going deeper: why the off mode still mints trace ids</summary>

The library's default provider is a true no-op: it records nothing, and its spans have no trace id, nothing to join on. A process that used it would carry a trace id only on machines with a collector — backwards, because the laptop that needs the join most is the one without a collector. So the off mode is a real provider with a sampler that answers "drop": the id generator runs first, then the sampler, and a non-recording span is built around the real context. Every record still joins to a trace, exported or not.

</details>

<details>
<summary>Going deeper: why the labels are patterns, not paths</summary>

A monitoring system keeps one series per distinct set of labels, forever. If the route label were the concrete path, every task id would create a series as tasks come and go — a week of scanning probes would leave thousands of series, each holding one request. The pattern the router matched bounds the count at the number of routes, and a path no route matches collapses into one `unmatched` series. The log record keeps the concrete path, because a record is read once, not charted forever.

</details>

<details>
<summary>Going deeper: why the profiles are never public</summary>

`/metrics` is counters and gauges: route names, traffic volumes, the runtime's numbers — operational data, bounded and impersonal. A heap profile is different: it is a picture of the process's memory, and memory holds session tokens, password material, and whatever a future handler leaves in it. So the profiles are gated on every deployment, not just public ones, and the flag that opens them is the same one the operator's command line sets. The network boundary is a deployment decision, made later.

</details>

<details>
<summary>Going deeper: why a failed flush is recorded, not fatal</summary>

The requests were already served; the only thing left is telemetry about them. A process that exits non-zero because a collector was away turns a monitoring problem into an outage, and a supervisor would restart a server that was working. So the flush gets five seconds, and a failure becomes one structured record through the process logger — the same channel every other record uses, which is why the library's error handler points there. The exit code stays 0.

</details>

The process explains itself now — a trace id on every record, a scrape that names its routes, and profiles only an admin can open. Next, it learns to keep a secret.

<div class="day-tracker" data-day="54"></div>
