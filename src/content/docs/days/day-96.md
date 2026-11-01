---
title: "Day 96 — Graphs"
description: "Walk a graph breadth-first and depth-first, then find shortest paths with weights using Dijkstra. — Day 96 of 100 Days of Go Lang."
sidebar:
  order: 96
chapter: 81
---

**About 3 hours** · Part XVI, day 6 of 9.

**You'll be able to:**

- walk a graph breadth-first and depth-first;
- find shortest paths with weights using Dijkstra.

---

A tree is a graph with no cycles and one root. A **graph** drops both
assumptions: vertices can connect to many others, edges can have weights, and
a walk can return to where it started. A dependency graph, a road network, and
a task scheduler are all graphs.

The representation decides the cost. An **adjacency list** stores each vertex's
edges in a slice; an **adjacency matrix** stores a table of booleans or
weights. The list is smaller for a sparse graph, which is most graphs the app
will meet.

## The shape

The graph is a map from a vertex to its outgoing edges:

<!-- verify: internal/dsa/graph.go at=dsa-graphs -->
```go title="internal/dsa/graph.go"
type Edge struct {
	To     string
	Weight int
}

...
type Graph struct {
	adj map[string][]Edge
}

// NewGraph returns an empty graph.
func NewGraph() *Graph { return &Graph{adj: map[string][]Edge{}} }
```

`AddEdge` appends the edge and creates an empty entry for the destination, so
a vertex with no outgoing edges still exists:

<!-- verify: internal/dsa/graph.go at=dsa-graphs -->
```go title="internal/dsa/graph.go"
func (g *Graph) AddEdge(from, to string, weight int) {
	g.adj[from] = append(g.adj[from], Edge{To: to, Weight: weight})
	if _, ok := g.adj[to]; !ok {
		g.adj[to] = nil
	}
}
```

The edge is directed. An undirected graph calls `AddEdge` twice, once in each
direction. The weight is an int; a real network would use a float or a
duration, but the algorithm is the same.

## Breadth-first

BFS uses a queue. It visits every vertex at distance 1 before any at distance
2, which is why it finds the shortest path in an unweighted graph:

<!-- verify: internal/dsa/graph.go at=dsa-graphs -->
```go title="internal/dsa/graph.go"
func (g *Graph) BFS(start string) []string {
	seen := map[string]bool{start: true}
	queue := []string{start}
	var out []string
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		out = append(out, v)
		for _, e := range g.adj[v] {
			if !seen[e.To] {
				seen[e.To] = true
				queue = append(queue, e.To)
			}
		}
	}
	return out
}
```

The `seen` map is set when a vertex is enqueued, not when it is dequeued. If it
were set on dequeue, a vertex with two parents would be queued twice. The
queue is a slice with a head pop; the earlier queue lesson explains the cost.

DFS uses a stack, or recursion. The recursive version is shorter:

<!-- verify: internal/dsa/graph.go at=dsa-graphs -->
```go title="internal/dsa/graph.go"
func (g *Graph) DFS(start string) []string {
	seen := map[string]bool{}
	var out []string
	var walk func(string)
	walk = func(v string) {
		if seen[v] {
			return
		}
		seen[v] = true
		out = append(out, v)
		for _, e := range g.adj[v] {
			walk(e.To)
		}
	}
	walk(start)
	return out
}
```

Both walks are O(V+E): every vertex and edge is visited once. The difference is
order, not cost.

## Shortest paths

BFS is shortest by edge count. A weighted graph needs Dijkstra, which always
expands the unvisited vertex with the smallest known distance. The priority
queue is the heap from the previous day:

<!-- verify: internal/dsa/graph.go at=dsa-graphs -->
```go title="internal/dsa/graph.go"
func (g *Graph) Dijkstra(start string) map[string]int {
	dist := map[string]int{start: 0}
	pq := &priorityQueue{{vertex: start, dist: 0}}
	heap.Init(pq)
	for pq.Len() > 0 {
		cur := heap.Pop(pq).(item)
		if cur.dist != dist[cur.vertex] {
			continue
		}
		for _, e := range g.adj[cur.vertex] {
			next := cur.dist + e.Weight
			if d, ok := dist[e.To]; !ok || next < d {
				dist[e.To] = next
				heap.Push(pq, item{vertex: e.To, dist: next})
			}
		}
	}
	return dist
}
```

The `cur.dist != dist[cur.vertex]` check skips a stale queue entry: a vertex
can be pushed more than once when a shorter path is found. Without it, the
algorithm still works but does extra work.

The queue is the standard library's `container/heap`, wrapped in a small
type:

<!-- verify: internal/dsa/graph.go at=dsa-graphs -->
```go title="internal/dsa/graph.go"
type item struct {
	vertex string
	dist   int
}

type priorityQueue []item

func (p priorityQueue) Len() int           { return len(p) }
func (p priorityQueue) Less(i, j int) bool { return p[i].dist < p[j].dist }
func (p priorityQueue) Swap(i, j int)      { p[i], p[j] = p[j], p[i] }
func (p *priorityQueue) Push(x any)        { *p = append(*p, x.(item)) }
func (p *priorityQueue) Pop() any {
	old := *p
	last := old[len(old)-1]
	*p = old[:len(old)-1]
	return last
}
```

Dijkstra requires non-negative weights. A negative edge breaks the greedy
choice: the smallest known distance may not be final. Bellman-Ford handles
negative edges at a higher cost; a negative cycle has no shortest path at all.

## Run the test

```bash
$ go test -run 'TestGraph|TestDijkstra' -v ./internal/dsa
=== RUN   TestGraphTraversal
--- PASS: TestGraphTraversal (0.00s)
=== RUN   TestDijkstra
--- PASS: TestDijkstra (0.00s)
PASS
ok  	todo/internal/dsa	0.003s
```

The test graph is `a→b(1), a→c(4), b→c(2), c→d(1)`. Dijkstra returns
`a:0, b:1, c:3, d:4`; the direct `a→c` edge is not the shortest path.

## The representation is a trade

An adjacency list is O(V+E) memory and fast to iterate. An adjacency matrix is
O(V^2) memory and answers "is there an edge?" in O(1). For a dense graph the
matrix can be smaller than a list of slices; for a sparse graph the list wins by
a wide margin.

The algorithms in this lesson use the list. A matrix version of BFS scans a row
instead of a slice; the order is the same. The choice is the density of the
graph and the question the app asks most often.

## Weights as time

A weight can be a distance, a cost, a latency, or a count. Dijkstra does not
care about the unit; it cares that the weights are non-negative and additive.
A latency that includes a queue is not additive in the same way, which is why
a queueing model is not a simple shortest path.

The graph is a model. The algorithm is only as good as the model's assumptions;
write them down next to the edges.

## The graph is built once

Building an adjacency list costs O(V+E). The traversals assume the graph is
already built; rebuilding it per request would dominate the algorithm. In the
app, the package graph is built at startup and read many times, which is the
right shape.

A dynamic graph needs an update strategy: add an edge, remove an edge, and
keep the traversal correct. The simple list supports append; a removal is a
scan of one vertex's edges. That is usually fine for a small graph and a
reason to use a different representation for a large one.

## If something went wrong

- **A vertex is missing from the BFS output** — it has no incoming edge and was
  never the start. The traversal only reaches connected vertices.
- **BFS visits a vertex twice** — `seen` is set on dequeue. Set it on enqueue.
- **Dijkstra returns a longer path** — a stale queue entry was not skipped, or
  a negative edge is present.
- **The graph uses a lot of memory** — the adjacency list stores a slice per
  vertex. A matrix would be worse for a sparse graph; a compressed format is
  the next step.

<details>
<summary>Going deeper: topological order</summary>

A directed acyclic graph can be ordered so every edge points forward. That
order is a **topological sort**, and it is what a build system uses to decide
which package to compile first.

Kahn's algorithm repeatedly removes a vertex with no incoming edges; if it
removes fewer than all vertices, the graph has a cycle. DFS can produce the
same order by appending a vertex after its descendants and reversing the
result. The app's package graph and the database migration order are both
topological problems in disguise.

</details>

Graphs connect the structures. Next we put values in order with two sorts and
find one with binary search.

<div class="day-tracker" data-day="96"></div>
