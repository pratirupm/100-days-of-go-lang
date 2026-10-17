---
title: "internal/db — the finished app"
description: "The finished app, file by file: internal/db (spoilers)."
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/db/migrate.go`

````go
// Package db owns the database schema and the transaction discipline every
// writer shares. The migrations are embedded in the binary and applied by
// goose, so a running binary always carries the schema it needs: there are no
// migration files to ship next to it and no separate migrate step before
// boot. The generated queries in this package are the only SQL the
// application runs, and every write rides WithConcurrentTx — see tx.go.
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
// migrations/00001_init.sql is reached as "migrations/00001_init.sql", which
// is why Up and Down name "migrations" as the directory below.
//
//go:embed migrations/*.sql
var migrationsFS embed.FS

// goose configures migration discovery, the SQL dialect, and its logger
// through package globals: SetBaseFS, SetDialect, and SetLogger write state
// that every caller in the process shares. This package therefore
// initializes them exactly once, under sync.Once — a second call would
// rewrite the globals under a concurrent Up or Down, while the guard makes
// the first call win and every later one a no-op. The error is stored in
// initErr, and sync.Once gives that write a happens-before edge to every
// read, so all callers see it.
var (
	initOnce sync.Once
	initErr  error
)

// configure points goose at the embedded migrations, selects SQLite as the
// dialect, and installs the quiet logger. The logger is the third global,
// and the one this package owns deliberately: goose's default writes a
// timestamped line to stderr for every migration it applies, but a library
// has no way to tell a test binary from production and no per-call
// configuration to offer — the choice is process-wide either way. Silence
// wins because the package is a library and a store open is not an event it
// should print about; the version table is the durable record of what was
// applied. configure is idempotent and safe for concurrent use.
func configure() error {
	initOnce.Do(func() {
		goose.SetBaseFS(migrationsFS)
		goose.SetLogger(goose.NopLogger())
		initErr = goose.SetDialect("sqlite3")
	})
	return initErr
}

// Up applies all pending migrations. It is the store's open-time step: a
// database at any version — including a brand-new, empty file — is brought
// to the latest schema before the first query runs.
func Up(ctx context.Context, sqlDB *sql.DB) error {
	if err := configure(); err != nil {
		return fmt.Errorf("migrate up: %w", err)
	}
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}

// UpTo applies migrations up to and including version. It exists for tests
// that need a database at an older schema — chapter 23's data-copy migration
// seeds a version-1 database through raw SQL and then migrates it — and
// goose's UpToContext is the library call underneath.
func UpTo(ctx context.Context, sqlDB *sql.DB, version int64) error {
	if err := configure(); err != nil {
		return fmt.Errorf("migrate up to %d: %w", version, err)
	}
	if err := goose.UpToContext(ctx, sqlDB, "migrations", version); err != nil {
		return fmt.Errorf("migrate up to %d: %w", version, err)
	}
	return nil
}

// Down rolls every migration back. Production never calls it: migrations are
// forward-only once shipped, and deleting a schema is a human decision, not
// an open-time behavior. It exists for development and tests, where
// returning to an empty database is how the next Up is proven to work.
func Down(ctx context.Context, sqlDB *sql.DB) error {
	if err := configure(); err != nil {
		return fmt.Errorf("migrate down: %w", err)
	}
	if err := goose.ResetContext(ctx, sqlDB, "migrations"); err != nil {
		return fmt.Errorf("migrate down: %w", err)
	}
	return nil
}
````


## `internal/db/migrate_test.go`

````go
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
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	_ "turso.tech/database/tursogo" // registers the "turso" driver with database/sql
)

// openTestDB opens a fresh Turso database inside a test-owned directory and
// registers its Close. The migrations are what is under test, so the driver
// is opened plainly — no MVCC, no pool pinning — and every test gets a
// database of its own.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := sql.Open("turso", filepath.Join(t.TempDir(), "tasks.db")+"?_busy_timeout=5000")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
	return sqlDB
}

// tableNames returns the tables the engine reports, sorted, with goose's
// version table and Turso's internal sequence tables filtered out. Turso
// materializes AUTOINCREMENT state in visible __turso_internal_seq_* tables
// — one per AUTOINCREMENT table, goose's version table included — where
// SQLite keeps rows in sqlite_sequence; a listing that means "the
// application schema" has to filter them. sqlite_sequence stays: the engine
// keeps the SQLite-compat table alongside, so it is part of what a listing
// sees.
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

// applicationTables returns the tables the migrations declare, sorted: the
// filtered listing minus sqlite_sequence, which no migration creates — it is
// the engine's SQLite-compat bookkeeping for AUTOINCREMENT.
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

// dumpSchema renders the functional schema the migrated database serves: for
// every application table, the columns pragma_table_info reports — name,
// type, NOT NULL, default, primary-key position — followed by the foreign
// keys pragma_foreign_key_list reports, followed by the indexes the
// migrations declared. It deliberately does not read the CREATE text
// sqlite_master stores: Turso normalizes that text (single line, its own
// quoting, a space before the REFERENCES parenthesis), so a text dump would
// pin the engine's rendering of the DDL rather than the schema; the pragmas
// are the functional shape any tool sees. goose's version table, the
// internal sequence tables, and sqlite_sequence are all excluded — none of
// them is schema a migration declares.
//
// The index section (chapter 50) covers origin 'c' — indexes a migration
// declared with CREATE INDEX. The engine's auto-indexes (origin 'pk' and
// 'u') are left out on purpose: their names are the engine's, their shape is
// already visible in the columns dump as pk= and NOT NULL, and pinning
// sqlite_autoindex_* names would pin the engine's bookkeeping rather than
// the schema.
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

		idxRows, err := sqlDB.Query(`SELECT name, "unique" FROM pragma_index_list(?) WHERE origin = 'c'`, table)
		require.NoError(t, err)
		for idxRows.Next() {
			var (
				name   string
				unique int
			)
			require.NoError(t, idxRows.Scan(&name, &unique))
			if unique == 1 {
				fmt.Fprintf(&b, "  unique index %s", name)
			} else {
				fmt.Fprintf(&b, "  index %s", name)
			}
			colRows, err := sqlDB.Query(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`, name)
			require.NoError(t, err)
			first := true
			for colRows.Next() {
				var col string
				require.NoError(t, colRows.Scan(&col))
				if first {
					b.WriteString(" (")
					first = false
				} else {
					b.WriteString(", ")
				}
				b.WriteString(col)
			}
			require.NoError(t, colRows.Err())
			require.NoError(t, colRows.Close())
			b.WriteString(")\n")
		}
		require.NoError(t, idxRows.Err())
		require.NoError(t, idxRows.Close())
	}
	return b.String()
}

// TestUpDownUp walks one database through the full cycle: Up builds both
// application tables, Down removes them and leaves goose's bookkeeping
// behind, and a second Up builds them again. The listing filters Turso's
// internal sequence tables and goose's version table; sqlite_sequence stays
// as the engine's AUTOINCREMENT footprint.
func TestUpDownUp(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	sqlDB := openTestDB(t)

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, []string{"audit_events", "sessions", "sqlite_sequence", "task_tags", "tasks", "users"}, tableNames(t, sqlDB))

	require.NoError(t, Down(ctx, sqlDB))
	assert.Equal(t, []string{"sqlite_sequence"}, tableNames(t, sqlDB))

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, []string{"audit_events", "sessions", "sqlite_sequence", "task_tags", "tasks", "users"}, tableNames(t, sqlDB))
}

// TestUp_Idempotent pins that Up is safe to call on every open: a second run
// applies nothing, reports no error, and leaves the version where it was.
func TestUp_Idempotent(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	sqlDB := openTestDB(t)

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(6), schemaVersion(t, sqlDB))

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(6), schemaVersion(t, sqlDB))
}

// TestMigratedSchemaMatchesGolden is the drift gate: it migrates a fresh
// database, dumps the functional schema Turso serves, and compares it with
// the committed golden file. A migration change that is not accompanied by
// a golden update fails here, which is what makes the migrations — not the
// store — the schema's source of truth.
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

// TestMigration_PreservesRows is the data-copy receipt: it migrates a
// database only to version 1, seeds it through raw SQL with the integer
// schema 00001 created, then runs the rest of the migrations and checks that
// every row and every tag survived the id change. The backfilled ids are
// random — an integer id carries no timestamp, so a v7 id cannot be rebuilt
// from it — and the test asserts shape and identity-by-content rather than
// values: each id parses as a UUID in canonical form, each task keeps its
// title, status, priority, and due, and each tag is still attached to the
// same title. A final insert through the new schema proves fresh rows get
// the v7 ids the store assigns.
func TestMigration_PreservesRows(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	sqlDB := openTestDB(t)

	require.NoError(t, UpTo(ctx, sqlDB, 1))
	assert.Equal(t, int64(1), schemaVersion(t, sqlDB))

	// Seed the old schema by raw SQL: AUTOINCREMENT assigns ids 1 and 2,
	// and the tags only mean anything when they stay attached to the right
	// title.
	_, err := sqlDB.Exec(`
		INSERT INTO tasks (title, status, priority, due) VALUES
			('write tests', 'Todo', 3, '2026-11-01T00:00:00Z'),
			('review code', 'Done', 5, NULL);
		INSERT INTO task_tags (task_id, tag) VALUES
			(1, 'go'), (1, 'book'), (2, 'review'), (2, 'go');
	`)
	require.NoError(t, err)

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(6), schemaVersion(t, sqlDB))

	// Every row survived and every id is a canonical, v4-shaped UUID.
	type taskRow struct {
		id       string
		title    string
		status   string
		priority int64
		due      sql.NullString
		version  int64
		owner    sql.NullString
	}
	rows, err := sqlDB.Query(`SELECT id, title, status, priority, due, version, owner_id FROM tasks ORDER BY title`)
	require.NoError(t, err)

	var got []taskRow
	for rows.Next() {
		var r taskRow
		require.NoError(t, rows.Scan(&r.id, &r.title, &r.status, &r.priority, &r.due, &r.version, &r.owner))
		got = append(got, r)
	}
	require.NoError(t, rows.Err())
	require.NoError(t, rows.Close())
	require.Len(t, got, 2, "the migration preserved both rows")

	want := []taskRow{
		{title: "review code", status: "Done", priority: 5, version: 1},
		{title: "write tests", status: "Todo", priority: 3, due: sql.NullString{String: "2026-11-01T00:00:00Z", Valid: true}, version: 1},
	}
	for i, r := range got {
		parsed, err := uuid.Parse(r.id)
		require.NoError(t, err, "id %q parses as a UUID", r.id)
		assert.Equal(t, r.id, parsed.String(), "the stored text is the canonical form")
		assert.Equal(t, uuid.Version(4), parsed.Version(), "backfilled ids are v4-shaped randoms")
		assert.Equal(t, want[i].title, r.title)
		assert.Equal(t, want[i].status, r.status)
		assert.Equal(t, want[i].priority, r.priority)
		assert.Equal(t, want[i].due, r.due)
		assert.Equal(t, want[i].version, r.version, "a row that predates the column reads back at version 1")
		assert.False(t, r.owner.Valid, "a row that predates ownership belongs to nobody")
	}

	// Tags still point at the same titles.
	tagRows, err := sqlDB.Query(`
		SELECT t.title, tt.tag
		FROM tasks t
		JOIN task_tags tt ON tt.task_id = t.id
		ORDER BY t.title, tt.tag
	`)
	require.NoError(t, err)
	defer func() { _ = tagRows.Close() }()

	var gotTags []string
	for tagRows.Next() {
		var title, tag string
		require.NoError(t, tagRows.Scan(&title, &tag))
		gotTags = append(gotTags, title+" -> "+tag)
	}
	require.NoError(t, tagRows.Err())
	assert.Equal(t, []string{
		"review code -> go",
		"review code -> review",
		"write tests -> book",
		"write tests -> go",
	}, gotTags)

	// A row inserted after the migration gets the id the store would
	// assign it: a v7 the application generated, at the default version.
	v7, err := uuid.NewV7()
	require.NoError(t, err)
	_, err = sqlDB.Exec(
		`INSERT INTO tasks (id, title, status, priority, due) VALUES (?, ?, ?, ?, ?)`,
		v7.String(), "ship it", "Todo", 3, nil,
	)
	require.NoError(t, err)

	var newID string
	var newVersion int64
	require.NoError(t, sqlDB.QueryRow(`SELECT id, version FROM tasks WHERE title = 'ship it'`).Scan(&newID, &newVersion))
	parsedNew, err := uuid.Parse(newID)
	require.NoError(t, err)
	assert.Equal(t, v7, parsedNew, "the stored id round-trips")
	assert.Equal(t, uuid.Version(7), parsedNew.Version(), "fresh rows get v7 ids")
	assert.Equal(t, int64(1), newVersion, "fresh rows default to version 1")
}

// openMVCCDB opens a fresh Turso database with MVCC enabled, the mode the
// store sets on the file before it runs the migrations. The migration tests
// above open the driver plainly; this helper is the receipt that the mode
// the store serves in is also a mode goose's DDL and transactions work in.
func openMVCCDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB := openTestDB(t)
	var mode string
	require.NoError(t, sqlDB.QueryRow(`PRAGMA journal_mode = mvcc`).Scan(&mode))
	require.Equal(t, "mvcc", mode)
	return sqlDB
}

// TestMigration_UnderMVCC pins that goose's migrations behave while the file
// is in MVCC mode: Up, UpTo, Down, and Up again all run as plain
// transactions under MVCC, the ADD COLUMN of 00003 fills existing rows with
// version 1, and its DROP COLUMN in Down is an ALTER Turso accepts — the
// question the migration's Down depends on. The order the store uses is this
// one: journal_mode first, then db.Up, so every migration runs in the mode
// the store will serve in.
func TestMigration_UnderMVCC(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	sqlDB := openMVCCDB(t)

	// Seed a version-2 database — the UUID schema without the version
	// column — and then migrate it under MVCC.
	require.NoError(t, UpTo(ctx, sqlDB, 2))
	assert.Equal(t, int64(2), schemaVersion(t, sqlDB))
	_, err := sqlDB.Exec(
		`INSERT INTO tasks (id, title, status, priority, due) VALUES ('00000000-0000-0000-0000-000000000001', 'write tests', 'Todo', 3, NULL)`,
	)
	require.NoError(t, err)

	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(6), schemaVersion(t, sqlDB))

	var version int64
	require.NoError(t, sqlDB.QueryRow(`SELECT version FROM tasks`).Scan(&version))
	assert.Equal(t, int64(1), version, "ADD COLUMN filled the existing row with the default")

	// Down runs 00003's DROP COLUMN — the ALTER the migration's Down is
	// built on — and Up applies it again, so the cycle leaves the same
	// schema it started from.
	require.NoError(t, Down(ctx, sqlDB))
	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(6), schemaVersion(t, sqlDB))
}
````


## `internal/db/migrations/00001_init.sql`

````sql
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
````


## `internal/db/migrations/00002_uuid_ids.sql`

````sql
-- +goose Up
-- The id era: tasks and task_tags move from INTEGER ids to canonical UUID
-- text. Existing rows cannot get UUIDv7 ids — v7 embeds the creation time in
-- its first 48 bits, and an integer id carries no timestamp to recover — so
-- the backfill assigns random 128-bit ids (the v4 recipe: random bytes, the
-- version nibble pinned to 4, the variant to 10xx) in canonical dashed form.
-- Rows inserted after this migration get v7 ids from the application. The
-- dashes are load-bearing: the store round-trips ids through
-- uuid.UUID.String(), and the engine compares WHERE id = ? byte for byte, so
-- a dashless id would never match its canonical form.
--
-- The copy is a rename dance because SQLite cannot change a column's type in
-- place and tasks.id is the primary key: a mapping table records old id ->
-- new id, the new tables are filled through joins, the old tables are dropped
-- child-first, and the renames leave the engine to rewrite the foreign-key
-- reference in the stored schema — verified against Turso's
-- pragma_foreign_key_list, not assumed.
CREATE TEMP TABLE id_map (
	old_id INTEGER PRIMARY KEY,
	new_id TEXT NOT NULL
);

INSERT INTO id_map (old_id, new_id)
WITH r AS (
	SELECT id AS old_id, lower(hex(randomblob(16))) AS h FROM tasks
)
SELECT
	old_id,
	substr(h, 1, 8) || '-' ||
	substr(h, 9, 4) || '-' ||
	'4' || substr(h, 14, 3) || '-' ||
	'8' || substr(h, 18, 3) || '-' ||
	substr(h, 21, 12)
FROM r;

CREATE TABLE tasks_new (
	id       TEXT PRIMARY KEY NOT NULL,
	title    TEXT NOT NULL,
	status   TEXT NOT NULL,
	priority INTEGER NOT NULL,
	due      TEXT
);

CREATE TABLE task_tags_new (
	task_id TEXT NOT NULL REFERENCES tasks_new(id) ON DELETE CASCADE,
	tag     TEXT NOT NULL,
	PRIMARY KEY (task_id, tag)
);

INSERT INTO tasks_new (id, title, status, priority, due)
SELECT m.new_id, t.title, t.status, t.priority, t.due
FROM tasks t
JOIN id_map m ON m.old_id = t.id;

INSERT INTO task_tags_new (task_id, tag)
SELECT m.new_id, tt.tag
FROM task_tags tt
JOIN id_map m ON m.old_id = tt.task_id;

-- Child first: no tag row outlives the parent it points at.
DROP TABLE task_tags;
DROP TABLE tasks;

-- The engine rewrites the REFERENCES tasks_new(id) in task_tags_new's stored
-- schema when the renamed table is the one it names, so the foreign key
-- follows the rename without an edit.
ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE task_tags_new RENAME TO task_tags;

DROP TABLE id_map;

-- +goose Down
-- The reverse is a rebuild, not a time machine. The original integer ids were
-- only ever stored in the dropped table, so there is nothing to restore them
-- from; this recreates the integer schema and assigns fresh sequential ids in
-- the order the UUIDs sort (which, for v7 ids, is creation order). Tags are
-- re-attached through a mapping built the same way, so a task keeps its tags
-- even though its number changed. A client that memorized an integer id from
-- before the migration cannot get it back.
CREATE TEMP TABLE id_map (
	new_id TEXT PRIMARY KEY NOT NULL,
	old_id INTEGER NOT NULL
);

INSERT INTO id_map (new_id, old_id)
SELECT id, ROW_NUMBER() OVER (ORDER BY id)
FROM tasks;

CREATE TABLE tasks_old (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	title    TEXT NOT NULL,
	status   TEXT NOT NULL,
	priority INTEGER NOT NULL,
	due      TEXT
);

CREATE TABLE task_tags_old (
	task_id INTEGER NOT NULL REFERENCES tasks_old(id) ON DELETE CASCADE,
	tag     TEXT NOT NULL,
	PRIMARY KEY (task_id, tag)
);

INSERT INTO tasks_old (id, title, status, priority, due)
SELECT m.old_id, t.title, t.status, t.priority, t.due
FROM tasks t
JOIN id_map m ON m.new_id = t.id;

INSERT INTO task_tags_old (task_id, tag)
SELECT m.old_id, tt.tag
FROM task_tags tt
JOIN id_map m ON m.new_id = tt.task_id;

DROP TABLE task_tags;
DROP TABLE tasks;

ALTER TABLE tasks_old RENAME TO tasks;
ALTER TABLE task_tags_old RENAME TO task_tags;

DROP TABLE id_map;
````


## `internal/db/migrations/00003_task_version.sql`

````sql
-- +goose Up
-- The optimistic-concurrency era: every task carries a version, bumped by
-- the store on each write, so a caller's write can be rejected when the task
-- changed since the caller read it. This is an additive migration — unlike
-- 00002's copy dance, no data moves and no row is rewritten: ADD COLUMN
-- appends the column and every existing row reads back at the default, 1,
-- which is the version Add assigns to new rows. The version is what the
-- compare-and-swap compares, so a row without one could never be completed;
-- NOT NULL DEFAULT 1 is what makes that state unrepresentable.
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- +goose Down
-- Undoing an ADD COLUMN is a DROP COLUMN, and the row data is untouched: the
-- versions were the only thing the column carried, and the schema without it
-- is exactly the schema 00002 left. Verified against Turso, which supports
-- DROP COLUMN in both WAL and MVCC modes (TestUpDownUp cycles through it).
ALTER TABLE tasks DROP COLUMN version;
````


## `internal/db/migrations/00004_users_and_sessions.sql`

````sql
-- +goose Up
-- The auth era: users and sessions. Two tables, and each one's key is a
-- decision. users.id is a UUIDv7 text id, like every other row this
-- application writes, and email carries a UNIQUE constraint the service
-- reads as a sentinel: registration inserts with ON CONFLICT DO NOTHING, and
-- zero rows changed means the address is taken. Emails are stored
-- normalized — trimmed and lowercased by the service — so the plain,
-- case-sensitive comparison of TEXT UNIQUE is exact for every writer; the
-- normalization is the application's job because the column cannot know
-- about it.
--
-- sessions is the scs store table, and its key is a hash: token_hash holds
-- hex(SHA-256(token)), so the raw token — whose only other copy lives in the
-- client's cookie — never reaches the database. data is scs's own
-- gob-encoded payload (the session deadline and the values), and expiry is
-- unix seconds, the instant FindSession compares against, so an expired row
-- is invisible before any sweep runs.
--
-- Instants are unix seconds here, unlike tasks.due: a due date is a calendar
-- date a human typed, which chapter 23 kept as RFC 3339 text, while
-- created_at and expiry are instants compared to "now" — an integer is the
-- honest shape, and it is what the SQL predicates want.
CREATE TABLE users (
	id            TEXT PRIMARY KEY NOT NULL,
	email         TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY NOT NULL,
	data       BLOB NOT NULL,
	expiry     INTEGER NOT NULL
);

-- +goose Down
-- Both tables are leaves: nothing references them and they reference
-- nothing, so dropping them is the whole rollback. The rows are the point of
-- the tables — sessions are disposable by design and users are not — and
-- Down, as chapter 21 established, exists for development and tests, where a
-- clean schema is what the next Up proves itself against.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
````


## `internal/db/migrations/00005_ownership.sql`

````sql
-- +goose Up
-- The ownership era: every task gains an owner, and the owner is a user — or
-- nobody. owner_id references users(id), and NULL is a real value: the
-- user-less scope, the local CLI's tasks. Every row that existed before this
-- migration is NULL-owned on purpose — nothing is claimed by a user who did
-- not create it, and the CLI's existing task list keeps working exactly as it
-- did. The API is the per-user surface from here on: its queries pin owner_id
-- to the session user, so an ownerless task is invisible to every user and a
-- user's task is invisible to every other user.
--
-- The index is the scoping access path: every task query carries owner_id in
-- its WHERE clause from this chapter on, and chapter 50's EXPLAIN work is
-- where the planner's use of it gets measured.
--
-- users gains the admin flag: the local operator's grant command flips it,
-- and chapter 46's server-side admin bootstrap is where the flag starts to
-- guard something.
--
-- audit_events is the auth trail: one row per happening this chapter audits —
-- register, login, logout, and grant. A table, not log records, because the
-- trail must outlive the process and be queryable next to the rows it is
-- about; the chapter notes carry the trade-off. user_id is the user the event
-- concerns; actor_id is who performed it, NULL when that is nobody — the
-- local CLI is not a user. The foreign keys keep the trail pointing at real
-- accounts, and nothing cascades: an account with a history cannot be deleted
-- without a decision.
CREATE TABLE audit_events (
    id         TEXT PRIMARY KEY NOT NULL,
    action     TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id),
    actor_id   TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
);

-- The owner column arrives nullable, which is also the only shape ALTER TABLE
-- ADD COLUMN with a REFERENCES clause admits under foreign keys: existing
-- rows read back as NULL — unowned.
ALTER TABLE tasks ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX tasks_owner_id ON tasks(owner_id);

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- +goose Down
-- Undoing the column is a rebuild, not a DROP COLUMN: SQLite refuses to drop
-- a column a foreign key names ("unknown column owner_id in foreign key
-- definition"), so tasks is rebuilt without it, the way 00002's Down rebuilt
-- the id columns. The tags ride along in a temp table: dropping the old tasks
-- table cascades into task_tags, so the parked copy is what re-attaches them
-- to the rebuilt table. The audit trail goes first — it references users —
-- and the flag is a plain DROP COLUMN. Down exists for development and tests
-- (chapter 21), and this one leaves the version-4 schema exactly.
DROP TABLE IF EXISTS audit_events;
ALTER TABLE users DROP COLUMN is_admin;

DROP INDEX IF EXISTS tasks_owner_id;

CREATE TEMP TABLE parked_tags AS SELECT task_id, tag FROM task_tags;

CREATE TABLE tasks_rebuilt (
	id       TEXT PRIMARY KEY NOT NULL,
	title    TEXT NOT NULL,
	status   TEXT NOT NULL,
	priority INTEGER NOT NULL,
	due      TEXT,
	version  INTEGER NOT NULL DEFAULT 1
);

INSERT INTO tasks_rebuilt (id, title, status, priority, due, version)
SELECT id, title, status, priority, due, version FROM tasks;

-- Child first: the cascade empties task_tags, and the parked rows are the
-- copy that restores it after the rename.
DROP TABLE tasks;
ALTER TABLE tasks_rebuilt RENAME TO tasks;

INSERT INTO task_tags (task_id, tag)
SELECT task_id, tag FROM parked_tags;

DROP TABLE parked_tags;
````


## `internal/db/migrations/00006_task_tags_tag_index.sql`

````sql
-- +goose Up
-- The tag access path. ListTasksByTag joins task_tags on tag = ?, and
-- without an index the engine has no way to find the matching rows: the
-- query plan is a full scan of task_tags — every tag row of every task in
-- the database — before the join even starts. The composite primary key
-- (task_id, tag) cannot serve the lookup: its first column is task_id, and
-- the query does not know the ids it wants until the tags are found. This
-- index turns the scan into a seek.
--
-- It is the only index the tag table gets. The other tag queries —
-- CountTasksByTag, ListTags, ListTagsForTasks — drive from the tasks side
-- or from ids the store already has, and their plans (chapter 50's notes
-- carry the EXPLAIN receipts) already use the primary key as a covering
-- index. An index that no plan uses is a write cost for nothing: every tag
-- insert maintains it.
CREATE INDEX task_tags_tag ON task_tags(tag);

-- +goose Down
DROP INDEX IF EXISTS task_tags_tag;
````


## `internal/db/plans_test.go`

````go
package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestQueryPlans is chapter 50's plan receipt: it asks the engine for the
// query plan of every task query the store runs, and logs what the engine
// says. It asserts nothing on purpose — a plan is the engine's answer for a
// schema, and pinning the engine's wording in a test would fail on a Turso
// upgrade that changed nothing that matters. What it gives is a rerunnable
// command: the chapter's index work quotes these lines, and a reader who
// changes the schema or a query can see the access paths move.
//
//	CI=true NO_COLOR=true go test -count=1 -v -run TestQueryPlans ./internal/db
//
// The SQL is the generated constants, not a copy: the receipt is the plan of
// the statement the store actually sends.
func TestQueryPlans(t *testing.T) {
	ctx := context.Background()
	sqlDB := openTestDB(t)
	require.NoError(t, Up(ctx, sqlDB))

	queries := []struct {
		name string
		sql  string
	}{
		{"GetTask", getTask},
		{"ListTasks", listTasks},
		{"ListTasksByStatus", listTasksByStatus},
		{"ListTasksByTag", listTasksByTag},
		{"SortTasksByDue", sortTasksByDue},
		{"CountTasksByTag", countTasksByTag},
		{"ListTags", listTags},
		{"ListTagsForTasks", listTagsForTasks},
		{"TaskStats", taskStats},
	}
	for _, q := range queries {
		args := planArgs(q.sql)
		rows, err := sqlDB.QueryContext(ctx, "EXPLAIN QUERY PLAN "+q.sql, args...)
		require.NoError(t, err, "%s must be a preparable statement", q.name)
		for rows.Next() {
			var (
				id, parent, notUsed int
				detail              string
			)
			require.NoError(t, rows.Scan(&id, &parent, &notUsed, &detail))
			t.Logf("%-18s %s", q.name, detail)
		}
		require.NoError(t, rows.Err())
		require.NoError(t, rows.Close())
	}
}

// planArgs counts the parameters the statement declares and returns that many
// nil arguments, because the driver checks the count at prepare time — the
// engine will not parse a statement whose parameters have not been supplied.
// A bare ? takes the next index; ?N names its index directly, so the count is
// the highest index either form reaches. None of the task queries carries a
// question mark inside a string literal, which is the one case a scan like
// this would misread.
func planArgs(sql string) []any {
	max := 0
	for i := 0; i < len(sql); i++ {
		if sql[i] != '?' {
			continue
		}
		n := 0
		for j := i + 1; j < len(sql) && sql[j] >= '0' && sql[j] <= '9'; j++ {
			n = n*10 + int(sql[j]-'0')
		}
		if n == 0 {
			max++
		} else if n > max {
			max = n
		}
	}
	return make([]any, max)
}
````


## `internal/db/queries/auth.sql`

````sql
-- The auth queries: users, sessions, and the audit trail, in sqlc's format. A
-- comment above a -- name: line becomes that method's doc comment in the
-- generated code. Keep this file ASCII, like the task queries: sqlc v1.31.1
-- counts token positions in runes but slices query text in bytes, so one
-- multibyte character above a sqlc.slice query corrupts its generated text.

-- Inserts a user, or reports that the email is taken: ON CONFLICT DO NOTHING
-- turns the unique constraint into a row count, so the caller reads "taken"
-- from the result instead of parsing a constraint error. Zero rows changed
-- means the email already existed. is_admin is not inserted: the column's
-- default is 0, and a registration is never an admin; the CLI's grant is the
-- one way the flag is set.
-- name: CreateUser :execrows
INSERT INTO users (id, email, password_hash, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(email) DO NOTHING;

-- Reads one user by email. Emails are stored normalized, so the caller
-- normalizes before it asks.
-- name: GetUserByEmail :one
SELECT id, email, password_hash, created_at, is_admin
FROM users
WHERE email = ?;

-- Reads one user by id. It is the admin gate's lookup: a session names a
-- user by id, and whether that user carries the admin flag is what decides
-- the profile routes. The read is the primary key's, and it happens on every
-- gated request rather than at login, so a grant or a revoke takes effect on
-- the next request instead of the next login.
-- name: GetUserByID :one
SELECT id, email, password_hash, created_at, is_admin
FROM users
WHERE id = ?;

-- Sets the admin flag of the user with the email and reports how many rows
-- changed: zero rows means no such user, which the caller reads as its own
-- sentinel instead of parsing a driver's error.
-- name: SetUserAdmin :execrows
UPDATE users
SET is_admin = ?
WHERE email = ?;

-- Replaces the stored credential of the user with the email and reports how
-- many rows changed. It is the boot's rotation path (see BootstrapAdmin): a
-- key the stored hash no longer opens replaces it, and the replacement is an
-- argon2id hash like every other stored credential. Zero rows means the user
-- was gone between the read that found it and this write.
-- name: SetUserPassword :execrows
UPDATE users
SET password_hash = ?
WHERE email = ?;

-- Appends one audit event. The table is the trail's only writer's target: the
-- service inserts a row for every happening the chapter audits, in the same
-- transaction as the action when the action is the service's own (a
-- registration, a grant, the boot's bootstrap and rotate) and on its own
-- otherwise (a login, a logout). actor_id is nullable: a grant's actor is the
-- local CLI, which is not a user.
-- name: InsertAuditEvent :exec
INSERT INTO audit_events (id, action, user_id, actor_id, created_at)
VALUES (?, ?, ?, ?, ?);

-- Reads the payload of a live session. The expiry predicate is what makes an
-- expired session invisible to scs, before any sweep runs; expiry is unix
-- seconds.
-- name: FindSession :one
SELECT data
FROM sessions
WHERE token_hash = ? AND expiry > ?;

-- Writes a session row, replacing the data and expiry of an existing token.
-- scs's Commit contract is "add or overwrite", which is what the upsert is.
-- name: UpsertSession :exec
INSERT INTO sessions (token_hash, data, expiry)
VALUES (?, ?, ?)
ON CONFLICT(token_hash) DO UPDATE SET data = excluded.data, expiry = excluded.expiry;

-- Removes a session row. Deleting a token that is not there is a no-op, per
-- scs's Store contract.
-- name: DeleteSession :exec
DELETE FROM sessions
WHERE token_hash = ?;

-- Removes every expired session and reports how many rows went, for the
-- boot-time sweep.
-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions
WHERE expiry <= ?;
````


## `internal/db/queries/tasks.sql`

````sql
-- The queries TursoStore runs, in sqlc's format. A comment above a -- name:
-- line becomes that method's doc comment in the generated code; sqlc checks
-- the SQL against the schema at generation time, so a column that does not
-- exist fails the generate step instead of a test. The generated row structs
-- are database shapes: due is sql.NullString and ids are TEXT, which sqlc
-- types as string, and the store maps them to todo/internal/task types at
-- its own boundary.
--
-- Every task query carries the scope: `owner_id IS sqlc.narg('owner')`, which
-- sqlc types as sql.NullString. IS is SQL's null-safe equality, so the one
-- predicate serves both scopes: a NULL parameter matches the user-less rows
-- (the local CLI's tasks), a user id matches that user's, and a task outside
-- the scope matches no row at all: the store reads and writes only what the
-- scope owns, and a foreign id is indistinguishable from a missing one. The
-- chapter notes carry the 404-not-403 reasoning and the design trade-offs.

-- Inserts a task under the id the store assigned, at the version the store
-- assigned, in the scope the store was opened in: NULL is the local, user-less
-- scope. A zero due is inserted as NULL, not the year 1 as text.
-- name: InsertTask :exec
INSERT INTO tasks (id, title, status, priority, due, version, owner_id)
VALUES (?, ?, ?, ?, ?, ?, sqlc.narg('owner'));

-- Inserts one tag row. The composite primary key rejects a repeated tag, so
-- the store deduplicates before calling this.
-- name: InsertTag :exec
INSERT INTO task_tags (task_id, tag)
VALUES (?, ?);

-- Reads one task by id, within the scope. sqlc returns sql.ErrNoRows when no
-- row matches, which is also the answer for a task the scope does not own.
-- name: GetTask :one
SELECT id, title, status, priority, due, version, owner_id
FROM tasks
WHERE id = ? AND owner_id IS sqlc.narg('owner');

-- Lists the scope's tasks in id order. Ids are UUIDv7 text, which sorts by
-- creation time, so for an append-only store this is insertion order.
-- name: ListTasks :many
SELECT id, title, status, priority, due, version, owner_id
FROM tasks
WHERE owner_id IS sqlc.narg('owner')
ORDER BY id;

-- Lists the scope's tasks whose status equals the argument, in id order.
-- name: ListTasksByStatus :many
SELECT id, title, status, priority, due, version, owner_id
FROM tasks
WHERE status = ? AND owner_id IS sqlc.narg('owner')
ORDER BY id;

-- Lists the scope's tasks carrying the tag, in id order. The join yields a
-- task once per matching task_tags row, and the primary key keeps that at
-- most one.
-- name: ListTasksByTag :many
SELECT tasks.id, tasks.title, tasks.status, tasks.priority, tasks.due, tasks.version, tasks.owner_id
FROM tasks
JOIN task_tags ON task_tags.task_id = tasks.id
WHERE task_tags.tag = ? AND tasks.owner_id IS sqlc.narg('owner')
ORDER BY tasks.id;

-- Marks the task with the given id as done and reports how many rows
-- changed, which is how the store tells a hit from a miss or a stale
-- version. The WHERE clause pins the version the caller read, the scope the
-- store was opened in, and bumps the version in the SET clause, so the
-- compare and the write are one statement: the database decides whether the
-- snapshot is still current and whether the task is even in scope, and zero
-- rows changed means either the task is gone or it was never the scope's
-- (which the store's GetTask probe tells apart).
-- name: CompleteTask :execrows
UPDATE tasks
SET status = ?, version = version + 1
WHERE id = ? AND version = ? AND owner_id IS sqlc.narg('owner');

-- Replaces every mutable column of the task and reports how many rows
-- changed, which is how the store tells a hit from a miss or a stale
-- version. The WHERE clause pins the version the caller read and the scope
-- the store was opened in, so a foreign task fails the same way a missing
-- one does; the update is written as a full replacement because that is what
-- the caller hands back: the snapshot it read, with the fields it meant to
-- change changed.
-- name: UpdateTask :execrows
UPDATE tasks
SET title = ?, status = ?, priority = ?, due = ?, version = version + 1
WHERE id = ? AND version = ? AND owner_id IS sqlc.narg('owner');

-- Deletes the task and reports how many rows changed, which is how the store
-- tells a hit from a miss or a stale version: the WHERE clause pins the
-- version the caller read and the scope the store was opened in, so a delete
-- whose snapshot moved on, or whose task is another user's, removes nothing. The task's tag rows go with the task through task_tags' ON DELETE
-- CASCADE, which is on because the store's connections turn foreign keys on.
-- name: DeleteTask :execrows
DELETE FROM tasks
WHERE id = ? AND version = ? AND owner_id IS sqlc.narg('owner');

-- Deletes every tag of the task. Update calls it before inserting the tag
-- set the caller handed in, so an update replaces the tags instead of
-- merging them: a tag the caller dropped has to disappear. The task is
-- already in scope when this runs: it is the same transaction's UpdateTask
-- that matched.
-- name: DeleteTaskTags :exec
DELETE FROM task_tags
WHERE task_id = ?;

-- Counts, for every distinct tag, how many of the scope's tasks carry it. A
-- task counts at most once per tag because task_tags holds one row per pair;
-- the join is what puts the task's owner in reach of the predicate.
-- name: CountTasksByTag :many
SELECT task_tags.tag, COUNT(*) AS count
FROM task_tags
JOIN tasks ON tasks.id = task_tags.task_id
WHERE tasks.owner_id IS sqlc.narg('owner')
GROUP BY task_tags.tag;

-- Lists every distinct tag of the scope's tasks, sorted. Empty when there are
-- none.
-- name: ListTags :many
SELECT DISTINCT task_tags.tag
FROM task_tags
JOIN tasks ON tasks.id = task_tags.task_id
WHERE tasks.owner_id IS sqlc.narg('owner')
ORDER BY task_tags.tag;

-- Lists the scope's tasks sorted by due ascending with undated tasks last; id
-- breaks ties, and UUIDv7's text form sorts by creation time.
-- name: SortTasksByDue :many
SELECT id, title, status, priority, due, version, owner_id
FROM tasks
WHERE owner_id IS sqlc.narg('owner')
ORDER BY (due IS NULL), due, id;

-- Aggregates the scope's tasks: the total and how many are done. The CAST
-- pins the sum to INTEGER so the generated field is int64, and COALESCE
-- covers the empty table, where SUM is NULL.
-- name: TaskStats :one
SELECT COUNT(*) AS total, CAST(COALESCE(SUM(status = ?), 0) AS INTEGER) AS done
FROM tasks
WHERE owner_id IS sqlc.narg('owner');

-- Loads the tags of the given tasks in one query, ordered so each task's
-- tags arrive sorted. sqlc.slice expands to one placeholder per id. No scope
-- predicate is needed: the ids come from a scoped query the store just ran.
-- name: ListTagsForTasks :many
SELECT task_id, tag
FROM task_tags
WHERE task_id IN (sqlc.slice('task_ids'))
ORDER BY task_id, tag;

-- Keep this file ASCII: sqlc v1.31.1 counts token positions in runes but
-- slices query text in bytes, so one multibyte character above the
-- sqlc.slice query corrupts its generated text (an em dash reproduces it).
-- make generate refuses non-ASCII here for the same reason.
````


## `internal/db/schema.sql`

````sql
table audit_events
  id TEXT NOT NULL pk=1
  action TEXT NOT NULL
  user_id TEXT NOT NULL
  actor_id TEXT
  created_at INTEGER NOT NULL
  foreign key (actor_id) references users (id) on update NO ACTION on delete NO ACTION match NONE
  foreign key (user_id) references users (id) on update NO ACTION on delete NO ACTION match NONE

table sessions
  token_hash TEXT NOT NULL pk=1
  data BLOB NOT NULL
  expiry INTEGER NOT NULL

table task_tags
  task_id TEXT NOT NULL pk=1
  tag TEXT NOT NULL pk=2
  foreign key (task_id) references tasks (id) on update NO ACTION on delete CASCADE match NONE
  index task_tags_tag (tag)

table tasks
  id TEXT NOT NULL pk=1
  title TEXT NOT NULL
  status TEXT NOT NULL
  priority INTEGER NOT NULL
  due TEXT
  version INTEGER NOT NULL default 1
  owner_id TEXT
  foreign key (owner_id) references users (id) on update NO ACTION on delete NO ACTION match NONE
  index tasks_owner_id (owner_id)

table users
  id TEXT NOT NULL pk=1
  email TEXT NOT NULL
  password_hash TEXT NOT NULL
  created_at INTEGER NOT NULL
  is_admin INTEGER NOT NULL default 0
````


## `internal/db/tx.go`

````go
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	turso "turso.tech/database/tursogo" // ErrTursoBusy and ErrTursoGeneric classify the retry
)

// The concurrent-transaction helper every writer of this database shares.
// It moved here from internal/store in chapter 33, when the auth package's
// session store became the second caller: the task store and the auth tables
// live in the same database, under the same MVCC rules, and the rules belong
// to the package that owns the database. A single-statement write rides a
// concurrent transaction just like a multi-statement one — in MVCC mode an
// autocommit write takes the exclusive path, and concurrent transactions
// cannot commit while it holds — so every write in this application goes
// through WithConcurrentTx.

// txMaxAttempts is how many times WithConcurrentTx runs its transaction
// before giving up on a busy engine or a write-write conflict. The first
// attempt is immediate; the rest wait out a doubling backoff.
const txMaxAttempts = 5

// WithConcurrentTx runs fn inside BEGIN CONCURRENT on a dedicated connection,
// retrying a busy engine or a write-write conflict with backoff (bounded
// attempts).
//
// BEGIN CONCURRENT is Turso's MVCC transaction: it acquires no locks up
// front, every writer works from its own snapshot, and conflicts are
// detected when a write touches a row another open transaction has written
// — or at commit, for the transactions that got that far. Two writers on
// different rows therefore run at the same time, which is the whole point of
// the pool: a plain BEGIN takes the engine's write lock, so concurrent
// writers serialize and the ones that wait past the busy timeout fail.
// Because a concurrent transaction acquires nothing at BEGIN, the only
// contention a writer can meet is the write-write conflict, and that has one
// honest answer: retry the transaction from the start.
//
// The retry loop is the belt behind the DSN's busy_timeout(5000) suspenders.
// Inside the five-second window the engine resolves lock contention without
// an error; past it a genuinely long writer is reported as busy, and the
// backoff gives it room to finish instead of failing the caller. A failed
// attempt rolls back before the next one starts, so retries never stack
// writes — and fn must be replayable: a retry runs it again from the start.
// A constraint error is never retried: a duplicate id or tag is a fact about
// the data, and running it again would fail identically.
func WithConcurrentTx(ctx context.Context, db *sql.DB, fn func(*sql.Conn) error) error {
	delay := time.Millisecond
	var err error
	for attempt := 1; attempt <= txMaxAttempts; attempt++ {
		if err = ConcurrentTxOnce(ctx, db, fn); err == nil {
			return nil
		}
		if !isRetryable(err) || attempt == txMaxAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("concurrent transaction: %w", context.Cause(ctx))
		case <-time.After(delay):
		}
		delay *= 2
	}
	return fmt.Errorf("concurrent transaction: %w", err)
}

// ConcurrentTxOnce is one attempt: a dedicated connection, BEGIN CONCURRENT,
// fn, COMMIT. The deferred ROLLBACK turns every path that does not commit
// into an undo: after a successful COMMIT there is no transaction left to
// end and the rollback is a no-op, and after a failed BEGIN, fn, or COMMIT
// it discards whatever the attempt wrote. The rollback runs under
// context.WithoutCancel so a canceled ctx cannot leave the transaction open
// for the connection's next user; an open transaction must not leak back
// into the pool. The connection is closed on every path, so the pool sees
// one clean connection returned or one dropped.
//
// It is exported because one caller cannot use the retry loop: the task
// importer streams a document, and a retry would continue from where the
// failed attempt stopped instead of replaying it. A write-write conflict
// aborts that import instead.
func ConcurrentTxOnce(ctx context.Context, db *sql.DB, fn func(*sql.Conn) error) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.ExecContext(ctx, "BEGIN CONCURRENT"); err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _, _ = conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK") }()

	if err := fn(conn); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// isRetryable reports whether err is worth another transaction attempt. Two
// shapes qualify: ErrTursoBusy, the engine's lock contention, and the
// write-write conflict MVCC reports when an open transaction has already
// written a row this attempt touched. The conflict is the surprise: the
// driver maps it to its generic error kind, so errors.Is(err,
// turso.ErrTursoBusy) is false for it and the message is the only
// typed-enough handle the driver offers. Everything else — a constraint
// violation above all — is a fact about the data, and retrying would fail
// the same way.
func isRetryable(err error) bool {
	if errors.Is(err, turso.ErrTursoBusy) {
		return true
	}
	return errors.Is(err, turso.ErrTursoGeneric) && strings.Contains(err.Error(), "Write-write conflict")
}
````
