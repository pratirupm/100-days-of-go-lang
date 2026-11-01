---
title: "Day 93 — Stacks, queues, and links"
description: "Choose a stack or a queue from the order the work needs, and see where a linked list earns its pointers and where a slice wins. — Day 93 of 100 Days of Go Lang."
sidebar:
  order: 93
chapter: 78
---

**About 3 hours** · Part XVI, day 3 of 9.

**You'll be able to:**

- choose a stack or a queue from the order the work needs;
- see where a linked list earns its pointers and where a slice wins.

---

A sequence has two ends, and the operation you allow at each end names the
structure. A **stack** adds and removes at the same end: last in, first out.
A **queue** adds at one end and removes at the other: first in, first out. The
choice is not stylistic; it is the order the work must happen.

A **linked list** is the other way to hold a sequence: each element points to
the next. It never copies the whole block, but it follows a pointer for every
step and spends memory on the links. Today we build all three and let the
tests argue for them.

## The stack

The stack is a slice with two methods:

<!-- verify: internal/dsa/linear.go at=dsa-linear -->
```go title="internal/dsa/linear.go"
type Stack[T any] struct {
	items []T
}

// Push adds a value to the top.
func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }

// Pop removes and returns the top value.
func (s *Stack[T]) Pop() (T, bool) {
	if len(s.items) == 0 {
		var zero T
		return zero, false
	}
	last := len(s.items) - 1
	v := s.items[last]
	s.items = s.items[:last]
	return v, true
}
```

`Pop` shortens the slice; it does not erase the value, so a reference stored
in the backing array can keep an object alive after it is popped. For a value
type such as `int`, that does not matter. For a pointer, a production stack
would zero the slot before shortening.

The `(T, bool)` return is the Go idiom for a missing value: the zero value is
not an error, and the caller decides whether an empty stack is a bug. A panic
would be faster and less polite; a sentinel value would be ambiguous.

## The queue

A queue over a slice has a head index. Dequeue moves the head, not every
element:

<!-- verify: internal/dsa/linear.go at=dsa-linear -->
```go title="internal/dsa/linear.go"
type Queue[T any] struct {
	items []T
	head  int
}

// Enqueue adds a value to the back.
func (q *Queue[T]) Enqueue(v T) { q.items = append(q.items, v) }

// Dequeue removes and returns the front value.
func (q *Queue[T]) Dequeue() (T, bool) {
	if q.head >= len(q.items) {
		var zero T
		return zero, false
	}
	v := q.items[q.head]
	q.head++
	if q.head > 0 && q.head*2 >= len(q.items) {
		q.items = append([]T(nil), q.items[q.head:]...)
		q.head = 0
	}
	return v, true
}
```

Without the compaction, the backing array grows forever: every enqueue
appends, and the dead prefix is never reused. The `head*2 >= len` check is a
simple policy — compact when at least half the block is dead. A ring buffer
avoids the copy entirely by wrapping the index, at the cost of a fixed
capacity or a grow step.

## The linked list

A linked list stores one node per value:

<!-- verify: internal/dsa/linear.go at=dsa-linear -->
```go title="internal/dsa/linear.go"
type Node[T comparable] struct {
	Value T
	Next  *Node[T]
}

...
type LinkedList[T comparable] struct {
	head *Node[T]
	tail *Node[T]
	n    int
}
```

`PushFront` is O(1): create a node, point it at the old head. `PushBack` is
O(1) because the list keeps a tail pointer; without it, every append would
walk to the end. `Remove` walks from the head, so it is O(n).

The `comparable` constraint is there because `Remove` compares values. A list
that only appends and walks could use `any`; a list that searches for a value
needs equality.

## Run the tests

```bash
$ go test -run 'Test(Stack|Queue|LinkedList)' -v ./internal/dsa
=== RUN   TestStackLIFO
--- PASS: TestStackLIFO (0.00s)
=== RUN   TestQueueFIFO
--- PASS: TestQueueFIFO (0.00s)
=== RUN   TestLinkedListRemove
--- PASS: TestLinkedListRemove (0.00s)
PASS
ok  	todo/internal/dsa	0.002s
```

The stack test pushes two values and pops them in reverse; the queue test
enqueues five and dequeues them in order; the list test removes the tail and
checks the missing case. The tests are small because the contract is small.

## Which one

A stack is the right shape for undo, depth-first search, and expression
parsing. A queue is the right shape for breadth-first search, a worker pool,
and any "first come, first served" scheduling.

A linked list is rarely the right default in Go. A slice is contiguous,
cache-friendly, and cheaper per element. The list wins when the sequence is
large, the inserts and removes happen at known nodes, and the elements are
moved between lists without copying. That is a narrower case than a textbook
suggests.

The queue's compaction is the same trade in miniature: a slice plus an index
is a queue, as long as the dead prefix is reclaimed. A ring buffer or a linked
list avoids the copy; the slice avoids the pointer chase. Measure the workload,
not the textbook.

## The ring buffer

A ring buffer is a fixed-size slice with a head and a tail that wrap. Enqueue
writes at the tail and advances modulo the length; dequeue reads at the head
and advances the same way. Nothing is copied, and the memory is allocated once.

The cost is capacity: a full ring must either reject the enqueue or grow. A
grow copies the live elements into a larger ring, which is the same amortized
trade as the dynamic array. The ring is the right shape for a bounded queue
with a known maximum, such as a batch of a fixed size.

## The deque

A double-ended queue allows push and pop at both ends. A ring buffer is one
implementation; a linked list is another. The deque is the structure behind a
sliding-window maximum and a work-stealing scheduler. The stack and the queue
are its two restricted views.

Go's standard library does not ship a deque. A slice with a head index is the
usual substitute, with the same compaction trade as the queue above.

## If something went wrong

- **`Pop` returns a stale value after `Len` is zero** — the test checked the
  bool; a caller that ignores it reads the zero value. Always check the bool.
- **The queue's memory grows without bound** — the compaction threshold never
  triggers, or the consumer is slower than the producer. Check `Len` and the
  backing capacity.
- **`Remove` on a singly linked list is O(n)** — the list has no back pointer.
  A doubly linked list makes the removal O(1) at the cost of another pointer
  per node.
- **The generic list does not compile with a struct value** — the struct is
  not comparable. Use a key function instead of `==`, or store a comparable
  key beside the value.

<details>
<summary>Going deeper: the cache is the hidden cost</summary>

A slice walk reads contiguous memory, so the CPU prefetcher can bring the next
elements before they are needed. A linked-list walk follows a pointer to a
random address; each step can be a cache miss. The asymptotic costs can be the
same and the wall-clock costs very different.

That is why "linked lists are O(1) insert" is only half the story. The insert
is O(1) once you have the node; finding the node is O(n), and the walk is
cache-hostile. A slice insert is O(n) because it shifts, but the shift is a
contiguous copy the hardware does well.

</details>

The two ends of a sequence are covered. Next we give the sequence an order
that supports search: a tree.

<div class="day-tracker" data-day="93"></div>
