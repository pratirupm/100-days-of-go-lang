---
title: "internal/telemetry — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/telemetry/telemetry.go`

````go
// Package telemetry builds the process's observability plumbing: the tracer
// provider the HTTP stack starts spans with, and the metrics registry the
// scrape endpoint serves. Both are constructed once, at boot, and handed to
// the parts that use them — the package owns the process-level pieces, and
// the HTTP layer owns what a request contributes to them.
//
// The tracer provider's two modes are the chapter's honest default. Without
// an endpoint it samples nothing: spans are non-recording, no exporter
// goroutine exists, and no batch is ever buffered — but every span still
// carries a real trace id, which is what the request records join on, so
// the logs and the traces line up on a laptop with no collector in sight.
// With an endpoint the OTLP HTTP exporter ships spans in batches, and
// Shutdown flushes the last batch before the process leaves.
package telemetry

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
)

// ServiceName is the service.name every span this process exports carries.
// It is a constant rather than an environment variable: one binary, one
// service, and a trace backend that has to guess which process a span came
// from is a backend nobody can query.
const ServiceName = "todo-server"

// defaultTracesPath is the OTLP/HTTP signal path for traces: the path the
// standard environment variable's endpoint reaches, and the one a
// path-less endpoint is given here.
const defaultTracesPath = "/v1/traces"

// NewTracerProvider builds the trace pipeline. An empty endpoint means
// export is off: the provider samples nothing (NeverSample), so no span is
// ever recorded or buffered and no exporter goroutine exists — while every
// span still gets a real trace id, which is what the request records join
// the signals on. A non-empty endpoint is the OTLP HTTP collector's base
// URL, spans are batched to it, and the batch processor is what Shutdown
// flushes, so a caller that cares about the last spans calls Shutdown
// before exiting.
func NewTracerProvider(ctx context.Context, endpoint string, logger *slog.Logger) (*sdktrace.TracerProvider, error) {
	if endpoint == "" {
		return sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample())), nil
	}

	// The endpoint is validated here, so a typo is a boot error rather than
	// a failed export every batch. A URL with no path — or the root — gets
	// the signal path appended: the SDK's WithEndpointURL option takes a
	// URL as given (a path-less one targets / on purpose), while its own
	// OTEL_EXPORTER_OTLP_ENDPOINT handling appends /v1/traces. The option
	// and the environment variable should not disagree about where spans
	// go, so the conventional http://collector:4318 reaches /v1/traces,
	// and a collector behind a prefix is spelled with the prefix in the
	// URL.
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("telemetry: endpoint %q: want a URL with scheme and host, like http://collector:4318", endpoint)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = defaultTracesPath
	}

	// The endpoint's scheme decides transport security: http is plain,
	// anything else is TLS. The URL is passed as given — the exporter's own
	// environment reading is bypassed, so the one source of "where does
	// telemetry go" is this process's configuration.
	exp, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(u.String()))
	if err != nil {
		return nil, fmt.Errorf("telemetry: OTLP exporter: %w", err)
	}

	// The SDK's own failures — a collector that is away, a batch that cannot
	// be sent — go through the process logger instead of the standard
	// library's stderr, so chapter 29's rule (stderr carries structured
	// records, nothing else) holds even when telemetry is the thing failing.
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		logger.Error("telemetry export failed", "err", err)
	}))

	return sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(ServiceName),
		)),
	), nil
}

// NewRegistry builds the metrics registry the scrape endpoint serves: the
// Go runtime's own collectors — the GC's cost, the heap, the goroutines —
// and the process collector, which is where RSS comes from. The HTTP layer
// registers its request metrics on top. A fresh registry per server, never
// the package-global default: what a scrape exposes is exactly what this
// process registered, and a test can build one without touching global
// state.
func NewRegistry() *prometheus.Registry {
	reg := prometheus.NewRegistry()
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return reg
}
````


## `internal/telemetry/telemetry_test.go`

````go
// Package telemetry_test exercises the two constructors over real
// collaborators: for the export path, an httptest server stands in for the
// collector, and the assertions are what the collector received and when.
package telemetry_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/telemetry"
)

// discardLogger is the tests' logger: the SDK's error handler would write to
// it, and nothing under test is expected to fail.
func discardLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// TestTracerProvider_OffMode pins the default: with no endpoint nothing is
// exported — and nothing needs to be — but a span still carries a real,
// valid trace id, which is the id the request records join on. This is the
// mode a laptop and a test run live in.
func TestTracerProvider_OffMode(t *testing.T) {
	t.Parallel()

	tp, err := telemetry.NewTracerProvider(context.Background(), "", discardLogger())
	require.NoError(t, err)
	defer func() { require.NoError(t, tp.Shutdown(context.Background())) }()

	_, span := tp.Tracer("telemetry-test").Start(context.Background(), "op")
	defer span.End()

	assert.True(t, span.SpanContext().IsValid(), "a non-recording span still carries a trace id")
	assert.False(t, span.IsRecording(), "the off mode records nothing")
	assert.False(t, span.SpanContext().IsSampled(), "nothing is sampled for export")
}

// TestTracerProvider_ExportAndFlush pins the export path end to end: a span
// ended milliseconds ago is still in the batch processor when Shutdown is
// called, and Shutdown is what ships it — the flush the process's shutdown
// relies on. The collector records the path and the size of what it
// received: a path-less endpoint must arrive at the signal path,
// /v1/traces, like the standard environment variable's endpoint would.
func TestTracerProvider_ExportAndFlush(t *testing.T) {
	t.Parallel()

	var (
		mu    sync.Mutex
		paths []string
		sizes []int
	)
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		mu.Lock()
		paths = append(paths, r.URL.Path)
		sizes = append(sizes, len(body))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer collector.Close()

	tp, err := telemetry.NewTracerProvider(context.Background(), collector.URL, discardLogger())
	require.NoError(t, err)

	_, span := tp.Tracer("telemetry-test").Start(context.Background(), "op")
	span.End()

	// No wait: the batch timer is five seconds, and this call is what ships
	// the span.
	require.NoError(t, tp.Shutdown(context.Background()))

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []string{"/v1/traces"}, paths, "a path-less endpoint gets the signal path")
	require.Positive(t, sizes[0], "the batch carries the span")
}

// TestTracerProvider_BadEndpoint pins the boot-time check: an endpoint that
// is not a URL is an error at construction, not a per-batch failure in the
// log — a typo should stop the process, not cost a failed export every five
// seconds.
func TestTracerProvider_BadEndpoint(t *testing.T) {
	t.Parallel()

	_, err := telemetry.NewTracerProvider(context.Background(), "collector:4318", discardLogger())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "collector:4318")
}
````
