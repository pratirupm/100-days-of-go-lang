# Chapter 70 — caching and limits

```text
key = "rate:" + client + ":" + minute
n = INCR key
if n == 1: EXPIRE key 60
if n > limit: reject 429
$ podman run -d --name todo-redis -p 16379:6379 redis:7-alpine
...
$ go run ./cmd/todo-activity -listen 127.0.0.1:18090 -grpc 127.0.0.1:19093 -redis 127.0.0.1:16379
2026/10/31 15:18:10 INFO activity gRPC listening addr=127.0.0.1:19093
2026/10/31 15:18:10 INFO activity listening addr=127.0.0.1:18090

$ curl -sS -X POST http://127.0.0.1:18090/activity -H 'Content-Type: application/json' -d '{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed"}'
...
$ curl -sS http://127.0.0.1:18090/activity
[{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed","at":"2026-10-31T09:48:10.93603558Z"}]
$ curl -sS http://127.0.0.1:18090/activity
[{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed","at":"2026-10-31T09:48:10.93603558Z"}]

$ podman exec todo-redis redis-cli GET activity:latest
[{"id":"evt-redis-1","task_id":"t-r1","kind":"created","title":"cache the feed","at":"2026-10-31T09:48:10.93603558Z"}]
$ podman exec todo-redis redis-cli TTL activity:latest
5

$ TODO_REDIS_ADDR=127.0.0.1:16379 go test -run TestAllow -v ./internal/activity
=== RUN   TestAllowFixedWindow
--- PASS: TestAllowFixedWindow (0.00s)
PASS
ok  	todo/internal/activity	0.005s
```
