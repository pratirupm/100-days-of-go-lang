---
title: "Day 39 — Users and sessions"
sidebar:
  order: 39
chapter: 33
---

**About 3 hours** · Part VII, day 4 of 6.

**You'll be able to:**

- register, log in, and log out users;
- hash passwords with argon2id and carry identity in a cookie session that rotates on login.

---

The API can hold tasks now, but every request looks the same to it. Nothing knows who is asking — the app has no idea what a user is.

Today it learns. A **user** is an email address and a password; a **session** is how a logged-in client is remembered from one request to the next. Three new routes carry the moves — `register`, `login`, and `logout` — and a cookie carries the proof.

Two ideas hold the design up, and each gets a plain-language explanation before the code. A password is never stored — the app keeps a **hash** instead, a one-way scramble that can be checked but never reversed. And a session is a coat-check ticket: the server keeps the row, the client keeps a long random number, and showing it back proves the login.

By the end you can watch the whole flow with `curl`: register an account, log in and receive a cookie, watch a wrong password and an unknown account fail with the same answer, and log out.

## Passwords are scrambled, never stored

A password must never be written down in a database. Databases leak, and a leaked password is a leaked key — people reuse them. So the app stores something else: a **hash**.

A hash is a one-way scramble: scrambling a password always produces the same result, and checking one means scrambling what was typed and comparing the two scrambles. There is no way to run it backwards, which is what makes a stolen database useless for reading passwords. One twist: a **salt**, a few random bytes mixed into each password before scrambling and stored beside the hash, so two users with the same password get different hashes.

The scrambling recipe is called **argon2id**, and its defining feature is deliberate expense: it's built to eat memory and take a moment, so guessing passwords stays costly even for an attacker with specialized hardware. The recipe's knobs live in `internal/auth/password.go`:

<!-- verify: internal/auth/password.go at=sessions -->
```go title="internal/auth/password.go"
const (
	argonMemory  uint32 = 19456 // KiB, 19 MiB
	argonTime    uint32 = 2
	argonThreads uint8  = 1
	argonSaltLen        = 16
	argonKeyLen  uint32 = 32
)
```

Nineteen mebibytes of memory, two passes over it, one lane — and a fresh 16-byte salt per password. Memory is what makes the guessing hardware poor at this, and one lane keeps a small server able to hash several logins at once.

Making a hash is four lines:

<!-- verify: internal/auth/password.go at=sessions -->
```go title="internal/auth/password.go"
func HashPassword(password string) string {
	salt := make([]byte, argonSaltLen)
	rand.Read(salt)
	return encodeHash(password, salt, defaultArgonParams())
}
```

There's no error to return — the random source it uses doesn't fail in a way a caller could handle — so the function hands back one string: the hash, salt included.

Checking a password is the mirror image, and its subtlety is the comparison:

<!-- verify: internal/auth/password.go at=sessions -->
```go title="internal/auth/password.go"
func VerifyPassword(password, encoded string) (bool, error) {
	p, salt, want, err := parseHash(encoded)
	if err != nil {
		return false, fmt.Errorf("verify password: %w", err)
	}
	...
	got := argon2.IDKey([]byte(password), salt, p.time, p.memory, p.threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
```

`parseHash` reads the cost back out of the stored string before anything is allocated, and `ConstantTimeCompare` compares the two scrambles without stopping early — an early exit would leak, through timing, how much of a guess was right. A string that can't be parsed is an error, not a wrong password: a corrupt row deserves a 500, and a bad guess a 401.

The stored string is called a **PHC string**, and it carries everything the check needs: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. Because the cost travels inside it, raising the parameters later won't invalidate anything — old hashes keep verifying under the cost they were made with, and only new passwords pay the new price.

## The tests come first

The chapter's contract lives in test files: three in `internal/auth` — `password_test.go`, `service_test.go`, and `session_store_test.go` — one in `internal/api` called `auth_test.go`, and the black-box flow in the server's integration test. They name everything before any of it exists.

The tests also import the two libraries the chapter adds, so the project gains them now: `go get github.com/alexedwards/scs/v2@v2.9.0` for sessions, and `go get golang.org/x/crypto@v0.58.0` for the argon2id recipe. Both land in the module's list:

<!-- verify: go.mod at=sessions -->
```text title="go.mod"
require (
	github.com/alexedwards/scs/v2 v2.9.0
	...
	golang.org/x/crypto v0.58.0
	...
)
```

The session library is new; `x/crypto` was already present as an indirect dependency and moves up because the app now calls it itself.

Two cases carry the chapter's promises. The first pins the cookie a successful login sets, flag by flag:

<!-- verify: internal/api/auth_test.go at=sessions -->
```go title="internal/api/auth_test.go"
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1)
	cookie := cookies[0]
	assert.Equal(t, "session", cookie.Name)
	assert.NotEmpty(t, cookie.Value)
	assert.True(t, cookie.Secure, "the cookie must not travel over plain http")
	assert.True(t, cookie.HttpOnly, "scripts must not read the session")
	assert.Equal(t, http.SameSiteLaxMode, cookie.SameSite)
	assert.Equal(t, "/", cookie.Path)
	assert.InDelta(t, int((24 * time.Hour).Seconds()), cookie.MaxAge, 5, "the cookie expires with the session")
	assert.False(t, cookie.Expires.IsZero(), "a persistent cookie carries Expires")
```

Every line is a promise: the cookie is named `session`, its value is a long random token, and it's marked `Secure` (never over plain http), `HttpOnly` (scripts can't read it), `SameSite=Lax`, scoped to `/`, and good for a day — as both `Max-Age` and `Expires`, which makes it survive a browser restart.

The second case pins the failure: a wrong password and an unknown email must be indistinguishable.

<!-- verify: internal/api/auth_test.go at=sessions -->
```go title="internal/api/auth_test.go"
	for name, email := range map[string]string{
		"a wrong password": "alice@example.com",
		"an unknown email": "nobody@example.com",
	} {
		...
			require.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.JSONEq(t, `{"code":"unauthorized","message":"invalid email or password"}`, rec.Body.String())
			assert.Empty(t, rec.Result().Cookies(), "a failed login sets no session")
		...
	}
```

Both rows get a 401 with the same body, and neither sets a cookie. If the answers differed — in wording, in status, or even in how long they took — the endpoint could be used to find out which email addresses have accounts.

With the tests in place and none of the code written, run everything:

```bash
$ go test -count=1 ./...
todo/internal/auth: no non-test Go files in …/internal/auth
...
FAIL	todo/internal/auth [build failed]
FAIL	todo/internal/api	0.040s
FAIL	todo/internal/db	0.045s
FAIL
```

Three failures, one per layer the chapter touches. `internal/auth` holds only tests — there is no package for them to test yet. The API package compiles and runs, and its new cases fail on 404s: the auth routes don't exist. And the database tests already expect the new schema, which the code doesn't provide yet.

## Two tables, and the queries over them

Everything rests on two new tables, added by a migration in `internal/db/migrations`:

<!-- verify: internal/db/migrations/00004_users_and_sessions.sql at=sessions -->
```sql title="internal/db/migrations/00004_users_and_sessions.sql"
CREATE TABLE users (
	id            TEXT PRIMARY KEY NOT NULL,
	email         TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY NOT NULL,
	data       BLOB NOT NULL,
	expiry     INTEGER NOT NULL
);
```

`users` holds the email — unique, so two accounts can't share one — and the PHC string. `sessions` holds one row per live login; its key is `token_hash`, and `data` is the session library's own packed payload. The database tests move with the migration: the pinned schema version and the table listing gain the two tables, and the golden schema is regenerated with `make schema-update`.

Two storage decisions are worth spelling out. Emails are stored **normalized**: trimmed and lowercased. The unique rule compares text byte for byte, so without normalizing, `Alice@example.com` and `alice@example.com` would be two accounts; the service lowercases at every boundary that names an email. And the timestamps are **unix seconds** — whole seconds since 1970 — because `created_at` and `expiry` are instants compared to "now" by a query, unlike a task's due date, which is a calendar date a human reads.

The queries in `internal/db/queries/auth.sql` are three decisions in SQL:

<!-- verify: internal/db/queries/auth.sql at=sessions -->
```sql title="internal/db/queries/auth.sql"
-- name: CreateUser :execrows
INSERT INTO users (id, email, password_hash, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(email) DO NOTHING;
...
-- name: FindSession :one
SELECT data
FROM sessions
WHERE token_hash = ? AND expiry > ?;
...
-- name: UpsertSession :exec
INSERT INTO sessions (token_hash, data, expiry)
VALUES (?, ?, ?)
ON CONFLICT(token_hash) DO UPDATE SET data = excluded.data, expiry = excluded.expiry;
```

`CreateUser` inserts with `ON CONFLICT(email) DO NOTHING`, so a duplicate email changes zero rows instead of raising an error the code would have to parse — the service reads the count and calls it a taken email. `FindSession` carries the expiry check in its `WHERE`, so an expired row is invisible before anything cleans it up. `UpsertSession` is add-or-overwrite, exactly what the session library asks its store to do.

Two more queries finish the file: `DeleteSession` for logout, and `DeleteExpiredSessions` for the cleanup sweep the server runs at boot.

## The auth service

`internal/auth` is a package of its own — users, hashing, and session storage — and it talks to the database through those generated queries. The two failures its callers must tell apart are named up front:

<!-- verify: internal/auth/auth.go at=sessions -->
```go title="internal/auth/auth.go"
var ErrEmailTaken = errors.New("email is already registered")
...
var ErrInvalidCredentials = errors.New("invalid email or password")
...
const SessionUserID = "user_id"
```

One sentinel for a taken email, one for bad credentials — deliberately one for both a wrong password and an unknown email — and one constant naming the session key a login writes.

`Register` normalizes the email, hashes the password, inserts the row, and then looks at how many rows changed:

<!-- verify: internal/auth/auth.go at=sessions -->
```go title="internal/auth/auth.go"
	email = normalizeEmail(email)
	...
	user := User{
		ID:           id,
		Email:        email,
		PasswordHash: HashPassword(password),
		CreatedAt:    time.Now().UTC().Truncate(time.Second),
	}
	...
	var n int64
	err = db.WithConcurrentTx(ctx, s.db, func(conn *sql.Conn) error {
		var err error
		n, err = db.New(conn).CreateUser(ctx, db.CreateUserParams{
			ID:           user.ID.String(),
			Email:        user.Email,
			PasswordHash: user.PasswordHash,
			CreatedAt:    user.CreatedAt.Unix(),
		})
		return err
	})
	...
	if n == 0 {
		return User{}, fmt.Errorf("register user %s: %w", email, ErrEmailTaken)
	}
	return user, nil
```

The hash happens before the insert, so a duplicate registration still pays the argon2id cost — and in exchange, registration never races: there is no separate "is this email free?" read that another request could slip through. Zero rows changed *is* the answer, read from the row count instead of parsed out of the database's error text.

`Authenticate` looks the user up, and the interesting branch is the one where the lookup finds nothing:

<!-- verify: internal/auth/auth.go at=sessions -->
```go title="internal/auth/auth.go"
	email = normalizeEmail(email)
	row, err := s.queries.GetUserByEmail(ctx, email)
	if errors.Is(err, sql.ErrNoRows) {
		_, _ = VerifyPassword(password, dummyHash) // discarded: the work is the point
		return User{}, ErrInvalidCredentials
	}
	...
	if !ok {
		return User{}, ErrInvalidCredentials
	}
	return user, nil
```

The missing-account branch verifies the typed password against a fixed dummy hash before failing. The result is thrown away — the work is the point. Without it, "no such email" would return in a fraction of a millisecond while "wrong password" pays the full scramble, and that difference is a signal an attacker can measure.

One small function decides what an email means, and every boundary calls it:

<!-- verify: internal/auth/auth.go at=sessions -->
```go title="internal/auth/auth.go"
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
```

Lowercased and trimmed, in one place, so the unique rule and the lookups always agree.

## The session store

Now the ticket. The app doesn't hand-roll sessions; it uses a small, focused library called **scs** — a session manager that keeps its payloads in a **store** the app provides. The app's store is `internal/auth/session.go`, and it keeps rows in the `sessions` table.

Here's the coat-check picture. On login, the library creates a **token**: a long random string, the ticket. The token goes to the client inside the cookie; the payload — who you are, when the session expires — goes into the table, and every later request shows the ticket back so the server can find the row it names. A stolen database should hand a reader no working ticket, so the table stores a fingerprint instead of the token: `hex(SHA-256(token))`. The coat check keeps stubs, not tickets.

Two lines pin the store to the library's contract — both the required interface and the optional context-aware one, which lets a request's deadline reach the queries:

<!-- verify: internal/auth/session.go at=sessions -->
```go title="internal/auth/session.go"
var (
	_ scs.Store    = (*SessionStore)(nil)
	_ scs.CtxStore = (*SessionStore)(nil)
)
```

These handshakes are checked by the compiler: if the store stops matching what the library expects, the build fails instead of the behavior changing quietly.

Finding a session hashes the token before it touches SQL, and a miss is not an error:

<!-- verify: internal/auth/session.go at=sessions -->
```go title="internal/auth/session.go"
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
```

"Row not found" becomes `found == false` — a token nothing holds is an ordinary miss — and the expiry check rides inside the query, so a dead session is simply not found.

Writing one rides the same concurrent transaction every other write in the app uses:

<!-- verify: internal/auth/session.go at=sessions -->
```go title="internal/auth/session.go"
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
```

The token is hashed on the way in, so the raw value never reaches a table — it only ever appears in the cookie the client receives.

And the fingerprint itself is three lines:

<!-- verify: internal/auth/session.go at=sessions -->
```go title="internal/auth/session.go"
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
```

A fast hash is the right tool here: the token is 256 random bits, so there is nothing to guess, and the expensive argon2id recipe exists for human passwords, not tokens. What the fingerprint buys is the leak property — a copy of the database contains no ticket anyone can replay.

Two small things complete the store: the three context-free methods the library's interface also requires, each delegating to its context-aware twin, and `DeleteExpired`, the sweep the library never does — expired rows are refused by lookups but stay in the table until something removes them.

## Three routes and a cookie

In `internal/api/auth.go`, the HTTP layer declares what it needs from the auth package: two operations, not a database or a hashing recipe.

<!-- verify: internal/api/auth.go at=sessions -->
```go title="internal/api/auth.go"
type Authenticator interface {
	Register(ctx context.Context, email, password string) (auth.User, error)
	Authenticate(ctx context.Context, email, password string) (auth.User, error)
}
...
var _ Authenticator = (*auth.Service)(nil)
```

The interface lives in the package that uses it, and the line below it is a handshake: if `auth.Service` ever stops matching, the build fails.

The two request shapes carry different rules, on purpose:

<!-- verify: internal/api/auth.go at=sessions -->
```go title="internal/api/auth.go"
type registerRequest struct {
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required,min=8,max=128"`
}
...
type loginRequest struct {
	Email    string `json:"email" validate:"required"`
	Password string `json:"password" validate:"required"`
}
```

Registration enforces the policy — an address that looks like an email, a password of at least 8 characters and at most 128 — while login only checks that both fields are present. A short password at login is still a wrong password: a 401, not a 422.

The response shape is the public half of a user:

<!-- verify: internal/api/auth.go at=sessions -->
```go title="internal/api/auth.go"
type userResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
}
```

There is no field for the hash, which makes "the password never leaves" a property of the type rather than of a handler remembering to leave it out.

The register handler binds, validates, calls the service, and answers 201 — no session, no cookie. An account that exists is a fact a client can see, and logging in is a separate move. The login handler is where the session comes into being:

<!-- verify: internal/api/auth.go at=sessions -->
```go title="internal/api/auth.go"
func (s *server) login(c echo.Context) error {
	var req loginRequest
	if err := bindBody(c, &req); err != nil {
		return err
	}
	if err := c.Validate(&req); err != nil {
		return err
	}

	ctx := c.Request().Context()
	user, err := s.auth.Authenticate(ctx, req.Email, req.Password)
	if err != nil {
		return err
	}
	s.sessions.Put(ctx, auth.SessionUserID, user.ID.String())
	return c.JSON(http.StatusOK, newUserResponse(user))
}
```

The id goes into the session the middleware loaded for this request, under `auth.SessionUserID`, and the library writes the cookie when the response is written. Nothing in the handler names a cookie or a table — that's the manager's job.

Logout is the shortest handler:

<!-- verify: internal/api/auth.go at=sessions -->
```go title="internal/api/auth.go"
func (s *server) logout(c echo.Context) error {
	if err := s.sessions.Destroy(c.Request().Context()); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}
```

`Destroy` removes the row and marks the session destroyed, so the response comes back with the cookie cleared. A logout with no session is still a 204, because "no session" is already true.

The cookie's whole policy lives in one constructor in `internal/api/sessions.go`:

<!-- verify: internal/api/sessions.go at=sessions -->
```go title="internal/api/sessions.go"
	m.Lifetime = 24 * time.Hour
	...
	m.Cookie.Secure = true
	...
	m.Cookie.HttpOnly = true
	...
	m.Cookie.SameSite = http.SameSiteLaxMode
	...
	m.Cookie.Path = "/"
	...
	m.ErrorFunc = sessionErrorFunc
	return m
```

Every value is written down even when it matches the library's default, because a default is not a decision. The lifetime is 24 hours, absolute rather than sliding, so a stolen cookie can't be kept alive by using it. `Secure` says the browser must never send the cookie over plain http — the flag is enforced by the browser, not the server, which is why the walkthrough replays the cookie by hand. `HttpOnly` keeps scripts from reading it, and `SameSite=Lax` lets the cookie ride a normal link into the app while refusing cross-site form posts. `Path=/` means the API and, later, the web pages share one session.

When loading or saving a session fails, the library calls back into the API's own error shape:

<!-- verify: internal/api/sessions.go at=sessions -->
```go title="internal/api/sessions.go"
func sessionErrorFunc(w http.ResponseWriter, r *http.Request, err error) {
	LoggerFrom(r.Context()).Error("session failed", "err", err)
	w.Header().Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	w.WriteHeader(http.StatusInternalServerError)
	_ = json.NewEncoder(w).Encode(errorResponse{Code: codeInternal, Message: "internal error"})
}
```

The failure is logged through the request's logger, so the record carries the request id, and the client gets the same `internal_error` object every other server bug produces.

## The stack, the wiring, and one moved helper

The session layer joins the middleware stack as a fifth entry:

<!-- verify: internal/api/middleware.go at=sessions -->
```go title="internal/api/middleware.go"
//	RequestID -> request logging -> Recover -> Timeout -> sessions -> BodyLimit -> Gzip -> CORS -> Secure
...
		echo.WrapMiddleware(sessions.LoadAndSave),
```

The order reads top-down as a request travels. The session layer sits inside the deadline — loading and saving a session are database work — and above the layers that shape a body or a response, which have nothing to say about a session.

The one error handler gains the two auth failures, and the order of its cases is the classification:

<!-- verify: internal/api/error.go at=sessions -->
```go title="internal/api/error.go"
	case errors.Is(err, auth.ErrEmailTaken):
		...
		return http.StatusConflict, errorResponse{
			Code:    codeEmailTaken,
			Message: auth.ErrEmailTaken.Error(),
		}
	...
	case errors.Is(err, auth.ErrInvalidCredentials):
		...
		return http.StatusUnauthorized, errorResponse{
			Code:    codeUnauthorized,
			Message: auth.ErrInvalidCredentials.Error(),
		}
```

A taken email is a 409 with a code of its own, `email_taken`, so a form can put the message on the email field; bad credentials are a 401 with `unauthorized`, the same for both halves of a failed login. The validator also gains one sentence — `must be a valid email address` — because the library's fallback isn't prose.

`api.New` grows two parameters — the authenticator and the session manager — and the routes hang off the same `/api/v1` group:

<!-- verify: internal/api/api.go at=sessions -->
```go title="internal/api/api.go"
func New(st store.Store, authn Authenticator, sessions *scs.SessionManager, logger *slog.Logger) *echo.Echo {
...
	g.POST("/auth/register", s.register)
	g.POST("/auth/login", s.login)
	g.POST("/auth/logout", s.logout)
```

The manager arrives configured, so the constructor doesn't re-decide the cookie — one policy, one place.

One more change ripples out from the new package. The concurrent-transaction helper every write uses moves from `internal/store` to `internal/db`, because the auth package is now its second caller and the rules it carries belong to the package that owns the database:

<!-- verify: internal/db/tx.go at=sessions -->
```go title="internal/db/tx.go"
func WithConcurrentTx(ctx context.Context, db *sql.DB, fn func(*sql.Conn) error) error {
```

The body doesn't change; the store's call sites and the helper's test follow it to the new home, and the name they call is now `db.WithConcurrentTx`. Alongside the move, the store lends out its database handle, so the auth package serves other tables of the same database without opening a second connection:

<!-- verify: internal/store/turso.go at=sessions -->
```go title="internal/store/turso.go"
func (s *TursoStore) DB() *sql.DB { return s.db }
```

One process, one connection pool, one close — the store still owns the handle's lifecycle, and the auth package only borrows it.

Finally, the server wires the new material from that handle and sweeps dead sessions once at boot:

<!-- verify: cmd/todo-server/main.go at=sessions -->
```go title="cmd/todo-server/main.go"
	sqlDB := st.DB()
	sessionStore := auth.NewSessionStore(sqlDB)
	if n, err := sessionStore.DeleteExpired(ctx); err != nil {
		logger.Error("session sweep failed", "err", err)
	} else if n > 0 {
		logger.Info("expired sessions removed", "count", n)
	}

	e := api.New(st, auth.NewService(sqlDB), api.NewSessionManager(sessionStore), logger)
```

The sweep is the cleanup half of expiry: lookups already refuse an expired row, but nothing removes it until this runs. A sweep that fails is logged and boot continues — readiness is where a broken database gets reported.

## Make it pass

The auth package first:

```bash
$ go test -count=1 -v ./internal/auth
--- PASS: TestHashPassword_RoundTrip (0.18s)
--- PASS: TestHashPassword_Encoding (0.05s)
--- PASS: TestVerifyPassword_Errors (0.00s)
--- PASS: TestVerifyPassword_UsesEncodedParams (0.04s)
--- PASS: TestRegister (0.07s)
--- PASS: TestRegister_DuplicateEmail (0.13s)
--- PASS: TestAuthenticate (0.19s)
--- PASS: TestSessionStore_RoundTrip (0.03s)
--- PASS: TestSessionStore_ContextlessTrio (0.03s)
--- PASS: TestSessionStore_CommitReplaces (0.04s)
--- PASS: TestSessionStore_HashesTokenAtRest (0.03s)
--- PASS: TestSessionStore_ExpiredIsNotFound (0.04s)
--- PASS: TestSessionStore_DeleteExpired (0.04s)
ok  	todo/internal/auth	0.234s
```

Thirteen cases: the hash pair, the encoding, the malformed-input contract, register, the duplicate, authenticate, and the session store's round trip, context-free methods, overwrite, token-at-rest fingerprinting, expiry, and sweep. The cases that scramble a password take tens of milliseconds; the rest are instant.

The API layer next:

```bash
$ go test -count=1 -v ./internal/api
--- PASS: TestHealthz (0.00s)
--- PASS: TestReady_OK (0.00s)
--- PASS: TestReady_StoreDown (0.00s)
...
--- PASS: TestUnknownRoute_ErrorShape (0.00s)
--- PASS: TestRegister (0.13s)
--- PASS: TestRegister_DuplicateEmail (0.19s)
--- PASS: TestRegister_Validation (0.00s)
--- PASS: TestLogin_SetsSession (0.19s)
--- PASS: TestLogin_CookieKeysTheStoredSession (0.16s)
--- PASS: TestLogin_WrongPassword (0.00s)
--- PASS: TestSession_VisibleToHandlers (0.18s)
--- PASS: TestLogout (0.00s)
ok  	todo/internal/api	0.241s
```

Eight new cases here. The last leg is the interop proof: a login's cookie is presented back and a handler reads the user id out of the loaded session; a token nothing holds arrives as an empty session, not a forged one; and logout deletes the row the cookie names.

Then the wire. Start the server as before — in a scratch directory with `TODO_DB` and `TODO_LOG` inside it — and make one `curl` per claim. Registration first, then the two refusals:

```bash
$ curl -s -i -X POST -H "Content-Type: application/json" --data '{"email":"Alice@Example.COM","password":"correct horse battery staple"}' http://127.0.0.1:18084/api/v1/auth/register
HTTP/1.1 201 Created
Content-Type: application/json
...
X-Request-Id: tzKbpnZhgsNFVqxrlYaXXmDTunBylytr
Date: Thu, 15 Oct 2026 06:47:20 GMT
Content-Length: 110

{"id":"01a13e50-bc6c-774f-ad22-41efd951c1a4","email":"alice@example.com","created_at":"2026-10-15T06:47:20Z"}

$ curl -s -i -X POST -H "Content-Type: application/json" --data '{"email":"alice@example.com","password":"another long password"}' http://127.0.0.1:18084/api/v1/auth/register
HTTP/1.1 409 Conflict
...
{"code":"email_taken","message":"email is already registered"}

$ curl -s -i -X POST -H "Content-Type: application/json" --data '{"email":"not-an-email","password":"short"}' http://127.0.0.1:18084/api/v1/auth/register
HTTP/1.1 422 Unprocessable Entity
...
{"code":"validation_failed","message":"validation failed","fields":[{"field":"email","message":"must be a valid email address"},{"field":"password","message":"must be at least 8"}]}
```

The 201 echoes the new user, and the email in the answer is lowercase even though the request capitalized it — normalization, visible on the wire. The second registration is the same address in different case: 409 with `email_taken`. The third is refused before the service is reached: a 422 listing both broken rules.

Now the login — the request that gets a cookie — and the two failures after it:

```bash
$ curl -s -D - -X POST -H "Content-Type: application/json" --data '{"email":"alice@example.com","password":"correct horse battery staple"}' http://127.0.0.1:18084/api/v1/auth/login
HTTP/1.1 200 OK
Cache-Control: no-cache="Set-Cookie"
Content-Type: application/json
...
Set-Cookie: session=TYMJQH4dCiiiw5o1m1LSnQg8y-jIpNwfht3ApbQ8RFA; Path=/; Expires=Fri, 16 Oct 2026 06:47:22 GMT; Max-Age=86400; HttpOnly; Secure; SameSite=Lax
...
{"id":"01a13e50-bc6c-774f-ad22-41efd951c1a4","email":"alice@example.com","created_at":"2026-10-15T06:47:20Z"}

$ curl -s -i -X POST -H "Content-Type: application/json" --data '{"email":"alice@example.com","password":"wrong password"}' http://127.0.0.1:18084/api/v1/auth/login
HTTP/1.1 401 Unauthorized
...
{"code":"unauthorized","message":"invalid email or password"}

$ curl -s -i -X POST -H "Cookie: session=TYMJQH4dCiiiw5o1m1LSnQg8y-jIpNwfht3ApbQ8RFA" http://127.0.0.1:18084/api/v1/auth/logout
HTTP/1.1 204 No Content
Cache-Control: no-cache="Set-Cookie"
...
Set-Cookie: session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax
...
```

The `Set-Cookie` line is the ticket: a `session` cookie holding the token, a day's `Expires` and `Max-Age`, and the flags `HttpOnly; Secure; SameSite=Lax`. `curl` doesn't keep cookies for us, so the logout sends it back by hand. The wrong password answers 401 in the one error shape — the same body an unknown email gets — and logout rewrites the cookie to `Max-Age=0`, which is how a browser is told to drop it.

The server's records show the same run from the other side, and the hashing is visible in the durations:

```bash
{"time":"2026-10-15T12:17:20.96719638+05:30","level":"INFO","msg":"request","request_id":"tzKbpnZhgsNFVqxrlYaXXmDTunBylytr","method":"POST","path":"/api/v1/auth/register","status":201,"duration":26936871}
...
{"time":"2026-10-15T12:17:21.062878491+05:30","level":"WARN","msg":"request","request_id":"yOCZpiuVLiNGUAaDquFykEQEyDcRUjMP","method":"POST","path":"/api/v1/auth/login","status":401,"duration":18848856}
```

Register and the failed login take about 27 and 19 milliseconds — the argon2id work — while every other request in the run is under a millisecond. The expense shows up exactly where a password was handled.

## If something went wrong

**Writes fail with `Concurrent transaction mode is only supported when MVCC is enabled`.** The message:

```bash
register user: concurrent transaction: begin: turso: error: Transaction
error: Concurrent transaction mode is only supported when MVCC is enabled
```

Every write in this app rides a concurrent transaction, and the database engine accepts those only under MVCC. The store turns that mode on before anything else, so if you meet this message, a database was opened without that first step. Fix: open the way the store opens — `journal_mode = mvcc` first, then the migrations.

**`scs: no session data in context`.** The panic the session library raises when a handler writes into a session the request never loaded:

```bash
--- FAIL: TestSessionWithoutLayer (0.00s)
panic: scs: no session data in context [recovered, repanicked]
```

`sessions.Put` doesn't create a session; it writes into the one the middleware loaded into the request's context. Without the session layer in the stack, there is nothing to write into, and the library panics rather than dropping the write quietly. Fix: keep `echo.WrapMiddleware(sessions.LoadAndSave)` in the stack, inside the deadline. The failure is loud on purpose — a login that answers 200 is also proof the layer is installed.

**The expired row is still in the table.** Nothing fails; the surprise is a query. After a session expires, lookups report it missing, and yet the row is still there. The sessions live in the database, and because the file is in Turso's MVCC format, stock `sqlite3` cannot open it — it answers `file is not a database`. The app reads the file through its own driver, which still finds the dead row: the session library never removes rows, so it sits there until something deletes it. The expiry check in `FindSession` is what makes an expired row invisible — it is not a cleanup that may not have run. Fix: the boot-time `DeleteExpired` sweep. Enforcement and cleanup are two mechanisms, and only the first is on the request path.

<details>
<summary>Going deeper: why the hash spends memory</summary>

Guessing a password means trying candidates, and the defender's goal is to make every try cost real resources. Graphics cards are wonderful at simple arithmetic and terrible at needing a lot of memory at once — so argon2id's cost is mostly memory: 19 MiB per guess here, a floor the OWASP password-storage guidance names. Sixteen logins scrambled at the same moment hold around 300 MiB, which a small server can afford. Parallelism is one lane on purpose: the server already serves several requests at once, and letting each hash claim more cores would multiply memory in flight without lengthening the attacker's work per guess. The parameters were measured before they were fixed, and they travel inside every stored hash, so raising them later won't invalidate anything already stored.

</details>

<details>
<summary>Going deeper: what the cookie's flags mean</summary>

`Secure` is a promise the browser makes, not the server: it won't send the cookie over plain http, which is why the walkthrough replays the cookie by hand. `HttpOnly` hides the cookie from page scripts, so a stray script can't read the ticket. `SameSite=Lax` keeps the cookie off cross-site form posts and image loads while still letting it ride a top-level navigation — with `Strict`, following a link into the app would arrive logged out. And the lifetime is absolute: 24 hours from login, not 24 hours of activity, so a stolen cookie can't be kept alive by using it.

</details>

<details>
<summary>Going deeper: why a missing account still pays for a hash</summary>

The identical 401 hides which half of a login failed. But identical text doesn't hide timing: without the dummy verify, an unknown email would return after one quick lookup, while a wrong password pays the full scramble — tens of milliseconds. Measured from outside, that gap turns the endpoint into an account finder, exactly what the identical message was supposed to prevent. The dummy hash makes both paths pay the same work, and the constant-time comparison closes the same door on the digest itself: a comparison that stopped at the first differing byte would leak how much of a guess was right.

</details>

The API knows who is asking now. Next it decides what they're allowed to do: every task gets an owner, and the routes that change one start asking for a logged-in user.

<div class="day-tracker" data-day="39"></div>
