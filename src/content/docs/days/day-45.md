---
title: "Day 45 — CSS and static files"
description: "Give the pages a face — a hand-written stylesheet, baked into the executable and served with a version the browser can check. — Day 45 of 100 Days of Go Lang."
sidebar:
  order: 45
chapter: 38
---

**About 3 hours** · Part VIII, day 3 of 5.

**You'll be able to:**

- style the pages with a small design system;
- embed the assets in the binary and serve them with cache validation.

---

The pages work. Sign in and the tasks appear; the forms save and delete; the header knows whether you're logged in. But a browser draws all of it with its default looks — plain black text, plain gray buttons, one long unstyled column.

Today the app gets a face. The face is a **stylesheet**: a file that tells the browser how things should look — which color each piece of text is, how much space sits around it, how big it is. The page asks for the file with one line, and the browser paints everything with it.

The neat part is where the file lives. We **embed** it — bake its bytes into the program itself — so the finished app carries its own looks. There is nothing to copy beside the executable, and nothing to forget when the app moves to a server.

By the end, the task list looks like a real app: cards, buttons, spacing, and a dark mode.

## What a stylesheet is

A stylesheet is written in **CSS** — the language that says how a page looks. CSS is a list of rules. Each rule picks part of the page and gives it orders:

```css
body {
  color: #1b1f23;
  background: #f2f4f7;
}
```

`body` picks the page's body; the lines inside the braces say its text is near-black and its background is light gray. A browser reads the rules top to bottom and applies them to what it draws.

Our stylesheet is one file, `internal/web/assets/app.css`. It's a **design system** in miniature: every color, space, and text size is named once at the top, and every rule below reads those names. Change one name and the whole page follows — which is how the file gets its dark mode in a single block at the end.

A browser only loads a stylesheet if the page asks for it, and the page asks with one line in its head: `<link rel="stylesheet" href="/static/app.css"/>`. Every page in the app gets that line, because every page is built inside the same layout.

One more thing before we write any of it: there is no tool to install and no build program to run for CSS. The file is source, like Go code — and `go build` is the only build step we need.

## The tests come first

Every promise the server makes is written down as a test first — that's how the app has been built from the very beginning. The stylesheet's promise has three layers:

- `internal/web/assets_test.go` — the wire: the stylesheet's URL answers 200 with `text/css`, a version header, and a cache instruction; a second request carrying that version gets `304 Not Modified`; an unknown path is the app's usual 404.
- `internal/web/assets/assets_test.go` — the version itself: every embedded file gets one, and it is a fingerprint of that file's bytes.
- `cmd/todo-server/integration_test.go` — the process: the real executable serves the stylesheet with nothing beside it, because the stylesheet is inside it.

The finished app's appendix holds the complete test files; the pieces below are the ones that carry the idea.

Create the first file, `internal/web/assets_test.go`. It opens with the two values the tests and the server must agree on, and the pattern that finds the stylesheet's link in a page:

<!-- verify: internal/web/assets_test.go at=web-assets -->
```go title="internal/web/assets_test.go"
// The static surface's wire contract, pinned: the policy string the tests
// and the server must spell the same way, and the stylesheet's stable URL —
// stable being the whole point of the revalidation policy.
const (
	// assetCacheControl is the Cache-Control value the policy promises:
	// store the file, revalidate before every use.
	assetCacheControl = "no-cache"
	// stylesheetPath is the stylesheet's URL, as the layout links it.
	stylesheetPath = "/static/app.css"
)

// stylesheetLink matches the layout's stylesheet reference. templ renders
// attributes in source order, so rel comes before href, and a void element
// without the source's self-closing slash.
var stylesheetLink = regexp.MustCompile(`<link rel="stylesheet" href="([^"]+)">`)
```

`assetCacheControl` is the instruction the server will send with the file, and `stylesheetPath` is the URL the layout will link. `stylesheetLink` is a small pattern that reads that URL out of a page's own output — so a test can fetch exactly what the page asked for.

The first case asks for the stylesheet and checks the whole answer:

<!-- verify: internal/web/assets_test.go at=web-assets -->
```go title="internal/web/assets_test.go"
// TestStaticAssets_ServeTheDesignSystem pins the mount: GET /static/app.css
// is the embedded stylesheet, served with the validators the cache policy
// promises — a strong ETag and a Cache-Control that asks for revalidation —
// and the content type a stylesheet needs.
func TestStaticAssets_ServeTheDesignSystem(t *testing.T) {
	t.Parallel()

	e, _ := newWebAPI(t, store.NewMemoryStore())
	rec := get(t, e, stylesheetPath)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get(echo.HeaderContentType), "text/css")
	assert.Equal(t, assetCacheControl, rec.Header().Get(echo.HeaderCacheControl))

	// The validator is strong — a quoted, content-derived tag, never a
	// weak W/ one — because the embedded file cannot change under it.
	assert.Regexp(t, `^"[0-9a-f]{32}"$`, rec.Header().Get("ETag"))

	// The body is the design system: tokens first, then the components the
	// pages' markup reads.
	body := rec.Body.String()
	assert.Contains(t, body, ":root {")
	assert.Contains(t, body, "--color-ink:")
	assert.Contains(t, body, "--space-4:")
	assert.Contains(t, body, "--font-body:")
	assert.Contains(t, body, ".task {")
	assert.Contains(t, body, "prefers-color-scheme: dark")
}
```

Read it as a list of promises: a 200; a content type that says CSS; `no-cache`; a version header whose value is a quoted 32-character code; and a body that is the design system itself — the `:root` names first, the dark block last. The odd-looking parts will make sense when we write the server side.

The second case is the browser's second visit — the same URL, with the version from the first answer sent back:

<!-- verify: internal/web/assets_test.go at=web-assets -->
```go title="internal/web/assets_test.go"
// TestStaticAssets_RevalidateWithETag pins the policy's second half: the
// same URL is asked for again with the tag the first answer carried, and
// the answer is a 304 with no body — the request a browser makes on every
// page load after the first. A tag that does not match gets the file.
func TestStaticAssets_RevalidateWithETag(t *testing.T) {
	t.Parallel()

	e, _ := newWebAPI(t, store.NewMemoryStore())

	first := get(t, e, stylesheetPath)
	require.Equal(t, http.StatusOK, first.Code)
	tag := first.Header().Get("ETag")
	require.NotEmpty(t, tag)

	t.Run("a matching tag is the 304", func(t *testing.T) {
		t.Parallel()

		rec := getIfNoneMatch(t, e, stylesheetPath, tag)

		require.Equal(t, http.StatusNotModified, rec.Code)
		assert.Empty(t, rec.Body.String(), "a 304 carries no body")
...
	t.Run("a stale tag serves the file", func(t *testing.T) {
		t.Parallel()

		rec := getIfNoneMatch(t, e, stylesheetPath, `"stale"`)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, first.Body.String(), rec.Body.String())
	})
}
```

A matching version gets `304 Not Modified` with no body: nothing changed, keep your copy. A wrong version gets the whole file again.

The third case pins the miss. Three shapes of it — a file that isn't there, a path that tries to climb out of the tree, and the folder itself — all answer the same 404 in the same JSON shape as every other miss in the app:

<!-- verify: internal/web/assets_test.go at=web-assets -->
```go title="internal/web/assets_test.go"
// TestStaticAssets_UnknownPathsAre404 pins the static surface's miss: a
// path the embedded tree does not have is the same 404 in the same error
// shape every other miss is — including a path that tries to climb out of
// the tree, which the static handler refuses before any file is opened.
func TestStaticAssets_UnknownPathsAre404(t *testing.T) {
	t.Parallel()

	e, _ := newWebAPI(t, store.NewMemoryStore())

	for name, target := range map[string]string{
		"a file that is not embedded": "/static/nope.css",
		"a path that climbs out":      "/static/../web.go",
		"the directory itself":        "/static/",
	} {
		t.Run(name, func(t *testing.T) {
...
			rec := get(t, e, target)

			require.Equal(t, http.StatusNotFound, rec.Code)
			assert.Equal(t, echo.MIMEApplicationJSON, rec.Header().Get(echo.HeaderContentType))
			assert.JSONEq(t, `{"code":"not_found","message":"Not Found"}`, rec.Body.String())
		})
	}
}
```

Not found, in the app's usual voice. A fourth case ties the page to the stylesheet: `TestPage_LinksTheDesignSystem` fetches the login page, reads the stylesheet's URL out of the page's own output, and asks for it — a link the server does not serve would be a broken page.

And one small piece of test furniture, the request a browser makes when it holds a copy:

<!-- verify: internal/web/assets_test.go at=web-assets -->
```go title="internal/web/assets_test.go"
// getIfNoneMatch drives one conditional GET through the handler: the same
// request a browser makes when it holds a copy and presents the validator.
func getIfNoneMatch(t *testing.T, h http.Handler, target, tag string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set("If-None-Match", tag)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
```

It builds a GET request, sets the version header, and records the answer. The second file is the white-box half — tests that live inside the package and check the version-making code directly. Create `internal/web/assets/assets_test.go`:

<!-- verify: internal/web/assets/assets_test.go at=web-assets -->
```go title="internal/web/assets/assets_test.go"
// TestETags pins the validator map against the embedded tree: every file
// carries a tag, and the tag is the quoted SHA-256 prefix of the file's own
// bytes — recomputed here, not read back from the map, so the test would
// catch a walk that hashed the wrong thing.
func TestETags(t *testing.T) {
	t.Parallel()

	embedded := []string{"app.css"}
	for _, name := range embedded {
		data, err := fs.ReadFile(Files, name)
		require.NoError(t, err, name)
		sum := sha256.Sum256(data)
		assert.Equal(t, `"`+hex.EncodeToString(sum[:16])+`"`, ETags[name])
	}
	assert.Len(t, ETags, len(embedded), "the map names every embedded file, and only those")
}
```

Read the last lines: the test recomputes the fingerprint from the file's own bytes and compares it to the map. A test that read the value back out of the map would prove nothing — recomputing it proves the map's values really come from the files.

The second case builds a tiny tree in memory — three pretend stylesheets — and walks it:

<!-- verify: internal/web/assets/assets_test.go at=web-assets -->
```go title="internal/web/assets/assets_test.go"
// TestEntityTags walks a synthetic tree: the tag is a function of the
// content — which is what makes it a version rather than a timestamp —
// directories are skipped, and the file's path is the key.
func TestEntityTags(t *testing.T) {
	t.Parallel()

	tree := fstest.MapFS{
		"a.css":      {Data: []byte("body {}")},
		"b.css":      {Data: []byte("body { }")},
		"deep/c.css": {Data: []byte("body {}")},
	}

	tags := entityTags(tree)

	require.Len(t, tags, 3, "a directory is not a file")
	assert.Contains(t, tags, "deep/c.css", "the key is the path, not the base name")
	assert.NotEqual(t, tags["a.css"], tags["b.css"], "different bytes, different tags")
	assert.Equal(t, tags["a.css"], tags["deep/c.css"], "same bytes, same tag")
	assert.Equal(t, tags, entityTags(tree), "the walk is deterministic")
}
```

Two files with the same bytes get the same version; two files with different bytes get different versions; a file in a subfolder is keyed by its whole path. That's the rule, proved without touching the real stylesheet.

Last, add one case to `cmd/todo-server/integration_test.go`, the file that drives the real server process. Its pattern block gains one line:

<!-- verify: cmd/todo-server/integration_test.go at=web-assets -->
```go title="cmd/todo-server/integration_test.go"
// The regexps the flow reads out of a page: the token every form embeds,
// the first task row's edit link and version — the values a browser carries
// back in the row's forms — and the stylesheet's URL. templ renders
// attributes in source order.
var (
	csrfField      = regexp.MustCompile(`name="csrf_token" value="([^"]+)"`)
	editLink       = regexp.MustCompile(`href="/tasks/([0-9a-f-]+)/edit"`)
	versionField   = regexp.MustCompile(`name="version" value="(\d+)"`)
	stylesheetLink = regexp.MustCompile(`<link rel="stylesheet" href="([^"]+)">`)
)
```

`stylesheetLink` is the same pattern as in the first test file. The two
helpers the case calls are the file's own: `startServer` starts the binary,
and `fetchPage` makes a request and hands back the response and the page's
text. The finished app's appendix holds
`cmd/todo-server/integration_test.go` in full — read the parts behind the
`...` there as you type them. The case itself starts the real binary and
follows the page's own link:

<!-- verify: cmd/todo-server/integration_test.go at=web-assets -->
```go title="cmd/todo-server/integration_test.go"
func TestServer_StaticAssets(t *testing.T) {
	t.Parallel()

	srv := startServer(t)
	defer srv.stop(t)

	base := "http://" + srv.addr

	resp, page := fetchPage(t, base+"/login")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	link := stylesheetLink.FindStringSubmatch(page)
	require.Len(t, link, 2, "the page links its stylesheet")
...
	resp, css := fetchPage(t, base+link[1])
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, resp.Header.Get("Content-Type"), "text/css")
	require.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
	tag := resp.Header.Get("ETag")
	require.NotEmpty(t, tag, "the stylesheet carries a validator")
	require.Contains(t, css, ":root")
...
	require.Equal(t, http.StatusNotModified, resp.StatusCode)
	require.Empty(t, body, "a 304 carries no body")
}
```

The point is where the stylesheet comes from. The test starts the server in a scratch folder holding only the database and the log file — no `assets/` folder, no `static/` folder, nothing to copy beside the executable — and the stylesheet is served anyway, because it was compiled in.

Now run the tests and watch them fail:

```bash
$ go test -count=1 ./...
# todo/internal/web/assets [todo/internal/web/assets.test]
internal/web/assets/assets_test.go:28:28: undefined: Files
internal/web/assets/assets_test.go:31:57: undefined: ETags
internal/web/assets/assets_test.go:33:16: undefined: ETags
internal/web/assets/assets_test.go:48:10: undefined: entityTags
internal/web/assets/assets_test.go:54:24: undefined: entityTags
...
--- FAIL: TestStaticAssets_ServeTheDesignSystem (0.00s)
    assets_test.go:42: 
        	Error Trace:	…/internal/web/assets_test.go:42
        	Error:      	Not equal: 
        	            	expected: 200
        	            	actual  : 404
        	Test:       	TestStaticAssets_ServeTheDesignSystem
...
FAIL
FAIL	todo/internal/web	0.088s
FAIL	todo/internal/web/assets [build failed]
```

Two failures, and both are the point. The first is a package that doesn't exist yet: `internal/web/assets` has only its test file, so the compiler names every piece we're about to write — `Files`, `ETags`, `entityTags`. The second is the better one: the HTTP cases compile and run against the app as it stands, and `/static/app.css` is echo's 404 where the 200 will be. The page case fails too, because the layout has no link yet. Nothing is broken; the code simply doesn't exist yet.

## Files baked into the program

Now the code. Create `internal/web/assets/assets.go`. Its two jobs are to hold the stylesheet inside the program — that's the embedding — and to know each file's version:

<!-- verify: internal/web/assets/assets.go at=web-assets -->
```go title="internal/web/assets/assets.go"
// Files is the embedded tree, rooted at this directory: the stylesheet is
// "app.css" inside it, which is also the name the server resolves a request
// to.
//
//go:embed app.css
var Files embed.FS
```

The line to stare at is `//go:embed app.css`. It looks like a comment — and it is one, in a way: a **directive**, a comment the Go tool reads as an instruction. It says: when this program is built, read the file `app.css` from this folder and put its bytes inside the program. The variable below it, `Files`, is how the rest of the code sees them.

`embed.FS` is a small file tree that lives in memory. You can open and read files from it, but it can't change and it can't be missing, because its contents are part of the executable. That's what embedding means: the file is baked into the binary, and the binary carries it wherever it goes.

Next, the versions:

<!-- verify: internal/web/assets/assets.go at=web-assets -->
```go title="internal/web/assets/assets.go"
// ETags maps each embedded file's path to its entity tag: the quoted,
// truncated hex SHA-256 of the file's bytes. A strong validator, because
// the bytes it names cannot change under it — a build with an edited
// stylesheet is a build with a new tag, which is what lets a cache treat
// the tag as a version. The map is built once, here; the tree is a few
// kilobytes, so the boot cost is one pass over it.
var ETags = entityTags(Files)
```

An **`ETag`** is a version code for a file. This map's values are built from the files' bytes: take all the bytes, run them through `sha256` — a fingerprinting function built into Go — and write the first 16 bytes of the result as 32 characters of `0`–`9` and `a`–`f`. The same bytes always produce the same code, and one changed character in the CSS produces a different one. That's what makes it an honest version: it can only change when the file changes.

The versions never change while the program runs, so the map is built once at startup, and a request is a map lookup. The walk that builds it is the last piece:

<!-- verify: internal/web/assets/assets.go at=web-assets -->
```go title="internal/web/assets/assets.go"
// entityTags computes the tag for every file in fsys, skipping directories.
// The tree is part of the binary, so a read failure is a programming error
// and panics: there is no boot to fail more gracefully than that, and a
// silently missing validator would turn every revalidation into a full
// download.
func entityTags(fsys fs.FS) map[string]string {
	tags := make(map[string]string)
	err := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(fsys, path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		tags[path] = `"` + hex.EncodeToString(sum[:16]) + `"`
		return nil
	})
	if err != nil {
		panic("assets: computing entity tags: " + err.Error())
	}
	return tags
}
```

`fs.WalkDir` visits every file in the tree; the first lines skip folders. For each file, the code reads the bytes, fingerprints them, and stores the result under the file's path — a file at `deep/c.css` would be stored under that whole name, because the path is also the name the server resolves a request to.

The `panic` at the end is deliberate. The tree is part of the binary, so a file that can't be read means the program is broken in a way no later request could repair. Failing at startup is louder and safer than serving a file with no version.

## The design system

Create `internal/web/assets/app.css`. The finished app's appendix holds the whole stylesheet — every component, not just the three pieces quoted here. It opens with the names every rule below reads:

<!-- verify: internal/web/assets/app.css at=web-assets -->
```css title="internal/web/assets/app.css"
:root {
  /* Color: one ink on one paper over one canvas, plus the accents. */
  --color-ink: #1b1f23;
  --color-ink-muted: #59636e;
  --color-paper: #ffffff;
  --color-canvas: #f2f4f7;
  --color-line: #d1d9e0;
  --color-accent: #0969da;
  --color-accent-strong: #0550ae;
  --color-success-ink: #1a7f37;
  --color-success-bg: #dafbe1;
  --color-danger-ink: #cf222e;
  --color-danger-bg: #ffebe9;

  /* Space: a 4px-based scale; the number is a step, not a multiplier. */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;

  /* Type: one family, four sizes, one line height. */
  --font-body: system-ui, -apple-system, "Segoe UI", sans-serif;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.5rem;
  --leading: 1.5;

  --radius: 6px;
}
```

Those `--color-ink`-style names are **custom properties**: named values that other rules read with `var()`. The names on the right are ordinary colors and sizes; the names on the left are ours. Nothing below the block writes a raw color, so the page's whole palette lives in one place.

The components come next — the header band, the centered column, fields, flash messages, the task cards — and each one styles something the pages' markup already names. The buttons are the clearest example, because they're addressed by what they do:

<!-- verify: internal/web/assets/app.css at=web-assets -->
```css title="internal/web/assets/app.css"
/* Buttons: the bare one is the quiet action, .primary is the action a form
   exists for, .danger destroys something. */
button {
  padding: var(--space-2) var(--space-4);
  font: inherit;
  color: var(--color-ink);
  background: var(--color-paper);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
  cursor: pointer;
}
...
button.primary {
  color: var(--color-paper);
  background: var(--color-accent);
  border-color: var(--color-accent);
}
...
button.danger:hover {
  color: var(--color-danger-ink);
  border-color: var(--color-danger-ink);
}
```

A bare `<button>` is the quiet action: Complete, Log out. `.primary` is the action the form exists for: Save, Log in. `.danger` destroys something: Delete. Those three names are hooks the markup opts into, and the stylesheet treats them as meanings rather than positions — move a button to a different spot on the page and it keeps its look.

The last block is the payoff:

<!-- verify: internal/web/assets/app.css at=web-assets -->
```css title="internal/web/assets/app.css"
/* Dark scheme: one override block, because the components never name a raw
   color. This is the whole reason the tokens exist. */
@media (prefers-color-scheme: dark) {
  :root {
    --color-ink: #e6edf3;
    --color-ink-muted: #9198a1;
    --color-paper: #151b23;
    --color-canvas: #0d1117;
    --color-line: #3d444d;
    --color-accent: #4493f8;
    --color-accent-strong: #6cb6ff;
    --color-success-ink: #3fb950;
    --color-success-bg: #12261e;
    --color-danger-ink: #f85149;
    --color-danger-bg: #25171c;
  }
}
```

Eleven names change, and every component follows, because no component ever named a raw color. That's the dark mode: one block, no second stylesheet, no duplicated rules.

The file is a plain list of rules — one file, no imports, because every extra file would be another request for the browser to make. There is nothing to compile and nothing to run; `go build` will carry it into the binary.

## Serving the file with a version

Every file the server sends rides with the same question: has this browser seen it before? For the stylesheet, the answer is a version and an instruction, and both live in `internal/web/static.go` — the policy for everything served under `/static`:

<!-- verify: internal/web/static.go at=web-assets -->
```go title="internal/web/static.go"
const (
	// assetCacheControl is the policy's Cache-Control value. no-cache
	// means "revalidate before use", not "do not store": the file is
	// cached, and a 304 — a few dozen bytes — is what a browser pays per
	// page load to confirm it.
	assetCacheControl = "no-cache"

	// etagHeader is the header the validator travels in. Neither net/http
	// nor echo exports a constant for it — ServeContent reads it by this
	// name — so it is spelled once, here.
	etagHeader = "ETag"
)
```

`no-cache` sounds like "never keep it", but it means the opposite: **store the file, but ask before using it again**. The version travels in a header named `ETag`; Go's standard library doesn't export a constant for that name, so we spell it once, here.

The middleware puts both on the response before the file is written:

<!-- verify: internal/web/static.go at=web-assets -->
```go title="internal/web/static.go"
// cacheAssets is the /static group's middleware: it sets the cache policy
// on the response before echo's static handler writes the file. The tag is
// looked up by the request's own file name, trimmed the way the handler
// trims it; a name the embedded tree does not have gets no headers and
// falls through to the handler's 404, which leaves in the house error shape
// like every other miss. The tags were computed once at boot, so this is a
// map read per request, not a hash.
func cacheAssets(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if tag, ok := assets.ETags[strings.TrimPrefix(c.Param("*"), "/")]; ok {
			h := c.Response().Header()
			h.Set(etagHeader, tag)
			h.Set(echo.HeaderCacheControl, assetCacheControl)
		}
		return next(c)
	}
}
```

A **middleware** is a function that runs before a handler — the pages already have several, for sessions and for CSRF. This one looks up the request's file name in the version map we just built and, if the file is in the tree, sets the version and the cache instruction on the response. A name the tree doesn't have falls through to the file handler's 404, in the app's usual error shape.

Two details are worth seeing. The lookup uses the request's own path, trimmed the same way the file handler trims it, so both agree on the name. And the headers are set on `c.Response().Header()` — the response about to be written — because the file server reads the version off the response before it decides whether to send the body. Set it after the file, and the browser never gets its 304.

## The mount and the link

Two small changes connect all of this to the running app. First, `internal/web/web.go` mounts the stylesheet under `/static`:

<!-- verify: internal/web/web.go at=web-assets -->
```go title="internal/web/web.go"
func (s *Server) Register(e *echo.Echo) {
	// The embedded design system, under /static and behind the cache
	// policy (see static.go). The group is what lets the policy run
	// before echo's static handler writes the file — StaticFS registers
	// the route but takes no middleware — and an unknown path under
	// /static falls through the wildcard to the stack's 404, in the house
	// error shape like every other miss.
	static := e.Group("/static", cacheAssets)
	static.StaticFS("/", assets.Files)

	e.GET("/", s.index, s.requireUser)
...
}
```

The group is the shape that matters. `e.Group("/static", cacheAssets)` creates the `/static` section of the site with the policy attached to everything in it, and `static.StaticFS("/", assets.Files)` registers echo's own file handler inside it. Serving files — content types, ranges, conditional requests — is the handler's job; the policy is ours.

Why a group instead of mounting the tree directly? Because `StaticFS` registers the route but takes no middleware. The policy must run before the file is written — that's what lets the version be evaluated — and the group is the hook that makes that happen.

Second, the layout names the stylesheet:

<!-- verify: internal/web/views/layout.templ at=web-assets -->
```templ title="internal/web/views/layout.templ"
templ Layout(title string, page Page) {
	<!DOCTYPE html>
	<html lang="en">
		<head>
			<meta charset="utf-8"/>
			<meta name="viewport" content="width=device-width, initial-scale=1"/>
			<title>{ title }</title>
			<link rel="stylesheet" href="/static/app.css"/>
		</head>
```

One line in the head, and every page that composes the layout — the task list, the form, the login page — gets its face. The URL is exactly the URL the tests pin: `/static/app.css`.

## The class hooks

Three buttons gain the names the stylesheet addresses. The form's Save:

<!-- verify: internal/web/views/form.templ at=web-assets -->
```templ title="internal/web/views/form.templ"
		<p class="field">
			<label for="tags">Tags</label>
			<input id="tags" name="tags" value={ form.Tags }/>
			if errors["tags"] != "" {
				<span class="error" role="alert">{ errors["tags"] }</span>
			}
		</p>
		<button type="submit" class="primary">Save</button>
	</form>
```

The Save button carries `.primary` — the action the form exists for. The login page's Log in:

<!-- verify: internal/web/views/login.templ at=web-assets -->
```templ title="internal/web/views/login.templ"
		<form method="post" action="/login">
			<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>
...
			<button type="submit" class="primary">Log in</button>
		</form>
```

Log in gets the same class. And the task row's Delete:

<!-- verify: internal/web/views/tasks.templ at=web-assets -->
```templ title="internal/web/views/tasks.templ"
			<a href={ "/tasks/" + t.ID.String() + "/edit" }>Edit</a>
			<form method="post" action={ "/tasks/" + t.ID.String() + "/delete" }>
				<input type="hidden" name="csrf_token" value={ page.CSRFToken }/>
				<input type="hidden" name="version" value={ strconv.Itoa(t.Version) }/>
				<button type="submit" class="danger">Delete</button>
			</form>
		</span>
```

Save and Log in are the actions their forms exist for, so they're `.primary`. Delete destroys something, so it's `.danger`. The bare buttons — Complete, Log out — need nothing, because the stylesheet styles every bare button the same quiet way.

Now regenerate the Go files from the templates:

```bash
$ go run github.com/a-h/templ/cmd/templ@v0.3.1070 generate
(✓) Post-generation event received, processing... [ updates=4 needsRestart=true needsBrowserReload=true ]
(✓) Complete [ updates=4 duration=5.855185ms ]
```

Four generated files changed — the layout and the three templates. The new link lands in the generated Go as one more piece of text; the generated files follow their sources, so never edit them by hand.

## Run it green

Run the page tests:

```bash
$ go test -count=1 -v ./internal/web/...
--- PASS: TestPage_LinksTheDesignSystem (0.01s)
--- PASS: TestStaticAssets_RevalidateWithETag (0.00s)
...
--- PASS: TestStaticAssets_ServeTheDesignSystem (0.00s)
...
ok  	todo/internal/web	0.036s
--- PASS: TestETags (0.00s)
--- PASS: TestEntityTags (0.00s)
ok  	todo/internal/web/assets	0.002s
```

The PASS lines are grouped here for reading — the cases run in parallel, so they finish in a different order each run. `TestETags` and `TestEntityTags` are the white-box pair; the rest are the wire's.

The process-level cases, with the binary rebuilt:

```bash
--- PASS: TestServer_Lifecycle (0.08s)
--- PASS: TestServer_StaticAssets (0.08s)
...
PASS
ok  	todo/cmd/todo-server	1.434s
```

The second PASS line is the new case. And the whole app:

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	2.043s
ok  	todo/cmd/todo-server	2.301s
...
ok  	todo/internal/web	0.089s
ok  	todo/internal/web/assets	0.003s
?   	todo/internal/web/views	[no test files]
```

Everything passes. The stylesheet travels inside the binary, the server versions it, and the pages link it.

## Look at it from a browser

Start the server the way the earlier web work showed — `TODO_DB=todo.db TODO_LOG=todo.log ./todo-server --listen 127.0.0.1:18089` — sign in, and ask for the stylesheet the way a browser does. The captures below use `$B` for the server's address (`B=http://127.0.0.1:18089`), and `session=...` stands in for the session cookie's value.

```bash
$ curl -si $B/static/app.css | sed -n '1,10p'
HTTP/1.1 200 OK
Accept-Ranges: bytes
Cache-Control: no-cache
Content-Length: 5671
Content-Type: text/css; charset=utf-8
Etag: "249a33fe9d052c2589c90b9614ccce1c"
Referrer-Policy: no-referrer
Vary: Cookie
Vary: Accept-Encoding
Vary: Origin
...
$ curl -s $B/static/app.css | sed -n '6,14p'

:root {
  /* Color: one ink on one paper over one canvas, plus the accents. */
  --color-ink: #1b1f23;
  --color-ink-muted: #59636e;
  --color-paper: #ffffff;
  --color-canvas: #f2f4f7;
  --color-line: #d1d9e0;
  --color-accent: #0969da;
```

Read the headers: `Content-Type: text/css` says this is a stylesheet; `Content-Length` is its size in bytes; `Cache-Control: no-cache` is the policy; and `Etag` is the version.

The header spells the version's name `Etag` — Go's own capitalization of `ETag`. Header names don't care about case; more on that below.

The second visit sends the version back:

```bash
$ ETAG="249a33fe9d052c2589c90b9614ccce1c"

$ curl -si -H "If-None-Match: $ETAG" $B/static/app.css
HTTP/1.1 304 Not Modified
Cache-Control: no-cache
Etag: "249a33fe9d052c2589c90b9614ccce1c"
...
Date: Thu, 15 Oct 2026 09:39:20 GMT
```

`304 Not Modified`, and no body: no stylesheet bytes cross the wire; the browser keeps the copy it already has. That's the version doing its job.

And the version isn't a secret handshake — it's the file's fingerprint, checkable by hand:

```bash
$ sha256sum internal/web/assets/app.css | cut -c1-32
249a33fe9d052c2589c90b9614ccce1c
```

The first 32 characters of the file's SHA-256 are exactly the `Etag` the server sent. Change the file and both change together.

A path the tree doesn't have is the app's usual 404 — and so is a path that tries to climb out of the tree, which the file handler refuses before opening anything:

```bash
$ curl -si $B/static/nope.css
HTTP/1.1 404 Not Found
Content-Type: application/json
...
Content-Length: 43

{"code":"not_found","message":"Not Found"}

$ curl -si --path-as-is $B/static/../app.css | sed -n '1p;$p'
HTTP/1.1 404 Not Found
{"code":"not_found","message":"Not Found"}

$ curl -si $B/static/ | sed -n '1p;$p'
HTTP/1.1 404 Not Found
{"code":"not_found","message":"Not Found"}
```

Three misses, one answer. The page itself names the stylesheet:

```bash
$ curl -s $B/ -H 'Cookie: session=...' | sed -n 's/.*<title>/<title>/;s/<\/head>.*/<\/head>/p'
<title>Tasks</title><link rel="stylesheet" href="/static/app.css"></head>
```

There is the link, in the page a browser would draw. And the buttons carry their hooks:

```bash
$ curl -s $B/ -H 'Cookie: session=...' | grep -o '<button[^>]*class="danger"[^>]*>[^<]*</button>'
<button type="submit" class="danger">Delete</button>

$ curl -s $B/tasks/new -H 'Cookie: session=...' | grep -o '<button[^>]*>[^<]*</button>'
<button type="submit">Log out</button>
<button type="submit" class="primary">Save</button>
```

That's the whole story from outside: the page asks for `/static/app.css`, the server answers from inside its own executable, and a returning browser pays for a few headers instead of the file.

## If something went wrong

**The stylesheet serves, but with no version.** If you mount the tree directly — `e.StaticFS("/static", assets.Files)` instead of the group — the file still serves with a 200 and the right content type, but the policy never runs. The tests say so:

```bash
--- FAIL: TestStaticAssets_ServeTheDesignSystem (0.00s)
    assets_test.go:44: 
        	Error:      	Not equal: 
        	            	expected: "no-cache"
        	            	actual  : ""
...
    assets_test.go:48: 
        	Error:      	Expect "" to match "^"[0-9a-f]{32}"$"
        	Test:       	TestStaticAssets_ServeTheDesignSystem
--- FAIL: TestStaticAssets_RevalidateWithETag (0.00s)
    assets_test.go:73: 
        	Error:      	Should NOT be empty, but was 
        	Test:       	TestStaticAssets_RevalidateWithETag
```

The version header and the cache instruction are empty strings, and the conditional request can never become a 304 — so every page load pays the full download. The fix is the two lines from the mount: `e.Group("/static", cacheAssets)` with `static.StaticFS("/", assets.Files)` on it. The policy has to run before the file handler writes the file.

**The test expects `application/json; charset=UTF-8`, the server sends `application/json`.** The two values from the failed assertion:

```bash
expected: "application/json; charset=UTF-8"
actual  : "application/json"
```

`application/json` has no charset parameter, and echo writes the plain constant. The fix is to expect what the server actually writes. The general rule: when a test disagrees with the server, read the server's code before assuming the server is wrong.

**The wire spells the header `Etag`.** Not a problem, and not a typo: the code sets `ETag`, and Go writes header names with its own capitalization — first letter up, the rest down. `rec.Header().Get("ETag")` and `Get("Etag")` are the same lookup. Don't "fix" the code or the test; there is nothing to fix.

<details>
<summary>Going deeper: why the tokens are worth it</summary>

The `:root` names are CSS **custom properties**. A property set on `:root` — the document's top element — is inherited by everything inside it, and any rule can read it with `var(--name)`. That's why the dark block works: it doesn't restyle a single button or card. It redefines eleven names inside `@media (prefers-color-scheme: dark)`, a rule the browser applies only when the reader's system asks for dark colors, and every rule that reads those names follows automatically.

Without the tokens, the file would need a second copy of every color-bearing rule for dark mode — and the copies would drift apart the first time someone edited one and forgot the other. The tokens are the fix: the components never know the palette, only its names.

</details>

<details>
<summary>Going deeper: the version is a fingerprint</summary>

`sha256.Sum256` runs the file's bytes through the SHA-256 algorithm and returns 32 bytes — a fingerprint so sensitive that changing one character changes roughly half of it, and so wide that two different files producing the same fingerprint is not something that happens. We keep the first 16 of those bytes and write them as 32 characters: 128 bits, which is far more than a version needs, in a header shorter than all 64 characters would be.

Why derive the version from the content instead of the clock? A timestamp would change whenever a build ran, even if the file didn't — and then every browser would re-download a stylesheet that never changed. A content-derived version can only change when the content does, which is exactly what "version" should mean. That's also why the test recomputes the fingerprint from the bytes instead of trusting the map.

</details>

<details>
<summary>Going deeper: the executable carries its files</summary>

A normal program reads its files from disk. An embedded file is different: the Go tool copies it into the executable while building, and at run time the program reads it out of its own bytes. Nothing on disk is opened, so nothing beside the executable can go missing.

This is why the process-level test starts the server in a scratch folder holding only the database and the log: there is no `assets/` directory to find, and the stylesheet is served anyway. The executable is the whole app, looks included.

</details>

The pages have a face now; next the app hardens its edges — the headers every response carries and the rules its cookie follows.

<div class="day-tracker" data-day="45"></div>
