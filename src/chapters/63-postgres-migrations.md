---
title: Migrations and transactions
day: 75
time: "3 hours"
description: Migrate a live-shaped table in small, reversible steps, then use a transaction to make a multi-row change all-or-nothing.
sidebar:
  order: 63
---

The schema changed three times before the app was finished: ids became UUIDs,
tasks gained a version, and tasks gained an owner. Each change had to run on a
database that already held rows. A **migration** is that change written down:
one file, one direction, and a record that it ran.

The record matters as much as the SQL. Without it, a second boot would try to
create tables that already exist; with it, the migrator can apply only what is
missing. **Goose** keeps that record in a table beside the schema.

Today we move the PostgreSQL schema into migrations, apply them to a fresh
database, and use a transaction to prove that a failed multi-row change leaves
nothing behind.

## The migration

The first migration is the schema the store needs. It is the same DDL the
previous lesson applied directly, wrapped in goose's comments:

<!-- verify: internal/store/postgres/migrations/00001_init.sql at=postgres-migrations -->
```sql title="internal/store/postgres/migrations/00001_init.sql"
-- +goose Up
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0
);

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
```

`-- +goose Up` starts the forward direction. The `IF NOT EXISTS` clauses make
the first run safe on a database that already has the tables, which is what
lets a development database and a fresh one take the same path. A production
migration can be stricter; the rule here is that the first migration must be
runnable against the shape it replaced.

The indexes and the down direction close the file:

<!-- verify: internal/store/postgres/migrations/00001_init.sql at=postgres-migrations -->
```sql title="internal/store/postgres/migrations/00001_init.sql"
CREATE INDEX IF NOT EXISTS tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS task_tags_tag ON task_tags(tag);

-- +goose Down
DROP TABLE IF EXISTS task_tags;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS users;
```

The second migration adds the status index from the query lesson:

<!-- verify: internal/store/postgres/migrations/00002_status_index.sql at=postgres-migrations -->
```sql title="internal/store/postgres/migrations/00002_status_index.sql"
-- +goose Up
CREATE INDEX IF NOT EXISTS tasks_status_owner ON tasks(status, owner_id);

-- +goose Down
DROP INDEX IF EXISTS tasks_status_owner;
```

Every migration has a `Down` even when nobody runs it in production. Down is
for development and tests: it lets a fresh database prove the migration can
be reversed, and it names the exact object to remove. A Down that drops a
table with data is honest about what reversing means; it is not a backup.

## The migrator

The migrations are embedded in the binary. The store's constructor calls the
migrator before it serves a query:

<!-- verify: internal/store/postgres/migrations.go at=postgres-migrations -->
```go title="internal/store/postgres/migrations.go"
//go:embed migrations/*.sql
var migrations embed.FS

// Migrate applies the embedded PostgreSQL migrations. The migration table is
// goose's own; running Migrate twice is a no-op after the first run.
func Migrate(ctx context.Context, db *sql.DB) error {
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}
```

`embed.FS` puts the SQL in the binary, so an import cannot forget a file. The
dialect is explicit; goose supports several engines, and the PostgreSQL
dialect is what makes its version table and locking behave correctly.
`UpContext` takes the boot context, so a canceled boot does not leave a
migration half-started.

The rest of the lesson uses a scratch database named `todo_migrate`; create
it once with `createdb -U todo todo_migrate` (or the equivalent in your
client) if you are following along.

The version table is the record:

```bash
$ podman exec todo-postgres psql -U todo -d todo_migrate -c "SELECT version_id, is_applied FROM goose_db_version ORDER BY id;"
 version_id | is_applied
------------+------------
          0 | t
          1 | t
          2 | t
(3 rows)
```

Version 0 is goose's own bookkeeping row; 1 and 2 are the two migrations.
`is_applied` is true for both. A third boot reads the table, sees nothing
pending, and returns. That is why the constructor can call `Migrate` every
time without a separate "has this run?" flag.

## Migrations on a live table

Adding a column is cheap in PostgreSQL; adding a `NOT NULL` column with a
default used to rewrite the whole table, and adding an index takes a lock.
The safe pattern is small steps:

1. Add the column as nullable, or with a default PostgreSQL can attach
   without a rewrite.
2. Backfill in batches, not one transaction over every row.
3. Add the constraint or index once the data is ready; use
   `CREATE INDEX CONCURRENTLY` on a live table.
4. Remove the old column or table in a later migration, after the code no
   longer reads it.

Each step is its own migration. A migration that does three of them is a
migration you cannot pause between. The book's schema is small enough to do
in one file; a production one should not be.

## The transaction

A transaction groups statements so the database sees them as one change.
`BEGIN` starts it, `COMMIT` makes it durable, and `ROLLBACK` throws it away.
The store's `Add` and `Update` use transactions for exactly this reason: a
task without its labels is not a task.

Prove the rollback in `psql`:

```bash
$ podman exec todo-postgres psql -U todo -d todo_migrate -c "BEGIN; INSERT INTO tasks (id,title,status,priority,version) VALUES ('00000000-0000-7000-8002-000000000001','rollback me','Todo',3,1); SELECT count(*) FROM tasks; ROLLBACK; SELECT count(*) FROM tasks;"
BEGIN
INSERT 0 1
 count
-------
     1
(1 row)

ROLLBACK
 count
-------
     0
(1 row)
```

The row exists inside the transaction and disappears after the rollback. No
other connection ever saw it, because the insert was not committed. This is
the property the store relies on: a failure between the task insert and a
label insert rolls back both.

A transaction is not a retry policy. If two writers update the same row, one
can fail with a serialization error; the store's compare-and-swap returns
`ErrConflict`, and the caller re-reads and decides. The transaction makes the
write atomic; the version makes it safe to retry.

## If something went wrong

- **`goose: no migrations found`** — the embed path and the directory passed
  to `UpContext` disagree. The pattern is `migrations/*.sql`; the directory
  is `migrations`.
- **`relation "goose_db_version" does not exist`** — the migrator never ran
  or the user cannot create tables. Check the database and role first.
- **A migration is half-applied** — PostgreSQL runs each goose migration in a
  transaction by default, so a failure rolls it back. A statement that cannot
  run in a transaction (`CREATE INDEX CONCURRENTLY`) needs goose's
  `NO TRANSACTION` annotation and its own recovery plan.
- **A transaction blocks other writers** — the lock is held until commit or
  rollback. Keep transactions short; do not wait on a network call inside
  one.

<details>
<summary>Going deeper: expand and contract</summary>

A migration that renames a column breaks the old code before the new code
deploys. The expand-and-contract pattern avoids that: add the new column, write
both, backfill, switch reads, stop writing the old one, then drop it. Each step
is compatible with both versions of the app, so a rolling deploy never has a
window where the code and schema disagree.

That pattern is why migrations are part of the deploy, not a manual step after
it. The deploy order is: migrate the database forward, deploy code that can
read both shapes, then remove the old shape in a later change. A rollback of
the code does not require a rollback of the schema if the schema is still
backward-compatible.

</details>

The schema can move forward without losing data, and a failed change can be
undone. Next we measure what the database does under real load.
