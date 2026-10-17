---
title: Authorization
day: 40
time: "3 hours"
description: Give every task an owner, scope each request to the signed-in user, and keep a trail of who did what.
sidebar:
  order: 34
---

The server knows who is asking. The last lesson gave it users, passwords, and sessions, so a request can arrive with a name attached. It still has no idea what that name may touch — any signed-in caller can read, change, and delete everyone's tasks.

**Authentication** answers "who is asking". **Authorization** answers "what may they touch". The rule for this app fits in one sentence: a task belongs to the person who made it.

So every task gains an owner, and the server answers each request as if the other users' tasks did not exist. Alice asks for one of Bob's tasks by its id and gets the same answer a made-up id gets. Bob's work comes out untouched.

Two people share one server and one database and never see each other's lists — and the operator who runs the server can hand one account the admin flag, with a record of who did what.

## A task belongs to the person who made it

The obvious way to enforce ownership is a check in every handler: load the task, compare its owner with the session, refuse when they differ. It works — until a later handler forgets it, and a forgotten check is a leak, not a typo.

So the rule lives one level down, inside the database queries. Every task query carries an owner, and the store hands each request a **view**: the same store, restricted to one user's rows. A task outside the view matches no row, and a task that matches no row is indistinguishable from one that never existed.

That last property is why a foreign task answers 404, not 403. A 403 would say "this exists, but it is not yours" — exactly the fact someone probing ids wants to learn. Because the store decides the 404, no handler can leak the difference by accident.

The build moves in small steps, and the tests come first — starting with the one that fails today.

## The tests come first

The lesson's first test registers two real users, logs them in through the routes, has Bob create a task, and probes that task four ways as Alice. Every probe must answer 404 with the same body a nonexistent id gets:

<!-- verify: internal/api/ownership_test.go at=authorization -->
```go title="internal/api/ownership_test.go"
	probes := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"see it", http.MethodGet, target, ""},
		{"update it", http.MethodPatch, target, `{"version":1,"title":"stolen"}`},
		{"complete it", http.MethodPatch, target, `{"version":1,"status":"Done"}`},
		{"delete it", http.MethodDelete, target + "?version=1", ""},
	}
```

A 404 that is not a refusal tells Alice nothing about whether the id names anything. The bug it prevents has a security name: reaching someone else's data by swapping an id in a request is an **insecure direct object reference**, and the fix is to make an id mean nothing outside its owner.

<!-- verify: internal/api/ownership_test.go at=authorization -->
```go title="internal/api/ownership_test.go"
			require.Equal(t, http.StatusNotFound, rec.Code, "a foreign task is a miss, not a refusal")
			assert.JSONEq(t, errorJSON("not_found", "task not found"), rec.Body.String())
```

The test pins both directions too: Alice's list must not carry Bob's task, and Bob's task must come out of the four probes untouched — the scope is a filter, not a wall.

The second test walks the five task routes with no session at all, and with a made-up cookie, and every request must be turned away with the same 401:

<!-- verify: internal/api/ownership_test.go at=authorization -->
```go title="internal/api/ownership_test.go"
	probes := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"list", http.MethodGet, "/api/v1/tasks", ""},
		{"create", http.MethodPost, "/api/v1/tasks", `{"title":"write tests"}`},
		{"get", http.MethodGet, "/api/v1/tasks/" + missing, ""},
		{"update", http.MethodPatch, "/api/v1/tasks/" + missing, `{"version":1,"title":"write tests"}`},
		{"delete", http.MethodDelete, "/api/v1/tasks/" + missing + "?version=1", ""},
	}
```

The auth routes stay open, because they are the ones an anonymous caller must reach — and their own 401, a failed login, keeps its own message.

The store's shared suite grows three cases, run against both the memory store and the database store: `ScopedVisibility`, `ScopedForeignWrites`, and `ScopedAggregates`. The first pins the miss where it is made:

<!-- verify: internal/store/storetest/suite.go at=authorization -->
```go title="internal/store/storetest/suite.go"
		// A task another scope owns is a miss, not a leak: the store cannot
		// tell the caller the task exists but is not theirs.
		_, err = alice.Get(ctx, theirs[0].ID)
		require.Error(t, err)
		assert.ErrorIs(t, err, store.ErrNotFound)
		assert.NotErrorIs(t, err, store.ErrConflict)
```

The second pins the order inside a write: the owner is checked before the version, so a foreign write with a stale version is a miss, never a conflict. The third pins that the filters, the counts, and the stats see the scope's tasks only — an aggregate is as much a read as a list. The database store's suite also seeds two user rows first, because the owner column's foreign key requires the owner to exist; the memory store has no schema to satisfy.

The existing task tests also move onto a session, because the routes now require one. A small fixture mints a session for a fixed test user by driving the session manager directly, so no request is logged and no password is hashed:

<!-- verify: internal/api/api_test.go at=authorization -->
```go title="internal/api/api_test.go"
	ctx, err := sessions.Load(context.Background(), "")
	require.NoError(t, err)
	sessions.Put(ctx, auth.SessionUserID, testUserID.String())
	token, _, err := sessions.Commit(ctx)
	require.NoError(t, err)
```

Run the tests and watch them fail:

```bash
$ go test -count=1 ./...
# todo/internal/store/storetest [todo/internal/store.test]
internal/store/storetest/suite.go:470:19: s.Scoped undefined (type "todo/internal/store".Store has no field or method Scoped)
...
--- FAIL: TestTaskRoutes_RequireUser (0.00s)
    --- FAIL: TestTaskRoutes_RequireUser/list (0.00s)
        ownership_test.go:113: 
            	Error:      	Not equal: 
            	            	expected: 401
            	            	actual  : 200
...
--- FAIL: TestTask_Foreign_Returns404 (0.35s)
    ownership_test.go:67: 
        	Error:      	Not equal: 
        	            	expected: map[string]interface {}{"tasks":[]interface {}{}}
        	            	actual  : map[string]interface {}{"tasks":[]interface {}{map[string]interface {}{"due":interface {}(nil), "id":"01a13e68-7da0-72d0-b7eb-4a8c028a72c5", "priority":3, "status":"Todo", "tags":[]interface {}{"secret"}, "title":"bob's task", "version":1}}}
    --- FAIL: TestTask_Foreign_Returns404/see_it (0.00s)
        ownership_test.go:58: 
            	Error:      	Not equal: 
            	            	expected: 404
            	            	actual  : 200
            	Messages:   	a foreign task is a miss, not a refusal
...
FAIL	todo/internal/api	0.454s
FAIL
```

The compiler error names a piece that does not exist yet: the suite calls `Scoped`, and the interface has not grown it. The better failures are the ones that compile: Alice reads Bob's task and the server hands it over with a 200, and the five task routes answer anonymous callers with 200s and a 201, because nothing stands in front of them. Nothing is broken; the tests describe an app that does not exist yet.

## The schema gains three things

Migration 00005 is the lesson in SQL. The audit trail's table comes first, so the foreign keys it needs exist when it is created:

<!-- verify: internal/db/migrations/00005_ownership.sql at=authorization -->
```sql title="internal/db/migrations/00005_ownership.sql"
-- +goose Up
...
CREATE TABLE audit_events (
    id         TEXT PRIMARY KEY NOT NULL,
    action     TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id),
    actor_id   TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
);

-- The owner column arrives nullable, which is also the only shape ALTER TABLE
-- ADD COLUMN with a REFERENCES clause admits under foreign keys: existing
-- rows read back as NULL — unowned.
ALTER TABLE tasks ADD COLUMN owner_id TEXT REFERENCES users(id);
CREATE INDEX tasks_owner_id ON tasks(owner_id);

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
```

There are three additions, and each one is a decision. `audit_events` is the trail: one row per happening — a registration, a login, a logout, a grant. `owner_id` is nullable on purpose, and NULL is not a missing value here: it is a real scope, the user-less tasks of the command line. Every row that predates this migration stays NULL-owned; a task nobody claimed must not be handed to whichever account happened to exist first. The index is the access path every task query uses from here on, and `is_admin` is the flag the operator's command flips.

The Down is the part to read twice. Undoing the column cannot be a `DROP COLUMN`: the index references it, and the foreign key names it, and SQLite refuses both. So `tasks` is rebuilt without the column, and the label rows ride along in a temporary table, because dropping the old table cascades into `task_tags`:

<!-- verify: internal/db/migrations/00005_ownership.sql at=authorization -->
```sql title="internal/db/migrations/00005_ownership.sql"
-- +goose Down
...
DROP TABLE IF EXISTS audit_events;
ALTER TABLE users DROP COLUMN is_admin;

DROP INDEX IF EXISTS tasks_owner_id;

CREATE TEMP TABLE parked_tags AS SELECT task_id, tag FROM task_tags;

CREATE TABLE tasks_rebuilt (
	id       TEXT PRIMARY KEY NOT NULL,
	title    TEXT NOT NULL,
	status   TEXT NOT NULL,
	priority INTEGER NOT NULL,
	due      TEXT,
	version  INTEGER NOT NULL DEFAULT 1
);

INSERT INTO tasks_rebuilt (id, title, status, priority, due, version)
SELECT id, title, status, priority, due, version FROM tasks;

-- Child first: the cascade empties task_tags, and the parked rows are the
-- copy that restores it after the rename.
DROP TABLE tasks;
ALTER TABLE tasks_rebuilt RENAME TO tasks;

INSERT INTO task_tags (task_id, tag)
SELECT task_id, tag FROM parked_tags;

DROP TABLE parked_tags;
```

The rebuilt table is the schema exactly as it was before this migration, and the migrate tests' round trip — up, down, up — pins it.

## Every query carries the owner

Every task query in `internal/db/queries/tasks.sql` grows the same condition. `ListTasks` is the plain case, and the file's header comment is where the rule lives:

<!-- verify: internal/db/queries/tasks.sql at=authorization -->
```sql title="internal/db/queries/tasks.sql"
-- Every task query carries the scope: `owner_id IS sqlc.narg('owner')`, which
-- sqlc types as sql.NullString. IS is SQL's null-safe equality, so the one
-- predicate serves both scopes: a NULL parameter matches the user-less rows
-- (the local CLI's tasks), a user id matches that user's, and a task outside
-- the scope matches no row at all: the store reads and writes only what the
-- scope owns, and a foreign id is indistinguishable from a missing one. The
-- chapter notes carry the 404-not-403 reasoning and the design trade-offs.
...
-- name: InsertTask :exec
INSERT INTO tasks (id, title, status, priority, due, version, owner_id)
VALUES (?, ?, ?, ?, ?, ?, sqlc.narg('owner'));

...
-- name: ListTasks :many
SELECT id, title, status, priority, due, version, owner_id
FROM tasks
WHERE owner_id IS sqlc.narg('owner')
ORDER BY id;
```

`sqlc.narg('owner')` is a named parameter that may be NULL, which sqlc types as `sql.NullString` — the type the due date already uses for "a value, or no value". `IS` is SQL's null-safe equality: a NULL parameter matches the user-less rows, a user's id matches that user's rows, so one condition serves both scopes.

The writes carry the condition too, in the same `WHERE` clause as the version, so the scope is checked first:

<!-- verify: internal/db/queries/tasks.sql at=authorization -->
```sql title="internal/db/queries/tasks.sql"
-- name: CompleteTask :execrows
UPDATE tasks
SET status = ?, version = version + 1
WHERE id = ? AND version = ? AND owner_id IS sqlc.narg('owner');
```

`ownerSQL` is the one place a scope becomes a parameter, and the one place the zero id becomes SQL's NULL:

<!-- verify: internal/store/turso.go at=authorization -->
```go title="internal/store/turso.go"
// ownerSQL maps a scope to the owner column's shape: uuid.Nil is SQL NULL,
// the user-less scope, and any other id is its canonical text. It is the one
// place a scope becomes a query parameter, which is what keeps the owner
// predicate and the column's NULL meaning from drifting apart.
func ownerSQL(owner uuid.UUID) sql.NullString {
	if owner == uuid.Nil {
		return sql.NullString{}
	}
	return sql.NullString{String: owner.String(), Valid: true}
}
```

With the queries written, regenerate the Go code sqlc writes from them — the query methods, the row types, and the test mocks:

```bash
$ go generate ./...
```

The generator rewrites the files under `internal/db` and the two mock files. They are rebuilt from the SQL every time, so never edit them by hand.

## The store gets a view

The `Store` interface gains exactly one method, first in the list:

<!-- verify: internal/store/store.go at=authorization -->
```go title="internal/store/store.go"
	// Scoped returns a view of the same store restricted to one owner:
	// every task query the view runs carries the owner, so the view reads
	// and writes only that owner's tasks. uuid.Nil is the user-less scope —
	// the local tasks of the CLI — and Scoped on a view re-scopes it: there
	// is one level of scope, not a nesting. The view shares the store's
	// data and its database handle; Close belongs to the store Scoped was
	// called on, not to the view.
	Scoped(owner uuid.UUID) Store
```

`uuid.Nil` is the zero id — every bit at zero — and it is the user-less scope's name, exactly as NULL is in the database. `Scoped` on a view re-scopes it: one level of scope, not a nesting. The constructors keep returning the user-less scope, because the command line, the exporter, and the importer hold them and none of those paths has a user.

The alternative was an owner argument on every method, which would thread a user through the command line, the exporter, and the importer — none of which have one. The view keeps the interface's shape: the scope is chosen once per request, where the identity arrives, and every other caller keeps working unchanged. The trade is named honestly: a handler that forgets to scope serves the user-less rows instead of failing — which is why the failing table came first.

The memory store gains one field — the view's scope — and keeps its data in a shared core:

<!-- verify: internal/store/store.go at=authorization -->
```go title="internal/store/store.go"
type MemoryStore struct {
	// core is the state every view of one store shares: a write through one
	// view is visible through every other view of the same owner, and the
	// ops counter counts the store, not the view.
	core *memoryCore

	// owner is the view's scope. uuid.Nil is the user-less scope: the local
	// tasks of the CLI, the rows whose owner_id is NULL. See Store.Scoped.
	owner uuid.UUID
}
```

The core is the state every view shares, so a write through one view is visible through every other view of the same owner. The rows keep the owner they were written under:

<!-- verify: internal/store/store.go at=authorization -->
```go title="internal/store/store.go"
type storedTask struct {
	task.Task
	owner uuid.UUID
}
```

A row keeps the task and its owner together, because ownership is the store's scoping fact — not a field the domain type or the wire format carries.

<!-- verify: internal/store/store.go at=authorization -->
```go title="internal/store/store.go"
// Scoped implements Store. The view shares the store's tasks and operation
// counter; only the rows whose owner matches the scope are visible or
// writable through it.
func (s *MemoryStore) Scoped(owner uuid.UUID) Store {
	return &MemoryStore{core: s.core, owner: owner}
}
```

Every method a view runs goes through the shared core and checks the view's owner — the list, the lookups, and the aggregates alike.

The database store is the same idea over its handle — same database, same generated queries, one different field:

<!-- verify: internal/store/turso.go at=authorization -->
```go title="internal/store/turso.go"
// Scoped implements Store: the view shares the store's handle and its
// generated queries, and differs only in the owner every query pins. Close
// belongs to the store Scoped was called on: closing a view would close the
// handle every other view is using.
func (s *TursoStore) Scoped(owner uuid.UUID) Store {
	return &TursoStore{db: s.db, queries: s.queries, owner: owner}
}
```

Every query the view runs hands the scope in through `ownerSQL(s.owner)`, so the owner rides in the SQL on every read and every write.

`classifyWrite` is where a zero-row write becomes an answer. It probes with the same scoped query, so a task the view does not own is invisible exactly as a missing one is — which is what makes a foreign write answer `ErrNotFound`, never `ErrConflict`:

<!-- verify: internal/store/turso.go at=authorization -->
```go title="internal/store/turso.go"
func (s *TursoStore) classifyWrite(ctx context.Context, op string, id uuid.UUID) error {
	_, err := s.queries.GetTask(ctx, db.GetTaskParams{ID: id.String(), Owner: ownerSQL(s.owner)})
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

The memory store gets the same ordering for free: its lookup searches only the view's rows, so a foreign id is a miss before any version comparison runs. The filters, the counts, and the stats all read through the view too.

## A check in front of the task routes

`internal/api/authorization.go` is the whole check, and the session is the authority — the session layer has already loaded it and checked its expiry. A session that is absent, unknown, or carries an id that is not a UUID is the same answer, with no detail about which half was wrong:

<!-- verify: internal/api/authorization.go at=authorization -->
```go title="internal/api/authorization.go"
func RequireUser(sessions *scs.SessionManager) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			raw := sessions.GetString(c.Request().Context(), auth.SessionUserID)
			id, err := uuid.Parse(raw)
			if err != nil {
				return echo.NewHTTPError(http.StatusUnauthorized, "authentication required")
			}
			c.SetRequest(c.Request().WithContext(withUser(c.Request().Context(), id)))
			return next(c)
		}
	}
}
```

The user's id travels in the request's context under a private key type. The helper a handler uses panics when the id is missing, and the panic is deliberate: the zero id is a *real* scope — the user-less one — so a helper that answered it for an anonymous request would silently serve the wrong rows:

<!-- verify: internal/api/authorization.go at=authorization -->
```go title="internal/api/authorization.go"
// userKey is the request context's key for the authenticated user's id. It is
// a struct type rather than a string so it cannot collide with a key another
// package sets.
type userKey struct{}

// withUser returns a copy of ctx carrying the authenticated user's id.
// RequireUser is the only setter.
func withUser(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, userKey{}, id)
}
```

The id travels under a key of a private type, so no other package can collide with it — and `withUser` is the only writer. The two readers come next:

<!-- verify: internal/api/authorization.go at=authorization -->
```go title="internal/api/authorization.go"
// UserFrom returns the authenticated user's id — the value RequireUser put in
// the request's context — and whether it was there at all. The second return
// is what keeps "no user" from being mistaken for the zero id: uuid.Nil is a
// real scope (the user-less one, the local CLI's tasks), so a helper that
// answered the zero value for an anonymous request would silently serve the
// wrong rows.
func UserFrom(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(userKey{}).(uuid.UUID)
	return id, ok
}

// userID returns the authenticated user's id for a handler behind
// RequireUser. A handler that reaches it without the middleware is a wiring
// bug, and the panic says so: the stack's Recover answers it with a 500, which
// is what a bug gets.
func userID(ctx context.Context) uuid.UUID {
	id, ok := UserFrom(ctx)
	if !ok {
		panic("api: task handler reached without RequireUser")
	}
	return id
}
```

The task routes move behind the check as a group; the auth routes stay outside it, because they are the ones an anonymous caller must reach:

<!-- verify: internal/api/api.go at=authorization -->
```go title="internal/api/api.go"
	g := e.Group("/api/v1")
	tasks := g.Group("/tasks", RequireUser(sessions))
	tasks.GET("", s.listTasks)
	tasks.POST("", s.createTask)
	tasks.GET("/:id", s.getTask)
	tasks.PATCH("/:id", s.updateTask)
	tasks.DELETE("/:id", s.deleteTask)

	g.POST("/auth/register", s.register)
	g.POST("/auth/login", s.login)
	g.POST("/auth/logout", s.logout)
```

Every one of the five handlers opens with the same two lines — the scope is chosen first, and nothing after it knows ownership exists:

<!-- verify: internal/api/tasks.go at=authorization -->
```go title="internal/api/tasks.go"
func (s *server) getTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))
...
```

The rest of each handler is unchanged: it speaks to the view exactly as it spoke to the store before.

## The audit trail

An **audit trail** is a record of who did what, kept next to the data it is about. It is not the same thing as the log lines the server writes: a log record is for operating the process and can rotate away, while the trail must outlive any run — so it is a table.

`internal/auth/audit.go` declares the vocabulary first — one token per happening, stored as text, so a reader of the table needs no code:

<!-- verify: internal/auth/audit.go at=authorization -->
```go title="internal/auth/audit.go"
// The audited actions. They are the table's vocabulary: one token per
// happening, stored as text, so a reader of the table needs no code.
const (
	// ActionRegister is a user's registration.
	ActionRegister = "register"
	// ActionLogin is a login that produced a session.
	ActionLogin = "login"
	// ActionLogout is a logout that destroyed a session.
	ActionLogout = "logout"
	// ActionGrant is an admin grant by the local operator.
	ActionGrant = "grant"
)
```

An `AuditEvent` is what the rest of the package passes around: the happening, the user it concerns, and the actor:

<!-- verify: internal/auth/audit.go at=authorization -->
```go title="internal/auth/audit.go"
// AuditEvent is one entry in the trail: what happened, to which user, and who
// did it. The id and the timestamp are the service's to assign when it writes
// the row, so a caller cannot pick a key or backdate an event.
type AuditEvent struct {
	// Action is what happened: one of the Action* constants.
	Action string
	// UserID is the user the event concerns. It must name an existing user;
	// the table's foreign key is what says so.
	UserID uuid.UUID
	// ActorID is who performed the action. The zero uuid.UUID means nobody
	// a user can name — the local CLI has no account of its own — and is
	// stored as NULL.
	ActorID uuid.UUID
}
```

`Record` is the HTTP layer's path to the trail: a login's session and a logout are the API's to create and destroy, so their events arrive here, in the same kind of transaction every write in the app rides.

<!-- verify: internal/auth/audit.go at=authorization -->
```go title="internal/auth/audit.go"
func (s *Service) Record(ctx context.Context, e AuditEvent) error {
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		return insertAudit(ctx, db.New(conn), e)
	})
	if err != nil {
		return fmt.Errorf("record %s event: %w", e.Action, err)
	}
	return nil
}
```

`insertAudit` assigns the id and the timestamp — a caller cannot pick a key or backdate an event:

<!-- verify: internal/auth/audit.go at=authorization -->
```go title="internal/auth/audit.go"
func insertAudit(ctx context.Context, q *db.Queries, e AuditEvent) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	return q.InsertAuditEvent(ctx, db.InsertAuditEventParams{
		ID:        id.String(),
		Action:    e.Action,
		UserID:    e.UserID.String(),
		ActorID:   actorSQL(e.ActorID),
		CreatedAt: time.Now().UTC().Truncate(time.Second).Unix(),
	})
}
```

The id is a UUIDv7, so the trail sorts by creation time, and the timestamp is truncated to the second like every other instant the app stores. `actorSQL` maps "nobody" to the column's NULL:

<!-- verify: internal/auth/audit.go at=authorization -->
```go title="internal/auth/audit.go"
func actorSQL(actor uuid.UUID) sql.NullString {
	if actor == uuid.Nil {
		return sql.NullString{}
	}
	return sql.NullString{String: actor.String(), Valid: true}
}
```

The service's own two events ride their action's transaction. A registration writes its event in the same transaction as the user row, so a duplicate registration writes neither:

<!-- verify: internal/auth/auth.go at=authorization -->
```go title="internal/auth/auth.go"
		if err != nil || n == 0 {
			// A taken email writes nothing, the trail included.
			return err
		}
		return insertAudit(ctx, q, AuditEvent{Action: ActionRegister, UserID: user.ID, ActorID: user.ID})
```

The grant reports its miss with a sentinel of its own — an email no user holds:

<!-- verify: internal/auth/auth.go at=authorization -->
```go title="internal/auth/auth.go"
// ErrUserNotFound is reported when an operation names an email no user holds:
// the grant command's miss. The CLI prints it; the API has no route that can
// produce it today.
var ErrUserNotFound = errors.New("user not found")
```

`GrantAdmin` is the update's row count, the read-back, and the event, in one transaction. The miss is read from the row count — zero rows means no such user — instead of a lookup that would race the write:

<!-- verify: internal/auth/auth.go at=authorization -->
```go title="internal/auth/auth.go"
func (s *Service) GrantAdmin(ctx context.Context, email string) (User, error) {
	email = normalizeEmail(email)
	if email == "" {
		return User{}, errors.New("auth: email must not be empty")
	}

	var user User
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		n, err := q.SetUserAdmin(ctx, db.SetUserAdminParams{IsAdmin: 1, Email: email})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrUserNotFound
		}
		row, err := q.GetUserByEmail(ctx, email)
		if err != nil {
			return err
		}
		if user, err = userFromRow(row); err != nil {
			return err
		}
		return insertAudit(ctx, q, AuditEvent{Action: ActionGrant, UserID: user.ID})
	})
	if err != nil {
		return User{}, fmt.Errorf("grant admin to %s: %w", email, err)
	}
	return user, nil
}
```

The queries behind those calls are two small additions to `internal/db/queries/auth.sql`, plus one column read back:

<!-- verify: internal/db/queries/auth.sql at=authorization -->
```sql title="internal/db/queries/auth.sql"
-- name: GetUserByEmail :one
SELECT id, email, password_hash, created_at, is_admin
FROM users
WHERE email = ?;

...
-- name: SetUserAdmin :execrows
UPDATE users
SET is_admin = ?
WHERE email = ?;

-- name: InsertAuditEvent :exec
INSERT INTO audit_events (id, action, user_id, actor_id, created_at)
VALUES (?, ?, ?, ?, ?);
```

The `User` type gains the flag:

<!-- verify: internal/auth/auth.go at=authorization -->
```go title="internal/auth/auth.go"
	// IsAdmin reports whether the user carries the admin flag the CLI's
	// grant command sets. A fresh registration never does.
	IsAdmin bool
```

`userFromRow` is the boundary where a generated database row becomes a domain user, and it reads the flag back from the column:

<!-- verify: internal/auth/auth.go at=authorization -->
```go title="internal/auth/auth.go"
	return User{
		ID:           id,
		Email:        row.Email,
		PasswordHash: row.PasswordHash,
		CreatedAt:    time.Unix(row.CreatedAt, 0).UTC(),
		IsAdmin:      row.IsAdmin != 0,
	}, nil
```

The API's `Authenticator` interface gains `Record` so the handlers can reach the trail:

<!-- verify: internal/api/auth.go at=authorization -->
```go title="internal/api/auth.go"
	// Record appends an event to the audit trail. The login and logout
	// handlers own happenings the service cannot see — a session's birth
	// and death are the HTTP layer's — and this is how they reach the
	// trail.
	Record(ctx context.Context, e auth.AuditEvent) error
```

The login handler records its event before the session is put — a login that cannot reach the trail is a failed login, not a session the trail does not know about:

<!-- verify: internal/api/auth.go at=authorization -->
```go title="internal/api/auth.go"
	if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogin, UserID: user.ID, ActorID: user.ID}); err != nil {
		return err
	}
	s.sessions.Put(ctx, auth.SessionUserID, user.ID.String())
```

The logout records before the session is destroyed, so an event that cannot be written leaves the session in place and the client can retry:

<!-- verify: internal/api/auth.go at=authorization -->
```go title="internal/api/auth.go"
	if raw := s.sessions.GetString(ctx, auth.SessionUserID); raw != "" {
		if id, err := uuid.Parse(raw); err == nil {
			if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogout, UserID: id, ActorID: id}); err != nil {
				return err
			}
		}
	}
```

The login response gains the flag too, so a client can see what the grant wrote:

<!-- verify: internal/api/auth.go at=authorization -->
```go title="internal/api/auth.go"
type userResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
	IsAdmin   bool      `json:"is_admin"`
}
```

The converter copies it out of the domain user:

<!-- verify: internal/api/auth.go at=authorization -->
```go title="internal/api/auth.go"
func newUserResponse(u auth.User) userResponse {
	return userResponse{ID: u.ID.String(), Email: u.Email, CreatedAt: u.CreatedAt, IsAdmin: u.IsAdmin}
}
```

A failed login records nothing, on purpose: no login happened, and the column names a user — an unknown email has none.

## The operator's grant

An account becomes an admin only through the command line. No route hands the flag out, so the first admin is made where the database is. `internal/cli/admin.go` declares the capability it needs at the point of use, because the store's contract is the task contract and does not promise a database:

<!-- verify: internal/cli/admin.go at=authorization -->
```go title="internal/cli/admin.go"
// adminStore is the capability the admin commands need from the opened store:
// the database handle the auth tables live in.
type adminStore interface {
	DB() *sql.DB
}
```

`newAdminCmd` builds the group and hangs the grant command under it:

<!-- verify: internal/cli/admin.go at=authorization -->
```go title="internal/cli/admin.go"
// newAdminCmd builds the admin command group.
func newAdminCmd(sess *session) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "admin",
		Short: "Operator commands over users",
		Long: `Operator commands over users.

These commands work on the database the CLI opened, like every other
command, and they are the local operator's: there is no HTTP endpoint that
grants the admin flag.`,
	}
	cmd.AddCommand(newAdminGrantCmd(sess))
	return cmd
}
```

`newAdminGrantCmd` is the command itself — one positional email, the service's grant behind it, and the same two output formats as every other command:

<!-- verify: internal/cli/admin.go at=authorization -->
```go title="internal/cli/admin.go"
// newAdminGrantCmd builds `todo admin grant <email>`: one positional email,
// the service's grant behind it, and the same two output formats as every
// other command.
func newAdminGrantCmd(sess *session) *cobra.Command {
	return &cobra.Command{
		Use:   "grant <email>",
		Short: "Grant the admin flag to a user",
		Long: `Grant the admin flag to the user with the given email.

The grant is recorded in the audit trail, and the actor is nobody: the local
operator runs the command and has no account of their own. An email no user
holds fails the command and changes nothing.`,
		Args: cobra.ExactArgs(1),
```

Its `RunE` asks the opened store for the capability with a type assertion, so a store without a database — the in-memory one in a test — fails with a sentence instead of a crash:

<!-- verify: internal/cli/admin.go at=authorization -->
```go title="internal/cli/admin.go"
		RunE: func(cmd *cobra.Command, args []string) error {
			st, ok := sess.store.(adminStore)
			if !ok {
				return fmt.Errorf("admin: the opened store does not expose a database (it is %T)", sess.store)
			}
			user, err := auth.NewService(st.DB()).GrantAdmin(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			sess.logger.Info("admin granted", "user_id", user.ID.String(), "email", user.Email)
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonUser{
					ID:      user.ID.String(),
					Email:   user.Email,
					IsAdmin: user.IsAdmin,
				})
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "granted admin to %s\n", user.Email)
			return err
		},
	}
}
```

The human form prints one line; `--json` prints the machine form — id, email, and the flag:

<!-- verify: internal/cli/admin.go at=authorization -->
```go title="internal/cli/admin.go"
// jsonUser is the machine form of a user for the admin commands: the id, the
// email, and the admin flag, under the stable-key discipline every --json
// shape follows. Change it additively — a renamed or retyped key is a
// breaking change.
type jsonUser struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	IsAdmin bool   `json:"is_admin"`
}
```

The group joins the root command beside the others:

<!-- verify: internal/cli/cli.go at=authorization -->
```go title="internal/cli/cli.go"
		newStatsCmd(&sess),
		newImportCmd(&sess),
		newAdminCmd(&sess),
	)
```

That is the whole wiring — the grant is a command of the same binary, working on the same database file every other command opened.

## Try it on the wire

Run the store's suite — `go test -count=1 -v -run TestStoreConformance ./internal/store` — and watch the three scoping cases pass on both implementations:

```bash
        --- PASS: TestStoreConformance/MemoryStore/ScopedVisibility (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/ScopedForeignWrites (0.00s)
        --- PASS: TestStoreConformance/MemoryStore/ScopedAggregates (0.00s)
        --- PASS: TestStoreConformance/TursoStore/ScopedVisibility (0.01s)
        --- PASS: TestStoreConformance/TursoStore/ScopedForeignWrites (0.01s)
        --- PASS: TestStoreConformance/TursoStore/ScopedAggregates (0.01s)
```

Then the API's tests — `go test -count=1 -v ./internal/api` — every case passes:

```bash
--- PASS: TestAuditTrail (0.34s)
...
--- PASS: TestTask_Foreign_Returns404 (0.37s)
--- PASS: TestTaskRoutes_RequireUser (0.00s)
...
ok  	todo/internal/api	0.578s
```

Then a real server. Start it the way the last lesson showed, in a scratch folder with `TODO_DB` and `TODO_LOG` inside it — and with both binaries built earlier copied in: `todo-server` for the server and `todo` for the operator's command. Start it on the port the commands below use, and keep the base URL in a shell variable — `$B` — so each command stays short; every API route lives under `/api/v1`:

<!-- transcripts: authored -->
```bash
$ TODO_DB=todo.db TODO_LOG=todo.log ./todo-server --listen 127.0.0.1:18085 > stdout.txt 2> stderr.txt &
$ B=http://127.0.0.1:18085
```

Two registrations first, each command creating its account's jar with `-c`:

<!-- transcripts: authored -->
```bash
$ curl -s -c alice.jar -X POST -H "Content-Type: application/json" --data '{"email":"alice@example.com","password":"correct horse battery staple"}' $B/api/v1/auth/register
{"id":"01a13e98-d063-7c95-b041-f75010677b34","email":"alice@example.com","created_at":"2026-10-15T08:06:04Z","is_admin":false}

$ curl -s -c bob.jar -X POST -H "Content-Type: application/json" --data '{"email":"bob@example.com","password":"correct horse battery staple"}' $B/api/v1/auth/register
{"id":"01a13e98-d086-71fe-8339-56bdd2f49a3a","email":"bob@example.com","created_at":"2026-10-15T08:06:04Z","is_admin":false}
```

Both users log in — the login route is the one the last lesson built — and `-c` writes each session cookie into that account's jar; from here on, `-b` presents it:

<!-- transcripts: authored -->
```bash
$ curl -s -c alice.jar -X POST -H "Content-Type: application/json" --data '{"email":"alice@example.com","password":"correct horse battery staple"}' $B/api/v1/auth/login
$ curl -s -c bob.jar -X POST -H "Content-Type: application/json" --data '{"email":"bob@example.com","password":"correct horse battery staple"}' $B/api/v1/auth/login
```

Each login answers `200` with the user, and each user creates one task — bob's first:

<!-- transcripts: authored -->
```bash
$ curl -s -b bob.jar -H 'Content-Type: application/json' --data '{"title":"bob'\''s secret plan","tags":["private"]}' $B/api/v1/tasks
{"id":"01a13e98-efc9-72f3-85e5-52dd0e9ebaa8","title":"bob's secret plan","status":"Todo","priority":3,"due":null,"tags":["private"],"version":1}

$ curl -s -b alice.jar -H 'Content-Type: application/json' --data '{"title":"alice'\''s own task"}' $B/api/v1/tasks
{"id":"01a13e98-efd0-7085-ae2e-cfb6862044dd","title":"alice's own task","status":"Todo","priority":3,"due":null,"tags":[],"version":1}

$ curl -s -b alice.jar $B/api/v1/tasks
{"tasks":[{"id":"01a13e98-efd0-7085-ae2e-cfb6862044dd","title":"alice's own task","status":"Todo","priority":3,"due":null,"tags":[],"version":1}]}
```

Alice's list carries her task and nothing else. Then the foreign-task table on the wire: Alice probes Bob's task three ways, and every answer is the same 404 with the same body a made-up id gets:

<!-- transcripts: authored -->
```bash
$ curl -s -i -b alice.jar $B/api/v1/tasks/01a13e98-efc9-72f3-85e5-52dd0e9ebaa8 | head -1
HTTP/1.1 404 Not Found
$ curl -s -b alice.jar $B/api/v1/tasks/01a13e98-efc9-72f3-85e5-52dd0e9ebaa8
{"code":"not_found","message":"task not found"}

$ curl -s -i -X PATCH -b alice.jar -H 'Content-Type: application/json' --data '{"version":1,"status":"Done"}' $B/api/v1/tasks/01a13e98-efc9-72f3-85e5-52dd0e9ebaa8 | head -1
HTTP/1.1 404 Not Found
$ curl -s -X PATCH -b alice.jar -H 'Content-Type: application/json' --data '{"version":1,"status":"Done"}' $B/api/v1/tasks/01a13e98-efc9-72f3-85e5-52dd0e9ebaa8
{"code":"not_found","message":"task not found"}

$ curl -s -i -X DELETE -b alice.jar "$B/api/v1/tasks/01a13e98-efc9-72f3-85e5-52dd0e9ebaa8?version=1" | head -1
HTTP/1.1 404 Not Found
$ curl -s -X DELETE -b alice.jar "$B/api/v1/tasks/01a13e98-efc9-72f3-85e5-52dd0e9ebaa8?version=1"
{"code":"not_found","message":"task not found"}
```

An anonymous request gets the check's own 401, and Bob's task is still there, untouched, when he reads it back:

<!-- transcripts: authored -->
```bash
$ curl -s -i $B/api/v1/tasks | head -1
HTTP/1.1 401 Unauthorized
$ curl -s $B/api/v1/tasks
{"code":"unauthorized","message":"authentication required"}

$ curl -s -b bob.jar $B/api/v1/tasks/01a13e98-efc9-72f3-85e5-52dd0e9ebaa8
{"id":"01a13e98-efc9-72f3-85e5-52dd0e9ebaa8","title":"bob's secret plan","status":"Todo","priority":3,"due":null,"tags":["private"],"version":1}
```

The server was stopped, and the local operator ran the grant against the same file. The `todo` binary is the one built earlier for the command line — copy it into the same scratch folder, beside `todo-server` — and `TODO_DB=todo.db` is the value the server was started with, so the command opens the database the server just wrote:

<!-- transcripts: authored -->
```bash
$ TODO_DB=todo.db ./todo admin grant alice@example.com
granted admin to alice@example.com

$ TODO_DB=todo.db ./todo admin grant nobody@example.com
grant admin to nobody@example.com: concurrent transaction: user not found
exit: 1
```

The server came back up, and Alice's next login shows the flag the command wrote:

<!-- transcripts: authored -->
```bash
$ curl -s -X POST -H 'Content-Type: application/json' --data '{"email":"alice@example.com","password":"correct horse battery staple"}' $B/api/v1/auth/login
{"id":"01a13e98-d063-7c95-b041-f75010677b34","email":"alice@example.com","created_at":"2026-10-15T08:06:04Z","is_admin":true}
```

Read back from the same database file — the trail is a table, so anything that can read the database can read it — the trail holds six rows: two registrations, the two logins, the grant, whose actor is empty because the operator is not a user, and the login after the grant:

```bash
register  user=01a13e98-d063-7c95-b041-f75010677b34 actor=01a13e98-d063-7c95-b041-f75010677b34 created=1792051564
register  user=01a13e98-d086-71fe-8339-56bdd2f49a3a actor=01a13e98-d086-71fe-8339-56bdd2f49a3a created=1792051564
login     user=01a13e98-d063-7c95-b041-f75010677b34 actor=01a13e98-d063-7c95-b041-f75010677b34 created=1792051568
login     user=01a13e98-d086-71fe-8339-56bdd2f49a3a actor=01a13e98-d086-71fe-8339-56bdd2f49a3a created=1792051568
grant     user=01a13e98-d063-7c95-b041-f75010677b34 actor=                             created=1792051595
login     user=01a13e98-d063-7c95-b041-f75010677b34 actor=01a13e98-d063-7c95-b041-f75010677b34 created=1792051599
```

Six rows, in the order they happened — the ids are UUIDv7, so they sort by time.

## If something went wrong

**`cannot drop column "owner_id"` — the Down cannot be a `DROP COLUMN`.** The engine refuses the obvious thing twice, in order:

```bash
drop column (index present): turso: error: Parse error: cannot drop column "owner_id": it is referenced in the index tasks_owner_id; position in index is 0, position in table is 6
drop index: <nil>
drop column (index gone): turso: error: Parse error: error in table tasks after drop column: unknown column "owner_id" in foreign key definition
```

The index references the column, so it must go first — and then the foreign key names it, and SQLite will not drop a column a foreign key names. The column can only leave by rebuilding the table, which is what the Down does: the label rows are parked in a temporary table, because dropping the old `tasks` table cascades into `task_tags`. The migrate tests' up-down-up round trip is the receipt that the rebuilt schema is the old one exactly.

**The fixture that seeded the user-less scope — the case that cannot see its own task.** After the handlers start scoping, the task tests come back wrong: a case that expects its seeded task answers `{"tasks":[]}`, and an id case answers the 404 a missing task gets. The fixture seeded through the bare store — the user-less scope — while the routes now serve the test user's scope, so the two disagree about who owns the task. Fix: seed through the scope the routes serve:

<!-- verify: internal/api/tasks_test.go at=authorization -->
```go title="internal/api/tasks_test.go"
func seedTask(t *testing.T, st store.Store, tt task.Task) task.Task {
	t.Helper()
	added, err := st.Scoped(testUserID).Add(context.Background(), tt)
	require.NoError(t, err)
	return added
}
```

The same edit lands in the helper that reads a task back. It is not a test weakening: a task seeded into the user-less scope *should* be invisible to the routes.

**`StoreMock.ScopedFunc: method is nil but Store.Scoped was just called`.** The message:

```bash
StoreMock.ScopedFunc: method is nil but Store.Scoped was just called
```

The handlers call `Scoped` before they list or get, and a mock with no `ScopedFunc` panics on the first call — the panic reaches the client as a 500. Fix: wire the view in every case that uses the mock:

<!-- verify: internal/api/tasks_test.go at=authorization -->
```go title="internal/api/tasks_test.go"
	st := &StoreMock{}
	// The handler scopes the store to the authenticated user before it
	// lists; the view it asks for is this same mock, so the failure below
	// is what the handler sees.
	st.ScopedFunc = func(uuid.UUID) store.Store { return st }
```

The mock follows the interface, not the other way around.

**The grant's miss wears the transaction's wrapper.** An email no user holds, with the command pointed at the same database the server used:

<!-- transcripts: authored -->
```bash
$ TODO_DB=todo.db ./todo admin grant nobody@example.com
grant admin to nobody@example.com: concurrent transaction: user not found
exit: 1
```

The update changes zero rows, the service reads that as "user not found", and the error travels out through the transaction helper, whose wrapper names the transaction the miss was found in. Nothing needs fixing; the exit code and the unchanged database are the parts that matter.

<details>
<summary>Going deeper: why a foreign task is 404, not 403</summary>

403 is the answer HTTP has for "understood, but refused". It is also a worse answer here, because it tells the caller that the id names something. Someone walking through ids learns which ones are real, and a real id is the only thing the next probe needs. A 404 answers exactly what a made-up id answers, so the probe learns nothing. The trade is disclosed: a client that mixed up two users' ids sees "not found" rather than "not yours".

</details>

<details>
<summary>Going deeper: why the scope is a view, not a parameter</summary>

The other design was an owner argument on every store method: `List(ctx, owner)`, `Get(ctx, owner, id)`. Parameters are more explicit at every call site, which is a real virtue — but they change every signature, and they thread a user through paths that have none. The view keeps the interface's shape: one method, the scope chosen once per request. The cost is that a handler which forgets to scope serves the user-less rows instead of failing loudly — which is why the failing table comes first, and why the helper that reads the user's id panics instead of returning the zero value.

</details>

<details>
<summary>Going deeper: why NULL is a scope, not a missing value</summary>

The two alternatives were an owner column that cannot be NULL — which would make the command line's local tasks impossible to represent, and force the migration to invent an owner for every existing row — and an empty-string stand-in, which collides with the foreign key: an empty string is not a user id. SQL's own shape for "a reference that is not there" is NULL, and a foreign key admits it. So the user-less scope is `owner_id IS NULL`: the store the constructors return serves it, and every row that predates the migration stays NULL on purpose.

</details>

<details>
<summary>Going deeper: why the trail is a table, not log lines</summary>

Log lines are for operating the process: they rotate, they are per-run, and their shape is tuned for finding one request in a stream. The trail answers "who did what, when" next to the data it is about: it must outlive any process, survive log rotation, and be written in the same transaction as the action it records. `audit_events` is that table. A failed login records nothing — a deliberate hole: the column names a user, and an unknown email has none. Counting failed attempts is a different job — a counter per address, not a row per user — and it waits for the hardening pass.

</details>

The API serves one user at a time now; next, its routes get a written description that clients can read without the code.
