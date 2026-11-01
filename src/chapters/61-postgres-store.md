---
title: The production database
day: 73
time: "3 hours"
description: Run the store conformance suite against PostgreSQL and see exactly what a production swap requires.
sidebar:
  order: 61
---

The app has stored its tasks in Turso since the database days. Turso is a
real database, but it is embedded: one file, one process, no separate server
to back up, replicate, or fail over. A production deployment usually wants a
database that lives on its own machine and speaks over the network.

**PostgreSQL** is that database. The point of the store interface was to make
this swap a package, not a rewrite. The interface already says what the rest
of the app needs: add, get, list, filter, count, sort, complete, update,
delete, and stats, all scoped to an owner and all compare-and-swap on the
version.

Today we add a PostgreSQL implementation and run the same conformance suite
against it.

## The schema

The PostgreSQL schema mirrors the tables the app already has: tasks, their
labels, and the users that own them.

<!-- verify: internal/store/postgres/schema.sql at=postgres-store -->
```sql title="internal/store/postgres/schema.sql"
CREATE TABLE IF NOT EXISTS tasks (
    id       TEXT PRIMARY KEY,
    title    TEXT NOT NULL,
    status   TEXT NOT NULL,
    priority INTEGER NOT NULL,
    due      TEXT,
    version  INTEGER NOT NULL DEFAULT 1,
    owner_id TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
);

CREATE INDEX IF NOT EXISTS tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS task_tags_tag ON task_tags(tag);
```

The ids are text because the app generates UUIDv7 values and stores their
canonical form. The due date is text because it is a calendar date, not an
instant; the app already writes RFC 3339. The version is the
compare-and-swap column. `owner_id` is nullable: NULL is the user-less scope
the CLI uses, and a user id is the API's scope.

The two indexes are the access paths the queries need. They are the same
ones the Turso schema ended with, and the next lesson measures them.

## The constructor

The PostgreSQL store lives in its own package. It imports the store contract
and depends on it; the contract does not know PostgreSQL exists.

<!-- verify: internal/store/postgres/postgres.go at=postgres-store -->
```go title="internal/store/postgres/postgres.go"
func New(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres store: %w", err)
	}
	db.SetMaxOpenConns(8)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open postgres store: %w", err)
	}
	if _, err := db.ExecContext(ctx, schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open postgres store: apply schema: %w", err)
	}
	return &Store{db: db}, nil
}
```

`sql.Open` does not connect; `PingContext` does. The schema is embedded in the
package, so an import cannot forget it. `SetMaxOpenConns(8)` matches the
Turso store's pool size: enough for concurrent readers and writers, small
enough to notice a leak.

`Scoped` returns a view over the same handle:

<!-- verify: internal/store/postgres/postgres.go at=postgres-store -->
```go title="internal/store/postgres/postgres.go"
func (s *Store) Scoped(owner uuid.UUID) store.Store {
	return &Store{db: s.db, owner: owner}
}
```

Closing a view would close the handle every other view uses, so `Close`
belongs to the store that opened it. The same rule the Turso store documents.

## The write path

`Add` writes the task and its labels in one transaction. A failure between the
two inserts rolls both back, so no task loses its labels.

<!-- verify: internal/store/postgres/postgres.go at=postgres-store -->
```go title="internal/store/postgres/postgres.go"
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO tasks (id, title, status, priority, due, version, owner_id)
		 VALUES ($1, $2, $3, $4, $5, 1, $6)`,
		id.String(), t.Title, string(t.Status), int(t.Priority), dueValue(t.Due), ownerValue(s.owner),
	); err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
```

PostgreSQL uses `$1` placeholders; SQLite uses `?`. That is the kind of
difference the package boundary absorbs. The `ownerValue` helper returns nil
for `uuid.Nil` and the canonical text otherwise, so the nullable column and
the scope agree.

The compare-and-swap writes are one statement each:

<!-- verify: internal/store/postgres/postgres.go at=postgres-store -->
```go title="internal/store/postgres/postgres.go"
	res, err := s.db.ExecContext(ctx,
		`UPDATE tasks SET status = $1, version = version + 1
		 WHERE id = $2 AND version = $3 AND owner_id IS NOT DISTINCT FROM $4`,
		string(task.StatusDone), id.String(), version, ownerValue(s.owner))
```

`IS NOT DISTINCT FROM` is PostgreSQL's null-safe equality. It makes NULL
match NULL, so the user-less scope reads its own rows and a user id reads
only that user's. A zero-row update is classified by a probe: missing is
`ErrNotFound`, present-but-stale is `ErrConflict`. That is the same contract
the other stores keep.

## Run the suite

Start PostgreSQL:

```bash
$ podman run -d --name todo-postgres -p 15432:5432 -e POSTGRES_USER=todo -e POSTGRES_PASSWORD=todo -e POSTGRES_DB=todo docker.io/library/postgres:17-alpine
...
```

Run the conformance test with the DSN:

```bash
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go test -count=1 ./internal/store/postgres -v
=== RUN   TestPostgresConformance
...
--- PASS: TestPostgresConformance (1.03s)
    --- PASS: TestPostgresConformance/AddAndList (0.06s)
...
PASS
ok  	todo/internal/store/postgres	1.035s
```

The suite is the same one the memory and Turso stores run: add and list,
complete, stale versions, missing tasks, update and delete, status and label
filters, counts, labels, due sorting, stats, scoped visibility, foreign writes,
canceled contexts. A failure names the implementation and the case, so the
three stores are held to one contract by one set of assertions.

The test skips when `TODO_POSTGRES_DSN` is unset. That keeps `go test ./...`
green on a laptop without a database; the CI job that has PostgreSQL sets
the variable and runs the suite. A skipped test is not a passed test; the
environment is the condition.

## What has not changed

The API, the CLI, the web UI, and the TUI all talk to `store.Store`. None of
them import PostgreSQL. That is the payoff of the interface: the database is
a package behind the contract, and the rest of the app does not know which
one is installed.

The server still opens the Turso store in this lesson. That is deliberate:
the PostgreSQL package is a tested alternative, not the default. The package
currently covers tasks and users; the session and audit tables would move in
the same change, because a half-swap would leave tasks in one database and
sessions in another. This lesson proves the store contract. Wiring the
constructor is the next change, and it is a deployment decision, not a line in
a chapter.

## If something went wrong

- **`connection refused`** — PostgreSQL is not listening on the published
  port. Check `podman ps` and `podman logs todo-postgres`; the first boot
  takes a second.
- **`password authentication failed`** — the DSN's user, password, or
  database does not match the container's `POSTGRES_*` values.
- **`relation "tasks" does not exist`** — the schema did not run. The
  constructor applies it; a test that opens the handle directly must call
  the same schema.
- **A conformance failure on labels** — the label insert or the label attach
  changed. The suite compares every task's labels on every list query, so the
  failure points at the row, not the prose.

<details>
<summary>Going deeper: why the store interface is worth the extra package</summary>

An interface with one implementation is often a guess. An interface with
three — memory, Turso, PostgreSQL — is a contract that has been tested from
different sides. The memory store proves the semantics without a database;
Turso proves them with SQLite's SQL; PostgreSQL proves them with placeholders,
null-safe equality, and a different transaction model.

The cost is real: every new method is three implementations and one suite.
The benefit is that the swap is a package and a constructor, not a rewrite of
every handler. The book chose the store boundary early, when the app had one
implementation, because the second one was coming. This is the lesson where
that choice pays.

</details>

The data can live on a database server now. Next we read the query plans and
add the indexes the planner actually asks for.
