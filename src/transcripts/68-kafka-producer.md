# Chapter 68 — events on a log

```text
$ podman exec todo-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server todo-kafka:9092 --list
__consumer_offsets
todo.events

$ go run ./cmd/todo-event -brokers 127.0.0.1:19092 -topic todo.events -id evt-k2 -task t-k2 -kind created -title "publish the event"
published evt-k2 to todo.events

$ podman exec todo-kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server todo-kafka:9092 --topic todo.events --from-beginning --max-messages 1 --timeout-ms 10000
{"id":"evt-k2","task_id":"t-k2","kind":"created","title":"publish the event","at":"2026-10-31T09:45:44.747498153Z"}
Processed a total of 1 messages
```
