# Chapter 69 — consumers and replay

```text
$ go run ./cmd/todo-activity -listen 127.0.0.1:18089 -grpc 127.0.0.1:19091 -kafka 127.0.0.1:19092
2026/10/31 15:16:39 INFO activity gRPC listening addr=127.0.0.1:19091
2026/10/31 15:16:39 INFO activity listening addr=127.0.0.1:18089

$ go run ./cmd/todo-event -brokers 127.0.0.1:19092 -topic todo.events -id evt-k3 -task t-k3 -kind created -title "consume the event"
published evt-k3 to todo.events
$ go run ./cmd/todo-event -brokers 127.0.0.1:19092 -topic todo.events -id evt-k3 -task t-k3 -kind created -title "consume the event"
published evt-k3 to todo.events

$ curl -sS http://127.0.0.1:18089/activity
[{"id":"evt-k3","task_id":"t-k3","kind":"created","title":"consume the event","at":"2026-10-31T09:46:41.581348685Z"},{"id":"evt-k2","task_id":"t-k2","kind":"created","title":"publish the event","at":"2026-10-31T09:45:44.747498153Z"}]

$ podman exec todo-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server todo-kafka:9092 --group activity --topic todo.events --reset-offsets --to-earliest --execute
GROUP                          TOPIC                          PARTITION  NEW-OFFSET
activity                       todo.events                    0          0

$ podman exec todo-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server todo-kafka:9092 --group activity --describe

Consumer group 'activity' has no active members.

GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG             CONSUMER-ID     HOST            CLIENT-ID
activity        todo.events     0          0               3               3               -               -               -
```
