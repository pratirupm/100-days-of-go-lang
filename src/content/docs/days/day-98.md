---
title: "Day 98 — Practice, interview-shaped"
description: "Solve two-sum, balanced brackets, and top-k in Go, and explain the cost of each answer before writing it. — Day 98 of 100 Days of Go Lang."
sidebar:
  order: 98
chapter: 83
---

**About 3 hours** · Part XVI, day 8 of 9.

**You'll be able to:**

- solve two-sum, balanced brackets, and top-k in Go;
- explain the cost of each answer before writing it.

---

An interview problem is a small excuse to choose a structure. The useful
habit is to say the cost first: "one pass with a map, O(n) time and O(n)
space" or "a stack, O(n) time and O(n) space". Then the code is the proof, not
the exploration.

Today we solve three problems that map to the last seven days: a hash lookup,
a stack, and a heap.

## Two-sum

Given a slice of ints and a target, return the indices of two values that add
to the target. The naive answer is a double loop, O(n^2). The better answer
walks once and remembers what it has seen:

<!-- verify: internal/dsa/practice.go at=dsa-practice -->
```go title="internal/dsa/practice.go"
func TwoSum(nums []int, target int) (int, int, bool) {
	seen := make(map[int]int, len(nums))
	for i, v := range nums {
		if j, ok := seen[target-v]; ok {
			return j, i, true
		}
		seen[v] = i
	}
	return 0, 0, false
}
```

The map is from value to index. At each value, check whether the complement is
already in the map; if it is, the pair is found. The cost is O(n) time and
O(n) space. The single pass is why the duplicate `3 + 3 = 6` case works: the
second 3 sees the first 3 in the map.

The return `(int, int, bool)` is the Go shape for "maybe no pair". A caller
that ignores the bool reads `0, 0`, which is a valid pair only if the input
has two zeros at those indices; the bool is the contract.

## Balanced brackets

Given a string of `()[]{}`, report whether every bracket closes in the right
order. A counter per type is not enough: `([)]` has balanced counts and the
wrong order. The stack remembers the opens:

<!-- verify: internal/dsa/practice.go at=dsa-practice -->
```go title="internal/dsa/practice.go"
func ValidParentheses(s string) bool {
	pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}
	var stack []rune
	for _, r := range s {
		switch r {
		case '(', '[', '{':
			stack = append(stack, r)
		case ')', ']', '}':
			if len(stack) == 0 || stack[len(stack)-1] != pairs[r] {
				return false
			}
			stack = stack[:len(stack)-1]
		}
	}
	return len(stack) == 0
}
```

The map says which open matches each close. A close with an empty stack, or a
close whose top does not match, is invalid. At the end, an unmatched open
leaves a non-empty stack. The cost is O(n) time and O(n) space in the worst
case — a string of all opens.

The code ignores non-bracket characters. That is deliberate for this problem;
a parser for a real language would have more cases. The stack is the reusable
idea.

## Top-k

Given a slice of ints and k, return the k largest values in descending order.
Sorting the whole slice is O(n log n); a min-heap of size k is O(n log k):

<!-- verify: internal/dsa/practice.go at=dsa-practice -->
```go title="internal/dsa/practice.go"
func TopK(nums []int, k int) []int {
	if k <= 0 {
		return nil
	}
	h := NewMinHeap(func(a, b int) bool { return a < b })
	for _, v := range nums {
		h.Push(v)
		if h.Len() > k {
			_, _ = h.Pop()
		}
	}
	out := make([]int, 0, h.Len())
	for h.Len() > 0 {
		v, _ := h.Pop()
		out = append(out, v)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(out)))
	return out
}
```

The heap holds the k largest seen so far; its root is the smallest of them, so
a new value that is larger evicts the root. The final sort is O(k log k), which
is small when k is small. The cost is O(n log k) time and O(k) space.

An alternative is a quickselect partition, which is O(n) average and O(n^2)
worst case. The heap is predictable and easy to explain; the quickselect is
faster on average and harder to get right. For an interview, state both and
pick the one you can defend.

## Run the tests

```bash
$ go test -run 'TestTwoSum|TestValidParentheses|TestTopK' -v ./internal/dsa
=== RUN   TestTwoSum
--- PASS: TestTwoSum (0.00s)
=== RUN   TestValidParentheses
--- PASS: TestValidParentheses (0.00s)
=== RUN   TestTopK
--- PASS: TestTopK (0.00s)
PASS
ok  	todo/internal/dsa	0.002s
```

The tests cover the positive and negative cases: a pair and no pair, balanced
and unbalanced brackets, and a k that is smaller than the input. A test that
only covers the happy path is a demo, not a contract.

## The method

The pattern is the same for every problem:

1. Say the brute-force cost.
2. Name the structure that removes the repeated work.
3. Say the new cost and the space it spends.
4. Write the code.
5. Test the edges: empty input, one element, duplicates, no answer.

The structure is the answer. The code is the syntax.

## Test the edge, not the story

The happy path is the example in the prompt. The edge cases are where the
solution earns its keep: an empty slice, one element, duplicate values, a
target that matches no pair, k equal to zero, a string with an unmatched open.

The tests in this lesson cover the positive and negative cases because a
solution that only handles the example is a demo. In an interview, say the edge
cases before writing the code; in a review, ask for the test that would fail if
the edge were wrong.

## Say the cost out loud

Before the code, say "O(n) time, O(n) space" or "O(n log k) time, O(k) space".
The sentence forces the choice of structure and gives the interviewer
something to correct. A solution with the wrong cost is easier to redirect
before it is written.

The same habit works in a design review. The cost sentence is the interface
between the idea and the implementation.

## If something went wrong

- **Two-sum returns the same index twice** — the code checked the complement
  before inserting the current value, so it cannot match itself. If it does,
  the insertion order is wrong.
- **Brackets accepts `([)]`** — the stack top was not compared with the
  matching open. A count per type would also accept it.
- **Top-k returns the smallest values** — the heap is a max-heap or the final
  sort is ascending. Check both.
- **Top-k panics on k > n** — the heap simply holds all n values; the result
  is the whole slice. Decide whether that is an error or a valid answer.

<details>
<summary>Going deeper: the interview is a conversation</summary>

The interviewer is not only checking whether the code runs. They are checking
whether you can state an assumption, choose a structure, and hear a hint. A
solution you can explain is worth more than a clever one you cannot.

The same is true in a code review. "I used a map because the lookup is O(1) and
the input is large" is a reviewable sentence. "I used a map" is not. The cost
sentence is the design; the code is the evidence.

</details>

Three problems, three structures. The last lesson puts them together in a
cache and asks how to choose in the first place.

<div class="day-tracker" data-day="98"></div>
