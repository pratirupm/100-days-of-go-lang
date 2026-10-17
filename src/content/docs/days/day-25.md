---
title: "Day 25 — Database migrations"
description: "Move the schema out of the code and into numbered migration files that goose applies every time the store opens. — Day 25 of 100 Days of Go Lang."
sidebar:
  order: 25
chapter: 21
---

**About 3 hours** · Part V, day 3 of 6.

**You'll be able to:**

- write SQL migrations, embed them in the binary, and apply them at boot;
- keep a golden schema that fails when the shape drifts.

---

The schema — the database's tables and their columns — currently lives in two constants in `turso.go`, and every open recreates it from them. That is enough while there is one shape and nothing to preserve.

But a database outlives the program that made it. The file on disk holds tasks a person typed, and later versions of the app will want new columns and new tables. A file with data in it cannot be deleted and rebuilt; it has to be brought forward carefully.

So the schema moves out of the code and into **migrations**: numbered recipes for changing the database's shape, each applied once, in order. A tool called goose reads the recipes. Opening the store applies whatever is pending, and a test compares the shape the database serves with a recorded file, so a change nobody meant cannot slip through.

## What a migration is

A **migration** is a recipe for one change to a database's shape, written down in a file and applied in order. Ours are written in SQL, the language databases speak; a database change becomes something a person writes down, numbers, and applies once.

The number is the file's position in the sequence: `00001_init.sql` is the first recipe, and a later change arrives as `00002_...`. Each file has two directions. The forward section applies the change; the reverse section undoes it. goose finds them by their opening comments, `-- +goose Up` and `-- +goose Down`.

goose also keeps a small table of its own, `goose_db_version`, with one row per recipe it has applied. On each run it reads the table, applies what is missing, and records what it did. That is what makes opening safe to repeat: an up-to-date database gets no work, a brand-new file gets every recipe.

Two rules come with the idea. A recipe that has already run is never edited: goose records version numbers, not file contents, so a database that took version 1 will never look at `00001_init.sql` again. And migrations are additive: the schema is extended on top, never rewritten in place.

## The tests come first

The store's tests ask whether tasks survive an open and a close. The new tests ask a different question: what shape does the database serve? They go in a new package, `internal/db`: the store will depend on the migrations, and the migrations will know nothing about the store.

Create the folder `internal/db` and, inside it, `migrate_test.go`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them. It opens with the package and the helper that gives each test its own database:

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	_ "turso.tech/database/tursogo" // registers the "turso" driver with database/sql
)

// ...
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := sql.Open("turso", filepath.Join(t.TempDir(), "tasks.db")+"?_busy_timeout=5000")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	return sqlDB
}
```

`openTestDB` opens a fresh file inside a folder the test owns and registers the file's cleanup, so every test starts from nothing. The import with the blank name, `_`, registers the Turso driver without giving us a name to call.

Next, the helpers that interrogate a migrated database:

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
// ...
func tableNames(t *testing.T, sqlDB *sql.DB) []string {
	t.Helper()
	rows, err := sqlDB.Query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()

	var names []string
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		if strings.HasPrefix(name, "goose") || strings.HasPrefix(name, "__turso_internal_") {
			continue
		}
		names = append(names, name)
	}
	require.NoError(t, rows.Err())
	return names
}
```

`tableNames` asks the database to list its tables and drops two families of names: goose's own bookkeeping and Turso's internal tables, which begin with `__turso_internal_`. One name that looks like neither stays in the list — `sqlite_sequence`, the engine's own record for `AUTOINCREMENT` columns.

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
func applicationTables(t *testing.T, sqlDB *sql.DB) []string {
	t.Helper()
	var tables []string
	for _, name := range tableNames(t, sqlDB) {
		if name == "sqlite_sequence" {
			continue
		}
		tables = append(tables, name)
	}
	return tables
}

// schemaVersion returns the highest applied migration version.
func schemaVersion(t *testing.T, sqlDB *sql.DB) int64 {
	t.Helper()
	var version int64
	require.NoError(t, sqlDB.QueryRow(`SELECT MAX(version_id) FROM goose_db_version`).Scan(&version))
	return version
}
```

`applicationTables` is the same list with `sqlite_sequence` removed: the tables the migrations declare. `schemaVersion` reads the highest version goose has recorded.

Then the function the golden comparison is built on. It dumps the schema the database serves, table by table:

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
func dumpSchema(t *testing.T, sqlDB *sql.DB) string {
	t.Helper()
	var b strings.Builder
	for i, table := range applicationTables(t, sqlDB) {
		if i > 0 {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "table %s\n", table)

		rows, err := sqlDB.Query(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`, table)
		require.NoError(t, err)
		for rows.Next() {
```

The query is a **pragma** — the database's word for a question about its own shape. `pragma_table_info` answers with each column's name, type, whether it allows NULL, its default, and its place in the primary key.

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
			var (
				name    string
				typ     string
				notNull int
				dflt    sql.NullString
				pk      int
			)
			require.NoError(t, rows.Scan(&name, &typ, &notNull, &dflt, &pk))
			fmt.Fprintf(&b, "  %s", name)
			if typ != "" {
				fmt.Fprintf(&b, " %s", typ)
			}
			if notNull == 1 {
				b.WriteString(" NOT NULL")
			}
			if dflt.Valid {
				fmt.Fprintf(&b, " default %s", dflt.String)
			}
			if pk > 0 {
				fmt.Fprintf(&b, " pk=%d", pk)
			}
			b.WriteString("\n")
		}
```

Each answer becomes one line of text: the name, the type, `NOT NULL` when the column requires a value, `default` when it has one, and `pk=` when it is part of the primary key. This is the text a person reads in `schema.sql`.

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
		require.NoError(t, rows.Err())
		require.NoError(t, rows.Close())

		fkRows, err := sqlDB.Query(`SELECT "table", "from", "to", on_update, on_delete, match FROM pragma_foreign_key_list(?)`, table)
		require.NoError(t, err)
		for fkRows.Next() {
			var (
				refTable string
				from     string
				to       string
				onUpdate string
				onDelete string
				match    string
			)
			require.NoError(t, fkRows.Scan(&refTable, &from, &to, &onUpdate, &onDelete, &match))
			fmt.Fprintf(&b, "  foreign key (%s) references %s (%s) on update %s on delete %s match %s\n",
				from, refTable, to, onUpdate, onDelete, match)
		}
		require.NoError(t, fkRows.Err())
		require.NoError(t, fkRows.Close())
	}
	return b.String()
}
```

The second query does the same for foreign keys — the pointers from one table's rows to another's — and `dumpSchema` returns the whole picture as one string.

Now the three tests. The first walks one database through the full cycle:

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
// ...
func TestUpDownUp(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	sqlDB := openTestDB(t)

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, []string{"sqlite_sequence", "task_tags", "tasks"}, tableNames(t, sqlDB))

	require.NoError(t, Down(ctx, sqlDB))
	assert.Equal(t, []string{"sqlite_sequence"}, tableNames(t, sqlDB))

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, []string{"sqlite_sequence", "task_tags", "tasks"}, tableNames(t, sqlDB))
}
```

`Up` builds both tables, `Down` removes them, and a second `Up` builds them again. The list at each step is the proof: after `Down`, only `sqlite_sequence` remains — the application's tables are gone, while goose's bookkeeping and the engine's compat table stay.

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
// ...
func TestUp_Idempotent(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	sqlDB := openTestDB(t)

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(1), schemaVersion(t, sqlDB))

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(1), schemaVersion(t, sqlDB))
}
```

The second test runs `Up` twice and reads the version after each run: applying twice must leave the database exactly where applying once did.

<!-- verify: internal/db/migrate_test.go at=migrations -->
```go title="internal/db/migrate_test.go"
// ...
func TestMigratedSchemaMatchesGolden(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	sqlDB := openTestDB(t)
	require.NoError(t, Up(ctx, sqlDB))

	got := dumpSchema(t, sqlDB)

	if os.Getenv("UPDATE_SCHEMA") != "" {
		require.NoError(t, os.WriteFile("schema.sql", []byte(got), 0o600))
		t.Logf("wrote schema.sql")
		return
	}

	want, err := os.ReadFile("schema.sql")
	require.NoError(t, err, "read the golden schema; regenerate it with: make schema-update")
	if diff := cmp.Diff(string(want), got); diff != "" {
		t.Errorf("migrated schema differs from schema.sql (-golden +migrated):\n%s\nregenerate it with: make schema-update", diff)
	}
}
```

The third test is the one that keeps everyone honest. It migrates a fresh database, dumps the schema, and compares it with the file `schema.sql`, character for character. When `UPDATE_SCHEMA` is set, it writes the file instead of comparing — the deliberate path for a change you meant. The message names the shortcut for regeneration; we run the command itself later.

Two more edits, in the store's tests. The constructor is about to take a context — applying migrations can fail and can be interrupted, so it belongs with the methods — and the tests move first. In `internal/store/conformance_test.go`, add `context` to the imports and change the call to:

<!-- verify: internal/store/conformance_test.go at=migrations -->
```go title="internal/store/conformance_test.go"
			s, err := store.NewTursoStore(context.Background(), filepath.Join(t.TempDir(), "tasks.db"))
```

In `internal/store/turso_test.go`, all four calls gain `context.Background()` the same way, the `:memory:` one included:

<!-- verify: internal/store/turso_test.go at=migrations -->
```go title="internal/store/turso_test.go"
	s, err := NewTursoStore(context.Background(), ":memory:")
```

All five call sites now name the context. Run everything:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/db [todo/internal/db.test]
internal/db/migrate_test.go:160:21: undefined: Up
internal/db/migrate_test.go:163:21: undefined: Down
internal/db/migrate_test.go:166:21: undefined: Up
...
internal/db/migrate_test.go:193:21: undefined: Up
# todo/internal/store [todo/internal/store.test]
internal/store/turso_test.go:32:48: too many arguments in call to NewTursoStore
	have (context.Context, string)
	want (string)
...
ok  	todo/cmd/todo	0.002s
FAIL	todo/internal/db [build failed]
FAIL	todo/internal/store [build failed]
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
FAIL
```

Two classes of error, and the compiler is the checklist. `undefined: Up` — and `Down` — means the package the tests describe doesn't exist yet: six complaints in all. `too many arguments in call to NewTursoStore` counts the new first parameter; the tests moved to the new shape before the store did. Once this internal test file compiles, the external one reports the same arity error at its own call site. Your line numbers will differ; the shapes will not.

## Write the migration

Now the recipe itself. Create the folder `internal/db/migrations` and, inside it, `00001_init.sql`:

<!-- verify: internal/db/migrations/00001_init.sql at=migrations -->
```sql title="internal/db/migrations/00001_init.sql"
-- +goose Up
CREATE TABLE tasks (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	title    TEXT NOT NULL,
	status   TEXT NOT NULL,
	priority INTEGER NOT NULL,
	due      TEXT
);

CREATE TABLE task_tags (
	task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	tag     TEXT NOT NULL,
	PRIMARY KEY (task_id, tag)
);

-- +goose Down
DROP TABLE IF EXISTS task_tags;
DROP TABLE IF EXISTS tasks;
```

The forward half creates both tables: `tasks`, with a column per field, and `task_tags`, one row per task-and-label pair. The pair is the primary key, so a repeated label is impossible, and `REFERENCES tasks(id) ON DELETE CASCADE` ties each label row to its task — delete the task, and its label rows go with it. The reverse half drops both, child first.

One difference from the constants stands out: no `IF NOT EXISTS`. That is deliberate. This recipe runs exactly once per database, and a database that already has the tables but no version row should be looked at by a person, not silently skipped. The "If something went wrong" section shows what that failure looks like.

## The package that applies it

Create `internal/db/migrate.go`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them. It opens with the package's name, its imports, and one line that looks like a comment but is an instruction to the Go tool:

<!-- verify: internal/db/migrate.go at=migrations -->
```go title="internal/db/migrate.go"
// Package db owns the database schema. The migrations are embedded in the
// binary and applied by goose, so a running binary always carries the schema
// it needs: there are no migration files to ship next to it and no separate
// migrate step before boot.
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sync"

	"github.com/pressly/goose/v3"
)

// migrationsFS is the embedded migrations directory. The pattern is relative
// to this file, and the FS keeps the directory name as its root:
// ...
//
//go:embed migrations/*.sql
var migrationsFS embed.FS
```

`//go:embed migrations/*.sql` compiles the SQL files into the program, so the binary carries its own schema: no `.sql` files to copy when the app moves, no separate step before the store opens. The pattern is relative to the file that holds it, which is why the directory is reached as `migrations`.

Next, the one-time setup:

<!-- verify: internal/db/migrate.go at=migrations -->
```go title="internal/db/migrate.go"
// ...
var (
	initOnce sync.Once
	initErr  error
)

// ...
func configure() error {
	initOnce.Do(func() {
		goose.SetBaseFS(migrationsFS)
		goose.SetLogger(goose.NopLogger())
		initErr = goose.SetDialect("sqlite3")
	})
	return initErr
}
```

`configure` does three things, once. It points goose at the embedded files, picks the dialect — the name of the SQL flavor the database speaks — `sqlite3`, which is what Turso speaks, and installs goose's silent logger: a library opening a database is not an event worth printing about. All three settings live for the whole program, so they run inside `sync.Once`: the first caller does the work, and every later caller reuses the result.

Then the three functions the store and the tests use:

<!-- verify: internal/db/migrate.go at=migrations -->
```go title="internal/db/migrate.go"
// ...
func Up(ctx context.Context, sqlDB *sql.DB) error {
	if err := configure(); err != nil {
		return fmt.Errorf("migrate up: %w", err)
	}
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}
```

`Up` applies whatever is pending. On a fresh file that is the whole recipe; on an up-to-date file, nothing — which is what makes it safe as an open-time step.

<!-- verify: internal/db/migrate.go at=migrations -->
```go title="internal/db/migrate.go"
// ...
func Down(ctx context.Context, sqlDB *sql.DB) error {
	if err := configure(); err != nil {
		return fmt.Errorf("migrate down: %w", err)
	}
	if err := goose.ResetContext(ctx, sqlDB, "migrations"); err != nil {
		return fmt.Errorf("migrate down: %w", err)
	}
	return nil
}
```

`Down` rolls every migration back, leaving an empty database. It calls `ResetContext` rather than `DownContext`, because goose's `DownContext` rolls back exactly one recipe, and the promise here is "empty" — a promise that has to keep holding as recipes are added.

:::caution
`Down` drops both tables — every task, gone. It exists for development and tests, where an empty database is how the next `Up` is proven. Undoing a shipped recipe is a person's decision, written on purpose, usually as the next migration.
:::

<!-- verify: internal/db/migrate.go at=migrations -->
```go title="internal/db/migrate.go"
// ...
func UpTo(ctx context.Context, sqlDB *sql.DB, version int64) error {
	if err := configure(); err != nil {
		return fmt.Errorf("migrate up to %d: %w", version, err)
	}
	if err := goose.UpToContext(ctx, sqlDB, "migrations", version); err != nil {
		return fmt.Errorf("migrate up to %d: %w", version, err)
	}
	return nil
}
```

`UpTo` stops at a given version instead of the latest. Nothing calls it yet; it is there for a recipe later in the book that needs to put a database at an older shape and then migrate it forward.

## The golden schema

The comparison file is written by hand once and guarded from then on. Create `internal/db/schema.sql`:

<!-- verify: internal/db/schema.sql at=migrations -->
```text title="internal/db/schema.sql"
table task_tags
  task_id INTEGER NOT NULL pk=1
  tag TEXT NOT NULL pk=2
  foreign key (task_id) references tasks (id) on update NO ACTION on delete CASCADE match NONE

table tasks
  id INTEGER pk=1
  title TEXT NOT NULL
  status TEXT NOT NULL
  priority INTEGER NOT NULL
  due TEXT
```

This is the functional shape of the two tables, not the `CREATE TABLE` text the database stores. The dump was built this way on purpose — the last box says why.

## Move the store onto migrations

The store is next. Delete the two constants that hold the `CREATE TABLE` statements and the loop that ran them, and add `todo/internal/db` to `turso.go`'s imports, beside `todo/internal/task`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them. Then change the constructor to:

<!-- verify: internal/store/turso.go at=migrations -->
```go title="internal/store/turso.go"
// ...
func NewTursoStore(ctx context.Context, path string) (*TursoStore, error) {
	connector, err := turso.NewConnector(tursoDSN(path))
	if err != nil {
		return nil, fmt.Errorf("open turso store %s: %w", path, err)
	}
	// ...
	sqlDB := sql.OpenDB(&pragmaConnector{
		base:    connector,
		pragmas: []string{"PRAGMA foreign_keys(1)"},
	})

	// ...
	sqlDB.SetMaxOpenConns(1)

	// ...
	// The schema is not created here: the embedded migrations are the one
	// place the DDL lives, and goose applies whatever is pending. ctx
	// governs that step, so a canceled boot aborts before serving.
	if err := db.Up(ctx, sqlDB); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("open turso store %s: %w", path, err)
	}
	return &TursoStore{db: sqlDB}, nil
}
```

Four things changed. The constructor takes `ctx` first, because opening now does work that can be canceled. The local variable that held the database handle is renamed `sqlDB` — if it stayed `db`, that name would be the variable, not the package we just wrote, and `db.Up` would not compile. The constants and their loop are gone; in their place, one call — `db.Up(ctx, sqlDB)` — with the handle closed if it fails. A store that exists is a store whose schema is current.

## Add goose and run everything

goose is not in the project yet. From the app's root folder:

<!-- transcripts: authored -->
```bash
$ go get github.com/pressly/goose/v3@v3.29.0
```

Confirm the version:

```bash
$ go list -m github.com/pressly/goose/v3
github.com/pressly/goose/v3 v3.29.0
```

`go get` adds goose to `go.mod`, the file that records the project's dependencies, and pulls in the few small libraries it needs.

Then run everything:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/db	0.024s
ok  	todo/internal/store	0.059s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
```

Every package passes. The new package's three tests migrate real files; the store's suites now migrate their temp databases on every open and pass unchanged; and `cmd/todo` still wires the memory store, so the CLI never touches a database file yet.

goose is pure Go, so the no-cgo build from the database work still holds.

## When the schema changes on purpose

One routine is worth doing once now: how the golden is regenerated. When a schema change is intended, the file is rewritten, never hand-edited:

```bash
$ UPDATE_SCHEMA=1 go test -run TestMigratedSchemaMatchesGolden ./internal/db
```

```text
ok  	todo/internal/db	0.020s
```

Run against the current tree it changes nothing — the file comes back exactly as it was, which is why the command prints a plain pass. The point of the routine is the other case: change a migration without regenerating the golden, and the comparison fails with a diff that names what moved:

```text
--- FAIL: TestMigratedSchemaMatchesGolden (0.02s)
    migrate_test.go:206: migrated schema differs from schema.sql (-golden +migrated):
          ...
        - 	" NOT NULL",
          ...
        regenerate it with: make schema-update
FAIL
FAIL	todo/internal/db	0.019s
FAIL
```

Read the last line first: it names the regeneration step, the shortcut for the command above. The `-` side is the golden file; the `+` side is what the migrations now serve. If the change was meant, the regenerated file is the record of it; if it wasn't, the failing test just caught it.

The message's last line — `regenerate it with: make schema-update` — names a shortcut. The `Makefile` keeps the project's long commands under names, and the golden's regeneration earns one now. Add the recipe to the `Makefile`, with the comment that says when to reach for it:

<!-- verify: Makefile at=migrations -->
```make title="Makefile"
# schema-update rewrites the schema golden from the embedded migrations, for
# the one case the drift check cannot decide for you: a schema change you
# made on purpose.
schema-update:
	UPDATE_SCHEMA=1 go test -run TestMigratedSchemaMatchesGolden ./internal/db
```

The test's failure message has been naming `make schema-update` since it was written; now the name is a recipe that exists. `make schema-update` runs the `UPDATE_SCHEMA=1` line from above, so the message's last line is a command you can run.

## If something went wrong

**The build stops on the goose import.**

```text
# todo/internal/db
internal/db/migrate_test.go:12:2: no required module provides package github.com/pressly/goose/v3; to add it:
	go get github.com/pressly/goose/v3
FAIL	todo/internal/db [setup failed]
FAIL
```

Go cannot find goose, so the package never reaches the compiler. The file and
line at the start of the message are wherever the import lives — in your tree
that is `internal/db/migrate.go`. Run the `go get` command above, then the
tests again.

**A database created by the old constructor.** The old constructor created the tables without recording a version. goose now tries to run `00001_init.sql` on a database that already has the tables, and the engine refuses:

```text
first open: open turso store /tmp/legacyprobe3569638994/legacy.db: migrate up: ERROR 00001_init.sql: ...
turso: error: Parse error: table tasks already exists
```

That is the loud failure the missing `IF NOT EXISTS` buys. For a development file whose tasks don't matter, delete it and open the store again — the migration builds everything:

```text
after delete and reopen: ok, 0 tasks, version 1
```

For a database whose data matters, tell goose the version already ran, without running it. The failed open already created the version table, so one insert is enough:

```sql
INSERT INTO goose_db_version (version_id, is_applied) VALUES (1, 1);
```

Reopening the store then prints:

```text
baselined to version 1
second open: ok, 0 tasks
```

That is called baselining — stamping the version whose schema the database already matches. Either way, a person decides; the migration never guesses.

**`Up` on `:memory:` seems to succeed, but the tables are missing.**

```text
Up on the second connection: ok (this connection's database only)
query on the first connection: turso: error: Parse error: no such table: tasks
```

Every connection to `:memory:` opens its own private, empty database. goose migrated the second connection; the caller's first connection stayed empty. Use a file for anything real — the store pins one connection, so `:memory:` happens to work there, but that is a coincidence of the pool size, not a property of migrations.

**A recipe that already ran gets edited.** No message — and that is the problem. goose records version numbers, not file contents: a database that has version 1 recorded will never run `00001_init.sql` again, whatever the file now says, while a fresh database gets the edited version. Two databases quietly hold different shapes. Never edit a recipe that has run; the change is the next numbered file. The golden test is the guard: it migrates a fresh database, so an edited recipe that changes the served schema fails the comparison.

<details>
<summary>Going deeper: why the SQL travels inside the binary</summary>

`//go:embed migrations/*.sql` compiles the migration files into the program. The alternative is shipping `.sql` files next to the binary and pointing goose at a folder on disk — one more thing to copy when the app moves, one more path to get right at boot, and a way for the binary and its files to fall out of step. Embedded, the binary carries the exact schema it was built with.

</details>

<details>
<summary>Going deeper: what the version table remembers</summary>

`goose_db_version` is the reason `Up` is safe to call on every open. goose reads the highest version the database has recorded, compares it with the recipes it carries, and applies only what is newer. The table is the current answer to "which recipes has this database taken", not a log. That is also why the recipes use plain `CREATE TABLE` with no `IF NOT EXISTS`: the version table already prevents a second run, and `IF NOT EXISTS` would instead make a recipe silently do nothing in the one case where a person should look — a database with the tables but no version row.

</details>

<details>
<summary>Going deeper: why the golden is not the database's own text</summary>

The database stores the text of each `CREATE TABLE` it ran, and the dump could have read that text back. But Turso rewrites it: the migration's multi-line statement comes back as one line, with the engine's own quoting and spacing. A golden built from that text would pin the engine's rendering rather than the schema. The pragmas answer with the functional shape instead — columns, constraints, foreign keys — the same answers SQLite gives for the same migration. One thing they cannot see is `AUTOINCREMENT` itself; it shows up in the table listing the first test asserts, not in the golden.

</details>

<details>
<summary>Going deeper: why the one-time setup is wrapped in `sync.Once`</summary>

goose configures itself through package-wide settings — the filesystem, the dialect, the logger — and every caller in the program shares them. `Up` and `Down` can run at the same time: the tests run in parallel, and every store open migrates. Without the guard, a second call could rewrite those settings while another caller is using them. `sync.Once` lets the first caller do the work and hands every later caller the same result and error. The cost: the settings are process-wide, so one package owns them — here, `internal/db` — and every caller goes through its `Up` and `Down`.

</details>

The schema now lives in numbered files the binary carries, and a test guards the shape they serve. Next, the store's hand-written SQL moves out: a tool called sqlc reads this same migration and generates typed Go from queries written as SQL.

<div class="day-tracker" data-day="25"></div>
