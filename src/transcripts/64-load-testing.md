# Chapter 64 — load testing

```text
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go run ./cmd/pgload -seed 10000 -workers 8 -duration 3s
2026/10/31 15:07:38 OK   00001_init.sql (6.89ms)
2026/10/31 15:07:38 OK   00002_status_index.sql (4.44ms)
2026/10/31 15:07:38 goose: successfully migrated database to version: 2
ops=939 elapsed=3.0s throughput=313/s p50=6.519ms p95=15.153ms p99=199.475ms

$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go run ./cmd/pgload -seed 10000 -workers 32 -duration 3s
...
```
