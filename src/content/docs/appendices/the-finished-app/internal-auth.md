---
title: "internal/auth — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/auth/audit.go`

````go
package auth

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"todo/internal/db"
)

// The audit trail: one row in audit_events per auth happening this chapter
// cares about. Events are recorded where the fact is decided — a
// registration, a grant, and the boot's bootstrap and rotate are the
// service's own transactions and their events ride them, while a login and a
// logout are the HTTP layer's to create and destroy and reach the trail
// through Record. A failed login is not audited: no login happened, and the
// notes carry what that leaves open (a failed-attempt counter is chapter 39's
// rate limiter material, and the column shape here names a user, which an
// unknown email does not have).

// The audited actions. They are the table's vocabulary: one token per
// happening, stored as text, so a reader of the table needs no code.
const (
	// ActionRegister is a user's registration.
	ActionRegister = "register"
	// ActionLogin is a login that produced a session.
	ActionLogin = "login"
	// ActionLogout is a logout that destroyed a session.
	ActionLogout = "logout"
	// ActionGrant is an admin grant by the local operator: the CLI's grant
	// command or the boot's re-assert of a flag that was off.
	ActionGrant = "grant"
	// ActionBootstrap is the boot's creation of the admin account the
	// operator's key seeded.
	ActionBootstrap = "bootstrap"
	// ActionRotate is the boot's replacement of a stored credential the
	// configured key no longer opened.
	ActionRotate = "rotate"
)

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

// Record appends an event to the audit trail. It is how the HTTP layer
// records the happenings the service does not own: a login's session and a
// logout are the API's to create and destroy, so their events arrive here, in
// one concurrent transaction like every other write.
func (s *Service) Record(ctx context.Context, e AuditEvent) error {
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		return insertAudit(ctx, db.New(conn), e)
	})
	if err != nil {
		return fmt.Errorf("record %s event: %w", e.Action, err)
	}
	return nil
}

// insertAudit writes one event through q, the caller's queries: the caller
// runs it inside the transaction its action rides when the action is the
// service's own. The id is a UUIDv7 generated here, so the trail sorts by
// creation time, and the timestamp is truncated to the second like every
// other instant this application stores.
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

// actorSQL maps an actor to the column's shape: the zero uuid.UUID is NULL —
// no user performed the action — and any other id is its canonical text.
func actorSQL(actor uuid.UUID) sql.NullString {
	if actor == uuid.Nil {
		return sql.NullString{}
	}
	return sql.NullString{String: actor.String(), Valid: true}
}
````


## `internal/auth/audit_test.go`

````go
// Package auth_test — the audit cases live in this file, apart from the
// registration, authentication, and session-store cases. The audit trail is
// the durable record of the auth happenings: a table in the same database,
// written by the same transaction discipline as everything else.
package auth_test

import (
	"context"
	"database/sql"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/auth"
)

// auditRow is one audit event as the table stores it. user_id and actor_id
// are nullable: a grant's actor is nobody — the local CLI is not a user —
// and the column shape says so.
type auditRow struct {
	Action  string
	UserID  sql.NullString
	ActorID sql.NullString
}

// auditRows reads the trail in id order. UUIDv7 ids sort by creation time,
// so this is insertion order.
func auditRows(t *testing.T, sqlDB *sql.DB) []auditRow {
	t.Helper()
	rows, err := sqlDB.Query(`SELECT action, user_id, actor_id FROM audit_events ORDER BY id`)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()

	var events []auditRow
	for rows.Next() {
		var e auditRow
		require.NoError(t, rows.Scan(&e.Action, &e.UserID, &e.ActorID))
		events = append(events, e)
	}
	require.NoError(t, rows.Err())
	return events
}

// TestRegister_RecordsAudit pins that a registration writes its own event in
// the same transaction as the user row: the new user is both the subject and
// the actor.
func TestRegister_RecordsAudit(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)

	user, err := svc.Register(context.Background(), "alice@example.com", "correct horse battery staple")
	require.NoError(t, err)

	events := auditRows(t, sqlDB)
	require.Len(t, events, 1)
	assert.Equal(t, auth.ActionRegister, events[0].Action)
	assert.Equal(t, user.ID.String(), events[0].UserID.String)
	assert.Equal(t, user.ID.String(), events[0].ActorID.String, "the user acted on their own account")
}

// TestRecord pins the path the HTTP layer uses for the happenings the service
// does not own: a login and a logout are the API's to create and destroy —
// the service only holds the credentials — and Record is how they reach the
// trail.
func TestRecord(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()
	user, err := svc.Register(ctx, "alice@example.com", "correct horse battery staple")
	require.NoError(t, err)

	require.NoError(t, svc.Record(ctx, auth.AuditEvent{Action: auth.ActionLogin, UserID: user.ID, ActorID: user.ID}))
	require.NoError(t, svc.Record(ctx, auth.AuditEvent{Action: auth.ActionLogout, UserID: user.ID, ActorID: user.ID}))

	events := auditRows(t, sqlDB)
	require.Len(t, events, 3)
	assert.Equal(t, []string{auth.ActionRegister, auth.ActionLogin, auth.ActionLogout},
		[]string{events[0].Action, events[1].Action, events[2].Action})
	for _, e := range events {
		assert.Equal(t, user.ID.String(), e.UserID.String)
	}
}
````


## `internal/auth/auth.go`

````go
// Package auth owns the application's users and sessions: the User type and
// the service that registers and authenticates it, the argon2id password
// hashing the service stores (password.go), the admin bootstrap the server's
// key seeds (bootstrap.go), and the scs session store that keeps session
// payloads in the sessions table (session.go). The HTTP handlers live in
// internal/api; this package is the domain and its storage.
//
// It is deliberately not part of internal/store. The task Store interface
// stays task-focused: users and sessions are not tasks, and widening it would
// drag them into the conformance suite, the generated mocks, and every
// consumer that only wants tasks. This package talks to the database through
// the generated queries in internal/db, and its own small surface is what
// the API depends on.
package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"todo/internal/db"
)

// User is a registered user. PasswordHash is the PHC-encoded argon2id hash
// and never leaves the process: the API's response shape is built from ID,
// Email, CreatedAt, and IsAdmin only.
type User struct {
	// ID is the user's identifier: a UUIDv7, like every row this
	// application writes.
	ID uuid.UUID
	// Email is the user's address in its normalized form: trimmed and
	// lowercased. It is unique across users.
	Email string
	// PasswordHash is the stored credential.
	PasswordHash string
	// CreatedAt is when the user was registered, truncated to the second
	// because that is the precision the column stores.
	CreatedAt time.Time
	// IsAdmin reports whether the user carries the admin flag the CLI's
	// grant command sets. A fresh registration never does.
	IsAdmin bool
}

// ErrEmailTaken is reported when a registration names an email that already
// exists. The API renders it as a 409 with its own code, so a form can put
// the message on the email field.
var ErrEmailTaken = errors.New("email is already registered")

// ErrUserNotFound is reported when an operation names an email no user holds:
// the grant command's miss. The CLI prints it; the API has no route that can
// produce it today.
var ErrUserNotFound = errors.New("user not found")

// ErrInvalidCredentials is reported when a login's email and password do not
// match a user. One sentinel covers both halves — an unknown email and a
// wrong password — on purpose: the caller cannot tell them apart, so the
// endpoint cannot be used to enumerate accounts.
var ErrInvalidCredentials = errors.New("invalid email or password")

// SessionUserID is the session key under which a login stores the
// authenticated user's id. It is the session payload's one key so far;
// chapter 34's RequireUser reads it, and the web UI's flash messages will
// share the same session under keys of their own.
const SessionUserID = "user_id"

// Service registers and authenticates users over the application database.
type Service struct {
	// db is the handle writes ride through db.WithConcurrentTx: every write
	// in this application is a concurrent transaction under MVCC, a
	// registration included.
	db *sql.DB
	// queries runs the generated statements for reads.
	queries *db.Queries
}

// NewService builds the service over the process's database handle. The
// handle is not owned: the store that opened it closes it.
func NewService(sqlDB *sql.DB) *Service {
	return &Service{db: sqlDB, queries: db.New(sqlDB)}
}

// Register creates a user and returns it. The email is normalized first, so
// the same address in any case is one account; the password is hashed with
// argon2id and only the hash is stored. A registration whose email already
// exists fails with ErrEmailTaken — the insert's ON CONFLICT DO NOTHING
// turns the unique constraint into a row count, which keeps the check free
// of a race between "look for the email" and "insert it". The registration's
// audit event rides the same transaction: the user row and the trail's record
// of it land together or not at all, and a duplicate registration writes
// neither.
func (s *Service) Register(ctx context.Context, email, password string) (User, error) {
	email = normalizeEmail(email)
	if email == "" || password == "" {
		// The API's validator is the wire-shape check; this guard is the
		// service refusing to write a row that could never log in. It is a
		// programming error if it fires, so the error is plain.
		return User{}, errors.New("auth: email and password must not be empty")
	}

	id, err := uuid.NewV7()
	if err != nil {
		return User{}, fmt.Errorf("register user: %w", err)
	}
	user := User{
		ID:           id,
		Email:        email,
		PasswordHash: HashPassword(password),
		CreatedAt:    time.Now().UTC().Truncate(time.Second),
	}

	var n int64
	err = db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		var err error
		n, err = q.CreateUser(ctx, db.CreateUserParams{
			ID:           user.ID.String(),
			Email:        user.Email,
			PasswordHash: user.PasswordHash,
			CreatedAt:    user.CreatedAt.Unix(),
		})
		if err != nil || n == 0 {
			// A taken email writes nothing, the trail included.
			return err
		}
		return insertAudit(ctx, q, AuditEvent{Action: ActionRegister, UserID: user.ID, ActorID: user.ID})
	})
	if err != nil {
		return User{}, fmt.Errorf("register user: %w", err)
	}
	if n == 0 {
		return User{}, fmt.Errorf("register user %s: %w", email, ErrEmailTaken)
	}
	return user, nil
}

// GrantAdmin sets the admin flag on the user with the given email and records
// the grant in the audit trail, both in one concurrent transaction: the flag
// and its trail land together or not at all. The email is normalized like
// every other email boundary. An email no user holds fails with
// ErrUserNotFound, read from the update's row count instead of a lookup that
// would race the write; the event's actor is nobody, because the local
// operator runs the command and has no account of their own. The returned
// user is read back inside the same transaction, so the flag it carries is
// the one the update wrote.
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

// Authenticate returns the user whose email and password match, or
// ErrInvalidCredentials. The two failures cost the same: an unknown email is
// verified against a dummy hash before it fails, so timing cannot tell the
// two apart any more than the message can. A stored hash that cannot be
// parsed is an error, not a failed login — a corrupt record is the server's
// problem, and the API answers it with a 500.
func (s *Service) Authenticate(ctx context.Context, email, password string) (User, error) {
	email = normalizeEmail(email)
	row, err := s.queries.GetUserByEmail(ctx, email)
	if errors.Is(err, sql.ErrNoRows) {
		_, _ = VerifyPassword(password, dummyHash) // discarded: the work is the point
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("authenticate %s: %w", email, err)
	}

	user, err := userFromRow(row)
	if err != nil {
		return User{}, fmt.Errorf("authenticate %s: %w", email, err)
	}
	ok, err := VerifyPassword(password, user.PasswordHash)
	if err != nil {
		return User{}, fmt.Errorf("authenticate %s: %w", email, err)
	}
	if !ok {
		return User{}, ErrInvalidCredentials
	}
	return user, nil
}

// UserByID returns the user with the given id, or ErrUserNotFound. It is the
// admin gate's lookup (see internal/api's RequireAdmin): the profile routes
// are reachable only by a user whose flag says so, and the flag is read from
// the database on every gate, so a grant or a revoke takes effect on the
// next request rather than the next login. A session naming an id no user
// holds is a corrupt session — the API answers it like a missing one — and
// nothing in this application deletes users, so ErrUserNotFound here means
// exactly that.
func (s *Service) UserByID(ctx context.Context, id uuid.UUID) (User, error) {
	row, err := s.queries.GetUserByID(ctx, id.String())
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, fmt.Errorf("user %s: %w", id, ErrUserNotFound)
	}
	if err != nil {
		return User{}, fmt.Errorf("get user %s: %w", id, err)
	}
	user, err := userFromRow(row)
	if err != nil {
		return User{}, fmt.Errorf("get user %s: %w", id, err)
	}
	return user, nil
}

// normalizeEmail is the one place the email's stored form is decided: trimmed
// and lowercased. The users table's UNIQUE constraint compares TEXT byte for
// byte, so normalizing at every boundary is what makes "Alice@example.com"
// and "alice@example.com" the same account.
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// userFromRow maps one generated row to a domain user. The generated type is
// a database shape — string id, unix seconds, the flag as an integer — and
// this is the boundary where it becomes a User.
func userFromRow(row db.User) (User, error) {
	id, err := uuid.Parse(row.ID)
	if err != nil {
		return User{}, fmt.Errorf("parse id %q: %w", row.ID, err)
	}
	return User{
		ID:           id,
		Email:        row.Email,
		PasswordHash: row.PasswordHash,
		CreatedAt:    time.Unix(row.CreatedAt, 0).UTC(),
		IsAdmin:      row.IsAdmin != 0,
	}, nil
}
````


## `internal/auth/bootstrap.go`

````go
package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"todo/internal/db"
	"todo/internal/secret"
)

// The admin bootstrap: the deployment names an account and a key — through
// TODO_ADMIN_KEY or TODO_ADMIN_KEY_FILE, loaded by internal/secret — and the
// boot ensures the credential exists, carries the admin flag, and is opened
// by that key. It is the server's own way to a first admin, the one the CLI's
// grant command cannot be for a process that never runs the CLI.
//
// The stored form is the PHC-encoded argon2id hash every password gets (see
// password.go): the key is hashed on the way in, the clear value never
// reaches a statement, and a database leak hands over a hash to crack rather
// than a credential to replay. The key itself is a secret.Secret until the
// two places this file needs the bytes — and those two Reveal calls are the
// whole list.

// BootstrapResult is what one BootstrapAdmin call changed. The three facts
// are separate because the boot reports them separately: an operator reading
// the record wants to know whether the account was created, whether its
// stored credential was replaced, and whether the admin flag was set — and a
// boot that changed nothing says so by leaving all three false.
type BootstrapResult struct {
	// Created reports the account did not exist and was created.
	Created bool
	// Rotated reports the stored credential did not open with the key and
	// was replaced.
	Rotated bool
	// Granted reports the admin flag was off and was set.
	Granted bool
}

// BootstrapAdmin ensures the admin credential the deployment named. It runs
// once at boot, from main, before the server accepts a request.
//
// The semantics, in the order they are decided:
//
//   - the account does not exist: it is created with the key as its
//     credential, the admin flag set, and one bootstrap event in the trail;
//   - it exists and the key opens the stored hash: nothing is written except
//     the flag when it is off (a grant event, the same one the CLI's grant
//     records) — a boot that changed nothing writes nothing at all;
//   - it exists and the key does not open the stored hash: the stored
//     credential is replaced with a hash of the key (a rotate event). While
//     the key is configured it is the authority over this one account, which
//     is what makes rotation one step — set the new key and restart — instead
//     of a credential nothing in this application can change. A boot that
//     refused on a mismatch would leave rotation with no path at all; the
//     price, recorded in the notes, is that a key that changed without the
//     operator meaning to is a rotation rather than an error, and the trail
//     and the boot record are where that shows.
//
// A stored hash that cannot be parsed is the one failure that is not a
// rotation: a corrupt record is the server's problem, and overwriting the
// evidence would hide it. The boot refuses instead.
//
// An empty key or an email that normalizes to nothing is a programming
// error, not a runtime condition: main does not call this without both.
func (s *Service) BootstrapAdmin(ctx context.Context, email string, key secret.Secret) (BootstrapResult, error) {
	email = normalizeEmail(email)
	if email == "" {
		return BootstrapResult{}, errors.New("auth: email must not be empty")
	}
	if key.IsEmpty() {
		return BootstrapResult{}, errors.New("auth: key must not be empty")
	}

	var out BootstrapResult
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		q := db.New(conn)
		row, err := q.GetUserByEmail(ctx, email)
		if errors.Is(err, sql.ErrNoRows) {
			return createBootstrappedAdmin(ctx, q, email, key, &out)
		}
		if err != nil {
			return err
		}
		return ensureBootstrappedAdmin(ctx, q, row, email, key, &out)
	})
	if err != nil {
		return BootstrapResult{}, fmt.Errorf("bootstrap admin %s: %w", email, err)
	}
	return out, nil
}

// createBootstrappedAdmin creates the account, hashes the key, sets the flag,
// and records the bootstrap event — one transaction, all of it or none.
func createBootstrappedAdmin(ctx context.Context, q *db.Queries, email string, key secret.Secret, out *BootstrapResult) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	n, err := q.CreateUser(ctx, db.CreateUserParams{
		ID:           id.String(),
		Email:        email,
		PasswordHash: HashPassword(key.Reveal()),
		CreatedAt:    time.Now().UTC().Truncate(time.Second).Unix(),
	})
	if err != nil {
		return err
	}
	if n == 0 {
		// A registration for the same email committed between this
		// transaction's snapshot and its insert — the row the read did not
		// see. The error is plain rather than a sentinel: the caller cannot
		// do anything different from a taken email, and the next boot takes
		// the ensure path.
		return fmt.Errorf("create %s: %w", email, ErrEmailTaken)
	}
	if _, err := q.SetUserAdmin(ctx, db.SetUserAdminParams{IsAdmin: 1, Email: email}); err != nil {
		return err
	}
	*out = BootstrapResult{Created: true, Granted: true}
	return insertAudit(ctx, q, AuditEvent{Action: ActionBootstrap, UserID: id})
}

// ensureBootstrappedAdmin verifies the key against the stored hash and
// repairs what it finds: a hash the key does not open is rotated, and a flag
// that is off is granted. Each repair records its own event; a call that
// repairs nothing records nothing.
func ensureBootstrappedAdmin(ctx context.Context, q *db.Queries, row db.User, email string, key secret.Secret, out *BootstrapResult) error {
	user, err := userFromRow(row)
	if err != nil {
		return err
	}

	ok, err := VerifyPassword(key.Reveal(), user.PasswordHash)
	if err != nil {
		return err
	}
	if !ok {
		n, err := q.SetUserPassword(ctx, db.SetUserPasswordParams{
			PasswordHash: HashPassword(key.Reveal()),
			Email:        email,
		})
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrUserNotFound
		}
		out.Rotated = true
		if err := insertAudit(ctx, q, AuditEvent{Action: ActionRotate, UserID: user.ID}); err != nil {
			return err
		}
	}

	if !user.IsAdmin {
		if _, err := q.SetUserAdmin(ctx, db.SetUserAdminParams{IsAdmin: 1, Email: email}); err != nil {
			return err
		}
		out.Granted = true
		if err := insertAudit(ctx, q, AuditEvent{Action: ActionGrant, UserID: user.ID}); err != nil {
			return err
		}
	}
	return nil
}
````


## `internal/auth/bootstrap_test.go`

````go
// Package auth_test — the bootstrap cases live in this file, apart from the
// registration, authentication, audit, and session-store cases. The bootstrap
// is the server's own way to an admin: the deployment names an account and a
// key, and the boot ensures the credential exists, carries the flag, and is
// opened by that key — stored as a hash like every password.
package auth_test

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/auth"
	"todo/internal/secret"
)

// bootstrapKey is the chapter's key: long enough to look like one, and never
// stored. The cases assert against the table, not against the value.
const bootstrapKey = "todo-admin-key-8d2f1c-never-in-the-database"

// assertKeyNowhere sweeps every table's every column for the key's bytes.
// "Only the hash is stored" is a claim about the whole database, not about
// one column: the sweep is what makes it one — a future writer that put the
// key into some other row fails this case wherever that row is.
func assertKeyNowhere(t *testing.T, sqlDB *sql.DB, key secret.Secret) {
	t.Helper()

	rows, err := sqlDB.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	require.NoError(t, err)
	var tables []string
	for rows.Next() {
		var name string
		require.NoError(t, rows.Scan(&name))
		tables = append(tables, name)
	}
	require.NoError(t, rows.Err())
	require.NoError(t, rows.Close())
	require.NotEmpty(t, tables, "the sweep must have tables to read")

	for _, table := range tables {
		assertTableHasNo(t, sqlDB, table, key.Reveal())
	}
}

// assertTableHasNo reads every row of one table and fails if any column
// carries the value. Columns arrive as strings, bytes, or numbers depending
// on the driver's mood; bytes are decoded so a leak cannot hide behind a
// numeric-looking %v of a byte slice.
func assertTableHasNo(t *testing.T, sqlDB *sql.DB, table, value string) {
	t.Helper()

	// #nosec G202 -- table names come from sqlite_master, this database's own catalogue
	rows, err := sqlDB.Query(`SELECT * FROM "` + table + `"`)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()

	cols, err := rows.Columns()
	require.NoError(t, err)
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		require.NoError(t, rows.Scan(ptrs...))
		for i, v := range values {
			var text string
			switch v := v.(type) {
			case nil:
				continue
			case []byte:
				text = string(v)
			case string:
				text = v
			default:
				text = fmt.Sprintf("%v", v)
			}
			assert.NotContains(t, text, value, "%s.%s holds the clear key", table, cols[i])
		}
	}
	require.NoError(t, rows.Err())
}

// TestBootstrapAdmin_Creates pins the first boot over a fresh database: the
// account exists, it is an admin, and its stored credential is an argon2id
// hash of the key — the clear key is in no table, and the trail records the
// boot with nobody as the actor.
func TestBootstrapAdmin_Creates(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)

	res, err := svc.BootstrapAdmin(context.Background(), "  Admin@Example.COM ", secret.Secret(bootstrapKey))
	require.NoError(t, err)
	assert.Equal(t, auth.BootstrapResult{Created: true, Granted: true}, res)

	var (
		email   string
		isAdmin int
		hash    string
	)
	require.NoError(t, sqlDB.QueryRow(`SELECT email, is_admin, password_hash FROM users`).Scan(&email, &isAdmin, &hash))
	assert.Equal(t, "admin@example.com", email, "the email is normalized like every other boundary")
	assert.Equal(t, 1, isAdmin)
	assert.NotEqual(t, bootstrapKey, hash)
	assert.True(t, strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$"),
		"the stored credential is the PHC-encoded hash, got %q", hash)

	ok, err := auth.VerifyPassword(bootstrapKey, hash)
	require.NoError(t, err)
	assert.True(t, ok, "the key opens the stored hash")

	assertKeyNowhere(t, sqlDB, secret.Secret(bootstrapKey))

	events := auditRows(t, sqlDB)
	require.Len(t, events, 1)
	assert.Equal(t, auth.ActionBootstrap, events[0].Action)
	assert.False(t, events[0].ActorID.Valid, "the operator's secret is not a user")
}

// TestBootstrapAdmin_Idempotent pins the second boot: the key opens the
// stored hash and the flag is already set, so nothing is written — the hash
// is byte-identical and the trail gains no row.
func TestBootstrapAdmin_Idempotent(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()

	_, err := svc.BootstrapAdmin(ctx, "admin@example.com", secret.Secret(bootstrapKey))
	require.NoError(t, err)
	var first string
	require.NoError(t, sqlDB.QueryRow(`SELECT password_hash FROM users`).Scan(&first))

	res, err := svc.BootstrapAdmin(ctx, "admin@example.com", secret.Secret(bootstrapKey))
	require.NoError(t, err)
	assert.Equal(t, auth.BootstrapResult{}, res, "a boot that changed nothing says so")

	var second string
	require.NoError(t, sqlDB.QueryRow(`SELECT password_hash FROM users`).Scan(&second))
	assert.Equal(t, first, second, "the stored hash is not rewritten: a fresh salt would change it")

	assert.Len(t, auditRows(t, sqlDB), 1, "the trail gains nothing when nothing changed")
}

// TestBootstrapAdmin_Rotates pins the changed key: a key the stored hash does
// not open replaces the credential — the rotation — and the trail records it.
// The account was a normal registration first: the deployment's key takes the
// account over, which is the direction the authority has to point.
func TestBootstrapAdmin_Rotates(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()

	_, err := svc.Register(ctx, "admin@example.com", "the password nobody remembers")
	require.NoError(t, err)

	res, err := svc.BootstrapAdmin(ctx, "admin@example.com", secret.Secret(bootstrapKey))
	require.NoError(t, err)
	assert.Equal(t, auth.BootstrapResult{Rotated: true, Granted: true}, res)

	// The old password is refused and the key authenticates.
	_, err = svc.Authenticate(ctx, "admin@example.com", "the password nobody remembers")
	require.ErrorIs(t, err, auth.ErrInvalidCredentials)
	user, err := svc.Authenticate(ctx, "admin@example.com", bootstrapKey)
	require.NoError(t, err)
	assert.True(t, user.IsAdmin)

	assertKeyNowhere(t, sqlDB, secret.Secret(bootstrapKey))

	events := auditRows(t, sqlDB)
	require.Len(t, events, 3)
	assert.Equal(t, []string{auth.ActionRegister, auth.ActionRotate, auth.ActionGrant},
		[]string{events[0].Action, events[1].Action, events[2].Action})
}

// TestBootstrapAdmin_Regrants pins the flag repair: a key that opens the
// stored hash with the flag off sets the flag and records the same grant the
// CLI records — and nothing else changes.
func TestBootstrapAdmin_Regrants(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()

	// The account was registered with the key as its password — the seed a
	// hand-made deployment would produce — but nothing granted the flag.
	user, err := svc.Register(ctx, "admin@example.com", bootstrapKey)
	require.NoError(t, err)
	require.False(t, user.IsAdmin)

	res, err := svc.BootstrapAdmin(ctx, "admin@example.com", secret.Secret(bootstrapKey))
	require.NoError(t, err)
	assert.Equal(t, auth.BootstrapResult{Granted: true}, res, "the key already opened the account; only the flag changed")

	got, err := svc.UserByID(ctx, user.ID)
	require.NoError(t, err)
	assert.True(t, got.IsAdmin)

	events := auditRows(t, sqlDB)
	require.Len(t, events, 2)
	assert.Equal(t, auth.ActionRegister, events[0].Action)
	assert.Equal(t, auth.ActionGrant, events[1].Action)
}

// TestBootstrapAdmin_CorruptStoredHash pins the one failure that is not a
// rotation: a stored hash that cannot be parsed is a corrupt record, and the
// boot refuses instead of overwriting the evidence.
func TestBootstrapAdmin_CorruptStoredHash(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()

	_, err := svc.Register(ctx, "admin@example.com", "a password")
	require.NoError(t, err)
	_, err = sqlDB.Exec(`UPDATE users SET password_hash = 'not-a-hash' WHERE email = 'admin@example.com'`)
	require.NoError(t, err)

	_, err = svc.BootstrapAdmin(ctx, "admin@example.com", secret.Secret(bootstrapKey))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "argon2id")
}

// TestBootstrapAdmin_Input pins the guards: an email that normalizes to
// nothing and an empty key are errors, and neither writes anything.
func TestBootstrapAdmin_Input(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()

	_, err := svc.BootstrapAdmin(ctx, "   ", secret.Secret(bootstrapKey))
	require.Error(t, err)
	_, err = svc.BootstrapAdmin(ctx, "admin@example.com", secret.Secret(""))
	require.Error(t, err)

	var n int
	require.NoError(t, sqlDB.QueryRow(`SELECT count(*) FROM users`).Scan(&n))
	assert.Zero(t, n)
	assert.Empty(t, auditRows(t, sqlDB))
}
````


## `internal/auth/password.go`

````go
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Password hashing: argon2id, the PHC string format, and constant-time
// verification.
//
// The stored form is a PHC string —
//
//	$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
//
// — which carries the algorithm, the version, the cost parameters, the salt,
// and the key in one self-describing value. Nothing about the hash needs a
// second column or a constant to be read back: VerifyPassword parses the cost
// out of the string it is given, so raising the cost parameters later leaves
// every stored hash verifiable, and only new passwords pay the new price.

// The argon2id cost parameters, in one place because they are one decision.
//
// memory is the memory cost in KiB: 19 MiB, the baseline OWASP's Password
// Storage Cheat Sheet names for argon2id (m=19456, t=2, p=1). Memory is the
// point of the algorithm — a guess costs the attacker that much RAM, which is
// what makes GPUs and ASICs poor at it — and 19 MiB keeps a small deployment
// able to hash several logins at once without swapping.
//
// iterations is the time cost: two passes over that memory. threads is the
// degree of parallelism: one, because this server's concurrency already comes
// from serving several requests at once — letting each hash claim cores too
// would multiply the memory in flight without lengthening the attacker's work
// per guess.
//
// The parameters travel in every hash (see HashPassword), so these constants
// are safe to raise: old hashes keep verifying under the parameters they were
// made with, and the encoding test is what makes a change visible.
const (
	argonMemory  uint32 = 19456 // KiB, 19 MiB
	argonTime    uint32 = 2
	argonThreads uint8  = 1
	argonSaltLen        = 16
	argonKeyLen  uint32 = 32
)

// The parse bounds: a hash whose parameters fall outside them is rejected
// before the verifier allocates anything. The stored string is the
// application's own record, but a corrupt or tampered row must not be able to
// make a request allocate a gigabyte or spin for an hour.
const (
	minArgonMemory  = 8 // KiB
	maxArgonMemory  = 1 << 20
	maxArgonTime    = 10
	maxArgonThreads = 255
	maxArgonKey     = 64 // bytes
)

// argonParams is the cost read back out of an encoded hash.
type argonParams struct {
	memory  uint32
	time    uint32
	threads uint8
}

// defaultArgonParams returns the parameters new hashes are made with.
func defaultArgonParams() argonParams {
	return argonParams{memory: argonMemory, time: argonTime, threads: argonThreads}
}

// HashPassword hashes password with argon2id and returns the PHC-encoded
// string. Every call draws a fresh 16-byte salt from crypto/rand, so two
// hashes of the same password differ.
//
// There is no error to report: crypto/rand.Read never returns one in this Go
// — it crashes the process irrecoverably if the system source fails — and a
// signature that carried an error would be dead code in every caller.
func HashPassword(password string) string {
	salt := make([]byte, argonSaltLen)
	rand.Read(salt)
	return encodeHash(password, salt, defaultArgonParams())
}

// VerifyPassword reports whether password matches the PHC-encoded argon2id
// hash. The cost parameters are parsed from the encoding, so a hash made
// under older parameters keeps verifying after the constants change. The
// comparison is constant-time: a byte-by-byte compare that returned early
// would leak, through timing, how much of a guess was right.
//
// A malformed encoding is an error, not a false: the caller must be able to
// tell "wrong password" from "corrupt record", because the two deserve
// different answers — a 401 and a 500.
func VerifyPassword(password, encoded string) (bool, error) {
	p, salt, want, err := parseHash(encoded)
	if err != nil {
		return false, fmt.Errorf("verify password: %w", err)
	}
	// #nosec G115 -- parseHash bounds the decoded key to [16, maxArgonKey]
	// bytes, so the conversion cannot overflow.
	got := argon2.IDKey([]byte(password), salt, p.time, p.memory, p.threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is what Authenticate verifies when no user matched, so the
// missing-account path costs what the wrong-password path costs and the
// endpoint's timing cannot be used to enumerate emails. The salt is a fixed,
// public constant and the result is discarded: this hash authenticates
// nobody, its only job is to spend the work. It is built once, at package
// initialization, from the same encoder every stored hash uses.
var dummyHash = encodeHash("no such user", []byte("todo-dummy-salt!"), defaultArgonParams())

// encodeHash runs argon2id and formats the result as a PHC string. salt and
// key are encoded in unpadded standard base64, which is what the PHC string
// format defines.
func encodeHash(password string, salt []byte, p argonParams) string {
	key := argon2.IDKey([]byte(password), salt, p.time, p.memory, p.threads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.memory, p.time, p.threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
}

// parseHash reads the parameters, salt, and key back out of an encoded hash,
// validating each before anything is allocated with it.
func parseHash(encoded string) (argonParams, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" {
		return argonParams{}, nil, nil, errors.New("not an argon2id hash")
	}

	var version uint32
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return argonParams{}, nil, nil, fmt.Errorf("unsupported version %q", parts[2])
	}

	var memory, timeCost, threads uint32
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &timeCost, &threads); err != nil {
		return argonParams{}, nil, nil, fmt.Errorf("unreadable parameters %q", parts[3])
	}
	if memory < minArgonMemory || memory > maxArgonMemory {
		return argonParams{}, nil, nil, fmt.Errorf("memory cost %d out of range", memory)
	}
	if timeCost < 1 || timeCost > maxArgonTime {
		return argonParams{}, nil, nil, fmt.Errorf("time cost %d out of range", timeCost)
	}
	if threads < 1 || threads > maxArgonThreads {
		return argonParams{}, nil, nil, fmt.Errorf("parallelism %d out of range", threads)
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return argonParams{}, nil, nil, fmt.Errorf("salt is not base64: %w", err)
	}
	if len(salt) < 8 {
		return argonParams{}, nil, nil, fmt.Errorf("salt is %d bytes", len(salt))
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return argonParams{}, nil, nil, fmt.Errorf("key is not base64: %w", err)
	}
	if len(key) < 16 || len(key) > maxArgonKey {
		return argonParams{}, nil, nil, fmt.Errorf("key is %d bytes", len(key))
	}

	return argonParams{memory: memory, time: timeCost, threads: uint8(threads)}, salt, key, nil
}
````


## `internal/auth/password_test.go`

````go
// Package auth_test exercises the auth package through its exported
// contract: the password hashing pair, the user service, and the session
// store scs writes through. Every case runs against a real database — the
// schema, the SQL, and the hashing are what the package is.
package auth_test

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/argon2"

	"todo/internal/auth"
)

// TestHashPassword_RoundTrip pins the encode/verify pair: the right password
// verifies, a different one does not, and two hashes of the same password
// differ because each carries its own salt.
func TestHashPassword_RoundTrip(t *testing.T) {
	t.Parallel()

	encoded := auth.HashPassword("correct horse battery staple")

	ok, err := auth.VerifyPassword("correct horse battery staple", encoded)
	require.NoError(t, err)
	assert.True(t, ok, "the right password verifies")

	ok, err = auth.VerifyPassword("Correct horse battery staple", encoded)
	require.NoError(t, err)
	assert.False(t, ok, "the compare is exact")

	again := auth.HashPassword("correct horse battery staple")
	assert.NotEqual(t, encoded, again, "each hash carries its own salt")
	ok, err = auth.VerifyPassword("correct horse battery staple", again)
	require.NoError(t, err)
	assert.True(t, ok)
}

// TestHashPassword_Encoding pins the encoded form: a PHC string carrying the
// algorithm, the version, and the cost parameters. The parameters are a
// decision the encoding records, so a change to the constants is a change to
// this test — on purpose.
func TestHashPassword_Encoding(t *testing.T) {
	t.Parallel()

	encoded := auth.HashPassword("hunter2hunter2")

	parts := strings.Split(encoded, "$")
	require.Len(t, parts, 6, "the PHC string has six fields")
	assert.Equal(t, "", parts[0])
	assert.Equal(t, "argon2id", parts[1])
	assert.Equal(t, "v=19", parts[2])
	assert.Equal(t, "m=19456,t=2,p=1", parts[3], "the cost parameters travel with the hash")
	assert.Len(t, parts[4], 22, "a 16-byte salt in unpadded base64")
	assert.Len(t, parts[5], 43, "a 32-byte key in unpadded base64")
}

// TestVerifyPassword_Errors pins the malformed-input contract: a string that
// is not a PHC-encoded argon2id hash is an error, not a false — the caller
// must be able to tell "wrong password" from "corrupt record".
func TestVerifyPassword_Errors(t *testing.T) {
	t.Parallel()

	for _, encoded := range []string{
		"",
		"not a hash",
		"$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo",
		"$argon2id$v=13$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo",
		"$argon2id$v=19$m=19456,t=2$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo",
		"$argon2id$v=19$m=19456,t=2,p=1$not base64!$aGFzaA",
		"$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$",
		"$argon2id$v=19$m=999999999,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo",
	} {
		ok, err := auth.VerifyPassword("whatever", encoded)
		assert.Error(t, err, "encoded: %q", encoded)
		assert.False(t, ok, "encoded: %q", encoded)
	}
}

// TestVerifyPassword_UsesEncodedParams pins the forward-compatibility rule:
// the parameters come from the encoding, not from the current constants, so
// a hash made under older parameters keeps verifying after the constants
// change. The test builds a hash with a different cost by hand.
func TestVerifyPassword_UsesEncodedParams(t *testing.T) {
	t.Parallel()

	salt := []byte("0123456789abcdef")
	key := argon2.IDKey([]byte("old password"), salt, 1, 8*1024, 1, 32)
	encoded := "$argon2id$v=19$m=8192,t=1,p=1$" +
		base64.RawStdEncoding.EncodeToString(salt) + "$" +
		base64.RawStdEncoding.EncodeToString(key)

	ok, err := auth.VerifyPassword("old password", encoded)
	require.NoError(t, err)
	assert.True(t, ok, "the hash verifies under the parameters it was made with")

	ok, err = auth.VerifyPassword("new password", encoded)
	require.NoError(t, err)
	assert.False(t, ok)
}
````


## `internal/auth/service_test.go`

````go
package auth_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	_ "turso.tech/database/tursogo" // registers the "turso" driver with database/sql

	"todo/internal/auth"
	"todo/internal/db"
)

// openTestDB opens a fresh Turso database inside a test-owned directory, in
// the mode the store serves in: MVCC first, then the embedded migrations —
// the store's own open order. The auth package's writes ride BEGIN
// CONCURRENT, which the engine only accepts under MVCC, so a helper that
// skipped the pragma would fail every write with the engine saying so.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	sqlDB, err := sql.Open("turso", filepath.Join(t.TempDir(), "auth.db")+"?_busy_timeout=5000")
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })

	var mode string
	require.NoError(t, sqlDB.QueryRow(`PRAGMA journal_mode = mvcc`).Scan(&mode))
	require.Equal(t, "mvcc", mode)
	require.NoError(t, db.Up(context.Background(), sqlDB))
	return sqlDB
}

// TestRegister pins what a registration produces: a v7 id, the normalized
// email, a stored hash that is not the password, and a creation time. The
// stored hash is read back from the table, not from the returned value,
// because the table is what a leak would expose.
func TestRegister(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)

	user, err := svc.Register(context.Background(), "  Alice@Example.COM ", "correct horse battery staple")
	require.NoError(t, err)

	assert.Equal(t, uuid.Version(7), user.ID.Version(), "ids are v7, like every other row this app writes")
	assert.Equal(t, "alice@example.com", user.Email, "the email is trimmed and lowercased")
	assert.WithinDuration(t, time.Now(), user.CreatedAt, time.Minute)

	var stored string
	require.NoError(t, sqlDB.QueryRow(`SELECT password_hash FROM users WHERE email = ?`, "alice@example.com").Scan(&stored))
	assert.NotEqual(t, "correct horse battery staple", stored)
	assert.True(t, strings.HasPrefix(stored, "$argon2id$v=19$m=19456,t=2,p=1$"), "the column holds the PHC-encoded hash, got %q", stored)
	assert.Equal(t, stored, user.PasswordHash)
}

// TestRegister_DuplicateEmail pins the unique constraint as a sentinel: a
// second registration for the same email — in any case, because the service
// normalizes first — fails with ErrEmailTaken.
func TestRegister_DuplicateEmail(t *testing.T) {
	t.Parallel()

	svc := auth.NewService(openTestDB(t))
	ctx := context.Background()

	_, err := svc.Register(ctx, "alice@example.com", "correct horse battery staple")
	require.NoError(t, err)

	_, err = svc.Register(ctx, "ALICE@example.com", "another long password")
	require.ErrorIs(t, err, auth.ErrEmailTaken)
}

// TestAuthenticate pins the happy path and both failure modes. A wrong
// password and an unknown email are the same sentinel and the same message:
// the client cannot learn which half was wrong, so the endpoint cannot be
// used to enumerate accounts.
func TestAuthenticate(t *testing.T) {
	t.Parallel()

	svc := auth.NewService(openTestDB(t))
	ctx := context.Background()
	registered, err := svc.Register(ctx, "alice@example.com", "correct horse battery staple")
	require.NoError(t, err)

	t.Run("the right password authenticates", func(t *testing.T) {
		user, err := svc.Authenticate(ctx, "alice@example.com", "correct horse battery staple")
		require.NoError(t, err)
		assert.Equal(t, registered.ID, user.ID)
		assert.Equal(t, registered.Email, user.Email)
	})

	t.Run("the email lookup is case-insensitive", func(t *testing.T) {
		user, err := svc.Authenticate(ctx, "  ALICE@example.com ", "correct horse battery staple")
		require.NoError(t, err)
		assert.Equal(t, registered.ID, user.ID)
	})

	t.Run("a wrong password is ErrInvalidCredentials", func(t *testing.T) {
		_, err := svc.Authenticate(ctx, "alice@example.com", "wrong password")
		require.ErrorIs(t, err, auth.ErrInvalidCredentials)
	})

	t.Run("an unknown email is ErrInvalidCredentials", func(t *testing.T) {
		_, err := svc.Authenticate(ctx, "nobody@example.com", "correct horse battery staple")
		require.ErrorIs(t, err, auth.ErrInvalidCredentials)
	})
}

// TestGrantAdmin pins the operator's grant: the flag lands on the user and
// the returned value carries it, the email is normalized like every other
// email boundary, an unknown email is ErrUserNotFound — and the grant leaves
// an audit event whose actor is nobody, because the local CLI is not a user.
func TestGrantAdmin(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()
	user, err := svc.Register(ctx, "alice@example.com", "correct horse battery staple")
	require.NoError(t, err)
	require.False(t, user.IsAdmin, "a fresh registration is not an admin")

	granted, err := svc.GrantAdmin(ctx, "  Alice@Example.COM ")
	require.NoError(t, err)
	assert.Equal(t, user.ID, granted.ID)
	assert.Equal(t, "alice@example.com", granted.Email)
	assert.True(t, granted.IsAdmin, "the returned user carries the flag")

	// The column is the truth, not the returned value.
	var isAdmin int
	require.NoError(t, sqlDB.QueryRow(`SELECT is_admin FROM users WHERE email = ?`, "alice@example.com").Scan(&isAdmin))
	assert.Equal(t, 1, isAdmin)

	// The registration and the grant are the trail, in that order, and the
	// grant's actor is nobody: the operator is not a user.
	events := auditRows(t, sqlDB)
	require.Len(t, events, 2)
	assert.Equal(t, auth.ActionRegister, events[0].Action)
	assert.Equal(t, auth.ActionGrant, events[1].Action)
	assert.Equal(t, user.ID.String(), events[1].UserID.String)
	assert.False(t, events[1].ActorID.Valid, "the local CLI is not a user")

	// An unknown email is the sentinel, and nothing is written.
	_, err = svc.GrantAdmin(ctx, "nobody@example.com")
	require.ErrorIs(t, err, auth.ErrUserNotFound)
	assert.Len(t, auditRows(t, sqlDB), 2, "a failed grant records nothing")
}

// TestUserByID pins the admin gate's lookup: a registered user comes back by
// id — the flag included, since that is the value the gate reads — and an id
// no user holds is ErrUserNotFound.
func TestUserByID(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	svc := auth.NewService(sqlDB)
	ctx := context.Background()
	user, err := svc.Register(ctx, "alice@example.com", "correct horse battery staple")
	require.NoError(t, err)
	_, err = svc.GrantAdmin(ctx, "alice@example.com")
	require.NoError(t, err)

	got, err := svc.UserByID(ctx, user.ID)
	require.NoError(t, err)
	assert.Equal(t, user.ID, got.ID)
	assert.Equal(t, "alice@example.com", got.Email)
	assert.True(t, got.IsAdmin, "the gate reads the flag from this lookup")

	_, err = svc.UserByID(ctx, uuid.New())
	require.ErrorIs(t, err, auth.ErrUserNotFound)
}
````


## `internal/auth/session.go`

````go
package auth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/alexedwards/scs/v2"

	"todo/internal/db"
)

// SessionStore is the session store scs writes through: an implementation of
// scs.Store over the sessions table, and of scs.CtxStore — the context-aware
// set scs prefers when it is there — so every query runs under the request's
// context and its deadline.
//
// The key at rest is a hash, never the token itself. scs hands this store the
// raw token from the client's cookie; hashToken turns it into the row key,
// and the raw value reaches nothing but the Set-Cookie header the middleware
// writes. A database copy therefore hands a reader no session it can replay.
type SessionStore struct {
	// db is the handle writes ride through db.WithConcurrentTx, like every
	// other write in the application.
	db *sql.DB
	// queries runs the generated statements for reads.
	queries *db.Queries
}

// The store must satisfy the interface scs holds it by, and the optional
// context-aware set scs prefers when it is there.
var (
	_ scs.Store    = (*SessionStore)(nil)
	_ scs.CtxStore = (*SessionStore)(nil)
)

// NewSessionStore builds the store over the process's database handle. The
// handle is not owned: the store that opened it closes it.
func NewSessionStore(sqlDB *sql.DB) *SessionStore {
	return &SessionStore{db: sqlDB, queries: db.New(sqlDB)}
}

// FindCtx implements scs.CtxStore: it returns the payload of a live session,
// found false for a token nothing holds or one whose expiry has passed, and
// an error only for a system failure. The expiry predicate is in the query,
// so an expired row is invisible before any sweep runs.
func (s *SessionStore) FindCtx(ctx context.Context, token string) ([]byte, bool, error) {
	data, err := s.queries.FindSession(ctx, db.FindSessionParams{
		TokenHash: hashToken(token),
		Expiry:    time.Now().Unix(),
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("find session: %w", err)
	}
	return data, true, nil
}

// Find implements scs.Store. scs calls FindCtx at runtime — the interface
// method exists because scs.Store declares it, and a caller that holds only
// the interface gets the same answers on a background context.
func (s *SessionStore) Find(token string) ([]byte, bool, error) {
	return s.FindCtx(context.Background(), token)
}

// CommitCtx implements scs.CtxStore: it writes the session payload under the
// hashed token, replacing the data and expiry of a row that already exists.
// The write rides a concurrent transaction like every other write, so a
// session commit never stalls another writer's.
func (s *SessionStore) CommitCtx(ctx context.Context, token string, data []byte, expiry time.Time) error {
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		return db.New(conn).UpsertSession(ctx, db.UpsertSessionParams{
			TokenHash: hashToken(token),
			Data:      data,
			Expiry:    expiry.Unix(),
		})
	})
	if err != nil {
		return fmt.Errorf("commit session: %w", err)
	}
	return nil
}

// Commit implements scs.Store. See Find for why both forms exist.
func (s *SessionStore) Commit(token string, data []byte, expiry time.Time) error {
	return s.CommitCtx(context.Background(), token, data, expiry)
}

// DeleteCtx implements scs.CtxStore. Deleting a token nothing holds is a
// no-op that returns nil, which is what scs's Store contract asks for.
func (s *SessionStore) DeleteCtx(ctx context.Context, token string) error {
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		return db.New(conn).DeleteSession(ctx, hashToken(token))
	})
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// Delete implements scs.Store. See Find for why both forms exist.
func (s *SessionStore) Delete(token string) error {
	return s.DeleteCtx(context.Background(), token)
}

// DeleteExpired removes every expired session and reports how many rows went.
// scs never sweeps its store — an expired row is refused by Find and left
// behind — so the process calls this once at boot: the sessions table's dead
// rows then live at most as long as a process does. A periodic sweep is
// chapter 45's background-work material, when there is a scheduler to hang
// it on.
func (s *SessionStore) DeleteExpired(ctx context.Context) (int64, error) {
	var n int64
	err := db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		var err error
		n, err = db.New(conn).DeleteExpiredSessions(ctx, time.Now().Unix())
		return err
	})
	if err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	return n, nil
}

// hashToken returns the at-rest key of a session token: hex(SHA-256(token)).
//
// The token scs generates is 32 random bytes — 256 bits from crypto/rand — so
// a fast hash is the right tool: there is no guessing a 256-bit random, and
// the expensive argon2id recipe exists for low-entropy human passwords, not
// for tokens. What the hash buys is the leak property: the table holds only
// digests, so a copy of the database contains no cookie a reader can replay.
//
// scs v2.9 has a HashTokenInStore switch that hashes tokens itself; this
// store keeps it off, because the at-rest form is the store's contract and
// one owner — this function — is what makes it testable here. (scs's recipe
// is base64 of the same SHA-256 digest; the two encodings are not
// interchangeable, and nothing needs them to be.)
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
````


## `internal/auth/session_store_test.go`

````go
package auth_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/auth"
)

// The store must satisfy the interface scs holds it by, and the optional
// context-aware set scs prefers when it is there.
var (
	_ scs.Store    = (*auth.SessionStore)(nil)
	_ scs.CtxStore = (*auth.SessionStore)(nil)
)

// TestSessionStore_RoundTrip pins scs's Store contract: commit, find, delete,
// and the two not-found answers — a token nothing holds is a miss with no
// error, and deleting a token twice is a no-op, not a failure.
func TestSessionStore_RoundTrip(t *testing.T) {
	t.Parallel()

	store := auth.NewSessionStore(openTestDB(t))
	ctx := context.Background()
	expiry := time.Now().Add(time.Hour)

	data, found, err := store.FindCtx(ctx, "no-such-token")
	require.NoError(t, err)
	assert.False(t, found)
	assert.Nil(t, data)

	require.NoError(t, store.CommitCtx(ctx, "token-1", []byte("session payload"), expiry))
	data, found, err = store.FindCtx(ctx, "token-1")
	require.NoError(t, err)
	assert.True(t, found)
	assert.Equal(t, []byte("session payload"), data)

	require.NoError(t, store.DeleteCtx(ctx, "token-1"))
	_, found, err = store.FindCtx(ctx, "token-1")
	require.NoError(t, err)
	assert.False(t, found)

	require.NoError(t, store.DeleteCtx(ctx, "token-1"), "deleting a missing token is a no-op")
}

// TestSessionStore_ContextlessTrio pins that the plain Store methods — the
// ones the interface scs declares — work too: they are the same store, and a
// caller that only knows the interface gets the same answers.
func TestSessionStore_ContextlessTrio(t *testing.T) {
	t.Parallel()

	store := auth.NewSessionStore(openTestDB(t))

	require.NoError(t, store.Commit("token-1", []byte("payload"), time.Now().Add(time.Hour)))
	data, found, err := store.Find("token-1")
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, []byte("payload"), data)

	require.NoError(t, store.Delete("token-1"))
	_, found, err = store.Find("token-1")
	require.NoError(t, err)
	assert.False(t, found)
}

// TestSessionStore_CommitReplaces pins the upsert: committing an existing
// token overwrites its data and expiry instead of failing on the key, which
// is what scs's Commit contract asks for.
func TestSessionStore_CommitReplaces(t *testing.T) {
	t.Parallel()

	store := auth.NewSessionStore(openTestDB(t))
	ctx := context.Background()

	require.NoError(t, store.CommitCtx(ctx, "token-1", []byte("first"), time.Now().Add(time.Hour)))
	require.NoError(t, store.CommitCtx(ctx, "token-1", []byte("second"), time.Now().Add(2*time.Hour)))

	data, found, err := store.FindCtx(ctx, "token-1")
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, []byte("second"), data, "the last commit wins")
}

// TestSessionStore_HashesTokenAtRest pins the storage key: the row is keyed
// by hex(SHA-256(token)), and the raw token — whose only other copy lives in
// the client's cookie — never reaches the table. A database that leaks hands
// the reader nothing it can replay.
func TestSessionStore_HashesTokenAtRest(t *testing.T) {
	t.Parallel()

	sqlDB := openTestDB(t)
	store := auth.NewSessionStore(sqlDB)
	require.NoError(t, store.CommitCtx(context.Background(), "raw-token-value", []byte("payload"), time.Now().Add(time.Hour)))

	var count int
	require.NoError(t, sqlDB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, "raw-token-value").Scan(&count))
	assert.Zero(t, count, "the raw token is not a key")

	sum := sha256.Sum256([]byte("raw-token-value"))
	require.NoError(t, sqlDB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token_hash = ?`, hex.EncodeToString(sum[:])).Scan(&count))
	assert.Equal(t, 1, count, "the row is keyed by the hash of the token")
}

// TestSessionStore_ExpiredIsNotFound pins expiry enforcement: an expired row
// is invisible to Find — the query's expiry predicate is what enforces it,
// not a sweep that may not have run.
func TestSessionStore_ExpiredIsNotFound(t *testing.T) {
	t.Parallel()

	store := auth.NewSessionStore(openTestDB(t))
	ctx := context.Background()

	require.NoError(t, store.CommitCtx(ctx, "token-1", []byte("payload"), time.Now().Add(-time.Minute)))

	_, found, err := store.FindCtx(ctx, "token-1")
	require.NoError(t, err)
	assert.False(t, found, "an expired session is not found")
}

// TestSessionStore_DeleteExpired pins the sweep: expired rows go, live rows
// stay, and the count reports what went.
func TestSessionStore_DeleteExpired(t *testing.T) {
	t.Parallel()

	store := auth.NewSessionStore(openTestDB(t))
	ctx := context.Background()
	require.NoError(t, store.CommitCtx(ctx, "expired-1", []byte("a"), time.Now().Add(-time.Hour)))
	require.NoError(t, store.CommitCtx(ctx, "expired-2", []byte("b"), time.Now().Add(-time.Minute)))
	require.NoError(t, store.CommitCtx(ctx, "live", []byte("c"), time.Now().Add(time.Hour)))

	n, err := store.DeleteExpired(ctx)
	require.NoError(t, err)
	assert.Equal(t, int64(2), n, "both expired rows went")

	_, found, err := store.FindCtx(ctx, "live")
	require.NoError(t, err)
	assert.True(t, found, "the live row stayed")
}
````
