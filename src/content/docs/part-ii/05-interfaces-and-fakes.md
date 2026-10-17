---
title: Interfaces and fakes
day: 6
time: "2.5 hours"
description: Give the store a name for what it must do, then build a stand-in that can fail on command.
sidebar:
  order: 5
---

The store works. It holds tasks, lists them, marks them done, and its tests pass. But there is one kind of failure it cannot show us: a task that exists and still refuses to complete.

Real stores fail that way. A file cannot be written, a connection drops, a disk fills up. To test how the code behaves on those days, we need a stand-in store that fails on command — and a way to say "any store with these six abilities will do", so the code under test never cares which store it was handed.

The name for a list of abilities is an **interface**. The name for a store built only for a test is a **fake**. Together they let us write `CompleteAll`, a function that completes a batch of tasks, keeps going when some of them fail, and reports everything that went wrong.

## The test that needs a stand-in

`CompleteAll` will take a store and a list of task IDs. It should try every ID, even after a failure, and report all the failures at the end. That promise — finish what you can — is what we test first.

The test below rigs three IDs. ID 1 exists and should complete. ID 2 exists, but the store is told to fail on it. ID 3 does not exist at all. When the call returns, task 1 must be done despite both failures. Append this to `store/store_test.go`:

<!-- verify: store/store_test.go at=store-interface -->
```go title="store/store_test.go"
func TestCompleteAll(t *testing.T) {
	errBoom := errors.New("disk on fire")
	s := &fakeStore{
		MemoryStore:  NewMemoryStore(),
		failComplete: map[int]error{2: errBoom},
	}
	s.Add(task.Task{Title: "write tests", Status: "Todo"})
	s.Add(task.Task{Title: "make them pass", Status: "Todo"})

	// id 2 is scripted to fail, id 3 does not exist, and id 1 must complete
	// despite both: a failure does not stop the batch.
	err := CompleteAll(s, []int{1, 2, 3})
	if err == nil {
		t.Fatalf("CompleteAll error = nil, want joined errors")
	}
	if !errors.Is(err, errBoom) {
		t.Errorf("CompleteAll error = %v, want an error matching %v", err, errBoom)
	}
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("CompleteAll error = %v, want an error matching ErrNotFound", err)
	}

	list := s.List()
	wantStatuses := []string{"Done", "Todo"}
	if len(list) != len(wantStatuses) {
		t.Fatalf("List() length = %d, want %d", len(list), len(wantStatuses))
	}
	for i, want := range wantStatuses {
		if list[i].Status != want {
			t.Errorf("after CompleteAll, List()[%d].Status = %q, want %q", i, list[i].Status, want)
		}
	}
}
```

Read it from the top. `errBoom` is a made-up failure — "disk on fire" — created just for this test. The `fakeStore` is told to hand back that error whenever someone completes task 2. Then two tasks are added, so they get IDs 1 and 2.

The call asks to complete 1, 2, and 3. Three things are checked afterwards: the returned error is not nil; that single error matches both `errBoom` and `ErrNotFound`; and the final list shows task 1 done with task 2 still waiting. That last check is the whole point — a failure on one ID must not stop another.

Two names in the test do not exist yet: `CompleteAll` and `fakeStore`. That is on purpose. We build the stand-in next, and the real function after that.

## A stand-in that fails on command

Think of a stunt double. A film needs a dangerous scene, so someone who looks enough like the star steps in and does what the star cannot do on camera. The camera does not care who is inside the costume.

Our test needs the same trick. The real store fails only for a missing ID, and that is not the failure we want to study. So we write a small double in the test file: it behaves exactly like `MemoryStore` except for the IDs the test chooses to break. Append it to `store/store_test.go`:

<!-- verify: store/store_test.go at=store-interface -->
```go title="store/store_test.go"
// fakeStore inherits the real behavior from MemoryStore and scripts failures
// for chosen ids — simulating errors the real store cannot produce.
type fakeStore struct {
	*MemoryStore
	failComplete map[int]error
}

func (f *fakeStore) Complete(id int) error {
	if err, ok := f.failComplete[id]; ok {
		return err
	}
	return f.MemoryStore.Complete(id)
}
```

The first line inside the struct is the odd one: `*MemoryStore`, alone, with no field name. This is called **embedding** — the whole memory store is tucked inside the fake, and all of its methods answer for the fake too. That is why `fakeStore` can `Add`, `List`, and do everything else without a single line of extra code.

One method is not borrowed. Writing `Complete` on `fakeStore` replaces the embedded one, and the replacement checks the `failComplete` map first: if the test scripted an error for that ID, hand it back. Otherwise `f.MemoryStore.Complete(id)` calls the real method, so unscripted IDs behave exactly like the real store — including the genuine `ErrNotFound` for ID 3.

That difference is the whole fake: one map, one method. Small enough to hold in your head, which is what a good stand-in should be.

## A test for the days when nothing fails

The other end of the promise needs a test too: when every ID completes, the error must be nil. Without that check, a function that always added a complaint to the report could still pass the noisy test — the real failures would be in there too. Append this one as well:

<!-- verify: store/store_test.go at=store-interface -->
```go title="store/store_test.go"
func TestCompleteAll_AllOK(t *testing.T) {
	s := NewMemoryStore()
	s.Add(task.Task{Title: "write tests", Status: "Todo"})
	s.Add(task.Task{Title: "make them pass", Status: "Todo"})

	if err := CompleteAll(s, []int{1, 2}); err != nil {
		t.Fatalf("CompleteAll error = %v, want nil", err)
	}

	list := s.List()
	wantStatuses := []string{"Done", "Done"}
	if len(list) != len(wantStatuses) {
		t.Fatalf("List() length = %d, want %d", len(list), len(wantStatuses))
	}
	for i, want := range wantStatuses {
		if list[i].Status != want {
			t.Errorf("after CompleteAll, List()[%d].Status = %q, want %q", i, list[i].Status, want)
		}
	}
}
```

This test uses the real store, no fake. Both tasks must end up done, and the call must return nil; the statuses are checked in order, because `List` hands tasks back in the order they were added. Between the two tests, both directions are covered: failures are collected when they happen, and a clean run reports nothing. Notice also that the fake and the real store are used in exactly the same way — that is the shape of what comes next.

## Run it and watch it fail

Run the tests from the app's root, the folder that holds `go.mod`:

```bash
$ go test ./...
# todo/store [todo/store.test]
store/store_test.go:271:9: undefined: CompleteAll
store/store_test.go:299:12: undefined: CompleteAll
FAIL	todo/store [build failed]
ok  	todo/task	(cached)
FAIL
```

Go refuses to build the store's tests because two tests call a function that does not exist. Your line numbers may differ — they depend on where in your file the tests landed — but the name is the point: `undefined: CompleteAll`. The `task` package says `(cached)`, which means nothing there changed since the last run. And notice what Go did *not* complain about: the fake compiled fine.

## Name the contract: the Store interface

Now the socket. A wall socket does not know what will be plugged into it. A lamp, a phone charger, a kettle — if the plug fits, it works. The socket describes only the shape of the plug.

An interface in Go is that description, written as a list of methods. Any type with those methods fits — the list works like a **contract**, saying what every store promises to do. When a type has every method on the list, we say it **satisfies** the interface — or, in the words the compiler uses, that it implements it.

The interface below names the six things our app asks of a store. In `store/store.go`, above the `MemoryStore` struct and its comment, add:

<!-- verify: store/store.go at=store-interface -->
```go title="store/store.go"
// Store is the persistence contract the rest of the application depends on.
type Store interface {
	Add(t task.Task) task.Task
	List() []task.Task
	ByStatus(status string) []task.Task
	CountByTag() map[string]int
	SortByDue() []task.Task
	Complete(id int) error
}

// MemoryStore is one implementation of Store.
var _ Store = (*MemoryStore)(nil)
```

Nothing new is implemented here — these are the six methods `MemoryStore` already has, gathered under one name. The line below the interface is a claim we ask the compiler to check: `*MemoryStore` fits the `Store` socket. The `_` means "we don't need to keep this value"; the value is a nil pointer, and no method is ever called on it. If a method were missing or misspelled, the build would stop right here, next to the type that needs fixing.

The `*` in front of `MemoryStore` matters. Every one of the six methods is written to work on a pointer (`func (s *MemoryStore) ...`), so the methods belong to `*MemoryStore`, not to a plain `MemoryStore` value. The assertion spells the pointer out for that reason.

And here is the best part: `fakeStore` never mentions `Store` anywhere. It fits the same socket anyway — five of the six methods come from the embedded `MemoryStore`, and `Complete` is written on the fake itself. Two very different types, one socket.

## Complete every ID, best effort

Now the function itself. Below `Complete`, add:

<!-- verify: store/store.go at=store-interface -->
```go title="store/store.go"
// CompleteAll completes every id, best-effort, and returns the joined errors of
// the operations that failed (nil when all succeed).
func CompleteAll(s Store, ids []int) error {
	var errs []error
	for _, id := range ids {
		if err := s.Complete(id); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
```

The parameter `s` has the type `Store` — the socket. Any value with the six methods fits, so the test can hand over a `*fakeStore` and this function will not notice. `errs` starts empty. The loop tries every ID and collects the failures instead of returning at the first one. `errors.Join` packs them into a single error, or returns nil when nothing failed. The `errors` package is already imported for `ErrNotFound`, so no import line moves.

There is no early exit, and that is the point: **best effort**. A failure on one ID never stops the others, and the caller gets one report describing everything that went wrong.

Run the tests:

```bash
$ go test ./...
ok  	todo/store	0.002s
ok  	todo/task	(cached)
```

Both packages pass. The store's tests now cover both kinds of day: the good one in `TestCompleteAll_AllOK`, and the bad one — a scripted failure, a missing task, and a task that still completes — in `TestCompleteAll`.

## Read the package back

One command shows what the package now offers to the rest of the app. From the app's root:

```bash
$ go doc ./store
package store // import "todo/store"

Package store keeps tasks in memory.

var ErrNotFound = errors.New("task not found")
func CompleteAll(s Store, ids []int) error
type MemoryStore struct{ ... }
    func NewMemoryStore() *MemoryStore
type Store interface{ ... }
```

There it is: the new function, the `Store` interface, and `MemoryStore` with its constructor. The package comment still says "keeps tasks in memory" — true for now. A second store joins the app later in the book, and that sentence will get a small update then.

## If something went wrong

**`cannot use MemoryStore{} ... (method Add has pointer receiver)`.** You wrote the assertion with a plain value instead of a pointer:

```text
# todo/store [todo/store.test]
store/store.go:28:15: cannot use MemoryStore{} (value of struct type MemoryStore) as Store value in variable declaration: MemoryStore does not implement Store (method Add has pointer receiver)
FAIL	todo/store [build failed]
ok  	todo/task	(cached)
FAIL
```

The six methods belong to `*MemoryStore`, so a plain `MemoryStore` value has none of them. Change the line to `var _ Store = (*MemoryStore)(nil)`, as shown above. The message's "pointer receiver" means the method was written on the pointer type. It names only the first missing method — the other five are missing too.

**`*polyfillStore does not implement Store (missing method Add)`.** This one comes from a fake that keeps the store as a named field instead of embedding it:

```go
type polyfillStore struct {
	mem MemoryStore
}
```

A named field does not bring the store's methods along — only embedding does. So the fake fails the compiler's check:

```text
# todo/store [todo/store.test]
store/store_test.go:336:24: cannot use s (variable of type *polyfillStore) as Store value in argument to CompleteAll: *polyfillStore does not implement Store (missing method Add)
FAIL	todo/store [build failed]
FAIL
```

Write `*MemoryStore` on its own line, with no field name, and override only the method the test scripts.

**The test fails after you write `CompleteAll` with an early return.** If the loop hands back the first error instead of collecting every failure:

```go
for _, id := range ids {
	if err := s.Complete(id); err != nil {
		return err
	}
}
return nil
```

then the first failure comes home alone, and the test complains:

```text
--- FAIL: TestCompleteAll (0.00s)
    store_test.go:279: CompleteAll error = disk on fire, want an error matching ErrNotFound
FAIL
FAIL	todo/store	0.002s
ok  	todo/task	0.001s
FAIL
```

An untouched package answers from Go's test cache: `todo/task` did not change
here, so your run may print `(cached)` where this one shows a time.

"Disk on fire" came back by itself, and the ID 3 failure was never reached, so the error cannot match `ErrNotFound`. Collect the failures and join them at the end, as shown above.

<details>
<summary>Going deeper: why does the assertion spell out a pointer?</summary>

Methods written on a pointer belong to the pointer type. All six `MemoryStore` methods are written that way, so `*MemoryStore` fits `Store` and a plain value does not. The assertion `var _ Store = (*MemoryStore)(nil)` is checked by the compiler and then thrown away — the nil is never used.

Careful with the same trick elsewhere. If a `Store` variable holds a nil `*MemoryStore` and you call a method, the call reaches a receiver with no store behind it, and the program crashes with `invalid memory address or nil pointer dereference`. An interface holding a nil pointer is not a nil interface: the type half is filled in, so Go believes the value is real. That is why functions in this book accept interfaces but return concrete types — nilness stays visible at the boundary.

</details>

<details>
<summary>Going deeper: one method is often enough</summary>

The best interfaces in Go are small. The standard library's `io.Writer` has exactly one method, `Write`, and everything that can receive bytes uses it — files, network connections, terminals. `fmt.Fprintf` writes to any of them without knowing which one it has.

The community rule of thumb is that a bigger interface is a weaker promise, and the matching habit is: accept interfaces, return structs. `CompleteAll` accepts `Store`, while `NewMemoryStore` still returns the concrete `*MemoryStore`, so callers keep every method visible. `CompleteAll` uses only one of the six methods, so it could even declare its own one-method interface — but this project keeps one shared `Store` so that every store is held to the same list.

</details>

<details>
<summary>Going deeper: fakes, stubs, and mocks</summary>

In plain terms: a *stub* answers with canned data; a *fake* is a working implementation with a shortcut; a *mock* checks how it was called. `fakeStore` is a fake — everything the test does not script runs the real `MemoryStore`. The label matters less than the cost: pick the cheapest stand-in that keeps the test honest. Ours is a struct, a map, and one method, all in the test file.

</details>

<details>
<summary>Going deeper: what the joined error really contains</summary>

`errors.Join` collects its arguments into one value. Its message is each error's message, in order, one per line — first `disk on fire`, then `complete task 3: task not found`. It returns nil when nothing failed, which is why the all-OK path needs no special case, and it never merges duplicates: two failures are two facts, even with identical text.

The joined value keeps every error inside it, and `errors.Is` searches that whole set. That is why one returned error can match both `errBoom` and `ErrNotFound` in the test. Joining zero errors, or only nil values, gives back nil.

</details>

Next, the app grows a layout that can hold several packages and a command-line program — and the store we just named comes along.
