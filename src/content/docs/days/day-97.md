---
title: "Day 97 — Sorting and searching"
description: "Sort with quicksort and merge sort, compare their costs, and find a value in a sorted slice without scanning it. — Day 97 of 100 Days of Go Lang."
sidebar:
  order: 97
chapter: 82
---

**About 3 hours** · Part XVI, day 7 of 9.

**You'll be able to:**

- sort with quicksort and merge sort and compare their costs;
- find a value in a sorted slice without scanning it.

---

Sorting is the operation that makes searching easy. A sorted slice supports
binary search: halve the range, compare, repeat. An unsorted slice forces a
scan. The sort costs O(n log n) once; the search saves O(n) every time.

Two classic sorts show the trade. **Quicksort** partitions in place, so it
uses little memory and is fast in practice, but its worst case is O(n^2).
**Merge sort** always costs O(n log n) and is stable, but it needs an O(n)
buffer.

## Quicksort

Quicksort picks a pivot, moves smaller values to its left and larger to its
right, then sorts the two sides:

<!-- verify: internal/dsa/sort.go at=dsa-sorting -->
```go title="internal/dsa/sort.go"
func QuickSort(values []int) {
	quick(values, 0, len(values)-1)
}

func quick(a []int, lo, hi int) {
	if lo >= hi {
		return
	}
	p := partition(a, lo, hi)
	quick(a, lo, p-1)
	quick(a, p+1, hi)
}
```

The partition is the interesting part. The median-of-three pivot avoids the
worst case on already-sorted input, which is the case a naive first-element
pivot handles badly:

<!-- verify: internal/dsa/sort.go at=dsa-sorting -->
```go title="internal/dsa/sort.go"
func partition(a []int, lo, hi int) int {
	mid := lo + (hi-lo)/2
	if a[mid] < a[lo] {
		a[mid], a[lo] = a[lo], a[mid]
	}
	if a[hi] < a[lo] {
		a[hi], a[lo] = a[lo], a[hi]
	}
	if a[hi] < a[mid] {
		a[hi], a[mid] = a[mid], a[hi]
	}
	a[mid], a[hi-1] = a[hi-1], a[mid]
	pivot := a[hi-1]
	i := lo
	for j := lo; j < hi-1; j++ {
		if a[j] < pivot {
			a[i], a[j] = a[j], a[i]
			i++
		}
	}
	a[i], a[hi-1] = a[hi-1], a[i]
	return i
}
```

The pivot ends at `hi-1`; the loop leaves everything smaller before `i` and
everything larger after it. The recursion sorts the two sides. The average
cost is O(n log n); the worst case is still O(n^2) for an adversarial input,
which is why production sorts use a hybrid with a heap or insertion fallback.

## Merge sort

Merge sort splits the slice, sorts each half, and merges the two sorted
halves:

<!-- verify: internal/dsa/sort.go at=dsa-sorting -->
```go title="internal/dsa/sort.go"
func MergeSort(values []int) []int {
	if len(values) < 2 {
		return append([]int(nil), values...)
	}
	mid := len(values) / 2
	left := MergeSort(values[:mid])
	right := MergeSort(values[mid:])
	out := make([]int, 0, len(values))
	for len(left) > 0 && len(right) > 0 {
		if left[0] <= right[0] {
			out = append(out, left[0])
			left = left[1:]
		} else {
			out = append(out, right[0])
			right = right[1:]
		}
	}
	out = append(out, left...)
	out = append(out, right...)
	return out
}
```

The `<=` on the left value is what makes the sort stable: equal values keep
their original order. The cost is O(n log n) in every case, and the buffer is
O(n) per merge. The recursion allocates a new slice at each level; a
production version allocates one buffer and reuses it.

## Binary search

A sorted slice can be searched by halving. The loop keeps a `lo` and `hi`
inclusive and narrows the range:

<!-- verify: internal/dsa/sort.go at=dsa-sorting -->
```go title="internal/dsa/sort.go"
func BinarySearch(sorted []int, target int) (int, bool) {
	lo, hi := 0, len(sorted)-1
	for lo <= hi {
		mid := lo + (hi-lo)/2
		switch {
		case sorted[mid] == target:
			return mid, true
		case sorted[mid] < target:
			lo = mid + 1
		default:
			hi = mid - 1
		}
	}
	return 0, false
}
```

`mid := lo + (hi-lo)/2` avoids overflow in a language where `lo+hi` can
overflow; Go's int is large enough for a slice, but the habit is portable. The
cost is O(log n): each comparison halves the range.

`sort.SearchInts` in the standard library uses the same shape with a predicate.
The book's version returns the index and a bool; `sort.Search` returns the
first index where the predicate is true, which is the more general tool.

## Run the test

```bash
$ go test -run TestSorts -v ./internal/dsa
=== RUN   TestSortsAndSearch
--- PASS: TestSortsAndSearch (0.00s)
PASS
ok  	todo/internal/dsa	0.002s
```

The test sorts a shuffled slice with both algorithms and searches every value
in the result. It also checks a missing value. The assertions are the
contract; the algorithms are the implementation.

## Choosing a sort

`slices.Sort` is the right default in Go: it is a hybrid of quicksort,
heapsort, and insertion sort, tuned for the standard library's types. Write
your own when you need stability with a custom comparison, a specific memory
profile, or the exercise of understanding the shape.

Quicksort is in-place and cache-friendly; merge sort is stable and predictable.
A stable sort matters when equal keys must keep their original order — for
example, tasks with the same due date sorted by creation time.

## Stability is a product decision

A stable sort keeps equal keys in their original order. That matters when the
input has a secondary order already: tasks sorted by creation time, then by
priority, keep the creation order within one priority. An unstable sort can
shuffle those ties.

Merge sort is stable by construction; quicksort is not, unless the partition
carries the original index as a tiebreaker. `slices.SortStableFunc` is the
standard library's stable option. The extra cost is usually a buffer and a
slower merge; the benefit is a predictable order a user can see.

## Binary search variants

`BinarySearch` returns any matching index. A "lower bound" search returns the
first index where the value is at least the target; an "upper bound" returns the
first index greater than it. The variants matter for duplicates and for
insertion points.

`sort.Search` takes a predicate and returns the first index where it is true.
That one function covers lower bound, upper bound, and "is it present" with a
small wrapper. The loop is the same halving; the predicate is the difference.

## If something went wrong

- **Quicksort is O(n^2) on sorted input** — the pivot choice is poor. Use
  median-of-three or a random pivot.
- **Merge sort is slower than expected** — the allocations dominate. Reuse a
  buffer or use `slices.SortStableFunc`.
- **Binary search misses a value that is present** — the range is off by one.
  Keep `lo <= hi` and move past `mid` on both sides.
- **Binary search on an unsorted slice** — the result is meaningless. Sort
  first, or use a linear scan.

<details>
<summary>Going deeper: comparison lower bound</summary>

A comparison sort cannot do better than O(n log n) in the worst case. There
are n! possible orders, and each comparison gives one bit; log2(n!) is
Θ(n log n). Quicksort and merge sort meet the bound; a sort that beats it must
avoid comparisons — counting sort, radix sort, or a bucket sort that knows the
key distribution.

That is why a sort of small integers can be faster than `slices.Sort`: the
keys fit in a few buckets, and the algorithm never compares them. The general
sort is the safe default; the specialized sort is the optimization when the
keys are known.

</details>

The values are ordered. Next we use the toolbox on the kind of problems an
interview asks, and say the cost before writing the code.

<div class="day-tracker" data-day="97"></div>
