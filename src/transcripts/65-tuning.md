# Chapter 65 — tuning under load

```text
for each task:
    SELECT tag FROM task_tags WHERE task_id = $1 ORDER BY tag
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go run ./cmd/pgload -seed 10000 -workers 8 -duration 3s
2026/10/31 15:09:21 goose: no migrations to run. current version: 2
ops=1887 elapsed=3.0s throughput=629/s p50=6.84ms p95=56.569ms p99=87.898ms
```
