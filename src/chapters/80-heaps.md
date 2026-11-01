---
title: Heaps
day: 95
time: "3 hours"
description: Keep the smallest value at the root with two array walks, then use a heap to answer a top-k question without sorting everything.
sidebar:
  order: 80
---

A binary search tree keeps every value in order, which is more than a priority
queue needs. A **heap** keeps only one promise: the smallest value is at the
root, and every parent is smaller than its children. That is enough to answer
"what is next?" in O(log n) and to build a priority queue.

The heap is stored in an array, not in nodes with pointers. The parent of index
`i` is `(i-1)/2`; the children are `2*i+1` and `2*i+2`. The array is the tree.

## The shape

The heap keeps a slice and a comparison function:

<!-- verify: internal/dsa/heap.go at=dsa-heaps -->
```go title="internal/dsa/heap.go"
type MinHeap[T any] struct {
	items []T
	less  func(a, b T) bool
}

// NewMinHeap returns an empty heap ordered by less.
func NewMinHeap[T any](less func(a, b T) bool) *MinHeap[T] {
	return &MinHeap[T]{less: less}
}
```

`less` is the ordering. A min-heap of ints uses `<`; a max-heap uses `>`. The
same code serves both, and a heap of structs can order by a field.

## Push

Push appends the value at the end, then walks it up while it is smaller than
its parent:

<!-- verify: internal/dsa/heap.go at=dsa-heaps -->
```go title="internal/dsa/heap.go"
func (h *MinHeap[T]) Push(v T) {
	h.items = append(h.items, v)
	i := len(h.items) - 1
	for i > 0 {
		parent := (i - 1) / 2
		if !h.less(h.items[i], h.items[parent]) {
			break
		}
		h.items[i], h.items[parent] = h.items[parent], h.items[i]
		i = parent
	}
}
```

The walk is O(log n): each swap moves up one level. The append is amortized
O(1). The heap property is restored before the method returns.

## Pop

Pop removes the root, moves the last value to the root, and walks it down:

<!-- verify: internal/dsa/heap.go at=dsa-heaps -->
```go title="internal/dsa/heap.go"
func (h *MinHeap[T]) Pop() (T, bool) {
	if len(h.items) == 0 {
		var zero T
		return zero, false
	}
	top := h.items[0]
	last := len(h.items) - 1
	h.items[0] = h.items[last]
	h.items = h.items[:last]
	h.siftDown(0)
	return top, true
}
```

The last leaf replaces the root because removing the last element is cheap. It
is probably not the next smallest, so `siftDown` repairs the order.

## Sift down

`siftDown` compares the node with its two children and swaps with the smaller
one until neither child is smaller:

<!-- verify: internal/dsa/heap.go at=dsa-heaps -->
```go title="internal/dsa/heap.go"
func (h *MinHeap[T]) siftDown(i int) {
	for {
		left, right := 2*i+1, 2*i+2
		smallest := i
		if left < len(h.items) && h.less(h.items[left], h.items[smallest]) {
			smallest = left
		}
		if right < len(h.items) && h.less(h.items[right], h.items[smallest]) {
			smallest = right
		}
		if smallest == i {
			return
		}
		h.items[i], h.items[smallest] = h.items[smallest], h.items[i]
		i = smallest
	}
}
```

The bounds checks are the only edge cases: a node may have no children, only a
left child, or both. The loop stops when the node is smaller than both.

## Run the test

```bash
$ go test -run TestMinHeap -v ./internal/dsa
=== RUN   TestMinHeapOrder
--- PASS: TestMinHeapOrder (0.00s)
PASS
ok  	todo/internal/dsa	0.002s
```

The test pushes `5, 3, 8, 1, 4, 7, 9` and pops them in ascending order. The
input order does not matter; the heap repairs itself on every push and pop.

## Top-k

A heap answers "the k largest values" without sorting the whole input. Keep a
min-heap of size k; push each value; when the heap is over k, pop the smallest.
The heap holds the k largest seen so far, and its root is the weakest of them.

The cost is O(n log k), not O(n log n). When k is small and n is large, that is
the difference between a scan and a sort. The practice day uses this.

`container/heap` in the standard library is the same idea with an interface
instead of a generic. The generated `priorityQueue` in the graph day is a
concrete example: `Len`, `Less`, `Swap`, `Push`, and `Pop` are the five methods
the package needs.

## Heap or sorted slice?

A sorted slice answers "the smallest" in O(1) and "the k smallest" with a
slice, but every insert is O(n) because the elements shift. A heap answers
"the smallest" in O(1) and insert/pop in O(log n), but it cannot answer "the
fifth smallest" without popping four values.

Choose the heap when the workload is a stream of inserts and repeated
extractions. Choose the sorted slice when the data is built once and read many
times, or when the order of the whole set is the point. The top-k problem is a
heap because k is small and the stream is large; a sorted slice would sort the
whole stream for a prefix.

## The heap is an array

The heap's memory is one contiguous slice, so a heap of a million ints is a
million ints plus a little slack. A tree of nodes would add two pointers per
value and a pointer chase per comparison. That is why a priority queue is
usually an array heap, not a balanced tree.

The array also makes the heap easy to serialize and to copy. The shape is the
index arithmetic; there is no hidden allocation per node.

## The heap is not sorted

The heap guarantees only the root. The rest of the array is partially ordered:
a parent is smaller than its children, but siblings have no relation. Iterating
the array does not produce sorted order; popping does.

That is the trade. A sorted array gives O(1) minimum and O(log n) search but
O(n) insert. A heap gives O(1) minimum and O(log n) insert/pop but no order
beyond the root. Choose by the operations, not by the name.

## If something went wrong

- **The root is not the smallest** — the comparison in `less` is reversed, or
  `siftDown` picked the larger child. Check both children before swapping.
- **Pop returns a value twice** — the slice was shortened but the last slot
  was not cleared, or the caller kept a copy. The heap's length is the source
  of truth.
- **Top-k returns k+1 values** — the pop happens after the push, and the
  condition is `> k`; check the order.
- **The heap is slower than sorting** — k is close to n. At that point the
  heap's log k is close to log n, and the sort's simpler memory access wins.

<details>
<summary>Going deeper: heapify is linear</summary>

Building a heap by pushing n values costs O(n log n). Building it by sifting
down from the last parent to the root costs O(n), because most nodes are near
the bottom and sift down only a level or two. The linear build is why
`container/heap`'s `Init` is cheaper than n pushes.

The proof is a sum over levels: level h has at most n/2^(h+1) nodes, and each
sifts at most h levels. The sum is bounded by 2n. The constant is not the
point; the shape is that the expensive sifts happen at the top, where there
are few nodes.

</details>

The heap keeps one value at the front. Next we connect values to each other
and walk the graph.
