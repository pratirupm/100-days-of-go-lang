---
title: Benchmarks
day: 14
time: "3 hours"
description: Measure how fast the store's operations are, and compare two runs without being fooled by the machine.
sidebar:
  order: 12
---

The tests tell us whether the store is right. They say nothing about whether it is fast. Listing ten tasks feels instant. Listing ten thousand might not — and we have never measured the difference.

A **benchmark** is a test that measures time instead of checking an answer. It runs one piece of code many times and reports what a single run cost. Benchmarks never pass or fail; they produce numbers.

This chapter writes benchmarks for seven of the store's operations, runs them, and saves the results in a file. Then we compare the store with two proposed speed-ups — and both are refused. One is faster but breaks a promise; the other is slower than the code it was meant to beat.

## What a benchmark measures

A benchmark lives in a `_test.go` file, and its name starts with `Benchmark`. Go finds it the way it finds tests, but runs it only when asked, with the `-bench` flag.

Inside, you write a loop, and the loop is yours:

```go
for i := 0; i < b.N; i++ {
	benchSink.tasks = s.List()
}
```

`b` is the benchmark's connection to Go's testing tools, like `t` in a test. The testing package chooses `b.N`: it starts at 1 and grows the count until the timed region lasts about a second. Then it reports `ns/op` — nanoseconds per operation. A nanosecond is a billionth of a second, so a smaller number means cheaper work.

Two more columns describe memory, not time. With `-benchmem` — or `b.ReportAllocs()` in the benchmark — Go reports `B/op`, bytes allocated per operation, and `allocs/op`, allocations per operation. Time moves between runs; the allocation count repeats exactly, while `B/op` is usually stable and can shift with the amortized growth of a slice.

## Write the benchmark suite

Create `internal/store/bench_test.go`. It opens with the package and imports, then three shared values:

<!-- verify: internal/store/bench_test.go at=benchmarks -->
```go title="internal/store/bench_test.go"
package store

import (
	"fmt"
	"testing"
	"time"

	"todo/internal/task"
)

// benchSizes are the store sizes the size-scaled benchmarks run at. The
// sub-benchmark names ("n=100", "n=10000") are stable so benchstat can pair
// runs across commits.
var benchSizes = []int{100, 10000}

// benchTags is the fixed tag pool the seeding helper draws from.
var benchTags = []string{"go", "book", "urgent", "home", "work"}

// benchBase is the fixed reference date for seeded due dates. The seeding
// helper never reads the clock, so every run seeds the same tasks.
var benchBase = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
```

`benchSizes` lists the two store sizes every sized benchmark runs at. `benchTags` is the fixed pool of words the seeding helper draws from. `benchBase` is a fixed date, so every run seeds the same tasks.

Then the sink:

<!-- verify: internal/store/bench_test.go at=benchmarks -->
```go title="internal/store/bench_test.go"
// benchSink keeps the results of the benchmarked calls reachable. Writing to
// a package-level variable the compiler cannot see through is what keeps the
// calls under measurement from being optimized away.
var benchSink struct {
	task   task.Task
	tasks  []task.Task
	counts map[string]int
	tags   []string
}
```

`benchSink` is the unusual piece. If nothing uses a call's result, the compiler may delete the call — leaving a loop that measures nothing. Writing each result into a package-level variable the compiler cannot see through keeps the work alive. Its fields hold every shape the store returns.

Next, the helper that builds the data:

<!-- verify: internal/store/bench_test.go at=benchmarks -->
```go title="internal/store/bench_test.go"
// benchTask builds the i-th task of the seeding pattern: the status cycles
// between Todo and Done, every other task has a due date, and most tasks
// carry tags from the small pool — with repeats, so CountByTag must
// deduplicate within a task.
func benchTask(i int) task.Task {
	t := task.Task{
		Title:  fmt.Sprintf("task-%05d", i),
		Status: task.StatusTodo,
	}
	if i%3 == 0 {
		t.Status = task.StatusDone
	}
	if i%2 == 0 {
		t.Due = benchBase.AddDate(0, 0, i%60)
	}
	if i%7 != 0 {
		first := benchTags[i%len(benchTags)]
		t.Tags = []string{first, benchTags[(i+1)%len(benchTags)]}
		if i%5 == 0 {
			t.Tags = append(t.Tags, first)
		}
	}
	return t
}
```

`benchTask` builds the i-th task of a fixed pattern. The status alternates between todo and done, every other task has a due date, and most tasks get two words from the pool — some repeated. The repeats are deliberate: they give `CountByTag` a duplicate to ignore.

And a store seeded with the first n of those tasks:

<!-- verify: internal/store/bench_test.go at=benchmarks -->
```go title="internal/store/bench_test.go"
// seedStore returns a store holding n tasks built by benchTask, in insertion
// order with sequential IDs starting at 1.
func seedStore(n int) *MemoryStore {
	s := NewMemoryStore()
	for i := range n {
		s.Add(benchTask(i))
	}
	return s
}
```

One new shape: `for i := range n` ranges over a whole number, so `i` visits `0` through `n-1` — the same loop as `for i := 0; i < n; i++`.

Every benchmark starts from a store built this way, so two runs compare the same data.

Now the benchmarks. `BenchmarkAdd` is the one whose setup happens inside the timed region:

<!-- verify: internal/store/bench_test.go at=benchmarks -->
```go title="internal/store/bench_test.go"
func BenchmarkAdd(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			s := seedStore(n)
			t := benchTask(n)
			b.ReportAllocs()
			// Seeding above happened inside the timed region; drop it.
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				benchSink.task = s.Add(t)
			}
		})
	}
}
```

Two details. `b.Run(fmt.Sprintf("n=%d", n), ...)` runs one benchmark inside another, so each size reports as its own row: `BenchmarkAdd/n=100` and `BenchmarkAdd/n=10000`. The size belongs in the name, because comparisons pair old and new by the full name. And `b.ResetTimer()` drops the seeding above it, so only the `Add` calls count.

`BenchmarkList` is the same shape with the seeding moved out of the timed region:

<!-- verify: internal/store/bench_test.go at=benchmarks -->
```go title="internal/store/bench_test.go"
func BenchmarkList(b *testing.B) {
	for _, n := range benchSizes {
		s := seedStore(n)
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				benchSink.tasks = s.List()
			}
		})
	}
}
```

The seed now happens before `b.Run`, so nothing needs dropping and there is no reset. The other five benchmarks are this same function with one line changed:

```go
benchSink.tasks = s.ByStatus(task.StatusTodo)   // BenchmarkByStatus
benchSink.tasks = s.ByTag(benchTags[0])        // BenchmarkByTag
benchSink.tasks = s.SortByDue()                // BenchmarkSortByDue
benchSink.counts = s.CountByTag()              // BenchmarkCountByTag
benchSink.tags = s.Tags()                      // BenchmarkTags
```

Each result goes to the sink field that fits it.

## Run it once, and read the numbers

Run the suite once, with one sample per row:

```bash
$ go test -bench=. -benchmem -count=1 ./internal/store
```

```text
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAdd/n=100-16     	 3062056	       341.6 ns/op	     490 B/op	       0 allocs/op
BenchmarkAdd/n=10000-16   	 5822628	       750.4 ns/op	     503 B/op	       0 allocs/op
BenchmarkList/n=100-16    	  199214	      5214 ns/op	    9728 B/op	       1 allocs/op
BenchmarkList/n=10000-16  	     963	   1344180 ns/op	  966662 B/op	       1 allocs/op
BenchmarkByStatus/n=100-16         	  116208	     10108 ns/op	   15648 B/op	       7 allocs/op
BenchmarkByStatus/n=10000-16       	     342	   3599450 ns/op	 3218726 B/op	      18 allocs/op
BenchmarkByTag/n=100-16            	  201922	      5691 ns/op	    7456 B/op	       6 allocs/op
BenchmarkByTag/n=10000-16          	     784	   1280477 ns/op	 1269025 B/op	      15 allocs/op
BenchmarkSortByDue/n=100-16        	   55299	     21087 ns/op	    9728 B/op	       1 allocs/op
BenchmarkSortByDue/n=10000-16      	     254	   4663155 ns/op	  966656 B/op	       1 allocs/op
BenchmarkCountByTag/n=100-16       	   95497	     12209 ns/op	     256 B/op	       2 allocs/op
BenchmarkCountByTag/n=10000-16     	    1048	   1120749 ns/op	     256 B/op	       2 allocs/op
BenchmarkTags/n=100-16             	   95097	     13114 ns/op	     304 B/op	       7 allocs/op
BenchmarkTags/n=10000-16           	    1010	   1064331 ns/op	     304 B/op	       7 allocs/op
PASS
ok  	todo/internal/store	25.431s
```

Read it in three passes. First the names: seven benchmarks, each at two sizes, each ending in `-16` — the number of processors the run may use, which will differ on your machine.

Second the columns: `ns/op` is time and will move between runs; `allocs/op` repeats exactly, and `B/op` is usually stable — it can move with the amortized growth of a slice. Third the rows that should make you look: `ByStatus` costs 18 allocations per call at n=10000 against 7 at n=100, and `ByTag` climbs from 6 to 15 — both walk the whole list and grow their result one match at a time. The count map and the word list stay flat. None of this is a bug; it is what the code costs.

A plain test run does not execute the benchmarks: without `-bench`, the suite pays for them by building them, nothing more.

## Record a baseline

One run is a number, not a verdict. The same code, sampled ten times, wanders: in the reference capture, `Add` at n=100 ranged from 131.9 to 267.5 ns/op — a factor of two. The fix is to record several counts and treat the set as the measurement.

First make the folder that will hold the record: `mkdir -p internal/store/testdata/bench`. `tee` writes a file, not a folder, and fails if it is missing. Then ask for ten counts and copy the run into the file as it happens:

```bash
$ go test -bench=. -benchmem -count=10 ./internal/store \
    | tee internal/store/testdata/bench/baseline.txt
```

`-count=10` runs the whole set ten times, so every row appears ten times — ten samples. `tee` shows the run and writes it at the same time. When the run finishes, the file holds ten samples of each of the fourteen rows, a four-line header naming the machine, and two result lines. It begins:

<!-- verify: internal/store/testdata/bench/baseline.txt at=benchmarks -->
```text title="internal/store/testdata/bench/baseline.txt"
goos: linux
goarch: amd64
pkg: todo/internal/store
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAdd/n=100-16     	 3943270	       267.5 ns/op	     595 B/op	       0 allocs/op
BenchmarkAdd/n=100-16     	 8747371	       210.3 ns/op	     524 B/op	       0 allocs/op
```

and ends:

<!-- verify: internal/store/testdata/bench/baseline.txt at=benchmarks -->
```text title="internal/store/testdata/bench/baseline.txt"
PASS
ok  	todo/internal/store	197.034s
```

Two things to notice. The `Add` samples disagree by a factor of two, while the `allocs/op` column repeats exactly — time is the noisy half, the allocation count the exact one. `B/op` is usually stable too, but the store's amortized slice growth can move it, as the two `Add` rows above show. And the file is not a claim about how fast the app is; it records what this machine measured, so future runs can compare against it.

## Compare two runs with benchstat

Raw numbers are hard to compare by eye. **benchstat** is a small tool that takes two of these files and lays the differences out in a table. Run it with `go run`, so nothing gets installed:

```bash
$ go run golang.org/x/perf/cmd/benchstat@latest old.txt new.txt
```

For each benchmark name, benchstat pairs the samples from the two files and reports the median of each — the middle value, unmoved by a one-off spike — with a `±` showing how tightly the samples clustered around it. The `vs base` column is the change between the two medians. The p-value answers: if the two files were recordings of the same code, how surprising is a gap this large? Below 0.05 is the usual line for "surprising enough to believe", and a row marked `~` did not cross it. The `geomean` row summarizes the whole column in one number.

Now the warning that costs people wrong decisions. A comparison is an experiment on a machine you do not control. Here is the first attempt — the store against a proposed change, one capture of each:

```text
                      │   old.txt    │               a.txt                │
                      │    sec/op    │    sec/op     vs base              │
Add/n=100-16            468.9n ±  46%   173.8n ± 45%  -62.95% (p=0.000 n=10)
Add/n=10000-16          465.6n ±  41%   178.8n ± 23%  -61.61% (p=0.000 n=10)
List/n=100-16           4.958µ ±   3%   1.749µ ± 19%  -64.72% (p=0.000 n=10)
List/n=10000-16        1506.4µ ±   5%   366.4µ ±  2%  -75.67% (p=0.000 n=10)
```

`Add` and `List` contain none of that change, yet the table claims improvements of 60 to 76% with p=0.000. The p-value is not broken: it compared two sets of recorded samples and found they barely overlapped. What it cannot see is how the files were recorded. Between the captures, the machine's load, speed, and temperature had moved — and drift reads as a real difference.

The fix is to interleave: alternate the two versions' runs in time. `go test -c` builds the package's test binary and leaves it on disk instead of running it, so we can build one binary per version:

```bash
$ go test -c -o old.test ./internal/store     # unmodified code
$ go test -c -o new.test ./internal/store     # with the candidate applied
$ for i in $(seq 10); do
  ./old.test -test.bench=. -test.benchmem -test.count=1 > "old-$i.txt"
  ./new.test -test.bench=. -test.benchmem -test.count=1 > "new-$i.txt"
done
$ cat old-*.txt > old.txt
$ cat new-*.txt > new.txt
$ go run golang.org/x/perf/cmd/benchstat@latest old.txt new.txt
```

The `-test.` prefix is how a compiled test binary spells the testing flags, and `-test.count=1` takes one sample per run. The loop alternates old and new, so both share the machine's mood. The two `cat` commands stack the paired samples into the files benchstat wants. Every table from here on is interleaved.

## Two speed-ups, both refused

Before measuring anything, write down what would count as a win. The bar: a change replaces the app's code only when the p-value is below 0.05, the time improves by at least 5%, and the behavior is identical — every test that passed before still passes, with no test changed. Missing one clause is a rejection.

Candidates are tried in a throwaway copy of the app, never in the app itself. The copy is the **lab**:

```bash
$ cp -r . ../todo-bench-lab
$ cd ../todo-bench-lab
```

**The first candidate was fast and forbidden.** The change was three words in the store's `filter` helper, which walks the task list and keeps the matches. The lab reserved room for the result instead of growing it:

```go
// the lab's filter, candidate A
matches := make([]T, 0, len(xs))
for _, x := range xs {
	if keep(x) {
		matches = append(matches, x)
	}
}
return matches
```

`make([]T, 0, len(xs))` builds an empty list with room already reserved for every task, so the loop can fill it without growing. Run the tests before trusting any number — a speed-up that breaks behavior is not one:

```bash
$ go test ./...
```

```text
--- FAIL: TestMemoryStore_ByTag (0.00s)
    --- FAIL: TestMemoryStore_ByTag/unknown_tag_returns_nil (0.00s)
        store_test.go:170: 
            	Error Trace:	…/internal/store/store_test.go:170
            	Error:      	Expected nil, but got: []task.Task{}
            	Test:       	TestMemoryStore_ByTag/unknown_tag_returns_nil
...
FAIL
FAIL	todo/internal/store	0.003s
FAIL
```

Three assertions fail, all in the same way: the original `filter` returns nil when nothing matches; the preallocated version returns an empty list. A caller can tell those apart — the tests pin the difference — so this changes behavior, not just speed.

The interleaved numbers, from the lab:

```text
                      │   oldA.txt    │               newA.txt               │
                      │    sec/op     │    sec/op     vs base                │
Add/n=100-16             287.2n ±  8%   285.0n ± 25%        ~ (p=0.796 n=10)
Add/n=10000-16           255.1n ± 12%   227.9n ± 15%        ~ (p=0.075 n=10)
...
ByStatus/n=100-16        4.059µ ±  7%   1.941µ ±  5%  -52.19% (p=0.000 n=10)
ByStatus/n=10000-16     1258.8µ ±  4%   331.1µ ±  4%  -73.70% (p=0.000 n=10)
ByTag/n=100-16           2.382µ ±  2%   2.209µ ±  3%   -7.28% (p=0.000 n=10)
ByTag/n=10000-16         532.7µ ±  4%   287.4µ ±  4%  -46.05% (p=0.000 n=10)
...
geomean                  27.71µ         22.58µ        -18.50%
```

The moving rows are large. `ByStatus` at n=10000 fell from 1258.8 µs to 331.1 µs, about 74%, and its allocation count fell from 18 to 1; `ByTag` at n=10000 fell 46%. The untouched rows sit at `~`: the method can see a change where one exists, and finds none where the code did not change. That flatness is the control that makes the wins believable. But this candidate fails the bar's third clause. Rejected — the store keeps its slower, correct `filter`.

**The second candidate lost against expectations.** It attacked `SortByDue`, the slowest operation in the smoke run. Instead of sorting the tasks themselves, build one small key per task — the due date, plus a rank that sends tasks with no due date to the end — sort the keys, then gather the tasks back in that order. Small keys move more cheaply, and the date comparison happens once per task instead of once per comparison. It should have won.

The interleaved table says otherwise:

```text
                      │   oldB.txt   │               newB.txt                │
                      │    sec/op    │    sec/op      vs base                │
Add/n=100-16            294.8n ± 30%    290.6n ± 33%        ~ (p=0.699 n=10)
Add/n=10000-16          258.2n ± 17%    257.4n ± 16%        ~ (p=0.853 n=10)
...
SortByDue/n=100-16      9.126µ ±  5%   11.039µ ±  3%  +20.96% (p=0.000 n=10)
SortByDue/n=10000-16    2.132m ±  3%    2.595m ±  4%  +21.69% (p=0.000 n=10)
...
geomean                 27.57µ          28.59µ         +3.71%
```

`SortByDue` came out about 21% slower at both sizes. The memory tables agree:

```text
SortByDue/n=10000-16    944.0Ki ± 0%   1336.0Ki ± 0%  +41.53% (p=0.000 n=10)
SortByDue/n=10000-16    1.000 ± 0%     2.000 ± 0%  +100.00% (p=0.000 n=10)
```

The first line is from the bytes table, the second from the allocations table: 42% more bytes, one extra allocation per call. Every other row is flat, same as before. The rewrite is slower on the very benchmark it was written for, and it moves more memory to get there. Rejected.

Two plausible changes, two measured refusals. The store's code is byte-for-byte what it was, and that is the chapter's result: we can say why, and the numbers are on file for the next time the idea comes back.

## If something went wrong

**The comparison says code you did not touch got faster.** Two captures taken one after the other will disagree about code that never changed:

```text
Add/n=100-16            468.9n ±  46%   173.8n ± 45%  -62.95% (p=0.000 n=10)
List/n=10000-16        1506.4µ ±   5%   366.4µ ±  2%  -75.67% (p=0.000 n=10)
```

The p-value compared the two sets of samples and found they barely overlapped — but it cannot see that the machine was busier during one of them. Load, speed, and heat drift between sessions, and drift reads as a result. Fix: interleave. Build both versions with `go test -c` and alternate their runs.

**Rows that stopped lining up.** benchstat pairs rows by their full names. Rename a benchmark — `BenchmarkTags` becomes `BenchmarkAllTags` — and the rows no longer pair, so each shows on only one side:

```text
…
Tags/n=100-16            7.656µ ± 38%
Tags/n=10000-16          651.5µ ±  6%
AllTags/n=100-16                         18.74µ ± 156%
AllTags/n=10000-16                       1.865m ±  26%
geomean                  38.26µ          67.73µ          +65.51%                ¹
¹ benchmark set differs from baseline; geomeans may not be comparable
```

The one-sided rows and the footnote say the two files no longer describe the same set of benchmarks. Fix: once a baseline exists, treat the names as an interface. Do not rename a benchmark or change its sizes; the name is how old and new pair up.

**Numbers too small to believe.** A benchmark whose result nothing observes can measure nothing:

```text
BenchmarkScratchPureDiscarded-16   1000000000   0.1379 ns/op   0 B/op   0 allocs/op
BenchmarkScratchPureSink-16        1000000000   0.3789 ns/op   0 B/op   0 allocs/op
```

The discarded call was deleted by the compiler, so `0.1379 ns/op` is the cost of an empty loop, not of the work. Whether a call gets deleted depends on the compiler's decisions, which change between versions. Fix: store every result in a sink the compiler cannot see through.

<details>
<summary>Going deeper: how the testing package chooses `b.N`</summary>

The count is not fixed, and that is deliberate. The testing package starts with `b.N = 1` and grows the count until the timed region lasts about a second. `-benchtime=100x` overrides it — run the body exactly 100 times — which makes a capture quick but noisy: with few trips, one interruption by something else on the machine moves the average a lot. A fixed count shows the shape of a result; it never decides a verdict.

</details>

<details>
<summary>Going deeper: what the p-value and the `±` mean</summary>

benchstat does not trust a single sample. For each benchmark it reports the median of the recorded values — the middle value, unmoved by one-off spikes — with a `±` for the spread of the samples. The `vs base` column is the change between the two medians. The p-value comes from a statistical test (the Mann-Whitney U-test) that asks how surprising the gap would be if both sets of samples came from the same code. Below 0.05, the gap is unlikely to be chance; a row marked `~` stayed above the line. Even so, about one row in twenty lights up by chance when nothing changed — which is why a verdict needs a written bar. The `geomean` row is the geometric mean of the column.

</details>

<details>
<summary>Going deeper: why `Add` reports zero allocations</summary>

`Add` prints hundreds of bytes per operation and `0 allocs/op`, and both are true. The store keeps its tasks in a list; when the list runs out of room, Go allocates a bigger backing array and copies the values into it. Over many appends that happens rarely — about log₂ N times over N operations — so the allocation count per operation rounds to zero, while the bytes of those rare, large allocations still divide out to a real average. That is why the memory columns are the deterministic half: `allocs/op` repeats on any machine, which is why benchstat flags such rows `¹ all samples are equal`.

</details>

The store has a suite that measures it and a file that remembers the numbers. Next: the tools that check the code without running it.
