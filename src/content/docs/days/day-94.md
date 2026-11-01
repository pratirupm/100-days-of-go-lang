---
title: "Day 94 — Trees"
description: "Insert, search, and walk a binary search tree in order, and explain why an unbalanced tree loses its logarithmic promise. — Day 94 of 100 Days of Go Lang."
sidebar:
  order: 94
chapter: 79
---

**About 3 hours** · Part XVI, day 4 of 9.

**You'll be able to:**

- insert, search, and walk a binary search tree in order;
- explain why an unbalanced tree loses its logarithmic promise.

---

A sorted slice answers a lookup in O(log n) with binary search, but inserting
into the middle is O(n). A **binary search tree** keeps the order and the
insert cheap: each node has a left subtree of smaller values and a right
subtree of larger ones, so a search follows one path.

The cost is the height. A balanced tree has height O(log n); a tree built from
sorted input is a linked list with extra pointers, and the search is O(n).
Today we build the shape and measure the height.

## The node

The tree is a root pointer and nodes with two children:

<!-- verify: internal/dsa/bst.go at=dsa-trees -->
```go title="internal/dsa/bst.go"
type BST struct {
	root *bstNode
}

type bstNode struct {
	value       int
	left, right *bstNode
}
```

The value is an `int` to keep the lesson small. A generic tree would take a
comparison function; the shape is the same.

## Insert

Insert walks down the same path a search would, creating a leaf when it finds
an empty child:

<!-- verify: internal/dsa/bst.go at=dsa-trees -->
```go title="internal/dsa/bst.go"
func insertNode(n *bstNode, v int) *bstNode {
	if n == nil {
		return &bstNode{value: v}
	}
	switch {
	case v < n.value:
		n.left = insertNode(n.left, v)
	case v > n.value:
		n.right = insertNode(n.right, v)
	}
	return n
}
```

The duplicate case does nothing: a set stores one copy of each value. The
recursive version is easy to read; an iterative version avoids the call stack
and is what a production tree would use for a deep structure.

The cost is O(height). Each comparison chooses a subtree; the number of
comparisons is the length of the path from the root to the new leaf.

## Search

The search is the same walk without the insert:

<!-- verify: internal/dsa/bst.go at=dsa-trees -->
```go title="internal/dsa/bst.go"
func (t *BST) Contains(v int) bool {
	n := t.root
	for n != nil {
		switch {
		case v == n.value:
			return true
		case v < n.value:
			n = n.left
		default:
			n = n.right
		}
	}
	return false
}
```

The loop stops at the value or at a nil child. A missing value costs the
height of the tree, not the number of nodes.

## In-order

An in-order walk visits left, node, right. On a binary search tree, that is
ascending order:

<!-- verify: internal/dsa/bst.go at=dsa-trees -->
```go title="internal/dsa/bst.go"
func (t *BST) InOrder() []int {
	var out []int
	var walk func(*bstNode)
	walk = func(n *bstNode) {
		if n == nil {
			return
		}
		walk(n.left)
		out = append(out, n.value)
		walk(n.right)
	}
	walk(t.root)
	return out
}
```

The walk is O(n): every node is visited once. The output is a sorted slice,
which is a useful way to check the tree's shape and a useful way to hand the
values to a binary search.

`Height` is the number of edges on the longest path. The empty tree is -1, a
leaf is 0, and a node is one more than its taller child:

<!-- verify: internal/dsa/bst.go at=dsa-trees -->
```go title="internal/dsa/bst.go"
func (t *BST) Height() int {
	var height func(*bstNode) int
	height = func(n *bstNode) int {
		if n == nil {
			return -1
		}
		return 1 + max(height(n.left), height(n.right))
	}
	return height(t.root)
}
```

## Run the test

```bash
$ go test -run TestBST -v ./internal/dsa
=== RUN   TestBSTOrderAndHeight
--- PASS: TestBSTOrderAndHeight (0.00s)
PASS
ok  	todo/internal/dsa	0.002s
```

The test inserts `5, 3, 8, 1, 4, 7, 9`; the in-order walk returns
`1, 3, 4, 5, 7, 8, 9`, and the height is 2. The tree is balanced by accident
because the input order alternates around the root.

## The balance problem

Insert `1, 2, 3, 4, 5` in order. Every value is greater than the last, so every
node becomes a right child:

```text
1
 \
  2
   \
    3
     \
      4
       \
        5
```

The height is 4 for 5 nodes, and the search for 5 visits every node. The
tree's O(log n) promise assumed balance; sorted input breaks it.

The fixes are rotations (AVL, red-black) or a different shape (B-tree, skip
list). Go's standard library does not ship a balanced tree; a `map` is the
usual answer for a key-value lookup, and a sorted slice is the usual answer
for a small ordered set. The tree is worth understanding because the balanced
versions are built from the same rotations.

## Deletion is the hard operation

Insert and search are one path. Deletion has three cases: a leaf is removed, a
node with one child is replaced by that child, and a node with two children is
replaced by its in-order successor (the smallest value in the right subtree),
then the successor is removed from its old place.

The third case is why deletion is the operation that breaks naive tree code.
The ordering must survive the replacement, and the height can change. A
balanced tree adds rotations after the delete, which is more code than the
insert. The book leaves deletion as an exercise because the shape is the lesson,
not the bookkeeping.

## Tree or map?

A Go map is faster for a key lookup and simpler to use. A tree is worth it when
the order is the point: range queries, predecessor/successor, and sorted
traversal. A sorted slice is often the better ordered structure for a small,
read-mostly set; a balanced tree is the better one for a large, changing set.

The unbalanced BST in this lesson is a teaching shape, not a production
default. The standard library's map and `slices` package cover most app needs;
the tree is the idea behind the database index.

## If something went wrong

- **A search for a missing value loops forever** — the walk did not move to a
  child on the unequal case. Check the `default` branch.
- **The in-order output is not sorted** — the comparison was reversed on one
  side. A left child must be smaller, a right child larger.
- **The height is n-1 for sorted input** — that is the unbalanced tree, not a
  bug in `Height`. The fix is a balancing strategy, not a different counter.
- **The recursive insert overflows the stack** — the tree is very deep. Use an
  iterative insert or a balanced tree.

<details>
<summary>Going deeper: why a map is not a tree</summary>

A Go map is a hash table, not a search tree. It gives O(1) average lookup and
no order; a tree gives O(log n) lookup and sorted traversal. If the app needs
"all tasks due before Friday, in order", a tree or a sorted slice answers it;
a map does not.

The database's B-tree index is the same idea at a different scale: a balanced
tree whose nodes are disk pages. The fan-out is large, the height is small, and
the comparisons are the same. The data structure is the reason an index turns
a scan into a seek.

</details>

The tree orders values by comparison. Next we put the smallest value at the
root and keep it there with a heap.

<div class="day-tracker" data-day="94"></div>
