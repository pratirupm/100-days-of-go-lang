---
title: Queries and indexes
day: 74
time: "3 hours"
description: Read EXPLAIN (ANALYZE, BUFFERS), add the index the planner asks for, and keep the one the numbers support.
sidebar:
  order: 62
---

A query that works on ten rows can be unusable on ten thousand. The database
does not get slower because the SQL changed; it gets slower because the plan
changed. **EXPLAIN** is how you see the plan, and an **index** is one of the
few changes that alters it.

Today we load a realistic number of tasks into PostgreSQL, read the plan for
the status filter, add an index, and compare. The lesson is not "index
everything"; it is "read the plan before and after, and keep what the plan
proves."

## Make a table worth planning

The conformance suite leaves the tables empty. Seed a shape the planner can
reason about: ten thousand Todo tasks and one thousand Done ones.

```bash
$ podman exec todo-postgres psql -U todo -d todo -c "INSERT INTO tasks (id,title,status,priority,version) SELECT '00000000-0000-7000-8000-'||lpad(i::text,12,'0'), 'task '||i, 'Todo', 3, 1 FROM generate_series(1,10000) i; INSERT INTO tasks (id,title,status,priority,version) SELECT '00000000-0000-7000-8001-'||lpad(i::text,12,'0'), 'done '||i, 'Done', 3, 1 FROM generate_series(1,1000) i; ANALYZE tasks;"
INSERT 0 10000
INSERT 0 1000
ANALYZE
```

`generate_series` is PostgreSQL's row generator. `lpad` pads the number so
the ids are fixed-width text; the exact ids do not matter, only their shape
and order. `ANALYZE` refreshes the statistics the planner reads. Without it,
the planner guesses, and a guess is how a plan goes wrong.

Now ask for the Done tasks, the scope the API uses when a user filters by
status:

```bash
$ podman exec todo-postgres psql -U todo -d todo -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id, title, status, priority, due, version FROM tasks WHERE status = 'Done' AND owner_id IS NOT DISTINCT FROM NULL ORDER BY id;"
```

Before the index, the plan is a sequential scan:

```text
 Sort  (cost=312.33..314.83 rows=1000 width=91) (actual time=1.280..1.314 rows=1000 loops=1)
   Sort Key: id
   Sort Method: quicksort  Memory: 103kB
   Buffers: shared hit=125
   ->  Seq Scan on tasks  (cost=0.00..262.50 rows=1000 width=91) (actual time=0.842..0.972 rows=1000 loops=1)
         Filter: ((owner_id IS NULL) AND (status = 'Done'::text))
         Rows Removed by Filter: 10000
         Buffers: shared hit=125
 Execution Time: 1.391 ms
```

Read it bottom-up. `Seq Scan` reads every row; `Rows Removed by Filter:
10000` says it read 11,000 rows to keep 1,000. The `Sort` is a separate step
because the scan does not return rows in id order. `Buffers: shared hit=125`
is the page cache traffic; it is the number to watch when the table grows.

## The index

The filter is `status = 'Done' AND owner_id IS NULL`. An index on
`(status, owner_id)` can find those rows without reading the other ten
thousand. The schema already declares it:

<!-- verify: internal/store/postgres/schema.sql at=postgres-queries -->
```sql title="internal/store/postgres/schema.sql"
CREATE INDEX IF NOT EXISTS tasks_owner_id ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS tasks_status_owner ON tasks(status, owner_id);
CREATE INDEX IF NOT EXISTS task_tags_tag ON task_tags(tag);
```

The column order matters. `(status, owner_id)` can serve a query that names
`status` first; `(owner_id, status)` would serve the owner-first query. The
app's status filter always carries both, so either order could work; the
plan is the tiebreaker.

Create it (the schema does this on a fresh database, but the seeded one
predates the change) and read the plan again:

```bash
$ podman exec todo-postgres psql -U todo -d todo -c "CREATE INDEX tasks_status_owner ON tasks(status, owner_id); ANALYZE tasks; EXPLAIN (ANALYZE, BUFFERS) SELECT id, title, status, priority, due, version FROM tasks WHERE status = 'Done' AND owner_id IS NOT DISTINCT FROM NULL ORDER BY id;"
```

```text
 Sort  (cost=205.86..208.36 rows=1000 width=91) (actual time=0.390..0.419 rows=1000 loops=1)
   Sort Key: id
   Sort Method: quicksort  Memory: 103kB
   Buffers: shared hit=12 read=2
   ->  Bitmap Heap Scan on tasks  (cost=18.54..156.03 rows=1000 width=91) (actual time=0.038..0.128 rows=1000 loops=1)
         Recheck Cond: ((status = 'Done'::text) AND (owner_id IS NULL))
         Heap Blocks: exact=12
         Buffers: shared hit=12 read=2
         ->  Bitmap Index Scan on tasks_status_owner  (cost=0.00..18.29 rows=1000 width=0) (actual time=0.031..0.031 rows=1000 loops=1)
               Index Cond: ((status = 'Done'::text) AND (owner_id IS NULL))
               Buffers: shared read=2
 Execution Time: 0.494 ms
```

The `Seq Scan` is gone. `Bitmap Index Scan` finds the matching row locations,
`Bitmap Heap Scan` fetches those pages, and the sort still happens because
the index does not carry `id` in sorted order. The buffer count drops from
125 to 14, and the execution time from 1.4 ms to 0.5 ms. On this table the
difference is small; on a million rows the scan is the difference between a
page and a timeout.

## The index the planner ignores

The Todo filter is the same query with a different value. It matches 10,000
of 11,000 rows — 91%. The planner is allowed to prefer the primary-key scan
and filter the status, because reading almost every row through an index is
more work than reading the table. That is not a bug; it is selectivity.

The lesson is not "add an index for every WHERE clause." It is "read the
plan for the values the app actually asks for." A status filter that is
usually 90% of the table does not need an index on status; the same filter
for a rare status does. If the data distribution changes, the plan can
change with it.

## The label query

The labels have their own access path. `ByTag` joins `task_tags` on `tag`, and
the index on `task_tags(tag)` turns the join's first step into a seek. The
same rule applies: the query names the label, the index starts with the label,
and the join uses the task id's primary key.

The schema keeps one index on the label column. The composite primary key
`(task_id, tag)` cannot serve a lookup by label alone, because its first column
is the task id. That is why the extra index exists even though it costs a
write on every label insert.

## If something went wrong

- **`EXPLAIN` shows a Seq Scan after the index** — the table is small, the
  filter is not selective, or `ANALYZE` has not run. Check the row estimate
  first; the planner may be right.
- **`CREATE INDEX` blocks writes** — a plain `CREATE INDEX` takes a lock. On
  a live table use `CREATE INDEX CONCURRENTLY`; it is slower but does not
  block writes.
- **The plan uses the index but is slower** — an index scan can lose to a
  sequential scan when most rows match, or when the table is cached. Compare
  `Buffers` and `actual time`, not just the plan shape.
- **The index is unused after a restart** — statistics are stale or the
  query changed. Run `ANALYZE` and compare the exact SQL, including the
  `IS NOT DISTINCT FROM` predicate.

<details>
<summary>Going deeper: cost is a guess, buffers are a fact</summary>

The `cost=...` numbers are the planner's estimates, built from statistics and
cost constants. They are useful for comparing plans, not for predicting
wall-clock time. The `actual time` and `Buffers` lines are measurements from
the run. Read those first.

`EXPLAIN (ANALYZE)` actually executes the statement. For an `UPDATE` or
`DELETE`, wrap it in a transaction and roll back if you do not mean it.
`EXPLAIN (ANALYZE, BUFFERS)` adds the page traffic, which is often the number
that explains a production slowdown: a plan that looks cheap can still touch
every page.

</details>

The query has an index it can use and a plan we can read. Next we change the
table while it is live, and make the migration reversible.
