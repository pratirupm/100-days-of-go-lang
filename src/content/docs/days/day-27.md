---
title: "Day 27 — IDs and time"
description: "Give every task an id the app makes itself — one that sorts by creation time — and carry the existing rows across to it."
sidebar:
  order: 27
chapter: 23
---

**About 3 hours** · Part V, day 5 of 6.

**You'll be able to:**

- move to UUIDv7 ids and keep times in UTC;
- migrate existing rows safely and version the export format.

---

Every task in the app carries a number. The first one added gets 1, the next gets 2, and the database hands out its own numbers in its own column. It works, but look closely: two stores count two different sequences, a number tells anyone who sees it how many tasks exist, and the database's counter is one shared line every insert waits on.

Today the id becomes a **UUID** — a name so unlikely to repeat that any machine can make one on its own. The kind we'll use, version 7, carries a creation time in its first bits, so ids also sort in the order the tasks were written.

The change has a catch. A database file already holds tasks, and the id's type is part of the table's shape. The table has to be rebuilt and every row carried across — titles, statuses, priorities, due dates, labels and all. Nothing may be lost on the way.

By the end, the stores assign their own ids, the export file moves to a new version, the CLI prints ids, and a test proves the old rows crossed safely.

## A name unlikely to collide

A **UUID** — short for universally unique identifier — is a 128-bit name written as 36 characters in five dashed groups, like `01a139ff-afc7-7395-8a6b-cd3bdbb0482e`. The characters are hexadecimal digits: the sixteen symbols `0`–`9` and `a`–`f`.

There are more possible UUIDs than there are grains of sand on Earth, so two machines making them at the same time will not produce the same one. No server hands them out, and no counter has to be shared. A name like that is called *opaque*: you can hold one and use it, but you cannot guess the next one from it.

Two recipes matter here. Version 4 fills almost every bit with randomness. Version 7 spends its first 48 bits on a timestamp — milliseconds since the start of 1970 — then a counter and some random bits. That prefix is the whole point: compare two version 7 ids as text and the older one comes first, because the fixed-width, dashed text sorts in the same order as the bytes inside it.

In Go, `uuid.UUID` is not text. It is an array of sixteen bytes with its own comparison rules; `.String()` writes the dashed form, and `uuid.Parse` reads that form back. The app keeps the value in the domain and the text in the database, because the database sorts text.

## The due dates stay as they are

One more part of the id's story is time, so it is worth saying what this change does not touch: the due date.

A due date is a moment, and a moment is the same everywhere. Midnight UTC on a day in November is a different clock reading in another city, but it is one instant. The app stores due dates as text in UTC, so the same moment in different places is one string, and every stored value ends in `Z`. Because the text has a fixed shape, comparing two due dates as text is comparing two moments in time.

That format stays, and the migration copies each due value text for text. The ordering the app already relies on keeps working, unchanged. The box at the end records why the alternative, a plain number of seconds, was turned down.

## Move the tests to the new type

The id's type is changing, and the tests that name an id change first, as always. Three edits define the move.

The round-trip test spells a whole task, id and all:

<!-- verify: internal/task/task_test.go at=uuid-ids -->
```go title="internal/task/task_test.go"
			task: Task{
				ID:       uuid.MustParse("0199c0de-0000-7000-8000-000000000007"),
				Title:    "write the book",
				Status:   StatusDone,
				Priority: PriorityMax,
				Due:      time.Date(2026, 10, 20, 12, 30, 0, 0, time.UTC),
				Tags:     []string{"go", "writing"},
			},
```

The same test pins what the id looks like when a task travels as JSON:

<!-- verify: internal/task/task_test.go at=uuid-ids -->
```go title="internal/task/task_test.go"
			// uuid.UUID is an encoding.TextMarshaler, so the id rides the
			// canonical dashed string form, not an array of sixteen bytes.
			assert.Contains(t, string(data), `"ID":"`+tt.task.ID.String()+`"`)
```

`uuid.UUID` is a text marshaler: it has a method that writes its dashed form, and the JSON encoder uses it. The id crosses as a string, not as an array of sixteen numbers.

The conformance suite's `addAll` helper stops expecting a sequence and says what actually remains true:

<!-- verify: internal/store/storetest/suite.go at=uuid-ids -->
```go title="internal/store/storetest/suite.go"
// addAll adds tasks in order, requires each Add to hand out a non-nil id,
// requires the ids to be unique, and returns the stored tasks. The ids
// themselves are v7 values the suite cannot predict; what the contract
// promises is that they exist, identify the task, and do not repeat.
func addAll(t *testing.T, s store.Store, tasks ...task.Task) []task.Task {
	t.Helper()
	added := make([]task.Task, len(tasks))
	seen := make(map[uuid.UUID]bool, len(tasks))
	for i, tt := range tasks {
		got, err := s.Add(context.Background(), tt)
		require.NoError(t, err)
		require.NotEqual(t, uuid.Nil, got.ID, "Add assigns a non-nil id")
		require.False(t, seen[got.ID], "Add assigns unique ids")
		seen[got.ID] = true
		added[i] = got
	}
	return added
}
```

There is no counter to require any more. What the contract promises is that every added task gets a non-nil id and that no two ids repeat.

The third edit is a new test, `TestUUIDv7_Monotonic`, and it pins the ordering property the whole change exists for.

<!-- verify: internal/store/store_test.go at=uuid-ids -->
```go title="internal/store/store_test.go"
	const n = 1000
	s := NewMemoryStore()
	added := make([]task.Task, n)
	for i := range added {
		got, err := s.Add(context.Background(), task.Task{Title: fmt.Sprintf("task %03d", i)})
		require.NoError(t, err)
		added[i] = got
	}

	for i := 1; i < len(added); i++ {
		assert.Negative(t, bytes.Compare(added[i-1].ID[:], added[i].ID[:]),
			"id %d sorts before id %d", i-1, i)
	}

	ids := make([]uuid.UUID, len(added))
	for i, tt := range added {
		ids[i] = tt.ID
		assert.Equal(t, uuid.Version(7), tt.ID.Version())
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	for i, id := range ids {
		assert.Equal(t, added[i].ID, id, "sorted order equals insertion order")
	}
}
```

It adds a thousand tasks, checks that each id sorts strictly after the one before it as bytes, and checks that sorting the ids reproduces the order the tasks were added in.

The rest is the same move repeated: wherever a test spelled an id as a literal — `Complete(ctx, 1)`, a map keyed by `int`, an expected id of `42` — it now uses the value `Add` returned. Where the point is a miss, it uses `missingID`, the fixed `uuid.MustParse("00000000-0000-0000-0000-000000000042")`. The foreign-key test's orphan row names an id no task holds, spelled as UUID text. The tests need the uuid package, so fetch it:

```bash
$ go get github.com/google/uuid
$ go mod tidy
```

The module now asks for it directly:

<!-- verify: go.mod at=uuid-ids -->
```text title="go.mod"
require (
	github.com/gkampitakis/go-snaps v0.5.23
	github.com/google/go-cmp v0.7.0
	github.com/google/uuid v1.6.0
	...
)
```

The uuid package sits in the first block, the dependencies the app asks for directly.

:::tip
Let the compiler do the walking. Make the edits you can see, run the tests, and fix the first errors it lists. A type change like this one is mechanical, and Go is good at pointing.
:::

Run everything and read the list:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/task [todo/internal/task.test]
internal/task/task_test.go:215:15: cannot use uuid.MustParse("0199c0de-0000-7000-8000-000000000007") (value of array type uuid.UUID) as int value in struct literal
internal/task/task_test.go:234:57: tt.task.ID.String undefined (type int has no field or method String)
# todo/internal/store/storetest
internal/store/storetest/suite.go:120:43: cannot use missingID (variable of array type "github.com/google/uuid".UUID) as int value in argument to s.Complete
...
ok  	todo/cmd/todo	0.003s
FAIL	todo/internal/store [build failed]
FAIL	todo/internal/store/storetest [build failed]
FAIL	todo/internal/task [build failed]
FAIL
```

Every line is a place where a test expects the new id and the code still speaks `int`. `cannot use ... as int value` and `undefined (type int has no field or method String)` are the compiler saying "this test has moved and this code has not". Your line numbers will differ; the shapes will not.

## Change the type, then the stores

Now the code the tests describe. The domain field changes type, and its comment records who assigns ids. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them:

<!-- verify: internal/task/task.go at=uuid-ids -->
```go title="internal/task/task.go"
// Task is a single todo item.
type Task struct {
	// ID is the task's identifier. It is uuid.Nil until a store assigns
	// one; stores assign UUIDv7 values, which sort by creation time.
	ID uuid.UUID
	...
}
```

`uuid.Nil` is the all-zero id — the type's zero value, meaning "no id yet". `NewTask` keeps returning tasks with that zero value, because a constructor that invented ids would hand one to every task, including the ones that never reach a store. Assignment belongs to the store, and now the store gets to pick the recipe.

The memory store loses the field that counted and generates an id inside its write lock:

<!-- verify: internal/store/store.go at=uuid-ids -->
```go title="internal/store/store.go"
	id, err := uuid.NewV7()
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}
	t.ID = id
	s.tasks = append(s.tasks, t)
	return t, nil
```

The lock earns its keep here: version 7 ids never go backwards within a process, so generating inside the lock makes assignment order and slice order one sequence, even when several Adds run at once.

The rest of the memory store is a short sweep. `Complete` and `CompleteAll` take a `uuid.UUID` instead of an `int`, the `Store` interface's line changes with them, and the error text prints the id with `%s` so it appears in its dashed form.

The database store generates the id before the transaction and hands the same value to the row and to the caller. The appendix holds this file in full — the lines behind the `...` are there as you type them:

<!-- verify: internal/store/turso.go at=uuid-ids -->
```go title="internal/store/turso.go"
	id, err := uuid.NewV7()
	if err != nil {
		return task.Task{}, fmt.Errorf("add task: %w", err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	...
	q := s.queries.WithTx(tx)
	if err := q.InsertTask(ctx, db.InsertTaskParams{
		ID:       id.String(),
		Title:    t.Title,
		Status:   string(t.Status),
		Priority: int64(t.Priority),
		Due:      dueSQL(t.Due),
	}); err != nil {
```

`id.String()` is the boundary: the domain's value becomes the dashed text the column stores. On the way back out, the row mapper parses the text:

<!-- verify: internal/store/turso.go at=uuid-ids -->
```go title="internal/store/turso.go"
	parsedID, err := uuid.Parse(id)
	if err != nil {
		return task.Task{}, fmt.Errorf("parse id %q: %w", id, err)
	}
```

That error return is new — the function used to be infallible — and it is honest: a row whose id is not a UUID is corrupt data, and the store says so instead of panicking. The label loader keys its map on `id.String()` for the same reason: both sides of that lookup must use the text the column holds.

One query changes shape. `InsertTask` used to let the database assign the id and hand it back; now the store assigns the id and the query inserts it:

<!-- verify: internal/db/queries/tasks.sql at=uuid-ids -->
```sql title="internal/db/queries/tasks.sql"
-- Inserts a task under the id the store assigned. A zero due is inserted as
-- NULL, not the year 1 as text.
-- name: InsertTask :exec
INSERT INTO tasks (id, title, status, priority, due)
VALUES (?, ?, ?, ?, ?);
```

Regenerate the typed code from the queries:

```bash
$ go generate ./...
```

```text
(no output)
```

sqlc checks the new query against the migration schema and rewrites `internal/db`. The generated insert now takes the id and returns only an error:

<!-- verify: internal/db/tasks.sql.go at=uuid-ids -->
```go title="internal/db/tasks.sql.go"
type InsertTaskParams struct {
	ID       string
	Title    string
	Status   string
	Priority int64
	Due      sql.NullString
}
```

Nothing generated imports the domain or the uuid package. The generated layer knows tables, the store knows behavior.

## The rows have to cross

The database's `tasks.id` column is an integer, and it has to become text. Here is the hard part: a database cannot change a column's type in place — there is no command for it — and `id` is the primary key. So the change is a rebuild: new tables with the new types, every row copied across, the old tables dropped, and the new ones renamed into place.

Existing rows cannot get version 7 ids. A version 7 id's value is the creation time in its first bits, and an integer id carries no timestamp to recover. So the copy gives each old row a random id instead — the version 4 recipe — and only tasks added after the change get version 7 ids from the store.

A migration this risky gets a test before it gets written. `UpTo` — the hook that stops at an older version — finally has a caller. In `internal/db/migrate_test.go`, add the uuid import and a new test, `TestMigration_PreservesRows`. It starts with the seed:

<!-- verify: internal/db/migrate_test.go at=uuid-ids -->
```go title="internal/db/migrate_test.go"
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
```

It migrates a fresh database only to version 1, seeds the old integer schema by raw SQL — the counter assigns ids 1 and 2 — and then runs the rest of the migrations.

What it checks is shape and identity, not values, because the new ids are random: every id parses as a UUID, the stored text is canonical, and the backfilled ids are version 4. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them.

<!-- verify: internal/db/migrate_test.go at=uuid-ids -->
```go title="internal/db/migrate_test.go"
	require.NoError(t, Up(ctx, sqlDB))
	assert.Equal(t, int64(2), schemaVersion(t, sqlDB))

	// Every row survived and every id is a canonical, v4-shaped UUID.
	type taskRow struct {
		id       string
		title    string
		status   string
		priority int64
		due      sql.NullString
	}
	rows, err := sqlDB.Query(`SELECT id, title, status, priority, due FROM tasks ORDER BY title`)
	require.NoError(t, err)
	...
	want := []taskRow{
		{title: "review code", status: "Done", priority: 5},
		{title: "write tests", status: "Todo", priority: 3, due: sql.NullString{String: "2026-11-01T00:00:00Z", Valid: true}},
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
	}
```

Each title, status, priority, and due date must match the old row it came from. Then the labels, and one fresh insert. The appendix holds this file in full — the lines behind the `...` are there as you type them:

<!-- verify: internal/db/migrate_test.go at=uuid-ids -->
```go title="internal/db/migrate_test.go"
	// Tags still point at the same titles.
	tagRows, err := sqlDB.Query(`
		SELECT t.title, tt.tag
		FROM tasks t
		JOIN task_tags tt ON tt.task_id = t.id
		ORDER BY t.title, tt.tag
	`)
	require.NoError(t, err)
	...
	assert.Equal(t, []string{
		"review code -> go",
		"review code -> review",
		"write tests -> book",
		"write tests -> go",
	}, gotTags)

	// A row inserted after the migration gets the id the store would
	// assign it: a v7 the application generated.
	v7, err := uuid.NewV7()
	require.NoError(t, err)
	...
	assert.Equal(t, uuid.Version(7), parsedNew.Version(), "fresh rows get v7 ids")
}
```

The label check joins each label row back to its task and asks whether the same title still carries the same labels. The fresh insert proves the other direction: rows added after the migration get version 7 ids, and the id round-trips through the column.

Run the package now and the test fails: the migration that gives the rows their new ids does not exist yet, so the database stays at version 1 and the seeded ids are still numbers.

## Write the migration

Create `internal/db/migrations/00002_uuid_ids.sql`. The finished app's appendix holds this file in full — read the parts behind the `...` there as you type them. The forward half starts with the mapping — a scratch table pairing every old number with a new id:

<!-- verify: internal/db/migrations/00002_uuid_ids.sql at=uuid-ids -->
```sql title="internal/db/migrations/00002_uuid_ids.sql"
-- +goose Up
...
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
```

`id_map` is temporary: it lives for the length of the migration and disappears with it. The `INSERT` computes each row's random sixteen bytes once, then slices the hex text into the dashed form, pinning `4` as the version and `8` as the variant so the result is a valid version 4 id. Every backfilled id is canonical — dashed, lowercase, the exact text `uuid.Parse` reads and `String` writes.

Next, the new tables and the copy:

<!-- verify: internal/db/migrations/00002_uuid_ids.sql at=uuid-ids -->
```sql title="internal/db/migrations/00002_uuid_ids.sql"
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
```

The two `INSERT`s move the rows through the mapping. The task copy takes each new id with its old row's fields; the label copy joins through the same mapping, so every label row lands on its task's new id. Nothing is matched by position or by title — only by the mapping.

Then the old tables go, child first, and the new ones take their names:

<!-- verify: internal/db/migrations/00002_uuid_ids.sql at=uuid-ids -->
```sql title="internal/db/migrations/00002_uuid_ids.sql"
-- Child first: no tag row outlives the parent it points at.
DROP TABLE task_tags;
DROP TABLE tasks;

...
ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE task_tags_new RENAME TO task_tags;

DROP TABLE id_map;
```

Child first is the reverse of creation, and it is deliberate: a label row may not outlive the task it points at. The renames are left to the engine. When the table a foreign key names is renamed, the engine rewrites the reference in the child's stored schema, so the label table's pointer follows `tasks_new` to `tasks` without an edit.

Every migration has a reverse, and this one is honest about what it cannot do:

<!-- verify: internal/db/migrations/00002_uuid_ids.sql at=uuid-ids -->
```sql title="internal/db/migrations/00002_uuid_ids.sql"
-- +goose Down
...
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
```

The mapping numbers the tasks in the order their UUIDs sort, and the two `_old` tables are the integer schema again.

<!-- verify: internal/db/migrations/00002_uuid_ids.sql at=uuid-ids -->
```sql title="internal/db/migrations/00002_uuid_ids.sql"
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
```

The original numbers were only ever stored in the dropped table, so there is nothing to restore them from. The reverse rebuilds the integer schema and assigns fresh numbers in the order the UUIDs sort — which, for version 7 ids, is creation order, and for the backfilled version 4 randoms is deterministic but arbitrary. A person who memorized an old number cannot get it back. The reverse exists for development and tests, where a clean, empty database is the point.

With the migration in place, the test passes:

```text
=== RUN   TestMigration_PreservesRows
=== PAUSE TestMigration_PreservesRows
=== CONT  TestMigration_PreservesRows
--- PASS: TestMigration_PreservesRows (0.02s)
PASS
ok  	todo/internal/db	0.020s
```

Every seeded row crossed, and the ids that came out are the shape the test pins.

## Regenerate the golden

The migrated schema is pinned by a test that dumps the database and compares it with `internal/db/schema.sql`. The id type changed, so the comparison fails:

```text
--- FAIL: TestMigratedSchemaMatchesGolden (0.02s)
    migrate_test.go:206: migrated schema differs from schema.sql (-golden +migrated):
          (
          	"""
          	table task_tags
        - 	  task_id INTEGER NOT NULL pk=1
        + 	  task_id TEXT NOT NULL pk=1
          	  tag TEXT NOT NULL pk=2
          	  foreign key (task_id) references tasks (id) on update NO ACTION on delete CASCADE match NONE
          	
          	table tasks
        - 	  id INTEGER pk=1
        + 	  id TEXT NOT NULL pk=1
          	  title TEXT NOT NULL
          	  status TEXT NOT NULL
          	... // 3 identical lines
          	"""
          )
        
        regenerate it with: make schema-update
FAIL
FAIL	todo/internal/db	0.022s
```

The `-` lines are the recorded file; the `+` lines are what the migrations now serve. The change was meant, so regenerate the file with the command the message names:

```bash
$ UPDATE_SCHEMA=1 go test -run TestMigratedSchemaMatchesGolden ./internal/db
```

```text
ok  	todo/internal/db	0.020s
```

The file comes back as the new shape:

<!-- verify: internal/db/schema.sql at=uuid-ids -->
```text title="internal/db/schema.sql"
table task_tags
  task_id TEXT NOT NULL pk=1
  tag TEXT NOT NULL pk=2
  foreign key (task_id) references tasks (id) on update NO ACTION on delete CASCADE match NONE

table tasks
  id TEXT NOT NULL pk=1
  title TEXT NOT NULL
  status TEXT NOT NULL
  priority INTEGER NOT NULL
  due TEXT
```

The id lines moved from `INTEGER` to `TEXT`, and the foreign key line is unchanged: the rename left the label table pointing at `tasks`. `TestUp_Idempotent` pins the schema version, so its literal moves from 1 to 2 in the same pass.

## Export format version 2

The interchange document carries a version number, and its schema just changed: ids were integers, now they are UUID text. The version moves to 2:

<!-- verify: internal/store/export.go at=uuid-ids -->
```go title="internal/store/export.go"
// exportVersion is the schema version the interchange format carries and the
// only one ImportJSON accepts. Writing the field is not enough to make it a
// contract: the reader checks it, so a document that claims a schema this
// package does not know is refused before a single task is added instead of
// being misread as version 2. Version 1 was the integer-id era; version 2 is
// the UUID era, whose ids ride uuid's canonical string form. A v1 document is
// refused twice over: the version check fires before any task is decoded, and
// even a document that claimed version 2 with an integer id could not decode
// into the task type at all.
const exportVersion = 2
```

The importer reads that field and refuses anything else:

<!-- verify: internal/store/export.go at=uuid-ids -->
```go title="internal/store/export.go"
	if version != exportVersion {
		return 0, fmt.Errorf("import tasks: unsupported version %d, want %d", version, exportVersion)
	}
```

A version 1 document is refused before a single task is decoded. There is a second layer under the first: even a document that claimed version 2 could not smuggle an integer id past the task type, because `uuid.UUID` decodes only from its canonical string form. A hand-written version 1 file and a lying version 2 file, imported by a probe:

```text
import error: import tasks: unsupported version 1, want 2
decode error: import tasks: task 0: json: cannot unmarshal number into Go struct field Task.ID of type uuid.UUID
```

The first message names a format; the second names the element's position and the type the id could not become. Without either check, an empty version 1 file would import zero tasks and be rewritten as version 2 on the next export — a silent conversion of a format the code never understood.

Two tests pin both halves. `TestImportJSON_RejectsUnknownVersion` feeds versions 1 and 3; the new one feeds the structural half:

<!-- verify: internal/store/export_test.go at=uuid-ids -->
```go title="internal/store/export_test.go"
func TestImportJSON_RejectsIntegerID(t *testing.T) {
	t.Parallel()

	s := NewMemoryStore()
	doc := `{"version":2,"tasks":[{"ID":1,"Title":"from v1","Status":"Todo","Priority":3}]}`

	n, err := ImportJSON(context.Background(), s, strings.NewReader(doc))
	require.Error(t, err)
	assert.Zero(t, n)
	assert.Contains(t, err.Error(), "task 0", "the failure names the element's position")

	list, err := s.List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, list, "the task with the integer id never reaches the store")
}
```

They pass together:

```bash
$ go test -count=1 -run 'TestImportJSON_RejectsUnknownVersion|TestImportJSON_RejectsIntegerID' -v ./internal/store
```

```text
=== RUN   TestImportJSON_RejectsUnknownVersion
=== PAUSE TestImportJSON_RejectsUnknownVersion
=== RUN   TestImportJSON_RejectsIntegerID
...
--- PASS: TestImportJSON_RejectsIntegerID (0.00s)
--- PASS: TestImportJSON_RejectsUnknownVersion (0.00s)
    --- PASS: TestImportJSON_RejectsUnknownVersion/version_1 (0.00s)
    --- PASS: TestImportJSON_RejectsUnknownVersion/version_3 (0.00s)
PASS
ok  	todo/internal/store	0.004s
```

The round trip's own test moved with the format: the document now opens `{"version":2,"tasks":[`, the id rides its dashed form, and the import asserts fresh version 7 ids rather than the document's values — the identity rule from the export work, restated for UUIDs.

## The CLI prints ids

`run` now collects the ids the store assigns, completes the first task through the id it got back, and prints the id as the line's first field:

<!-- verify: cmd/todo/main.go at=uuid-ids -->
```go title="cmd/todo/main.go"
	s := store.NewMemoryStore()
	var ids []uuid.UUID
	for _, title := range []string{"buy milk", "write the book"} {
		t, err := task.NewTask(title)
		if err != nil {
			return err
		}
		added, err := s.Add(ctx, t)
		if err != nil {
			return err
		}
		ids = append(ids, added.ID)
	}
	if err := store.CompleteAll(ctx, s, ids[:1]); err != nil {
		return err
	}
```

The printing line puts the id first:

<!-- verify: cmd/todo/main.go at=uuid-ids -->
```go title="cmd/todo/main.go"
		if _, err := fmt.Fprintf(w, "%s  %s\n", t.ID, t); err != nil {
```

The output looks like this:

```text
01a139ff-afc7-7395-8a6b-cd3bdbb0482e  [Done] buy milk
01a139ff-afc7-7399-83b1-9e5ceaee0bdd  [Todo] write the book
```

The shared `01a139ff-afc7` prefix is the millisecond both tasks were created in; the bytes after it climb.

The snapshot test cannot pin those values — they are random per run — so it normalizes them before comparing. The test gains a pattern and a helper:

<!-- verify: cmd/todo/main_test.go at=uuid-ids -->
```go title="cmd/todo/main_test.go"
// uuidPattern matches the canonical string form of a UUID anywhere in the
// output. run prints the ids the store assigned, and UUIDv7 ids are random
// values that change on every run, so the snapshot cannot pin them.
var uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// normalizeIDs replaces every UUID in s with the placeholder <id>. The
// snapshot then pins the output's shape and order — the part that is the
// program's behavior — while the volatile id values stay out of the golden.
// go-snaps has no transform hook, so the normalization happens here, before
// MatchSnapshot sees the string.
func normalizeIDs(s string) string {
	return uuidPattern.ReplaceAllString(s, "<id>")
}
```

The pattern matches any canonical UUID in the output, and the helper swaps each one for `<id>`. The call site uses it:

<!-- verify: cmd/todo/main_test.go at=uuid-ids -->
```go title="cmd/todo/main_test.go"
			snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, normalizeIDs(out.String()))
```

The failing run against the old snapshot shows exactly what is being replaced:

```text
--- FAIL: TestRun (0.00s)
    --- FAIL: TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list (0.00s)
        main_test.go:44: 
            - Snapshot - 2
            + Received + 2
            
            - 1. [Done] buy milk
            - 2. [Todo] write the book
            + <id>  [Done] buy milk
            + <id>  [Todo] write the book
              ↵
            
            at __snapshots__/main_test.snap:2
            
FAIL
FAIL	todo/cmd/todo	0.003s
FAIL
```

The update run, scoped to the one test, rewrites the snapshot:

```bash
$ UPDATE_SNAPS=true NO_COLOR=true go test -count=1 -run '^TestRun$' ./cmd/todo
```

```text
ok  	todo/cmd/todo	0.003s
```

The rewritten snapshot:

```diff
 [TestRun/seeds_tasks,_completes_the_first,_and_prints_the_list - 1]
-1. [Done] buy milk
-2. [Todo] write the book
+<id>  [Done] buy milk
+<id>  [Todo] write the book
```

The snapshot now pins the shape and the order — two lines, the done task first, two spaces before the summary — and the random values stay out of it. Printing the position again would hide the id the CLI now exists to show; a short prefix would churn just the same.

## Run everything

The tests moved first, the code followed, and every name the compiler listed is fixed. Run everything:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/db	0.022s
ok  	todo/internal/store	0.066s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
```

Every package passes, with real ids: the conformance suite ran against both stores, the migration test proved the old rows crossed, and the CLI snapshot matches on shape.

## If something went wrong

**A row whose id is not a UUID.** The store reads every id through `uuid.Parse`, so an old integer-id row that escaped the migration surfaces on the first read:

```text
list: list tasks: parse id "1": invalid UUID length: 1
```

The store migrates on open, so a real database crosses the boundary on its own. A row still there afterwards was written around the migration; the parse error is the boundary refusing to guess.

**Comparing an id to text.** The compiler, on a comparison against a string literal:

```text
# cmperr
./main.go:7:12: invalid operation: id == "0199c0de-0000-7000-8000-000000000007" (mismatched types uuid.UUID and untyped string)
```

The id is not text in the domain. Compare values — `t.ID == want` — and convert at the edges. The subtler version has no compiler at all: a dashless id passed into SQL would never match the stored canonical form. `uuid.Parse` accepts both forms; the database accepts one.

**A migration that drops instead of copies.** If the old tables go before the rows are copied, the test reports the rows gone:

```text
    migrate_test.go:263: 
        	Error Trace:	…/internal/db/migrate_test.go:263
        	Error:      	"[]" should have 2 item(s), but has 0
        	Test:       	TestMigration_PreservesRows
        	Messages:   	the migration preserved both rows
--- FAIL: TestMigration_PreservesRows (0.02s)
FAIL
FAIL	todo/internal/db	0.019s
FAIL
```

Fill the new tables through the mapping first; the drops come after the copy.

**Reversing the drop order.** The migration drops the label table before the task table, and the comment says why. Reverse the order against a child table without `ON DELETE CASCADE`, with foreign keys enforced, and the engine refuses:

```text
drop parent first: turso: constraint failed: FOREIGN KEY constraint failed
drop child first: <nil>
```

A label row may not outlive its parent. This schema cascades, so the reversed order happens to survive here — the worse kind of bug, one that passes against today's shape and breaks the day the cascade changes.

**Assuming the old numbers come back.** The reverse migration assigns fresh numbers, so a memorized integer is gone:

```text
after Up: ids [a9d21eff-a186-4979-8805-00ddbb751f9f d7cd4ac0-80bb-4ddc-8376-f91643df0684]
after Down: id 1 = "write tests"
after Down: id 2 = "review code"
rows with the old id 10: 0
```

Nothing is broken: the reverse is for development and tests, where a clean schema is the point.

<details>
<summary>Going deeper: what the 128 bits hold</summary>

Version 7 spends the id like this: 48 bits of Unix milliseconds, 4 bits for the version, 12 bits of a counter, 2 bits of variant, and 62 random bits. The counter is what makes the ordering guarantee real — when two ids are made in the same millisecond, the counter increases, so the bytes still climb. The uuid package's generator keeps a process-wide (millisecond, counter) pair and never repeats a value.

Two honest caveats. The id leaks a creation timestamp at millisecond precision to anyone holding it, so a version 7 id is opaque, not secret. And the guarantee is per process: two processes making ids in the same millisecond can interleave. The property the test pins is the one a single process can rely on.

</details>

<details>
<summary>Going deeper: why the backfilled ids are random</summary>

A version 7 id's value is the creation time inside it, and an integer id carries no timestamp to recover. The alternatives were both worse: stamping every migrated row with "now" would invent one creation instant for the whole table, and a deterministic mapping from the old integer would leak the old sequence back into the new ids. So the migration assigns random version 4 ids, and only rows inserted after it get version 7 ids from the store. The test pins both shapes.

</details>

<details>
<summary>Going deeper: why the due date did not become a number</summary>

Epoch seconds — one integer, seconds since 1970 — would be smaller and simpler to compare. RFC 3339 text is larger, and its ordering is a property of the format: text order is time order only because every value is fixed-width and in UTC. But the text is readable in the database, in query output, and in a diff, and that was worth more than the bytes here. The discipline that keeps it safe is already in place: due dates are parsed to UTC midnight, stored with a trailing `Z`, and compared as text. One local offset slipping into any code path would silently break the ordering — the failure to remember if this format is ever revisited.

</details>

<details>
<summary>Going deeper: what text ids cost and buy</summary>

A UUID costs 36 bytes of text against 8 bytes of integer, and a text primary key is a unique index rather than the row's own address, so lookups pay an index probe and inserts pay index upkeep. What the text buys: ids that are opaque and portable, generation owned by the app instead of one database's counter, and one value the domain, the database, and the export format all carry unchanged. It also sets up what comes next: the old counter was a single line every insert waited on, while these keys are per-row text.

</details>

The ids are the app's own now, and they sort by creation time. Next, the app stops taking turns: several writers work at once, and the ids are ready for it.

<div class="day-tracker" data-day="27"></div>
