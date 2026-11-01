# Chapter 61 — the production database

```text
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
