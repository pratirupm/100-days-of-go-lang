---
title: "Day 99 — Choosing the structure"
description: "Build an LRU cache from a map and a list, then pick a structure from the operations the app actually runs. — Day 99 of 100 Days of Go Lang."
sidebar:
  order: 99
chapter: 84
---

**About 3 hours** · Part XVI, day 9 of 9.

**You'll be able to:**

- build an LRU cache from a map and a list;
- pick a structure from the operations the app actually runs.

---

The last eight days built the pieces. The last lesson asks how to choose. The
answer is not "use a map" or "use a tree"; it is the operations the app runs,
their frequency, and the memory it can spend.

An **LRU cache** is a good final exercise because it needs two structures at
once: a map for O(1) lookup and a linked list for O(1) recency updates. Neither
alone is enough.

## The cache

The cache keeps a map from key to list element, and a list with the most
recently used at the front:

<!-- verify: internal/dsa/lru.go at=dsa-choose -->
```go title="internal/dsa/lru.go"
type LRU[K comparable, V any] struct {
	capacity int
	items    map[K]*list.Element
	order    *list.List
}

type lruEntry[K comparable, V any] struct {
	key   K
	value V
}
```

The map answers "is this key present?" in O(1). The list answers "which key is
least recently used?" in O(1) at the back. The element pointer in the map is
the join: a hit can move the element to the front without searching the list.

## Get

A hit moves the element to the front and returns the value:

<!-- verify: internal/dsa/lru.go at=dsa-choose -->
```go title="internal/dsa/lru.go"
func (c *LRU[K, V]) Get(key K) (V, bool) {
	if el, ok := c.items[key]; ok {
		c.order.MoveToFront(el)
		return el.Value.(*lruEntry[K, V]).value, true
	}
	var zero V
	return zero, false
}
```

The type assertion is safe because the cache is the only writer of the list.
A production implementation could hide the element type behind a struct; the
idea is the same.

## Put

A put either updates an existing entry or inserts a new one and evicts the
back if the cache is over capacity:

<!-- verify: internal/dsa/lru.go at=dsa-choose -->
```go title="internal/dsa/lru.go"
func (c *LRU[K, V]) Put(key K, value V) {
	if el, ok := c.items[key]; ok {
		el.Value.(*lruEntry[K, V]).value = value
		c.order.MoveToFront(el)
		return
	}
	el := c.order.PushFront(&lruEntry[K, V]{key: key, value: value})
	c.items[key] = el
	if c.order.Len() > c.capacity {
		last := c.order.Back()
		entry := last.Value.(*lruEntry[K, V])
		delete(c.items, entry.key)
		c.order.Remove(last)
	}
}
```

The eviction uses the back of the list. The entry stores its key so the map can
delete the right entry; the list element alone does not know its key.

## Run it

```bash
$ go test -run TestLRU -v ./internal/dsa
=== RUN   TestLRUEvictsLeastRecentlyUsed
--- PASS: TestLRUEvictsLeastRecentlyUsed (0.00s)
PASS
ok  	todo/internal/dsa	0.004s
```

The test inserts `a`, `b`, touches `a`, inserts `c`, and checks that `b` was
evicted. That is the whole contract: capacity, recency, and eviction.

The lookup benchmark:

```bash
$ go test -run '^$' -bench BenchmarkLRUGet -benchmem ./internal/dsa
goos: linux
goarch: amd64
pkg: todo/internal/dsa
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkLRUGet-16    	28035411	        39.81 ns/op	       0 B/op	       0 allocs/op
PASS
ok  	todo/internal/dsa	1.194s
```

About 40 ns and zero allocations. The map lookup, the list move, and the type
assertion are the cost. The number is for this machine; the zero allocations
are the part that travels.

## Choosing

Start with the operations:

| Operation | Structure | Cost |
|---|---|---|
| Append and iterate | slice | O(1) amortized, contiguous |
| Lookup by key | map | O(1) average |
| Last in, first out | stack | O(1) |
| First in, first out | queue | O(1) amortized |
| Ordered traversal | tree or sorted slice | O(log n) or O(n) |
| Next smallest | heap | O(log n) |
| Shortest path | graph + heap | O((V+E) log V) |

Then the constraints: memory, concurrency, persistence, and the cost of a
mistake. A map is the default for a key lookup because the standard library
has one and it is fast. A slice is the default for a small ordered set because
it is contiguous and the constant is tiny. A tree is worth it when the order
is the point and the set is large. A heap is worth it when only the extreme
matters.

The app's own choices follow the same table: the store's tasks are a slice in
memory and rows in a database; the labels are a map/set; the queue is a channel
or a Kafka topic; the shortest path is the dependency graph of packages. The
data structure is rarely named, but it is always there.

## The cost of a wrong choice

A map where a slice would do wastes memory and loses order. A slice where a
map would do turns every lookup into a scan. A tree where a heap would do adds
order nobody reads. A heap where a sorted slice would do adds a log factor for
a set that is read once.

The wrong choice is not a bug in the first test. It is a p99 in production,
or a memory graph that climbs. That is why the cost sentence belongs in the
design review, not only in the interview.

## Concurrency changes the answer

A map is not safe for concurrent writes; a slice is not safe for concurrent
appends; the LRU's list and map are not safe for concurrent access. A mutex
around the whole structure is the first answer. A sharded map or a channel is
the second when the contention is real.

The data structure choice is not complete until the concurrency model is
named. The app's store uses a mutex; the HTTP server gives each request its own
goroutine; the Kafka consumer is one reader per partition. The structure and
the lock are one design.

## Invalidation is the cache's real job

A cache that returns stale data is worse than no cache. The LRU's eviction is
about capacity; invalidation is about correctness. The app's activity cache
deletes the key on write for exactly this reason.

The structure choice is not complete until the invalidation rule is named.
Capacity, recency, and freshness are three different policies; the LRU only
implements one of them.

## If something went wrong

- **The cache returns a value after eviction** — the map still holds the key.
  Delete it when the list element is removed.
- **The cache never evicts** — the capacity check is after the insert but the
  list length is not the map length, or the capacity is zero.
- **The type assertion panics** — something else wrote to the list. Keep the
  list private and the element type consistent.
- **The cache is slower than no cache** — the hit rate is low or the value is
  cheap to compute. Measure the hit rate before adding the complexity.

<details>
<summary>Going deeper: the invariants are the design</summary>

An LRU has three invariants: the map and the list contain the same keys; the
list is ordered by recency; and the length never exceeds capacity. Every bug
is a violation of one of them.

Writing the invariants down is the design. The code is a set of operations that
preserve them. A test that checks the invariants after a sequence of operations
is stronger than a test that checks one scenario.

The same habit applies to the store, the queue, and the cache in the app: name
the invariant, then make every write preserve it.

</details>

The toolbox is complete. The last day is a review: run the suite, compare the
shapes, and solve one problem without a hint.

<div class="day-tracker" data-day="99"></div>
