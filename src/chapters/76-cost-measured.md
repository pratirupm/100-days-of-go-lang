---
title: Cost, measured
day: 91
time: "3 hours"
description: Read Big-O as a shape, measure two implementations with a benchmark, and explain the gap the numbers show.
sidebar:
  order: 76
---

Big-O is a shape, not a stopwatch. It says how the work grows when the input
grows: a linear scan touches every element, a map lookup touches a few. It
does not say which one is faster on ten items, and it does not replace a
measurement.

The last ninety days built an app with slices, maps, trees of packages, and a
database. The next ten look underneath them. We start with the smallest
question: given a value, how does the cost of finding it change with the size
of the collection?

## Two lookups

A slice is a contiguous block. To find a value, the code walks it:

<!-- verify: internal/dsa/growth_test.go at=dsa-growth -->
```go title="internal/dsa/growth_test.go"
func BenchmarkSliceContains(b *testing.B) {
	data := make([]int, 10_000)
	for i := range data {
		data[i] = i
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		for _, v := range data {
			if v == 9_999 {
				break
			}
		}
	}
}
```

The value is at the end, so the benchmark measures the full scan. The cost is
O(n): ten thousand comparisons per lookup. A map is a hash table; the lookup
computes a hash and follows one bucket:

<!-- verify: internal/dsa/growth_test.go at=dsa-growth -->
```go title="internal/dsa/growth_test.go"
func BenchmarkMapContains(b *testing.B) {
	data := make(map[int]bool, 10_000)
	for i := 0; i < 10_000; i++ {
		data[i] = true
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = data[9_999]
	}
}
```

The map's average cost is O(1), with a collision path that is usually short.
The benchmark builds the map outside the timer, so it measures the lookup and
not the insertion.

## Run it

```bash
$ go test -run '^$' -bench 'Benchmark(Slice|Map)Contains' -benchmem ./internal/dsa
goos: linux
goarch: amd64
pkg: todo/internal/dsa
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkSliceContains-16    	  341961	      4598 ns/op	       0 B/op	       0 allocs/op
BenchmarkMapContains-16      	120690066	        11.09 ns/op	       0 B/op	       0 allocs/op
PASS
ok  	todo/internal/dsa	3.961s
```

The slice lookup is about 4,600 ns; the map lookup is about 11 ns. The ratio is
roughly 400, which is the ten-thousand-element scan divided by a constant
hash path. The `-16` suffix is `GOMAXPROCS`; the benchmarks are single
goroutine, so it does not change the comparison.

`B/op` and `allocs/op` are the allocation columns. Both are zero here: the
slice was built once and the map was built once, and neither lookup allocates.
A benchmark that allocates on every operation pays the garbage collector in
production even when the nanoseconds look small.

## What the numbers do not say

The map is not free. It has a larger constant cost for tiny collections: a
linear scan of four values can beat a hash and a bucket lookup. It uses more
memory: the buckets, the hash metadata, and the keys. It has a worst case:
many keys colliding in one bucket turn the lookup into a scan.

The slice is not useless. It is contiguous, cache-friendly, and cheap to
iterate. If the operation is "visit every value", the slice wins; if it is
"find one value by key", the map wins. The benchmark measures one operation;
the app's mix decides.

## The shape of the curve

A benchmark at one size gives one point. The useful picture is two points: ten
thousand and twenty thousand. A linear scan should double; a map should stay
flat. If the map doubles too, something in the lookup is scanning — a bad
hash, a tiny bucket count, or an allocation that the benchmark hid.

The same method applies to every structure in this stretch: measure at two
sizes, then compare the shape. A single number is a story; two numbers are a
test.

## When Big-O misleads

Big-O ignores the constant. A linear scan with a tiny constant can beat a hash
lookup with a large one on a small input. It also ignores memory access: a
contiguous scan is cache-friendly, while a pointer chase is not. Two O(n)
algorithms can differ by an order of magnitude on the same machine.

The notation is still useful because it predicts the shape at scale. The
benchmark is useful because it measures the constant at the size you have.
Use both: the shape to choose the family, the benchmark to choose the member.

## Measure the operation the app runs

The benchmark measured "find one value". The app might run "find, then update,
then write", and the update's cost can dominate. A micro-benchmark isolates one
operation; a load test measures the mix. Use the micro-benchmark to compare two
implementations of the same operation, and the load test to decide whether the
operation matters.

A benchmark that measures the wrong operation is worse than no benchmark: it
produces a number that feels like evidence and points at the wrong fix.

## The benchmark is a test

A benchmark is a test with a different assertion. It asserts that the operation
finishes, and it records how long. A benchmark that panics or allocates
wildly is a failing test with a number attached.

Run it on the target hardware, with the target data, before trusting the
number. The shape is portable; the nanoseconds are not.

## One number is not a trend

A single benchmark run is a sample. The machine may be busy, the cache may be
cold, or the input may be too small. Run the benchmark several times and compare
the distribution, or use `benchstat` to summarize the runs.

The shape matters more than the third digit. A 10% difference can be noise; a
10x difference is a different algorithm or a different memory access pattern.

## If something went wrong

- **The benchmark compiler optimized the loop away** — assign the result to a
  package-level sink, or use the value in a way the compiler cannot prove
  unused. An empty loop measures nothing.
- **The benchmark includes setup** — call `b.ResetTimer()` after the setup, as
  both functions do. A map build inside the timed loop measures the build.
- **The numbers move on every run** — the machine is noisy or the input is
  too small. Pin the CPU, close other work, and use `benchstat` for a
  comparison instead of one run.
- **The map is slower than expected** — the key is a string or a struct with
  a costly hash, or the map is small enough that the constant wins. Measure
  the actual key type, not an int stand-in.

<details>
<summary>Going deeper: amortized cost</summary>

An append to a slice is O(1) on average even though the occasional append
copies the whole block. The copy is O(n), but it happens after n appends, so
the cost per append is constant when spread over the sequence. That is
**amortized** cost: the expensive step is paid for by many cheap ones.

A hash table's average O(1) is also an average over a good hash and a bounded
load factor. A bad hash or an unbounded load turns it into O(n). Big-O is a
promise about the implementation's shape; the measurement is how you check
that the promise holds for the data you actually have.

</details>

The map is faster for one lookup. The next day looks at the block underneath
the slice and the copy that makes append look free.
