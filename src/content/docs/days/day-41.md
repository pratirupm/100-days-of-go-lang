---
title: "Day 41 — API documentation"
description: "Generate a written description of the API from the handlers themselves, and serve it as a page anyone can read and try."
sidebar:
  order: 41
chapter: 35
---

**About 3 hours** · Part VII, day 6 of 6.

**You'll be able to:**

- annotate the API and generate an OpenAPI spec;
- serve Swagger UI and keep the docs under test.

---

The API works. Every route answers, every failure leaves in the same shape, and the tests prove both. But nothing tells a stranger how to use it: which routes exist, what each one accepts, what comes back, and what can go wrong. That knowledge lives in the handlers and in the tests.

Today the API writes its own manual. **OpenAPI** is a written description of an HTTP API — every route, its inputs, its answers, its failures — in a form tools can read. **Swagger UI** is a page that renders such a description: a browsable list of every operation, with a form that can send a real request.

The description will be generated from short comments beside the handlers, so it lives next to the code it describes. And one test will make sure no route is ever missing from it.

## The test comes first

True to the habit, we describe the behavior before building it. The new file is `internal/api/docs_test.go`, and it holds two cases. The first walks the server's own route table — echo can list every route it serves — and checks that each one appears in the description. The second checks that the page renders and serves the very document the first case reads.

The description itself is one file, `swagger.json` — the spec, in the tools' vocabulary — generated into `internal/api/docs/`. The test reads it from disk on purpose: the file the page serves must be the file the test checks. The file opens with the package and the imports its helpers need:

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
package api_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/alexedwards/scs/v2/memstore"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/api"
	"todo/internal/store"
)
```

The cases share the helpers the other API tests define. The finished app's appendix holds `internal/api/api_test.go` in full — read the parts behind the `...` there as you type them.

`get` drives one request through the handler without a socket, `stubAuth` is the authenticator that panics if a route reaches it, `discardLogger` throws records away, and `newTestAPI` builds the server for the cases that are not about auth. This file adds only what the description needs. First, a small type for the part of the document the check reads:

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
// swaggerPath is the Swagger UI's mount point. The UI is not part of the
// spec — it is the thing that renders the spec — so the coverage check
// skips it, by name, in one place.
const swaggerPath = "/swagger/*"

// swaggerDoc is the part of the generated spec the coverage check reads:
// paths, each mapping the HTTP method to its operation. The operation
// bodies are left as raw JSON — the check is that a method is documented,
// not what the operation says.
type swaggerDoc struct {
	Paths map[string]map[string]json.RawMessage `json:"paths"`
}
```

`swaggerPath` names the page's mount point, and `swaggerDoc` is the part of the document the check cares about: a map from each path to the methods it answers. The operation bodies are left as raw JSON — the check is that a method is documented, not what the operation says.

Two helpers read the file: `readSpec` parses it into that shape, and `readSpecFile` returns it byte for byte, so a missing file fails with a message that names the fix.

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
func readSpecFile(t *testing.T) []byte {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("docs", "swagger.json"))
	require.NoError(t, err, "docs/swagger.json is generated and committed; run make generate")
	return data
}
```

The message's last words name the run that fixes it — the generator run we will meet in a moment.

One translation stands between the two systems: echo names a parameter `:id`, the document names it `{id}`.

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
// openAPIPath translates echo's path syntax into the spec's: a named
// parameter, ":id", is a template segment, "{id}". The two syntaxes are the
// only difference between the route echo registered and the path swag
// documents.
func openAPIPath(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if name, ok := strings.CutPrefix(part, ":"); ok {
			parts[i] = "{" + name + "}"
		}
	}
	return strings.Join(parts, "/")
}
```

`openAPIPath` splits the path, rewrites each parameter segment, and joins it back — the one place the two spellings meet.

Now the first case, the honesty check:

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
func TestSpec_DocumentsEveryRoute(t *testing.T) {
	t.Parallel()

	doc := readSpec(t)
	e := api.New(store.NewMemoryStore(), stubAuth{}, api.NewSessionManager(memstore.New()), discardLogger())

	var missing []string
	for _, route := range e.Routes() {
		// Two kinds of route are not the spec's to document. /swagger/* is
		// the UI that renders the spec; echo's own RouteNotFound entries are
		// the group middleware's catch-alls — echo registers them when a
		// group carries middleware, so a 404 inside /api/v1/tasks still runs
		// RequireUser — and they name no endpoint a client calls.
		if route.Path == swaggerPath || route.Method == echo.RouteNotFound {
			continue
		}
		method, path := strings.ToLower(route.Method), openAPIPath(route.Path)
		if _, ok := doc.Paths[path][method]; !ok {
			missing = append(missing, strings.ToUpper(method)+" "+path)
		}
	}
	sort.Strings(missing)

	assert.Empty(t, missing, "every echo route must be documented in docs/swagger.json")
}
```

The walk skips two kinds of route. `/swagger/*` is the page that renders the description, so it is not part of it. And echo registers entries of its own — `RouteNotFound`, the catch-alls it adds when a group carries middleware, so a 404 inside `/api/v1/tasks` still runs the session check — which name no endpoint a client calls. Everything else must be documented, and anything missing is collected and sorted, so the failure names routes in a stable order.

The second case pins the page itself:

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
func TestSwaggerUI_ServesTheDocs(t *testing.T) {
	t.Parallel()

	e := api.New(store.NewMemoryStore(), stubAuth{}, api.NewSessionManager(memstore.New()), discardLogger())

	index := get(t, e, "/swagger/index.html")
	require.Equal(t, http.StatusOK, index.Code)
	assert.Contains(t, index.Body.String(), "Swagger UI")

	spec := get(t, e, "/swagger/doc.json")
	require.Equal(t, http.StatusOK, spec.Code)
	assert.Contains(t, spec.Header().Get(echo.HeaderContentType), "application/json")
	assert.Equal(t, withoutEmptySpecKeys(t, readSpecFile(t)), withoutEmptySpecKeys(t, spec.Body.Bytes()))
}
```

The index answers 200 and shows the page's name; the document the page serves is compared, key for key, with the file on disk. One helper makes that comparison fair.

The page's own template always renders three keys — `host`, `basePath`, and `schemes` — even when they are empty, while the generated file leaves them out. `withoutEmptySpecKeys` drops them from both sides:

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
func withoutEmptySpecKeys(t *testing.T, data []byte) map[string]any {
	t.Helper()

	var doc map[string]any
	require.NoError(t, json.Unmarshal(data, &doc), "the spec must be valid JSON")
	for _, key := range []string{"host", "basePath", "schemes"} {
		delete(doc, key)
	}
	return doc
}
```

A difference of encoding, not of content — which is why the helper deletes the three keys instead of comparing raw bytes.

## Watch it fail

None of the pieces exist yet — no annotations, no generated file, no page — so run everything:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	2.384s
ok  	todo/cmd/todo-server	2.318s
--- FAIL: TestSwaggerUI_ServesTheDocs (0.00s)
    docs_test.go:113: 
        	Error:      	Not equal: 
        	            	expected: 200
        	            	actual  : 404
        	Test:       	TestSwaggerUI_ServesTheDocs
--- FAIL: TestSpec_DocumentsEveryRoute (0.00s)
    docs_test.go:84: 
        	Error:      	Received unexpected error:
        	            	open docs/swagger.json: no such file or directory
        	Test:       	TestSpec_DocumentsEveryRoute
        	Messages:   	docs/swagger.json is generated and committed; run make generate
FAIL
FAIL	todo/internal/api	0.959s
...
FAIL
```

Two failures, two halves of the work. The description file does not exist because nothing has generated it yet, and the page's route does not exist, so the request comes back as a 404 in the app's usual error shape.

## Annotate the handlers

The generator is called `swag`, and what it reads are **annotations**: comment lines in a fixed shape, starting with `@`. The comment above each handler already explains the operation to a person; the annotations add the machine-readable half — a summary, the inputs, the answers, the path.

One block belongs to no single operation: the general information — title, version, description, and a description for each group of operations. It must stand alone as a comment group of its own, and ours sits in `cmd/todo-server/main.go`, above `main`:

<!-- verify: cmd/todo-server/main.go at=openapi -->
```go title="cmd/todo-server/main.go"
//	@title			Todo API
//	@version		1.0
//	@description	The todo application's HTTP surface: the task CRUD routes
//	@description	and the auth routes that gate them.
//	@description
//	@description	The task routes require a session: log in through
//	@description	`POST /api/v1/auth/login` first, and the cookie it sets
//	@description	carries the identity on every following request. Every task
//	@description	is scoped to the authenticated user, so a task another user
//	@description	owns answers exactly what a missing task answers.
//	@description
//	@description		Every failure leaves in one shape — `code`, `message`, and,
//	@description		on a validation failure, `fields`. The responses named per
//	@description		operation are the ones its handler decides; the stack's own
//	@description		failures can arrive on any route in the same shape: 413 for
//	@description		a body over 64 KiB, 500 for an internal error, 504 for a
//	@description		request past its ten-second deadline.
//	@tag.name			tasks
//	@tag.description	The task CRUD surface. Every route requires a session and is scoped to the caller.
//	@tag.name			auth
//	@tag.description	Registration, login, and logout — the routes an anonymous caller can reach.
//	@tag.name			health
//	@tag.description	Liveness and readiness probes for supervisors, not clients.
```

The blank `@description` lines separate paragraphs on the rendered page. Read what the block promises a client: the task routes require a session, and every failure leaves in one shape — `code`, `message`, and, on a validation failure, `fields`.

Each of the ten operations then carries its own annotations, beside the comment that explains it. `listTasks` is the shape all ten follow:

<!-- verify: internal/api/tasks.go at=openapi -->
```go title="internal/api/tasks.go"
//	@Summary		List tasks
//	@Description	Lists the authenticated user's tasks. status and tag are filters and cannot be combined.
//	@Tags			tasks
//	@Produce		json
//	@Param			status	query		string				false	"filter by status"	Enums(Todo, Done)
//	@Param			tag		query		string				false	"filter by tag"
//	@Success		200		{object}	taskListResponse	"the caller's tasks"
//	@Failure		400		{object}	errorResponse		"an invalid filter, or status and tag combined"
//	@Failure		401		{object}	errorResponse		"no session"
//	@Router			/api/v1/tasks [get]
```

Read the lines one at a time. `@Param status query string false "filter by status" Enums(Todo, Done)` is one input: its name, where it travels (`query` means the query string), its type, whether it is required, what it means, and the values it accepts. `@Success 200 {object} taskListResponse` names the answer's shape by the Go type that produces it. `@Failure 401 {object} errorResponse "no session"` references the one error shape by name. And `@Router /api/v1/tasks [get]` is the method and path the check matches against the route table.

The routes with a body add `@Accept json` and a `body` parameter; the routes with an id add a `path` parameter; and three responses carry a header — a create's `Location`, and the login's and logout's `Set-Cookie`:

<!-- verify: internal/api/auth.go at=openapi -->
```go title="internal/api/auth.go"
//	@Success		200			{object}	userResponse	"the authenticated user"
//	@Header			200			{string}	Set-Cookie		"the session cookie"
```

That is the login's pair: the answer's shape and the cookie it sets. The create's `Location` and the logout's cleared cookie follow the same pattern.

The two health endpoints are operations like the rest, in a group of their own:

<!-- verify: internal/api/api.go at=openapi -->
```go title="internal/api/api.go"
//	@Summary		Liveness probe
//	@Description	Reports the process up. Touches no dependency, so a database that is briefly away does not fail it.
//	@Tags			health
//	@Produce		json
//	@Success		200	{object}	map[string]string	"status ok"
//	@Router			/healthz [get]
```

They are for supervisors rather than clients, but documenting them keeps the check free of exceptions: the only routes it skips are the page itself and echo's internal entries.

## Two shapes the comments cannot reach

The generator builds each shape from the Go type it finds, and two of our types are not literal enough for it. The first is `time.Time`: the tool renders any type named `Time` as a plain string with no format, so the fields that carry an instant add a backtick note recording the encoding the wire already uses:

<!-- verify: internal/api/tasks.go at=openapi -->
```go title="internal/api/tasks.go"
	Due      *time.Time `json:"due,omitempty" format:"date-time"`
// ...
	Due      *time.Time `json:"due" format:"date-time"`
```

The create body's `due` field and the response's carry the same note, and so does `created_at` on the user response:

<!-- verify: internal/api/auth.go at=openapi -->
```go title="internal/api/auth.go"
	CreatedAt time.Time `json:"created_at" format:"date-time"`
```

All three instants reach the page as dates, in the form the API already speaks.

The second type is the change body's `due` field. It uses our `optional[time.Time]` wrapper — the one that tells an absent field from a null one — and the wrapper's fields are private, so the tool cannot see through it. Without help it documents the field as an empty object, a shape no client could use. Two backtick notes fix it, and a third records the status vocabulary:

<!-- verify: internal/api/tasks.go at=openapi -->
```go title="internal/api/tasks.go"
type updateTaskRequest struct {
	Version  *int                `json:"version" validate:"required,min=1"`
	Title    *string             `json:"title,omitempty"`
	Status   *string             `json:"status,omitempty" enums:"Todo,Done"`
	Priority *int                `json:"priority,omitempty" validate:"omitempty,min=1,max=5"`
	Due      optional[time.Time] `json:"due" swaggertype:"string" format:"date-time"`
	Tags     *[]string           `json:"tags,omitempty" validate:"omitempty,tags"`
}
```

`swaggertype:"string"` tells the tool the wire value is a string — or null — and `format:"date-time"` says which kind of string. `enums:"Todo,Done"` records the two statuses the domain's parser accepts. The generated shape for those two fields reads:

```json
"due": {
    "type": "string",
    "format": "date-time"
},
...
"status": {
    "type": "string",
    "enum": [
        "Todo",
        "Done"
    ]
},
```

Those notes are the whole difference between an unusable empty object and a documented string.

## Generate the document

Two libraries join the app: the generated file imports the first, and the page's handler comes from the second. Fetch both — `go get github.com/swaggo/swag@v1.16.6` and `go get github.com/swaggo/echo-swagger@v1.5.2` — then run the generator. It is not installed anywhere: `go run` builds it into the module cache and runs it, at the exact version named in the command.

First the formatter, which tidies the annotations' alignment:

```bash
$ go run github.com/swaggo/swag/cmd/swag@v1.16.6 fmt -d cmd/todo-server,internal/api -g main.go
```

Silence means the annotations were already tidy. Then the generator itself:

```bash
$ go run github.com/swaggo/swag/cmd/swag@v1.16.6 init -g cmd/todo-server/main.go -o internal/api/docs --parseInternal
2026/10/15 13:59:49 Generate swagger docs....
2026/10/15 13:59:49 Generate general API Info, search dir:./
2026/10/15 13:59:49 warning: failed to get package name in dir: ./, error: execute go list command, exit status 1, stdout:, stderr:no Go files in …
2026/10/15 13:59:49 Generating api.registerRequest
...
2026/10/15 13:59:49 create docs.go at internal/api/docs/docs.go
2026/10/15 13:59:49 create swagger.json at internal/api/docs/swagger.json
2026/10/15 13:59:49 create swagger.yaml at internal/api/docs/swagger.yaml
```

Three parts of the command matter. `-g` names the file that holds the general block. `-o` names the output folder. And `--parseInternal` tells the tool to read the module's `internal/` packages, where every handler lives — run it from the app's root, which is where the search starts.

The warning line is the tool asking the root folder for a package name; the root is a module, not a package, so there is no name to find. It warns and carries on, and the lines after it show the shapes being written. The document calls each one a definition.

The run writes three files into `internal/api/docs/`: `docs.go`, `swagger.json`, and `swagger.yaml`. The JSON and YAML files are the same document in two encodings. `docs.go` opens by saying who wrote it:

<!-- verify: internal/api/docs/docs.go at=openapi -->
```go title="internal/api/docs/docs.go"
// Package docs Code generated by swaggo/swag. DO NOT EDIT
package docs
```

It embeds the document and registers it at startup, and that registration is what the page's handler reads. The API imports the package for that one step, with an underscore — imported, but not named:

<!-- verify: internal/api/api.go at=openapi -->
```go title="internal/api/api.go"
	// The generated spec, imported for its side effect: its init registers
	// the document with swag, which is where the UI handler reads it from.
	_ "todo/internal/api/docs"
```

One underscore, one registration, and the page has a document to read.

:::note
The three generated files are outputs, never inputs. Edit one by hand and the next generator run overwrites the edit — change the annotation, run the generator again, and read what changed in the document.
:::

## Serve the page

One route serves the document and the page's own files. It goes in `New`, beside the health endpoints, under the same middleware stack as every other route:

<!-- verify: internal/api/api.go at=openapi -->
```go title="internal/api/api.go"
	// The spec and the UI that renders it, under the same stack as every
	// other route: a documentation request gets an id, a record, a
	// deadline, and the security headers like any other. The handler
	// serves the spec the docs package registered at init — the same
	// document the tests read from disk — plus swagger-ui's assets.
	e.GET("/swagger/*", echoSwagger.WrapHandler)
```

The page is public — no session — and that is deliberate. The document describes routes an anonymous caller can already probe: a task request without a session gets the same 401 it would get anywhere, and that refusal already says the route exists. The document carries shapes, not data. And the page a client would log in through is the page a login wall would refuse.

A request for the page still rides the whole stack. Start the server as before — `TODO_DB=todo.db TODO_LOG=todo.log ./todo-server --listen 127.0.0.1:18086` in a scratch folder — and keep its address in `$B` (`B=http://127.0.0.1:18086`). Ask for the page:

```bash
$ curl -si $B/swagger/index.html | head -14
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Referrer-Policy: no-referrer
Vary: Cookie
Vary: Accept-Encoding
Vary: Origin
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
X-Request-Id: vAfkNbACxTBQXNXJnXUfmvGtNPhsrrok
X-Xss-Protection: 1; mode=block
Date: Thu, 15 Oct 2026 08:28:49 GMT
Transfer-Encoding: chunked
```

The request id, the security headers, and the session layer's `Vary: Cookie` are all there: the docs are not a side door around the middleware, they are another route.

## The record that named the wrong path

The page worked on the first load: the title, every operation, and the shapes all rendered. Then we read the server's records and found one that lied. The request for `/swagger/favicon-32x32.png` was recorded as `favicon-32x32.png`.

The cause sits in the page's asset handler: it rewrites its own copy of the request's address to the file's relative name before serving it, and our request record read the address after the handler ran. A record of the request should be captured while the request is still the client's.

So the fix gets a test that fails without it. Add this case to `internal/api/middleware_test.go` — it drives a route that rewrites its address the way the real handler does:

<!-- verify: internal/api/middleware_test.go at=openapi -->
```go title="internal/api/middleware_test.go"
// TestRequestLog_PathAsRequested pins that the record names the path the
// client sent, not one a handler rewrote. The Swagger UI's asset handler is
// the real case: it rewrites its request's URL to the embedded file's
// relative name before handing it to the file server, and a record that read
// the URL afterwards would log "swagger-ui.css" as the path.
func TestRequestLog_PathAsRequested(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	e := newTestAPI(store.NewMemoryStore(), logger)

	// A route that rewrites its URL the way the UI's handler does.
	e.GET("/rewrite", func(c echo.Context) error {
		c.Request().URL.Path = "relative-name.css"
		return c.NoContent(http.StatusNoContent)
	})

	rec := get(t, e, "/rewrite")

	require.Equal(t, http.StatusNoContent, rec.Code)
	records := logRecords(t, buf)
	require.Len(t, records, 1)
	assert.Equal(t, "/rewrite", records[0].Path)
}
```

The route renames its request's address and answers 204; the case asks that the record still read `/rewrite`. Run it before the fix, and it fails:

```bash
$ go test -count=1 -run TestRequestLog_PathAsRequested ./internal/api
--- FAIL: TestRequestLog_PathAsRequested (0.00s)
    middleware_test.go:206: 
        	Error:      	Not equal: 
        	            	expected: "/rewrite"
        	            	actual  : "relative-name.css"
        	Test:       	TestRequestLog_PathAsRequested
FAIL
FAIL	todo/internal/api	0.035s
FAIL
```

The record shows the handler's rewritten name, not the path the client sent. The fix reads the method and the path at the top of the middleware, with the id and the start time, before anything can rewrite them:

<!-- verify: internal/api/middleware.go at=openapi -->
```go title="internal/api/middleware.go"
			// The method and the path are read now, before the handler
			// runs: they are the request as the client sent it, and a
			// handler may rewrite its own copy of the URL — the Swagger
			// UI's asset handler rewrites it to the embedded file's
			// relative name — which must not leak into the record.
			method, path := req.Method, req.URL.Path
```

The two values are captured before the handler runs, so nothing a handler does to its own copy of the request can reach them. The record is written from those two values instead of re-reading the request:

<!-- verify: internal/api/middleware.go at=openapi -->
```go title="internal/api/middleware.go"
			reqLogger.LogAttrs(c.Request().Context(), requestLevel(c.Response().Status), "request",
				slog.String("method", method),
				slog.String("path", path),
				slog.Int("status", c.Response().Status),
				slog.Duration("duration", time.Since(start)),
			)
```

Run the case again, and the record reads `/rewrite`.

## Run it green

Run everything:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	1.602s
ok  	todo/cmd/todo-server	1.673s
ok  	todo/internal/api	0.549s
?   	todo/internal/api/docs	[no test files]
ok  	todo/internal/auth	0.524s
ok  	todo/internal/cli	0.263s
ok  	todo/internal/config	0.004s
ok  	todo/internal/db	0.056s
ok  	todo/internal/logging	0.004s
ok  	todo/internal/store	0.511s
?   	todo/internal/store/storetest	[no test files]
ok  	todo/internal/task	0.005s
```

Every package passes. The new `internal/api/docs` package has no test files of its own — it is generated, and the coverage case in `internal/api` holds it to its promises.

The document holds ten operations and nine definitions:

```text
POST   /api/v1/auth/login       Log in
POST   /api/v1/auth/logout      Log out
POST   /api/v1/auth/register    Register a user
GET    /api/v1/tasks            List tasks
POST   /api/v1/tasks            Create a task
DELETE /api/v1/tasks/{id}       Delete a task
GET    /api/v1/tasks/{id}       Get a task
PATCH  /api/v1/tasks/{id}       Update a task
GET    /healthz                 Liveness probe
GET    /ready                   Readiness probe
```

Five task routes, three auth routes, two health routes; the four request bodies, the three response shapes, and the error pair. Open the page while the server runs — at `http://127.0.0.1:18086/swagger/index.html` — and it renders the title, the operations, and the shapes, each operation with a form that sends a real request.

## If something went wrong

**`open docs/swagger.json: no such file or directory`.** The description is generated, not written by hand, and the test says so:

```text
--- FAIL: TestSpec_DocumentsEveryRoute (0.00s)
    docs_test.go:84: 
        	Error:      	Received unexpected error:
        	            	open docs/swagger.json: no such file or directory
        	Test:       	TestSpec_DocumentsEveryRoute
        	Messages:   	docs/swagger.json is generated and committed; run make generate
```

Run the two swag commands from the app's root and the file appears in `internal/api/docs/`.

**`ECHO_ROUTE_NOT_FOUND` names routes a client cannot call.** If the check walks the route table without the second half of its filter, it reports echo's own catch-all entries:

```text
--- FAIL: TestSpec_DocumentsEveryRoute (0.00s)
    docs_test.go:99: 
        	Error:      	Should be empty, but was [ECHO_ROUTE_NOT_FOUND /api/v1/tasks ECHO_ROUTE_NOT_FOUND /api/v1/tasks/*]
        	Test:       	TestSpec_DocumentsEveryRoute
        	Messages:   	every echo route must be documented in docs/swagger.json
```

echo registers those entries for a group's prefix and `prefix/*` when the group carries middleware, so a 404 inside `/api/v1/tasks` still runs `RequireUser`. They are real entries in the table and they name no endpoint a client calls, so the check skips them, by name:

<!-- verify: internal/api/docs_test.go at=openapi -->
```go title="internal/api/docs_test.go"
		if route.Path == swaggerPath || route.Method == echo.RouteNotFound {
			continue
		}
```

With that clause, the check and the route table agree: only routes a client can call are held to the document.

**The `swag init` warning that is not a failure.** Every run prints it:

```text
2026/10/15 13:59:49 warning: failed to get package name in dir: ./, error: execute go list command, exit status 1, stdout:, stderr:no Go files in …
```

It is the tool asking the root folder for a package name — the root is a module, not a package — and the document is complete without one. The trap is the obvious way to silence it: pointing the search at the folder the general block lives in, `cmd/todo-server`, would drop every annotation outside that folder, and the document would come out with zero paths and zero definitions. Keep the run as shown.

<details>
<summary>Going deeper: spec-first or code-first?</summary>

An OpenAPI document can be written two ways. **Spec-first** writes the document by hand and generates server stubs from it: the document is the source of truth, and the code follows. **Code-first** — ours — annotates the handlers and generates the document from them: the code is the source of truth, and the document follows.

Code-first wins here because each annotation sits beside the handler it describes. A reader changing a handler sees what the document will say, and the two move in one edit. The cost is real and worth naming: annotations are prose, and the compiler does not check them. A handler can gain a route and no annotation, and the build stays happy — which is exactly why the coverage case walks the route table. A route the document does not name fails the next run instead of shipping.

</details>

<details>
<summary>Going deeper: why the generated files stay in the project</summary>

The three generated files are not hidden away; they live in `internal/api/docs/` with the rest of the code. That placement buys two things. The test reads the document from disk, so the file the page serves is a file a person can open and read. And a copy of the project without the generator still has the document, because the document is part of the project.

When a handler changes, its annotation changes beside it, the generator runs again, and the document changes with it — one edit, one generated update, read together.

</details>

<details>
<summary>Going deeper: the release candidate in the library list</summary>

If you read `go.mod` after fetching, one line looks strange: `github.com/swaggo/swag/v2` is there, marked indirect, even though nothing in the app calls it. The page's handler library supports both versions of the document format, and importing both of the generator library's major versions is how it does that. The v2 line arrives as a consequence, compiled into the build graph but never called.

The alternative — an older handler library that predates the v2 support — trades the extra line for a version two releases behind the maintained one. We keep the maintained one, and the line is named here so it is not a mystery in `go.mod`.

</details>

The API describes itself now, and the description cannot fall behind the code. Next, the app grows a web face that reads the same session and the same store.

<div class="day-tracker" data-day="41"></div>
