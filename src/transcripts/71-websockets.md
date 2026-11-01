# Chapter 71 — live updates

```text
$ go run ./cmd/todo-activity -listen 127.0.0.1:18091 -grpc 127.0.0.1:19094
2026/10/31 15:19:11 INFO activity gRPC listening addr=127.0.0.1:19094
2026/10/31 15:19:11 INFO activity listening addr=127.0.0.1:18091

$ go run ./cmd/wsclient -url ws://127.0.0.1:18091/ws
{"id":"evt-ws-1","task_id":"t-ws","kind":"completed","title":"push the change","at":"2026-10-31T09:49:14.193834359Z"}

$ curl -sS -X POST http://127.0.0.1:18091/activity -H 'Content-Type: application/json' -d '{"id":"evt-ws-1","task_id":"t-ws","kind":"completed","title":"push the change"}'
...
```
