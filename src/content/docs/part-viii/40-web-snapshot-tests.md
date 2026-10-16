---
title: Testing the pages
description: Save every page as a reviewed snapshot and pin its heading structure — with a clock the tests can set.
sidebar:
  order: 40
---

The pages work. Sign in, read the list, create and edit tasks through the
forms — each page answers with the right markup. What no test can say yet is
what a *whole page* looks like. The cases so far check pieces: a title here, a
token there, a status code at the end.

Today we take a picture of every page. A test saves the page's full markup in
a file, and every later run compares the page against the saved copy. If a
page changes — even by one character — the test fails and shows the change,
line by line.

Two parts of a page are different every run: the long id the store assigns to
each task, and the security token the session mints for each form. Those get
replaced with placeholders before the picture is taken, so the comparison is
about the page, not about the randomness.

We also check the shape of every page's headings, and give the pages a clock
the tests can set — so a due date written as "tomorrow" renders the same date
on every run.

## A page, saved and compared

A **snapshot test** compares something big against a saved copy. The saved
copy is called a **golden**. It is a file that sits beside the test and holds
what the page looked like when the case last ran.

The app already uses the same tool for the command line's recorded output and
for the task parser. The library is called `go-snaps`, and its rule is simple:
when a case has no saved entry yet, the first run writes one and the test
passes. Every run after that compares. A difference fails the test with a
diff of saved against received.

There is a second half to that rule. go-snaps reports each entry it writes —
`✎ Snapshot added` — and a written entry is not reviewed until a person reads
it. That reading is the point: the file is the page's frozen expectation, and
a change to it is a change to what the app promises. So updating it is a
deliberate act: `UPDATE_SNAPS=true` rewrites the failing entries, and we scope
that update to one test so it cannot rewrite the whole app's expectations by
accident.

The goldens will live in `internal/web/__snapshots__/snapshots_test.snap`,
with one named entry per case. An entry's name is the test and the case —
`[TestPages_Snapshots/login - 1]` — so a failure points at one page and
nothing else.

## What changes between runs

Most of a page is fixed: titles, statuses, dates, priorities, labels, buttons.
Two values are not. The first is the id the store assigns when a task is
stored — a long string that changes on every run. The second is the CSRF
token, the security value each form carries; the session mints a fresh one per
session. A golden that held either would fail on every run for no reason.

The test replaces both with fixed placeholders before the comparison. Two
patterns do the finding:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// uuidPattern matches the canonical string form of a UUID anywhere in the
// markup. Every task id the pages render is a UUIDv7 the store assigned at
// Add time — a random value that changes on every run, which a golden cannot
// pin. It is the same pattern internal/cli's snapshots normalize the ids
// the CLI prints with.
var uuidPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// csrfPattern matches a form's hidden CSRF field, capturing the halves
// around the value. The token is crypto/rand.Text minted per session, so the
// value is normalized while the field itself stays in the golden: a page
// that stopped carrying a token would be a diff.
var csrfPattern = regexp.MustCompile(`(name="csrf_token" value=")[^"]*(")`)
```

The first pattern matches the id and replaces it with `<id>`. The second
matches the hidden CSRF field and replaces only its value with `<csrf>` — the
field itself stays, because a page that stopped carrying a token is a change
worth seeing.

One small function applies both, then breaks the page at its element
boundaries so the file reads one element per line:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// normalizePage replaces the values that are random by design with fixed
// placeholders — the store-assigned ids and the session's CSRF tokens — and
// breaks the body at its tag boundaries so the golden reads one element per
// line. What is left is what the page's behavior is made of — titles,
// statuses, dates, priorities, tags, versions, actions, flashes, and the
// error shape — and that is what the golden pins. go-snaps has no transform
// hook, so the normalization happens here, before MatchSnapshot sees the
// string.
func normalizePage(s string) string {
	s = uuidPattern.ReplaceAllString(s, "<id>")
	s = csrfPattern.ReplaceAllString(s, "${1}<csrf>${2}")
	return lineBreakTags(s)
}
```

What is left is what the page's behavior is made of, and that is what the
golden pins. One more small function hands the cleaned-up page to the library:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// matchPage matches one rendered page against its golden. Raw serialization
// keeps the file the page itself rather than a Go-quoted string of it.
func matchPage(t *testing.T, body string) {
	t.Helper()
	snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, normalizePage(body))
}
```

Every case ends with `matchPage(t, rec.Body.String())`: the recorded page
body goes through the replacements and meets its golden. `Raw()` keeps the
entry as the page itself, not as a Go-quoted string of it.

## The fixture every case renders

Most cases need tasks to render. `pageFixture` builds four of them, and every
list case reads the same four — so the goldens and the older cases agree on
what a full row looks like:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// pageFixture seeds the tasks the page goldens render: one task with every
// field a row can show — a due date and tags — one with a non-default
// priority, one done, and one with tags only, in insertion order. The due
// date is a fixed UTC value built with time.Date, never time.Now: the
// fixture is the clock, and the one path that needs a live clock — relative
// dates on the form edge — is the seeded handler clock's case.
func pageFixture(t *testing.T) (store.Store, task.Task) {
	t.Helper()
	st := store.NewMemoryStore()
	rich := seed(t, st, testUserID, "buy milk", func(tt *task.Task) {
		tt.Due = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
		tt.Tags = []string{"home"}
	})
	seed(t, st, testUserID, "write the book", func(tt *task.Task) {
		tt.Priority = task.PriorityMax
	})
	shipped := seed(t, st, testUserID, "ship it", nil)
	require.NoError(t, st.Scoped(testUserID).Complete(context.Background(), shipped.ID, shipped.Version))
	seed(t, st, testUserID, "water the plants", func(tt *task.Task) {
		tt.Tags = []string{"garden"}
	})
	return st, rich
}
```

Read the four tasks in order. "buy milk" carries a due date and a label;
"write the book" gets the highest priority; "ship it" is marked done through
the store; "water the plants" has a label only. The due date is built with
`time.Date(2026, 11, 1, ...)` — an exact value, never a reading of the clock.
That matters: `time.Now()` would put the day of the run into the fixture, and
the golden with it.

## Eight pages, eight cases

The new file is `internal/web/snapshots_test.go`. It is a test-only package,
like the other web tests, and it drives the real stack through the helpers the
earlier page work built: `newWebAPI` composes the server, `get` and `postForm`
drive requests without a socket, `testSession` mints a signed-in session
without a login, and `csrfToken` fetches a form and reads its token the way a
browser would. The finished app's appendix holds the whole file; the pieces
below are the ones that carry the idea.

The file's own opening states its contract:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// ...
// of every page a browser reads — the login page, the list, the list with
// its flash, the new and edit forms, the form re-rendered with validation
// errors, and the error body a miss leaves — plus a heading-structure smoke
// check. The snapshot cases drive the real stack the way the other page
// cases do, and the values that are random by design — the store-assigned
// ids and the session's CSRF tokens — are normalized out before the golden
// sees them; everything else the page renders is pinned.
package web_test
```

Then the test itself. Each case is one request, or one form post followed
through its redirect, and each ends in `matchPage`:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// TestPages_Snapshots pins the pages as goldens. Each case drives one
// request — or one POST → redirect → GET flow — through a fresh stack and
// matches the response body against __snapshots__/snapshots_test.snap. The
// first run writes the missing entries and reports each as added: that run
// ...
func TestPages_Snapshots(t *testing.T) {
	t.Parallel()

	t.Run("login", func(t *testing.T) {
		t.Parallel()

		e, _ := newWebAPI(t, store.NewMemoryStore())
		rec := get(t, e, "/login")

		require.Equal(t, http.StatusOK, rec.Code)
		matchPage(t, rec.Body.String())
	})

	...
}
```

The eight cases are the login page; the list; the list with a flash — a
completed task leaves `Task completed.` above the heading, and a form post
reaches it by answering with a redirect the browser follows; the list after a
relative due date; the new form; the edit form; the form re-rendered with
validation errors; and the error body a miss leaves.

Hold one case back: `list after a relative due date` posts `tomorrow`, and it
needs the clock we add in a moment. Leave it out for now; we will add it, and
its golden, once the clock exists.

## The first run writes the goldens

Create the file with the cases above — all but the held-back one — and run
them:

```bash
$ NO_COLOR=true go test -count=1 -v -run TestPages_Snapshots ./internal/web
=== NAME  TestPages_Snapshots/login
    snapshots_test.go:115: ✎ Snapshot added
=== NAME  TestPages_Snapshots/list
    snapshots_test.go:126: ✎ Snapshot added
...
--- PASS: TestPages_Snapshots (0.00s)
...
PASS
ok  	todo/internal/web	0.041s
```

Seven cases, seven added lines — and the run passes, because there was nothing
to compare against and so nothing to fail. The order of the lines is the
parallel schedule's; the cases run side by side and finish in a different
order each run. `NO_COLOR=true` keeps the output free of color codes, and the
`✎` lines are log lines: a plain run without `-v` shows only `ok`.

Now read what it wrote: `internal/web/__snapshots__/snapshots_test.snap`. The
first entry, exactly as it sits in the file:

<!-- verify: internal/web/__snapshots__/snapshots_test.snap at=web-tests -->
```text title="internal/web/__snapshots__/snapshots_test.snap"
[TestPages_Snapshots/login - 1]
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
<h1>
<a href="/">todo</a>
</h1>
</header>
<main>
<h2>Log in</h2> <form method="post" action="/login">
<input type="hidden" name="csrf_token" value="<csrf>">
<p class="field">
<label for="email">Email</label> <input id="email" name="email" type="email" value="">
</p>
<p class="field">
<label for="password">Password</label> <input id="password" name="password" type="password">
</p>
<button type="submit" class="primary">Log in</button>
</form>
</main>
</body>
</html>
---
```

Every element sits on its own line. The CSRF value is `<csrf>` and the field
is still there. The space between `</h2>` and `<form` is still there, because
the templates wrote it and the golden keeps what the templates wrote. That is
the page — all of it.

A miss renders no page, so its golden is the one shape the stack writes. The
case asks for a task id that exists nowhere:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
	t.Run("a miss's error body", func(t *testing.T) {
		t.Parallel()

		e, sessions := newWebAPI(t, store.NewMemoryStore())
		missing := uuid.MustParse("0199cafe-0042-7000-8000-000000000040")
		rec := get(t, e, "/tasks/"+missing.String()+"/edit", testSession(t, sessions))

		require.Equal(t, http.StatusNotFound, rec.Code)
		matchPage(t, rec.Body.String())
	})
```

Its entry is short enough to quote whole:

<!-- verify: internal/web/__snapshots__/snapshots_test.snap at=web-tests -->
```text title="internal/web/__snapshots__/snapshots_test.snap"
[TestPages_Snapshots/a_miss's_error_body - 1]
{"code":"not_found","message":"task not found"}
```

Run the test again and it passes without writing anything: seven entries,
seven comparisons, no output beyond `ok`.

## A clock the pages read

The task form accepts `today` and `tomorrow` as due dates, and the page
renders the resolved date — `due 2026-10-16`. The handler used to resolve
that against the wall clock at the moment of the request, with a `time.Now()`
call inside the handler. A golden can never pin that: the entry would carry
the day it was written and fail the next morning.

The fix moves the clock to the edge of the system. The server is built with a
clock, and the handlers read the server's. Production passes the real one; a
test can pass a fixed instant. In `internal/web/web.go`, the server gains one
field, and the constructor gains one parameter:

<!-- verify: internal/web/web.go at=web-tests -->
```go title="internal/web/web.go"
type Server struct {
	store    store.Store
	auth     Authenticator
	sessions *scs.SessionManager
	// now is the handlers' clock: the reference the form edge resolves
	// relative due dates against. It is a constructor parameter rather
	// than a time.Now call at the point of use, so a test can seed it:
	// the page a post renders is then a golden instead of a race with
	// midnight.
	now func() time.Time
}

...
func New(st store.Store, authn Authenticator, sessions *scs.SessionManager, now func() time.Time) *Server {
	return &Server{store: st, auth: authn, sessions: sessions, now: now}
}
```

`now` is a function that returns a time — that is the whole contract. It
arrives with the constructor, so it cannot be forgotten: a server built
without a clock would fail on its first form post instead of quietly reading
the wall clock. The file also gains `time` in its imports.

The two form posts that resolve due dates now read that clock. In
`internal/web/tasks.go`:

<!-- verify: internal/web/tasks.go at=web-tests -->
```go title="internal/web/tasks.go"
	form := taskFormFrom(c)
	t, errs := parseTaskForm(form, s.now())
	...
	form := taskFormFrom(c)
	edited, errs := parseTaskForm(form, s.now())
```

And production hands in the real clock, in `cmd/todo-server/main.go`:

<!-- verify: cmd/todo-server/main.go at=web-tests -->
```go title="cmd/todo-server/main.go"
	// The server-rendered pages mount onto the instance the API just built:
	// one echo, one middleware stack, one session manager, one store. The
	// pages are registered here rather than inside api.New so the API
	// instance — and the OpenAPI coverage test that walks its route table —
	// stays free of page routes that are not API operations.
	web.New(st, authn, sessions, time.Now).Register(e)
```

That is the default: the running server resolves "tomorrow" against the
actual day, exactly as a person using it expects. The tests choose their own
value.

## The tests get the same clock

The web tests build the server through helpers. The helper that chooses an
authenticator now hands the real clock to a new one:

<!-- verify: internal/web/web_test.go at=web-tests -->
```go title="internal/web/web_test.go"
func newWebAPIWithAuth(t *testing.T, st store.Store, authn web.Authenticator) (*echo.Echo, *scs.SessionManager) {
	t.Helper()
	return newWebAPIWithClock(t, st, authn, time.Now)
}
```

The new helper takes the clock as a parameter, and the fixed instant gets a
name:

<!-- verify: internal/web/web_test.go at=web-tests -->
```go title="internal/web/web_test.go"
// newWebAPIWithClock is newWebAPIWithAuth with the pages' clock chosen by the
// caller: the deterministic cases seed it, so a form post that says
// "tomorrow" renders a fixed date and the golden pins it.
func newWebAPIWithClock(t *testing.T, st store.Store, authn web.Authenticator, now func() time.Time) (*echo.Echo, *scs.SessionManager) {
	t.Helper()
	sessions := api.NewSessionManager(memstore.New())
	e := api.New(st, stubAuth{}, sessions, slog.New(slog.DiscardHandler))
	web.New(st, authn, sessions, now).Register(e)
	return e, sessions
}

// seededClock is the pages' clock in the deterministic cases: a fixed
// instant, so a relative due date ("tomorrow") renders the same date on
// every run. Production passes time.Now (see cmd/todo-server).
func seededClock() time.Time {
	return time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
}
```

`seededClock` is 2026-10-15 at noon, UTC. A post that says `tomorrow`
therefore renders `2026-10-16` — the same date on every run, on every
machine. The one test that builds the server by hand, the request-record
case, passes `time.Now` too.

One older case changes with the seam. `TestTaskForm_Shapes` used to compute
"tomorrow" from its own reading of the wall clock, so it asserted the rule
only as long as its clock and the server's agreed. It now asserts the exact
date:

<!-- verify: internal/web/forms_test.go at=web-tests -->
```go title="internal/web/forms_test.go"
	e, sessions := newWebAPIWithClock(t, st, stubAuth{}, seededClock)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/tasks/new", cookie)

	// seededClock is 2026-10-15 12:00 UTC, so "tomorrow" is the 16th.
	wantDue := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
```

The case's last assertion gets a new message with it: `tomorrow resolves
against the seeded clock`.

Now the held-back case comes back. Add it to `TestPages_Snapshots`, after the
flash case:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
	t.Run("list after a relative due date", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		e, sessions := newWebAPIWithClock(t, st, stubAuth{}, seededClock)
		cookie := testSession(t, sessions)
		token := csrfToken(t, e, "/tasks/new", cookie)

		// "tomorrow" resolves against the seeded clock: the golden pins
		// the date the page renders — 2026-10-16 — instead of whatever
		// the wall clock said on the day of the run.
		rec := postForm(t, e, "/tasks", url.Values{
			"csrf_token": {token},
			"title":      {"call mom"},
			"due":        {"tomorrow"},
			"tags":       {"family"},
		}, cookie)
		require.Equal(t, http.StatusSeeOther, rec.Code)

		followed := get(t, e, "/", sessionFrom(t, rec, cookie))
		require.Equal(t, http.StatusOK, followed.Code)
		matchPage(t, followed.Body.String())
	})
```

The case posts `tomorrow`, follows the redirect, and matches the list page it
lands on — against the seeded clock.

## The last entry and a green suite

Run the snapshot test again, now with the case included:

```bash
=== RUN   TestPages_Snapshots/list_after_a_relative_due_date
=== PAUSE TestPages_Snapshots/list_after_a_relative_due_date
=== CONT  TestPages_Snapshots/list_after_a_relative_due_date
    snapshots_test.go:169: ✎ Snapshot added
--- PASS: TestPages_Snapshots (0.00s)
    --- PASS: TestPages_Snapshots/list_after_a_relative_due_date (0.00s)
PASS
ok  	todo/internal/web	0.042s
```

The post said `tomorrow`, the seeded clock said 2026-10-15, and the new entry
pins the row the page rendered:

<!-- verify: internal/web/__snapshots__/snapshots_test.snap at=web-tests -->
```text title="internal/web/__snapshots__/snapshots_test.snap"
<span class="status">Todo</span> <span class="title">call mom</span> <span class="priority">priority 3</span> <span class="due">due 2026-10-16</span> <span class="tags">family</span> <span class="actions">
```

Run the whole web surface, and everything is green:

```bash
$ go test -count=1 ./internal/web/...
ok  	todo/internal/web	0.034s
ok  	todo/internal/web/assets	0.003s
?   	todo/internal/web/views	[no test files]
```

The two new tests join the case list, and nothing else moved: the property
cases from the earlier web work are the same suite.

## Checking the headings

A page's headings are its outline: `h1` is the top level, `h2` the next, and
so on down to `h6`. A screen reader — a tool that reads a page aloud — can
list a page's headings, and a person navigates by them. So the pages get one
more check: exactly one `h1` (the site title), exactly one `h2` (the page's
own heading), and no level skipped — an `h1` followed by an `h3` would skip
`h2`.

Three small helpers find the headings and count the levels; the check itself
is one function:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// assertHeadings checks one page's heading structure: exactly one h1 — the
// site title, the document's first heading — exactly one h2, the page's own
// heading, and no level skipped anywhere.
func assertHeadings(t *testing.T, body string) {
	t.Helper()
	levels := headingLevels(body)
	require.NotEmpty(t, levels, "the page carries headings")
	assert.Equal(t, 1, levels[0], "the document starts with its h1")
	assert.Equal(t, 1, countLevel(levels, 1), "exactly one h1")
	assert.Equal(t, 1, countLevel(levels, 2), "exactly one h2")
	for i := 1; i < len(levels); i++ {
		assert.LessOrEqual(t, levels[i], levels[i-1]+1, "no heading level is skipped")
	}
}
```

`TestPages_Headings` drives the same five pages through the stack and calls
`assertHeadings` on each:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// TestPages_Headings is the accessibility smoke check: every page a browser
// reads renders one top-level heading and one section heading, with no level
// skipped. That is the whole claim. Not claimed: contrast, focus order,
// labels, landmarks, keyboard behavior, or anything an automated audit would
// call WCAG conformance — heading structure is the one property a page's
// ...
func TestPages_Headings(t *testing.T) {
	t.Parallel()

	t.Run("login", func(t *testing.T) {
		t.Parallel()

		e, _ := newWebAPI(t, store.NewMemoryStore())
		rec := get(t, e, "/login")

		require.Equal(t, http.StatusOK, rec.Code)
		assertHeadings(t, rec.Body.String())
	})

	...
}
```

Run it:

```bash
$ go test -count=1 -v -run TestPages_Headings ./internal/web
--- PASS: TestPages_Headings (0.00s)
    --- PASS: TestPages_Headings/login (0.00s)
    --- PASS: TestPages_Headings/new_form (0.00s)
    --- PASS: TestPages_Headings/edit_form (0.00s)
    --- PASS: TestPages_Headings/list (0.00s)
    --- PASS: TestPages_Headings/form_with_errors (0.00s)
PASS
ok  	todo/internal/web	0.048s
```

It passes because the pages were built right — the check's job is to keep
them that way. One `h1`, one `h2`, no skipped level, page by page.

## When a page changes

A golden is only worth something if someone reads it. Here is what a real
change looks like. We changed the header's link text on a copy of the app —
`todo` becomes `todo app`:

```diff
@@ -11,7 +11,7 @@ templ Layout(title string, page Page) {
 		</head>
 		<body>
 			<header>
-				<h1><a href="/">todo</a></h1>
+				<h1><a href="/">todo app</a></h1>
 				if page.Authenticated {
 					<nav>
 						<a href="/tasks/new">New task</a>
```

The snapshot test fails, and the failure is the review — a small diff with
context, for the first page the change touches:

```bash
--- FAIL: TestPages_Snapshots (0.00s)
    --- FAIL: TestPages_Snapshots/login (0.00s)
        snapshots_test.go:115: 
            - Snapshot - 1
            + Received + 1

            @@ -9,7 +9,7 @@

              <body>
              <header>
              <h1>
            - <a href="/">todo</a>
            + <a href="/">todo app</a>
              </h1>
              </header>
              <main>

            at __snapshots__/snapshots_test.snap:2
```

One shared change — the header — moves seven of the eight entries. Every page
except the error body composes the layout, and the error body renders JSON and
never sees it. That blast radius is the review: the diff says what changed,
where, and what else was touched.

Read and accepted, the update is scoped to the one test that owns the entries:

```bash
$ UPDATE_SNAPS=true NO_COLOR=true go test -count=1 -v -run TestPages_Snapshots ./internal/web
=== NAME  TestPages_Snapshots/login
    snapshots_test.go:115: ✎ Snapshot updated
...
--- PASS: TestPages_Snapshots (0.00s)
...
PASS
```

And the file's change is what a reviewer reads — seven lines out, seven lines
in, nothing else:

```diff
@@ -11,7 +11,7 @@
 <body>
 <header>
 <h1>
-<a href="/">todo</a>
+<a href="/">todo app</a>
 </h1>
 </header>
 <main>
@@ -42,7 +42,7 @@
 <body>
 <header>
 <h1>
-<a href="/">todo</a>
+<a href="/">todo app</a>
 </h1>
 <nav>
<a href="/tasks/new">New task</a>
```

Two of the seven changes are shown; the rest are the same one-line change in
the other entries. The rule from here on: run the tests, read the diff, scope
the update to the test that owns the entries, and read the updated file before
accepting it.

## If something went wrong

**The saved page carries the day it was written.** The stored entry says
`due 2026-10-16` and the received page says `due 2026-10-17` — the same page,
one day later. The cause is a handler that reads the clock at the moment of
the request, with `time.Now()` inside it. The fix is the seam we built: the
clock arrives with the server, production passes `time.Now`, and the
deterministic cases pass `seededClock`. A golden of a relative date then
renders one exact date, and the only clock in the test is the one we set.

**The diff that is one long line.** If the page were saved the way the
template writes it — one unbroken line — a failure would look like this:

```bash
            - Snapshot - 1
            + Received + 1
            - <!doctype html><html lang="en"><head>...
            + <!doctype html><html lang="en"><head>...
            at __snapshots__/snapshots_test.snap:15
```

The two lines are the same page with one word changed — 666 characters
against 670 for the login page — and there is no shared line for the eye to
land on. That is why `normalizePage` ends with `lineBreakTags`: `><` becomes a
line break before the comparison, so every element sits on its own line and a
failure is a small, readable diff. What that trades away is in a box at the
end.

**`UPDATE_SNAPS=true go test ./...`.** The reflex after a failing snapshot is
to update everything — but that command rewrites every failing entry in every
package, including the ones whose failure was telling you something. Scope
it: `UPDATE_SNAPS=true go test -count=1 -run TestPages_Snapshots
./internal/web`. Read the updated entries. If a changed line cannot be
explained, the update is not ready.

<details>
<summary>Going deeper: what the golden gives up</summary>

The golden is not the exact bytes the server wrote. Breaking the page at its
element boundaries adds a newline between adjacent elements — whitespace in
HTML — so the file holds a review format of the page rather than the byte
stream. The function is small:

<!-- verify: internal/web/snapshots_test.go at=web-tests -->
```go title="internal/web/snapshots_test.go"
// lineBreakTags turns the boundary between two adjacent tags into a line
// break. templ renders the page as one unbroken line, and go-snaps diffs by
// line: without this, a two-kilobyte page would be a single line and every
// review a wall of text. Only the boundary — a '>' followed directly by a
// '<' — changes, and the spaces the templates put between inline elements
// stay exactly where they are; the page the handler wrote is untouched, and
// the golden is a review format of it rather than a byte stream.
func lineBreakTags(s string) string {
	return strings.ReplaceAll(s, "><", ">\n<")
}
```

What it keeps is everything a reviewer needs: every element, every attribute,
every text node, and even the spaces the templates put between inline
elements — only a `>` directly followed by a `<` becomes a boundary. And the
transformation runs in the test, after the response is recorded, so the page
the handler wrote is untouched. The golden is derived from the response on
every run, which means the two cannot drift apart.

</details>

<details>
<summary>Going deeper: replace the value, keep the shape</summary>

The normalization has one rule: replace the volatile value, never remove the
structure around it. The reason becomes visible if you break it. Widen the
CSRF pattern so it drops the whole hidden field instead of replacing its
value:

```go
var csrfPattern = regexp.MustCompile(`<input type="hidden" name="csrf_token" value="[^"]*">`)
```

Update the goldens, then delete the token from the login template: the
snapshot test is green.

```bash
$ go test -count=1 -run 'TestPages_Snapshots/login' ./internal/web
ok  	todo/internal/web	0.032s
```

The golden went blind exactly where it was supposed to stay sharp: a page that
dropped its token rendered the same cleaned-up text the entry held. The
pattern as written captures the halves around the value, so the field stays in
the file and a dropped token is a diff. The property case from the login work
asserts the same rule from the other side:

```bash
--- FAIL: TestCSRF_LoginFormCarriesTheToken (0.00s)
    csrf_test.go:113: 
        	Error Trace:	…/internal/web/web_test.go:182
        	            				…/internal/web/csrf_test.go:113
        	Error:      	"[]" should have 2 item(s), but has 0
        	Test:       	TestCSRF_LoginFormCarriesTheToken
        	Messages:   	the page carries a CSRF token field
FAIL
FAIL	todo/internal/web	0.035s
FAIL
```

One test states the rule; the other states the page. Normalize the volatile
value; pin the structure.

</details>

<details>
<summary>Going deeper: what the heading check does not claim</summary>

Exactly one `h1`, exactly one `h2`, no level skipped — that is the whole
claim. A page that adds a third heading, or jumps from `h1` to `h3`, fails by
name.

What the check does not claim is everything else an accessibility audit
covers: contrast, focus order, labels and names, landmarks, keyboard behavior,
or conformance with the Web Content Accessibility Guidelines. Heading
structure is the one property a page's outline can assert without a browser,
and the process-level web cases — the whole flow through the real binary — are
the closest the suite gets to a rendering proof. This check is deliberately
small enough to be honest about what it proves.

</details>

<details>
<summary>Going deeper: why the clock is a function</summary>

`now func() time.Time` — a function, not a clock object with methods. One
method is the whole contract, so a function is the smallest shape that carries
it. It is a constructor parameter rather than a field set after the server is
built, so it cannot be forgotten: a server without a clock fails on its first
form post instead of quietly reading the wall clock. And the default is
reality — the cases that post absolute dates, or none, ride `time.Now` and
cannot flake; only the case that needs a fixed reference seeds one.

The pattern generalizes: a value read at the point of use is a value a test
can never pin. Move it to the edge of the system, where it arrives with the
constructor, and the pages become deterministic.

</details>

<details>
<summary>Going deeper: the tools behind this page</summary>

`go-snaps` — https://github.com/gkampitakis/go-snaps — is the library behind
`MatchSnapshot`, `Raw()`, and the `UPDATE_SNAPS` variable. MDN's page on
heading elements — https://developer.mozilla.org/en-US/docs/Web/HTML/Element/Heading_Elements
— explains the outline rules the heading check follows, and the W3C's Page
Structure tutorial — https://www.w3.org/WAI/tutorials/page-structure/headings/
— shows what a heading list means to a screen reader. Go's `time.Date` —
https://pkg.go.dev/time#Date — is the constructor the fixtures use.

</details>

Every page has a saved copy the suite checks now, and the pages read a clock
the tests can set. Next, the app gets a face that lives in the terminal.
