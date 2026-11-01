---
title: "Day 77 — Tuning under load"
description: "Profile the same load, replace the N+1 tag reads with one query, and keep only the changes the numbers support. — Day 77 of 100 Days of Go Lang."
sidebar:
  order: 77
chapter: 65
style: production
---

**About 3 hours** · Part XIII, day 5 of 5.

**You'll be able to:**

- profile the server and the database under the same load;
- keep only the changes the numbers support.

---

The load test gave us a number: 313 operations per second, with a p99 near
200 ms. The median was fine; the tail was not. A tail that large usually
means a queue, a lock, or a query repeated once per row.

The store's list path had the third. `attachTags` asked for one task's labels,
then the next task's, then the next — an **N+1**: one query for the list and
one more for every row. On a ten-thousand-row list, that is ten thousand
round trips.

Today we replace the N+1 with one query, rerun the exact load, and compare.

## The shape before

The old helper looped over the tasks and queried each one:

```text
for each task:
    SELECT tag FROM task_tags WHERE task_id = $1 ORDER BY tag
```

Each query is cheap. Ten thousand cheap queries are not. The database spends
its time parsing the same statement, the driver spends its time in the bind
and round trip, and the connection is held for the whole list. The p99 is the
list that waited behind a writer for a connection while its ten thousand
queries ran.

## The shape after

The new helper collects the ids and asks for all of them at once:

<!-- verify: internal/store/postgres/postgres.go at=tuning -->
```go title="internal/store/postgres/postgres.go"
func (s *Store) attachTags(ctx context.Context, tasks []task.Task) error {
	if len(tasks) == 0 {
		return nil
	}
	ids := make([]string, len(tasks))
	index := make(map[string]int, len(tasks))
	for i := range tasks {
		id := tasks[i].ID.String()
		ids[i] = id
		index[id] = i
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT task_id, tag FROM task_tags WHERE task_id = ANY($1::text[]) ORDER BY task_id, tag`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, tag string
		if err := rows.Scan(&id, &tag); err != nil {
			return err
		}
		if i, ok := index[id]; ok {
			tasks[i].Tags = append(tasks[i].Tags, tag)
		}
	}
	return rows.Err()
}
```

`$1::text[]` is a PostgreSQL array. pgx binds the Go `[]string` to it; the
query returns one row per task-label pair, ordered by task and label. The map
turns the task id into the slice index, so the row walk is one pass. The
`ORDER BY` keeps each task's labels sorted, which is the contract the other
stores keep.

The map costs memory: one entry per task, one string key per entry. The old
loop cost a round trip per task. For a list of ten thousand, the map is the
better trade; for a list of ten, either is fine. The cutoff is a measurement,
not a rule.

## The same load

Run the exact command from the previous lesson:

```bash
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go run ./cmd/pgload -seed 10000 -workers 8 -duration 3s
2026/10/31 15:09:21 goose: no migrations to run. current version: 2
ops=1887 elapsed=3.0s throughput=629/s p50=6.84ms p95=56.569ms p99=87.898ms
```

Before: `throughput=313/s`, `p50=6.519ms`, `p95=15.153ms`, `p99=199.475ms`.
After: `throughput=629/s`, `p50=6.84ms`, `p95=56.569ms`, `p99=87.898ms`.

The throughput doubled and the p99 more than halved. The median barely moved.
The p95 got worse: 15 ms to 57 ms. That is the honest result, not a clean win.

Why would p95 rise? The batch query is larger. A list of ten thousand tasks
now returns ten thousand label rows in one result; the client waits for the
whole result before it can finish the list. The old loop spread that work
across many small waits, which some percentiles saw as shorter. The tail is
better because the list no longer holds a connection for thousands of round
trips; the middle is worse because one big result is a bigger single step.

The change is still worth keeping: throughput is the capacity the system has,
and p99 is the experience of the slowest user. A p95 regression with a p99
improvement is a trade to state, not hide. If the p95 mattered more, the next
step would be chunking the ids — the Turso store does exactly that with a
512-id chunk — or paging the list so no caller asks for ten thousand rows.

## What else the numbers say

The pool is still eight connections. At 629 ops/s, eight workers are not
queuing for a connection most of the time; the p99 tail comes from the large
list, not the pool. Raising the pool would not fix that tail. It might raise
throughput until the database's own CPU or I/O becomes the limit.

The next measurement would be the database's wait events: `pg_stat_activity`
for active queries, `pg_locks` for blocked ones, and `EXPLAIN (ANALYZE,
BUFFERS)` for the list itself. A tuning change without one of those is a
guess.

## The pool is part of the plan

The store opens eight connections. At eight workers, a request that needs a
connection can usually get one; at thirty-two, the queue is the pool. The
number is not a law. It should be at least the number of concurrent database
operations the service wants, and below the database's `max_connections`
minus the connections reserved for migrations and operators.

A pool that is too small shows up as time spent waiting in `database/sql`, not
as a slow query. A pool that is too large shows up as database CPU and memory
pressure, and sometimes as worse throughput because the server is context
switching between more sessions. The load test is the place to see both.

The batch query changed the shape of the work, not the pool. The next
measurement would raise and lower `SetMaxOpenConns` against the same load and
compare the p99. A tuning change without that comparison is a guess about
where the queue is.

## If something went wrong

- **`cannot find encode plan for []string`** — the driver did not bind the
  slice to `text[]`. Keep the `::text[]` cast and pass a `[]string`; pgx v5
  handles the array.
- **The batch query is slower than the loop** — the list is small or the
  result is huge. Measure the row count; chunk the ids or keep the loop for
  tiny lists.
- **p99 improves but p95 worsens** — a larger single query moved work from
  the tail to the middle. Decide which percentile the user experiences and
  document the trade.
- **Throughput stops rising with workers** — the system is at the knee.
  Check the pool, locks, and CPU before adding more workers.

<details>
<summary>Going deeper: the N+1 is a shape, not a line count</summary>

An N+1 can hide behind an ORM, a helper, or a loop that looks harmless. The
tell is the query count growing with the number of rows. A list of ten and a
list of ten thousand run the same code; only the second one shows the cost.

The fix is not always one query. A batch of 512 ids, a join that returns the
parent and child rows together, or a second query for the page's ids are all
valid. The constraint is the result size and the latency the caller can
afford. The book's Turso store chose chunks of 512 because the generated
query's placeholder list is part of the statement text; PostgreSQL's array
parameter avoids that particular cost, so one query is reasonable here.

</details>

The list is faster and the tail is smaller. Next we keep the data consistent
when a write spans the database and an event stream.

<div class="day-tracker" data-day="77"></div>
