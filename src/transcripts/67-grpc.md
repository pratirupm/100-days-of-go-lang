# Chapter 67 — typed calls

```text
$ curl -sS -b /tmp/grpc-cookies.txt 'http://127.0.0.1:18097/api/v1/activity?limit=1'
{"events":[{"id":"01a19aa6-00bf-7e43-96fe-effa4cdc08d8","task_id":"01a19aa6-00ba-763b-9428-43dcfb47b56e","kind":"created","title":"api reads grpc","at":"2026-11-02T05:05:32Z"}]}
$ buf generate
...
$ ls internal/activitypb
activity.pb.go
activity_grpc.pb.go
$ go run ./cmd/todo-activity -listen 127.0.0.1:18088 -grpc 127.0.0.1:19090
2026/10/31 15:13:24 INFO activity gRPC listening addr=127.0.0.1:19090
2026/10/31 15:13:24 INFO activity listening addr=127.0.0.1:18088

$ curl -sS -X POST http://127.0.0.1:18088/activity -H 'Content-Type: application/json' -d '{"id":"evt-4","task_id":"t-4","kind":"created","title":"call it over gRPC"}'
...
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
