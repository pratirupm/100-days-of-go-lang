---
title: Live updates
day: 84
time: "3 hours"
description: Push task changes to a connected browser over WebSockets, and keep slow readers from blocking the room.
sidebar:
  order: 71
---

The feed is pull-based: a browser asks, the server answers, the browser asks
again. Polling works, but it is either slow (long intervals) or wasteful
(short intervals). A **WebSocket** keeps one connection open and lets either
side send a message at any time.

The upgrade starts as HTTP. The client sends an `Upgrade: websocket` header,
the server answers `101 Switching Protocols`, and the same TCP connection
becomes a message stream. After that, frames are small and the server can push
without a request.

Today the activity service broadcasts each new event to every connected
client.

## The hub

The service keeps a slice of connections and a mutex. Broadcasting marshals
the event once and writes it to each connection:

<!-- verify: cmd/todo-activity/main.go at=websockets -->
```go title="cmd/todo-activity/main.go"
	var wsMu sync.Mutex
	var wsConns []*websocket.Conn
	broadcast := func(e activity.Event) {
		body, err := json.Marshal(e)
		if err != nil {
			return
		}
		wsMu.Lock()
		defer wsMu.Unlock()
		for _, c := range wsConns {
			_ = c.Write(context.Background(), websocket.MessageText, body)
		}
	}
```

This is the smallest useful hub. It writes synchronously while holding the
lock, so one slow client can delay the others. That is fine for a few local
connections and wrong for a room of thousands. The production shape is a
per-client send channel with a bounded buffer and a writer goroutine; a client
that cannot keep up is dropped, not allowed to block the broadcaster.

`context.Background()` on the write is another simplification. A real write
uses a short timeout, so a dead connection does not hold the lock forever.

## The upgrade

The handler accepts the connection and registers it:

<!-- verify: cmd/todo-activity/main.go at=websockets -->
```go title="cmd/todo-activity/main.go"
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		wsMu.Lock()
		wsConns = append(wsConns, c)
		wsMu.Unlock()
		defer func() {
			wsMu.Lock()
			for i, conn := range wsConns {
				if conn == c {
					wsConns = append(wsConns[:i], wsConns[i+1:]...)
					break
				}
			}
			wsMu.Unlock()
			_ = c.Close(websocket.StatusNormalClosure, "")
		}()
		for {
			if _, _, err := c.Read(context.Background()); err != nil {
				return
			}
		}
	})
```

`InsecureSkipVerify` disables the library's origin check. That is acceptable
for a local demo and wrong for a browser-facing service: a WebSocket is not
protected by the same-origin policy once it is open, so the server must check
`Origin` against an allowlist. The book's API already owns CORS and CSRF; the
socket needs its own decision.

The read loop exists to notice a disconnect. The client is not expected to
send application messages; the read returns an error when the connection
closes, and the deferred cleanup removes it from the hub.

## Broadcast on write

Every path that adds an event calls the same broadcast:

<!-- verify: cmd/todo-activity/main.go at=websockets -->
```go title="cmd/todo-activity/main.go"
		store.Add(e)
		invalidateCache(r.Context(), rdb)
		broadcast(e)
		w.WriteHeader(http.StatusCreated)
```

The Kafka consumer does the same after its idempotency check. The order is
store, invalidate, broadcast. A client that receives the event and immediately
reads the feed sees the new row, because the cache was invalidated first. A
broadcast before the store write would race the read.

## Try it

Start the service:

```bash
$ go run ./cmd/todo-activity -listen 127.0.0.1:18091 -grpc 127.0.0.1:19094
2026/10/31 15:19:11 INFO activity gRPC listening addr=127.0.0.1:19094
2026/10/31 15:19:11 INFO activity listening addr=127.0.0.1:18091
```

Connect a client:

```bash
$ go run ./cmd/wsclient -url ws://127.0.0.1:18091/ws
```

In another terminal, post an event:

```bash
$ curl -sS -X POST http://127.0.0.1:18091/activity -H 'Content-Type: application/json' -d '{"id":"evt-ws-1","task_id":"t-ws","kind":"completed","title":"push the change"}'
...
```

The client prints the pushed event and exits:

```text
{"id":"evt-ws-1","task_id":"t-ws","kind":"completed","title":"push the change","at":"2026-10-31T09:49:14.193834359Z"}
```

The client was connected before the POST. That is the whole difference from
polling: the server initiated the message.

## Reconnect and slow readers

A WebSocket can close for many reasons: a laptop sleeps, a proxy times out, a
deploy replaces the server. The client should reconnect with backoff and
resume from a cursor — the last event id it saw — rather than assume it missed
nothing. The server can keep a short replay buffer, or the client can read the
feed after reconnecting and merge by id.

A slow reader is the other failure. With a synchronous broadcast, one client
that stops reading can block the loop. The bounded-channel design fixes it:
each client has a buffer; when it is full, the server closes that client with
a policy error. A dropped client can reconnect and catch up; a blocked server
cannot serve anyone.

## Heartbeats and idle proxies

A WebSocket is a long-lived TCP connection, and the network between the client
and the server may not know that. A load balancer with a sixty-second idle
timeout closes a connection that has been quiet; the client sees a close and
must reconnect.

A heartbeat is a small ping every thirty seconds. The server can send a
protocol-level ping, or the application can send a `{"type":"ping"}` message
that the client ignores. The first is cheaper; the second is visible in the
logs and works through proxies that strip control frames.

The reconnect is the client's job. It should back off, reset the backoff on a
successful connection, and resume from the last event id it saw. A client that
reconnects and starts from "now" silently loses the events during the gap; a
client that reconnects and replays from its cursor can catch up.

## The socket is a second API

Every message the server pushes is data leaving the process. It needs the same
authorization as the read endpoint: only a signed-in user should receive that
user's events. The local hub broadcasts every event to every connection, which
is fine for a single-user demo and wrong for a multi-user feed.

The fix is a room per user or per tenant, keyed from the session, and a check
before the write. The origin check is the first test; the session check is the
second. A socket that passes the first and skips the second is a public feed.

## If something went wrong

- **The handshake returns 403** — the origin check rejected the request.
  Configure the allowlist; do not disable it in production.
- **The client connects but receives nothing** — the broadcast path is not
  called, or the write is blocked. Check the store and cache order first.
- **The connection closes after a minute** — a proxy or load balancer has an
  idle timeout. Send a ping or a heartbeat, or raise the timeout.
- **One client stops all updates** — the broadcast is synchronous. Move to a
  per-client queue with a bounded buffer.

<details>
<summary>Going deeper: WebSockets versus server-sent events</summary>

Server-sent events (SSE) are one-way: the server pushes text over a normal
HTTP response. They reconnect automatically and pass through more proxies than
WebSockets. WebSockets are bidirectional and binary-capable, but need an
upgrade and a heartbeat.

For a feed where the server is the only sender, SSE is often enough. The book
uses WebSockets because the activity service will eventually accept client
messages — marking a notification read, for example. Choose by the direction
you need, not by the newer protocol.

</details>

The feed is live now. The next part makes the whole system survive failures:
retries, idempotency, and the ordering guarantees the log only partly gives.
