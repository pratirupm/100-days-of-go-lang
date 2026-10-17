---
title: Web security
day: 46
time: "3 hours"
description: Make the app's safety promises enforceable — a policy on every response, a stronger cookie, a fresh session at login, and a budget on password guesses.
sidebar:
  order: 39
---

Every response the app sends carries a short set of notes alongside the body. Those notes are called **headers**, and some of them are promises to the browser: don't run scripts on this page, don't let another site embed it, don't send the session cookie over a plain connection. The app has been making a few of those promises. Now it will make them all, in writing.

This is the hardening pass. We'll write a policy for the pages and send it on every response, give the session cookie a name the browser protects on its own, re-issue the session at login, and put a budget on how fast a password can be guessed.

None of it changes how the app looks. What changes is what someone on the other end can make it do.

## The tests come first

The contract lives in two new test files — `internal/api/security_test.go` and `internal/web/security_test.go` — plus a few new cases in the auth tests on both edges. The policy strings are spelled out in the test file rather than read from the code they test, because a test that reads the constant it checks cannot catch the constant changing:

<!-- verify: internal/api/security_test.go at=web-security -->
```go title="internal/api/security_test.go"
// The policies the cases pin, spelled here rather than read from the
// implementation: a test that reads the constant it tests cannot catch the
// constant changing. TestCSP_Snapshot is the review surface for an edit —
// any policy change lands as a diff in this file.
const (
	// wantCSP is the process policy: the pages' and the API's, the one the
	// MPA's inventory produced.
	wantCSP = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

	// wantSwaggerCSP is the docs UI's policy: swagger-ui ships a script
	// bundle and an inline bootstrap script, an inline style block, and
	// data: icons in its stylesheet, so the process policy would leave it
	// blank.
	wantSwaggerCSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
)
```

The comment's MPA is the browser pages — the multi-page site the server renders. One policy belongs to the pages and the API, and the other belongs to the docs page — a moment below explains why it needs its own. The header table is the rest of the contract:

<!-- verify: internal/api/security_test.go at=web-security -->
```go title="internal/api/security_test.go"
// securityHeaderSet is the policy set every response the process writes
// must carry. TestSecurityHeaders asserts it one header per subtest — a
// missing header fails by name — and the refusal cases assert the same set
// on the responses that used to leave without it.
var securityHeaderSet = []struct{ header, want string }{
	{echo.HeaderContentSecurityPolicy, wantCSP},
	{echo.HeaderXContentTypeOptions, "nosniff"},
	{echo.HeaderXFrameOptions, "DENY"},
	{echo.HeaderReferrerPolicy, "no-referrer"},
	{echo.HeaderXXSSProtection, "0"},
}

// assertSecurityHeaderSet asserts the whole set, one header per assertion.
func assertSecurityHeaderSet(t *testing.T, header http.Header) {
	t.Helper()
	for _, tc := range securityHeaderSet {
		assert.Equalf(t, tc.want, header.Get(tc.header), "header %s", tc.header)
	}
}
```

`TestSecurityHeaders` walks the table one header per subtest, so a missing or changed header fails by name, and the same helper checks the responses that used to leave without any headers at all.

Run the whole suite and watch what the app does not do yet:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	1.792s
--- FAIL: TestServer_WebForms (0.12s)
    integration_test.go:423:
        	Error:      	Expected value not to be nil.
        	Messages:   	the login page sets the session cookie
FAIL
FAIL	todo/cmd/todo-server	1.980s
--- FAIL: TestSecurityHeaders (0.00s)
    --- FAIL: TestSecurityHeaders/Content-Security-Policy (0.00s)
            	expected: "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
            	actual  : ""
...
--- FAIL: TestSessionCookie_HostPrefix (0.56s)
        	expected: "__Host-session"
        	actual  : "session"
--- FAIL: TestLoginLimiter_429 (0.73s)
        	expected: 429
        	actual  : 401
FAIL
FAIL	todo/internal/api	0.863s
...
--- FAIL: TestLoginLimiter_OneBudgetAcrossEdges (0.01s)
        	expected: 429
        	actual  : 500
FAIL
FAIL	todo/internal/web	0.105s
```

Every failure names a missing piece. The policy header is empty because no layer sets it, and `X-Frame-Options` still says `SAMEORIGIN` while the policy we're about to write says the pages may never be framed. The cookie case wants `__Host-session` and gets `session`, and the process-level flow fails for the same reason — it reads the cookie by its new name while the server still writes the old one. The limiter cases fail the only way they can before a limiter exists: the sixth attempt reaches the password check and answers 401 where 429 is owed. And the web case answers 500, because the sixth attempt reached the JSON edge's handler — which in that test is built to crash — and the panic catcher turned the crash into a server error. A refused attempt should never reach a handler at all.

## One list, reordered

All of this rides the middleware stack — the ordered line of code that runs around every request. The order is still the decision, and the hardening pass moves one layer: `Secure` climbs from last place to third, and the login limiter takes the fifth spot.

<!-- verify: internal/api/middleware.go at=web-security -->
```go title="internal/api/middleware.go"
// The middleware stack is one ordered list around every route the server
// serves, and the order is the chapter's first decision:
//
//	RequestID -> request logging -> Secure -> Recover -> login limiter ->
//	Timeout -> sessions -> BodyLimit -> Gzip -> CORS
...
```

Echo runs the list outermost first, so the list reads top-down as a request travels. Setting response headers has no dependency on any other layer, and the header map is written when the response is written — so `Secure`'s position decides only which refusals carry the headers. Sitting above the session load, the body limit, and the cross-origin preflight puts the header set on those responses too: the 413, the 204, and a failed session load all leave with it now.

One more change rides the top of the list. The app trusts a client's `X-Request-ID` header on purpose — matching a caller's report to the server's records is the whole point — but it trusted the header without a size limit. An id over 64 characters is not a correlation id; it is a payload headed for every record about the request.

<!-- verify: internal/api/middleware.go at=web-security -->
```go title="internal/api/middleware.go"
	// maxRequestIDLength bounds a client-supplied X-Request-ID. Echo's own
	// generator makes 32 characters; 64 is twice that, so a caller with a
	// longer id has built one, not quoted one, and the id is replaced with
...
	maxRequestIDLength = 64
```

The bound is applied inside echo's own id layer, after echo has set the response header and before the rest of the chain runs:

<!-- verify: internal/api/middleware.go at=web-security -->
```go title="internal/api/middleware.go"
		// client-supplied id is trusted on purpose: correlating a caller's
		// report with the server's records is the whole point, and the id
		// reaches nothing but a log field and the response header. The
		// trust is bounded in effect — the JSON handler escapes the value
		// and it names nothing — and the audit bounded it in size: an id
		// over maxRequestIDLength is not a correlation id, it is a payload
		// headed for every record about the request, so it is replaced with
		// a generated one before anything reads it. The replacement happens
		// through RequestIDHandler, which echo calls after it has set the
		// header and before the chain runs; the response header is the
		// canonical copy, so the client reads the id that will be logged.
		middleware.RequestIDWithConfig(middleware.RequestIDConfig{
			RequestIDHandler: func(c echo.Context, id string) {
				if len(id) > maxRequestIDLength {
					c.Response().Header().Set(echo.HeaderXRequestID, rand.Text())
				}
			},
		}),
```

An over-long id is replaced with a freshly generated one — and because the response header is the copy the client reads back, the client sees the id that will be logged.

The `Secure` layer keeps every header it names, and this hardening pass changed two values:

<!-- verify: internal/api/middleware.go at=web-security -->
```go title="internal/api/middleware.go"
		middleware.SecureWithConfig(middleware.SecureConfig{
			XSSProtection:         "0",
			ContentTypeNosniff:    "nosniff",
			XFrameOptions:         "DENY",
			HSTSMaxAge:            31536000,
			HSTSExcludeSubdomains: true,
			ContentSecurityPolicy: contentSecurityPolicy,
			ReferrerPolicy:        "no-referrer",
		}),
```

Here is what each one does, in the order the config names them:

- **`X-XSS-Protection: 0`** switches off an old browser filter that had a habit of making pages less safe rather than more.
- **`X-Content-Type-Options: nosniff`** tells the browser to trust the content type the server declared instead of guessing from the bytes.
- **`X-Frame-Options: DENY`** says no other page may show ours inside a frame — the legacy twin of the policy's `frame-ancestors` rule, and the two must agree.
- **`Strict-Transport-Security`** — when the app is reached over https, it tells the browser to keep using https for a year. It is set only on an https request: a browser ignores it on a plain connection anyway, so sending it there would be a lie.
- **`Content-Security-Policy`** is the rule sheet for what a page may load and do; its value is the policy the next section writes.
- **`Referrer-Policy: no-referrer`** means that when a visitor follows a link away, the request says nothing about where it came from.

## A policy for the pages

A **Content Security Policy** is a list of rules the browser enforces about a page: what the page may load, where its forms may send data, and who may embed it. The rules are written from the pages' inventory — what the pages actually use — and that inventory is almost empty: one stylesheet, no scripts, no images.

<!-- verify: internal/api/middleware.go at=web-security -->
```go title="internal/api/middleware.go"
const contentSecurityPolicy = "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
```

Here is what each directive says, in order:

- **`default-src 'none'`** is the floor. A resource kind the policy does not name is refused, so adding one later is a deliberate edit here, not a default.
- **`script-src 'none'`** is the central claim: there is no JavaScript anywhere in the pages, inline or external, and the policy says so.
- **`style-src 'self'`** allows the one stylesheet the app serves — `/static/app.css` — and nothing else.
- **`img-src 'none'`**: the pages embed no images at all.
- **`form-action 'self'`** keeps every form's submission on this origin: the destination is policy, not markup.
- **`base-uri 'none'`** refuses a `<base>` element, so a URL in a page cannot be re-rooted under an injected one.
- **`frame-ancestors 'none'`** is the clickjacking rule: no page may be framed at all.

The order of the directives is the order a reader asks the questions: what is allowed by default, then scripts, then styles, then the rest.

The pages needed no change to satisfy the policy, and that is worth a beat. The stylesheet is external on purpose, and that is exactly why `style-src 'self'` is enough. A single `style` attribute in a template would have forced `'unsafe-inline'` into the policy, and that is the loophole the whole rule exists to avoid.

One more property comes free from where the policy is written: it rides every response the process sends, including the JSON ones. A policy constrains a browser, and a browser reading JSON has nothing to enforce — but writing it once, in the one layer every response passes through, is what makes "every response" true.

## The docs page gets its own policy

The `/swagger` page is the one exception. swagger-ui is a JavaScript application: it ships its own script bundle and an inline bootstrap script, carries an inline `<style>` block, uses `data:` images in its stylesheet, and fetches the API's description with a background request. The pages' policy would leave it a blank page, and weakening the pages' policy for its sake would be the wrong trade.

<!-- verify: internal/api/middleware.go at=web-security -->
```go title="internal/api/middleware.go"
const swaggerContentSecurityPolicy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
```

The directives that differ are exactly the four things swagger-ui uses; everything else keeps the pages' shape. The exception is applied where it lives — as route middleware on the docs routes:

<!-- verify: internal/api/middleware.go at=web-security -->
```go title="internal/api/middleware.go"
// swaggerUIHeaders replaces the process policy on the docs UI's routes. It
// runs as route middleware, inside the stack, so the response already
// carries every other header; this call changes one value, and the
// exception is spelled where the route is registered (see api.go).
func swaggerUIHeaders(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		c.Response().Header().Set(echo.HeaderContentSecurityPolicy, swaggerContentSecurityPolicy)
		return next(c)
	}
}
```

Route middleware wraps the handler it is registered beside, and the route names it:

<!-- verify: internal/api/api.go at=web-security -->
```go title="internal/api/api.go"
	e.GET("/swagger/*", echoSwagger.WrapHandler, swaggerUIHeaders)
```

One header is replaced before the handler writes, and every other header still rides the response. `'unsafe-inline'` is confined to a route that serves the generated description and swagger-ui's own files — no user input reaches it.

## The cookie's new name

The app sets exactly one cookie — the session ticket — and this hardening pass found every flag already right: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, a 24-hour lifetime. The change is the name.

<!-- verify: internal/api/sessions.go at=web-security -->
```go title="internal/api/sessions.go"
const hostCookieName = "__Host-session"
```

The `__Host-` prefix is a rule the browser enforces, and it is strict about it: a cookie that claims the prefix must be marked `Secure`, must use `Path=/`, and must carry no `Domain`. All three were already true, which is why the rename is the whole change:

<!-- verify: internal/api/sessions.go at=web-security -->
```go title="internal/api/sessions.go"
	// The name carries the __Host- prefix, which is the browser's rule and
	// not the server's: a cookie that claims it must be Secure, have Path
	// "/", and carry no Domain — all three already true of this policy,
	// which is why the audit's rename is the whole change. What the browser
	// enforces in return is origin-scoping: a sibling application on a
	// parent domain cannot write a "__Host-session" cookie that this origin
	// would read, so cookie shadowing and fixation-by-subdomain are closed
	// by the name. The cost is one logged-out visit per browser that holds
	// an older "session" cookie: the old name is simply ignored from now
	// on.
	m.Cookie.Name = hostCookieName
```

What the browser gives back is origin-scoping: only this exact origin can set a `__Host-session` cookie, so a sibling application on the same parent domain cannot plant one this app would read. The cost is one logged-out visit per browser that still holds the old `session` cookie — the old name is simply ignored.

## A fresh session at login

There is a quiet attack the app was open to. A session can exist before anyone logs in — the login page itself starts one to hold the token every form carries. If an attacker can make a victim's browser carry the attacker's session cookie, and the victim then logs in, the session the attacker holds is now the victim's logged-in session. The trick is called **session fixation**, and the defense is one rule: when a login changes who a session belongs to, the old ticket is thrown away.

The JSON edge's login renews before it stores anything:

<!-- verify: internal/api/auth.go at=web-security -->
```go title="internal/api/auth.go"
	if err := s.sessions.RenewToken(ctx); err != nil {
		return err
	}
	if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogin, UserID: user.ID, ActorID: user.ID}); err != nil {
		return err
	}
	s.sessions.Put(ctx, auth.SessionUserID, user.ID.String())
	return c.JSON(http.StatusOK, newUserResponse(user))
```

`RenewToken` deletes the row the presented cookie named and makes a fresh token, so the cookie a client held before the login is dead when the response returns — the response's cookie is the only live one. The order is part of the contract: renewal first, then the audit record, then the user id. A login that cannot renew fails before anything is recorded; a login that cannot reach the trail leaves only an anonymous session behind, and the trail never records a login that did not establish a session.

The form edge does the same, and adds one line — the form's safety token is re-issued too:

<!-- verify: internal/web/auth.go at=web-security -->
```go title="internal/web/auth.go"
	if err := s.sessions.RenewToken(ctx); err != nil {
		return err
	}
	if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogin, UserID: user.ID, ActorID: user.ID}); err != nil {
		return err
	}
	s.sessions.Put(ctx, auth.SessionUserID, user.ID.String())
	s.sessions.Remove(ctx, csrfKey)
```

The old safety token was minted for the anonymous session the renewal just retired, and both changes answer the same event: a privilege change. The next page render mints a fresh one.

## A budget for guesses

Nothing has stopped a script from trying passwords as fast as the server could check them. Checking one is deliberately expensive — the scrambling recipe spends a moment of memory-bound work — but a patient script still gets thousands of tries a day. The fix is a budget per source address.

The shape is a **token bucket**, which is what it sounds like: every address starts with five tokens, every login attempt spends one, and one token comes back every ten seconds. The numbers live in one place:

<!-- verify: internal/api/ratelimit.go at=web-security -->
```go title="internal/api/ratelimit.go"
const (
	// webLoginPath and apiLoginPath are the routes the limiter guards, as
	// echo's route patterns: c.Path() answers the registered pattern, so
	// the predicate names the routes rather than any URL that resembles
	// them. The form edge's path is web's; the coupling is this constant
	// and one sentence in web's Register comment.
	webLoginPath = "/login"
	apiLoginPath = "/api/v1/auth/login"

	// loginBurst is the number of attempts a source may make back to back
	// before the bucket empties.
	loginBurst = 5

	// loginRefill is the interval at which one attempt returns to the
	// bucket: five attempts, then one per ten seconds per address.
	loginRefill = 10 * time.Second

	// loginRetryAfter is what the refusal advertises. One refill interval
	// is the longest wait a token can be away, so it is the honest bound.
	loginRetryAfter = "10"

	// loginBucketTTL is how long an idle address keeps its bucket. The
	// window bounds the store's steady size to the addresses seen in the
	// last three minutes, and it is the other half of the memory cost.
	loginBucketTTL = 3 * time.Minute
)
```

Five is a person mistyping a password, and one per ten seconds is a pause rather than a lockout — about eleven attempts a minute, or five password checks per ten seconds for a script.

The limiter itself is echo's rate-limit layer with three settings: which requests count, who they count against, and what a refusal looks like.

<!-- verify: internal/api/ratelimit.go at=web-security -->
```go title="internal/api/ratelimit.go"
// loginLimiter builds the limiter the stack installs (see useStack). It is
// one instance per process, so the budget is one budget.
func loginLimiter() echo.MiddlewareFunc {
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		...
		Skipper: func(c echo.Context) bool {
			if c.Request().Method != http.MethodPost {
				return true
			}
			switch c.Path() {
			case webLoginPath, apiLoginPath:
				return false
			}
			return true
		},
		IdentifierExtractor: peerAddress,
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(loginRefill),
			Burst:     loginBurst,
			ExpiresIn: loginBucketTTL,
		}),
		DenyHandler: func(c echo.Context, _ string, _ error) error {
			c.Response().Header().Set(echo.HeaderRetryAfter, loginRetryAfter)
			return echo.NewHTTPError(http.StatusTooManyRequests, "too many login attempts")
		},
	})
}
```

Read the skipper first: an attempt is a POST that carries credentials. A GET of the login page renders the form — and mints the session its token lives in — and that is not a guess, so a browser that opens the form, backs out, and opens it again never spends a token. The pages' test file owns that half of the contract:

<!-- verify: internal/web/security_test.go at=web-security -->
```go title="internal/web/security_test.go"
// TestLoginLimiter_PageFetchesDoNotSpend pins the method half of the
// predicate: the budget is for attempts — posts that carry credentials — not
// for renders. A browser that opens the form, backs out, and opens it again
// is not guessing, and its first post still reaches the check.
func TestLoginLimiter_PageFetchesDoNotSpend(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{authErr: auth.ErrInvalidCredentials}
	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), authn)

	for range 6 {
		require.Equal(t, http.StatusOK, get(t, e, "/login").Code)
	}

	cookie, token := loginForm(t, e)
	rec := postForm(t, e, "/login", url.Values{
		"csrf_token": {token},
		"email":      {"ada@example.com"},
		"password":   {"wrong horse"},
	}, cookie)

	assert.Equal(t, http.StatusUnauthorized, rec.Code, "page fetches never spend an attempt")
}
```

The case proves the half the verb check protects: six renders spend nothing, and the first post still reaches the password check. The key is the part worth slowing down for:

<!-- verify: internal/api/ratelimit.go at=web-security -->
```go title="internal/api/ratelimit.go"
// peerAddress keys the bucket on the transport's peer address — the socket's
// fact, not a header's claim. A RemoteAddr without a port (a unix socket
// peer, mostly) keys on itself; the error return is always nil because a key
// is always available, and echo's extractor error path exists for extractors
// that can fail to decide.
func peerAddress(c echo.Context) (string, error) {
	host, _, err := net.SplitHostPort(c.Request().RemoteAddr)
	if err != nil {
		return c.Request().RemoteAddr, nil
	}
	return host, nil
}
```

The key is the transport peer — the address on the other end of the socket, which a client cannot choose. The obvious-looking alternative is echo's `RealIP`, which believes the `X-Forwarded-For` header; any client can write that header, so a limiter keyed on it is evaded by editing a string. A limiter keyed on the socket's address is not.

The refusal needs nothing more: the deny handler sets `Retry-After: 10` and returns the house 429, which the one error handler renders in the one error shape — `too_many_requests`, the code derived from the status text. And the budget is one budget across both login routes: the form post and the JSON post draw from the same bucket, because a per-route limiter would hand an attacker two budgets for alternating between them.

The login route's description gains the refusal it can now answer:

<!-- verify: internal/api/auth.go at=web-security -->
```go title="internal/api/auth.go"
//	@Failure		429			{object}	errorResponse	"too many login attempts from this address"
```

Regenerate the API description with the same generation step the docs work used, so the page and the route cannot drift. And one small step before the tests: the limiter imports a time-keeping library the project already carries, so run `go mod tidy` once to record that the app uses it directly now.

## Run it green

The hardening cases first:

```bash
$ go test -count=1 -v ./internal/api ./internal/web
...
--- PASS: TestCSP_Snapshot
--- PASS: TestCSP_SwaggerUI
...
--- PASS: TestLoginLimiter_429
--- PASS: TestLoginLimiter_KeyedOnPeerAddress
--- PASS: TestLoginLimiter_OneBudgetAcrossEdges
--- PASS: TestLoginLimiter_OtherRoutesUnaffected
--- PASS: TestLoginLimiter_PageFetchesDoNotSpend
...
--- PASS: TestLogin_RenewsSession
--- PASS: TestLogin_RenewsSessionAndCSRFToken
...
--- PASS: TestRequestID_LengthCapped
...
--- PASS: TestSecurityHeaders
--- PASS: TestSessionCookie_HostPrefix
...
```

Every case passes, the hardening ones among them — the policy, the docs policy, the refusals, the id cap, the limiter, the cookie's name, and the renewal on both edges. Then the whole suite, one package at a time:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	3.781s
ok  	todo/cmd/todo-server	4.039s
ok  	todo/internal/api	1.642s
ok  	todo/internal/auth	1.151s
ok  	todo/internal/cli	0.500s
ok  	todo/internal/config	0.008s
ok  	todo/internal/db	0.136s
ok  	todo/internal/logging	0.012s
ok  	todo/internal/store	1.406s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.014s
ok  	todo/internal/web	0.161s
ok  	todo/internal/web/assets	0.008s
```

Every package passes, and the api and web lines are the ones that matter here: the same suites that failed a moment ago, now green.

## Talk to the server

Start the server as before — `TODO_DB=todo.db TODO_LOG=todo.log ./todo-server --listen 127.0.0.1:18089` — register an account, and walk the claims. The login page first:

```bash
$ curl -s -D login.headers -o login.html http://127.0.0.1:18089/login
HTTP/1.1 200 OK
Content-Security-Policy: default-src 'none'; …
Set-Cookie: __Host-session=OhvzY2bVcfF5…; Path=/; Expires=Fri, 16 Oct 2026 10:05:21 GMT; Max-Age=86400; HttpOnly; Secure; SameSite=Lax
...
```

The response carries the pages' policy, and the cookie it sets is named `__Host-session`, with every flag already right. Now submit the form — with the token the page embedded and the cookie it set:

```bash
$ curl -s -D login-post.headers -o login-post.html -X POST -H "Content-Type: application/x-www-form-urlencoded" --data "csrf_token=G3M3ZWHCATHX…&email=ada@example.com&password=correct horse battery staple" --cookie "__Host-session=OhvzY2bVcfF5…" http://127.0.0.1:18089/login
HTTP/1.1 303 See Other
Location: /
Set-Cookie: __Host-session=caQP1Ap5OhJZ…; Path=/; …; HttpOnly; Secure; SameSite=Lax
...
cookieA=OhvzY2bVcfF5... cookieB=caQP1Ap5OhJZ...  (A != B: yes)
```

The post answers with a different cookie, and the old one is dead: the pre-login cookie opens a redirect back to the login page, while the post's cookie opens the list. Now the budget: one successful login plus four wrong passwords spend five tokens, and the sixth attempt is refused:

```bash
$ # one login above + four wrong passwords = five; the sixth is refused
$ curl -s -i -X POST -H "Content-Type: application/json" --data '{"email":"ada@example.com","password":"wrong password"}' http://127.0.0.1:18089/api/v1/auth/login
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 10
...
{"code":"too_many_requests","message":"too many login attempts"}
```

The refusal is the house error shape with `Retry-After: 10`. It is not the JSON edge's alone: the same address posting the login form is refused with the same answer, because the budget belongs to the source, not the route.

## If something went wrong

**The process-level test cannot find the cookie.** The message:

```bash
--- FAIL: TestServer_WebForms (0.12s)
    integration_test.go:423:
        	Error:      	Expected value not to be nil.
        	Test:       	TestServer_WebForms
        	Messages:   	the login page sets the session cookie
```

The test looks for the session cookie by name, and the name changed — the helper still compares against `session` while the server writes `__Host-session`, so the lookup finds nothing. The fix: when a name changes, change every reader of it. In `cmd/todo-server/integration_test.go`, the helper that finds the cookie compares against the old name; make it `__Host-session`.

**A page visit spends a login attempt.** The message:

```bash
--- FAIL: TestLoginLimiter_OneBudgetAcrossEdges (0.00s)
    security_test.go:39:
        	Error:      	Not equal: 
        	            	expected: 401
        	            	actual  : 429
        	Test:       	TestLoginLimiter_OneBudgetAcrossEdges
        	Messages:   	attempt 5
FAIL
FAIL	todo/internal/web	0.076s
FAIL
```

The test renders the login form before it posts anything, and a limiter that matches by path alone spends a token on that render — so the fifth post meets an empty bucket. The fix: the verb half of the skipper. An attempt is a POST that carries credentials; a page render is not a guess.

**`expected: 429, actual: 500`.** The sixth attempt reaches the handler instead of being refused:

```bash
--- FAIL: TestLoginLimiter_OneBudgetAcrossEdges (0.01s)
        	expected: 429
        	actual  : 500
FAIL
FAIL	todo/internal/web	0.105s
```

The limiter is missing from the stack, or its route patterns do not match the registered routes, so no bucket is ever spent and the request travels on. The fix: check that `loginLimiter()` sits between the panic catcher and the deadline, and that the two path constants match the routes the server registers exactly. A limiter's position is part of its job — put it below a handler and the work you meant to refuse has already happened.

**`"Cookie" does not contain "Accept-Encoding"`.** The message:

```bash
--- FAIL: TestErrorResponse_Uncompressed (0.00s)
    security_test.go:237:
        	Error:      	"Cookie" does not contain "Accept-Encoding"
        	Test:       	TestErrorResponse_Uncompressed
        	Messages:   	the Vary contract still rides the response
FAIL
FAIL	todo/internal/api	0.146s
FAIL
```

This one comes from a test, not the app: `Vary` is a header that may appear more than once, and `Header.Get` returns only the first value — here the session library's `Cookie`. The server was right, and the assertion was reading the wrong half. The fix: assert against `Header.Values`, where the `Accept-Encoding` entry lives. The rule: a header that may repeat is a list, and `Get` is only for the headers that do not.

<details>
<summary>Going deeper: why a login re-issues the session</summary>

A session that exists before a login is a session someone else could have started. An attacker who can plant a cookie in a victim's browser — a shared computer, an old link, a sibling application on the same domain — can wait for the victim to log in and then use the same session. Renewing at the login removes the possibility rather than watching for it: the token the attacker planted names a row that no longer exists, and the only live cookie is the one the login's response carries. The test proves both halves — the planted cookie opens nothing, and the renewed one opens the task routes.

</details>

<details>
<summary>Going deeper: where the https promise gets its trust</summary>

`Strict-Transport-Security` is a promise made to the browser: stay on https for a year. Sending it over a plain connection would be a lie, so echo sets it only when the request's scheme is https. Behind a proxy — which is how this app will be deployed later — the scheme comes from the `X-Forwarded-Proto` header, and any client can write that header. Echo believes it only when the request's peer is on the loopback, link-local, or private network: the kind of address a proxy on the same machine has, and the kind a stranger on the internet cannot have. The four cases are pinned by tests: https carries the header, plain http carries nothing, and a forwarded claim counts only from a trusted peer.

</details>

<details>
<summary>Going deeper: what the limiter costs in memory</summary>

The limiter keeps one small record per address seen in the last three minutes: the address, a counter, and a timer, about 169 bytes in all. A scratch measurement filled the store with a hundred thousand addresses and read the heap around it:

```bash
n=100000 before=1161984 after=18031360 delta=16869376 per-visitor=168.7 bytes
```

At human login rates the store holds a handful of addresses, and the three-minute sweep keeps it that way. A flood of distinct addresses could grow it — about 170 MB for a million of them — and that is the kind of number to watch before deciding to cap the store. The first attempt to measure this reported a delta of −32 bytes, because the measurement's own store was never read afterward and the compiler was free to throw it away; the honest number needs the store kept alive across the reading.

</details>

The app's promises are enforceable now. Next, the pages get pinned down — snapshot tests that catch any change to what a browser receives.
