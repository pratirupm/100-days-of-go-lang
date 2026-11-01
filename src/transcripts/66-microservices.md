# Chapter 66 — splitting the app

```text
$ go run ./cmd/todo-activity -listen 127.0.0.1:18087
2026/10/31 15:12:11 INFO activity listening addr=127.0.0.1:18087

$ curl -sS http://127.0.0.1:18087/healthz
{"status":"ok"}

$ curl -sS -i -X POST http://127.0.0.1:18087/activity -H 'Content-Type: application/json' -d '{"id":"evt-2","task_id":"t-2","kind":"completed","title":"ship the service"}'
HTTP/1.1 201 Created
Date: Sat, 31 Oct 2026 09:42:22 GMT
Content-Length: 0

$ curl -sS http://127.0.0.1:18087/activity
[{"id":"evt-2","task_id":"t-2","kind":"completed","title":"ship the service","at":"2026-10-31T09:42:22.235146235Z"},{"id":"evt-1","task_id":"t-1","kind":"created","title":"write the activity service","at":"2026-10-31T09:42:13.517592466Z"}]
```
