# Chapter 61 — the production database

```text
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' TODO_ADMIN_EMAIL=admin@example.com TODO_ADMIN_KEY=local-admin-key TODO_LISTEN=127.0.0.1:18096 TODO_LOG=/tmp/todo-pg.log go run ./cmd/todo-server
...
{"time":"2026-11-02T10:26:46.874486458+05:30","level":"INFO","msg":"store ready","driver":"postgres"}
{"time":"2026-11-02T10:26:46.907514941+05:30","level":"INFO","msg":"server listening","addr":"127.0.0.1:18096","version":"dev"}

$ podman run -d --name todo-postgres -p 15432:5432 -e POSTGRES_USER=todo -e POSTGRES_PASSWORD=todo -e POSTGRES_DB=todo docker.io/library/postgres:17-alpine
...
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go test -count=1 ./internal/store/postgres -v
=== RUN   TestPostgresConformance
...
--- PASS: TestPostgresConformance (1.03s)
    --- PASS: TestPostgresConformance/AddAndList (0.06s)
...
PASS
ok  	todo/internal/store/postgres	1.035s
```
