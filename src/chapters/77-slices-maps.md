---
title: Slices and maps, underneath
day: 92
time: "3 hours"
description: Build a dynamic array, watch the copy that makes append look free, and compare a linear scan with a map lookup.
sidebar:
  order: 77
---

A Go slice looks like a list. It is really a small header — a pointer, a
length, and a capacity — over a contiguous block. `append` is fast because the
block usually has room; when it does not, the runtime allocates a larger block
and copies.

A **dynamic array** is that idea without the language help. Building one makes
the copy visible, and the benchmark shows what preallocating the block is
worth.

## The header

The array keeps one field, a slice. The length is the number of stored values;
the capacity is the size of the block:

<!-- verify: internal/dsa/array.go at=dsa-array -->
```go title="internal/dsa/array.go"
type DynamicArray[T any] struct {
	items []T
}

// NewDynamicArray returns an array with the requested capacity.
func NewDynamicArray[T any](capacity int) *DynamicArray[T] {
	return &DynamicArray[T]{items: make([]T, 0, capacity)}
}

// Append adds one value. The amortized cost is O(1); the occasional copy is
// O(n), and the capacity doubles so the copies become rare.
func (a *DynamicArray[T]) Append(v T) {
	a.items = append(a.items, v)
}
```

`make([]T, 0, capacity)` allocates the block but sets the length to zero. The
array can append up to `capacity` values without another allocation. When it
outgrows the block, `append` allocates roughly twice the capacity, copies the
old values, and returns a new header.

The copy is O(n), but it happens after n appends; spread over the sequence, the
cost per append is constant. That is **amortized** cost. The worst single
append is expensive; the average is not.

## The benchmark

`BenchmarkAppendGrow` starts with capacity zero and appends a thousand values.
`BenchmarkAppendPrealloc` starts with capacity one thousand and does the same:

<!-- verify: internal/dsa/array_test.go at=dsa-array -->
```go title="internal/dsa/array_test.go"
func BenchmarkAppendGrow(b *testing.B) {
	for i := 0; i < b.N; i++ {
		a := NewDynamicArray[int](0)
		for j := 0; j < 1_000; j++ {
			a.Append(j)
		}
	}
}

func BenchmarkAppendPrealloc(b *testing.B) {
	for i := 0; i < b.N; i++ {
		a := NewDynamicArray[int](1_000)
		for j := 0; j < 1_000; j++ {
			a.Append(j)
		}
	}
}
```

The first grows through several blocks; the second allocates once. The test
below checks the reads and the out-of-range case, so the benchmark is not the
only evidence that the structure works.

## Run it

```bash
$ go test -run TestDynamicArray -v ./internal/dsa
=== RUN   TestDynamicArrayGrowsAndReads
--- PASS: TestDynamicArrayGrowsAndReads (0.00s)
PASS
ok  	todo/internal/dsa	0.002s
```

```bash
$ go test -run '^$' -bench 'BenchmarkAppend' -benchmem ./internal/dsa
goos: linux
goarch: amd64
pkg: todo/internal/dsa
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkAppendGrow-16        	  166503	      7338 ns/op	   25208 B/op	      12 allocs/op
BenchmarkAppendPrealloc-16    	  473226	      2882 ns/op	    8192 B/op	       1 allocs/op
PASS
ok  	todo/internal/dsa	2.693s
```

Growing a thousand values costs about 7,300 ns and 12 allocations; preallocating
costs about 2,900 ns and one allocation. The bytes tell the same story: 25 KB
of allocations against 8 KB. The preallocated version is not just faster; it
asks the allocator for less and gives the garbage collector less to do.

The exact ratio depends on the machine and the element size. The shape — a
constant number of allocations versus a logarithmic number of copies — is the
part that travels.

## When to preallocate

`make([]T, 0, n)` is the right call when n is known and the slice is hot. It
is noise in a function that runs once. The compiler cannot read your mind, and
the runtime's growth is good enough for the common case.

A map has a similar hint: `make(map[K]V, n)` sizes the initial buckets. The
map's growth is more expensive than a slice copy because it rehashes every
key. A map built with a known size avoids the rehash steps.

The cost of overallocating is memory. A slice with capacity one million and
length ten holds a million-element block; the ten values do not care. A
capacity hint is a guess, and a bad guess costs more than the growth it
avoided.

## Maps are not slices

A map is a hash table. It does not preserve insertion order, it does not
support an index, and its iteration order is deliberately randomized. The
lookup is O(1) on average because the key hashes to a bucket; the cost is the
hash, the bucket probe, and the memory for the table.

The previous day's benchmark showed the lookup gap. This day's benchmark shows
the other side: building a map with a size hint avoids rehashing. Both are the
same lesson — the structure has a shape, and the shape has a price.

## The header is copied

A slice is a three-word header: pointer, length, capacity. Passing a slice to a
function copies the header, not the block. Appending inside the function can
write into the caller's block if there is capacity, or allocate a new block if
there is not. The caller sees the first case and not the second.

That is why a function that appends should return the new slice. The header is
the API; the block is shared. A map is different: the map value is a pointer to
the runtime's table, so passing a map and writing to it is visible to the
caller. The two types look similar and behave oppositely.

## Maps have a size hint too

`make(map[K]V, n)` tells the runtime how many entries to expect. It sizes the
initial bucket array, so the map rehashes fewer times while it fills. The hint
is a performance tool, not a correctness one; a wrong hint costs memory, not a
wrong answer.

The same is true of a slice's capacity. The hint is an optimization for a hot
path with a known size. In a function that runs once, the hint is noise.

## If something went wrong

- **`append` changed the caller's slice** — a slice is a header passed by
  value. Appending inside a function can allocate a new block that the caller
  never sees. Return the new slice.
- **A preallocated slice still allocates** — the append exceeded the capacity,
  or the element type is larger than expected. Check `cap` before blaming the
  hint.
- **The map iteration order changed** — that is deliberate. Sort the keys if
  the order matters.
- **The benchmark allocates without an obvious reason** — the interface value,
  the closure, or the growth is the cause. `-benchmem` names the bytes; the
  escape analysis names the line.

<details>
<summary>Going deeper: the growth factor</summary>

Go's slice growth is not exactly doubling for every size; the runtime uses a
formula that keeps the growth factor near 1.25 for large slices and closer to
2 for small ones. The exact factor is an implementation detail, not a promise.
The promise is amortized O(1), and the factor is how the runtime keeps the
copies rare without wasting too much memory.

A custom dynamic array can choose its own factor. Doubling is easy to reason
about; 1.5 is gentler on memory and copies more often. The right choice
depends on the element size and the allocator, which is why the benchmark
exists.

</details>

The block grows by copying. Next we use the two ends of a sequence — a stack
and a queue — and a linked list that never copies.
