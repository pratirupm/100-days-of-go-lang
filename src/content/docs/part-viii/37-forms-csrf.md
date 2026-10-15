---
title: Forms
description: Give the pages hands — forms that create, edit, complete, and delete tasks, each carrying a stamp that proves it came from your own page.
sidebar:
  order: 37
---

The pages can read now: the list shows your tasks, and the sign-in check
keeps strangers out. But every change still happens somewhere else — through
`curl`, or through a program.

Today the pages get hands. Every row grows a Complete button, a Delete button,
and an Edit link; a new page carries the task form; and a login form appears,
so a visitor can sign in from the page instead of the API. A **form** is the
part of a page that sends data back: input fields, a submit button, and the
address to send them to.

Two rules ride along, and each gets one plain sentence before its code. The
first is a stamp that proves the form came from your own page — the security
world calls it **CSRF**. The second is submit-then-redirect, so a refresh does
not repeat the action a post just did — the pages' code calls it **PRG**.

When it works: press Complete, the row says Done, a message says so once, and
a refresh changes nothing.

## The tests come first

The contract comes first, as always, and it is written the way a browser
behaves: fetch a page, read its hidden stamp, post the form back. The first
case is the refusal — a post with a session but no stamp is turned away, and
nothing is written (`internal/web/csrf_test.go`):

<!-- verify: internal/web/csrf_test.go at=web-forms -->
```go title="internal/web/csrf_test.go"
func TestCSRF_RefusesPostWithoutToken(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)

	rec := postForm(t, e, "/tasks", url.Values{"title": {"buy milk"}}, cookie)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.Equal(t, echo.MIMEApplicationJSON, rec.Header().Get(echo.HeaderContentType))
	assert.JSONEq(t, `{"code":"forbidden","message":"invalid CSRF token"}`, rec.Body.String())

	tasks, err := st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, tasks, "a refused post writes nothing")
}
```

Three helpers in `web_test.go` do the browser's half: `postForm` sends one
form post, `testSession` mints a signed-in cookie without a login, and
`csrfFrom` reads a page's hidden stamp. The `403` and its JSON body are the
one refusal shape every route already uses.

The second case is the working half (`internal/web/forms_test.go`) — post the
form with its stamp, and the answer is a redirect to the list, with the task
stored and the message shown once:

<!-- verify: internal/web/forms_test.go at=web-forms -->
```go title="internal/web/forms_test.go"
func TestCreateTask_PRG(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/tasks/new", cookie)

	rec := postForm(t, e, "/tasks", url.Values{
		"csrf_token": {token},
		"title":      {"write the chapter"},
		"priority":   {"5"},
		"due":        {"2026-11-01"},
		"tags":       {"book, go"},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))

	tasks, err := st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, "write the chapter", tasks[0].Title)
...
	followed := get(t, e, "/", cookie)
	require.Equal(t, http.StatusOK, followed.Code)
	assert.Contains(t, followed.Body.String(), "Task created.")
	assert.Contains(t, followed.Body.String(), "write the chapter")

	again := get(t, e, "/", cookie)
	assert.NotContains(t, again.Body.String(), "Task created.", "the flash is shown once")
}
```

Read the last three lines twice: the first list shows `Task created.`, the
second does not. That is the flash, shown once. The other cases follow the
same shape — a form that breaks a rule comes back with messages, a stale
version redirects — and a process-level case drives the whole flow through
the real server binary. The finished app's appendix holds the whole test
file; the cases above are the ones that carry the idea.

Run them and watch them fail:

```bash
$ go test -count=1 ./...
# todo/internal/web_test [todo/internal/web.test]
internal/web/web_test.go:80:64: undefined: web.Authenticator
internal/web/web_test.go:84:21: too many arguments in call to web.New
	have ("todo/internal/store".Store, unknown type, *scs.SessionManager)
	want ("todo/internal/store".Store, *scs.SessionManager)
...
ok  	todo/cmd/todo	1.715s
--- FAIL: TestServer_WebForms (0.13s)
    integration_test.go:408: 
        	Error Trace:	…/cmd/todo-server/integration_test.go:408
        	Error:      	Not equal: 
        	            	expected: 303
        	            	actual  : 401
        	Test:       	TestServer_WebForms
--- FAIL: TestServer_WebFormsCSRF (0.15s)
    integration_test.go:560: 
        	Error Trace:	…/cmd/todo-server/integration_test.go:560
        	Error:      	Not equal: 
        	            	expected: 403
        	            	actual  : 404
        	Test:       	TestServer_WebFormsCSRF
...
FAIL	todo/internal/web [build failed]
?   	todo/internal/web/views	[no test files]
FAIL
```

Two kinds of failure, and both are the point. The compile errors say the
tests call pieces that do not exist yet — a `web.New` that takes an
authenticator, a page that takes the shared data. The two failures that
compile are better: the process-level flow expects a `303` where the server
still answers the old `401`, and a form post expects the stamp's `403` where
the route does not exist yet. Nothing is broken; the app does not do this
yet.

## A stamp that proves the form is yours

Your browser sends your session cookie with every request — that is how it
says who you are. But a page on another site can hold a form that posts to
this server, and the browser attaches your cookie to that post too. If the
server trusted the cookie alone, the foreign page could complete or delete
your tasks.

The stamp is a second lock. A **token** is a long random string the server
keeps in your session and puts into every form as a hidden field — an input
the browser sends back but the page never shows. On every post that changes
something, the server compares the field with the session's token; a missing
or wrong stamp is refused before any handler runs. The trick is that the
other site cannot read your page, so it cannot put your stamp on its fake
form.

`internal/web/csrf.go` holds the whole design. First, the token itself:

<!-- verify: internal/web/csrf.go at=web-forms -->
```go title="internal/web/csrf.go"
// csrfKey is both the session key the token lives under and the form field
// it travels in. The two namespaces never meet — one is a session payload,
// the other a request body — and one constant keeps them spelled the same.
const csrfKey = "csrf_token"

// csrfToken returns the session's CSRF token, minting one if the session has
// none. Minting puts the token in the session, which the session middleware
// commits — and sets the cookie for — when the response is written: that is
// why the login page, the first page an anonymous visitor sees, is where an
// anonymous session is born.
//
// crypto/rand.Text is the standard library's token helper: 26 base32
// characters, about 130 bits of randomness, built for exactly this. Nothing
// else in the process reads the token, so nothing else needs a method for
// it.
func (s *Server) csrfToken(ctx context.Context) string {
	if token := s.sessions.GetString(ctx, csrfKey); token != "" {
		return token
	}
	token := rand.Text()
	s.sessions.Put(ctx, csrfKey, token)
	return token
}
```

Read the two halves. `csrfKey` is one name used twice: the session slot the
token lives in, and the form field it travels in. `csrfToken` returns the
session's token, or mints one — `rand.Text`, 26 random characters — when the
session has none. Minting marks the session as changed, and the session layer
saves it with the response — that is why the login page is where an anonymous
session is born.

The compare rides every post route:

<!-- verify: internal/web/csrf.go at=web-forms -->
```go title="internal/web/csrf.go"
func (s *Server) csrf(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		switch c.Request().Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			return next(c)
		}
		want := s.sessions.GetString(c.Request().Context(), csrfKey)
		got := c.FormValue(csrfKey)
		if want == "" || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			return echo.NewHTTPError(http.StatusForbidden, "invalid CSRF token")
		}
		return next(c)
	}
}
```

GET, HEAD, and OPTIONS pass straight through — reads carry no stamp.
Everything else must present the session's token: `FormValue` reads the
submitted field, and `subtle.ConstantTimeCompare` compares the two without
stopping at the first wrong character. The refusal is echo's own `403`,
`invalid CSRF token`, through the same error handler as every other failure;
no handler runs, so nothing is written.

## Submit, then redirect

One browser behavior bites here. A page that arrived as the answer to a POST
re-sends that POST when you refresh it — the browser asks "send this again?",
and pressing yes writes twice. **PRG** breaks the chain: a successful post
answers with a redirect, the browser follows it with a plain GET, and a
refresh repeats the GET, which writes nothing.

A redirect has no page of its own, so the message cannot ride with it. It
rides the session instead: the post stores a **flash**, and the page the
redirect names shows it once, then forgets it. `internal/web/flash.go` is the
whole channel:

<!-- verify: internal/web/flash.go at=web-forms -->
```go title="internal/web/flash.go"
func (s *Server) putFlash(ctx context.Context, kind, message string) {
	raw, err := json.Marshal(views.Flash{Kind: kind, Message: message})
	if err != nil {
		// The value is two strings; Marshal cannot fail on them. The
		// branch exists because errcheck would want the error answered,
		// and the honest answer is that there is none.
		return
	}
	s.sessions.Put(ctx, flashKey, string(raw))
}

// popFlash returns the pending flash and removes it, or nil when none is
// pending. PopString's zero value is the empty string, and a marshaled
// Flash is never empty, so "" means "nothing pending" without a second
// lookup.
func (s *Server) popFlash(ctx context.Context) *views.Flash {
	raw := s.sessions.PopString(ctx, flashKey)
	if raw == "" {
		return nil
	}
	var flash views.Flash
	if err := json.Unmarshal([]byte(raw), &flash); err != nil {
		return nil
	}
	return &flash
}
```

`putFlash` writes the next page's message; `popFlash` reads it and removes it
in the same call — that is what makes a flash show exactly once. The value is
stored as JSON text rather than a Go value, because session values are
decoded as untyped data: a string needs no ceremony, while a Go struct would
have to be registered with the session library first. A flash that cannot be
decoded is dropped, not fatal — a message is a nicety, and a page that fails
over one would be the wrong trade.

Two answers stay outside the pattern, deliberately. A post whose input
breaks a rule is re-rendered — the form comes back, status `422`, with the
submitted values and a message per field — because nothing was written and
the user must not lose what they typed. And a post that names a task the
store cannot find redirects to the list with an error flash, so the page
shows the state the failure left behind.

## The data every page shares

Every page now needs the same three things: the token, the pending message,
and whether the visitor is signed in. `internal/web/views/views.go` holds the
small types the handlers build and the components render:

<!-- verify: internal/web/views/views.go at=web-forms -->
```go title="internal/web/views/views.go"
// Page is the data every page render shares: the CSRF token every form
// embeds, the flash the previous request left behind (nil when none is
// pending), and whether the request carries a user — the header's new-task
// link and logout form are for signed-in pages only.
type Page struct {
	CSRFToken     string
	Flash         *Flash
	Authenticated bool
}

// Flash is one message from the previous request, shown once: PRG's feedback
// channel. It travels in the session (internal/web owns that half), and a
// page renders it at the top of the content.
type Flash struct {
	// Kind is FlashSuccess or FlashError. The page renders the two with
	// different roles, so an error is announced when it appears rather than
	// read in document order.
	Kind    string
	Message string
}
```

`Page` is what every render gets — the token, the flash the previous request
left behind (or none), and whether the request carries a user, which decides
whether the header shows the New task link and the logout form. `Flash` is
one message with a kind: an error renders with `role="alert"`, so a screen
reader — the tool that reads a page aloud — announces it when it appears; a
success renders with `role="status"`.

The submitted form arrives as flat strings, because that is what a form body
is:

<!-- verify: internal/web/views/views.go at=web-forms -->
```go title="internal/web/views/views.go"
// TaskInput is the submitted values of a task form, as the browser sent them:
// strings, the priority among them, and the version the form was rendered
// at. The new-task form has no version — there is nothing yet to compare
// against — and the edit form's is a hidden field, which is why the zero
// value renders no version input at all.
type TaskInput struct {
	Title    string
	Priority string
	Due      string
	Tags     string
	Version  string
}
```

`TaskInput` is the form's fields exactly as the browser sends them. The
version is the hidden field the edit form carries back; the new-task form has
none, which is why an empty version renders no version input at all.

## The list learns to act

The layout grows two things: the flash at the top of the main area, and a
header for signed-in visitors — a New task link and a Log out form:

<!-- verify: internal/web/views/layout.templ at=web-forms -->
```templ title="internal/web/views/layout.templ"
		<body>
			<header>
				<h1><a href="/">todo</a></h1>
				if page.Authenticated {
					<nav>
						<a href="/tasks/new">New task</a>
						<form method="post" action="/logout">
							<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>
							<button type="submit">Log out</button>
						</form>
					</nav>
				}
			</header>
			<main>
				if page.Flash != nil {
					if page.Flash.Kind == FlashError {
						<p class={ "flash", page.Flash.Kind } role="alert">{ page.Flash.Message }</p>
					} else {
						<p class={ "flash", page.Flash.Kind } role="status">{ page.Flash.Message }</p>
					}
				}
				{ children... }
			</main>
```

The two flash kinds render with different roles, so an error is announced and
a success is read in place. The logout form carries the token like every
other form, because logging out is a post that changes state.

The rows grow the actions — complete, edit, and delete, each carrying the
stamp and the row's version:

<!-- verify: internal/web/views/tasks.templ at=web-forms -->
```templ title="internal/web/views/tasks.templ"
		<span class="actions">
			if t.Status == task.StatusTodo {
				<form method="post" action={ "/tasks/" + t.ID.String() + "/complete" }>
					<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>
					<input type="hidden" name="version" value={ strconv.Itoa(t.Version) }/>
					<button type="submit">Complete</button>
				</form>
			}
			<a href={ "/tasks/" + t.ID.String() + "/edit" }>Edit</a>
			<form method="post" action={ "/tasks/" + t.ID.String() + "/delete" }>
				<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>
				<input type="hidden" name="version" value={ strconv.Itoa(t.Version) }/>
				<button type="submit">Delete</button>
			</form>
		</span>
```

Complete is a one-button form and appears only on a task that is not done
yet; delete is a one-button form too; edit is a link, because it only reads.
Both post forms carry the hidden `version` — the number the row was rendered
at — which the store checks before it writes, so a page left open in another
tab cannot overwrite a newer change. The three components take the page now:

<!-- verify: internal/web/views/tasks.templ at=web-forms -->
```templ title="internal/web/views/tasks.templ"
templ IndexPage(tasks []task.Task, page Page) {
	@Layout("Tasks", page) {
		<h2>Your tasks</h2>
		@TaskList(tasks, page)
	}
}
```

`IndexPage`, `TaskList`, and `TaskRow` all take `page Page`, so a row can
reach the token and the version; the list's markup is otherwise what it was.

## The task form

`internal/web/views/form.templ` is the new/edit form, and it is where a
rejected post comes back. Read two things in it: the per-field messages, and
the priority dropdown that remembers what was submitted:

<!-- verify: internal/web/views/form.templ at=web-forms -->
```templ title="internal/web/views/form.templ"
templ TaskForm(action string, form TaskInput, page Page, errors map[string]string) {
	<form method="post" action={ action }>
		<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>
		if form.Version != "" {
			<input type="hidden" name="version" value={ form.Version }/>
		}
		<p class="field">
			<label for="title">Title</label>
			<input id="title" name="title" value={ form.Title }/>
			if errors["title"] != "" {
				<span class="error" role="alert">{ errors["title"] }</span>
			}
		</p>
		<p class="field">
			<label for="priority">Priority</label>
			<select id="priority" name="priority">
				for p := task.PriorityMin; p <= task.PriorityMax; p++ {
					<option value={ strconv.Itoa(int(p)) } selected?={ form.Priority == strconv.Itoa(int(p)) }>{ p }</option>
				}
			</select>
			if errors["priority"] != "" {
				<span class="error" role="alert">{ errors["priority"] }</span>
			}
		</p>
```

Every field writes the submitted value back — `value={ form.Title }` — so a
rejected form is not a blank form. Each field follows with an `if` that
renders the message beside the input it belongs to. The priority options loop
from the lowest to the highest, and `selected?` is templ's boolean attribute:
it renders as a bare `selected` when the submitted priority matches that
option, so the dropdown shows what was typed.

The rest of the form is the same shape:

<!-- verify: internal/web/views/form.templ at=web-forms -->
```templ title="internal/web/views/form.templ"
		<p class="field">
			<label for="due">Due</label>
			<input id="due" name="due" type="date" value={ form.Due }/>
			if errors["due"] != "" {
				<span class="error" role="alert">{ errors["due"] }</span>
			}
		</p>
		<p class="field">
			<label for="tags">Tags</label>
			<input id="tags" name="tags" value={ form.Tags }/>
			if errors["tags"] != "" {
				<span class="error" role="alert">{ errors["tags"] }</span>
			}
		</p>
		<button type="submit">Save</button>
	</form>
}
```

Due is a date input, labels are one text box, and every field repeats the
error pattern. The `version` input renders only when there is one —
`if form.Version != ""` — which is how the same component serves the new form
(no version) and the edit form (a version to carry back).

## The login form

An anonymous visitor is redirected to `/login` now instead of refused, and
the login form is the page that starts their session — and their stamp:

<!-- verify: internal/web/views/login.templ at=web-forms -->
```templ title="internal/web/views/login.templ"
templ LoginPage(page Page, email string, message string) {
	@Layout("Log in", page) {
		<h2>Log in</h2>
		if message != "" {
			<p class="error" role="alert">{ message }</p>
		}
		<form method="post" action="/login">
			<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>
			<p class="field">
				<label for="email">Email</label>
				<input id="email" name="email" type="email" value={ email }/>
			</p>
			<p class="field">
				<label for="password">Password</label>
				<input id="password" name="password" type="password"/>
			</p>
			<button type="submit">Log in</button>
		</form>
	}
}
```

The form carries the token, an email field that remembers what was submitted,
and a password field that never does: the password is not rendered back, so a
failed login cannot leak it into the page. The message at the top shows the
reason when a post fails.

`internal/web/auth.go` is the server side. The pages need two things from the
sign-in service — check a password, record the event — so the interface they
ask for is small:

<!-- verify: internal/web/auth.go at=web-forms -->
```go title="internal/web/auth.go"
// Authenticator is what the web handlers need from the auth package:
// authenticate a credential pair, and record the events the HTTP layer owns.
// It is defined here, by the consumer, the way the API defines its own — and
// it is deliberately smaller than the API's: the pages have no registration
// form this chapter, so Register is not part of this surface's contract.
type Authenticator interface {
	Authenticate(ctx context.Context, email, password string) (auth.User, error)
	// Record appends an event to the audit trail. A login and a logout are
	// the HTTP layer's to create and destroy — the service cannot see a
	// session — and this is how the pages' events reach the same trail the
	// API's do.
	Record(ctx context.Context, e auth.AuditEvent) error
}
```

`Authenticator` is defined by the pages, for the pages, and it is deliberately
smaller than the API's: there is no registration form here, so `Register` is
not part of it. A login post is the API's login spelled for a form — the same
service, the same trail, the same order:

<!-- verify: internal/web/auth.go at=web-forms -->
```go title="internal/web/auth.go"
func (s *Server) loginSubmit(c echo.Context) error {
	ctx := c.Request().Context()
	email := strings.TrimSpace(c.FormValue("email"))
	password := c.FormValue("password")
	if email == "" || password == "" {
		return render(c, http.StatusUnprocessableEntity,
			views.LoginPage(s.page(ctx), email, "email and password are required"))
	}

	user, err := s.auth.Authenticate(ctx, email, password)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		return render(c, http.StatusUnauthorized,
			views.LoginPage(s.page(ctx), email, auth.ErrInvalidCredentials.Error()))
	}
	if err != nil {
		return err
	}
	if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogin, UserID: user.ID, ActorID: user.ID}); err != nil {
		return err
	}
	s.sessions.Put(ctx, auth.SessionUserID, user.ID.String())
	s.putFlash(ctx, views.FlashSuccess, "Logged in as "+user.Email+".")
	return c.Redirect(http.StatusSeeOther, "/")
}
```

Read the failures: an empty field is `422` with the form back; a wrong pair is
`401` with the service's own words; a service failure is an ordinary error.
The email travels back into the form; the password never does. And the audit
event is recorded before the session is put, so a login that cannot reach the
trail leaves nothing behind.

Logout follows the same discipline:

<!-- verify: internal/web/auth.go at=web-forms -->
```go title="internal/web/auth.go"
func (s *Server) logout(c echo.Context) error {
	ctx := c.Request().Context()
	id := userID(ctx)
	if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogout, UserID: id, ActorID: id}); err != nil {
		return err
	}
	if err := s.sessions.Destroy(ctx); err != nil {
		return err
	}
	s.putFlash(ctx, views.FlashSuccess, "Logged out.")
	return c.Redirect(http.StatusSeeOther, "/login")
}
```

The event is recorded before the session is destroyed — an event that cannot
be written leaves the session in place, so it can be tried again — and then
the flash rides a fresh session: `Destroy` resets the session data, and the
`Put` inside `putFlash` starts a new, anonymous one. That is why `Logged out.`
lands on the login page once.

One case pins the login's words and its secrecy:

<!-- verify: internal/web/auth_test.go at=web-forms -->
```go title="internal/web/auth_test.go"
func TestLogin_WrongPassword(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{authErr: auth.ErrInvalidCredentials}
	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), authn)
	cookie, token := loginForm(t, e)

	rec := postForm(t, e, "/login", url.Values{
		"csrf_token": {token},
		"email":      {"ada@example.com"},
		"password":   {"wrong horse"},
	}, cookie)

	require.Equal(t, http.StatusUnauthorized, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, auth.ErrInvalidCredentials.Error())
	assert.Contains(t, body, `value="ada@example.com"`, "the submitted email survives")
	assert.NotContains(t, body, "wrong horse", "the password never travels back")
	assert.Empty(t, authn.records)

	followed := get(t, e, "/", sessionFrom(t, rec, cookie))
	assert.Equal(t, http.StatusSeeOther, followed.Code, "no session was established")
	assert.Equal(t, "/login", followed.Header().Get(echo.HeaderLocation))
}
```

The submitted email survives the failed post; the password never renders
back; no session is established; and no event is recorded.

## The task routes

`internal/web/tasks.go` is the chapter's biggest file, and its spine is the
parsing layer: the browser sends flat strings, and the form edge turns them
into a domain task through the same rules the API and the command line use:

<!-- verify: internal/web/tasks.go at=web-forms -->
```go title="internal/web/tasks.go"
func parseTaskForm(form views.TaskInput, now time.Time) (task.Task, map[string]string) {
	errs := make(map[string]string)
	t, err := task.NewTask(form.Title)
	if err != nil {
		errs[fieldOf(err, "title")] = messageOf(err)
	}

	if form.Priority != "" {
		p, err := strconv.Atoi(form.Priority)
		if err != nil || !task.Priority(p).Valid() {
			errs["priority"] = fmt.Sprintf("must be between %d and %d", task.PriorityMin, task.PriorityMax)
		} else {
			t.Priority = task.Priority(p)
		}
	}

	if form.Due != "" {
		due, err := task.ParseDue(form.Due, now)
		if err != nil {
			errs[fieldOf(err, "due")] = messageOf(err)
		} else {
			t.Due = due
		}
	}

	t.Tags = parseTags(form.Tags)
	return t, errs
}
```

The title goes through `task.NewTask` — the same trim-and-check the API calls
— the priority through `Priority.Valid`, and the due date through
`task.ParseDue`, so `tomorrow` works in a form exactly as it does in the
command line. Each failure is collected under its field's name, and two small
helpers pull the domain's own message out of the error, so the form shows the
domain's words, not a copy of them.

Two guards answer requests no page could produce. An id that is not an id,
and a version that is missing or not a number, are malformed requests — the
house `400` — with no value the user could correct:

<!-- verify: internal/web/tasks.go at=web-forms -->
```go title="internal/web/tasks.go"
func taskID(c echo.Context) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return uuid.Nil, echo.NewHTTPError(http.StatusBadRequest, "invalid task id")
	}
	return id, nil
}
...
func taskVersion(c echo.Context) (int, error) {
	version, err := strconv.Atoi(c.FormValue("version"))
	if err != nil || version < 1 {
		return 0, echo.NewHTTPError(http.StatusBadRequest, "version must be a positive integer")
	}
	return version, nil
}
```

A store failure is classified exactly as the API classifies it, but a form
post cannot answer with JSON: it redirects with the reason as an error flash —
to the edit form for a conflict, to the list for a miss:

<!-- verify: internal/web/tasks.go at=web-forms -->
```go title="internal/web/tasks.go"
func (s *Server) storeFailure(c echo.Context, err error, conflictTarget string) error {
	switch {
	case errors.Is(err, store.ErrConflict):
		s.putFlash(c.Request().Context(), views.FlashError, err.Error())
		return c.Redirect(http.StatusSeeOther, conflictTarget)
	case errors.Is(err, store.ErrNotFound):
		s.putFlash(c.Request().Context(), views.FlashError, err.Error())
		return c.Redirect(http.StatusSeeOther, "/")
	default:
		return err
	}
}
```

Create is the working half in a dozen lines — parse, re-render on a rule,
store, flash, redirect:

<!-- verify: internal/web/tasks.go at=web-forms -->
```go title="internal/web/tasks.go"
func (s *Server) createTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))

	form := taskFormFrom(c)
	t, errs := parseTaskForm(form, time.Now())
	if len(errs) > 0 {
		return render(c, http.StatusUnprocessableEntity,
			views.TaskFormPage("New task", "/tasks", form, s.page(ctx), errs))
	}
	if _, err := view.Add(ctx, t); err != nil {
		return err
	}
	s.putFlash(ctx, views.FlashSuccess, "Task created.")
	return c.Redirect(http.StatusSeeOther, "/")
}
```

Update is the one handler with a merge, because the form never shows the
status: the stored task is the base, the form's fields replace the editable
ones, and the version the form carried is what the compare-and-swap checks:

<!-- verify: internal/web/tasks.go at=web-forms -->
```go title="internal/web/tasks.go"
	current, err := view.Get(ctx, id)
	if err != nil {
		return s.storeFailure(c, err, "/tasks/"+id.String()+"/edit")
	}
	current.Title = edited.Title
	current.Priority = edited.Priority
	current.Due = edited.Due
	current.Tags = edited.Tags
	current.Version = version
	if _, err := view.Update(ctx, current); err != nil {
		return s.storeFailure(c, err, "/tasks/"+id.String()+"/edit")
	}
	s.putFlash(ctx, views.FlashSuccess, "Task saved.")
	return c.Redirect(http.StatusSeeOther, "/")
```

The status is never assigned, so a Done task stays Done. Complete is a
compare-and-swap at the version the row rendered, then a flash and a
redirect:

<!-- verify: internal/web/tasks.go at=web-forms -->
```go title="internal/web/tasks.go"
	if err := s.store.Scoped(userID(ctx)).Complete(ctx, id, version); err != nil {
		return s.storeFailure(c, err, "/")
	}
	s.putFlash(ctx, views.FlashSuccess, "Task completed.")
	return c.Redirect(http.StatusSeeOther, "/")
```

Delete is the same three lines with `Delete` and `Task deleted.`. The edit
page's read half turns a stored task back into the form's strings:

<!-- verify: internal/web/tasks.go at=web-forms -->
```go title="internal/web/tasks.go"
func editForm(t task.Task) views.TaskInput {
	due := ""
	if !t.Due.IsZero() {
		due = t.Due.Format("2006-01-02")
	}
	return views.TaskInput{
		Title:    t.Title,
		Priority: strconv.Itoa(int(t.Priority)),
		Due:      due,
		Tags:     strings.Join(t.Tags, ", "),
		Version:  strconv.Itoa(t.Version),
	}
}
```

The due date is formatted only when there is one — an empty date input is
right for a task with no due date — and the labels are joined with commas,
the field's submitted shape.

## The server side

`internal/web/web.go`'s `Register` is the map of the surface:

<!-- verify: internal/web/web.go at=web-forms -->
```go title="internal/web/web.go"
func (s *Server) Register(e *echo.Echo) {
	e.GET("/", s.index, s.requireUser)
	e.GET("/login", s.loginPage)
	e.POST("/login", s.loginSubmit, s.csrf)
	e.POST("/logout", s.logout, s.requireUser, s.csrf)

	tasks := e.Group("/tasks", s.requireUser, s.csrf)
	tasks.GET("/new", s.newTaskPage)
	tasks.POST("", s.createTask)
	tasks.GET("/:id/edit", s.editTaskPage)
	tasks.POST("/:id", s.updateTask)
	tasks.POST("/:id/complete", s.completeTask)
	tasks.POST("/:id/delete", s.deleteTask)
}
```

Read the middleware lists. The login page is open — it is how a visitor
becomes a user — and its post needs the token but no session. Everything else
sits behind `requireUser`, and the `/tasks` group carries both the check and
the token middleware, so a form route added to the group cannot forget
either. The check runs first, so an anonymous post is a redirect before its
token is considered.

The check is the pages' sign-in rule, and it answers differently from the
API's:

<!-- verify: internal/web/web.go at=web-forms -->
```go title="internal/web/web.go"
func (s *Server) requireUser(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		ctx := c.Request().Context()
		id, ok := api.SessionUser(ctx, s.sessions)
		if !ok {
			return c.Redirect(http.StatusSeeOther, "/login")
		}
		c.SetRequest(c.Request().WithContext(withUser(ctx, id)))
		return next(c)
	}
}
```

A browser without a live session gets a `303` to the login form, where the
API's check answers `401` — same question, two clients, two answers.
Underneath sits one shared identity rule:

<!-- verify: internal/api/authorization.go at=web-forms -->
```go title="internal/api/authorization.go"
func SessionUser(ctx context.Context, sessions *scs.SessionManager) (uuid.UUID, bool) {
	id, err := uuid.Parse(sessions.GetString(ctx, auth.SessionUserID))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}
```

`SessionUser` reads the session and returns the user's id only if it parses;
the API's `RequireUser` was rewritten over it, so both edges agree on who the
caller is and differ only in their answer. The pages keep their own context
key, because the API's key is that package's own contract.

`page` assembles what every render shares — the token, the flash, and whether
the visitor is signed in:

<!-- verify: internal/web/web.go at=web-forms -->
```go title="internal/web/web.go"
func (s *Server) page(ctx context.Context) views.Page {
	_, authenticated := userFrom(ctx)
	return views.Page{
		CSRFToken:     s.csrfToken(ctx),
		Flash:         s.popFlash(ctx),
		Authenticated: authenticated,
	}
}
```

Every handler builds it just before rendering, so no page can forget the
token or lose the message.

`render` writes a page with an explicit status, because a form now has two
answers:

<!-- verify: internal/web/web.go at=web-forms -->
```go title="internal/web/web.go"
func render(c echo.Context, status int, component templ.Component) error {
	c.Response().Header().Set(echo.HeaderContentType, echo.MIMETextHTMLCharsetUTF8)
	c.Response().WriteHeader(status)
	return component.Render(c.Request().Context(), c.Response())
}
```

`200` is the page; `422` is the re-render of a form that broke a rule.

And `cmd/todo-server/main.go` turns one line into a shared service: built
once and handed to both surfaces, so the API's auth routes and the pages'
login form check the same passwords against the same table and write to the
same trail:

<!-- verify: cmd/todo-server/main.go at=web-forms -->
```go title="cmd/todo-server/main.go"
	// The auth service is built once and handed to both surfaces: the API's
	// auth routes and the pages' login form check the same credentials
	// against the same users table and record to the same trail.
	authn := auth.NewService(sqlDB)
	e := api.New(st, authn, sessions, logger)
...
	web.New(st, authn, sessions).Register(e)
```

Both edges share the one service.

## Run it green

The web cases first:

```bash
$ go test -count=1 -v ./internal/web
--- PASS: TestCreateTask_PRG (0.00s)
--- PASS: TestCreateTask_Validation (0.00s)
--- PASS: TestEditTaskPage_RendersValues (0.00s)
--- PASS: TestEditTaskPage_ForeignTask (0.00s)
--- PASS: TestUpdateTask_PRG (0.00s)
--- PASS: TestUpdateTask_StaleVersion (0.00s)
--- PASS: TestCompleteTask_PRG (0.00s)
--- PASS: TestCompleteTask_StaleVersion (0.00s)
--- PASS: TestCompleteTask_ForeignTask (0.00s)
--- PASS: TestDeleteTask_PRG (0.00s)
--- PASS: TestTaskForm_Shapes (0.00s)
...
--- PASS: TestLogin_WrongPassword (0.00s)
--- PASS: TestLogin_Success (0.00s)
--- PASS: TestLogin_RecordFailure (0.01s)
--- PASS: TestLogin_EmptyCredentials (0.00s)
--- PASS: TestLogout (0.00s)
...
PASS
ok  	todo/internal/web	0.045s
```

The `PASS` lines are grouped for reading — the cases run in parallel and
finish in a different order each run. Then the process-level cases — the whole flow through the real binary, every
post carrying the token the page embedded:

```bash
=== RUN   TestServer_IndexPage
=== RUN   TestServer_WebForms
=== RUN   TestServer_WebFormsCSRF
--- PASS: TestServer_IndexPage (0.16s)
--- PASS: TestServer_WebFormsCSRF (0.16s)
--- PASS: TestServer_WebForms (0.17s)
PASS
ok  	todo/cmd/todo-server	1.342s
```

Every case passes. Next, look at it with a browser's eyes.

## Look at it work

Start the server as in the earlier work and keep its address in `$B`; an
account from the sign-in work can log in through the form now. The session
cookie is presented in an explicit header, and long values are trimmed with
`...`.

An anonymous visitor is sent to the login page, which renders the form and
starts the session the stamp lives in:

```bash
$ curl -si $B/
HTTP/1.1 303
Location: /login

$ curl -si $B/login
HTTP/1.1 200
Set-Cookie: session=IRv8StjrAeFT...
<!doctype html><html lang="en"><head>…<title>Log in</title></head><body><header><h1><a href="/">todo</a></h1></header><main><h2>Log in</h2> <form method="post" action="/login"><input type="hidden" name="csrf_token" value="PSJSZWKTSL6DIO6TCANAYYL4KM"><p class="field"><label for="email">Email</label> <input id="email" name="email" type="email" value=""></p>…</form></main></body></html>
```

The `Set-Cookie` line is the anonymous session's birth, and the form carries
the token. The login post presents the token and the cookie, and the flash
rides the redirect to the list:

```bash
$ curl -si -X POST $B/login -H 'Cookie: session=...' -d 'csrf_token=...&email=ada@example.com&password=...'
HTTP/1.1 303
Location: /
Set-Cookie: session=IRv8StjrAeFT...

$ curl -si $B/ -H 'Cookie: session=...'
HTTP/1.1 200
…<p class="flash success" role="status">Logged in as ada@example.com.</p><h2>Your tasks</h2><p class="empty">No tasks yet.</p>…
```

A post that breaks a rule is the re-render — `422`, the values as submitted,
one message per field, in the domain's own words:

```bash
$ curl -si -X POST $B/tasks -H 'Cookie: session=...' -d 'csrf_token=...&title=&priority=9&due=next tuesday&tags=book'
HTTP/1.1 422
…<input id="title" name="title" value=""> <span class="error" role="alert">cannot be empty</span>…
…<span class="error" role="alert">must be between 1 and 5</span>…
…<input id="due" name="due" type="date" value="next tuesday"> <span class="error" role="alert">unrecognized date &#34;next tuesday&#34;</span>…
…<input id="tags" name="tags" value="book"> …
```

Create is a redirect, and the list shows the task and the flash; the row
carries all three actions, each with the stamp and the version:

```bash
$ curl -si -X POST $B/tasks -H 'Cookie: session=...' -d 'csrf_token=...&title=buy milk&priority=5&due=2026-11-01&tags=errands, home'
HTTP/1.1 303
Location: /

$ curl -si $B/ -H 'Cookie: session=...'
HTTP/1.1 200
…<p class="flash success" role="status">Task created.</p>…
…<li class="task"><span class="status">Todo</span> <span class="title">buy milk</span> <span class="priority">priority 5</span> <span class="due">due 2026-11-01</span> <span class="tags">errands, home</span> <span class="actions"><form method="post" action="/tasks/01a13edb-f26d-7dee-90b5-205fe0710329/complete"><input type="hidden" name="csrf_token" value="PSJSZWKTSL6DIO6TCANAYYL4KM"> <input type="hidden" name="version" value="1"> <button type="submit">Complete</button></form><a href="/tasks/01a13edb-f26d-7dee-90b5-205fe0710329/edit">Edit</a><form method="post" action="/tasks/01a13edb-f26d-7dee-90b5-205fe0710329/delete">…</form></span></li>…
```

The refusal, both halves — no stamp and a wrong stamp — is the one `403`
shape, and nothing is written:

```bash
$ curl -si -X POST $B/tasks -H 'Cookie: session=...' -d 'title=refused'
HTTP/1.1 403
{"code":"forbidden","message":"invalid CSRF token"}

$ curl -si -X POST $B/tasks -H 'Cookie: session=...' -d 'csrf_token=not-the-session-token&title=refused'
HTTP/1.1 403
{"code":"forbidden","message":"invalid CSRF token"}
```

Logout destroys the session, and the fresh session carries the flash to the
login page; the task page is anonymous again:

```bash
$ curl -si -X POST $B/logout -H 'Cookie: session=...' -d 'csrf_token=...'
HTTP/1.1 303
Location: /login
Set-Cookie: session=kZKYoy-Bz4qQ...

$ curl -si $B/login -H 'Cookie: session=...'
HTTP/1.1 200
…<p class="flash success" role="status">Logged out.</p><h2>Log in</h2> …

$ curl -si $B/ -H 'Cookie: session=...'
HTTP/1.1 303
Location: /login
```

Every write in the capture was a redirect, and every message was shown once.

## If something went wrong

**`undefined: web.Authenticator` — the tests name code that does not exist
yet.**

```bash
# todo/internal/web_test [todo/internal/web.test]
internal/web/web_test.go:80:64: undefined: web.Authenticator
internal/web/web_test.go:84:21: too many arguments in call to web.New
	have ("todo/internal/store".Store, unknown type, *scs.SessionManager)
	want ("todo/internal/store".Store, *scs.SessionManager)
…
internal/web/render_bench_test.go:66:59: undefined: views.Page
```

The compiler lists every piece the new tests call: `web.New` with an
authenticator, `views.IndexPage` with a page. It is the test-first order made
visible, and the build that follows is the fix.

**`expected: 303, actual: 200` — a test that follows the redirect it is
checking.**

```bash
--- FAIL: TestServer_WebForms (0.11s)
    integration_test.go:411: 
        	Error Trace:	…/cmd/todo-server/integration_test.go:411
        	Error:      	Not equal: 
        	            	expected: 303
        	            	actual  : 200
        	Test:       	TestServer_WebForms
FAIL
FAIL	todo/cmd/todo-server	1.337s
FAIL
```

`http.DefaultClient` follows a redirect and hands back the target page's
`200`, so the check is really about the page it landed on. Fix: a client that
stops at the redirect — `CheckRedirect: … http.ErrUseLastResponse` — so the
check sees the `303` the server actually sent.

**A form that is not closed — the form generator refuses markup that does
not parse.**

```bash
(✗) Error [ error=failed to generate code for "…/internal/web/views/tasks.templ": …/internal/web/views/tasks.templ parsing error: <form>: close tag not found: line 53, col 3 ]
(✓) Post-generation event received, processing... [ updates=0 needsRestart=true needsBrowserReload=true ]
(✗) Command failed: generation completed with 1 errors
exit status 1
```

`templ generate` parses the markup before it writes Go, so a delete form
closed with `</ul>` stops it — and the message names the element and the
line and column. Close it, generate again, and the `(✓) Complete` line
returns.

**`the page carries a CSRF token field` — a form without its stamp cannot be
submitted.**

```bash
--- FAIL: TestCSRF_LoginFormCarriesTheToken (0.00s)
    csrf_test.go:113: 
        	Error Trace:	…/internal/web/web_test.go:165
        	            				…/internal/web/csrf_test.go:113
        	Error:      	"[]" should have 2 item(s), but has 0
        	Test:       	TestCSRF_LoginFormCarriesTheToken
        	Messages:   	the page carries a CSRF token field
FAIL
FAIL	todo/internal/web	0.040s
FAIL
```

The page renders, and every submission of it is refused: the stamp is what
the compare checks. Fix: every form embeds
`<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>`.

**`expected: 303, actual: 500` — a Go value put straight into the session.**

```bash
--- FAIL: TestCreateTask_PRG (0.00s)
    forms_test.go:46: 
        	Error Trace:	…/internal/web/forms_test.go:46
        	Error:      	Not equal: 
        	            	expected: 303
        	            	actual  : 500
        	Test:       	TestCreateTask_PRG
```

Session values are decoded as untyped data, and the session library cannot
encode a concrete type it has not been told about — so saving the session
fails and the redirect becomes a `500`. Fix: store the flash as its JSON
string, the shape the library handles without ceremony.

<details>
<summary>Going deeper: what CSRF actually is</summary>

The name is the attack: cross-site request forgery. A browser attaches
cookies by site, not by page, so a form on an attacker's page can post to
this server and your cookie goes along. What the attacker's page cannot do is
read your page, so it cannot learn the token — and its forged post fails the
compare. The cookie's `SameSite` setting already blocks most of this; the
token makes the rule the application's own.

</details>

<details>
<summary>Going deeper: why the token compare takes the same time either way</summary>

A plain byte-by-byte compare stops at the first wrong character, and the time
it takes leaks how much of the token was right — enough for an attacker to
guess one character at a time. `ConstantTimeCompare` walks every byte of both
strings and combines the results at the end, so a wrong token and a
nearly-right token take the same work. It also refuses unequal lengths — why a
missing token folds into the same branch.

</details>

<details>
<summary>Going deeper: one token per session, and the redirect's status</summary>

Two smaller choices. The token belongs to the session, not to a form or a
page: every form on every page carries the same one, so a second tab and the
back button keep working, and the token lives exactly as long as the session
does. A later hardening pass rotates it at login, together with the session
itself — a privilege change is the moment to reissue both. And the redirect
is a `303`, not a `302`: `303` says exactly "the answer is elsewhere; fetch
it with GET", so the browser never re-sends the post.

</details>

The pages can write now; next they get dressed — the classes the forms carry
(`flash`, `field`, `error`, `actions`) are waiting for a stylesheet.
