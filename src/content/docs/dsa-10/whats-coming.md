---
title: The 10 days of DSA
description: "Ten days of data structures and algorithms in Go — complexity, trees, graphs, sorting, and interview-shaped practice, measured with tests and benchmarks."
sidebar:
  label: What's coming
  order: 1
---

Ten days on data structures and algorithms — in Go, and in the book's own
style: write the test, measure the claim, and keep what the numbers support.

The first sixty days already laid the groundwork: slices and maps (Day 3),
generics (Day 7), and benchmarks (Day 14). These ten go underneath them.

## The working shape

- **Cost, measured** — Big-O in one hand and `benchstat` in the other:
  growth curves, allocations, and why the constant matters.
- **Slices and maps, underneath** — how they grow, when they copy, and what
  a collision costs.
- **Stacks, queues, and linked structures** — where each earns its keep, and
  where a plain slice wins.
- **Trees** — binary search trees, heaps, and the shapes behind priority
  queues.
- **Graphs** — traversal, shortest paths, and the algorithms behind
  schedulers and dependency graphs.
- **Sorting and searching** — the classics and their trade-offs, measured
  against Go's own `slices` package.
- **Practice, the interview-shaped kind** — a set of problems solved and
  tested in Go, not in pseudocode.

This is the working list; it firms up as the days are written.
