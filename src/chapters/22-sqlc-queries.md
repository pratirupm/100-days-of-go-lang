---
title: Queries with sqlc
day: 26
time: "3 hours"
description: Turn the store's hand-written SQL into named queries that a tool checks against the schema and turns into typed Go.
sidebar:
  order: 22
---

The store works. Tasks survive a restart, and one suite of tests holds both stores to the same promises. But most of `internal/store/turso.go` is bookkeeping: SQL sentences kept as strings, a scanner that reads rows, and a loop that builds question marks for a list of ids. The part that decides how the app behaves is a small fraction of the file.

Today a tool takes over that bookkeeping. **sqlc** reads the queries we write as SQL — the database's own language — and the schema the migrations describe, and it writes Go functions for them. The tool is a **generator**: a program that writes code from a source of truth. We write the queries once, in one file; the tool writes the boring Go around them.

The app's behavior does not change. That means no new tests appear in this chapter — the suite that already holds both stores to one contract is the judge. If the rewrite is faithful, every case passes, and the store has less to hide behind.

## Where the SQL lives now

Open `internal/store/turso.go` and read the methods. Each one carries its SQL as a string: a `SELECT` for listing, an `INSERT` with four placeholders, an `UPDATE` that sets a status. Beside the strings live a shared scanner that reads a row's five columns into local values, and a small builder that joins question marks for the labels query.

None of this is checked until the app runs. A typo in a column name is just text in a string until a test calls that method, and a forgotten column breaks when someone lists tasks. Adding a query means writing three things by hand: the SQL, the arguments, and the scanning code.

The schema already has a better home — the migration files from the last chapter. The SQL deserves one too. Both are things the database understands; neither needs to hide inside Go.

## A tool that writes the Go

A **generator** is a program that writes code from a source of truth. The mock in the store's tests is one example: a tool read the `Store` interface and wrote a fake implementation of it. The new tool reads our SQL and writes the Go that runs it.

**sqlc** has three inputs and one output. The inputs are the schema (the migration directory), the queries (SQL sentences written in a file, each with a name), and a small config that points at both. The output is ordinary Go that calls `database/sql` — the same kind of calls the store makes by hand today.

The names are the interface. Each query starts with a comment in a fixed shape: `-- name: ListTasks :many`. The name becomes a method, and the marker after it says what comes back. `:one` returns a single row; `:many` returns a list of rows; `:exec` runs a statement and returns nothing; `:execrows` runs a statement and reports how many rows it changed.

Because sqlc reads the schema, it checks every query before any Go exists. A column that is not in the migrations stops the generator and names the line. The SQL stays SQL, and the checking moves earlier — before the app runs, before a test runs.

## Write the config

The config is one small file at the app's root. Create `sqlc.yaml`:

<!-- verify: sqlc.yaml at=sqlc -->
```yaml title="sqlc.yaml"
# sqlc's config: SQL in, Go out. The schema source is the goose migration
# directory, not a second copy of the DDL — sqlc's goose parser reads only the
# statements between -- +goose Up and -- +goose Down, so the migration files
# stay the one place the schema lives, and internal/db/schema.sql keeps
# pinning what they produce for the tests. The queries live in their own
# directory; `out` is the db package itself, so the generated files sit next
# to migrate.go and share its package. Every path is relative to this file,
# which is what makes the //go:generate directive in internal/store/store.go
# work from a different working directory.
version: "2"
sql:
  - engine: "sqlite"
    schema: "internal/db/migrations"
    queries: "internal/db/queries"
    gen:
      go:
        package: "db"
        out: "internal/db"
```

Three inputs, one output. `schema` points at the migration directory the last chapter created; `queries` names a directory we are about to create; and `out` says where the generated Go goes — `internal/db`, the package the migrations already live in. The comment records two facts worth keeping: sqlc reads only the forward half of each migration, and every path is relative to this file.

## Write the queries

Create the folder `internal/db/queries` and, inside it, `tasks.sql`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them. This file is the store's whole SQL surface: twelve named queries in sqlc's format. It opens with a note about the file itself, then the two inserts and the read-by-id:

<!-- verify: internal/db/queries/tasks.sql at=sqlc -->
```sql title="internal/db/queries/tasks.sql"
-- The queries TursoStore runs, in sqlc's format. A comment above a -- name:
-- line becomes that method's doc comment in the generated code; sqlc checks
-- the SQL against the schema at generation time, so a column that does not
-- exist fails the generate step instead of a test. The generated row structs
-- are database shapes: due is sql.NullString and ids are int64, and the store
-- maps them to todo/internal/task types at its own boundary.

-- Inserts a task and returns the id Turso assigned. A zero due is inserted
-- as NULL, not the year 1 as text.
-- name: InsertTask :one
INSERT INTO tasks (title, status, priority, due)
VALUES (?, ?, ?, ?)
RETURNING id;

-- Inserts one tag row. The composite primary key rejects a repeated tag, so
-- the store deduplicates before calling this.
-- name: InsertTag :exec
INSERT INTO task_tags (task_id, tag)
VALUES (?, ?);

-- Reads one task by id. sqlc returns sql.ErrNoRows when no row matches.
-- name: GetTask :one
SELECT id, title, status, priority, due
FROM tasks
WHERE id = ?;
```

`InsertTask` ends with `RETURNING id`: the database hands back the id it assigned, which the old code fetched with a separate call. `InsertTag` is `:exec`, so nothing comes back. `GetTask` is `:one`, and when no row matches, the generated method reports `sql.ErrNoRows`, the database's standard no-row error.

The three list queries follow. They differ only in their `WHERE` line:

<!-- verify: internal/db/queries/tasks.sql at=sqlc -->
```sql title="internal/db/queries/tasks.sql"
-- Lists every task in ID order. IDs are assigned in insertion order, so for
-- an append-only store this is insertion order.
-- name: ListTasks :many
SELECT id, title, status, priority, due
FROM tasks
ORDER BY id;

-- Lists the tasks whose status equals the argument, in ID order.
-- name: ListTasksByStatus :many
SELECT id, title, status, priority, due
FROM tasks
WHERE status = ?
ORDER BY id;

-- Lists the tasks carrying the tag, in ID order. The join yields a task once
-- per matching task_tags row, and the primary key keeps that at most one.
-- name: ListTasksByTag :many
SELECT tasks.id, tasks.title, tasks.status, tasks.priority, tasks.due
FROM tasks
JOIN task_tags ON task_tags.task_id = tasks.id
WHERE task_tags.tag = ?
ORDER BY tasks.id;
```

`ListTasksByTag` joins the two tables: a task appears once for each of its label rows, and the primary key keeps that at most one. Next comes the update, plus the two queries that read labels:

<!-- verify: internal/db/queries/tasks.sql at=sqlc -->
```sql title="internal/db/queries/tasks.sql"
-- Marks the task with the given id as done and reports how many rows
-- changed, which is how the store tells a miss from a hit.
-- name: CompleteTask :execrows
UPDATE tasks
SET status = ?
WHERE id = ?;

-- Counts, for every distinct tag, how many tasks carry it. A task counts at
-- most once per tag because task_tags holds one row per pair.
-- name: CountTasksByTag :many
SELECT tag, COUNT(*) AS count
FROM task_tags
GROUP BY tag;

-- Lists every distinct tag, sorted. Empty when there are no tags.
-- name: ListTags :many
SELECT DISTINCT tag
FROM task_tags
ORDER BY tag;
```

`CompleteTask` is `:execrows`, because an `UPDATE` that matches nothing is still a successful statement — the count of changed rows is how the store tells a miss from a hit. Then the ordering rule and the stats aggregate:

<!-- verify: internal/db/queries/tasks.sql at=sqlc -->
```sql title="internal/db/queries/tasks.sql"
-- Lists all tasks sorted by due ascending with undated tasks last; id breaks
-- ties because IDs are assigned in insertion order.
-- name: SortTasksByDue :many
SELECT id, title, status, priority, due
FROM tasks
ORDER BY (due IS NULL), due, id;

-- Aggregates the task table: the total and how many are done. The CAST pins
-- the sum to INTEGER so the generated field is int64, and COALESCE covers
-- the empty table, where SUM is NULL.
-- name: TaskStats :one
SELECT COUNT(*) AS total, CAST(COALESCE(SUM(status = ?), 0) AS INTEGER) AS done
FROM tasks;
```

The `CAST(... AS INTEGER)` pins the sum to an integer, and `COALESCE` turns the empty table's `NULL` sum into zero. The last query loads the labels of many tasks in one statement:

<!-- verify: internal/db/queries/tasks.sql at=sqlc -->
```sql title="internal/db/queries/tasks.sql"
-- Loads the tags of the given tasks in one query, ordered so each task's
-- tags arrive sorted. sqlc.slice expands to one placeholder per id.
-- name: ListTagsForTasks :many
SELECT task_id, tag
FROM task_tags
WHERE task_id IN (sqlc.slice('task_ids'))
ORDER BY task_id, tag;

-- Keep this file ASCII: sqlc v1.31.1 counts token positions in runes but
-- slices query text in bytes, so one multibyte character above the
-- sqlc.slice query corrupts its generated text (an em dash reproduces it).
-- ...
```

`sqlc.slice('task_ids')` is a marker: at run time the generated code replaces it with one placeholder per id, so the list can be any length. The comment at the end asks for plain ASCII in this file — the box at the end of the chapter explains why.

## Run the generator

sqlc is not part of the app. Like the mock generator, it runs from a `//go:generate` line pinned to an exact version. Open `internal/store/store.go` and add the second directive below the mock's. The finished app's appendix holds this file in full; the pieces quoted here are the ones that carry the idea:

<!-- verify: internal/store/store.go at=sqlc -->
```go title="internal/store/store.go"
//go:generate go run github.com/matryer/moq@v0.8.0 -out store_moq_test.go . Store
// ...
//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f ../../sqlc.yaml
```

`go generate` runs a directive in the folder of the file that holds it, so sqlc starts inside `internal/store`. `-f ../../sqlc.yaml` hands it the config two folders up, and the paths inside the config are read relative to the config file itself. The version is written into the directive, so the tool is the same everywhere.

Run it:

```bash
$ go generate ./...
```

Silence is success. Three files have appeared next to `migrate.go`: `db.go`, `models.go`, and `tasks.sql.go`. Each one says who wrote it:

```bash
$ head -4 internal/db/tasks.sql.go
// Code generated by sqlc. DO NOT EDIT.
// versions:
//   sqlc v1.31.1
// source: tasks.sql
```

The `DO NOT EDIT` line is a promise: these files are outputs, never inputs. Edit one by hand and the next generation overwrites the edit.

:::note
When the queries change, run `go generate ./...` again. Never edit the three generated files; they are rewritten from `tasks.sql` and the schema every time.
:::

## Read the generated code

`db.go` is the plumbing every generated package needs:

<!-- verify: internal/db/db.go at=sqlc -->
```go title="internal/db/db.go"
// Code generated by sqlc. DO NOT EDIT.
// versions:
//   sqlc v1.31.1

package db

import (
	"context"
	"database/sql"
)

type DBTX interface {
	ExecContext(context.Context, string, ...interface{}) (sql.Result, error)
	PrepareContext(context.Context, string) (*sql.Stmt, error)
	QueryContext(context.Context, string, ...interface{}) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...interface{}) *sql.Row
}
```

`DBTX` is the small set of methods a database handle has. The app's handle, `*sql.DB`, has them — and so does `*sql.Tx`, a transaction. That is the trick the next part relies on:

<!-- verify: internal/db/db.go at=sqlc -->
```go title="internal/db/db.go"
func New(db DBTX) *Queries {
	return &Queries{db: db}
}

type Queries struct {
	db DBTX
}

func (q *Queries) WithTx(tx *sql.Tx) *Queries {
	return &Queries{
		db: tx,
	}
}
```

`New` wraps whatever it is handed, and `WithTx` returns a copy pointed at a transaction. The same generated methods can run inside `Add`'s transaction, with no second code path.

`models.go` is the schema as Go types:

<!-- verify: internal/db/models.go at=sqlc -->
```go title="internal/db/models.go"
// Code generated by sqlc. DO NOT EDIT.
// versions:
//   sqlc v1.31.1

package db

import (
	"database/sql"
)

type Task struct {
	ID       int64
	Title    string
	Status   string
	Priority int64
	Due      sql.NullString
}

type TaskTag struct {
	TaskID int64
	Tag    string
}
```

`Task` and `TaskTag` mirror the two tables. Look at the types: ids are `int64`, and `due` is `sql.NullString` — a string that can also be no value, the database's `NULL`. These are database shapes, not the app's `task.Task`; the store is where one becomes the other.

`tasks.sql.go` holds one method per named query. The twelve, in the order the file defines them:

```text
func (q *Queries) CompleteTask(ctx context.Context, arg CompleteTaskParams) (int64, error)
func (q *Queries) CountTasksByTag(ctx context.Context) ([]CountTasksByTagRow, error)
func (q *Queries) GetTask(ctx context.Context, id int64) (Task, error)
func (q *Queries) InsertTag(ctx context.Context, arg InsertTagParams) error
func (q *Queries) InsertTask(ctx context.Context, arg InsertTaskParams) (int64, error)
func (q *Queries) ListTags(ctx context.Context) ([]string, error)
func (q *Queries) ListTagsForTasks(ctx context.Context, taskIds []int64) ([]TaskTag, error)
func (q *Queries) ListTasks(ctx context.Context) ([]Task, error)
func (q *Queries) ListTasksByStatus(ctx context.Context, status string) ([]Task, error)
func (q *Queries) ListTasksByTag(ctx context.Context, tag string) ([]Task, error)
func (q *Queries) SortTasksByDue(ctx context.Context) ([]Task, error)
func (q *Queries) TaskStats(ctx context.Context, status string) (TaskStatsRow, error)
```

Two bodies are worth reading closely. `CompleteTask` is the `:execrows` query, so its count comes straight back:

<!-- verify: internal/db/tasks.sql.go at=sqlc -->
```go title="internal/db/tasks.sql.go"
// Marks the task with the given id as done and reports how many rows
// changed, which is how the store tells a miss from a hit.
func (q *Queries) CompleteTask(ctx context.Context, arg CompleteTaskParams) (int64, error) {
	result, err := q.db.ExecContext(ctx, completeTask, arg.Status, arg.ID)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
```

`ListTagsForTasks` is `sqlc.slice` expanded into placeholders:

<!-- verify: internal/db/tasks.sql.go at=sqlc -->
```go title="internal/db/tasks.sql.go"
func (q *Queries) ListTagsForTasks(ctx context.Context, taskIds []int64) ([]TaskTag, error) {
	query := listTagsForTasks
	var queryParams []interface{}
	if len(taskIds) > 0 {
		for _, v := range taskIds {
			queryParams = append(queryParams, v)
		}
		query = strings.Replace(query, "/*SLICE:task_ids*/?", strings.Repeat(",?", len(taskIds))[1:], 1)
	} else {
		query = strings.Replace(query, "/*SLICE:task_ids*/?", "NULL", 1)
	}
	rows, err := q.db.QueryContext(ctx, query, queryParams...)
	// ...
}
```

The comment above a query became the method's doc comment, and the placeholder list is built at run time from the slice. `GetTask` is generated but not called yet; it is there for the day the store reads one task by id.

## The tests are already written

This chapter changes how the store is written, not what it does. So it writes no new tests — and that is not a shortcut. The suite from the database work already pins the contract: nil-when-empty lists, a map that is never nil, `ErrNotFound` for a missing task, label order, zero due dates last, a canceled context. It runs against both stores, and it knows nothing about SQL strings or generated code.

The rewrite is done when that suite passes unchanged. If a case fails, the mapping is wrong, and the failing case says where.

## Move the store onto the generated queries

The store keeps its job: opening the database, transactions, error shapes, and the mapping to `task.Task`. What leaves is the SQL. Start with the struct — one new field — and the constructor. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
	// queries runs the generated statements. NewTursoStore binds it to db;
	// Add and Stats rebind a copy to a transaction with WithTx.
	queries *db.Queries
}
// ...
	return &TursoStore{db: sqlDB, queries: db.New(sqlDB)}, nil
```

Add `todo/internal/db` to the imports and drop `strings`; nothing here builds SQL text anymore.

`Add` keeps its transaction and swaps the statements for methods. The generated params structs carry the arguments, and `WithTx` points the queries at the transaction:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
	q := s.queries.WithTx(tx)
	id, err := q.InsertTask(ctx, db.InsertTaskParams{
		Title:    t.Title,
		Status:   string(t.Status),
		Priority: int64(t.Priority),
		Due:      dueSQL(t.Due),
	})
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
// ...
	for _, tag := range uniqueTags(t.Tags) {
		if err := q.InsertTag(ctx, db.InsertTagParams{TaskID: id, Tag: tag}); err != nil {
			return task.Task{}, fmt.Errorf("add task: %w", err)
		}
	}
```

`dueSQL` is a helper we will write below; it turns the due time into the column's shape. The label loop calls `InsertTag`, one row per label.

`Complete` reads the miss signal from the generated count:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
	n, err := s.queries.CompleteTask(ctx, db.CompleteTaskParams{
		Status: string(task.StatusDone),
		ID:     int64(id),
	})
	if err != nil {
		return fmt.Errorf("complete task %d: %w", id, err)
	}
	if n == 0 {
		return fmt.Errorf("complete task %d: %w", id, ErrNotFound)
	}
	return nil
```

Same shape as before: zero changed rows becomes `ErrNotFound`, with the `RowsAffected` call moved into the generated method.

The four read methods follow one pattern, and `List` is the example:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
	rows, err := s.queries.ListTasks(ctx)
	if err != nil {
		return nil, fmt.Errorf("list tasks: %w", err)
	}
	return s.queryTasks(ctx, "list tasks", rows)
```

Call the generated method, wrap the error with the operation's name, and hand the rows to `queryTasks`. `ByStatus`, `ByTag`, and `SortByDue` differ only in the method they call and the words in their errors.

`CountByTag` and the label-list method change the same way, with one promise kept by hand:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
	rows, err := s.queries.CountTasksByTag(ctx)
	if err != nil {
		return nil, fmt.Errorf("count by tag: %w", err)
	}
	counts := make(map[string]int, len(rows))
	for _, r := range rows {
		counts[r.Tag] = int(r.Count)
	}
	return counts, nil
}
// ...
	tags, err := s.queries.ListTags(ctx)
	if err != nil {
		return nil, fmt.Errorf("list tags: %w", err)
	}
	if len(tags) == 0 {
		return nil, nil
	}
	return tags, nil
```

The count map is built from the generated rows. The label list re-checks the empty result, because the promise is that no labels means `nil` — the store keeps that promise itself rather than trusting the generator's output shape.

`Stats` runs two queries in one read transaction:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
	q := s.queries.WithTx(tx)
	row, err := q.TaskStats(ctx, string(task.StatusDone))
	if err != nil {
		return Stats{}, fmt.Errorf("stats: %w", err)
	}
	stats := Stats{
		Total: int(row.Total),
		Done:  int(row.Done),
	}
	stats.Pending = stats.Total - stats.Done

	tagRows, err := q.CountTasksByTag(ctx)
	if err != nil {
		return Stats{}, fmt.Errorf("stats: %w", err)
	}
	stats.ByTag = make(map[string]int, len(tagRows))
	for _, r := range tagRows {
		stats.ByTag[r.Tag] = int(r.Count)
	}
	return stats, nil
```

Both queries join the transaction through `WithTx`, so the totals see one snapshot of the database.

## Map the rows to tasks

The generated methods return `db.Task` values — rows as the database sees them. The rest of the app knows `task.Task`, where ids are `int`, status is `task.Status`, and a due date is a `time.Time`. The store is the boundary, and two small functions carry a value across it:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
func taskFromRow(id int64, title, status string, priority int64, due sql.NullString) (task.Task, error) {
	t := task.Task{
		ID:       int(id),
		Title:    title,
		Status:   task.Status(status),
		Priority: task.Priority(priority),
	}
	if due.Valid {
		parsed, err := time.Parse(time.RFC3339, due.String)
		if err != nil {
			return task.Task{}, fmt.Errorf("parse due %q: %w", due.String, err)
		}
		t.Due = parsed
	}
	return t, nil
}
```

The conversions are explicit: `int(id)`, `task.Status(status)`, `task.Priority(priority)`. A `due` that holds a value is parsed from the stored text into a `time.Time`; one that does not leaves the task's due date at its zero value — no due date.

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
func dueSQL(due time.Time) sql.NullString {
	if due.IsZero() {
		return sql.NullString{}
	}
	return sql.NullString{String: due.UTC().Format(time.RFC3339), Valid: true}
}
```

The other direction. A zero time becomes an invalid `NullString`, which the driver writes as `NULL` — not the year 1 as text — and a real date is written as UTC text, the same format `taskFromRow` parses back.

`queryTasks` is where the read methods meet the mapping:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
func (s *TursoStore) queryTasks(ctx context.Context, op string, rows []db.Task) ([]task.Task, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	tasks := make([]task.Task, 0, len(rows))
	for _, r := range rows {
		t, err := taskFromRow(r.ID, r.Title, r.Status, r.Priority, r.Due)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", op, err)
		}
		tasks = append(tasks, t)
	}
	if err := s.attachTags(ctx, tasks); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	return tasks, nil
}
```

An empty result returns early as `nil` — the same nil-when-empty promise the memory store makes. Otherwise each row becomes a task, and `attachTags` loads the labels:

<!-- verify: internal/store/turso.go at=sqlc -->
```go title="internal/store/turso.go"
	byID := make(map[int64]*task.Task, len(tasks))
	ids := make([]int64, len(tasks))
	for i := range tasks {
		byID[int64(tasks[i].ID)] = &tasks[i]
		ids[i] = int64(tasks[i].ID)
	}

	rows, err := s.queries.ListTagsForTasks(ctx, ids)
	if err != nil {
		return err
	}
	for _, r := range rows {
		byID[r.TaskID].Tags = append(byID[r.TaskID].Tags, r.Tag)
	}
	return nil
```

One generated query loads the labels for all the tasks at once — the ids are its `sqlc.slice` argument — and the rows arrive ordered, so each task's labels are sorted.

Three pieces of the old file are simply gone: the shared column list, the row scanner, and the placeholder builder. Their jobs live in the generated code now. A search for SQL keywords in the store finds only two matches, and both are words in comments:

```bash
$ grep -nE 'SELECT|INSERT|UPDATE|DELETE|sql\.Rows|LastInsertId' internal/store/turso.go
135:// UPDATE reports that no row matched: an UPDATE that touches nothing is a
399:// DELETE CASCADE would do nothing.
```

Every statement the store runs is generated from `tasks.sql`.

## Run everything

Run the whole app:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/db	0.021s
ok  	todo/internal/store	0.072s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.003s
```

Every package passes on the first run. Now run the contract suite on its own and watch the cases:

```bash
$ go test -count=1 -run TestStoreConformance -v ./internal/store
--- PASS: TestStoreConformance (0.04s)
    --- PASS: TestStoreConformance/MemoryStore (0.00s)
        ...
    --- PASS: TestStoreConformance/TursoStore (0.04s)
        --- PASS: TestStoreConformance/TursoStore/AddAndList (0.02s)
        --- PASS: TestStoreConformance/TursoStore/EmptyStore (0.00s)
        --- PASS: TestStoreConformance/TursoStore/Complete (0.00s)
        --- PASS: TestStoreConformance/TursoStore/CompleteMissing (0.00s)
        --- PASS: TestStoreConformance/TursoStore/ByStatus (0.00s)
        --- PASS: TestStoreConformance/TursoStore/ByTag (0.00s)
        --- PASS: TestStoreConformance/TursoStore/CountByTag (0.00s)
        --- PASS: TestStoreConformance/TursoStore/Tags (0.00s)
        --- PASS: TestStoreConformance/TursoStore/SortByDue (0.00s)
            --- PASS: TestStoreConformance/TursoStore/SortByDue/zero_due_dates_last (0.00s)
            --- PASS: TestStoreConformance/TursoStore/SortByDue/ties_keep_insertion_order (0.00s)
        --- PASS: TestStoreConformance/TursoStore/Stats (0.00s)
        --- PASS: TestStoreConformance/TursoStore/CanceledContext (0.00s)
PASS
ok  	todo/internal/store	0.040s
```

The same suite that judged the hand-written SQL judges the generated queries, and every behavior survives: nil-when-empty lists, a map that is never nil, `ErrNotFound` for a missing task, label order, zero due dates sorted last, a canceled context. The store's whole SQL surface changed, and the suite never noticed. That is what tests are for.

The SQL now lives in one file, checked against the schema before any Go exists, and the store keeps what the generator does not do: transactions, error shapes, and the mapping. Next, the database's shape changes on purpose: integer ids become text, and the migrations, the golden schema, and the generated queries all have to agree.

## If something went wrong

**A query names a column the schema doesn't have.** Add a query that selects a column called `nope`, and the generator stops before writing any Go. Run it directly and the message is plain:

```bash
$ go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f sqlc.yaml
# package db
internal/db/queries/broken.sql:2:12: column "nope" does not exist
exit status 1
```

The message names the file, line, and column. The schema is the migration directory: a column that exists only in your head does not exist for sqlc. Fix the query, or add the column through a new migration, and run the generator again.

**You deleted the generated files to start clean.** `go generate ./...` cannot bootstrap: the mock tool loads the store's package first, and the store no longer compiles:

```bash
$ go generate ./...
couldn't load source package: -: # todo/internal/store
./turso.go:33:14: undefined: db.Queries
./turso.go:79:44: undefined: db.New
./turso.go:107:34: undefined: db.InsertTaskParams
...
internal/store/store.go:43: running "go": exit status 1
```

Run the generator directly instead — it needs no compiling module:

```bash
$ go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f sqlc.yaml
```

The three files come back byte for byte.

**You edited a generated file by hand.** There is no error message, and that is the problem. The next generation overwrites the edit:

```bash
$ echo "// hand edit" >> internal/db/tasks.sql.go
$ go generate ./...
$ grep -c "hand edit" internal/db/tasks.sql.go
0
```

Zero matches: the file was rewritten from the queries. Change the query, run the generator, and read what changed in the generated file — the query is the source of truth.

**The generator stops with a parser error that names text you never wrote.** The summary says `edited query syntax is invalid`, and the position points at the `sqlc.slice` query, not at the comment that changed. The cause is a non-ASCII character somewhere above it. Keep `internal/db/queries` plain ASCII; the box at the end tells the story.

<details>
<summary>Going deeper: why the version lives in the directive</summary>

sqlc is a developer tool, not a library the app uses. `go run pkg@version` builds it in its own little module, so nothing of sqlc is linked into the binary, and nothing of it appears in the app's dependencies. Ask:

```bash
$ go list -m github.com/sqlc-dev/sqlc
go: module github.com/sqlc-dev/sqlc: not a known dependency
```

And the tool can report its own version:

```bash
$ go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 version
v1.31.1
```

The version is written literally in the directive, so a plain `go generate ./...` runs the exact tool the code was generated with. An upgrade becomes one visible line in `store.go`.

</details>

<details>
<summary>Going deeper: why the store keeps the mapping</summary>

The generated types are database shapes: `int64` ids, `sql.NullString` for `due`. The app's types are domain shapes: `int`, `task.Status`, `time.Time`. We could have asked sqlc to emit the domain types with a config override. We didn't, because the mapping is not only translation — it is where behavior lives. A zero due becomes `NULL` and reads back as a zero time. An empty result becomes `nil`. A zero row count becomes `ErrNotFound`. Labels come back sorted. Keeping those decisions in the store keeps them testable, and keeps the generated code a thin translation of the SQL.

</details>

<details>
<summary>Going deeper: the bug that wants plain text</summary>

sqlc v1.31.1 has a units mismatch in its SQLite engine. It counts token positions in runes — characters as a reader sees them — but slices query text in bytes. A character like an em dash is one rune but three bytes, so a multibyte character above a `sqlc.slice` query shifts the position sqlc computes into the middle of a word, and generation fails with a parser error naming text nobody wrote:

```text
# package db
internal/db/queries-bug/tasks.sql:87:1: edited query syntax is invalid: extraneous input ''' expecting {<EOF>, ';', ALTER_, ANALYZE_, ATTACH_, BEGIN_, COMMIT_, CREATE_, DELETE_, DETACH_, DROP_, END_, EXPLAIN_, INSERT_, PRAGMA_, REINDEX_, RELEASE_, REPLACE_, ROLLBACK_, SAVEPOINT_, SELECT_, UPDATE_, VACUUM_, VALUES_, WITH_}
exit status 1
```

The comment at the end of `tasks.sql` is the guard: keep the file plain ASCII. The bug is upstream, and a pinned tool is a known tool — bugs included.

</details>

<details>
<summary>Going deeper: what sqlc does not do</summary>

It does not migrate — goose owns that. It does not manage transactions: `WithTx` points queries at a transaction, and the store still opens it, finishes it, and rolls it back. And it does not build SQL from Go values; the one place the store needs a dynamic list, `sqlc.slice` expands a slice into placeholders. sqlc's deal is narrow: you write the SQL, it writes the boring Go. No query builder hides the SQL, and no reflection runs at startup. Tools that build the SQL for you hide both the SQL and the schema; here the SQL is the artifact a person reads, checked against the schema before any Go exists.

</details>
