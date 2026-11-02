---
title: "Day 80 — Typed calls"
description: "Define the activity service in a proto file, generate Go stubs, and call it with a deadline and a typed error path. — Day 80 of 100 Days of Go Lang."
sidebar:
  order: 80
chapter: 67
style: production
---

**About 3 hours** · Part XIV, day 2 of 6.

**You'll be able to:**

- define the service in a proto file and generate the Go stubs;
- call it with a deadline and map its errors back to HTTP.

---

The activity service speaks JSON over HTTP. That is fine for a browser, but a
service-to-service call usually wants a stronger contract: a schema, generated
clients, and a compiler that catches a renamed field before a request does.

**gRPC** is that contract. A `.proto` file defines the messages and the
methods; `protoc` and its Go plugins generate the client and server stubs. The
wire format is protobuf, which is smaller and faster than JSON, but the real
win is the schema.

Today we give the activity service a gRPC contract and call it with
`grpcurl`.

## The contract

The proto file is the source of truth. It names the package, the service, and
the messages:

<!-- verify: proto/activity.proto at=grpc -->
```proto title="proto/activity.proto"
syntax = "proto3";

package activity.v1;

option go_package = "todo/internal/activitypb";

// Activity is the read model's typed contract.
service Activity {
  rpc List(ListRequest) returns (ListResponse);
}

message Event {
  string id = 1;
  string task_id = 2;
  string kind = 3;
  string title = 4;
  int64 at = 5;
}
```

Field numbers are the wire format. `id = 1` means the first field is one
byte on the wire; renaming the field in Go does not change the number, and
changing the number breaks compatibility. Treat the numbers as the contract
and the names as documentation.

`option go_package` tells the Go plugin where to put the generated code. The
package is `activitypb`, beside the service that uses it.

## Generate the stubs

The project uses `buf` as the protobuf toolchain. It reads `buf.yaml` for
the module and `buf.gen.yaml` for the plugins:

<!-- verify: buf.gen.yaml at=grpc -->
```yaml title="buf.gen.yaml"
version: v2
plugins:
  - local: protoc-gen-go
    out: internal/activitypb
    opt:
      - paths=source_relative
  - local: protoc-gen-go-grpc
    out: internal/activitypb
    opt:
      - paths=source_relative
```

Generate:

```bash
$ buf generate
...
$ ls internal/activitypb
activity.pb.go
activity_grpc.pb.go
```

`activity.pb.go` holds the messages; `activity_grpc.pb.go` holds the client,
the server interface, and the registration function. The generated code is
committed, like the sqlc output, so a reader can build without installing
`buf`. The `make generate` target is the one place to regenerate it.

## The server

The service registers the generated server beside its HTTP handler:

<!-- verify: cmd/todo-activity/main.go at=grpc -->
```go title="cmd/todo-activity/main.go"
	grpcServer := grpc.NewServer()
	reflection.Register(grpcServer)
	activitypb.RegisterActivityServer(grpcServer, &activityServer{store: store})
	go func() {
		slog.Info("activity gRPC listening", "addr", *grpcListen)
		if err := grpcServer.Serve(grpcListener); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
```

Reflection is a development convenience: it lets `grpcurl` discover the
service without a local copy of the proto. In production it is often disabled,
because it tells a caller the shape of the API. The API is public here, so
the trade is fine.

The handler maps the store's events to the generated messages:

<!-- verify: cmd/todo-activity/main.go at=grpc -->
```go title="cmd/todo-activity/main.go"
func (s *activityServer) List(_ context.Context, req *activitypb.ListRequest) (*activitypb.ListResponse, error) {
	events := s.store.List(int(req.GetLimit()))
	out := make([]*activitypb.Event, 0, len(events))
	for _, e := range events {
		out = append(out, &activitypb.Event{
			Id:     e.ID,
			TaskId: e.TaskID,
			Kind:   e.Kind,
			Title:  e.Title,
			At:     e.At.Unix(),
		})
	}
	return &activitypb.ListResponse{Events: out}, nil
}
```

The domain type and the wire type stay separate. The handler converts; a
change to the store's internal shape does not automatically change the wire
contract. `GetLimit` returns zero when the field is absent, which the store
treats as "everything"; the HTTP handler caps it at fifty.

## Call it

Start the service with both listeners:

```bash
$ go run ./cmd/todo-activity -listen 127.0.0.1:18088 -grpc 127.0.0.1:19090
2026/10/31 15:13:24 INFO activity gRPC listening addr=127.0.0.1:19090
2026/10/31 15:13:24 INFO activity listening addr=127.0.0.1:18088
```

Post one event through the HTTP side:

```bash
$ curl -sS -X POST http://127.0.0.1:18088/activity -H 'Content-Type: application/json' -d '{"id":"evt-4","task_id":"t-4","kind":"created","title":"call it over gRPC"}'
...
```

Call the gRPC side:

```bash
$ grpcurl -plaintext -d '{"limit":1}' 127.0.0.1:19090 activity.v1.Activity/List
{
  "events": [
    {
      "id": "evt-4",
      "taskId": "t-4",
      "kind": "created",
      "title": "call it over gRPC",
      "at": "1793439824"
    }
  ]
}
```

`at` is a Unix timestamp because the proto field is `int64`, not a string.
The JSON mapping shows camelCase names by default; the wire keeps the field
numbers.

## Deadlines and errors

A real client sets a deadline:

```go
ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
defer cancel()
resp, err := client.List(ctx, &activitypb.ListRequest{Limit: 10})
```

A deadline that expires returns `context.DeadlineExceeded`; a server that
returns an error can attach a gRPC status code, and the client maps it back
to its own error. That is the service-to-service equivalent of an HTTP status:
`codes.NotFound`, `codes.Unavailable`, `codes.InvalidArgument`.

The generated client already handles the connection, the framing, and the
codec. The application owns the deadline and the meaning of the error.

## The API as a client

The API uses the same contract. A small adapter turns the generated client
into the domain events the HTTP layer already understands:

<!-- verify: internal/activity/grpc_client.go at=api-grpc -->
```go title="internal/activity/grpc_client.go"
func (c *GRPCClient) ListActivity(ctx context.Context, limit int) ([]Event, error) {
	if limit < 0 {
		limit = 0
	}
	if limit > 100 {
		limit = 100
	}
	resp, err := c.client.List(ctx, &activitypb.ListRequest{Limit: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("activity list: %w", err)
	}
	events := make([]Event, 0, len(resp.GetEvents()))
	for _, e := range resp.GetEvents() {
		events = append(events, Event{
			ID:     e.GetId(),
			TaskID: e.GetTaskId(),
			Kind:   e.GetKind(),
			Title:  e.GetTitle(),
			At:     time.Unix(e.GetAt(), 0).UTC(),
		})
	}
	return events, nil
}
```

The API route is registered only when `TODO_ACTIVITY_GRPC` names the service:

<!-- verify: internal/api/activity.go at=api-grpc -->
```go title="internal/api/activity.go"
func (s *server) listActivity(c echo.Context) error {
	limit := 50
	if raw := c.QueryParam("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			return badRequest("limit must be between 1 and 100")
		}
		limit = n
	}
	events, err := s.activity.ListActivity(c.Request().Context(), limit)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, "activity service unavailable").SetInternal(err)
	}
	if events == nil {
		events = []activity.Event{}
	}
	return c.JSON(http.StatusOK, map[string]any{"events": events})
}
```

With the service running, `GET /api/v1/activity` returns the feed over gRPC.
The API keeps its HTTP edge, the service keeps its typed contract, and the
client never imports the protobuf types.

```bash
$ curl -sS -b /tmp/grpc-cookies.txt 'http://127.0.0.1:18097/api/v1/activity?limit=1'
{"events":[{"id":"01a19aa6-00bf-7e43-96fe-effa4cdc08d8","task_id":"01a19aa6-00ba-763b-9428-43dcfb47b56e","kind":"created","title":"api reads grpc","at":"2026-11-02T05:05:32Z"}]}
```

## Streaming, when it helps

The contract here is unary: one request, one response. gRPC also supports
server streaming, client streaming, and bidirectional streaming. A feed that
pushes every event could use server streaming instead of a WebSocket, and a
batch import could use client streaming.

Streaming is not automatically better. A stream needs a lifetime, a deadline,
and a reconnect story; the client must handle a half-open connection and a
server that restarts. The unary call is easier to retry and easier to put
behind a load balancer. Start unary and add streaming when the message rate or
the latency budget demands it.

The generated code changes shape when a method becomes streaming: the handler
receives a stream object instead of a request, and the client reads a stream
instead of a response. That is a contract change, so it belongs in a new
method, not a silent edit to the old one.

## Deadlines propagate

A deadline on the client is not automatically a deadline on the server's
downstream calls. The server receives the deadline in the context, and it must
pass a child context to the database, the broker, or the next service. If it
does not, the client times out while the server keeps working.

The rule is one line: derive every downstream context from the request
context. The retry policy uses the same context, so a canceled request stops
retrying. A handler that creates `context.Background()` for a downstream call
breaks both the deadline and the cancellation.

## If something went wrong

- **`buf: command not found`** — install `buf`, or use the committed generated
  files and skip generation.
- **`protoc-gen-go: program not found`** — the plugin is not on `PATH`.
  Install it with `go install google.golang.org/protobuf/cmd/protoc-gen-go@latest`.
- **`server does not support the reflection API`** — the server did not
  register reflection, or the client is pointing at the HTTP port. Use the
  gRPC port and `-plaintext`.
- **`connection refused` on 19090** — the gRPC listener did not start. Check
  the service log; the port may already be in use.

<details>
<summary>Going deeper: gRPC versus REST</summary>

REST with JSON is easy to inspect and works with every browser. gRPC is
compact, typed, and has streaming built in, but it needs a proxy to reach a
browser and a schema to generate clients. A public API often offers both: REST
for browsers and third parties, gRPC for internal service calls.

The contract is the real difference. A proto file is a reviewed interface; a
JSON handler is a convention. When two teams own the two sides, the reviewed
interface is worth the toolchain. When one team owns both, the convention may
be enough. The book uses gRPC here because the activity service is the
service-to-service seam, not the browser's API.

</details>

The service has a typed call now. Next we give it a stream of events, so the
call has something to return.

<div class="day-tracker" data-day="80"></div>
