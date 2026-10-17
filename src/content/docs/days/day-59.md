---
title: "Day 59 — Making it faster"
description: "Measure where the app spends its time at a hundred thousand tasks, then make the changes the numbers point at."
sidebar:
  order: 59
chapter: 50
---

**About 3 hours** · Part X, day 6 of 6.

**You'll be able to:**

- profile before changing anything;
- make the list fast with an index and a merge join, and record the measurements that refused.

---

The app is finished. It adds tasks, lists them, completes them, and keeps them in a database that survives a restart — from a command line, a web page, and a terminal window. On the few dozen tasks a person types in a day, every command feels instant.

Instant is a claim about a small list. What happens at a hundred thousand tasks? We have never asked, and the honest answer is that we do not know.

So we measure. The tool for measuring a running program is a **profiler**: it watches the program work and writes down where the time goes, like a time-and-motion study on a workshop floor. A benchmark says how slow a whole operation is; the profile says which parts to blame.

Three changes come out of the profile, and one ceiling. By the end, finding a single task among a hundred thousand goes from 35 milliseconds to under a quarter of a millisecond — and we can say why, because we watched it happen.

## A bigger list to measure against

Our benchmarks so far measure the store that keeps tasks in memory, at a hundred and at ten thousand tasks. They are good at comparing two versions of that code, and they cannot see the database at all: when the tasks live in a real file, most of the cost happens inside the engine and the driver, not in our loops.

So we build a second workload: a Turso database seeded with a hundred thousand tasks, and benchmarks that read it. Two details make it a measuring tool rather than a demo.

The first is determinism. The seeded rows never read the clock, and every id is generated from the row's position in the list — so every run, on every machine, seeds exactly the same data, and two runs compare the same thing. The second is a needle: exactly one task in the hundred thousand carries a label called `needle`. A label a third of the tasks carry measures the common case; one row measures what an index is for.

Create `internal/store/perf_bench_test.go` with these opening pieces:

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
...
// The database is built once per process and reused by every benchmark in
// the run; TODO_PERF_DB names the file when a capture wants to share one
// database across processes — benchstat comparisons interleave two test
// binaries, and re-seeding a hundred thousand tasks per process would make
// the seeding dominate the capture. The seeded rows are deterministic:
// benchTask reads no clock, and the ids are generated from the row index, so
// the same file is the same workload in every process that opens it.
```

The comment names the file's shared decisions: the database is built once per run, and `TODO_PERF_DB` names the file when two test binaries must read the same seeded database — the interleaved comparisons the benchmark work set up. Then the two constants:

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
// perfTaskCount is the workload's size: the number of tasks the seeded
// database holds. It is named in every benchmark's sub-name, because a
// comparison across a size change would be a comparison of two workloads.
const perfTaskCount = 100_000

// perfSeedBatch is how many tasks one seeding transaction inserts. Ten
...
const perfSeedBatch = 10_000
```

`perfTaskCount` is the workload's size, and `perfSeedBatch` is how many rows one transaction inserts — seeding is not what we are measuring, so it only has to be fast enough to run between captures. The folder that holds the seeded database is made once per run and removed when the run ends:

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
// perfDirOnce and perfDir are the process's seeded database directory. The
// benchmarks share one file per process — not one per benchmark and not one
// per count — because seeding is the expensive part of the suite and every
// benchmark reads the same workload; a per-test file would seed a hundred
// thousand tasks once per benchmark per -count. TestMain removes the
// directory when the process ends.
var (
	perfDirOnce sync.Once
	perfDir     string
)

func perfDirFor(b *testing.B) string {
	b.Helper()
	perfDirOnce.Do(func() {
		dir, err := os.MkdirTemp("", "todo-perf-*")
		if err != nil {
			b.Fatalf("create perf directory: %v", err)
		}
		perfDir = dir
	})
	return perfDir
}

// TestMain removes the process's seeded database when the run ends. The
// benchmarks build it under the system temp directory rather than under a
// test's, because it must outlive the test that seeded it — see perfStore.
func TestMain(m *testing.M) {
	code := m.Run()
	if perfDir != "" {
		_ = os.RemoveAll(perfDir)
	}
	os.Exit(code)
}
```

Next, the opener every benchmark shares. Read the middle: an existing file is adopted only when it already holds exactly the right number of tasks, so a half-seeded or stale file fails loudly instead of being read as the workload.

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
// perfStore returns the seeded store the Turso benchmarks read. The file is
// TODO_PERF_DB when set — the interleaved-capture case, where both binaries
// must open one database — and a process-owned temp file otherwise. An
// existing file is adopted only when it already holds exactly
// perfTaskCount tasks, so a half-seeded or stale file fails the benchmark
// loudly instead of being read as the workload.
func perfStore(b *testing.B) *TursoStore {
	b.Helper()
	path := os.Getenv("TODO_PERF_DB")
	if path == "" {
		path = filepath.Join(perfDirFor(b), "perf.db")
	}
	s, err := NewTursoStore(context.Background(), path)
	if err != nil {
		b.Fatalf("open perf store %s: %v", path, err)
	}
	b.Cleanup(func() { _ = s.Close() })

	var n int
	if err := s.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM tasks").Scan(&n); err != nil {
		b.Fatalf("count perf tasks: %v", err)
	}
	if n == perfTaskCount {
		return s
	}
	if n != 0 {
		b.Fatalf("%s holds %d tasks, want 0 or %d", path, n, perfTaskCount)
	}
	seedPerfStore(b, s)
	return s
}
```

The seed itself walks from zero to a hundred thousand in batches, one transaction per batch, and reports its own cost at the end — the `b.Logf` line:

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
// seedPerfStore inserts the workload: perfTaskCount tasks built by
// perfSeedTask, in batches of perfSeedBatch rows inside one concurrent
// transaction each. The ids are generated from the row index rather than by
// uuid.NewV7, so every process that seeds builds the same keys and an
// interleaved capture compares two binaries over one database.
func seedPerfStore(b *testing.B, s *TursoStore) {
	b.Helper()
	ctx := context.Background()
	start := time.Now()
	for lo := 0; lo < perfTaskCount; lo += perfSeedBatch {
		hi := min(lo+perfSeedBatch, perfTaskCount)
		err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
			q := db.New(conn)
			for i := lo; i < hi; i++ {
				t := perfSeedTask(i)
				if err := q.InsertTask(ctx, db.InsertTaskParams{
					ID:       t.ID.String(),
					Title:    t.Title,
					Status:   string(t.Status),
					Priority: int64(t.Priority),
					Due:      dueSQL(t.Due),
					Version:  int64(t.Version),
				}); err != nil {
					return err
				}
				for _, tag := range uniqueTags(t.Tags) {
					if err := q.InsertTag(ctx, db.InsertTagParams{TaskID: t.ID.String(), Tag: tag}); err != nil {
						return err
					}
				}
			}
			return nil
		})
		if err != nil {
			b.Fatalf("seed perf store: %v", err)
		}
	}
	b.Logf("seeded %d tasks in %s", perfTaskCount, time.Since(start))
}
```

Now the needle, and the two helpers that make every row deterministic:

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
// perfRareTag and perfRareTagIndex are the workload's needle: exactly one
// task carries perfRareTag, and its row index is chosen so benchTask gives
// it no other tags — 77777 is divisible by 7, the pattern's no-tags case. A
// tag every third task carries measures the common case; the needle measures
// what an access path is for: finding one row in a hundred thousand without
// reading the table.
const (
	perfRareTag      = "needle"
	perfRareTagIndex = 77777
)

// perfSeedTask builds the i-th task of the workload: benchTask's shape with
// a deterministic id, plus the needle. The id is the row index in UUIDv7's
// text form — a fixed prefix, the version and variant nibbles set, and the
// index in the low bits — so id order is index order and ListTasks' ORDER BY
// id is the insertion order the domain promises.
func perfSeedTask(i int) task.Task {
	t := benchTask(i)
	if i == perfRareTagIndex {
		t.Tags = []string{perfRareTag}
	}
	t.ID = perfSeedID(i)
	t.Version = 1
	return t
}

// perfSeedID formats the row index as the UUIDv7 text a store would have
// assigned: uuid's 8-4-4-4-12 layout, version 7 in the third group's high
// nibble, variant 10 in the fourth group's high bits. The index is decimal
// here — the point is determinism, not a plausible timestamp — and it fits
// the last group's twelve digits for every index the workload uses.
func perfSeedID(i int) uuid.UUID {
	return uuid.MustParse(fmt.Sprintf("01a00000-0000-7000-8000-%012d", i))
}
```

Every benchmark in the file is the same shape around one store call. This is the needle's:

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
func BenchmarkTursoByTagRare(b *testing.B) {
	s := perfStore(b)
	b.Run(fmt.Sprintf("n=%d", perfTaskCount), func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			got, err := s.ByTag(benchCtx, perfRareTag)
			if err != nil {
				b.Fatal(err)
			}
			benchSink.tasks = got
		}
	})
}
```

The rest of the file is that shape around `List`, `ByTag`, `SortByDue`, `Stats`, `Get`, and `Complete`, with `perfSink` holding the results that do not fit `benchSink`:

<!-- verify: internal/store/perf_bench_test.go at=optimization -->
```go title="internal/store/perf_bench_test.go"
// perfSink keeps the benchmarked Turso calls' results reachable, for the
// same reason benchSink does: a call whose result nothing reads can be
// optimized away.
var perfSink struct {
	stats Stats
	done  int
}
```

Like `benchSink`, it keeps each result reachable, because a call whose result nothing reads can be optimized away. Run the suite once. The first process seeds the database — about thirteen seconds — and then the benchmark rows follow:

```bash
$ go test -bench=. -benchmem -count=1 ./internal/store
seeded 100000 tasks in ~13s
...
```

Here are the suite's numbers, medians of six runs each, on the unfixed code:

```text
TursoList/n=100000-16        1589.136 ms   382.95 MB   11972254 allocs
TursoByTag/n=100000-16        701.261 ms   141.90 MB    4389025 allocs
TursoByTagRare/n=100000-16     35.065 ms     0.01 MB        283 allocs
TursoSortByDue/n=100000-16   1811.804 ms   382.95 MB   11972255 allocs
TursoStats/n=100000-16        353.578 ms     0.01 MB        350 allocs
TursoGet/n=100000-16            0.135 ms     0.01 MB        317 allocs
TursoComplete-16                0.062 ms     0.00 MB        129 allocs
...
```

Read the shapes before the numbers. A full list costs 1.6 to 1.8 seconds and moves 383 MB. A single read of one known task costs 135 microseconds — reading one row is about eleven thousand times less work than reading all of them. And the needle costs 35 milliseconds, hundreds of times the single read, even though it matches exactly one row. The engine has no way to find that row except by looking at every label row in the database. That last line is the clue the rest of the chapter follows.

## Watch where the time goes

The numbers say how slow the reads are. The profile says where the time goes. Go can record one while a benchmark runs: `-cpuprofile` writes down what the processor was doing, and `-memprofile` writes down what memory was being handed out. Both records are read with a tool called `pprof`, which prints the busiest functions first.

Run the list benchmark four times with a CPU profile attached, then read the top of the record:

```bash
$ go test -bench 'BenchmarkTursoList$' -benchtime=4x -cpuprofile cpu.prof ./internal/store
$ go tool pprof -top cpu.prof
```

`-benchtime=4x` runs the benchmark exactly four times instead of until a second passes — a profile needs only a few trips, and four keeps the session short. The record lands in `cpu.prof`, and the second command prints the busiest functions first:

```text
      flat  flat%   sum%        cum   cum%
    3250ms 33.75% 33.75%     3660ms 38.01%  runtime.cgocall
     480ms  4.98% 38.73%     5040ms 52.34%  github.com/ebitengine/purego.RegisterFunc.func1
     350ms  3.63% 42.37%      530ms  5.50%  runtime.tryDeferToSpanScan
     320ms  3.32% 45.69%     1950ms 20.25%  turso.tech/database/tursogo.turso_statement_row_value_text
...
```

Each row is one function, with two shares. `flat` is the time the profiler caught inside that function itself; `cum` counts it and everything it called. The top rows are the driver's plumbing: `runtime.cgocall` and purego — the layer that lets Go call the engine's native code — and `row_value_text`, one value being read out of one row. The store's own code does not appear at all.

Now the same run with a memory profile, read in objects rather than bytes:

```bash
$ go test -bench 'BenchmarkTursoList$' -benchtime=4x -memprofile mem.prof ./internal/store
$ go tool pprof -sample_index=alloc_objects -top mem.prof
```

```text
      flat  flat%   sum%        cum   cum%
  15663332 35.87% 35.87%   15663332 35.87%  reflect.unsafe_New
   9524964 21.81% 57.68%   16897871 38.69%  turso.tech/database/tursogo.turso_statement_row_value_text
   5046501 11.56% 69.23%   10158386 23.26%  turso.tech/database/tursogo.turso_statement_row_value_kind (inline)
   3407923  7.80% 77.04%   37716997 86.37%  turso.tech/database/tursogo.(*tursoDbRows).Next
   3123953  7.15% 84.19%    3287795  7.53%  turso.tech/database/tursogo.turso_statement_step
   1294530  2.96% 90.20%   20699703 47.40%  todo/internal/db.(*Queries).ListTagsForTasks
   1032652  2.36% 92.57%   22322205 51.11%  todo/internal/store.(*TursoStore).attachTags
```

`reflect.unsafe_New` alone is 36% of every object the run built: each call through the native-code layer bundles its arguments up with reflection and pays for the bundle. And the app's own rows are here: `attachTags` — the function that gives each task its labels — has half the objects allocated beneath it (`cum` 51.11%), with the label query just below.

Two facts follow, and they decide the rest of the chapter. First: the cost is proportional to the number of rows read times the number of values read out of each row, because every value crosses that boundary. Second: the objects come from materializing data — building maps and lists to hold rows we are about to walk anyway.

So there are exactly two reachable levers: touch fewer rows, and build fewer objects on the way through. No cleverer algorithm can move this profile, because the algorithm is not what is on it.

## Give the engine a way in

Start with the needle, the 35 milliseconds. The query behind `ByTag` joins `task_tags` on `tag = ?`. The label table's primary key is the pair `(task_id, tag)`, which orders the rows by task id first — and when the query runs, it does not know any task ids; it only knows the label. So the engine's only route is to read every label row in the database and keep the matching ones. A **query plan** is the engine's own description of its route, and the word for this route is `SCAN`.

An **index** is a second, sorted copy of a column, kept up to date by the engine, so a lookup by that column can jump instead of read — like the index at the back of a book. The pages did not change; you just stop flipping through them one at a time. Add a new migration, `internal/db/migrations/00006_task_tags_tag_index.sql`:

<!-- verify: internal/db/migrations/00006_task_tags_tag_index.sql at=optimization -->
```sql title="internal/db/migrations/00006_task_tags_tag_index.sql"
-- +goose Up
-- The tag access path. ListTasksByTag joins task_tags on tag = ?, and
-- without an index the engine has no way to find the matching rows: the
-- query plan is a full scan of task_tags — every tag row of every task in
-- the database — before the join even starts. The composite primary key
-- (task_id, tag) cannot serve the lookup: its first column is task_id, and
-- the query does not know the ids it wants until the tags are found. This
-- index turns the scan into a seek.
...
CREATE INDEX task_tags_tag ON task_tags(tag);

-- +goose Down
DROP INDEX IF EXISTS task_tags_tag;
```

The comment argues for the index's existence. One sentence belongs beside it: an index is not free, because every insert into the label table also maintains the copy — so the label table gets exactly one, the one a query needs.

The receipt is a test that asks the engine to describe its plans. Create `internal/db/plans_test.go`:

<!-- verify: internal/db/plans_test.go at=optimization -->
```go title="internal/db/plans_test.go"
...
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
...
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
```

`TestQueryPlans` prefixes every generated query with `EXPLAIN QUERY PLAN`, which asks the engine not to run the statement but to say how it would find the rows, and logs the answer. It asserts nothing on purpose: a plan is the engine's answer for a schema, and pinning the engine's exact wording in a test would fail on an upgrade that changed nothing that matters. What it gives us is a command anyone can rerun. The helper below it counts the `?` marks in each statement and hands the driver that many empty arguments, because the engine will not describe a statement whose parameters have not been supplied:

<!-- verify: internal/db/plans_test.go at=optimization -->
```go title="internal/db/plans_test.go"
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
```

Run it, and read the label query's three lines before and after the migration:

```bash
$ go test -count=1 -v -run TestQueryPlans ./internal/db
```

```text
ListTasksByTag     SCAN task_tags
ListTasksByTag     SEARCH tasks USING INDEX sqlite_autoindex_tasks_1 (id=?)
ListTasksByTag     USE SORTER FOR ORDER BY
```

```text
ListTasksByTag     SEARCH task_tags USING INDEX task_tags_tag (tag=?)
ListTasksByTag     SEARCH tasks USING INDEX sqlite_autoindex_tasks_1 (id=?)
ListTasksByTag     USE SORTER FOR ORDER BY
```

`SCAN` reads every row; `SEARCH ... USING INDEX` jumps to the matching ones. The seek replaces the scan, and the needle's read falls from 35 milliseconds to 169 microseconds — about 99.5% off. The other eight queries' plans are unchanged, which is worth noticing: their routes were already fine, and the index is for the one query that had none.

The common reads barely move, either. A label that a third of the tasks carry still matches a third of the table, and the driver's per-value work dominates there. An index is for finding few rows among many — which is exactly why the workload needed a needle to see it.

One more piece: the schema record. The file `internal/db/schema.sql` is the one a test compares against the migrated database, so a shape change nobody meant cannot slip by. It learns one more question — which indexes the migrations declared. In `internal/db/migrate_test.go`, `dumpSchema` gains a third pass per table:

<!-- verify: internal/db/migrate_test.go at=optimization -->
```go title="internal/db/migrate_test.go"
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
```

`pragma_index_list` answers with the indexes a migration created, and the loop writes one line per index with its columns. Then regenerate the record:

```bash
$ make schema-update
```

The regenerated file shows the new index in the same dump a person reads:

<!-- verify: internal/db/schema.sql at=optimization -->
```text title="internal/db/schema.sql"
table task_tags
  task_id TEXT NOT NULL pk=1
  tag TEXT NOT NULL pk=2
  foreign key (task_id) references tasks (id) on update NO ACTION on delete CASCADE match NONE
  index task_tags_tag (tag)
```

Now a dropped index fails the comparison the same way a dropped column does.

## Walk two lists instead of building a map

The second lever is objects. A list read attaches each task's labels after the rows arrive, and the old attachment built a map from task id to task before it walked the label rows: a hash table with one entry per task, one string key per entry, and one lookup per label row. For a hundred thousand tasks, that is a hundred thousand entries built to answer a question the data had already answered.

Look at how the two lists arrive. Every list query orders its tasks by id, and the label query returns its rows ordered by task id too. Two sorted lists can be walked side by side with one finger on each: advance the label finger until it reaches the task finger's id, attach the label, move on. Each row is visited once, forward only — no map, no key strings, no second pass. The walk has a name — a **merge join** — and its cost is the two fingers.

One size detail remains. The label query is generated from a list of task ids, and each id becomes one `?` in the statement's text: a single query for a hundred thousand tasks would be a megabyte of SQL for the engine to parse. So the labels are fetched in chunks of 512 ids:

<!-- verify: internal/store/turso.go at=optimization -->
```go title="internal/store/turso.go"
// tagChunkSize is how many task ids one tag query carries. The generated
// ListTagsForTasks expands its sqlc.slice argument to one placeholder per
// id, and the placeholder list is part of the statement text: one query for
// a hundred thousand tasks is a statement with a hundred thousand
// placeholders — a megabyte of SQL the engine parses, one bind call per id,
// and a statement no other call can share. Chunking bounds the statement,
// and the bound is what makes the query text repeatable: every full chunk
// sends the same 512-placeholder statement, which the driver can prepare
// once per connection, and only the final short chunk is a text of its own.
// 512 is a size, not a law: it is small enough that the SQL stays short and
// large enough that a list read is a handful of queries, not thousands.
const tagChunkSize = 512
```

The constant argues for the size: a statement that repeats exactly is one the driver can prepare once. The first of the two functions is the loop that bounds the work:

<!-- verify: internal/store/turso.go at=optimization -->
```go title="internal/store/turso.go"
// attachTags loads the tags of every task in tasks and assigns them sorted,
// the shape Tags returns. The tasks must be in id order — every query that
// feeds it orders by id (ListTasks, ListTasksByStatus, ListTasksByTag,
// SortTasksByDue), and Get hands it a slice of one — because the walk below
// pairs the two ordered streams instead of building an index.
//
// The shape is a merge join over bounded chunks. For each chunk of at most
// tagChunkSize tasks the store asks ListTagsForTasks for that chunk's tags
// and walks the rows — ordered by task_id, tag — together with the chunk —
// ordered by id — advancing one pointer per row and one per task, never
// backwards. A map from id to task would answer the same question and is
// what this code did before: it cost a hash table with one entry per task,
// one string per id for the map's keys, and one more lookup per tag row.
// The walk costs neither. What it cannot do is tolerate an unordered slice:
// a task out of order would take the rows of its ..., which is why the
// precondition is written here and why the conformance suite — which asserts
// every task's tags on every list query — is the test that holds it.
//
// The generated queries close their rows before returning, so no rows are
// open when the next chunk's query runs: with one connection, a second query
// would wait for a connection that open rows still hold. Both sides key on
// the id's canonical string form, which is what the column stores.
func (s *TursoStore) attachTags(ctx context.Context, tasks []task.Task) error {
	if len(tasks) == 0 {
		return nil
	}
	for lo := 0; lo < len(tasks); lo += tagChunkSize {
		hi := min(lo+tagChunkSize, len(tasks))
		if err := s.attachTagChunk(ctx, tasks[lo:hi]); err != nil {
			return err
		}
	}
	return nil
}
```

`attachTags` walks the task list in chunks of `tagChunkSize` and hands each chunk to `attachTagChunk`. The chunk's half is one forward pass. It renders the chunk's ids once, asks for their label rows, and then walks the two ordered lists together — the inner `for` advances `i` past tasks the current row does not belong to, and the outer loop attaches each row to the task the finger rests on:

<!-- verify: internal/store/turso.go at=optimization -->
```go title="internal/store/turso.go"
// attachTagChunk attaches the tags of one id-ordered chunk. The chunk's ids
// are rendered once, up front: the rows are compared against that slice
// rather than against ID.String(), so the canonical text of each id is built
// once per task instead of once per comparison.
func (s *TursoStore) attachTagChunk(ctx context.Context, tasks []task.Task) error {
	ids := make([]string, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].ID.String()
	}

	rows, err := s.queries.ListTagsForTasks(ctx, ids)
	if err != nil {
		return err
	}

	// Both streams are ordered by id, so one pass pairs them: i names the
	// task the next row belongs to, and it only ever moves forward. A row
	// whose id has no task in the chunk cannot happen — the query asked for
	// exactly these ids — so reaching the end of the chunk ends the walk
	// rather than being treated as an error.
	i := 0
	for _, r := range rows {
		for i < len(tasks) && ids[i] != r.TaskID {
			i++
		}
		if i == len(tasks) {
			break
		}
		tasks[i].Tags = append(tasks[i].Tags, r.Tag)
	}
	return nil
}
```

The precondition is the load-bearing part: the walk is only correct while the tasks are in id order, because a task out of order would collect its neighbor's labels. The comment says so, the conformance suite from the database work asserts every task's labels on every list query, and one new test pins the chunk boundary itself:

<!-- verify: internal/store/turso_test.go at=optimization -->
```go title="internal/store/turso_test.go"
// TestTursoStore_TagsAcrossChunks pins the chunk boundary attachTags works
// in: a list longer than tagChunkSize is attached in more than one query, and
// every task's tags must arrive whole — the first task, the task on the
// boundary, and the last one. The walk pairs the two ordered streams, so a
// bug at a boundary would either drop a chunk's tags or attach them to the
// ..., and this is the test that says so.
func TestTursoStore_TagsAcrossChunks(t *testing.T) {
	t.Parallel()

	s, err := NewTursoStore(context.Background(), tursoStorePath(t))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, s.Close()) })

	ctx := context.Background()
	n := tagChunkSize + 1
	for i := 0; i < n; i++ {
		_, err := s.Add(ctx, task.Task{
			Title: fmt.Sprintf("task-%04d", i),
			Tags:  []string{fmt.Sprintf("tag-%04d", i), "every"},
		})
		require.NoError(t, err)
	}

	tasks, err := s.List(ctx)
	require.NoError(t, err)
	require.Len(t, tasks, n)
	for i, tt := range tasks {
		assert.Equal(t, []string{"every", fmt.Sprintf("tag-%04d", i)}, tt.Tags,
			"task %d carries its own tags and only its own", i)
	}

	// The same check through a filtered query, which is the other path into
	// attachTags: every task carries "every", so ByTag crosses the chunk
	// boundary too.
	byTag, err := s.ByTag(ctx, "every")
	require.NoError(t, err)
	require.Len(t, byTag, n)
	assert.Equal(t, []string{"every", "tag-0000"}, byTag[0].Tags)
	assert.Equal(t, []string{"every", fmt.Sprintf("tag-%04d", n-1)}, byTag[n-1].Tags)
}
```

The test adds 513 tasks — one more than a chunk — each carrying its own label plus one they all share, and checks the first, the last, and every task between through both `List` and `ByTag`. A bug at a chunk boundary would drop labels or attach a neighbor's, and this is the test that would say so.

The honest accounting of the change has two sides. A list read moves 21 MB less — 383 MB down to 362 MB — because the map and its key strings are gone, and the statement no longer grows with the list. In exchange, the per-chunk bookkeeping adds about fifteen thousand small objects on top of twelve million, roughly a tenth of a percent. The time barely moves; the win is the bytes and the bounded statement. Both numbers are written down, because a trade you cannot see is a trade you cannot defend.

## Read one task, not all of them

The `done` command had the same disease one level up. To complete one task, it read every task and scanned for the id — because when the command was written, the store had no way to read a single task. It does now: `Store.Get` reads one row. Here is `findTask` in `internal/cli/cli.go` after the change:

<!-- verify: internal/cli/cli.go at=optimization -->
```go title="internal/cli/cli.go"
// findTask returns the task with the given id from the store, wrapped in the
// done command's own sentence: the error names what the user ran — "done:
// task ..." — not the store operation, so a miss is reported as the store's
// ErrNotFound under the command's words rather than nested inside Get's.
...
func findTask(ctx context.Context, s store.Store, id uuid.UUID) (task.Task, error) {
	t, err := s.Get(ctx, id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return task.Task{}, fmt.Errorf("done: task %s: %w", id, store.ErrNotFound)
	case err != nil:
		return task.Task{}, err
	default:
		return t, nil
	}
}
```

The switch is the whole trick. `Get` reports a missing task with the store's own `ErrNotFound`, but the command's promise is its own sentence — `done: task <id>: task not found` — so the first case rewraps the miss in the command's words, and the other two cases pass the task or the error through unchanged. The version handed back is the one `Complete` checks, because `Get` reads the same row `List` would have found.

Measured with the release binary against the seeded database, three rounds, alternating the old and new builds, running `todo done <id>`:

```text
before: 1.54 s, 94852 KB peak RSS      after: 0.04 s, 46524 KB peak RSS
before: 1.64 s, 92872 KB peak RSS      after: 0.05 s, 48796 KB peak RSS
before: 1.61 s, 106012 KB peak RSS     after: 0.04 s, 44800 KB peak RSS

missing id:
before-miss: 1.61 s, 92816 KB peak    after-miss: 0.05 s, 41884 KB peak
```

About 35 times faster and half the peak memory — and the error sentence is byte-for-byte the same on both sides, including the missing-id case at the bottom. Nothing about the command's logic was wrong. It simply read a hundred thousand rows to use one. It is a small change — one call replaced by another — and only a measurement could justify it: the code was correct, and the cost was invisible until the list got big.

## Put a ceiling on the memory

One question is left, and the profile already answered its cheap half: the collector is not where the time goes. Go's **garbage collector** is the part of the runtime that reclaims memory the program no longer uses. Left alone, it lets the heap grow and tidies up when it decides to; two settings let you lean on it.

`GOGC` says how much the heap may grow between collections — raising it means the collector runs less often. `GOMEMLIMIT` is a soft ceiling: as the heap approaches it, the collector works harder instead of letting the heap grow, so the process slows down under memory pressure instead of being killed for it.

Both were measured, with the read at a hundred thousand tasks. The runs alternate settings, so the machine's mood is shared:

```text
GOGC=100 (default)          1.711 s/op   156 MiB peak RSS
GOGC=400                    1.765 s/op   328 MiB peak RSS   (+3.14%, p=0.032)
GOGC=off                    (5.59 s wall) 799 MiB peak RSS
GOGC=off GOMEMLIMIT=128MiB  1.709 s/op   179 MiB peak RSS   (~ p=0.841)
```

The relaxation — `GOGC=400` — is 3% *slower* than the default and spends twice the resident set. The cap is free (the difference is inside the noise, p=0.84) and holds the process's peak memory at a fifth of the uncapped run. That decides it: the service file gets the ceiling, with the numbers written where the next operator will read them.

<!-- verify: deploy/todo-server.service at=optimization -->
```ini title="deploy/todo-server.service"
# GOMEMLIMIT is the runtime's half of the same bound: a soft heap ceiling.
# As the heap approaches it the collector works harder instead of letting
# the heap grow, so the process slows down under memory pressure instead of
...
MemoryMax=256M
Environment=GOMEMLIMIT=192MiB
```

192 MiB sits under the unit's existing 256 MiB hard ceiling, with room for the engine's own native memory, which no Go setting covers. And the rule the numbers repeat one more time: reduce allocations first, tune the collector last.

## If something went wrong

**The comparison says nothing changed, but the code did.** A capture with too few samples can hide a large change. The test benchstat uses cannot produce a small p-value from few samples: with three samples a side the smallest possible is 0.1, above the 0.05 line. Here is a 200-fold regression, reported and passed:

```text
~ TursoByTagRare/n=100000-16    0.0002s -> 0.0401s   +0.00%  p=0.100 n=3
```

Fix: give each side at least four samples. The captures in this chapter use five, and the count is the point — a comparison that cannot see a change is not a quiet pass. The number of samples is part of the experiment's design, and three is too few to ask a small question.

**A row moves that your change does not touch.** Five samples on a busy machine will occasionally separate two identical sets of numbers; a p-value of 0.032 is exactly the 3% chance the 0.05 line admits. In the chapter's own capture, the stats read moved 19% while nothing in the chapter touched it:

```text
TursoStats/n=100000-16                                0.4094s -> 0.4876s          +19.11%  p=0.032 n=5
```

Fix: re-run the comparison focused on that one benchmark before concluding anything. The focused re-run measured it flat — 0.4456 s to 0.4292 s, p=0.841. Significance is not importance; re-run before you conclude. Both mistakes look like results, which is what makes them worth naming: one hides a change, and the other invents one.

## Run it all one last time

Nothing in this chapter changed what the app does — every test that passed before still passes, with no test loosened to make a number look better. Run the whole module five times:

```bash
$ go test -count=5 ./...
```

```text
ok  	todo/cmd/todo	13.235s
…
ok  	todo/internal/store	7.496s
ok  	todo/internal/web	0.400s
```

Every package passes, five times over.

At the start, the app was a folder with a test and a `Task` holding one title. Look at it now: tasks carry a status, a priority, a due date, and labels; the store behind them is a Turso database, opened through migrations, satisfying one interface two implementations share; a command-line tool with its own settings and output formats sits beside an HTTP API with accounts, sessions, and permissions; a browser interface and a terminal interface ride on top; and a service file and a runbook carry it out of the workshop.

None of it arrived in one piece. Every feature came the same way: a failing test that said what should happen, the code that made it pass, then the tests passing again — and for every claim about speed, a measurement that decided.

The habit is the part worth keeping. Write the test first. Make the claim, run the thing, read the output, and let the output change your mind. Keep what the numbers support, and write down what they refuse. The app is complete; the next test is yours.

<details>
<summary>Going deeper: what a profiler actually records</summary>

A profiler does not watch every instruction. It interrupts the program about a hundred times a second and writes down which function was running when the bell rang; the table is a tally of those interruptions. That is why the shares are percentages of samples and not exact bills, and why `flat` and `cum` differ: `flat` counts the times the function itself was caught, and `cum` counts it and everything it called. Ten thousand samples is plenty to rank the work and not precise enough to decide a small question — which is why every change in this chapter was confirmed with benchmarks, where the counts are exact. `pprof` can also show one function line by line (`go tool pprof -list`), its callers and callees (`-peek`), or the whole profile as a picture, if you ever need to go deeper.

</details>

<details>
<summary>Going deeper: the collector's two knobs</summary>

Go's garbage collector frees memory the program can no longer reach. `GOGC` decides how often it runs: the default, 100, lets the heap double before the next collection — raise it and the collector runs less, at the cost of a bigger heap. `GOMEMLIMIT` is a soft ceiling: as the heap approaches it, the collector runs more, trading processor time for memory. The two settings are two directions of one trade, and this chapter measured both directions on the app's own read path. The numbers chose: cap the memory, leave the collection rate alone.

</details>

<details>
<summary>Going deeper: the measurements we refused</summary>

Not every idea that looks fast is fast, and the ones that lose are worth writing down. A single `LEFT JOIN` returning every task with its labels, instead of two queries and the walk, crosses more values — 1.49 million against 1.07 million — and was refused. Streaming the API's list response one task at a time moved 70% fewer bytes but took 160% more time, because the encoder's per-call cost dominates; the materialized response stayed. Dropping the `owner_id` column the domain never reads measured inside the noise, and a diff that buys nothing is not worth the review. A newer version of the native-code layer measured about 10% slower, so the driver's pinned version stayed. Field alignment had nothing to align: every read-path struct measured zero padding. And the collector relaxation above lost on both axes. Six candidates built, measured, and recorded — a measured no is a result.

</details>

<div class="day-tracker" data-day="59"></div>
