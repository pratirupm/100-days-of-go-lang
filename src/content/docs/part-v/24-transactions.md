---
title: Transactions
description: Give every task a version so a stale write is refused — and make a whole imported document land together or not at all.
sidebar:
  order: 24
---

Every app more than one writer can use meets the same quiet failure. Two writers read the same task, each decides what it should become, and both write. The slower write lands last and erases the faster one — no error, no warning, one writer's work simply gone. This is the **lost update**, and stopping it is why databases are built around transactions.

A **transaction** is an all-or-nothing bundle of changes. Picture a bank transfer: money leaves one account and arrives in the other. If the machine died halfway through, the money must not vanish and must not double — either both changes happen or neither does. That is the promise: the whole bundle lands as one thing, or it is undone as if it never started.

The app leans on that promise in two places. Every task gets a **version** — a count of the writes it has seen — and a write must hand back the version it read, so a stale write is refused instead of erasing newer state. And the importer gets the promise for real: a whole imported document of tasks lands together, or none of it does.

## A version that travels with the task

Picture editing a shared document where every save must name the revision it started from. You open revision 3; someone else saves revision 4; your save is refused — "you edited an old revision, re-read and try again." Nobody was locked out while you thought, and the clash shows up only when your save arrives. The design has a name, **optimistic concurrency**, and it fits this app: the gap between reading a task and completing it is a person deciding, which can be minutes.

The fix is a counter on every task. The store assigns version 1 when it stores the task, and adds one on every write. A caller reads the task and its version together and hands both back with the write; the store accepts the write only while the version still matches.

The tests come first. The conformance suite — the shared set of tests every store must pass — gains one case:

<!-- verify: internal/store/storetest/suite.go at=transactions -->
```go title="internal/store/storetest/suite.go"
	t.Run("CompleteStaleVersion", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s, task.Task{Title: "write tests", Status: task.StatusTodo})
		stale := added[0] // the caller's snapshot: id and version together

		require.NoError(t, s.Complete(context.Background(), stale.ID, stale.Version))

		// The same snapshot is one version behind now: the second write
		// must lose the compare-and-swap instead of overwriting the first.
		err := s.Complete(context.Background(), stale.ID, stale.Version)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrConflict)
		assert.NotErrorIs(t, err, store.ErrNotFound, "a stale version is not a missing task")
		assert.Contains(t, err.Error(), "complete task "+stale.ID.String())

		got, err := s.List(context.Background())
		require.NoError(t, err)
		require.Len(t, got, 1)
		assert.Equal(t, task.StatusDone, got[0].Status)
		assert.Equal(t, 2, got[0].Version, "the winner bumped the version exactly once")
	})
```

Read it as one snapshot used twice. The first `Complete` hands back the id and version `Add` returned, so it wins and the task becomes `Done` at version 2. The second hands back the same pair — one version behind now — and the test says that write must fail with `store.ErrConflict`, must not be reported as a missing task, and must leave the winner's state in place.

The suite's helper `addAll` grows one assertion to match: every `Add` stores its task at version 1. The case above shows the story without racing; a second test adds the race, and runs against both stores:

<!-- verify: internal/store/concurrency_test.go at=transactions -->
```go title="internal/store/concurrency_test.go"
			a, b := firstRead[0], secondRead[0]
			require.Equal(t, a.Version, b.Version)

			start := make(chan struct{})
			results := make(chan error, 2)
			for _, snapshot := range []task.Task{a, b} {
				go func() {
					<-start
					results <- s.Complete(ctx, snapshot.ID, snapshot.Version)
				}()
			}
			close(start)
			...
			assert.Equal(t, 1, winners, "exactly one writer wins the compare-and-swap")
			assert.Equal(t, 1, conflicts, "the stale writer is rejected")
```

Both writers read the task before either writes, so both hold the same version. Which one wins is the scheduler's choice; the test pins what must be true either way — exactly one write lands, the other is refused as stale, and the stored task shows the winner's state with the version moved by exactly one.

Now run the tests, and watch the compiler list everything that is missing:

```bash
$ go test -count=1 ./...
```

```text
# todo/internal/store/storetest
internal/store/storetest/suite.go:106:32: added[0].Version undefined (type task.Task has no field or method Version)
internal/store/storetest/suite.go:108:68: too many arguments in call to s.Complete
	have (context.Context, "github.com/google/uuid".UUID, unknown type)
	want (context.Context, "github.com/google/uuid".UUID)
...
internal/store/storetest/suite.go:130:32: undefined: store.ErrConflict
internal/store/storetest/suite.go:130:32: too many errors
...
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/db	0.026s
FAIL	todo/internal/store [build failed]
FAIL	todo/internal/store/storetest [build failed]
ok  	todo/internal/task	0.003s
FAIL
```

Every complaint is the same kind of thing: the tests describe code that does not exist yet. There is no `Version` field, `Complete` takes only an id, and `store.ErrConflict` has never been written. The compiler is the checklist — it names every call site that has to change.

## The version column

Now the code. The database needs somewhere to keep the version, so the schema grows one column. The schema lives in migration files, and this change is one statement:

<!-- verify: internal/db/migrations/00003_task_version.sql at=transactions -->
```sql title="internal/db/migrations/00003_task_version.sql"
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
```

An **additive** migration is the friendly kind: it only adds. `ADD COLUMN` appends the column, and every row that already exists reads back at the default, 1 — the same version a brand-new task gets. Nothing is copied, nothing is rewritten, and the `Down` half undoes it with one `DROP COLUMN`.

The domain type gains the field, and its comment carries the contract:

<!-- verify: internal/task/task.go at=transactions -->
```go title="internal/task/task.go"
	// Version counts the writes the task has seen. A store assigns 1 when
	// it stores the task and bumps it on every write; a caller reads it
	// with the task and hands it back with a write, which the store
	// accepts only while the version still matches. The zero value is
	// "no snapshot yet": stores overwrite it on Add.
	Version int
```

Both stores assign the version the way they already assign the id — inside `Add`, overwriting whatever the caller passed:

<!-- verify: internal/store/turso.go at=transactions -->
```go title="internal/store/turso.go"
	// The stored task starts at version 1, whatever the argument carried:
	// the version, like the id, is the store's to assign.
	t.ID = id
	t.Version = 1
```

The version belongs to the store, not the caller: if a caller could choose it, someone could invent a version the store never handed out and defeat the check. The memory store makes the same two assignments.

The schema snapshot file — the plain-text picture of the tables that a test compares against — gains one line:

<!-- verify: internal/db/schema.sql at=transactions -->
```text title="internal/db/schema.sql"
table tasks
  id TEXT NOT NULL pk=1
  title TEXT NOT NULL
  status TEXT NOT NULL
  priority INTEGER NOT NULL
  due TEXT
  version INTEGER NOT NULL default 1
```

That snapshot is what makes a forgotten schema change visible: the test compares the tables the migrations build with this file, and they must match line for line.

## The compare-and-swap

The heart of the version check is one SQL statement, and sqlc turns it into Go:

<!-- verify: internal/db/queries/tasks.sql at=transactions -->
```sql title="internal/db/queries/tasks.sql"
-- Marks the task with the given id as done and reports how many rows
-- changed, which is how the store tells a hit from a miss or a stale
-- version. The WHERE clause pins the version the caller read and the SET
-- clause bumps it, so the compare and the write are one statement: the
-- database decides whether the snapshot is still current, and zero rows
-- changed means it was not (or the task is gone, which the store's GetTask
-- probe tells apart).
-- name: CompleteTask :execrows
UPDATE tasks
SET status = ?, version = version + 1
WHERE id = ? AND version = ?;
```

`WHERE id = ? AND version = ?` is the compare; `SET status = ?, version = version + 1` is the swap. They are one statement, so no other writer can slip between checking the version and writing — the check and the write happen as a single act. `:execrows` is what makes the statement report back: the generated method returns how many rows it changed, and zero rows is a successful statement that means "nothing matched".

The generated code carries the check without any hand-written SQL:

<!-- verify: internal/db/tasks.sql.go at=transactions -->
```go title="internal/db/tasks.sql.go"
func (q *Queries) CompleteTask(ctx context.Context, arg CompleteTaskParams) (int64, error) {
	result, err := q.db.ExecContext(ctx, completeTask, arg.Status, arg.ID, arg.Version)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
```

That is the whole generated surface: the statement, its three parameters, and the count of rows it changed. Now the stores. First the new sentinel — a named error value the caller can match with `errors.Is`:

<!-- verify: internal/store/store.go at=transactions -->
```go title="internal/store/store.go"
// ErrConflict is reported when an operation's snapshot of a task is stale:
// the caller read the task at one version, someone else wrote it since, and
// the write that carried the old version lost the compare-and-swap. The
// caller's answer is to re-read the task and decide again, which is why the
// error is a sentinel rather than a description of what changed — the store
// cannot know what the caller meant to write. A stale snapshot is not the
// same thing as a missing task (ErrNotFound) or as an engine-level
// write-write conflict the store retries internally; those keep their own
// meanings.
var ErrConflict = errors.New("task was modified")
```

The memory store's `Complete` compares under its write lock, so the compare and the write cannot be split:

<!-- verify: internal/store/store.go at=transactions -->
```go title="internal/store/store.go"
	for i, t := range s.tasks {
		if t.ID != id {
			continue
		}
		if t.Version != version {
			return fmt.Errorf("complete task %s: %w", id, ErrConflict)
		}
		s.tasks[i].Status = task.StatusDone
		s.tasks[i].Version++
		return nil
	}
	return fmt.Errorf("complete task %s: %w", id, ErrNotFound)
```

The database store has no lock to lean on, so it classifies a zero-row result with one follow-up read. The order matters: a task that is gone must be reported as missing even when the version is also stale, so the probe decides between the two:

<!-- verify: internal/store/turso.go at=transactions -->
```go title="internal/store/turso.go"
	_, err = s.queries.GetTask(ctx, id.String())
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("complete task %s: %w", id, ErrNotFound)
	case err != nil:
		return fmt.Errorf("complete task %s: %w", id, err)
	default:
		return fmt.Errorf("complete task %s: %w", id, ErrConflict)
	}
```

The exact messages, printed from a scratch run of both stores:

```text
stale Complete:    complete task 01a13a2c-5469-7f3c-b5f2-fd042e65892c: task was modified
missing Complete:  complete task 00000000-0000-0000-0000-000000000000: task not found
turso stale:       complete task 01a13a2c-547b-7605-a62a-365b6a8153d8: task was modified
turso missing:     complete task 00000000-0000-0000-0000-000000000000: task not found
```

Both stores report the same two errors: a stale snapshot is `task was modified`, a missing task is `task not found`, and `errors.Is` finds both.

The batch helper carries the version through, so completing many tasks never overwrites a concurrent writer either. Each target is a whole task — the id and the version the caller read, together:

<!-- verify: internal/store/store.go at=transactions -->
```go title="internal/store/store.go"
func CompleteAll(ctx context.Context, s Store, targets []task.Task) error {
	var errs []error
	for _, t := range targets {
		if err := s.Complete(ctx, t.ID, t.Version); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
```

And the CLI's seed step passes the tasks `Add` returned, id and version together:

<!-- verify: cmd/todo/main.go at=transactions -->
```go title="cmd/todo/main.go"
	if err := store.CompleteAll(ctx, s, added[:1]); err != nil {
		return err
	}
```

Regenerate the Go from the query — the same command all the generated code comes from:

```bash
$ go generate ./...
```

It prints nothing when it succeeds; sqlc rewrites the query methods, and the mock generator follows the changed interface. Then run everything:

```bash
$ go test -count=1 ./...
```

```text
ok  	todo/cmd/todo	0.003s
ok  	todo/internal/db	0.029s
ok  	todo/internal/store	0.077s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.004s
```

Everything passes — but the writes still take turns. The version refuses a stale write; it does not yet let several writers work at once.

## Every write rides a transaction

A single database write is its own little transaction: it either lands or it doesn't. To group several writes, you say so. A statement starts the group, the writes happen inside it, and one final statement makes them all real. If anything fails first, one statement undoes the group and the data is exactly as it was — that undo is the **rollback**, and it is where "all or nothing" lives.

The engine underneath can run several transactions at the same time. The mode that allows this keeps older versions of each row around, so every transaction works from its own **snapshot** — the data as it looked when the transaction started. The mode is called **MVCC**, short for multi-version concurrency control. Two writers touching different tasks never wait for each other; when two transactions touch the same row, the engine reports a **write-write conflict** instead of letting one silently overwrite the other.

Our helper opens one such transaction on a connection of its own:

<!-- verify: internal/store/tx.go at=transactions -->
```go title="internal/store/tx.go"
func concurrentTxOnce(ctx context.Context, db *sql.DB, fn func(*sql.Conn) error) error {
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
```

Three details carry the discipline. The transaction gets a dedicated connection, so nothing else can use it mid-transaction. The undo is deferred, so every path that does not reach the final statement — a failed beginning, a failing function, a failed ending — undoes whatever the attempt wrote. And the undo runs under `context.WithoutCancel`, so even a canceled caller cannot leave a transaction open for the connection's next user.

The helper on top retries the two shapes worth retrying — a busy engine, and a write-write conflict — with a wait that doubles between attempts, up to a small bound:

<!-- verify: internal/store/tx.go at=transactions -->
```go title="internal/store/tx.go"
	for attempt := 1; attempt <= txMaxAttempts; attempt++ {
		if err = concurrentTxOnce(ctx, db, fn); err == nil {
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
```

Everything else fails as itself. A duplicate id, for example, is a fact about the data — running it again would fail identically — so the predicate that decides "retry" matches exactly the two transient shapes:

<!-- verify: internal/store/tx.go at=transactions -->
```go title="internal/store/tx.go"
func isRetryable(err error) bool {
	if errors.Is(err, turso.ErrTursoBusy) {
		return true
	}
	return errors.Is(err, turso.ErrTursoGeneric) && strings.Contains(err.Error(), "Write-write conflict")
}
```

The conflict needs its message checked because the driver reports it under a generic kind — the message is the only handle it offers. The retry replays the function from the start, which is why `Add` and `Complete` can ride it: each attempt is a fresh run of the same work. The importer cannot ride it, and the reason waits in the importer's section below.

Then the mode. It is a property of the file, not of a connection, so it is set once when the store opens, before the migrations run, and read back so a refused mode fails the open instead of the first write:

<!-- verify: internal/store/turso.go at=transactions -->
```go title="internal/store/turso.go"
	var mode string
	if err := sqlDB.QueryRowContext(ctx, "PRAGMA journal_mode = mvcc").Scan(&mode); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("open turso store %s: enable mvcc: %w", path, err)
	}
	if mode != "mvcc" {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("open turso store %s: journal mode is %q, want mvcc", path, mode)
	}
```

And the pool of open connections grows from one to eight, because concurrent transactions are the point now. The one exception is a `:memory:` database, where every new connection opens its own private, empty copy — so that path keeps the single connection the schema lives on:

<!-- verify: internal/store/turso.go at=transactions -->
```go title="internal/store/turso.go"
	maxConns := 8
	if path == memoryPath {
		maxConns = 1
	}
	sqlDB.SetMaxOpenConns(maxConns)
```

If you wire the helper in before the mode is on — the natural order to write the code — the engine says exactly what is missing:

```text
=== RUN   TestTursoStore_ConcurrentWriters
=== PAUSE TestTursoStore_ConcurrentWriters
=== CONT  TestTursoStore_ConcurrentWriters
    turso_test.go:245: 
...
        	            	add task: concurrent transaction: begin: turso: error: Transaction error: Concurrent transaction mode is only supported when MVCC is enabled
...
--- FAIL: TestTursoStore_ConcurrentWriters (0.02s)
```

With the mode on, the multi-writer test — a competing transaction held open with an unfinished write, then eight writers adding twenty-five tasks each — lands every write while the competing transaction is still open.

The last piece is what `Close` leaves behind. In this mode the file keeps a sidecar log beside it, and the newest changes — the schema included — live in that log until it is folded back into the main file. A copy of the main file alone is then not a database. So `Close` folds the log in first:

<!-- verify: internal/store/turso.go at=transactions -->
```go title="internal/store/turso.go"
func (s *TursoStore) Close() error {
	_, _ = s.db.ExecContext(context.Background(), "PRAGMA wal_checkpoint(TRUNCATE)")
	return s.db.Close()
}
```

The fold is best effort — a failure never turns a close into an error — and it runs first, so the file a caller copies afterwards is the whole database.

Run the helper's own tests:

```bash
$ go test -v -count=1 -run '^TestWithConcurrentTx$' ./internal/store
```

```text
--- PASS: TestWithConcurrentTx (0.00s)
    --- PASS: TestWithConcurrentTx/commit_makes_the_write_visible (0.00s)
    --- PASS: TestWithConcurrentTx/rollback_after_an_error_leaves_nothing (0.00s)
    --- PASS: TestWithConcurrentTx/a_write-write_conflict_is_retried_and_the_retry_commits (0.00s)
    --- PASS: TestWithConcurrentTx/a_constraint_error_is_not_retried (0.00s)
```

The four names are the four outcomes the helper must produce: a successful write is visible, a failure rolls back, a conflict is retried until it lands, and a constraint failure is not retried at all. The test fabricates the conflict shape on the first attempt — a real one needs a second writer holding the row — which is enough to prove the loop runs the function again:

<!-- verify: internal/store/tx_test.go at=transactions -->
```go title="internal/store/tx_test.go"
		err = withConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			attempts++
			if err := insert(conn, id.String()); err != nil {
				return err
			}
			if attempts == 1 {
				return fmt.Errorf("%w: Write-write conflict", turso.ErrTursoGeneric)
			}
			return nil
		})
		require.NoError(t, err)
		assert.Equal(t, 2, attempts, "the failed attempt was retried")
		assert.Equal(t, 2, count(), "the retry's insert is the one that landed")
```

Run the two multi-writer tests ten times under the race detector — the strongest statement we can make about this code:

```bash
$ go test -race -count=10 -run 'TestTursoStore_ConcurrentWriters|TestTursoStore_WriteWriteConflictIsNotErrConflict' ./internal/store
```

```text
ok  	todo/internal/store	1.683s
```

No races, and every writer's write landed every time.

## The importer lands everything or nothing

The export side of the app writes a JSON document holding every task; the import side reads one back. Until now the importer knew only the current document shape and wrote one task at a time — so a document that went bad halfway left its first half in the store. That is the half-a-transfer failure a transaction exists to prevent, and now there is one to ride.

The document's own version moves to 3, the shape that carries the task's version:

<!-- verify: internal/store/export.go at=transactions -->
```go title="internal/store/export.go"
const exportVersion = 3
```

The public door walks the envelope — the version field first, then the tasks array — and hands the store a stream, not a slice. The store pulls one task at a time while its own write is open:

<!-- verify: internal/store/importer.go at=transactions -->
```go title="internal/store/importer.go"
	// The store pulls the stream inside its own write: for the Turso store
	// that is one BEGIN CONCURRENT transaction whose rollback undoes a
	// failed import, for the memory store one buffered append under one
	// lock. Either way the count is the batch's size, and on error it is
	// zero — nothing landed.
	count, err := bi.insertAll(ctx, stream)
	if err != nil {
		return 0, fmt.Errorf("import tasks: %w", err)
	}
	return count, nil
```

That is the atomicity story in one call: the document is never held whole in memory, and the store's transaction is what makes the batch all-or-nothing. A malformed task, a task the store refuses, or a document that does not end cleanly rolls the whole batch back.

Older documents are the importer's business, so it reads versions 1 through 3 and maps each shape forward:

<!-- verify: internal/store/importer.go at=transactions -->
```go title="internal/store/importer.go"
	if version < 1 || version > exportVersion {
		return nil, fmt.Errorf("unsupported version %d", version)
	}
	...
		if version == 2 {
			// v2 predates the version column: every task it holds was at
			// version 1 by definition, and the absent field would otherwise
			// decode as the zero version.
			t.Version = 1
		}
		if t.Version < 1 {
			// A v3 task at version 0 is not a task this store could have
			// written: Add assigns 1 and every write bumps it. Refusing it
			// keeps "version counts committed writes" true for imported
			// rows instead of admitting one that no CAS would ever match.
			return task.Task{}, fmt.Errorf("task %d: version %d is invalid", i, t.Version)
		}
		return t, nil
```

The mapping's smallest half is the v2 rule: a v2 document predates the version column, so every task in it was at version 1 by definition, and the importer writes that value instead of the zero the absent field decodes to. The strictest half is the last check: a v3 task at version 0 is a task no store could have written, because `Add` assigns 1 and every write moves it — so the importer refuses it rather than admitting a row that no version check could ever match.

One more distinction lives in the end-of-document check. The stores' insert loops treat the stream's clean end as "the batch is complete", so a document that stops early must report a *different* error — otherwise a truncated import would look like a clean finish:

<!-- verify: internal/store/importer.go at=transactions -->
```go title="internal/store/importer.go"
func closeDocument(d *json.Decoder) error {
	tok, err := d.Token()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("document ends inside the tasks array: %w", io.ErrUnexpectedEOF)
		}
		return err
	}
	...
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return errors.New("trailing data after the document")
	}
	return nil
}
```

`io.EOF` is the clean finish; `io.ErrUnexpectedEOF` is "the document ended where the format says it cannot". The check runs from the stream's exhaustion pull, inside the store's write, so a document that does not end cleanly rolls the batch back instead of landing it and then reporting it.

The two stores carry the batch differently, and both are all-or-nothing. The database store streams straight into one concurrent transaction:

<!-- verify: internal/store/turso.go at=transactions -->
```go title="internal/store/turso.go"
	count := 0
	err := concurrentTxOnce(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		for {
			t, err := stream()
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return err
			}
			...
			count++
		}
	})
```

The memory store has no transaction to ride, so its promise comes from buffering: the stream is pulled into a slice, and the whole batch is appended under one write lock, so a failure while streaming never reaches the store.

<!-- verify: internal/store/store.go at=transactions -->
```go title="internal/store/store.go"
	var batch []task.Task
	for {
		t, err := stream()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return 0, err
		}
		batch = append(batch, t)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tasks = append(s.tasks, batch...)
	return len(batch), nil
```

Run the importer's atomicity tests — the ones that check a broken document leaves nothing behind:

```bash
$ go test -count=1 -run '^TestImportJSON_Atomic$' -v ./internal/store
```

```text
...
--- PASS: TestImportJSON_Atomic (0.00s)
    --- PASS: TestImportJSON_Atomic/MemoryStore/unknown_status (0.00s)
    --- PASS: TestImportJSON_Atomic/MemoryStore/truncated_element (0.00s)
    --- PASS: TestImportJSON_Atomic/MemoryStore/document_ends_inside_the_array (0.00s)
    --- PASS: TestImportJSON_Atomic/MemoryStore/document_ends_after_a_decoded_task (0.00s)
    --- PASS: TestImportJSON_Atomic/MemoryStore/trailing_data_after_the_document (0.00s)
    --- PASS: TestImportJSON_Atomic/TursoStore/unknown_status (0.02s)
    --- PASS: TestImportJSON_Atomic/TursoStore/truncated_element (0.02s)
    --- PASS: TestImportJSON_Atomic/TursoStore/document_ends_inside_the_array (0.02s)
    --- PASS: TestImportJSON_Atomic/TursoStore/document_ends_after_a_decoded_task (0.02s)
    --- PASS: TestImportJSON_Atomic/TursoStore/trailing_data_after_the_document (0.02s)
PASS
ok  	todo/internal/store	0.026s
```

Five ways a document can go bad after its first element — an unknown status, a truncated element, a document that stops inside the array, one that stops after a decoded task, and trailing data — and in every case the store is exactly as it was: the seeded task and nothing else, with the count zero. The tests come with the importer; run them against the old importer first and it answers with exactly what it cannot do: `import tasks: unsupported version 3, want 2`.

## If something went wrong

**The engine refuses the concurrent transaction.** Before the mode is on, the first write reports:

```text
add task: concurrent transaction: begin: turso: error: Transaction error: Concurrent transaction mode is only supported when MVCC is enabled
```

The mode is opt-in per file, and the file is still in its default mode, so a concurrent transaction is refused where it begins. Fix: run the database setting `PRAGMA journal_mode = mvcc` once when the store opens, before the migrations run, and read the mode back — a refused mode then fails the open instead of the first write. The mode lives in the file, so later opens inherit it.

**The schema snapshot disagrees with the migrations.** After adding the column, the snapshot test fails:

```text
--- FAIL: TestMigratedSchemaMatchesGolden (0.02s)
    migrate_test.go:207: migrated schema differs from schema.sql (-golden +migrated):
          (
          	"""
          	... // 9 identical lines
          	  priority INTEGER NOT NULL
          	  due TEXT
        + 	  version INTEGER NOT NULL default 1
          	"""
          )
        
        regenerate it with: make schema-update
```

The migration changed the tables, and the snapshot file still shows the old shape. Fix: run `make schema-update`, which rewrites the snapshot from the migrations. The migration tests also pin the newest schema version, and those numbers move to 3.

**"Write-write conflict" is not "task was modified".** Two different conflicts reach the caller, and they mean opposite things. The engine's shape:

```text
complete task 01a13a4f-65cd-7b21-996b-f35cb1c1beff: concurrent transaction: turso: error: Write-write conflict
Is ErrConflict: false
```

The app's own stale-snapshot error, for contrast, is a different sentence entirely:

```text
complete task 01a13a2c-5469-7f3c-b5f2-fd042e65892c: task was modified
```

The first is the engine's transient contention: another transaction touched the row first, and the store retries it internally. The second is the app's stale snapshot: the caller's version lost the race, and the answer is to re-read the task and decide again. The store keeps them apart by construction — the stale-snapshot error is only produced when the version check fails, never from a transaction error.

**A lone `.db` copy that is not a database.** Copy the main file while the store is open, and the copy cannot find the table:

```text
lone copy BEFORE close: count=0 err=turso: error: Parse error: no such table: tasks
```

The newest changes — the schema included — still live in the sidecar log beside the file, and a copy of the main file alone is missing all of them. Fix: `Close` folds the log back into the file first, so a copy made after `Close` is whole (`count=1 err=<nil>`). A copy taken while the store is still open must take the file and its sidecars together, or be an export document instead.

**A truncated document that lands its leading tasks.** The insert loop treats the stream's clean end as "done", so a document that stops early must report a different error — otherwise it looks like a success, and the tasks before the stop land:

```text
import: count=1 err=<nil>
store holds 1 task(s)
  "leading" status=Todo
```

Fix: the end-of-document check reports `io.ErrUnexpectedEOF` — "the document ended where the format says it cannot" — so the store sees a failure, the transaction rolls back, and nothing lands.

<details>
<summary>Going deeper: why a version, not a lock</summary>

The other way to stop a lost update is a lock: the first writer holds the task from the moment it reads until the moment it writes, and everyone else waits. That design is **pessimistic concurrency**, and for this app it would hold a database lock while a person decides what to do — minutes of waiting for anyone else who touches that task. The version makes the same guarantee without the waiting: readers run free, and the clash is detected at write time as an ordinary error. The price is that a clash is possible at all; for a todo list, that price is right.

</details>

<details>
<summary>Going deeper: why even a one-statement write rides a transaction</summary>

The update that completes a task is a single statement, so it could run on its own — every statement is a small transaction by itself. In the new mode, though, a write outside an explicit transaction still takes the engine's exclusive path, and a concurrent transaction cannot finish while an exclusive one is active. A scratch probe measured the difference, in milliseconds, three runs each:

```text
complete-autocommit  committed=1481–1515  conflict=85–107  elapsed=74–97 ms
complete-wrapped     committed=1600       conflict=0      elapsed=27–30 ms
```

So every write in the store rides a concurrent transaction, one statement or ten. The single statement is exactly where the temptation to skip it lives.

</details>

<details>
<summary>Going deeper: what the new mode is worth</summary>

The mode and the pool of connections are worth measuring together, because either one alone is not the win. A scratch probe ran the store's insert shape — a task plus its labels in one transaction, eight writers × one hundred — under four setups, three runs each:

```text
pool1-plain          committed=800 conflict=0   44.1 / 52.4 / 46.6
pool1-concurrent     committed=800 conflict=0   54.7 / 50.8 / 50.5
pool8-plain          committed=800 conflict=0  109.4 / 109.2 / 75.4
pool8-concurrent     committed=800 conflict=0   17.6 / 19.6 / 16.7
```

Every setup landed all 800 writes; the engine's busy wait absorbed the rest. One connection serializes writers (~44–52 ms). Eight connections without the mode are slower than one (~75–109 ms): the writers now contend for the engine's single write lock and spend their time waiting. Only the pool and the mode together overlap: ~17–20 ms. The mode is worth eight connections only because the write path uses them at the same time.

</details>

<details>
<summary>Going deeper: what happened to the old integer ids</summary>

Version 1 documents came from the era when ids were integers. An integer carries no timestamp and no randomness, so it cannot be rebuilt into a UUID — the importer gives each task a fresh v7 value in document order:

<!-- verify: internal/store/importer.go at=transactions -->
```go title="internal/store/importer.go"
		if version == 1 {
			var old importTaskV1
			if err := d.Decode(&old); err != nil {
				return task.Task{}, fmt.Errorf("task %d: %w", i, err)
			}
			// ...
			id, err := uuid.NewV7()
			if err != nil {
				return task.Task{}, fmt.Errorf("task %d: %w", i, err)
			}
			return task.Task{
				ID:       id,
				Version:  1,
				Title:    old.Title,
				Status:   old.Status,
				Priority: old.Priority,
				Due:      old.Due,
				Tags:     old.Tags,
			}, nil
		}
```

Document order is the only order the integer era left to preserve. Everything else maps forward: v2 predates the version column and normalizes to 1, and v3 keeps both id and version as written.

</details>

The store is now safe for many writers and whole documents — next, the app gets a face: real commands you can type.
