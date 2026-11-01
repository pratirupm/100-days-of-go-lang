---
title: Splitting the app
day: 79
time: "3 hours"
description: Find the seam where a read model can leave the monolith, run it beside the API, and route one feature to it.
sidebar:
  order: 66
---

A monolith is not a mistake. One binary, one database, one deploy is the
cheapest shape until one part needs to scale, fail, or change on a different
schedule. A **service boundary** is useful when those needs differ on each
side of it.

The activity feed is a good first seam. It is a read model: the API writes
tasks, and the feed shows what changed. The feed can be rebuilt from events,
it does not own the task rows, and a slow feed should not slow a write. That
is a boundary with a reason.

Today we run the feed as its own HTTP service beside the API. It keeps its
events in memory and accepts them over POST for now; later the input becomes
a Kafka topic.

## The seam

The API owns tasks: validation, ownership, versions, the database. The
activity service owns the question "what happened recently?" It has its own
event shape and its own store. It does not read the tasks table; it receives
the changes it needs.

That last sentence is the boundary. If the activity service queried the tasks
table directly, it would be a second client of the monolith's database, and
the schema would become a shared contract with two owners. Events keep the
ownership one-way.

## The service

The service starts with a small in-memory store. An event has an id, the task
it belongs to, a kind, a title, and a time:

<!-- verify: internal/activity/activity.go at=microservices -->
```go title="internal/activity/activity.go"
type Event struct {
	ID     string    `json:"id"`
	TaskID string    `json:"task_id"`
	Kind   string    `json:"kind"`
	Title  string    `json:"title"`
	At     time.Time `json:"at"`
}
```

`List` returns the newest events first. The store keeps insertion order and
walks backward, so the handler does not sort on every request. A limit of
zero means "everything"; the HTTP handler asks for fifty.

The service's main is deliberately plain: a mux, three handlers, a graceful
shutdown.

<!-- verify: cmd/todo-activity/main.go at=microservices -->
```go title="cmd/todo-activity/main.go"
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /activity", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(store.List(50))
	})
```

The POST handler validates the required fields and fills in `At` when the
producer did not. The service is permissive about the title and kind; the
producer is expected to send meaningful values. A real boundary would define
an enum and reject unknown kinds; this lesson keeps the first version small.

## Run it

Start the service on a local port:

```bash
$ go run ./cmd/todo-activity -listen 127.0.0.1:18087
2026/10/31 15:12:11 INFO activity listening addr=127.0.0.1:18087
```

Ask for health:

```bash
$ curl -sS http://127.0.0.1:18087/healthz
{"status":"ok"}
```

Post an event:

```bash
$ curl -sS -i -X POST http://127.0.0.1:18087/activity -H 'Content-Type: application/json' -d '{"id":"evt-2","task_id":"t-2","kind":"completed","title":"ship the service"}'
HTTP/1.1 201 Created
Date: Sat, 31 Oct 2026 09:42:22 GMT
Content-Length: 0
```

Read the feed:

```bash
$ curl -sS http://127.0.0.1:18087/activity
[{"id":"evt-2","task_id":"t-2","kind":"completed","title":"ship the service","at":"2026-10-31T09:42:22.235146235Z"},{"id":"evt-1","task_id":"t-1","kind":"created","title":"write the activity service","at":"2026-10-31T09:42:13.517592466Z"}]
```

The newest event is first. The JSON is the boundary's public shape: the API
does not send its internal task struct, and the service does not return one.
A change to the task's columns does not change the feed's contract.

## What is still missing

The input is a POST, not an event stream. A caller can post anything, the
service has no backpressure, and a restart loses the in-memory list. Those
are the next lessons: Kafka for the input, a consumer group for replay, Redis
for the cache, gRPC for typed calls, and WebSockets for live delivery.

The service can run beside the API now. In a real deployment it would have
its own container, its own health check, and its own scaling policy. The
Compose and Kubernetes lessons already show the shape; the service is one
more entry in the same file.

## Data ownership

The service keeps its own list. The API keeps the tasks. Neither reads the
other's tables. That is the ownership rule, and it is what makes the boundary
real: a schema change on one side is not a breaking change on the other.

The price is duplication. The activity event carries the title, so the feed can
render it without calling the API. If the title changes, the old event still
carries the old title; the feed is a history, not a live view. A UI that needs
the current title joins it from the API by task id, or the service subscribes
to a `task.updated` event and updates its projection.

The rule to write down is which side owns the truth for each field. The API
owns the task; the service owns the event. The feed's title is a snapshot at
the time of the event. That is a product decision as much as an architecture
one.

## Deploy independently

The service has its own binary and its own container. It can be deployed while
the API stays on the previous version, as long as the event contract is
compatible. That is the release advantage of the boundary: a feed change does
not require a task API deploy.

The compatibility rule is the same as a database migration: add fields, do not
rename them; accept both shapes during the transition; remove the old one in a
later change. The event is a public contract between two deployables, even when
both are owned by one team.

## The edge is still one API

The browser talks to the API, not to the activity service. The API can call the
service over gRPC and shape the response for the page; the service does not
need a public route. That keeps the public surface small and the internal
contract free to change.

If the service is exposed directly, it needs its own authentication,
authorization, rate limits, and CORS. Reusing the API as the edge is cheaper
and safer until the service has a reason to face the public on its own.

## If something went wrong

- **`address already in use`** — another process has port 18087. Pick a
  different `-listen` value.
- **`404 page not found` on `/activity`** — the method does not match. The
  route is `GET /activity`; a POST to the same path is the other handler.
- **The POST returns 400** — `id`, `task_id`, or `kind` is missing. The error
  body names the decoder's problem; the required-field check is separate.
- **The list is empty after a restart** — the store is in memory. That is
  expected for this version; persistence arrives with the event log.

<details>
<summary>Going deeper: a service is a failure boundary, not a folder</summary>

Splitting code into packages does not create a service. A service has its own
process, its own deployment, and its own failure modes. The activity service
can crash without taking the API down; the API can write tasks while the feed
is unavailable. That independence is the point, and it is also the cost: two
things to deploy, monitor, and secure.

The boundary should follow a change that needs independence. The activity
feed qualifies because it is a read model with a different query pattern and
a different freshness requirement. Splitting the auth check would not: every
request needs it, and a network hop would add latency to every write. Choose
the seam by the failure you want to isolate, not by the folder you want to
create.

</details>

The service has a boundary and a shape. Next we give it a typed contract so
the API can call it without learning JSON by hand.
