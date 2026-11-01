---
title: "Day 76 — Load testing"
description: "Drive the store with real concurrent readers and writers, record throughput and latency percentiles, and find the knee where the curve bends. — Day 76 of 100 Days of Go Lang."
sidebar:
  order: 76
chapter: 64
style: production
---

**About 3 hours** · Part XIII, day 4 of 5.

**You'll be able to:**

- drive the list and write paths with a real load tool;
- record throughput, latency, and the knee where the curve bends.

---

A benchmark measures one operation in a controlled loop. A **load test**
measures the system under many callers at once, with a mix of work, for long
enough to see the queue form. The second number is the one a production
operator needs: not "how fast is one list" but "how many lists per second
before the p99 goes vertical."

Today we drive the PostgreSQL store with a small Go load tool: ten thousand
seeded tasks, eight workers, a mix of list, filter, label lookup, and add. It
prints throughput and p50/p95/p99 latency. The numbers are for this laptop;
the shape is the lesson.

## The workload

The tool opens the same store the app uses, truncates the tables, and seeds a
table with a realistic size:

<!-- verify: cmd/pgload/main.go at=load-test -->
```go title="cmd/pgload/main.go"
	if _, err := s.DB().ExecContext(ctx, "TRUNCATE task_tags, tasks CASCADE"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for i := 0; i < *seed; i++ {
		status := task.StatusTodo
		if i%10 == 0 {
			status = task.StatusDone
		}
		if _, err := s.Add(ctx, task.Task{Title: fmt.Sprintf("seed %d", i), Status: status, Tags: []string{"load"}}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
```

One in ten tasks is Done, so the status filter has a selective case and a
broad case. Every task carries the label `load`, so the label lookup has a large
result set. The seeder is not the measured part; it is the table shape.

The workers cycle through four operations:

<!-- verify: cmd/pgload/main.go at=load-test -->
```go title="cmd/pgload/main.go"
				switch w % 4 {
				case 0:
					_, err = s.List(workCtx)
				case 1:
					_, err = s.ByStatus(workCtx, task.StatusDone)
				case 2:
					_, err = s.ByTag(workCtx, "load")
				case 3:
					_, err = s.Add(workCtx, task.Task{Title: "live", Status: task.StatusTodo, Tags: []string{"load"}})
				}
```

The mix is deliberate. Reads dominate, but not entirely: the add path takes a
transaction and a write lock, so it shows the cost of contention. A pure-read
test would flatter the system.

Each worker records its own operation's latency. A shared mutex appends to one
slice; with eight workers and a few hundred ops per second, the mutex is not
the bottleneck. At a much higher rate, a sharded histogram would be.

## Run it

```bash
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go run ./cmd/pgload -seed 10000 -workers 8 -duration 3s
2026/10/31 15:07:38 OK   00001_init.sql (6.89ms)
2026/10/31 15:07:38 OK   00002_status_index.sql (4.44ms)
2026/10/31 15:07:38 goose: successfully migrated database to version: 2
ops=939 elapsed=3.0s throughput=313/s p50=6.519ms p95=15.153ms p99=199.475ms
```

Read the line left to right. `ops=939` is the number of completed operations;
`throughput=313/s` is ops divided by the three seconds. `p50=6.5ms` says half
the operations finished faster than that; `p95=15ms` says 95% did; `p99=199ms`
says the slowest 1% took a fifth of a second.

The p99 is the interesting number. The median is comfortable, but one in a
hundred calls waits 200 ms. That tail is usually a queue: a writer holds a
lock, readers wait, or the connection pool is exhausted. A load test that only
reports the average hides it.

## Find the knee

Run the same test with more workers:

```bash
$ TODO_POSTGRES_DSN='postgres://todo:todo@127.0.0.1:15432/todo?sslmode=disable' go run ./cmd/pgload -seed 10000 -workers 32 -duration 3s
...
```

Throughput will rise until the database or the pool saturates, then flatten
while latency climbs. The point where the curve bends is the **knee**. Before
it, adding a worker buys throughput; after it, adding a worker buys queueing.
The right operating point is below the knee, with headroom for a burst.

The pool is the first ceiling: `SetMaxOpenConns(8)` means at most eight
connections, so 32 workers queue for them. That is intentional. A larger pool
would move the knee, not remove it; the database's own capacity is still
finite.

## What the numbers do not say

This test runs on the same machine as the database, over the loopback. A real
client crosses a network, and the network adds latency and failure modes the
loopback cannot show. The test also seeds a table that fits in memory; a
table larger than RAM changes the I/O cost.

The shape is still useful: it catches a query that scales badly, a transaction
that holds a lock too long, and a pool that is too small for the worker count.
Those are the failures a code review misses.

## Warm up before you measure

The first requests in a load test hit a cold process: the connection pool is
empty, the query plan cache is cold, and the page cache has not seen the table.
Those requests are slower than the steady state, and they land in the p99 if
the test is short.

A warm-up phase sends a fraction of the load for a few seconds and excludes
those samples from the report. The tool here does not separate the phases; a
three-second run on a seeded table is mostly warm after the first second. A
longer run should discard the first window, or report it separately.

The other cold start is the database. `ANALYZE` gives the planner statistics;
without it, the first queries can choose a plan the steady state would not.
The seeding step is part of the measurement, not setup noise.

## The dataset is the test

The seed is ten thousand tasks with one label each. A real table has tasks
with no labels, tasks with ten, and tasks whose title is long enough to matter.
The load test's numbers are only as realistic as its rows.

A second dataset with a different shape is the check. If the p99 moves when
the labels are added, the label attach path is the suspect. If it moves when the
titles grow, the row size is the suspect. One dataset gives a number; two give
a direction.

## If something went wrong

- **`connection refused`** — the DSN points at the wrong port or the database
  is not running.
- **`too many clients already`** — the pool is larger than PostgreSQL's
  `max_connections`. Lower `SetMaxOpenConns` or raise the server limit.
- **Throughput falls as workers rise** — the system is past the knee. Check
  locks, pool waits, and the slow query plan before adding more workers.
- **p99 is much larger than p95** — look for a lock or a garbage collection
  pause. A single long transaction can create exactly that tail.

<details>
<summary>Going deeper: coordinated omission</summary>

A closed-loop load test waits for each operation to finish before starting the
next. If the system stalls for a second, the test sends fewer requests during
that second, so the stall is under-represented in the percentiles. That is
**coordinated omission**.

An open-loop test sends requests on a schedule regardless of completion. It
shows the latency a real client sees when the system is behind. The tool here
is closed-loop because it is simple and repeatable; a production load test
should include an open-loop phase, and should record the queue depth, not just
the completed requests.

</details>

The store has a measured operating point now. Next we profile the same load
and keep only the changes the numbers support.

<div class="day-tracker" data-day="76"></div>
