---
title: Tasks over HTTP
day: 37
time: "3 hours"
description: Five routes that read, create, change, and remove tasks — with validation, one error shape, and a version that refuses stale writes.
sidebar:
  order: 31
---

The server from the last lesson answers two questions: is the process up, and can it reach the store. It cannot yet do the app's real job — hold tasks. Today it learns.

Five routes join the `/api/v1` group. They list the tasks, create one, read one, change one, and remove one. HTTP has a word for each move: `GET` reads, `POST` creates, `PATCH` changes, `DELETE` removes. Together the four moves are called **CRUD** — create, read, update, delete — and nearly every web API is shaped like this.

Two promises hold the surface together. Every request is checked before it reaches the store, and every failure leaves as the same JSON object, whatever went wrong. And every change carries the version it read, so a write whose task moved on is refused instead of erasing someone else's work.

By the end, you can point `curl` at the server and watch all of it happen: a task created, changed, refused once for a stale version, and removed.

## Five routes, and the numbers that answer them

The five routes are the same moves the command-line app already makes, in HTTP's spelling. `GET /api/v1/tasks` lists the tasks inside an object whose `tasks` key holds the array. `POST /api/v1/tasks` creates one from a title, a priority, a due date, and labels. `GET /api/v1/tasks/:id` reads one task; `PATCH /api/v1/tasks/:id` changes the fields it names; `DELETE /api/v1/tasks/:id` removes it. The `:id` part names which task the request is about.

Every answer opens with a **status code** — a number that says how the request went. A 2xx means it worked, a 4xx means the request was the problem, and a 5xx means the server was. The routes use 200 for a read, 201 with a `Location` header for a create, and 204 for a delete.

The codes also keep two kinds of failure apart: a request that did not parse is a 400, and one that parsed but broke a rule is a 422. A box at the end of the lesson walks the whole table.

The bodies have one shape of their own: a task on the wire is the same object the CLI's `--json` output already writes — id, title, status, priority, due, labels, and version — in a type of its own, so the app can change inside without changing what clients see.

## The tests come first

The store has a shared suite — the same cases run against the memory store and the database store — and it grows seven: `Get`, `Update`, `UpdateStaleVersion`, `UpdateMissing`, `Delete`, `DeleteStaleVersion`, and `DeleteMissing`. The names are the contract: every store must read one task back, replace one, remove one, and tell two failure kinds apart — a task that is gone (`ErrNotFound`) and a snapshot that is stale (`ErrConflict`).

The `Get` case has the shape all seven share:

<!-- verify: internal/store/storetest/suite.go at=task-endpoints -->
```go title="internal/store/storetest/suite.go"
	t.Run("Get", func(t *testing.T) {
		s := newStore(t)
		added := addAll(t, s,
			task.Task{Title: "write tests", Status: task.StatusTodo, Priority: task.PriorityMax, Due: due(1), Tags: []string{"go", "book"}},
			task.Task{Title: "review code", Status: task.StatusDone},
		)

		got, err := s.Get(context.Background(), added[0].ID)
		require.NoError(t, err)
		if diff := cmp.Diff(canonical(added[0]), canonical(got)); diff != "" {
			t.Errorf("Get() mismatch (-want +got):\n%s", diff)
		}

		// The returned task is a copy, its tags included: overwriting both
		// must not reach the store's own state.
		got.Title = "mutated"
		got.Tags[0] = "mutated"
		fresh, err := s.Get(context.Background(), added[0].ID)
		require.NoError(t, err)
		assert.Equal(t, "write tests", fresh.Title)
		assert.Contains(t, fresh.Tags, "go")

		_, err = s.Get(context.Background(), missingID)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.Contains(t, err.Error(), "get task "+missingID.String())
	})
```

It seeds two tasks, reads one back, and compares it with what `Add` returned. Then it overwrites the title and a label on the task it read, and reads again: the store must have handed out a copy, so the changes never reach its own state. Last, it asks for a fixed id no store holds and pins the miss: `ErrNotFound`, naming the operation.

The finished app's appendix holds the whole suite file; the `Get` case above is the one that carries the idea. Read the other six cases there as you type, and add them one at a time.

The API's tests are new, in `internal/api/tasks_test.go`: seventeen cases that drive the routes through echo's own `ServeHTTP` — no socket, no port — against a real memory store. One helper sends every request:

<!-- verify: internal/api/tasks_test.go at=task-endpoints -->
```go title="internal/api/tasks_test.go"
// send drives one request through the handler without a socket. A non-empty
// body is sent as application/json, the content type every JSON body case
// needs; the content-type case builds its own request instead.
func send(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
```

**Validation** is the name for checking a request before acting on it, and the 422 contract gets one table, a row per rule, each asserting the exact body and that the store is still empty:

<!-- verify: internal/api/tasks_test.go at=task-endpoints -->
```go title="internal/api/tasks_test.go"
	tests := []struct {
		name  string
		body  string
		field string
		want  string
	}{
		{name: "missing title", body: `{}`, field: "title", want: "cannot be empty"},
		{name: "no body at all", body: "", field: "title", want: "cannot be empty"},
		{name: "blank title", body: `{"title":"   "}`, field: "title", want: "cannot be empty"},
		{name: "title too long", body: `{"title":"` + strings.Repeat("x", 201) + `"}`, field: "title", want: "must be at most 200 characters"},
		{name: "priority too low", body: `{"title":"write tests","priority":0}`, field: "priority", want: "must be at least 1"},
		{name: "priority too high", body: `{"title":"write tests","priority":6}`, field: "priority", want: "must be at most 5"},
		{name: "empty tag", body: `{"title":"write tests","tags":["go",""]}`, field: "tags", want: "must not contain empty tags"},
	}
```

<!-- verify: internal/api/tasks_test.go at=task-endpoints -->
```go title="internal/api/tasks_test.go"
			rec := send(t, e, http.MethodPost, "/api/v1/tasks", tt.body)

			require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
			assert.Equal(t, "application/json", rec.Header().Get("Content-Type"))
			assert.JSONEq(t,
				errorJSON("validation_failed", "validation failed", fieldJSON(tt.field, tt.want)),
				rec.Body.String())
```

The messages come from two places — the rules marked on the request shape and the domain's own checks — and the client cannot tell them apart. One shape, one code.

The filters get a table too, over a status, a label, and a label nothing carries, plus one case that pins the collection shape:

<!-- verify: internal/api/tasks_test.go at=task-endpoints -->
```go title="internal/api/tasks_test.go"
	tests := []struct {
		name   string
		target string
		want   []string
	}{
		{name: "no filter", target: "/api/v1/tasks", want: []string{"write tests", "review code", "ship it"}},
		{name: "by status", target: "/api/v1/tasks?status=Todo", want: []string{"write tests", "ship it"}},
		{name: "by done status", target: "/api/v1/tasks?status=Done", want: []string{"review code"}},
		{name: "by tag", target: "/api/v1/tasks?tag=go", want: []string{"write tests", "review code"}},
		{name: "nothing matches", target: "/api/v1/tasks?tag=urgent", want: []string{}},
	}
```

<!-- verify: internal/api/tasks_test.go at=task-endpoints -->
```go title="internal/api/tasks_test.go"
		assert.JSONEq(t, tasksJSON(
			taskJSON(first.ID.String(), "write tests", "Todo", 3, `"2026-11-05T00:00:00Z"`, `["go","book"]`, 1),
			taskJSON(second.ID.String(), "ship it", "Todo", 1, "null", "[]", 1),
		), rec.Body.String())
```

The finished app's appendix holds the whole test file; the pieces above are the ones that carry the idea. Read the rest there as you type, and add the cases one at a time.

Now run the tests and watch two kinds of failure arrive at once:

```bash
$ go test -count=1 ./...
# todo/internal/store/storetest [todo/internal/store.test]
internal/store/storetest/suite.go:159:17: s.Get undefined (type "todo/internal/store".Store has no field or method Get)
internal/store/storetest/suite.go:169:19: s.Get undefined (type "todo/internal/store".Store has no field or method Get)
internal/store/storetest/suite.go:174:14: s.Get undefined (type "todo/internal/store".Store has no field or method Get)
internal/store/storetest/suite.go:196:20: s.Update undefined (type "todo/internal/store".Store has no field or method Update)
internal/store/storetest/suite.go:264:24: too many errors
...
FAIL	todo/internal/api	0.010s
FAIL	todo/internal/store [build failed]
FAIL	todo/internal/store/storetest [build failed]
FAIL
```

The first is the compiler: the suite names `Get`, `Update`, and `Delete` on the store, and the store has none of them yet. The second is the better one: the API tests compile — they name routes and bodies, never handler names — and fail on what the server does. Every task route answers 404, with echo's own `{"message":"Not Found"}` — exactly the shape this lesson replaces.

## The store learns three moves

The interface grows first, three methods beside the ones the app already has:

<!-- verify: internal/store/store.go at=task-endpoints -->
```go title="internal/store/store.go"
type Store interface {
	Add(ctx context.Context, t task.Task) (task.Task, error)
	Get(ctx context.Context, id uuid.UUID) (task.Task, error)
	List(ctx context.Context) ([]task.Task, error)
	ByStatus(ctx context.Context, status task.Status) ([]task.Task, error)
	ByTag(ctx context.Context, tag string) ([]task.Task, error)
	CountByTag(ctx context.Context) (map[string]int, error)
	Tags(ctx context.Context) ([]string, error)
	SortByDue(ctx context.Context) ([]task.Task, error)
	Complete(ctx context.Context, id uuid.UUID, version int) error
	Update(ctx context.Context, t task.Task) (task.Task, error)
	Delete(ctx context.Context, id uuid.UUID, version int) error
	Stats(ctx context.Context) (Stats, error)
}
```

`Get` returns one task with its labels. `Update` replaces the task at the version the argument carries, and `Delete` removes the task at the version the caller read. Both are the compare-and-swap `Complete` already uses: the version travels in, the store writes only while it still matches, and a snapshot that moved on fails with `ErrConflict`.

The database needs three new statements, in `internal/db/queries/tasks.sql`:

<!-- verify: internal/db/queries/tasks.sql at=task-endpoints -->
```sql title="internal/db/queries/tasks.sql"
-- Replaces every mutable column of the task and reports how many rows
-- changed, which is how the store tells a hit from a miss or a stale
-- version. The WHERE clause pins the version the caller read and the SET
-- clause bumps it, so the compare and the write are one statement; the
-- update is written as a full replacement because that is what the caller
-- hands back: the snapshot it read, with the fields it meant to change
-- changed.
-- name: UpdateTask :execrows
UPDATE tasks
SET title = ?, status = ?, priority = ?, due = ?, version = version + 1
WHERE id = ? AND version = ?;

-- Deletes the task and reports how many rows changed, which is how the store
-- tells a hit from a miss or a stale version: the WHERE clause pins the
-- version the caller read, so a delete whose snapshot moved on removes
-- nothing. The task's tag rows go with the task through task_tags' ON DELETE
-- CASCADE, which is on because the store's connections turn foreign keys on.
-- name: DeleteTask :execrows
DELETE FROM tasks
WHERE id = ? AND version = ?;

-- Deletes every tag of the task. Update calls it before inserting the tag
-- set the caller handed in, so an update replaces the tags instead of
-- merging them: a tag the caller dropped has to disappear.
-- name: DeleteTaskTags :exec
DELETE FROM task_tags
WHERE task_id = ?;
```

`UpdateTask` writes every field a caller can change and bumps the version: `WHERE id = ? AND version = ?` is the compare, `SET ... version = version + 1` is the swap, and the two are one statement, so no writer can slip between them. `DeleteTask` is the same compare with the row itself as the target. `DeleteTaskTags` makes an update replace the labels instead of merging them: the old rows are dropped and the caller's labels inserted, in one transaction.

Two generator directives sit in `internal/store/store.go`, and their order is on purpose:

<!-- verify: internal/store/store.go at=task-endpoints -->
```go title="internal/store/store.go"
// The sqlc directive sits above the moq one on purpose: moq type-checks the
// package it mocks, and that package contains the generated sqlc code, so a
// query change that breaks the generated types has to be regenerated before
// moq runs. Directives run in the order they appear in the file.
//
//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f ../../sqlc.yaml

//go:generate go run github.com/matryer/moq@v0.8.0 -out store_moq_test.go . Store
```

The query generator goes first: the mock generator reads the store's package, and the store does not compile until the new query methods exist. While a query is changing, run the query generator on its own — `go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f sqlc.yaml` — and let `go generate ./...` follow once the stores are whole.

The memory store's three new methods need two helpers the store did not have. `findLocked` is the id lookup `Complete` used to run inline — moved to one place so the four methods that need it cannot drift apart. `copyTask` is how a read hands out what the store holds without handing out the store's own memory. Both live at the bottom of `internal/store/store.go`, beside `listLocked`:

<!-- verify: internal/store/store.go at=task-endpoints -->
```go title="internal/store/store.go"
// findLocked returns the index of the task with the given id, or -1 when the
// store holds none. The caller must hold mu; the helper never acquires it.
func (s *MemoryStore) findLocked(id uuid.UUID) int {
	for i, t := range s.tasks {
		if t.ID == id {
			return i
		}
	}
	return -1
}

// copyTask returns a task whose tags slice is its own. It is how the read
// methods hand out what they hold without handing out the store's own
// memory: the struct is a value already, and the slice is the one field that
// would still alias.
func copyTask(t task.Task) task.Task {
	t.Tags = slices.Clone(t.Tags)
	return t
}
```

`Complete` moves onto `findLocked` in the same change: its comment, its lock, and its checks stay, and the loop it used to carry inline becomes the helper:

<!-- verify: internal/store/store.go at=task-endpoints -->
```go title="internal/store/store.go"
func (s *MemoryStore) Complete(ctx context.Context, id uuid.UUID, version int) error {
	s.ops.Add(1)
	if err := ctxErr(ctx, "complete task"); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.findLocked(id)
	if i < 0 {
		return fmt.Errorf("complete task %s: %w", id, ErrNotFound)
	}
	if s.tasks[i].Version != version {
		return fmt.Errorf("complete task %s: %w", id, ErrConflict)
	}
	s.tasks[i].Status = task.StatusDone
	s.tasks[i].Version++
	return nil
}
```

`Get` uses both helpers under the read lock — the id lookup, then a copy whose label slice belongs to the caller:

<!-- verify: internal/store/store.go at=task-endpoints -->
```go title="internal/store/store.go"
func (s *MemoryStore) Get(ctx context.Context, id uuid.UUID) (task.Task, error) {
	s.ops.Add(1)
	if err := ctxErr(ctx, "get task"); err != nil {
		return task.Task{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	i := s.findLocked(id)
	if i < 0 {
		return task.Task{}, fmt.Errorf("get task %s: %w", id, ErrNotFound)
	}
	return copyTask(s.tasks[i]), nil
}
```

`Update` is the compare-and-swap in miniature. The lock covers the compare and the write together, so no snapshot can slip between them, and the version moves with the fields:

<!-- verify: internal/store/store.go at=task-endpoints -->
```go title="internal/store/store.go"
func (s *MemoryStore) Update(ctx context.Context, t task.Task) (task.Task, error) {
	s.ops.Add(1)
	if err := ctxErr(ctx, "update task"); err != nil {
		return task.Task{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.findLocked(t.ID)
	if i < 0 {
		return task.Task{}, fmt.Errorf("update task %s: %w", t.ID, ErrNotFound)
	}
	if s.tasks[i].Version != t.Version {
		return task.Task{}, fmt.Errorf("update task %s: %w", t.ID, ErrConflict)
	}
	t.Version++
	s.tasks[i] = copyTask(t)
	return t, nil
}
```

`Delete` is `Complete`'s shape with one difference: instead of moving the status, it removes the row with `slices.Delete`. Its two failures are the same wrapped pair:

<!-- verify: internal/store/store.go at=task-endpoints -->
```go title="internal/store/store.go"
func (s *MemoryStore) Delete(ctx context.Context, id uuid.UUID, version int) error {
	s.ops.Add(1)
	if err := ctxErr(ctx, "delete task"); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.findLocked(id)
	if i < 0 {
		return fmt.Errorf("delete task %s: %w", id, ErrNotFound)
	}
	if s.tasks[i].Version != version {
		return fmt.Errorf("delete task %s: %w", id, ErrConflict)
	}
	s.tasks = slices.Delete(s.tasks, i, i+1)
	return nil
}
```

The database store's `Update` writes the columns and the labels in one `BEGIN CONCURRENT` transaction:

<!-- verify: internal/store/turso.go at=task-endpoints -->
```go title="internal/store/turso.go"
	var n int64
	err := withConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		var err error
		n, err = q.UpdateTask(ctx, db.UpdateTaskParams{
			Title:    t.Title,
			Status:   string(t.Status),
			Priority: int64(t.Priority),
			Due:      dueSQL(t.Due),
			ID:       t.ID.String(),
			Version:  int64(t.Version),
		})
		if err != nil || n == 0 {
			return err
		}
		if err := q.DeleteTaskTags(ctx, t.ID.String()); err != nil {
			return err
		}
		for _, tag := range uniqueTags(t.Tags) {
			if err := q.InsertTag(ctx, db.InsertTagParams{TaskID: t.ID.String(), Tag: tag}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return task.Task{}, fmt.Errorf("update task %s: %w", t.ID, err)
	}
	if n == 0 {
		return task.Task{}, s.classifyWrite(ctx, "update task", t.ID)
	}
	t.Version++
	return t, nil
```

The compare rides in the statement, and so does the swap: the row moves to its next version as it is written, and the label rewrite happens in the same transaction, so no reader ever sees a task without its labels. When zero rows change, one question is left open — is the task gone, or is the snapshot stale? One helper answers it for all three writes:

<!-- verify: internal/store/turso.go at=task-endpoints -->
```go title="internal/store/turso.go"
func (s *TursoStore) classifyWrite(ctx context.Context, op string, id uuid.UUID) error {
	_, err := s.queries.GetTask(ctx, id.String())
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return fmt.Errorf("%s %s: %w", op, id, ErrNotFound)
	case err != nil:
		return fmt.Errorf("%s %s: %w", op, id, err)
	default:
		return fmt.Errorf("%s %s: %w", op, id, ErrConflict)
	}
}
```

`Complete` had that switch inline; the same change replaces its tail with one call:

<!-- verify: internal/store/turso.go at=task-endpoints -->
```go title="internal/store/turso.go"
	...
	if n > 0 {
		return nil
	}
	return s.classifyWrite(ctx, "complete task", id)
}
```

The probe runs after the failed write, and its order is the contract: a task that is gone is a miss even when the version is stale too — re-reading a missing task is pointless, and re-reading a conflicting one is exactly the retry. All three writes share the helper, so every store reports the same sentences.

Now the generators. `go generate ./...` does not work by itself yet: it reaches the api package before the store's, and the api mock type-checks the store package — which does not compile until sqlc has written the new query methods. So the query generator runs by hand first, and the full walk follows. From the app's root:

<!-- transcripts: authored -->
```bash
$ go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f sqlc.yaml
$ go generate ./...
```

Silence is success: sqlc rewrites the generated queries in place, the two test mocks are rewritten to carry the three new methods, and the store's package compiles again. Run the shared suite — `go test -count=1 -v -run TestStoreConformance ./internal/store` — against both stores:

```bash
        --- PASS: TestStoreConformance/MemoryStore/Get (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/Update (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/UpdateStaleVersion (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/UpdateMissing (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/Delete (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/DeleteStaleVersion (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/DeleteMissing (0.00s)
        ...
        --- PASS: TestStoreConformance/TursoStore/Get (0.00s)
        --- PASS: TestStoreConformance/TursoStore/Update (0.00s)
        --- PASS: TestStoreConformance/TursoStore/UpdateStaleVersion (0.00s)
        --- PASS: TestStoreConformance/TursoStore/UpdateMissing (0.00s)
        --- PASS: TestStoreConformance/TursoStore/Delete (0.00s)
        --- PASS: TestStoreConformance/TursoStore/DeleteStaleVersion (0.00s)
        --- PASS: TestStoreConformance/TursoStore/DeleteMissing (0.00s)
        ...
PASS
ok  	todo/internal/store	0.099s
```

Both stores pass the same seven new cases, and the suite is otherwise unchanged. That is what makes it a proof: the store grew three abilities, and every promise it already made still holds.

## The shapes the API speaks

The wire has its own types, in `internal/api/tasks.go`, beside the five functions that answer the routes. The create body is its own small type, with the rules written as backtick notes on the fields:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
type createTaskRequest struct {
	Title    string     `json:"title"`
	Priority *int       `json:"priority,omitempty" validate:"omitempty,min=1,max=5"`
	Due      *time.Time `json:"due,omitempty"`
	Tags     []string   `json:"tags,omitempty" validate:"tags"`
}
```

Three fields are optional, and the notes say what each must satisfy: a priority from 1 to 5, and labels that carry no empty string. The title is deliberately unmarked: the domain's constructor, `task.NewTask`, already trims it and checks its length, and the API must not disagree with the CLI about what a title is. A status is not accepted — a new task starts in Todo, like the CLI's `add`.

The change body carries the version the caller read plus any subset of the five fields that can change:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
type updateTaskRequest struct {
	Version  *int                `json:"version" validate:"required,min=1"`
	Title    *string             `json:"title,omitempty"`
	Status   *string             `json:"status,omitempty"`
	Priority *int                `json:"priority,omitempty" validate:"omitempty,min=1,max=5"`
	Due      optional[time.Time] `json:"due"`
	Tags     *[]string           `json:"tags,omitempty" validate:"omitempty,tags"`
}
```

Absent fields are left alone. The one exception is `due`: a JSON `null` there means "remove the date". A pointer cannot tell absent from null — `encoding/json` decodes both to `nil` — so `due` uses one small type that can:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
type optional[T any] struct {
	set   bool
	value *T
}

// UnmarshalJSON records that the field was present and decodes its value. A
// JSON null leaves the value nil, which is what "clear" means.
func (o *optional[T]) UnmarshalJSON(data []byte) error {
	o.set = true
	if string(data) == "null" {
		o.value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	o.value = &v
	return nil
}
```

`optional[T]` records whether the field was present while the body was decoded: `set` is false when the client did not mention it, and true with a nil value when the client sent `null` — the "clear it" case.

The answer's shape is the CLI's `--json` object in its own type:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
type taskResponse struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	Status   string     `json:"status"`
	Priority int        `json:"priority"`
	Due      *time.Time `json:"due"`
	Tags     []string   `json:"tags"`
	Version  int        `json:"version"`
}
```

The conversion owns the two null rules: labels always arrive as an array, and a task with no due date answers with `"due":null`:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
func newTaskResponse(t task.Task) taskResponse {
	r := taskResponse{
		ID:       t.ID.String(),
		Title:    t.Title,
		Status:   t.Status.String(),
		Priority: int(t.Priority),
		Tags:     t.Tags,
		Version:  t.Version,
	}
	if r.Tags == nil {
		r.Tags = []string{}
	}
	if !t.Due.IsZero() {
		due := t.Due
		r.Due = &due
	}
	return r
}
```

The collection answers with a small envelope, and its key is always an array:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
type taskListResponse struct {
	Tasks []taskResponse `json:"tasks"`
}

// taskResponses maps tasks to their wire form, always non-nil.
func taskResponses(tasks []task.Task) []taskResponse {
	out := make([]taskResponse, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, newTaskResponse(t))
	}
	return out
}
```

An empty store lists `{"tasks":[]}` — never null — and the envelope leaves room for pagination later without changing the shape of what is already there.

## The five handlers

The wiring in `internal/api/api.go` sets the two hooks and registers the five routes:

<!-- verify: internal/api/api.go at=task-endpoints -->
```go title="internal/api/api.go"
	e := echo.New()
	e.Validator = newRequestValidator()
	e.HTTPErrorHandler = s.handleError

	e.GET("/healthz", s.healthz)
	e.GET("/ready", s.ready)

	// ...
	g := e.Group("/api/v1")
	g.GET("/tasks", s.listTasks)
	g.POST("/tasks", s.createTask)
	g.GET("/tasks/:id", s.getTask)
	g.PATCH("/tasks/:id", s.updateTask)
	g.DELETE("/tasks/:id", s.deleteTask)
```

`e.Validator` is the checker every request goes through, and `e.HTTPErrorHandler` is the one place a failure becomes a response — both in a moment. The five routes hang off the group the last lesson created, and each route names a **handler**: the function that answers it.

The create handler binds, validates, then builds:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
func (s *server) createTask(c echo.Context) error {
	var req createTaskRequest
	if err := bindBody(c, &req); err != nil {
		return err
	}
	if err := c.Validate(&req); err != nil {
		return err
	}

	t, err := task.NewTask(req.Title)
	if err != nil {
		return err
	}
	if req.Priority != nil {
		t.Priority = task.Priority(*req.Priority)
	}
	if req.Due != nil {
		t.Due = req.Due.UTC()
	}
	t.Tags = req.Tags

	stored, err := s.store.Add(c.Request().Context(), t)
	if err != nil {
		return err
	}
	c.Response().Header().Set(echo.HeaderLocation, taskPath(stored.ID))
	return c.JSON(http.StatusCreated, newTaskResponse(stored))
}
```

Three steps in order: `bindBody` reads the JSON into the request type, `c.Validate` runs the marked rules, and `task.NewTask` builds the domain task — the same constructor the CLI uses, so the title rules cannot drift. The store assigns the id and the version, and the answer is 201 with a `Location` header.

The read handler is one store call:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
func (s *server) getTask(c echo.Context) error {
	id, err := taskID(c)
	if err != nil {
		return err
	}
	t, err := s.store.Get(c.Request().Context(), id)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newTaskResponse(t))
}
```

The change handler is where the request type, the domain, and the store meet. The read is the base of the merge:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
	ctx := c.Request().Context()
	merged, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if req.Title != nil {
		// The domain constructor is also the title rule: it trims and
		// checks the length, so the API and the CLI cannot drift.
		normalized, err := task.NewTask(*req.Title)
		if err != nil {
			return err
		}
		merged.Title = normalized.Title
	}
	if req.Status != nil {
		var status task.Status
		if err := status.UnmarshalText([]byte(*req.Status)); err != nil {
			return err
		}
		merged.Status = status
	}
```

Only the fields the body names are applied, and each rule comes from the domain: the title through `task.NewTask`, the status through the domain's own parser. The rest of the merge:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
	if req.Priority != nil {
		merged.Priority = task.Priority(*req.Priority)
	}
	if req.Due.set {
		// A present due is the client's answer either way: null clears the
		// date, a value sets it.
		merged.Due = time.Time{}
		if req.Due.value != nil {
			merged.Due = req.Due.value.UTC()
		}
	}
	if req.Tags != nil {
		merged.Tags = *req.Tags
	}
	merged.Version = *req.Version

	stored, err := s.store.Update(ctx, merged)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, newTaskResponse(stored))
```

The version the body carried is handed to `Update` unchanged. That is what makes a lost update impossible: if the task changed since the caller read it, the store refuses the write with `ErrConflict` instead of overwriting the newer state.

The delete handler parses its own query parameter, because the version is not a body field:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
func (s *server) deleteTask(c echo.Context) error {
	id, err := taskID(c)
	if err != nil {
		return err
	}
	version, err := strconv.Atoi(c.QueryParam("version"))
	if err != nil || version < 1 {
		return badRequest("version must be a positive integer")
	}
	if err := s.store.Delete(c.Request().Context(), id, version); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
```

The version rides the query string — `?version=3` — and a missing or unusable one is a 400 that names it. Success is 204, because the task is gone and there is nothing left to describe.

The list handler maps the two filters onto the store's own queries:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
func (s *server) listTasks(c echo.Context) error {
	ctx := c.Request().Context()
	status, tag := c.QueryParam("status"), c.QueryParam("tag")

	var (
		tasks []task.Task
		err   error
	)
	switch {
	case status != "" && tag != "":
		return badRequest("status and tag cannot be combined")
	case status != "":
		var st task.Status
		if err := st.UnmarshalText([]byte(status)); err != nil {
			return err
		}
		tasks, err = s.store.ByStatus(ctx, st)
	case tag != "":
		tasks, err = s.store.ByTag(ctx, tag)
	default:
		tasks, err = s.store.List(ctx)
	}
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, taskListResponse{Tasks: taskResponses(tasks)})
}
```

Both filters at once have no query behind them, so the combination is refused with a 400 instead of answering with one filter silently dropped. An unknown status goes through the domain's own parser, so the API cannot drift from the statuses the domain knows.

Three small helpers finish the file. `bindBody` keeps echo's binder and replaces one thing — the decoder's message, which names Go types the API does not otherwise expose:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
func bindBody(c echo.Context, dst any) error {
	if err := c.Bind(dst); err != nil {
		var he *echo.HTTPError
		if errors.As(err, &he) && he.Code == http.StatusBadRequest {
			return badRequest("invalid JSON body")
		}
		return err
	}
	return nil
}
```

and `taskID` turns the path's placeholder into a real id, refusing anything else with a 400. `taskPath` is its twin in the other direction — the path a create puts in `Location`:

<!-- verify: internal/api/tasks.go at=task-endpoints -->
```go title="internal/api/tasks.go"
func taskID(c echo.Context) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return uuid.Nil, badRequest("invalid task id")
	}
	return id, nil
}

// taskPath is the resource path of a task, the value of a create's Location
// header.
func taskPath(id uuid.UUID) string {
	return "/api/v1/tasks/" + id.String()
}
```

## Check the request, answer with one shape

The marked rules need a checker, and echo does not bring one: `c.Validate` consults `e.Validator`, and without one every validated request fails with "validator not registered" — a 500. The app adds the standard Go checker as one dependency — `go get github.com/go-playground/validator/v10@v10.30.5` — and builds it in `internal/api/validator.go`:

<!-- verify: internal/api/validator.go at=task-endpoints -->
```go title="internal/api/validator.go"
// requestValidator is the API's echo.Validator.
type requestValidator struct {
	validate *validator.Validate
}

// newRequestValidator builds the validator: a fresh go-playground instance
// with the two customizations the API needs.
func newRequestValidator() *requestValidator {
	v := validator.New()

	// A failure is reported under the name the client used, not the Go
	// field's: the DTOs' json tags are the wire spelling, and the
	// validator's default is the struct field's own name. The mapping is
	// what lets validationMessage's prose and the field entry agree with
	// the request that failed.
	v.RegisterTagNameFunc(func(field reflect.StructField) string {
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			return field.Name
		}
		return name
	})

	// RegisterValidation's only failure is an invalid tag name, and the
	// name is a constant here: a typo is a programming error that fails
	// every test run at construction, not a runtime condition to report.
	if err := v.RegisterValidation("tags", validateTags); err != nil {
		panic(fmt.Sprintf("api: register validator: %v", err))
	}
	return &requestValidator{validate: v}
}
```

The first customization makes every failure speak the wire's spelling: a problem is reported under the field name the client used, not the Go name. The second registers the app's own rule for a list of labels:

<!-- verify: internal/api/validator.go at=task-endpoints -->
```go title="internal/api/validator.go"
// validateTags accepts a []string whose elements are all non-empty. The rule
// fails once for the whole slice rather than once per element, which keeps
// the 422 body bounded by the DTO's shape instead of by the request's
// contents: a body with a thousand empty tags is still one field entry. It
// also gives the wire one sentence for "a tag must not be empty" instead of
// one per offending index.
func validateTags(fl validator.FieldLevel) bool {
	tags, ok := fl.Field().Interface().([]string)
	if !ok {
		return false
	}
	for _, tag := range tags {
		if tag == "" {
			return false
		}
	}
	return true
}
```

It fails the whole list once, not once per element, so a request with four empty labels comes back with one field entry instead of four. The 422 body stays the size of the request type, never the size of the request.

One method makes the type echo's checker: `c.Validate` calls it with the bound request, which it hands to the go-playground instance.

<!-- verify: internal/api/validator.go at=task-endpoints -->
```go title="internal/api/validator.go"
// Validate implements echo.Validator. c.Validate is the only caller: a
// handler binds the request into its DTO and hands the DTO here.
func (v *requestValidator) Validate(i any) error {
	return v.validate.Struct(i)
}
```

Handlers never write error responses; they return the error, and echo hands it to the one place that does — `handleError`, in `internal/api/error.go`. The body is flat:

<!-- verify: internal/api/error.go at=task-endpoints -->
```go title="internal/api/error.go"
type errorResponse struct {
	Code    string       `json:"code"`
	Message string       `json:"message"`
	Fields  []fieldError `json:"fields,omitempty"`
}

// fieldError is one field-level failure inside a 422.
type fieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}
```

`code` is the stable, machine-readable half: one token per failure class, safe for a client to branch on. `message` is prose, for people and logs, and may change. `fields` appears only on a 422, one entry per failed field, sorted by name so the same failure always renders the same bytes.

One function classifies an error into its status and body, and the order of its cases is the classification:

<!-- verify: internal/api/error.go at=task-endpoints -->
```go title="internal/api/error.go"
func errorResponseFor(err error) (int, errorResponse) {
	var (
		fieldErrors validator.ValidationErrors
		invalid     task.ValidationError
		he          *echo.HTTPError
	)
	switch {
	case errors.As(err, &fieldErrors):
		return http.StatusUnprocessableEntity, errorResponse{
			Code:    codeValidationFailed,
			Message: "validation failed",
			Fields:  validationFields(fieldErrors),
		}
	case errors.As(err, &invalid):
		// A rule the domain owns — the title's shape, the status
		// vocabulary — reported by the domain's own error type. The client
		// cannot tell this branch from the validator's: one shape, one
		// code.
		return http.StatusUnprocessableEntity, errorResponse{
			Code:    codeValidationFailed,
			Message: "validation failed",
			Fields:  []fieldError{{Field: invalid.Field, Message: invalid.Message}},
		}
	case errors.Is(err, store.ErrNotFound):
		return http.StatusNotFound, errorResponse{
			Code:    codeNotFound,
			Message: store.ErrNotFound.Error(),
		}
	case errors.Is(err, store.ErrConflict):
		return http.StatusConflict, errorResponse{
			Code:    codeConflict,
			Message: store.ErrConflict.Error(),
		}
	case errors.As(err, &he):
		return he.Code, errorResponse{Code: codeForStatus(he.Code), Message: httpErrorMessage(he)}
	default:
		return http.StatusInternalServerError, errorResponse{
			Code:    codeInternal,
			Message: "internal error",
		}
	}
}
```

Both validation shapes come first — the checker's failures and the domain's own — and both become the same 422. Then the store's sentinels: `ErrNotFound` is a 404, `ErrConflict` is a 409. Then echo's own error type, which already carries a status. Anything left is a bug: 500, with the error text kept in the process. The client gets `{"code":"internal_error","message":"internal error"}` while the log gets the real one:

<!-- verify: internal/api/error.go at=task-endpoints -->
```go title="internal/api/error.go"
func (s *server) handleError(err error, c echo.Context) {
	// A handler that already wrote a response owns it; rewriting it here
	// would corrupt the body.
	if c.Response().Committed {
		return
	}

	status, body := errorResponseFor(err)
	if status >= http.StatusInternalServerError {
		s.logger.Error("request failed",
			"method", c.Request().Method,
			"path", c.Request().URL.Path,
			"err", err)
	}
	if err := c.JSON(status, body); err != nil {
		s.logger.Error("error response failed", "err", err)
	}
}
```

Smaller pieces finish the file. Above the switch sit the error codes, one constant per failure class; `validationFields` renders the checker's failures as field entries, sorted by name; and `httpErrorMessage` reads the message off echo's own error type.

`validationMessage` turns a failed rule into a sentence like "must be at most 5", because the checker's own wording names Go fields and rule names. `codeForStatus` names the failure class of a status no case above classified — that is how echo's own 404 and 405 render in the same shape — and `badRequest` builds the 400s the handlers raise themselves.

## Try it on the wire

Run the API's tests — `go test -count=1 -v ./internal/api` — and watch every case pass: the seventeen new ones, and the four the server already had:

```bash
--- PASS: TestHealthz (0.00s)
--- PASS: TestReady_StoreDown (0.00s)
--- PASS: TestReady_OK (0.00s)
--- PASS: TestServer_StartShutdown (0.00s)
--- PASS: TestCreateTask (0.00s)
--- PASS: TestCreateTask_Validation (0.00s)
--- PASS: TestCreateTask_UnusableBody (0.00s)
--- PASS: TestListTasks (0.00s)
--- PASS: TestListTasks_FilterErrors (0.00s)
--- PASS: TestListTasks_StoreFailure (0.00s)
--- PASS: TestGetTask (0.00s)
--- PASS: TestUpdateTask (0.00s)
--- PASS: TestUpdateTask_ClearsDue (0.00s)
--- PASS: TestUpdateTask_ClearsTags (0.00s)
--- PASS: TestUpdateTask_Validation (0.00s)
--- PASS: TestUpdateTask_Conflict (0.00s)
--- PASS: TestUpdateTask_NotFound (0.00s)
--- PASS: TestDeleteTask (0.00s)
--- PASS: TestDeleteTask_Conflict (0.00s)
--- PASS: TestDeleteTask_BadVersion (0.00s)
--- PASS: TestUnknownRoute_ErrorShape (0.00s)
PASS
ok  	todo/internal/api	0.006s
```

Then start the server the way the last lesson showed — the binary in a scratch directory, `TODO_DB` and `TODO_LOG` inside it — on port `18081`:

<!-- transcripts: authored -->
```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ./todo-server --listen 127.0.0.1:18081 > stdout.txt 2> stderr.txt &
```

Every `curl` below uses that port. The create, and two requests a rule turns away:

```bash
$ curl -s -i -X POST -H 'Content-Type: application/json' -d '{"title":"write the chapter","priority":5,"due":"2026-11-05T00:00:00Z","tags":["go","book"]}' http://127.0.0.1:18081/api/v1/tasks
HTTP/1.1 201 Created
Content-Type: application/json
Location: /api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
Date: Thu, 15 Oct 2026 05:48:06 GMT
Content-Length: 165

{"id":"01a13e1a-818f-7690-816d-fe5a47ae507d","title":"write the chapter","status":"Todo","priority":5,"due":"2026-11-05T00:00:00Z","tags":["go","book"],"version":1}

$ curl -s -i -X POST -H 'Content-Type: application/json' -d '{"title":"   "}' http://127.0.0.1:18081/api/v1/tasks
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:06 GMT
Content-Length: 116

{"code":"validation_failed","message":"validation failed","fields":[{"field":"title","message":"cannot be empty"}]}

$ curl -s -i -X POST -H 'Content-Type: application/json' -d '{"title":"review the chapter","priority":9,"tags":["go",""]}' http://127.0.0.1:18081/api/v1/tasks
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:06 GMT
Content-Length: 178

{"code":"validation_failed","message":"validation failed","fields":[{"field":"priority","message":"must be at most 5"},{"field":"tags","message":"must not contain empty tags"}]}
```

The 201 hands back the new task with its path in `Location`; the two 422s show one entry per failed field, sorted by name. The reads, and the filter combination the store refuses — it has no query for both filters at once:

```bash
$ curl -s http://127.0.0.1:18081/api/v1/tasks
{"tasks":[{"id":"01a13e1a-818f-7690-816d-fe5a47ae507d","title":"write the chapter","status":"Todo","priority":5,"due":"2026-11-05T00:00:00Z","tags":["book","go"],"version":1}]}

$ curl -s -i http://127.0.0.1:18081/api/v1/tasks?status=Todo&tag=go
HTTP/1.1 400 Bad Request
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:06 GMT
Content-Length: 69

{"code":"bad_request","message":"status and tag cannot be combined"}
```

Then the changes: one that lands, one refused because the caller's version moved on, one refused by the status vocabulary, and one that clears the due date:

```bash
$ curl -s -i -X PATCH -H 'Content-Type: application/json' -d '{"version":1,"title":"write the chapter twice","tags":["go"]}' http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
HTTP/1.1 200 OK
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:06 GMT
Content-Length: 164

{"id":"01a13e1a-818f-7690-816d-fe5a47ae507d","title":"write the chapter twice","status":"Todo","priority":5,"due":"2026-11-05T00:00:00Z","tags":["go"],"version":2}

$ curl -s -i -X PATCH -H 'Content-Type: application/json' -d '{"version":1,"title":"lost update"}' http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
HTTP/1.1 409 Conflict
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:06 GMT
Content-Length: 50

{"code":"conflict","message":"task was modified"}

$ curl -s -i -X PATCH -H 'Content-Type: application/json' -d '{"version":2,"status":"Blocked"}' http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:06 GMT
Content-Length: 128

{"code":"validation_failed","message":"validation failed","fields":[{"field":"status","message":"unknown status \"Blocked\""}]}

$ curl -s -i -X PATCH -H 'Content-Type: application/json' -d '{"version":2,"due":null}' http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
HTTP/1.1 200 OK
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:07 GMT
Content-Length: 146

{"id":"01a13e1a-818f-7690-816d-fe5a47ae507d","title":"write the chapter twice","status":"Todo","priority":5,"due":null,"tags":["go"],"version":3}
```

The stale write is the one to stare at: it carries version 1 after the task moved to version 2, and the answer is 409 — re-read and decide again. Then the refusals every surface owes, and the delete:

```bash
$ curl -s -i -X PATCH -H 'Content-Type: application/json' -d '{"version":' http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
HTTP/1.1 400 Bad Request
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:07 GMT
Content-Length: 53

{"code":"bad_request","message":"invalid JSON body"}

$ curl -s -i -X PUT http://127.0.0.1:18081/api/v1/tasks
HTTP/1.1 405 Method Not Allowed
Allow: OPTIONS, GET, POST
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:07 GMT
Content-Length: 61

{"code":"method_not_allowed","message":"Method Not Allowed"}

$ curl -s -i http://127.0.0.1:18081/api/v1/tasks/not-a-uuid
HTTP/1.1 400 Bad Request
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:07 GMT
Content-Length: 51

{"code":"bad_request","message":"invalid task id"}

$ curl -s -i -X DELETE http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
HTTP/1.1 400 Bad Request
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:07 GMT
Content-Length: 70

{"code":"bad_request","message":"version must be a positive integer"}

$ curl -s -i -X DELETE http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d?version=3
HTTP/1.1 204 No Content
Date: Thu, 15 Oct 2026 05:48:07 GMT


$ curl -s -i http://127.0.0.1:18081/api/v1/tasks/01a13e1a-818f-7690-816d-fe5a47ae507d
HTTP/1.1 404 Not Found
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:07 GMT
Content-Length: 48

{"code":"not_found","message":"task not found"}

$ curl -s http://127.0.0.1:18081/api/v1/tasks
{"tasks":[]}

$ curl -s -i http://127.0.0.1:18081/api/v1/nope
HTTP/1.1 404 Not Found
Content-Type: application/json
Date: Thu, 15 Oct 2026 05:48:07 GMT
Content-Length: 43

{"code":"not_found","message":"Not Found"}
```

Two details are worth naming: the label set has no promised order — the create echoes the labels as sent, later reads return them sorted — and the last 404 is echo's own route miss, in the API's shape.

## If something went wrong

**`s.Get undefined` — the interface grew, and the suite says so first.** The compiler reports:

```bash
# todo/internal/store/storetest [todo/internal/store.test]
internal/store/storetest/suite.go:159:17: s.Get undefined (type "todo/internal/store".Store has no field or method Get)
internal/store/storetest/suite.go:169:19: s.Get undefined (type "todo/internal/store".Store has no field or method Get)
internal/store/storetest/suite.go:174:14: s.Get undefined (type "todo/internal/store".Store has no field or method Get)
internal/store/storetest/suite.go:196:20: s.Update undefined (type "todo/internal/store".Store has no field or method Update)
internal/store/storetest/suite.go:264:24: too many errors
```

The suite names only interface methods, so it is the first thing the compiler builds. Fix: add the three methods to both stores. The compiler stops after ten errors per package, so `go test -gcflags=-e` shows the whole list, and the two generated mocks fail the same way until they are regenerated.

**Every route answers 404 — with echo's own body.** The two line numbers below come from the capture; in your copy they will differ, so read the messages rather than the numbers:

```bash
--- FAIL: TestUpdateTask (0.00s)
    tasks_test.go:411: 
        	Error:      	Not equal: 
        	            	expected: 200
        	            	actual  : 404
        	Test:       	TestUpdateTask
--- FAIL: TestUnknownRoute_ErrorShape (0.00s)
    tasks_test.go:634: 
        	Error:      	Not equal: 
        	            	expected: map[string]interface {}{"code":"not_found", "message":"Not Found"}
        	            	actual  : map[string]interface {}{"message":"Not Found"}
        	Test:       	TestUnknownRoute_ErrorShape
```

Two causes wear one failure. The status misses are the empty group — nothing hangs off `/api/v1` yet — and the shape miss is echo's default error handler: the test compares the body against `errorJSON("not_found", "Not Found")` with `assert.JSONEq`, and the default answers `{"message":"Not Found"}`, so the decoded maps differ by exactly the missing `code`. Fix: register the five routes and set `e.HTTPErrorHandler = s.handleError`; a route that does not exist then still says `Not Found`, but in the API's shape.

**The binder's words reach the client.**

```bash
--- FAIL: TestCreateTask_UnusableBody (0.00s)
    --- FAIL: TestCreateTask_UnusableBody/wrong_type_for_a_field (0.00s)
        tasks_test.go:250: 
            	Error:      	Not equal: 
            	            	expected: map[string]interface {}{"code":"bad_request", "message":"invalid JSON body"}
            	            	actual  : map[string]interface {}{"code":"bad_request", "message":"Unmarshal type error: expected=string, got=number, field=title, offset=11"}
            	Test:       	TestCreateTask_UnusableBody/wrong_type_for_a_field
```

The binder answers a body it cannot decode with the decoder's own words — the expected and got types, the field, the byte offset. Those internals are not part of the API's contract. Fix: `bindBody` replaces exactly that one message with `invalid JSON body`.

**Validation comes back 500 — the hook is not wired.**

```bash
$ curl -s -i -X POST -H 'Content-Type: application/json' -d '{"title":"   "}' http://127.0.0.1:18091/api/v1/tasks
HTTP/1.1 500 Internal Server Error
Content-Type: application/json
Date: Thu, 15 Oct 2026 06:01:24 GMT
Content-Length: 53

{"code":"internal_error","message":"internal error"}
```

and the log holds the reason:

```bash
{"time":"2026-10-15T11:31:24.005383523+05:30","level":"ERROR","msg":"request failed","method":"POST","path":"/api/v1/tasks","err":"validator not registered"}
```

`c.Validate` consults `e.Validator`, and without one it returns "validator not registered", which no case classifies — so it lands in the default branch: 500, with the text kept in the process. Fix: set the hook in `New`, once. The log line is what turns a bare 500 into a diagnosis.

**`"due": null` leaves the date alone — a pointer cannot tell absent from null.**

```bash
--- FAIL: TestUpdateTask_ClearsDue (0.00s)
    tasks_test.go:439: 
        	Error:      	Not equal: 
        	            	expected: map[string]interface {}{"due":interface {}(nil), "id":"01a13e27-0793-7bde-8257-84aa745569d4", "priority":3, "status":"Todo", "tags":[]interface {}{}, "title":"write tests", "version":2}
        	            	actual  : map[string]interface {}{"due":"2026-11-05T00:00:00Z", "id":"01a13e27-0793-7bde-8257-84aa745569d4", "priority":3, "status":"Todo", "tags":[]interface {}{}, "title":"write tests", "version":2}
        	Test:       	TestUpdateTask_ClearsDue
    tasks_test.go:444: 
        	Error:      	Should be true
        	Test:       	TestUpdateTask_ClearsDue
        	Messages:   	the due date is cleared
```

The version moved to 2 — the write happened — and the due date is still there. `encoding/json` decodes an absent field and an explicit `null` to the same nil pointer, so a plain pointer reads "clear it" as "not mentioned". Fix: `optional[T]` records presence while decoding, so the handler can tell "the client sent null" from "the client sent nothing".

<details>
<summary>Going deeper: why the wire has its own types</summary>

The task in the domain, `task.Task`, carries no JSON notes at all. The API's request and response types are where every wire spelling lives: the key names, the null rules, which fields a client may send. That is why a create ignores a status, a change insists on a version, and the response can grow a field later without touching the domain. The CLI's `--json` output keeps its own type for the same reason: two edges, two contracts, and a change to one never forces a change to the other.

</details>

<details>
<summary>Going deeper: the status codes, one at a time</summary>

200: the request worked, and the body is the task. 201: a new task exists, and `Location` says where. 204: the delete worked, and there is nothing left to say. 400: the request could not be read — broken JSON, an id that is not a UUID, a version that is not a positive number. 404: the task is gone. 409: the task changed since the caller read it, so re-read and decide again. 415: the content type is not one the server can read. 422: the request parsed but broke a rule, and the body lists the fields. 405: the path exists, but not for this method. 500: a bug, with the error text kept in the process. The split that matters most is 400 against 422: "I could not read this" against "I read it, and it is wrong".

</details>

<details>
<summary>Going deeper: absent, null, and a patch that changes nothing</summary>

`optional[T]` exists for exactly one distinction. `encoding/json` decodes an absent field and a `null` field to the same nil pointer, and a change needs them apart: absent means "leave it alone", null means "clear it". Only `due` has a "clear" — an empty date has no other spelling — so only `due` uses `optional`. An empty label array clears every label, because an update replaces the set rather than merging it. And a change that names no fields is a legal write: it changes nothing and bumps the version like any other.

</details>

<details>
<summary>Going deeper: why one empty label is one error</summary>

The obvious way to check a list of labels is to run the check on each element — the checker's `dive` marker does exactly that — and it has a bill. A request with four empty labels would come back with four field entries, one per position, and a request with a thousand would come back with a thousand: the 422 body built by the request's size. The app's own rule fails the whole list once, so the error body stays the size of the request type — six fields at most — and the client gets one sentence instead of an index list.

</details>

The API can now do the app's real work — next, every request through the group gets an id, a log line, a time limit, and a size limit.
