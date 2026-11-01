---
title: Observability at scale
day: 87
time: "3 hours"
description: Turn the activity service's counters into a Prometheus scrape, a dashboard query, and an alert that pages only when it should.
sidebar:
  order: 73
---

The activity service logs a line when it starts. That is enough to know it
started and not enough to know whether it is keeping up. **Observability** is
the ability to answer a question you did not know you would ask: how many
events, how fast, how many failed, which kind is stuck.

Metrics are the cheapest layer. A **counter** only goes up; a **gauge** goes
up and down; a **histogram** buckets observations. Prometheus **scrapes** an
HTTP endpoint every few seconds and stores the samples. A query language turns
the samples into a rate, a ratio, or an alert.

Today the activity service exposes one counter and Prometheus scrapes it.

## The counter

The counter has one label, `kind`, because that is the question the dashboard
asks: which events are arriving?

<!-- verify: cmd/todo-activity/main.go at=observability-scale -->
```go title="cmd/todo-activity/main.go"
var activityEvents = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "activity_events_total",
	Help: "Events accepted by the activity service, by kind.",
}, []string{"kind"})
```

The metric name follows the convention: a unit suffix (`_total`) and a
namespace (`activity_`). The label is bounded — `created`, `completed`, and
whatever kinds the producer defines. A label with an unbounded value (a task
id, a user id, a raw error string) creates a new time series per value and is
the classic way to melt a Prometheus server. Labels are for dimensions you
would group by, not for identities.

The handler exports the registry:

<!-- verify: cmd/todo-activity/main.go at=observability-scale -->
```go title="cmd/todo-activity/main.go"
	mux.Handle("GET /metrics", promhttp.Handler())
```

`promhttp.Handler()` serves the default registry in the text exposition
format. The counter is registered in `init`; the app's own metrics registry is
separate because this is a separate process.

## Scrape it

Prometheus reads a config with one job:

<!-- verify: deploy/observability/prometheus.yml at=observability-scale -->
```yaml title="deploy/observability/prometheus.yml"
global:
  scrape_interval: 5s

scrape_configs:
  - job_name: activity
    static_configs:
      - targets: ["127.0.0.1:18092"]
```

`scrape_interval` is the resolution of every rate query. A five-second
interval is fine for a local demo; a production scrape is often fifteen or
thirty seconds, because the cost is on the target and the server.

Start the service and Prometheus, then post two events:

```bash
$ curl -sS http://127.0.0.1:18092/metrics | grep '^activity_events_total'
activity_events_total{kind="completed"} 1
activity_events_total{kind="created"} 1
```

The raw endpoint is already useful: a counter and its labels. Prometheus turns
it into history:

```bash
$ curl -sS 'http://127.0.0.1:19090/api/v1/targets' | jq -c '.data.activeTargets[] | {scrapeUrl,health,lastError,lastScrape}'
{"scrapeUrl":"http://127.0.0.1:18092/metrics","health":"up","lastError":"","lastScrape":"2026-10-31T09:51:24.942785052Z"}
```

`health: up` is the first alert: the target is reachable. A target that is
down is not the same as a service that is healthy but slow; both matter, and
they are different queries.

Query the counter:

```bash
$ curl -sS 'http://127.0.0.1:19090/api/v1/query?query=activity_events_total' | jq -c '.data.result[] | {kind:.metric.kind,value:.value[1]}'
{"kind":"completed","value":"1"}
{"kind":"created","value":"1"}
```

The value is a string because Prometheus stores samples as floats and the HTTP
API preserves the text form. A counter is cumulative; `1` means one event
since the process started, not one per second.

## Rates and alerts

A dashboard usually wants a rate:

```promql
sum(rate(activity_events_total[1m])) by (kind)
```

`rate` divides the increase over the window by the window's seconds. It needs
at least two samples, so a one-minute window with a five-second scrape has
twelve samples. A rate over a window shorter than the scrape interval is
noise.

An alert is a query with a duration:

```promql
sum(rate(activity_events_total[5m])) == 0
for: 10m
```

That fires when no events arrive for ten minutes. It is a useful alert only if
zero is abnormal; at night it may be normal. The alert's `for` is the
difference between a blip and an incident.

The other useful alert is the consumer lag, which the service does not export
yet: `kafka_consumergroup_lag` from the Kafka exporter, or a gauge the service
sets from the reader's stats. A feed that receives events but never projects
them is healthy by the event counter and broken by the lag.

## Logs, metrics, traces

Metrics tell you that something changed; logs tell you which request; traces
tell you where the time went. The app already emits traces and Prometheus
metrics; the activity service is a new process and needs its own scrape and
its own log correlation.

The request id is the join key. The HTTP handler should put it in the log and
the response; the gRPC interceptor should do the same. Without a join key, the
three signals are three separate stories.

## A cardinality budget

Every label value multiplies the number of time series. A counter with a
`kind` label of five values is five series; a counter with a `task_id` label is
one series per task, forever. The second is how a Prometheus server runs out of
memory.

The budget is a design constraint: labels are dimensions you would put in a
`GROUP BY`, not identities. If a value is unique per request, it belongs in a
log or a trace, not a metric. If you need to find one slow task, a trace has
the id; the metric only needs the count.

The same rule applies to histograms. A histogram with too many buckets or too
many label combinations is a cardinality problem with a friendlier name. Pick
the buckets from the SLO, not from a default that covers every possible
latency.

## Alert fatigue is a failure

An alert that fires every night and is acknowledged without action trains the
team to ignore the pager. The `for:` duration, the threshold, and the routing
are part of the alert's design, not an afterthought. A page should mean a
human is needed now; a ticket can wait until morning.

The activity counter is a traffic signal, not a page. The page is the consumer
lag or the error rate. The dashboard can show all three; the pager gets the one
that means the feed is broken.

## A dashboard is a question

A dashboard with twenty panels is a wall, not an answer. Start with the four
golden signals and one question: is the feed healthy? The panels that answer it
stay; the rest are links to a deeper view.

The query and the panel should name the same thing the alert names. A dashboard
that shows a different rate window than the page is a source of arguments
during an incident. One definition, reused, is the goal.

## If something went wrong

- **`/metrics` returns 404** — the handler is registered on a different mux or
  the path is wrong. Check the route and the port.
- **Prometheus target is down** — the address is wrong or the service is not
  listening. `curl` the target from the Prometheus container; `localhost`
  inside a container is the container, not the host.
- **The query returns no data** — the metric name or label changed, or the
  scrape has not run twice yet. Check `/api/v1/targets` and the raw endpoint.
- **Cardinality explodes** — a label has an unbounded value. Remove it or
  aggregate before it reaches the counter.

<details>
<summary>Going deeper: the four golden signals</summary>

Latency, traffic, errors, and saturation. Every service dashboard starts with
those four. Latency is a distribution, not an average; traffic is requests or
events per second; errors are a rate, not a count; saturation is queue depth,
CPU, memory, or connection pool usage.

The activity counter is traffic. The next metric is errors, then latency, then
the consumer lag as saturation. A dashboard with one counter is a start, not
an observability story.

</details>

The system reports what it is doing now. Next we test the boundaries that the
reports cannot see: the contracts between the services.
