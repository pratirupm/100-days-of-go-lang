---
title: Secrets
description: Hand the server an admin key at boot, through a type that refuses to print it and a loader that checks who can read the file.
sidebar:
  order: 46
---

The server can only hand out the admin flag from the local command line: `todo admin grant` works when you can reach the database file. A deployed server's operator often cannot. So the server gets its own way to a first admin: it reads a name and a key at boot, makes the account, and never repeats the key out loud.

A **secret** is a value an app must know but must never tell anyone — like the PIN that unlocks your phone. You type it in, and the phone never shows it back. A **key**, here, is the particular secret this server is handed: the text that opens the admin account, like the key to a door.

The hard part is not reading the key. It is making sure nothing else ever writes it down. A log record, an error message, a debug dump — any of them could spell the key out for anyone who can read the server's files. So the key becomes a type that refuses to print, and the boot either creates the admin account, opens it, or replaces its stored credential.

## The tests come first

True to the habit, the behavior comes before the code. This chapter's tests live in three new files — `internal/secret/secret_test.go`, `internal/secret/load_test.go`, and `internal/auth/bootstrap_test.go` — plus two cases in `cmd/todo-server/integration_test.go` and one row in `internal/config/config_test.go`.

The first file pins the type's one promise: the key's bytes never reach a printed string. Its core is a table of the four formatting verbs, and every one of them must show the redaction instead of the value.

<!-- verify: internal/secret/secret_test.go at=secrets -->
```go title="internal/secret/secret_test.go"
	t.Run("the fmt verbs redact", func(t *testing.T) {
		t.Parallel()

		// The verbs in a table, not in four literal calls: the point is the
		// set of paths, and a new path is a new row.
		for _, verb := range []string{"%v", "%s", "%q", "%#v"} {
			got := fmt.Sprintf(verb, key)
			assert.NotContains(t, got, testKey, "%s leaked the key", verb)
			assert.Contains(t, got, "REDACTED", "%s shows the redaction", verb)
		}
		assert.NotContains(t, key.String(), testKey)
	})
```

The rest of the file drives every other path a value can take to a string — a struct that holds the key, a log record, a JSON document — and asserts the same pair: the key is absent, `REDACTED` is present. One case runs the real process logger and reads both of its destinations. A last small case checks `Reveal`, the one method that returns the key.

The second file pins the loader. The refusals are a loop, because the same check refuses the same three modes.

<!-- verify: internal/secret/load_test.go at=secrets -->
```go title="internal/secret/load_test.go"
	for _, mode := range []os.FileMode{0o640, 0o644, 0o604} {
		t.Run(fmt.Sprintf("a %04o file is refused", mode), func(t *testing.T) {
			t.Parallel()

			path := writeKeyFile(t, mode, "todo-admin-key-from-a-file")
			_, err := secret.Load(getenvFrom(map[string]string{fileVar: path}), directVar, fileVar)
			require.Error(t, err)
			assert.Contains(t, err.Error(), fmt.Sprintf("%04o", mode), "the refusal names the mode it found")
			assert.NotContains(t, err.Error(), "todo-admin-key-from-a-file", "the refusal does not echo the key")
		})
	}
```

Around the loop, the cases pin the sources: the variable's value is taken exactly as written, an empty variable counts as unset, both variables set is an error, and a file is read only when its mode bits have no group or other bits — 0600 and 0400 pass. A missing file, an empty file, a folder, and a file larger than a credential are refused too, and no refusal echoes the key.

The third file is the bootstrap's contract, and its first piece is a helper. "Only the hash is stored" is a claim about the whole database, so the helper sweeps every table's every column for the key's bytes.

<!-- verify: internal/auth/bootstrap_test.go at=secrets -->
```go title="internal/auth/bootstrap_test.go"
// assertKeyNowhere sweeps every table's every column for the key's bytes.
// "Only the hash is stored" is a claim about the whole database, not about
// one column: the sweep is what makes it one — a future writer that put the
// key into some other row fails this case wherever that row is.
func assertKeyNowhere(t *testing.T, sqlDB *sql.DB, key secret.Secret) {
	t.Helper()

	rows, err := sqlDB.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
...
	for _, table := range tables {
		assertTableHasNo(t, sqlDB, table, key.Reveal())
	}
}
```

The first case then pins the first boot: the account is created, carries the admin flag, and its stored credential is a hash of the key in the same format every password already uses.

<!-- verify: internal/auth/bootstrap_test.go at=secrets -->
```go title="internal/auth/bootstrap_test.go"
	res, err := svc.BootstrapAdmin(context.Background(), "  Admin@Example.COM ", secret.Secret(bootstrapKey))
	require.NoError(t, err)
	assert.Equal(t, auth.BootstrapResult{Created: true, Granted: true}, res)
```

Five cases follow it: a second boot with the same key changes nothing; a changed key replaces the stored credential; a flag that is off is set again; a stored hash that cannot be parsed is refused; and a blank email or an empty key is an error. The integration test drives the real server, where the ordinary login route is the only door the new account gets.

<!-- verify: cmd/todo-server/integration_test.go at=secrets -->
```go title="cmd/todo-server/integration_test.go"
	// The ordinary login opens the seeded account: the bootstrap adds no
	// second way in, it only makes sure the first one has an admin behind it.
	resp := postJSON(t, base+"/api/v1/auth/login",
		fmt.Sprintf(`{"email":"admin@example.com","password":%q}`, key), nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
```

Now run the tests and watch them fail.

```bash
$ go test -count=1 ./...
todo/internal/secret: no non-test Go files in …/internal/secret
# todo/internal/config_test [todo/internal/config.test]
internal/config/config_test.go:116:5: unknown field AdminEmail in struct literal of type config.Config
...
FAIL	todo/cmd/todo-server	11.963s
...
FAIL
```

Three failures in one run, and each names something this chapter adds. `todo/internal/secret: no non-test Go files` means the folder holds tests but no code — Go cannot build a package out of tests alone. The config package does not compile because the `AdminEmail` field does not exist yet. And the server's new case expects the login of the seeded account to answer 200; it gets 401, because nothing seeds it. Nothing is broken; the tests describe an app that does not exist yet.

## A string that refuses to print

`internal/secret` is a new package, and `secret.go` is its heart. The type is called `Secret`, and underneath it is just a string — with one job: every path that could turn a value into text must show a fixed redaction instead.

<!-- verify: internal/secret/secret.go at=secrets -->
```go title="internal/secret/secret.go"
// Package secret carries credentials through the process without letting
// them reach a log record, a formatted string, or a JSON document.
//
// A Secret is a string underneath, and the type is the whole mechanism: it
// implements Stringer, GoStringer, slog.LogValuer, and encoding.TextMarshaler,
// so every printing path the standard library and slog offer — the fmt verbs,
// a struct field, a record attribute, a marshaled document — shows a fixed
// redaction instead of the value. Reveal is the one method that returns the
// secret itself, which makes `grep -rn 'Reveal()'` the audit of every place a
// credential becomes a string.
//
// The type closes the accidental paths, not every path: a caller that Reveals
// and hands the string to a map, a template, or a driver has left the type
// behind, and that is a decision it should have to make explicitly.
//
// Loading lives beside the type (see Load): the environment variable and the
// owner-only file are the two sources this process can verify, and the
// deployment's third — systemd's LoadCredential — arrives as the same file
// with the same check.
package secret

import "log/slog"

// redacted is what every printing path shows in place of the value. One
// spelling, so a search for it in a log file answers "did this record carry a
// secret?" with one pattern.
const redacted = "[REDACTED]"

// Secret is a credential in memory: a string that knows how not to print.
type Secret string

// String returns the redaction. It is the fmt verbs' path — %v, %s, %q — and
// fmt calls it for a struct field too, so printing a configuration value that
// holds a Secret redacts the field rather than the whole value.
func (s Secret) String() string { return redacted }

// GoString returns the redaction in Go syntax: %#v's path. Without it, %#v
// would print the underlying string, because %#v consults GoStringer before
// Stringer.
func (s Secret) GoString() string { return `secret.Secret("` + redacted + `")` }

// LogValue returns the redaction as a slog value: a record attribute that
// holds a Secret shows the redaction, whichever handler renders it. slog
// resolves a LogValuer before any handler sees the value, so the JSON sink,
// the file sink, and tint are all covered by this one method.
func (s Secret) LogValue() slog.Value { return slog.StringValue(redacted) }

// MarshalText returns the redaction: encoding/json and every other
// TextMarshaler consumer print it in place of the value, so a Secret in a
// marshaled document is redacted there too.
func (s Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }

// Reveal returns the secret itself. It is the one way out of the type, and
// every call site is a deliberate boundary: the hash, the comparison, the
// reader that needs the bytes.
func (s Secret) Reveal() string { return string(s) }

// IsEmpty reports whether the secret holds nothing: the unset variable, the
// absent file. The empty secret is how "no credential configured" travels —
// the same convention the configuration's empty values follow.
func (s Secret) IsEmpty() bool { return s == "" }
```

Read the four methods as four doors, each one a way a value can reach a printed page. `String` is the formatting verbs' door — `%v`, `%s`, `%q` — and it is used for a struct field too, so a configuration value that holds a key redacts that field rather than the whole value. `GoString` is `%#v`'s door: without it, `%#v` would print the underlying string, because it asks for Go syntax before it asks for text. `LogValue` is the log record's door: the logging library resolves it before any handler renders the record, so the terminal copy and the file copy are covered by the one method. `MarshalText` is the JSON door.

Then the one way out: `Reveal`. Every call site is a deliberate boundary — the hash, the comparison, the reader that needs the bytes — and that is what makes `grep -rn 'Reveal()'` the audit of every place the key becomes a plain string. Today there are three call sites, all in the bootstrap. `IsEmpty` is how "no key configured" travels.

## Where the key comes from

The second file, `load.go`, resolves the key from one of two sources. The variable `TODO_ADMIN_KEY` holds the key itself. The variable `TODO_ADMIN_KEY_FILE` holds the path to a file that holds the key.

Setting both is an error, not a precedence — one credential with two sources is an ambiguity the operator has to resolve. Setting neither is fine: the secret is empty, and a deployment without a key is legitimate. An empty variable counts as not set, so a deployment moving from the variable to the file does not have to unset the first.

<!-- verify: internal/secret/load.go at=secrets -->
```go title="internal/secret/load.go"
package secret

import (
	"fmt"
	"os"
	"strings"
)

// maxSecretLen bounds what Load reads out of a file: 4 KiB is orders of
// magnitude more than a key, and small enough that a path pointing at the
// wrong file cannot turn a boot into a read of a log or a disk image.
const maxSecretLen = 4096

// Load resolves a secret from the environment: the variable named by
// directEnv holds the value itself, or the variable named by fileEnv holds a
// path to a file that does. Setting both is an error rather than a
// precedence: one credential with two sources is an ambiguity an operator has
// to resolve, not a default the loader should guess. Neither set is not an
// error — the secret is empty — because a deployment without the credential
// is a legitimate one.
//
// The direct value is taken verbatim: an environment variable is exact, and
// spaces or punctuation in a key are the key. The file is read with the
// checks this process can make: a regular file, at most maxSecretLen bytes,
// and owner-only — group and other bits are refused, because a credential
// file another account can read is a credential another account holds. The
// mode bits are the check's whole substance: ownership is not verified (the
// process cannot know which account the operator meant) and a symlink is
// followed like any other read. Trailing newlines are trimmed: a file is
// written by an editor or a shell redirect, and the newline belongs to the
// editor, not to the key.
//
// ...
// os.Getenv, tests pass a map. The file is real either way — its mode bits
// are what the check reads, and a check against a fake file system would not
// be the check that runs in production.
func Load(getenv func(string) string, directEnv, fileEnv string) (Secret, error) {
	direct := getenv(directEnv)
	path := getenv(fileEnv)
	if direct != "" && path != "" {
		return "", fmt.Errorf("secret: set either %s or %s, not both", directEnv, fileEnv)
	}
	if direct != "" {
		return Secret(direct), nil
	}
	if path == "" {
		return "", nil
	}

	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("secret: %s: %w", fileEnv, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("secret: %s: %s is not a regular file", fileEnv, path)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return "", fmt.Errorf("secret: %s: %s is mode %04o; a credential file must not be readable by group or other", fileEnv, path, perm)
	}
	if info.Size() > maxSecretLen {
		return "", fmt.Errorf("secret: %s: %s is %d bytes; a credential is at most %d", fileEnv, path, info.Size(), maxSecretLen)
	}

	data, err := os.ReadFile(path) // #nosec G304 -- the path is the operator's configured credential location, not caller input
	if err != nil {
		return "", fmt.Errorf("secret: %s: %w", fileEnv, err)
	}
	value := strings.TrimRight(string(data), "\r\n")
	if value == "" {
		return "", fmt.Errorf("secret: %s: %s is empty", fileEnv, path)
	}
	return Secret(value), nil
}
```

Walk the file checks in order, because each one can refuse. `os.Stat` comes first, so a missing path is refused by name. `IsRegular` because a credential is a file, not a folder. Then the mode bits: `perm&0o077 != 0` refuses any file that a group or another account can read — 0644 is refused with the mode in the message, while 0600 and 0400 pass. The size bound keeps a path that points at the wrong file from turning a boot into a read of a log or a disk image. The read trims trailing newlines, because the newline belongs to the editor that wrote the file, not to the key; a file that holds only a newline is refused as empty.

Every message names the variable, the path, or the mode, and none names the value. The failure path follows the same rule as the log.

Run the tests again. The secret package's cases pass now, and the failures that remain name exactly what the chapter still owes.

```bash
$ go test -count=1 ./...
# todo/internal/auth_test [todo/internal/auth.test]
internal/auth/bootstrap_test.go:99:18: svc.BootstrapAdmin undefined (type *auth.Service has no field or method BootstrapAdmin)
...
internal/auth/bootstrap_test.go:202:18: too many errors
FAIL	todo/internal/auth [build failed]
```

`BootstrapAdmin`, `BootstrapResult`, `ActionBootstrap`, `ActionRotate` — the names are the contract. Build them next.

## Two new words in the trail, and one new query

The audit trail already records a registration, a login, a logout, and a grant. The bootstrap adds two happenings of its own: the boot that creates the account, and the boot that replaces a stored credential the configured key no longer opens.

<!-- verify: internal/auth/audit.go at=secrets -->
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
```

The grant's comment now names its two writers: the command line's grant, and the boot's re-assert of a flag that was off. One token per happening, stored as text, so a reader of the table needs no code.

The rotation needs one new statement in `internal/db/queries/auth.sql`. It reports how many rows changed, like the flag update, so zero rows is read as "user not found" instead of parsed out of a driver's error.

<!-- verify: internal/db/queries/auth.sql at=secrets -->
```sql title="internal/db/queries/auth.sql"
-- Replaces the stored credential of the user with the email and reports how
-- many rows changed. It is the boot's rotation path (see BootstrapAdmin): a
-- key the stored hash no longer opens replaces it, and the replacement is an
-- argon2id hash like every other stored credential. Zero rows means the user
-- was gone between the read that found it and this write.
-- name: SetUserPassword :execrows
UPDATE users
SET password_hash = ?
WHERE email = ?;
```

The Go code for the query is generated from the SQL — never edited by hand. Regenerate it:

```bash
$ go generate ./...
```

`internal/db/auth.sql.go` gains `SetUserPassword`, and nothing else in the database changes: the bootstrap reuses the users table and the trail, so no migration arrives.

## The boot that seeds the admin

`internal/auth/bootstrap.go` is the chapter's core. The boot calls one function, `BootstrapAdmin`, and it decides three things inside one transaction — a group of writes that either all happen or none do.

<!-- verify: internal/auth/bootstrap.go at=secrets -->
```go title="internal/auth/bootstrap.go"
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
```

Three separate facts, because the boot reports them separately. A boot that changed nothing leaves all three false.

<!-- verify: internal/auth/bootstrap.go at=secrets -->
```go title="internal/auth/bootstrap.go"
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
```

Read the decision: look the account up by email. No row means the account does not exist, and the create path runs. A row means it exists, and the ensure path runs. Any other error stops the boot.

The create path hashes the key, sets the flag, and records the event — all in the same transaction.

<!-- verify: internal/auth/bootstrap.go at=secrets -->
```go title="internal/auth/bootstrap.go"
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
...
	if _, err := q.SetUserAdmin(ctx, db.SetUserAdminParams{IsAdmin: 1, Email: email}); err != nil {
		return err
	}
	*out = BootstrapResult{Created: true, Granted: true}
	return insertAudit(ctx, q, AuditEvent{Action: ActionBootstrap, UserID: id})
}
```

The key is hashed on the way in with the same argon2id function every password already uses, so the clear key never reaches a statement. The stored form is a hash, not the key: a copy of the database hands over a hash to crack, not a key to replay. The event is `bootstrap`, and its actor is nobody, because the operator's key is not a user.

The ensure path verifies first, then repairs only what it finds.

<!-- verify: internal/auth/bootstrap.go at=secrets -->
```go title="internal/auth/bootstrap.go"
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
```

The ordering is the point. The verify comes before any write, so the boot proves the key still opens the account instead of assuming it. A key that does not open the stored hash replaces it — a rotation — and records a `rotate` event. A flag that is off is set and records a `grant` event, the same one the command line records. A call that repairs nothing reaches the last line having written nothing at all.

One failure is not a rotation: a stored hash that cannot be parsed. The verify returns an error rather than `false`, and the boot refuses instead of overwriting the value — overwriting would destroy the evidence of a corrupt record, and the next boot would look healthy over it.

One more small edit: the package comment in `internal/auth/auth.go` now names the bootstrap among the things the package holds, so its own description stays true.

## The account's name joins the configuration

`internal/config` learns the account's name and the two variable names. The name is a plain setting; the key is deliberately not one.

<!-- verify: internal/config/config.go at=secrets -->
```go title="internal/config/config.go"
	// AdminEmail is the account the boot's admin key seeds or ensures (see
	// internal/auth's BootstrapAdmin). Empty means the key has no account to
	// name, which is an error when a key is set and nothing at all when none
	// is. The key itself is deliberately not a field here: a Config is a
	// value callers may print, and a secret must not be one.
	AdminEmail string
```

The reason is in the comment: a `Config` is a value callers may print, and a secret must not be one. The variable names are exported because the boot hands them to the loader; the value itself never enters the configuration.

<!-- verify: internal/config/config.go at=secrets -->
```go title="internal/config/config.go"
// The environment variables the admin bootstrap's secret arrives through.
// They are exported because main hands the two names to internal/secret,
// which reads the value and returns a type that cannot be printed; the value
// itself never enters a Config, for the reason the AdminEmail field's comment
// gives. The pair is the choice the loader refuses to guess between.
const (
	// EnvAdminKey names the variable holding the bootstrap key itself.
	EnvAdminKey = "TODO_ADMIN_KEY"
	// EnvAdminKeyFile names the variable holding a path to a file that
	// holds the key.
	EnvAdminKeyFile = "TODO_ADMIN_KEY_FILE"
)
```

The resolution table in `internal/config/config_test.go` gains one row for the new setting.

<!-- verify: internal/config/config_test.go at=HEAD -->
```go title="internal/config/config_test.go"
		{
			name: "TODO_ADMIN_EMAIL names the bootstrap account",
			env: map[string]string{
				"HOME":             "/home/user",
				"TODO_ADMIN_EMAIL": "admin@example.com",
			},
			want: config.Config{
				DBPath:     "/home/user/.local/share/todo/todo.db",
				LogPath:    "/home/user/.local/state/todo/logs/todo.log",
				Listen:     config.DefaultListen,
				AdminEmail: "admin@example.com",
			},
		},
```

The row pins the resolution: `TODO_ADMIN_EMAIL` lands in `AdminEmail`, and the key's two variable names stay out of the struct.

## The boot loads the key before it opens anything

The wiring in `cmd/todo-server/main.go` is short, and its order is deliberate. The key loads immediately after the configuration resolves — before the logger, before the store, before anything opens a file.

<!-- verify: cmd/todo-server/main.go at=secrets -->
```go title="cmd/todo-server/main.go"
	adminKey, err := secret.Load(os.Getenv, config.EnvAdminKey, config.EnvAdminKeyFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if !adminKey.IsEmpty() && cfg.AdminEmail == "" {
		fmt.Fprintln(os.Stderr, "todo-server: the admin key is set but TODO_ADMIN_EMAIL is not; a credential has to name an account")
		return 1
	}
```

A refusal here is one line on stderr and exit 1, and it leaves nothing behind: no log file, no database, no migration. A boot that cannot honor the operator's secret should not have written anything first. A key with no account to name is refused the same way — a credential has to name somebody.

The bootstrap itself runs after the store is open and before the server accepts a request.

<!-- verify: cmd/todo-server/main.go at=secrets -->
```go title="cmd/todo-server/main.go"
	if !adminKey.IsEmpty() {
		res, err := authn.BootstrapAdmin(ctx, cfg.AdminEmail, adminKey)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		logger.Info("admin credential ensured",
			"email", cfg.AdminEmail,
			"created", res.Created, "rotated", res.Rotated, "granted", res.Granted)
	}
```

What the boot ensured is recorded — the email and the three booleans. What it ensured it with is not: the key is not an attribute, a message, or a format string anywhere in the process.

## Run it green

Run the new packages' cases first.

```bash
$ go test -count=1 -v -run 'TestSecret|TestLoad|TestBootstrapAdmin' ./internal/secret ./internal/auth
--- PASS: TestSecret_Empty (0.00s)
--- PASS: TestSecret_ProcessLogger (0.00s)
--- PASS: TestLoad_Env (0.00s)
--- PASS: TestSecret_Redacts (0.00s)
--- PASS: TestLoad_File (0.00s)
ok  	todo/internal/secret	0.005s
--- PASS: TestBootstrapAdmin_Input (0.04s)
--- PASS: TestBootstrapAdmin_CorruptStoredHash (0.09s)
--- PASS: TestBootstrapAdmin_Regrants (0.13s)
--- PASS: TestBootstrapAdmin_Creates (0.15s)
--- PASS: TestBootstrapAdmin_Idempotent (0.17s)
--- PASS: TestBootstrapAdmin_Rotates (0.24s)
ok  	todo/internal/auth	0.289s
```

Every case passes. The order above is a presentation, not a property — the cases run in parallel and finish in a different order each time. The process-logger case logs the lines it captured, so the record both destinations hold is in the output — redacted.

```bash
=== RUN   TestSecret_ProcessLogger
...
    secret_test.go:112: stderr: {"time":"2026-10-15T14:55:57.344211829+05:30","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","key":"[REDACTED]"}
    secret_test.go:113: file:   {"time":"2026-10-15T14:55:57.344211829+05:30","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","key":"[REDACTED]"}
--- PASS: TestSecret_ProcessLogger (0.00s)
```

Both destinations hold the same record, with `"key":"[REDACTED]"` where the value would have been. Then the whole module:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	1.905s
ok  	todo/cmd/todo-server	2.381s
ok  	todo/internal/api	0.644s
?   	todo/internal/api/docs	[no test files]
ok  	todo/internal/auth	0.763s
ok  	todo/internal/cli	0.251s
...
ok  	todo/internal/secret	0.007s
ok  	todo/internal/store	0.781s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.007s
ok  	todo/internal/telemetry	0.009s
```

Every package passes — the whole module, the new cases included.

## Try it on a real server

Tests are one thing; a running server is another. Start it from a scratch folder with `TODO_DB` and `TODO_LOG` inside it, the base URL in `$B`, exactly as the last chapters showed. The captures write the binary as `todo-server`; from your scratch folder that is `./todo-server`. First boot: name the account, hand over the key.

```bash
$ TODO_ADMIN_EMAIL=admin@example.com TODO_ADMIN_KEY=demo-admin-key-3b7f1c9e \
    todo-server --listen 127.0.0.1:18046
{"time":"2026-10-15T14:52:24.990166421+05:30","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":true,"rotated":false,"granted":true}
{"time":"2026-10-15T14:52:24.990386162+05:30","level":"INFO","msg":"server listening","addr":"127.0.0.1:18046"}
```

The first record is the boot's. `created:true` says the account was made; `granted:true` says the admin flag is set; `rotated:false` says no stored credential was replaced. The second record is the server listening.

Now the key opens the account through the same login route every user uses — the bootstrap adds no second way in.

```bash
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Content-Type: application/json" \
    --data '{"email":"admin@example.com","password":"demo-admin-key-3b7f1c9e"}' $B/api/v1/auth/login
200

$ curl -s -w ' [%{http_code}]\n' -X POST -H "Content-Type: application/json" \
    --data '{"email":"admin@example.com","password":"not the key"}' $B/api/v1/auth/login
{"code":"unauthorized","message":"invalid email or password"}
 [401]

$ curl -s -o /dev/null -w '%{http_code}\n' -b "session=…" $B/debug/pprof/
200
```

The login with the key answers 200. A wrong key is a wrong password, because the stored credential is a hash of the key, and it answers 401. The third request carries the session cookie the login set — its value is elided with `…` — and it passes the check in front of the profiles, so the account is an admin without the command line ever running.

Now the redaction pass over the records the run wrote: the key is in the environment, the records exist, and the key is in none of them. (`grep -c` prints 0 and exits 1 — no match.)

```bash
$ grep -c 'demo-admin-key-3b7f1c9e' cap.log
0
$ tail -4 cap.log
{"time":"2026-10-15T14:52:33.957485894+05:30","level":"INFO","msg":"request","request_id":"ibVxmuIRplQyzedWcYvpNvoagiDVZKAh","trace_id":"09bc58735662b440d78232c956fe4266","method":"POST","path":"/api/v1/auth/login","status":200,"duration":19510157}
{"time":"2026-10-15T14:52:34.021894147+05:30","level":"WARN","msg":"request","request_id":"mcscqOzYPaXNcFuTurYXmadsTIstDaLG","trace_id":"e4b6dedf489159f091c733aef9968907","method":"POST","path":"/api/v1/auth/login","status":401,"duration":19442088}
{"time":"2026-10-15T14:52:34.057192631+05:30","level":"INFO","msg":"request","request_id":"KZnRRalfRwsTJHsYAPtpjsONRaMqIHoR","trace_id":"b1838fe5f19b13419e6b6f4c0130b746","method":"POST","path":"/api/v1/auth/login","status":200,"duration":26525743}
{"time":"2026-10-15T14:52:34.065560633+05:30","level":"INFO","msg":"request","request_id":"KLIzYscdUrMDFGLiknBPHnOZFVgCsSiZ","trace_id":"6b09c8da0d1b48620b637c520dadfbd8","method":"GET","path":"/debug/pprof/","status":200,"duration":461260}
```

The four records are the two logins, the failed attempt, and the profile request — and not one carries the key.

The key is the authority over this account while it is configured, so changing it is one step: set the new key and restart. The boot record says `rotated:true`; the old key stops working; the new one opens the account.

```bash
$ TODO_ADMIN_KEY=demo-admin-key-9e1a7d40-rotated todo-server --listen 127.0.0.1:18048
{"time":"2026-10-15T14:52:50.226929623+05:30","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":false,"rotated":true,"granted":false}

$ curl -s -w ' [%{http_code}]\n' … --data '{"email":"admin@example.com","password":"demo-admin-key-3b7f1c9e"}'
{"code":"unauthorized","message":"invalid email or password"}
 [401]

$ curl -s -o /dev/null -w '%{http_code}\n' … --data '{"email":"admin@example.com","password":"demo-admin-key-9e1a7d40-rotated"}'
200
```

The trail shows the same move, read back from the database file after the server stopped: the first boot's `bootstrap` row and the changed key's `rotate` row, each with nobody as the actor.

```bash
  bootstrap  user=01a13ede-b440-74a1-9753-bfe7bf1182bc  actor=""
  ...
  rotate  user=01a13ede-b440-74a1-9753-bfe7bf1182bc  actor=""
```

A restart with the key unchanged changes nothing, and says so:

```bash
$ TODO_ADMIN_KEY=demo-admin-key-9e1a7d40-rotated todo-server --listen 127.0.0.1:18051
{"time":"2026-10-15T15:00:41.13014203+05:30","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":false,"rotated":false,"granted":false}
```

The file variant next, in a fresh scratch folder. A key file that any other account can read stops the boot before it serves anything, names the mode it found, and does not echo the key. The same file at 0600 boots, and the newline it was written with is trimmed off the key.

<!-- transcripts: authored -->
```bash
$ printf 'demo-file-key-7a1f42c8\n' > admin-key && chmod 0644 admin-key && stat -c '%a %n' admin-key
644 admin-key

$ TODO_ADMIN_KEY_FILE=$PWD/admin-key todo-server --listen 127.0.0.1:18049
secret: TODO_ADMIN_KEY_FILE: /tmp/…/admin-key is mode 0644; a credential file must not be readable by group or other
exit code: 1

$ chmod 0600 admin-key && stat -c '%a %n' admin-key
600 admin-key

$ TODO_ADMIN_KEY_FILE=$PWD/admin-key todo-server --listen 127.0.0.1:18049
{"time":"2026-10-15T14:53:22.143211907+05:30","level":"INFO","msg":"admin credential ensured","email":"admin@example.com","created":true,"rotated":false,"granted":true}

$ curl -s -o /dev/null -w '%{http_code}\n' … --data '{"email":"admin@example.com","password":"demo-file-key-7a1f42c8"}'
200
```

One more refusal, for the ambiguity the loader will not guess: both sources set.

```bash
$ TODO_ADMIN_KEY=demo-admin-key-3b7f1c9e TODO_ADMIN_KEY_FILE=$PWD/admin-key todo-server --listen 127.0.0.1:18050
secret: set either TODO_ADMIN_KEY or TODO_ADMIN_KEY_FILE, not both
exit: 1
```

And the refused boot's footprint, in its own run: the directory holds the operator's key file and nothing else — no log, no database.

<!-- transcripts: authored -->
```bash
$ TODO_ADMIN_KEY_FILE=$PWD/footprint/admin-key todo-server --listen 127.0.0.1:18052
secret: TODO_ADMIN_KEY_FILE: /tmp/…/footprint/admin-key is mode 0644; a credential file must not be readable by group or other
exit code: 1

$ ls -A footprint/
admin-key
```

That is the refusal story end to end: one line on stderr, and a folder that holds the operator's own file and nothing else.

## If something went wrong

**`todo/internal/secret: no non-test Go files in …/internal/secret`.** If you run the tests before writing `secret.go`, Go cannot build the package: a folder with tests and no regular Go files is not a package yet. The fix is the file from "A string that refuses to print".

**The refused boot created a log file.** If the key load sits after the logger, a boot that refuses the operator's secret has already created the log file it would have used to report the refusal.

```bash
--- FAIL: TestServer_AdminKeyFile (0.04s)
    --- FAIL: TestServer_AdminKeyFile/a_world-readable_file_is_refused (0.04s)
        integration_test.go:359:
            	Error Trace:	…/cmd/todo-server/integration_test.go:359
            	Error:      	Should be true
            	Test:       	TestServer_AdminKeyFile/a_world-readable_file_is_refused
            	Messages:   	the refused boot created a log file
```

Move the key load and the account check above the logger. The refusal then writes one line to stderr and touches no file at all.

**`verify password: not an argon2id hash` — a stored credential that cannot be parsed.** The full line, wrapped by the transaction that ran the verify:

```bash
bootstrap admin admin@example.com: concurrent transaction: verify password: not an argon2id hash
```

`VerifyPassword` returns an error rather than `false`, so the boot can tell "wrong key" from "corrupt record". The boot refuses and writes nothing. Nothing to fix: overwriting would destroy the evidence, and the next boot would look healthy over it.

**The key file's mode is the problem.** The refusal names the mode it found and never echoes the key:

<!-- transcripts: authored -->
```bash
secret: TODO_ADMIN_KEY_FILE: /tmp/…/admin-key is mode 0644; a credential file must not be readable by group or other
```

Any group or other bit on the file is refused. `chmod 0600` fixes it, and `0400` is fine too. The check is a tripwire for a misconfigured secret — the box below says what it does not cover.

**`Failed locking file … File is locked by another process` — the database is held open.** A second process opening the database while the server still holds it:

```bash
turso: error: Locking error: Failed locking file '…/cap.db'. File is locked by another process
```

The database file is locked for as long as the server holds it open. Stop the server first, then read.

<details>
<summary>Going deeper: why a hash, not an encryption</summary>

The boot never needs the key back. It verifies a login against the key and compares the two — that is all. So the stored form is a one-way function: argon2id, the same function every password gets. A stolen database then hands over a hash to crack, not a key to replay, and the cost parameters that make the cracking expensive travel inside the stored string. Encryption would be for a case this app does not have — a value it must reproduce later — and it would add a second secret, the decryption key, whose loss yields every value at once.

</details>

<details>
<summary>Going deeper: why two sources is an error, and no source is fine</summary>

Everywhere else, the app resolves settings by precedence: flag, then environment, then default. This pair deliberately breaks that rule. One credential with two sources is an ambiguity, and the failure mode of guessing wrong is a rotation nobody asked for. An empty variable, by contrast, is simply not set — the convention every other setting follows — so a deployment moving from the variable to the file does not have to unset the first. And no key at all is a legitimate deployment: the command line's runs and every test have none, and the empty secret is how that travels.

</details>

<details>
<summary>Going deeper: what the mode check does not cover</summary>

The check asks one question: does this file have any group or other bits? Owner-only modes pass — 0600, 0400, even 0700 — and anything else is refused. It does not check who owns the file, because the process cannot know which account the operator meant. It follows a symlink like any other read. It does not check the folder's own mode. And the stat and the read are two steps, so a file swapped between them is not defended against. The check is a tripwire for a misconfigured secret, not a boundary against someone who can already write the path. A stricter spelling comes free: systemd's `LoadCredential=` hands the process the same kind of file, owner-only, under a directory the supervisor controls, and the same `TODO_ADMIN_KEY_FILE` names it.

</details>

<details>
<summary>Going deeper: why a changed key rotates the credential instead of failing the boot</summary>

Nothing else in this app writes a password, so "leave an existing account untouched" would mean the key could never change: an operator who rotated the secret in their configuration would get a boot that silently did nothing. The chapter chooses rotation, and makes it visible — a `rotate` row in the trail, `rotated:true` in the boot record. The price is named rather than hidden: while the key is configured, it is the authority over this one account, so a key that changed without the operator meaning to is a rotation rather than an error. What keeps that acceptable is that the authority is a secret only someone who can already write the process's environment — or its credential file — holds. A stale key from a rollback rotates back, and the trail shows both moves. To stop the environment owning the credential, unset the key and keep the account: the stored hash stays what it is, and nothing rewrites it any more.

</details>

The key can now be handed to the server without ever being said out loud; next, the whole project goes through a security audit.
