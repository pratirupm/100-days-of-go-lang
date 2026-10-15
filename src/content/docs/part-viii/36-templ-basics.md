---
title: The first web page
description: Build the app's first web page — the signed-in user's tasks, drawn by a browser, rendered with templ.
sidebar:
  order: 36
---

The app answers programs now. Send it JSON and it sends JSON back — but open
its address in a browser and there is nothing a person would want to read. It
has no face yet.

Today it gets one: the first web page. Open the server's address, sign in,
and your tasks appear — status, title, priority, due date, labels — drawn as
a page, not printed as JSON.

The page rides everything already built. It is one more route on the same
server, behind the same sign-in check, reading the same store the API writes.
Nothing new listens for requests.

## What a browser asks for

A browser loads a page by sending a request to an address and reading the
text that comes back. When the text is written in **HTML**, the browser draws
it as a page. HTML is the language web pages are written in: plain text with
instructions in angle brackets — `<h1>` marks a heading, `<p>` a paragraph,
`<ul>` and `<li>` a list — and the browser turns those instructions into what
you see on screen. Every page on the web is this: text shaped by a shared
agreement about what the instructions mean.

Our page answers `GET /` — the address a browser asks for when you open a
site's home. It shows the signed-in user's tasks, the same rows the API
returns.

Building that text from Go values needs a tool that mixes text and values
without letting a value become an instruction. Some values are ours, like the
page's title; some come from users, like a task's title. The tool is
**templ**. A `.templ` file is a template for a Go file: write the markup, and
templ turns it into a Go function that writes it. Inside, markup is markup,
and the Go parts are small and typed: `{ expr }` writes a value,
`@Name(args)` renders another component, and `if` and `for` choose and repeat
markup. A **component** is one of those functions — a piece of a page you can
name and compose.

`templ generate` reads every `.templ` file and writes a Go file beside it.
The new code lives in two folders: `internal/web` holds the handler that
answers the request, and `internal/web/views` holds the components that write
the page.

## The tests come first

The page has a contract, and we write it down as tests before the page exists
— the same habit as every piece of the app.

Create the folder `internal/web` and, inside it, `web_test.go`. It is a
test-only package, like the API's tests, and it drives the server through
echo's own `ServeHTTP` — no socket — composed exactly the way `main` composes
it. The helper that builds the server is the first thing to read:

<!-- verify: internal/web/web_test.go at=templates -->
```go title="internal/web/web_test.go"
// newWebAPI builds the server the way cmd/todo-server does: api.New installs
// the middleware stack and the API routes, and the web surface mounts onto
// the same instance, so a page request rides the same ids, records,
// deadlines, headers, and session load as an API request. The session
// manager is the production one over scs's in-memory store — the cookie
// policy under test is the one production uses.
func newWebAPI(t *testing.T, st store.Store) (*echo.Echo, *scs.SessionManager) {
	t.Helper()
	sessions := api.NewSessionManager(memstore.New())
	e := api.New(st, stubAuth{}, sessions, slog.New(slog.DiscardHandler))
	web.New(st, sessions).Register(e)
	return e, sessions
}
```

`api.New` installs the middleware stack and the API routes;
`web.New(...).Register(e)` mounts the pages onto the same instance. A page
request in a test rides the same ids, records, deadlines, headers, and
session load as an API request, because it is one.

The cases act as a signed-in user without going through a login.
`testSession` mints a session through the session manager itself — no login
route, no password — and returns the cookie that presents it:

<!-- verify: internal/web/web_test.go at=templates -->
```go title="internal/web/web_test.go"
func testSession(t *testing.T, sessions *scs.SessionManager) *http.Cookie {
	t.Helper()
	ctx, err := sessions.Load(context.Background(), "")
	require.NoError(t, err)
	sessions.Put(ctx, auth.SessionUserID, testUserID.String())
	token, _, err := sessions.Commit(ctx)
	require.NoError(t, err)
	return &http.Cookie{
		Name:     sessions.Cookie.Name,
		Value:    token,
		Path:     "/",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	}
}
```

Then the page's main case, in subtests — one shape each. The first is the
whole promise in miniature: the user's tasks render with their fields, and
another user's task never appears.

<!-- verify: internal/web/web_test.go at=templates -->
```go title="internal/web/web_test.go"
	t.Run("the user's tasks render", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		seed(t, st, testUserID, "buy milk", func(tt *task.Task) {
			tt.Due = time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
			tt.Tags = []string{"errands", "home"}
		})
		seed(t, st, testUserID, "write the chapter", nil)
		seed(t, st, otherUserID, "another user's task", nil)

		e, sessions := newWebAPI(t, st)
		rec := get(t, e, "/", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, echo.MIMETextHTMLCharsetUTF8, rec.Header().Get(echo.HeaderContentType))

		body := rec.Body.String()
		assert.Contains(t, body, "<title>Tasks</title>", "the page composes the layout")
		assert.Contains(t, body, "buy milk")
		assert.Contains(t, body, "write the chapter")
		assert.Contains(t, body, "due 2026-10-20")
		assert.Contains(t, body, "errands, home")
		assert.Contains(t, body, "priority 3")
		assert.NotContains(t, body, "another user's task", "the page is the logged-in user's scope")
	})
```

The second subtest seeds a task titled `<script>alert("xss")</script>` and
pins the escaping rule both ways: the raw markup must not appear in the page,
and its escaped form must.

<!-- verify: internal/web/web_test.go at=templates -->
```go title="internal/web/web_test.go"
	t.Run("a task title's markup renders inert", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		seed(t, st, testUserID, `<script>alert("xss")</script>`, nil)
		...
		assert.NotContains(t, body, `<script>alert("xss")</script>`, "a title is data, never markup")
		assert.Contains(t, body, `&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;`)
	})
```

A third subtest seeds no tasks for the user and pins the empty state's
sentence: `No tasks yet.`

Two cases carry the quieter promises. `TestIndexPage_RequiresUser` drives an
anonymous request and a forged cookie and pins the answer both times — the
API's own 401, in the API's one error shape:

<!-- verify: internal/web/web_test.go at=templates -->
```go title="internal/web/web_test.go"
	for name, cookies := range map[string][]*http.Cookie{
		"no cookie": nil,
		...
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := get(t, e, "/", cookies...)

			require.Equal(t, http.StatusUnauthorized, rec.Code)
			assert.JSONEq(t, `{"code":"unauthorized","message":"authentication required"}`, rec.Body.String())
		})
	}
```

`TestIndexPage_RequestRecord` reads the record the stack writes for the
request and pins that it names the status the client received.
`TestWebMount_LeavesOtherPathsAlone` pins that the sign-in check stays on the
page's own route: a `POST` to `/healthz` and an unknown path keep the stack's
own answers.

One case needs the real thing. The mount is a line in `main`, and nothing
below `main` can test it — so the process-level case in
`cmd/todo-server/integration_test.go` drives the real binary: anonymous, it
is the 401; with a real session and a task written through the real API, it
is the page.

<!-- verify: cmd/todo-server/integration_test.go at=templates -->
```go title="cmd/todo-server/integration_test.go"
func TestServer_IndexPage(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr

	resp, err := http.Get(base + "/") // #nosec G107 -- the test's own listener address
	...
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Contains(t, resp.Header.Get("Content-Type"), "text/html")
	assert.Contains(t, string(body), "<title>Tasks</title>")
	assert.Contains(t, string(body), "buy milk")
}
```

The finished app's appendix holds the whole test file; the pieces above are
the ones that carry the idea. Now run everything and watch it fail:

```bash
$ go test -count=1 ./...
todo/internal/web: no non-test Go files in …/internal/web
ok  	todo/cmd/todo	1.597s
--- FAIL: TestServer_IndexPage (0.08s)
    integration_test.go:243: 
        	Error Trace:	…/cmd/todo-server/integration_test.go:243
        	Error:      	Not equal: 
        	            	expected: 401
        	            	actual  : 404
        	Test:       	TestServer_IndexPage
FAIL
FAIL	todo/cmd/todo-server	1.727s
...
FAIL	todo/internal/web [build failed]
FAIL
```

Two failures, and both are the point. `todo/internal/web: no non-test Go
files` means the folder holds only a test file — there is no package for it
to test yet. The second is the better one: the process-level case compiles
against the binary as it stands and fails on what the server does — an
anonymous `GET /` answers echo's 404 where the page's route will answer the
sign-in check's 401. Nothing is broken; the code simply does not exist yet.

## The components

Create the folder `internal/web/views`. The first component is the document
every page sits inside — the layout. Create `layout.templ`:

<!-- verify: internal/web/views/layout.templ at=templates -->
```templ title="internal/web/views/layout.templ"
package views

templ Layout(title string) {
	<!DOCTYPE html>
	<html lang="en">
		<head>
			<meta charset="utf-8"/>
			<meta name="viewport" content="width=device-width, initial-scale=1"/>
			<title>{ title }</title>
		</head>
		<body>
			<header>
				<h1>todo</h1>
			</header>
			<main>
				{ children... }
			</main>
		</body>
	</html>
}
```

`templ Layout(title string)` declares a component named `Layout` that takes
the page's title. `{ title }` writes the title into the `<title>`
instruction — the text a browser shows in its tab. `{ children... }` is a
slot: the page composed inside this layout lands there. The rest is the
document's shape: the character set, the viewport, a header, and the main
area.

The page itself goes in `tasks.templ`:

<!-- verify: internal/web/views/tasks.templ at=templates -->
```templ title="internal/web/views/tasks.templ"
package views

import (
	"strings"

	"todo/internal/task"
)

templ IndexPage(tasks []task.Task) {
	@Layout("Tasks") {
		<h2>Your tasks</h2>
		@TaskList(tasks)
	}
}

templ TaskList(tasks []task.Task) {
	if len(tasks) == 0 {
		<p class="empty">No tasks yet.</p>
	} else {
		<ul class="tasks">
			for _, t := range tasks {
				@TaskRow(t)
			}
		</ul>
	}
}

templ TaskRow(t task.Task) {
	<li class="task">
		<span class="status">{ t.Status.String() }</span>
		<span class="title">{ t.Title }</span>
		<span class="priority">priority { t.Priority }</span>
		if !t.Due.IsZero() {
			<span class="due">due { t.Due.Format("2006-01-02") }</span>
		}
		if len(t.Tags) > 0 {
			<span class="tags">{ strings.Join(t.Tags, ", ") }</span>
		}
	</li>
}
```

Read it in pieces. `IndexPage` composes the page inside the layout:
`@Layout("Tasks") { ... }` calls `Layout` and passes the block as its
children. `TaskList` chooses between the empty state and the list — `if
len(tasks) == 0` — and `for _, t := range tasks` renders one row per task.

`TaskRow` writes one task: `{ t.Status.String() }` calls a method and writes
the result, `{ t.Title }` writes the title, and the `if` lines leave out the
due date and the labels when a task has none. Every `{ ... }` is a value,
never markup — the tests pin exactly that.

The generated code imports the templ library, so add it before generating,
from the app's root folder: run `go get github.com/a-h/templ@v0.3.1070`.
Then generate:

```bash
$ go run github.com/a-h/templ/cmd/templ@v0.3.1070 generate
(✓) Post-generation event received, processing... [ updates=2 needsRestart=true needsBrowserReload=true ]
(✓) Complete [ updates=2 duration=3.977461ms ]
```

templ found both files and wrote `layout_templ.go` and `tasks_templ.go`
beside them. The first lines of each say the file is no longer yours to edit:

<!-- verify: internal/web/views/layout_templ.go at=templates -->
```go title="internal/web/views/layout_templ.go"
// Code generated by templ - DO NOT EDIT.

// templ: version: v0.3.1070
package views
```

Change a `.templ` file and run `templ generate` again; never edit the
generated Go by hand, because the next run would overwrite the edit.

## The handler that answers /

Now the server side: `internal/web/web.go`. It builds a small `Server` around
the two things every page request needs — the store and the session manager:

<!-- verify: internal/web/web.go at=templates -->
```go title="internal/web/web.go"
// New builds the web surface around the store and the session manager. The
// store is the unscoped one: each request scopes its own view to the
// authenticated user, exactly as the API's handlers do. The session manager
// is the same one the API uses — one cookie, one session, one login.
func New(st store.Store, sessions *scs.SessionManager) *Server {
	return &Server{store: st, sessions: sessions}
}
```

The store is the unscoped one. Each request scopes its own view, exactly as
the API's handlers do.

`Register` mounts the page, and the middleware is the interesting part:

<!-- verify: internal/web/web.go at=templates -->
```go title="internal/web/web.go"
func (s *Server) Register(e *echo.Echo) {
	e.GET("/", s.index, api.RequireUser(s.sessions))
}
```

`e.GET("/", s.index, api.RequireUser(s.sessions))` says: a `GET` for `/` is
answered by `s.index`, but only after `api.RequireUser` — the same check the
API's task routes use — has confirmed a signed-in user. An anonymous visitor
gets the API's 401, in the API's one error shape, because there is exactly
one definition of "you must be signed in" across both surfaces.

The handler is the whole server side:

<!-- verify: internal/web/web.go at=templates -->
```go title="internal/web/web.go"
func (s *Server) index(c echo.Context) error {
	ctx := c.Request().Context()
	id, ok := api.UserFrom(ctx)
	if !ok {
		// The route is behind RequireUser; reaching the handler without the
		// id is a wiring bug, and the panic says so. uuid.Nil is a real
		// scope — the user-less one — so answering the zero value would
		// silently serve the wrong rows.
		panic("web: index reached without RequireUser")
	}
	tasks, err := s.store.Scoped(id).List(ctx)
	if err != nil {
		return err
	}
	c.Response().Header().Set(echo.HeaderContentType, echo.MIMETextHTMLCharsetUTF8)
	return views.IndexPage(tasks).Render(ctx, c.Response())
}
```

Line by line: the user's id comes from the request's context, where the
sign-in middleware put it; the panic is a wiring guard, because a page that
cannot know whose tasks to show must not guess.

`s.store.Scoped(id).List(ctx)` reads the user's tasks through the same
scoped view the API's handlers use, so the page cannot show a task the API
could not return; the content type says the body is HTML; and the last line
renders the page. Look closely at that last line: the render target is
`c.Response()` itself. A nearby variant looks right and quietly breaks the
request record — it is in "If something went wrong".

One line mounts the page from `main`:

<!-- verify: cmd/todo-server/main.go at=templates -->
```go title="cmd/todo-server/main.go"
	// The server-rendered pages mount onto the instance the API just built:
	// one echo, one middleware stack, one session manager, one store. The
	// pages are registered here rather than inside api.New so the API
	// instance — and the OpenAPI coverage test that walks its route table —
	// stays free of page routes that are not API operations.
	web.New(st, sessions).Register(e)
```

`web.New(st, sessions).Register(e)` sits right after `api.New` builds the
instance: one server, one middleware stack, one session manager, one store.
The pages mount here rather than inside `api.New` so the API's route table
stays the API's — the documentation's coverage check walks that table, and
pages are not API operations.

## Run it green

Run the page's tests:

```bash
$ go test -count=1 -v ./internal/web
--- PASS: TestWebMount_LeavesOtherPathsAlone (0.00s)
--- PASS: TestIndexPage_RequestRecord (0.00s)
--- PASS: TestIndexPage_RequiresUser (0.00s)
    --- PASS: TestIndexPage_RequiresUser/no_cookie (0.00s)
    --- PASS: TestIndexPage_RequiresUser/a_forged_cookie (0.00s)
--- PASS: TestIndexPage_RendersTasks (0.00s)
    --- PASS: TestIndexPage_RendersTasks/the_user's_tasks_render (0.00s)
    --- PASS: TestIndexPage_RendersTasks/a_task_title's_markup_renders_inert (0.00s)
    --- PASS: TestIndexPage_RendersTasks/a_user_with_no_tasks_gets_the_empty_state (0.00s)
PASS
ok  	todo/internal/web	0.162s
```

The `PASS` lines are grouped here for reading — the cases run in parallel,
so they finish in a different order each run. Then the process-level case:

```bash
=== RUN   TestServer_IndexPage
--- PASS: TestServer_IndexPage (0.20s)
PASS
ok  	todo/cmd/todo-server	1.835s
```

And the whole module:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	1.715s
ok  	todo/cmd/todo-server	1.948s
ok  	todo/internal/api	0.586s
...
ok  	todo/internal/web	0.061s
?   	todo/internal/web/views	[no test files]
```

Everything passes. The `internal/web/views` line says the components have no
tests of their own, which is right: they are tested through the page that
composes them, where a browser would meet them.

## Look at the page

Start the server the way the earlier web work showed — a scratch folder with
its own database and log file — and sign in through the API the way the auth
work showed; `curl -c alice.jar` keeps the cookie a login sets. The captures
below use `$B` for the server's address, and `alice.jar` and `bob.jar` for
the two accounts' cookie files. Add a few tasks through the API, including
one titled `<script>alert("xss")</script>` and one with a due date and
labels, and give the second account a task of its own.

An anonymous visitor meets the sign-in check first:

```bash
$ curl -si $B/
HTTP/1.1 401 Unauthorized
Content-Type: application/json
Referrer-Policy: no-referrer
Vary: Cookie
Vary: Accept-Encoding
Vary: Origin
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
X-Request-Id: MRLbYRcXqJvQwHQdDRyrwxgEKCZtiTvd
X-Xss-Protection: 1; mode=block
Date: Thu, 15 Oct 2026 08:50:10 GMT
Content-Length: 60

{"code":"unauthorized","message":"authentication required"}
```

The status, the headers, and the body are the API's 401 — the same refusal
every other route gives, because it is the same handler.

With alice's cookie, the page:

```bash
$ curl -si -b alice.jar $B/ | head -14
HTTP/1.1 200 OK
Content-Type: text/html; charset=UTF-8
Referrer-Policy: no-referrer
Vary: Cookie
Vary: Accept-Encoding
Vary: Origin
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
X-Request-Id: EVytzHOyAgEmjHBwIjyKRTrqurtzAEue
X-Xss-Protection: 1; mode=block
Date: Thu, 15 Oct 2026 08:50:10 GMT
Transfer-Encoding: chunked
```

`200`, and the content type says HTML. The other headers are the stack's: the
request id, the security headers, and the session layer's `Vary: Cookie`. The
page does not bypass the stack; it rides it.

The body:

```bash
$ curl -s -b alice.jar $B/
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tasks</title>
</head>
<body>
<header>
<h1>todo</h1>
</header>
<main>
<h2>Your tasks</h2>
<ul class="tasks">
<li class="task">
<span class="status">Todo</span> <span class="title">buy milk</span> <span class="priority">priority 4</span> <span class="due">due 2026-10-20</span> <span class="tags">errands, home</span>
</li>
<li class="task">
<span class="status">Todo</span> <span class="title">write the chapter</span> <span class="priority">priority 2</span> </li>
<li class="task">
<span class="status">Todo</span> <span class="title">&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;</span> <span class="priority">priority 3</span> </li>
</ul>
</main>
</body>
</html>
```

There it is: the layout's document, the header, the main area, and the list —
each task's status, title, priority, due date, and labels, in the order the
store returns them. A task with no due date or labels leaves those parts out,
and a user with no tasks would see `No tasks yet.`

The title that carries markup is data on the wire, not instructions:

```bash
$ curl -s -b alice.jar $B/ | grep -o '&lt;script&gt;[^<]*'
&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;
```

And the scope holds both ways:

```bash
$ curl -s -b alice.jar $B/ | grep -c "bob private task"
0
$ curl -s -b bob.jar $B/ | grep -o "bob private task"
bob private task
$ curl -s -b bob.jar $B/ | grep -c "buy milk"
0
```

Alice's page never shows bob's task, and bob's page never shows alice's — the
same scoped view the API uses.

The check stays on the page's own route, so paths the page does not own keep
their own answers:

```bash
$ curl -si $B/nope | head -2
HTTP/1.1 404 Not Found
Content-Type: application/json
$ curl -s $B/nope
{"code":"not_found","message":"Not Found"}

$ curl -si -X POST $B/healthz | head -2
HTTP/1.1 405 Method Not Allowed
Allow: OPTIONS, GET
```

A 404 is still a 404, and a `POST` to the health endpoint is still a method
problem, not a sign-in problem. That is the mount's whole footprint: the
routes it names, and nothing else.

## If something went wrong

**`no non-test Go files in …/internal/web`.** The folder holds `web_test.go`
and nothing else. A folder of tests is not a package, and the go tool stops
before running them:

```bash
todo/internal/web: no non-test Go files in …/internal/web
...
FAIL	todo/internal/web [build failed]
```

That is the test-first order made visible, not a problem to fix. Write
`web.go` and the message goes away.

**The request records all read `status 0`.** If the handler renders into
`c.Response().Writer` instead of `c.Response()`, the page still appears in
the browser — but echo never sees the write, and the record for the request
says nothing was served:

```bash
"method":"GET","path":"/","status":0,"duration":644614}
```

The regression case catches it before any browser does:

```bash
=== RUN   TestIndexPage_RequestRecord
=== PAUSE TestIndexPage_RequestRecord
=== CONT  TestIndexPage_RequestRecord
    web_test.go:234: 
        	Error Trace:	…/internal/web/web_test.go:234
        	Error:      	Not equal: 
        	            	expected: 200
        	            	actual  : 0
        	Test:       	TestIndexPage_RequestRecord
        	Messages:   	the record names the status the client received
--- FAIL: TestIndexPage_RequestRecord (0.00s)
FAIL
FAIL	todo/internal/web	0.033s
FAIL
```

`c.Response().Writer` is the layer below the one that knows what happened.
`c.Response()` tracks the status and whether the response has started, and
writing through it is what lets the record name the status the client
received. The fix is one word: render into `c.Response()`.

**`expected: 405, actual: 401` — the page wrapped in a middleware group.**
Middleware on a group applies to everything the group's prefix matches. A
group with an empty prefix claims the whole root namespace, so a `POST
/healthz` and an unknown path both meet the sign-in check:

```bash
--- FAIL: TestWebMount_LeavesOtherPathsAlone (0.00s)
    web_test.go:253: 
        	Error Trace:	…/internal/web/web_test.go:253
        	Error:      	Not equal: 
        	            	expected: 405
        	            	actual  : 401
        	Test:       	TestWebMount_LeavesOtherPathsAlone
    web_test.go:255: 
        	Error Trace:	…/internal/web/web_test.go:255
        	Error:      	Not equal: 
        	            	expected: 404
        	            	actual  : 401
        	Test:       	TestWebMount_LeavesOtherPathsAlone
FAIL
FAIL	todo/internal/web	0.039s
FAIL
```

The fix is to put the middleware on the page's own route — `e.GET("/",
s.index, api.RequireUser(s.sessions))` — and the mount's reach is exactly the
routes it names.

<details>
<summary>Going deeper: a title is data, never markup</summary>

Every `{ expr }` in a component is escaped before it reaches the page: templ
runs it through `html.EscapeString`, which replaces five characters — `&`,
`<`, `>`, `'`, and `"`. That is why a task titled
`<script>alert("xss")</script>` renders as text a reader sees instead of a
script a browser runs: by the time the bytes reach the browser, the angle
brackets are no longer instructions.

Escaping is a rendering rule, not a validation rule. The store kept the title
exactly as it was written; the page is the first place it would have become
code. templ has an escape hatch, `templ.Raw`, which writes a string as
markup — and this app never uses it. A page that renders user data has no
legitimate raw expression; the day one appears, it should be a deliberate,
reviewable line rather than a default.

</details>

<details>
<summary>Going deeper: the page is written, not assembled</summary>

The page is never one big string in memory. When the handler calls `Render`,
templ borrows a small fixed-size buffer from a pool — 4 KiB, always — and the
components write into it; the buffer flushes to the response as it fills, and
a nested component writes into the same buffer rather than its own. A page of
any size is written through one small buffer, and the pool means each request
reuses buffers instead of building new ones.

That is why the handler can hand the component straight to the response and
forget about it: the response writer is the only destination, and the page's
size never becomes a value the code has to manage.

</details>

<details>
<summary>Going deeper: why the components are Go functions</summary>

`templ IndexPage(tasks []task.Task)` becomes
`func IndexPage(tasks []task.Task) templ.Component`. The data you hand a view
is checked where you call it: rename a field on `task.Task` and every page
that reads it stops compiling, instead of quietly showing a blank spot.

The generated file carries the marker `// Code generated by templ - DO NOT
EDIT.` and the tool's version, so a reader knows at a glance that the file is
written by `templ generate` and not by hand. Change the `.templ` file, run
`templ generate`, and the generated file follows.

</details>

<details>
<summary>Going deeper: why the pages mount from main</summary>

`api.New` builds the API's instance and its route table; the pages are
mounted onto it by the caller — `main` in the real process, and the tests in
their own copies. That keeps `internal/api` from importing `internal/web`,
and it keeps the API's route table free of page routes: the documentation
coverage check that walks the table to prove every API route is documented
keeps its meaning, because a page is not an API operation.

The cost is named: nothing below `main` can notice the mount line
disappearing, which is exactly why the process-level case exists.

</details>

The app has a face now. Next it learns to take a task from a form — create,
change, complete, and remove from the page itself.
