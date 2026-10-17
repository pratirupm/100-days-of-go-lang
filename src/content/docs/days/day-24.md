---
title: "Day 24 — Adding a database"
description: "Move the tasks out of memory and into a real database behind the same store interface, and run one suite of tests against both. — Day 24 of 100 Days of Go Lang."
sidebar:
  order: 24
chapter: 20
---

**About 4 hours** · Part V, day 2 of 6.

**You'll be able to:**

- open a real database — Turso, with no C compiler in sight;
- run one conformance suite against both the memory and database stores.

:::tip[If you only have two hours]
stop after “Watch it fail” passes, and pick up at “The schema and the handle” tomorrow.
:::

---

Everything the app knows lives in memory. Quit the program and it's gone:
every task, every label, every due date, wiped the moment the process ends.
That's fine for a toy. For an app someone actually uses, it's the one thing
that cannot be true.

So the tasks move into a **database**: a program that keeps data on disk and
answers questions about it, and that data outlives the program that wrote
it. We'll use one called **Turso**, which speaks the same query language and
file format as SQLite — and whose Go driver needs no C compiler.

The move happens behind the `Store` interface, so nothing above the store
changes. And the interface gets its payoff today: the contract both stores
promise can be written down once, as a suite of tests, and run against each.

## What a database is

A database is a filing cabinet that lives on disk. Inside it are **tables**.
A table is like one sheet of a spreadsheet: every **row** is one record, and
every **column** is one of the record's fields. Our app gets two tables: one
for the tasks, a column per field — title, status, priority, due date — and
one for the labels.

Databases are asked questions in **SQL** — Structured Query Language — a
small language of sentences. Here is a whole one:
`SELECT title FROM tasks WHERE status = 'Todo'`. Read it left to right: pick
the `title` column, from the `tasks` table, for the rows whose `status`
says `Todo`.

The database gives the app what memory never could: data that survives a
restart, and one shared place every caller reads and writes. The in-memory
store stays, and the two must agree on every answer.

## A database engine with no C compiler

**Turso** is the engine — the program that actually stores and reads the
bytes. It speaks SQLite's query language and file format, so all the SQL
here is SQLite's SQL. The Go package that talks to it,
`turso.tech/database/tursogo`, is a **driver**: the adapter between a
database engine and Go's database tools.

Reaching into another language's code normally means **cgo**, a bridge that
needs a C compiler. This driver avoids cgo: it loads Turso's engine as a
native library at run time and calls into it through **purego**. So the app
keeps building with a plain Go toolchain, and with the C compiler switched
off.

Turso is young and says so: it's pre-1.0, so we pin the exact version,
`v0.8.3`. The export file the app can already write is the safe backup — a
copy independent of the database's own files.

## One suite, two stores

Until now, each store was tested through its own type. Nothing would check
that both answer the same calls the same way.

So we write the contract down once, as a **conformance suite**: one test
body every store must pass, run against each store in turn. It lives in its
own package, `internal/store/storetest`, and exports one function, `Run`.

The suite pins the deterministic core of the contract — the parts no clock,
no sleeping, and no concurrency can change. Persistence and the settings
only a real database has stay in that store's own tests.

## Write the tests first

Create the folder `internal/store/storetest`, and inside it a file called
`suite.go`. It opens with the package comment:

<!-- verify: internal/store/storetest/suite.go at=turso -->
```go title="internal/store/storetest/suite.go"
// Package storetest is the Store conformance suite: one test body that every
// implementation of todo/internal/store.Store must pass. It lives in its own
// package so the same suite can run against several implementations from one
// external test package. The suite imports store, which is exactly why its
// caller cannot be an internal test file of package store — that would be an
// import cycle — so the caller is an external test package such as
// store_test.
package storetest
```

The comment explains the package name: the suite imports `store`, so the
file that *calls* the suite cannot live inside `store` — the package would
import itself.

Below the imports comes the one exported function. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them:

<!-- verify: internal/store/storetest/suite.go at=turso -->
```go title="internal/store/storetest/suite.go"
func Run(t *testing.T, newStore func(t *testing.T) store.Store) {
	t.Helper()
	...
}
```

`newStore` builds a fresh store for one case, so every subtest starts empty.
The cases inside are the contract, one piece at a time: adding and listing,
an empty store, completing, filtering, counting, sorting by due date,
stats, and a canceled context. One case pins that an empty store returns
`nil`, not an empty list.

Now the runner, in a new file called `internal/store/conformance_test.go`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them:

<!-- verify: internal/store/conformance_test.go at=turso -->
```go title="internal/store/conformance_test.go"
// Package store_test is the external test package that runs the store
// conformance suite against every Store implementation. It must be external:
// the suite package imports todo/internal/store, so an internal test file of
// package store importing the suite would be an import cycle.
package store_test

...
func TestStoreConformance(t *testing.T) {
	t.Run("MemoryStore", func(t *testing.T) {
		storetest.Run(t, func(t *testing.T) store.Store {
			return store.NewMemoryStore()
		})
	})

	t.Run("TursoStore", func(t *testing.T) {
		storetest.Run(t, func(t *testing.T) store.Store {
			...
			s, err := store.NewTursoStore(filepath.Join(t.TempDir(), "tasks.db"))
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, s.Close()) })
			return s
		})
	})
}
```

Two subtest names, one suite body. The package name `store_test` is the
external test package the suite's comment asked for, and it can only use
what `store` exports — the same surface a real caller sees. The database
half opens a file inside a test-owned directory and registers `t.Cleanup`,
so the handle is closed even when a case fails.

The third file, `internal/store/turso_test.go`, holds what the suite cannot:
facts about this particular driver.

<!-- verify: internal/store/turso_test.go at=turso -->
```go title="internal/store/turso_test.go"
	_, err = s.db.ExecContext(ctx, `INSERT INTO task_tags (task_id, tag) VALUES (999, 'orphan')`)
	require.Error(t, err, "foreign keys are on for a connection that did not run the pragma")
	assert.Contains(t, err.Error(), "FOREIGN KEY")
}
```

The test asks the live connection what it is running — WAL, the journal
mode that keeps recent writes in a sidecar file, a five-second busy timeout,
foreign keys on — then proves the last one is enforcement, not a report: a
label row naming a task that doesn't exist is rejected by the database
itself. The file's other two tests pin persistence across a close and
reopen, and the `:memory:` trap.

## Watch it fail

Run everything:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/store [todo/internal/store.test]
internal/store/turso_test.go:32:12: undefined: NewTursoStore
internal/store/turso_test.go:78:12: undefined: NewTursoStore
internal/store/turso_test.go:101:19: undefined: NewTursoStore
internal/store/turso_test.go:128:12: undefined: NewTursoStore
ok  	todo/cmd/todo	0.003s
FAIL	todo/internal/store [build failed]
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.003s
FAIL
```

One missing name, four complaints: `NewTursoStore` doesn't exist yet. The
runner names the same missing function, but Go stops at the first package
it cannot build, so that error waits its turn. The other packages pass,
including the new `storetest` package, which holds only the suite.

## The schema and the handle

Now the code. Create `internal/store/turso.go`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them. It starts with the store's
type and the promise every store makes:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
type TursoStore struct {
	// db is the database/sql handle. Every method goes through it, and the
	// pool is pinned to one connection in NewTursoStore.
	db *sql.DB
}

// TursoStore is one implementation of Store.
var _ Store = (*TursoStore)(nil)
```

`database/sql` is Go's standard toolkit for databases, and the struct holds
one thing: the handle every method goes through. The last line is the same
promise `MemoryStore` makes: if `TursoStore` stops satisfying `Store`, the
file stops building.

The schema lives in two constants:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
const (
	tursoCreateTasks = `CREATE TABLE IF NOT EXISTS tasks (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	title    TEXT NOT NULL,
	status   TEXT NOT NULL,
	priority INTEGER NOT NULL,
	due      TEXT
)`

	tursoCreateTaskTags = `CREATE TABLE IF NOT EXISTS task_tags (
	task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	tag     TEXT NOT NULL,
	PRIMARY KEY (task_id, tag)
)`
)
```

Two tables, created only if they don't exist yet. `tasks` has a column per
field; `due` is text because it may hold a timestamp written as text — or
`NULL`, SQL's word for "no value". `task_tags` holds one row per
task-and-label pair, and the pair is the **primary key** — the columns that
identify a row and must be unique — so a repeated label is impossible.
`REFERENCES tasks(id) ON DELETE CASCADE` ties each label row to its task
row: delete the task, and the database deletes its labels.

The constructor opens the file and creates the schema:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
func NewTursoStore(path string) (*TursoStore, error) {
	connector, err := turso.NewConnector(tursoDSN(path))
	if err != nil {
		return nil, fmt.Errorf("open turso store %s: %w", path, err)
	}
	...
	db := sql.OpenDB(&pragmaConnector{
		base:    connector,
		pragmas: []string{"PRAGMA foreign_keys(1)"},
	})

	...
	db.SetMaxOpenConns(1)

	...
	for _, ddl := range []string{tursoCreateTasks, tursoCreateTaskTags} {
		if _, err := db.ExecContext(context.Background(), ddl); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("open turso store %s: %w", path, err)
		}
	}
	return &TursoStore{db: db}, nil
}
```

`turso.NewConnector` builds the connection maker; `sql.OpenDB` accepts it
and connects lazily — nothing touches the file until the schema statements
run. The store is safe for concurrent use because callers queue on one
connection, which is what `SetMaxOpenConns(1)` pins.

## Settings that live on every connection

The DSN — the string saying where the database is and how to open it —
carries exactly one setting:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
func tursoDSN(path string) string {
	return path + "?_busy_timeout=5000"
}
```

`_busy_timeout=5000` makes a connection wait up to five seconds for a lock
instead of failing immediately. Why only one? The driver's DSN grammar
knows a handful of its own keys and silently ignores the rest — a copied
SQLite DSN would open fine and configure nothing. The other setting goes
where it can take effect: a wrapper around the connector, so every fresh
connection runs it. The appendix holds this file in full — the lines behind
the `...` are there as you type them:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
type pragmaConnector struct {
	base    driver.Connector
	pragmas []string
}

func (c *pragmaConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	...
	for _, stmt := range c.pragmas {
		if _, err := execer.ExecContext(ctx, stmt, nil); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("turso: run %q: %w", stmt, err)
		}
	}
	return conn, nil
}

// Driver returns the underlying driver.
func (c *pragmaConnector) Driver() driver.Driver { return c.base.Driver() }
```

`foreign_keys` is a switch that lives on a connection, and Turso leaves it
off. `database/sql` has no hook for "run this on every new connection", so
the wrapper is one. Without it, a later connection would silently lose
enforcement, and the schema's `ON DELETE CASCADE` would do nothing. A
failed pragma closes the connection and fails the open.

The handle gets one more method, deliberately outside the interface:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
func (s *TursoStore) Close() error {
	return s.db.Close()
}
```

`Close` is not on `Store`: the interface describes operations on tasks, not
lifecycle, and only some stores have a handle to release. The tests call it
through `t.Cleanup`, so the file is closed even when a case fails.

## Add writes two tables as one

The task row and its label rows belong together, so `Add` writes them
inside a **transaction** — a group of writes that either all happen or none
do. The finished app's appendix holds this file in full — read the parts
behind the `...` there as you type them:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // a no-op after Commit

	// A zero Due is no due date: NULL, not the year 1 as text.
	var due any
	if !t.Due.IsZero() {
		due = t.Due.UTC().Format(time.RFC3339)
	}
	res, err := tx.ExecContext(ctx,
		`INSERT INTO tasks (title, status, priority, due) VALUES (?, ?, ?, ?)`,
		t.Title, string(t.Status), int(t.Priority), due)
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}

	...
	for _, tag := range uniqueTags(t.Tags) {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO task_tags (task_id, tag) VALUES (?, ?)`, id, tag); err != nil {
			return task.Task{}, fmt.Errorf("add task: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
	t.ID = int(id)
	return t, nil
```

Every statement uses `?` placeholders: the values travel separately from the
SQL text, so a title containing SQL is data, never instructions. `uniqueTags`
is a small helper defined further down the file: it drops repeated labels
before inserting, because the primary key would reject a repeat. The
deferred `Rollback` makes the transaction safe: fail before the transaction
finishes, and it undoes everything; afterwards, it does nothing.

## Complete asks how many rows changed

`Complete` changes one row's status. The catch: an `UPDATE` that matches no
row is not an error — it is a successful statement that changed zero rows.
So the not-found signal comes from the result. The appendix holds this file
in full — the lines behind the `...` are there as you type them:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
	res, err := s.db.ExecContext(ctx, `UPDATE tasks SET status = ? WHERE id = ?`, string(task.StatusDone), id)
	if err != nil {
		return fmt.Errorf("complete task %d: %w", id, err)
	}
	n, err := res.RowsAffected()
	...
	if n == 0 {
		return fmt.Errorf("complete task %d: %w", id, ErrNotFound)
	}
	return nil
```

`RowsAffected` counts the rows the statement touched. Zero means no task has
that id, and the miss is wrapped in `ErrNotFound` — the same error the
memory store returns, so one test covers both stores.

## Reads share one scanner

The read methods — `List`, `ByStatus`, `ByTag`, `SortByDue` — each run a
query, scan the rows into tasks with one shared helper, and load the labels
with a second query. `SortByDue` is the ordering rule expressed as SQL:

<!-- verify: internal/store/turso.go at=turso -->
```go title="internal/store/turso.go"
// SortByDue returns all tasks sorted by Due ascending, with tasks that have
// no due date last and ties in insertion order. (due IS NULL) is 0 for dated
// tasks and 1 for undated ones, which is what pushes the zero dates to the
// end; due orders the rest; and id breaks ties because IDs are assigned in
// insertion order, the closest the table has to a stored insertion sequence.
func (s *TursoStore) SortByDue(ctx context.Context) ([]task.Task, error) {
	if err := ctxErr(ctx, "sort by due"); err != nil {
		return nil, err
	}
	return s.queryTasks(ctx, "sort by due",
		`SELECT `+tursoTaskColumns+` FROM tasks ORDER BY (tasks.due IS NULL), tasks.due, tasks.id`)
}
```

`(due IS NULL)` is 0 for a task with a due date and 1 for one without, so
undated tasks sort last; dates are stored as UTC text, where text order is
date order; and `id` breaks ties in insertion order.

The scanner keeps "no due date" distinct from "a date" by reading the
column into a nullable string and parsing it only when it holds a value.
Every read method starts with the `ctxErr` check, so a canceled call fails
before the database is touched.

## Pin the driver

The import names the driver, but Go still has to fetch it. From the app's
root folder:

```bash
$ go get turso.tech/database/tursogo@v0.8.3
```

The `@v0.8.3` pins the exact version. The command downloads the driver, its
platform library, and the purego bridge, and writes them into `go.mod`:

<!-- verify: go.mod at=turso -->
```text title="go.mod"
require (
	...
	turso.tech/database/tursogo v0.8.3
)
```

The driver lands in the first block — the dependencies the app asks for
directly. Below it, marked `// indirect`, are the modules those packages
need in turn. `turso-go-platform-libs` carries the engine itself — the
reason the download is large.

## Run it again

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/store	0.063s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
```

Every package passes on the first run. The suite ran twice — once per store
— and passed both times, so the database answers exactly like memory.

## Prove it needs no C compiler

The default build uses cgo when a C compiler is available; the driver
doesn't need it. Ask what the default is, then build and test with the
compiler switched off:

```bash
$ echo "default CGO_ENABLED=$(go env CGO_ENABLED)"
$ CGO_ENABLED=0 go build ./...
$ CGO_ENABLED=0 go test -count=1 ./internal/store
```

```text
default CGO_ENABLED=1
ok  	todo/internal/store	0.040s
```

The first command says the machine's default is 1 — cgo is on. The next two
still succeed with it forced off: the whole app builds, and the store's
tests pass. That's the driver's promise kept: the C toolchain is gone from
the build.

## If something went wrong

**`sql: unknown driver "sqlite" (forgotten import?)`.** You tried to open
the database by name with `sql.Open("sqlite", ...)`. A driver registers its
name when its package is imported, and this driver's name is `turso`. The
store doesn't open by name at all — it builds the connector with
`turso.NewConnector`.

**`list tasks: turso: error: Parse error: no such table: tasks`.** You
opened the store with `":memory:"` and then something forced a second
connection. Every connection to `:memory:` opens its own private, empty
database, so the new connection has no tables. The store pins one
connection, so `:memory:` works until the pool grows. Use a file, as the
conformance runner does.

**A copied SQLite DSN configures nothing.** You opened with a DSN carrying
`_pragma=...` and the readback said:

```text
open: ok
journal_mode=wal busy_timeout=5000 foreign_keys=0
```

The open succeeded and nothing was set: this driver's DSN parser knows only
its own keys and silently ignores the rest. Carry `_busy_timeout` in the
DSN and everything else where it takes effect.

**Copying only `tasks.db` loses the data.** You wrote a task, closed the
store, copied the one file, and asked the copy:

```text
copy holds 0 task(s)
```

The changes live in the sidecar file next to it — the WAL journal — and the
main file alone is not the whole database. The app's export file is the
safe copy.

<details>
<summary>Going deeper: one connection at a time</summary>

`database/sql` normally keeps a pool of connections and hands one to each
caller. The store pins the pool to a single connection because the engine
allows one writer at a time. A second writer would wait for the lock and
then fail; one connection turns contention into a queue. The cost is real:
a read waits behind a write. Later in the book the store raises the pool
and turns on the engine's concurrent-writer mode.

</details>

<details>
<summary>Going deeper: the engine that unpacks itself</summary>

The platform library module embeds Turso's engine for every supported
system. The first time a program opens a store, the engine is extracted to a
cache directory — `$TURSO_GO_CACHE_DIR` if set, otherwise a folder under
your home directory — so opening a database needs a writable place to unpack
into.

A binary that opens the store carries the library, so it is far larger than
the CLI, which still uses the in-memory store. And the cgo-free binary is
still linked against the C runtime, because purego imports a few symbols
from it at run time. The C compiler is gone from the build, not C's runtime
from the machine.

</details>

<details>
<summary>Going deeper: why the suite sorts labels before comparing</summary>

The database stores labels as rows in a table with no order column; memory
keeps them in the task's slice, in insertion order, repeats and all. The
contract treats labels as a set — a repeated label counts once — so the
suite normalizes both sides before comparing whole tasks:

<!-- verify: internal/store/storetest/suite.go at=turso -->
```go title="internal/store/storetest/suite.go"
// canonical returns t with its tags deduplicated and sorted. The Store
// contract treats a task's tags as a set — CountByTag counts a repeated tag
// once, and Turso's task_tags table has no order column — so conformance
// comparisons normalize tag order instead of pinning what the contract
// leaves free.
func canonical(t task.Task) task.Task {
	t.Tags = slices.Compact(slices.Sorted(slices.Values(t.Tags)))
	return t
}
```

The counting rule stays pinned exactly, because both stores satisfy it.

</details>

The tasks can outlive the program now. Next, the schema stops being a
constant in the code and becomes a series of steps the app can replay.

<div class="day-tracker" data-day="24"></div>
