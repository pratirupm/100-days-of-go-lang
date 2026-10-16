---
title: "internal/web — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/appendices/the-finished-app/).


## `internal/web/__snapshots__/snapshots_test.snap`

````text

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

[TestPages_Snapshots/edit_form - 1]
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edit task</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
<h1>
<a href="/">todo</a>
</h1>
<nav>
<a href="/tasks/new">New task</a>
<form method="post" action="/logout">
<input type="hidden" name="csrf_token" value="<csrf>"> <button type="submit">Log out</button>
</form>
</nav>
</header>
<main>
<h2>Edit task</h2>
<form method="post" action="/tasks/<id>">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1">
<p class="field">
<label for="title">Title</label> <input id="title" name="title" value="buy milk"> </p>
<p class="field">
<label for="priority">Priority</label> <select id="priority" name="priority">
<option value="1">1</option>
<option value="2">2</option>
<option value="3" selected>3</option>
<option value="4">4</option>
<option value="5">5</option>
</select> </p>
<p class="field">
<label for="due">Due</label> <input id="due" name="due" type="date" value="2026-11-01"> </p>
<p class="field">
<label for="tags">Tags</label> <input id="tags" name="tags" value="home"> </p>
<button type="submit" class="primary">Save</button>
</form>
</main>
</body>
</html>
---

[TestPages_Snapshots/a_miss's_error_body - 1]
{"code":"not_found","message":"task not found"}

---

[TestPages_Snapshots/new_form - 1]
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New task</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
<h1>
<a href="/">todo</a>
</h1>
<nav>
<a href="/tasks/new">New task</a>
<form method="post" action="/logout">
<input type="hidden" name="csrf_token" value="<csrf>"> <button type="submit">Log out</button>
</form>
</nav>
</header>
<main>
<h2>New task</h2>
<form method="post" action="/tasks">
<input type="hidden" name="csrf_token" value="<csrf>"> <p class="field">
<label for="title">Title</label> <input id="title" name="title" value=""> </p>
<p class="field">
<label for="priority">Priority</label> <select id="priority" name="priority">
<option value="1">1</option>
<option value="2">2</option>
<option value="3" selected>3</option>
<option value="4">4</option>
<option value="5">5</option>
</select> </p>
<p class="field">
<label for="due">Due</label> <input id="due" name="due" type="date" value=""> </p>
<p class="field">
<label for="tags">Tags</label> <input id="tags" name="tags" value=""> </p>
<button type="submit" class="primary">Save</button>
</form>
</main>
</body>
</html>
---

[TestPages_Snapshots/list - 1]
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tasks</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
<h1>
<a href="/">todo</a>
</h1>
<nav>
<a href="/tasks/new">New task</a>
<form method="post" action="/logout">
<input type="hidden" name="csrf_token" value="<csrf>"> <button type="submit">Log out</button>
</form>
</nav>
</header>
<main>
<h2>Your tasks</h2>
<ul class="tasks">
<li class="task">
<span class="status">Todo</span> <span class="title">buy milk</span> <span class="priority">priority 3</span> <span class="due">due 2026-11-01</span> <span class="tags">home</span> <span class="actions">
<form method="post" action="/tasks/<id>/complete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit">Complete</button>
</form>
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
<li class="task">
<span class="status">Todo</span> <span class="title">write the book</span> <span class="priority">priority 5</span> <span class="actions">
<form method="post" action="/tasks/<id>/complete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit">Complete</button>
</form>
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
<li class="task">
<span class="status">Done</span> <span class="title">ship it</span> <span class="priority">priority 3</span> <span class="actions">
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="2"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
<li class="task">
<span class="status">Todo</span> <span class="title">water the plants</span> <span class="priority">priority 3</span> <span class="tags">garden</span> <span class="actions">
<form method="post" action="/tasks/<id>/complete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit">Complete</button>
</form>
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
</ul>
</main>
</body>
</html>
---

[TestPages_Snapshots/form_with_errors - 1]
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New task</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
<h1>
<a href="/">todo</a>
</h1>
<nav>
<a href="/tasks/new">New task</a>
<form method="post" action="/logout">
<input type="hidden" name="csrf_token" value="<csrf>"> <button type="submit">Log out</button>
</form>
</nav>
</header>
<main>
<h2>New task</h2>
<form method="post" action="/tasks">
<input type="hidden" name="csrf_token" value="<csrf>"> <p class="field">
<label for="title">Title</label> <input id="title" name="title" value=""> <span class="error" role="alert">cannot be empty</span>
</p>
<p class="field">
<label for="priority">Priority</label> <select id="priority" name="priority">
<option value="1">1</option>
<option value="2">2</option>
<option value="3">3</option>
<option value="4">4</option>
<option value="5">5</option>
</select> <span class="error" role="alert">must be between 1 and 5</span>
</p>
<p class="field">
<label for="due">Due</label> <input id="due" name="due" type="date" value="next tuesday"> <span class="error" role="alert">unrecognized date &#34;next tuesday&#34;</span>
</p>
<p class="field">
<label for="tags">Tags</label> <input id="tags" name="tags" value="book, go"> </p>
<button type="submit" class="primary">Save</button>
</form>
</main>
</body>
</html>
---

[TestPages_Snapshots/list_with_a_flash - 1]
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tasks</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
<h1>
<a href="/">todo</a>
</h1>
<nav>
<a href="/tasks/new">New task</a>
<form method="post" action="/logout">
<input type="hidden" name="csrf_token" value="<csrf>"> <button type="submit">Log out</button>
</form>
</nav>
</header>
<main>
<p class="flash success" role="status">Task completed.</p>
<h2>Your tasks</h2>
<ul class="tasks">
<li class="task">
<span class="status">Done</span> <span class="title">buy milk</span> <span class="priority">priority 3</span> <span class="due">due 2026-11-01</span> <span class="tags">home</span> <span class="actions">
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="2"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
<li class="task">
<span class="status">Todo</span> <span class="title">write the book</span> <span class="priority">priority 5</span> <span class="actions">
<form method="post" action="/tasks/<id>/complete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit">Complete</button>
</form>
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
<li class="task">
<span class="status">Done</span> <span class="title">ship it</span> <span class="priority">priority 3</span> <span class="actions">
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="2"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
<li class="task">
<span class="status">Todo</span> <span class="title">water the plants</span> <span class="priority">priority 3</span> <span class="tags">garden</span> <span class="actions">
<form method="post" action="/tasks/<id>/complete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit">Complete</button>
</form>
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
</ul>
</main>
</body>
</html>
---

[TestPages_Snapshots/list_after_a_relative_due_date - 1]
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tasks</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<header>
<h1>
<a href="/">todo</a>
</h1>
<nav>
<a href="/tasks/new">New task</a>
<form method="post" action="/logout">
<input type="hidden" name="csrf_token" value="<csrf>"> <button type="submit">Log out</button>
</form>
</nav>
</header>
<main>
<p class="flash success" role="status">Task created.</p>
<h2>Your tasks</h2>
<ul class="tasks">
<li class="task">
<span class="status">Todo</span> <span class="title">call mom</span> <span class="priority">priority 3</span> <span class="due">due 2026-10-16</span> <span class="tags">family</span> <span class="actions">
<form method="post" action="/tasks/<id>/complete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit">Complete</button>
</form>
<a href="/tasks/<id>/edit">Edit</a>
<form method="post" action="/tasks/<id>/delete">
<input type="hidden" name="csrf_token" value="<csrf>"> <input type="hidden" name="version" value="1"> <button type="submit" class="danger">Delete</button>
</form>
</span>
</li>
</ul>
</main>
</body>
</html>
---
````


## `internal/web/assets/app.css`

````css
/* The design system, hand-rolled: no node, no build step, no framework.
   Tokens first — every color, space, and type size the components below
   read is named once in this block — then the components the pages' markup
   already carries classes for. The dark-scheme block at the end is the
   payoff: it overrides the names, and nothing else changes. */

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

/* Base */
*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: var(--font-body);
  font-size: var(--text-base);
  line-height: var(--leading);
  color: var(--color-ink);
  background: var(--color-canvas);
}

h1,
h2 {
  margin: 0 0 var(--space-4);
  line-height: 1.2;
}

h2 {
  font-size: var(--text-xl);
}

a {
  color: var(--color-accent);
}

a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* Page chrome: the header band and the one centered column. */
body > header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  background: var(--color-paper);
  border-bottom: 1px solid var(--color-line);
}

body > header h1 {
  margin: 0;
  font-size: var(--text-lg);
}

body > header h1 a {
  color: inherit;
  text-decoration: none;
}

body > header nav {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

main {
  max-width: 48rem;
  margin: 0 auto;
  padding: var(--space-5) var(--space-4) var(--space-6);
}

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

button:hover {
  color: var(--color-accent);
  border-color: var(--color-accent);
}

button.primary {
  color: var(--color-paper);
  background: var(--color-accent);
  border-color: var(--color-accent);
}

button.primary:hover {
  background: var(--color-accent-strong);
  border-color: var(--color-accent-strong);
}

button.danger:hover {
  color: var(--color-danger-ink);
  border-color: var(--color-danger-ink);
}

/* Forms: one block per field, the label above the input, the error under
   it — the shape form.templ renders. */
.field {
  margin: 0 0 var(--space-4);
}

.field label {
  display: block;
  margin-bottom: var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
}

input,
select {
  width: 100%;
  max-width: 24rem;
  padding: var(--space-2) var(--space-3);
  font: inherit;
  color: inherit;
  background: var(--color-paper);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
}

.error {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  color: var(--color-danger-ink);
}

/* Flash: the one message the previous request left behind. */
.flash {
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid;
  border-radius: var(--radius);
}

.flash.success {
  color: var(--color-success-ink);
  background: var(--color-success-bg);
  border-color: currentColor;
}

.flash.error {
  color: var(--color-danger-ink);
  background: var(--color-danger-bg);
  border-color: currentColor;
}

/* The task list: one card per task, its fields on the first line, its
   actions pushed to the right. */
.tasks {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.task {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-paper);
  border: 1px solid var(--color-line);
  border-radius: var(--radius);
}

.task .status {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-ink-muted);
}

.task .title {
  font-weight: 600;
}

.task .priority,
.task .due,
.task .tags {
  font-size: var(--text-sm);
  color: var(--color-ink-muted);
}

.task .actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.task .actions button {
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-sm);
}

.empty {
  color: var(--color-ink-muted);
}

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
````


## `internal/web/assets/assets.go`

````go
// Package assets is the web surface's static tree: the hand-rolled design
// system's stylesheet, embedded into the binary with go:embed. There is no
// node and no asset pipeline — the embed directive is the whole build step
// — and nothing ships beside the executable: the CSS travels inside it.
//
// The package also computes each file's validator once, at startup. The
// embedded bytes are immutable for the life of the binary, so an entity tag
// is a constant rather than a hash per request; internal/web/static.go is
// the serving policy that reads them.
package assets

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
)

// Files is the embedded tree, rooted at this directory: the stylesheet is
// "app.css" inside it, which is also the name the server resolves a request
// to.
//
//go:embed app.css
var Files embed.FS

// ETags maps each embedded file's path to its entity tag: the quoted,
// truncated hex SHA-256 of the file's bytes. A strong validator, because
// the bytes it names cannot change under it — a build with an edited
// stylesheet is a build with a new tag, which is what lets a cache treat
// the tag as a version. The map is built once, here; the tree is a few
// kilobytes, so the boot cost is one pass over it.
var ETags = entityTags(Files)

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
````


## `internal/web/assets/assets_test.go`

````go
// Package assets is the web surface's embedded static tree: the design
// system's stylesheet, compiled into the binary. The tests are white-box —
// the validator map is package state, and the walk that builds it deserves
// a synthetic tree — while the HTTP half of the contract lives beside the
// mount, in internal/web's assets_test.go.
package assets

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
````


## `internal/web/assets_test.go`

````go
package web_test

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
)

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
		assert.Equal(t, tag, rec.Header().Get("ETag"), "the validator rides the 304")
		assert.Equal(t, assetCacheControl, rec.Header().Get(echo.HeaderCacheControl))
	})

	t.Run("a stale tag serves the file", func(t *testing.T) {
		t.Parallel()

		rec := getIfNoneMatch(t, e, stylesheetPath, `"stale"`)

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, first.Body.String(), rec.Body.String())
	})
}

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
			t.Parallel()

			rec := get(t, e, target)

			require.Equal(t, http.StatusNotFound, rec.Code)
			assert.Equal(t, echo.MIMEApplicationJSON, rec.Header().Get(echo.HeaderContentType))
			assert.JSONEq(t, `{"code":"not_found","message":"Not Found"}`, rec.Body.String())
		})
	}
}

// TestPage_LinksTheDesignSystem pins the other half of the embed: every
// page the layout renders names the stylesheet, and the URL it names is one
// the same server serves. The second request is the point — a link that
// 404s is a broken page — and the URL is read out of the page's own output,
// so the link and the asset cannot drift apart.
func TestPage_LinksTheDesignSystem(t *testing.T) {
	t.Parallel()

	e, _ := newWebAPI(t, store.NewMemoryStore())
	rec := get(t, e, "/login")
	require.Equal(t, http.StatusOK, rec.Code)

	m := stylesheetLink.FindStringSubmatch(rec.Body.String())
	require.Len(t, m, 2, "the layout links its stylesheet")
	assert.Equal(t, stylesheetPath, m[1])

	rec = get(t, e, m[1])
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Header().Get(echo.HeaderContentType), "text/css")
}

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
````


## `internal/web/auth.go`

````go
package web

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"

	"todo/internal/api"
	"todo/internal/auth"
	"todo/internal/web/views"
)

// The login routes: the form an anonymous visitor is redirected to, the post
// that establishes the session, and the logout that ends it. They are the
// web edge's half of chapter 33's auth story — the service, the password
// hashing, and the session store are the same ones the API's routes use —
// and they keep the API's discipline where it matters: the same
// Authenticator checks the password, the same audit trail records the login
// and the logout, and the session carries the same auth.SessionUserID the
// API's login puts there. One session, one identity, whichever edge made it.

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

// Authenticator's implementation is asserted here, not in auth: this package
// imports auth, and the reverse would be a cycle.
var _ Authenticator = (*auth.Service)(nil)

// loginPage answers GET /login: the form, or a redirect when the visitor is
// already signed in — a session that names a user has no business on a login
// form. Rendering the form is what mints the session's CSRF token (see
// page), so this page is where an anonymous session is born.
func (s *Server) loginPage(c echo.Context) error {
	ctx := c.Request().Context()
	if _, ok := api.SessionUser(ctx, s.sessions); ok {
		return c.Redirect(http.StatusSeeOther, "/")
	}
	return render(c, http.StatusOK, views.LoginPage(s.page(ctx), "", ""))
}

// loginSubmit answers POST /login. The two failures have the API's statuses:
// a post missing either credential is the 422 the JSON edge answers a field
// rule with, and a pair that does not match is the 401, rendered with the
// sentinel's own words — the same words the JSON edge puts in message. The
// email travels back into the form; the password never does.
//
// A successful login renews the session before anything is put in it:
// RenewToken deletes the row the presented cookie named and generates a
// fresh token, so a session a visitor fixed before the login cannot ride it
// in. The CSRF secret rotates with the session token — Remove leaves the
// next page render to mint a fresh one (csrfToken mints lazily) — because
// the old secret was minted for the anonymous session the renewal just
// retired. Then the audit event, then the session, in the API's order: a
// login that cannot renew, or cannot reach the trail, is a failed login with
// nothing privileged left behind, and the event is written while the session
// does not yet exist.
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
	if err := s.sessions.RenewToken(ctx); err != nil {
		return err
	}
	if err := s.auth.Record(ctx, auth.AuditEvent{Action: auth.ActionLogin, UserID: user.ID, ActorID: user.ID}); err != nil {
		return err
	}
	s.sessions.Put(ctx, auth.SessionUserID, user.ID.String())
	s.sessions.Remove(ctx, csrfKey)
	s.putFlash(ctx, views.FlashSuccess, "Logged in as "+user.Email+".")
	return c.Redirect(http.StatusSeeOther, "/")
}

// logout answers POST /logout. The trail records the logout before the
// session is destroyed — an event that cannot be written leaves the session
// in place, so the client can retry — and the destroy is followed by a
// flash, which scs writes into a fresh session: Destroy resets the session
// data, so the Put that carries the message starts a new, anonymous session
// — the same one the login page would have minted for its CSRF token — and
// the login page the redirect names shows "Logged out." once.
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
````


## `internal/web/auth_test.go`

````go
package web_test

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/auth"
	"todo/internal/store"
)

// The login page's contract: the form an anonymous visitor is redirected to,
// the post that establishes the session, and the logout that ends it. The
// authenticator is a scripted fake — the real service and its database are
// the API's own cases and the process-level flow's — so these cases pin the
// page's half: what it renders, what it sends to the authenticator, and what
// it puts in the session.

// fakeAuth is the login cases' Authenticator: scripted outcomes, the
// credentials it was handed, and the audit trail it recorded.
type fakeAuth struct {
	user      auth.User
	authErr   error
	recordErr error

	gotEmail    string
	gotPassword string
	records     []auth.AuditEvent
}

// Authenticate records the credentials and returns the scripted outcome.
func (f *fakeAuth) Authenticate(_ context.Context, email, password string) (auth.User, error) {
	f.gotEmail, f.gotPassword = email, password
	if f.authErr != nil {
		return auth.User{}, f.authErr
	}
	return f.user, nil
}

// Record appends the event to the trail the case reads.
func (f *fakeAuth) Record(_ context.Context, e auth.AuditEvent) error {
	if f.recordErr != nil {
		return f.recordErr
	}
	f.records = append(f.records, e)
	return nil
}

// loginForm fetches the login page and returns the session cookie the page's
// response set and the CSRF token it embedded — the two things a browser
// presents back on the post.
func loginForm(t *testing.T, h http.Handler) (*http.Cookie, string) {
	t.Helper()
	rec := get(t, h, "/login")
	require.Equal(t, http.StatusOK, rec.Code)
	cookies := rec.Result().Cookies()
	require.Len(t, cookies, 1, "the login page starts the session its token lives in")
	return cookies[0], csrfFrom(t, rec.Body.String())
}

// TestLoginPage_RendersForm pins the page an anonymous visitor is sent to:
// the form, its two fields, the token, and the session the response starts.
func TestLoginPage_RendersForm(t *testing.T) {
	t.Parallel()

	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), &fakeAuth{})

	rec := get(t, e, "/login")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, echo.MIMETextHTMLCharsetUTF8, rec.Header().Get(echo.HeaderContentType))
	body := rec.Body.String()
	assert.Contains(t, body, "<title>Log in</title>")
	assert.Contains(t, body, `action="/login"`)
	assert.Contains(t, body, `name="email"`)
	assert.Contains(t, body, `name="password"`)
	assert.Contains(t, body, `type="password"`)
	assert.NotEmpty(t, csrfFrom(t, body))
	assert.NotContains(t, body, "Log out", "an anonymous page has no session to end")
}

// TestLoginPage_RedirectsWhenLoggedIn pins the page's other shape: a session
// that already names a user has no business on the login form, so the page
// is a 303 to the list.
func TestLoginPage_RedirectsWhenLoggedIn(t *testing.T) {
	t.Parallel()

	e, sessions := newWebAPIWithAuth(t, store.NewMemoryStore(), &fakeAuth{})

	rec := get(t, e, "/login", testSession(t, sessions))

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))
}

// TestLogin_WrongPassword pins the failure: the sentinel's own words, the
// submitted email kept, the password never rendered back, no session
// established, and no audit event — a failed login records nothing, exactly
// like the JSON edge.
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

// TestLogin_Success pins the whole login: the form's credentials reach the
// authenticator, the trail records the login, the session carries the user,
// and the redirect's target renders the user's tasks with the welcome flash.
func TestLogin_Success(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{user: auth.User{ID: testUserID, Email: "ada@example.com"}}
	st := store.NewMemoryStore()
	seed(t, st, testUserID, "buy milk", nil)
	e, _ := newWebAPIWithAuth(t, st, authn)
	cookie, token := loginForm(t, e)

	rec := postForm(t, e, "/login", url.Values{
		"csrf_token": {token},
		"email":      {"ada@example.com"},
		"password":   {"correct horse battery staple"},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))
	assert.Equal(t, "ada@example.com", authn.gotEmail)
	assert.Equal(t, "correct horse battery staple", authn.gotPassword)
	require.Len(t, authn.records, 1)
	assert.Equal(t, auth.ActionLogin, authn.records[0].Action)
	assert.Equal(t, testUserID, authn.records[0].UserID)

	followed := get(t, e, "/", sessionFrom(t, rec, cookie))
	require.Equal(t, http.StatusOK, followed.Code)
	body := followed.Body.String()
	assert.Contains(t, body, "buy milk")
	assert.Contains(t, body, "Logged in as ada@example.com.")
	assert.Contains(t, body, "Log out")
}

// TestLogin_RecordFailure pins the trail's precedence: a login whose event
// cannot be written is a failed login — 500, no session — because a session
// the trail does not know about is worse than a login the user retries. The
// JSON edge makes the same call in the same order.
func TestLogin_RecordFailure(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{
		user:      auth.User{ID: testUserID, Email: "ada@example.com"},
		recordErr: errors.New("audit trail is away"),
	}
	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), authn)
	cookie, token := loginForm(t, e)

	rec := postForm(t, e, "/login", url.Values{
		"csrf_token": {token},
		"email":      {"ada@example.com"},
		"password":   {"correct horse battery staple"},
	}, cookie)

	require.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.JSONEq(t, `{"code":"internal_error","message":"internal error"}`, rec.Body.String())

	followed := get(t, e, "/", sessionFrom(t, rec, cookie))
	assert.Equal(t, http.StatusSeeOther, followed.Code, "no session was established")
}

// TestLogin_EmptyCredentials pins the form's own shape rule: a post missing
// either half is a 422 — the JSON edge's status for a field that failed its
// rule — and the authenticator is never reached.
func TestLogin_EmptyCredentials(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{}
	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), authn)
	cookie, token := loginForm(t, e)

	rec := postForm(t, e, "/login", url.Values{
		"csrf_token": {token},
		"email":      {""},
		"password":   {"correct horse battery staple"},
	}, cookie)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Contains(t, rec.Body.String(), "email and password are required")
	assert.Empty(t, authn.gotEmail, "the authenticator is never reached")
}

// TestLogout pins the end of the session: the trail records it, the session
// is destroyed, the old cookie no longer opens a page, and the fresh session
// the flash rides says so on the login page.
func TestLogout(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{}
	e, sessions := newWebAPIWithAuth(t, store.NewMemoryStore(), authn)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/", cookie)

	rec := postForm(t, e, "/logout", url.Values{"csrf_token": {token}}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/login", rec.Header().Get(echo.HeaderLocation))
	require.Len(t, authn.records, 1)
	assert.Equal(t, auth.ActionLogout, authn.records[0].Action)
	assert.Equal(t, testUserID, authn.records[0].UserID)

	gone := get(t, e, "/", cookie)
	require.Equal(t, http.StatusSeeOther, gone.Code, "the destroyed session opens nothing")
	assert.Equal(t, "/login", gone.Header().Get(echo.HeaderLocation))

	fresh := sessionFrom(t, rec, cookie)
	page := get(t, e, "/login", fresh)
	require.Equal(t, http.StatusOK, page.Code)
	assert.Contains(t, page.Body.String(), "Logged out.")
}

// TestLogin_RenewsSessionAndCSRFToken pins the fixation fix on the form
// edge: the session token a visitor presents to the login is dead when the
// response returns — the login response's cookie names a different session —
// and the CSRF secret rotates with it, so the next page mints a token the
// pre-login page never carried.
func TestLogin_RenewsSessionAndCSRFToken(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{user: auth.User{ID: testUserID, Email: "ada@example.com"}}
	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), authn)
	cookie, token := loginForm(t, e)

	rec := postForm(t, e, "/login", url.Values{
		"csrf_token": {token},
		"email":      {"ada@example.com"},
		"password":   {"correct horse battery staple"},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	renewed := sessionFrom(t, rec, cookie)
	require.NotEqual(t, cookie.Value, renewed.Value, "the login re-issues the session token")

	// The fixed cookie is dead: it opens no page.
	fixed := get(t, e, "/", cookie)
	require.Equal(t, http.StatusSeeOther, fixed.Code)
	assert.Equal(t, "/login", fixed.Header().Get(echo.HeaderLocation))

	// The renewed cookie opens the list, and the CSRF token the page mints
	// is not the one the fixed session carried.
	page := get(t, e, "/", renewed)
	require.Equal(t, http.StatusOK, page.Code)
	assert.NotEqual(t, token, csrfFrom(t, page.Body.String()), "the CSRF secret rotates with the session")
}
````


## `internal/web/csrf.go`

````go
package web

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"net/http"

	"github.com/labstack/echo/v4"
)

// The form edge's CSRF story, in one place: one token per session, minted on
// the first page that needs it, embedded in every form as a hidden field,
// and compared — in constant time — against the session's value on every
// state-changing post. The design is the synchronizer token pattern, and
// every choice in it is deliberate:
//
//   - The token lives in the session, so it is bound to the cookie the
//     browser already carries. An attacker's page cannot read it (the pages
//     have no JavaScript at all, and the cookie is HttpOnly), cannot guess it
//     (crypto/rand.Text, 130 bits), and cannot make the browser attach a
//     token to a cross-site post (the field's value is the attacker's to
//     choose, and the compare fails).
//   - The compare is subtle.ConstantTimeCompare, so a wrong token leaks
//     nothing about the right one through timing. A missing token and a
//     wrong one are the same refusal — 403, "invalid CSRF token" — because
//     which half failed is the client's business only in the legitimate
//     case, and the legitimate client never sees it.
//   - One token per session, not per form or per page: a second tab and a
//     back button keep working, and the token's lifetime is the session's.
//     The login rotates it together with the session token (see auth.go):
//     both answer the same event, a privilege change, so the pre-login
//     secret cannot outlive the anonymous session it was minted for.
//   - Only the form edge carries tokens. The JSON API's clients are not
//     browsers, and the session cookie is SameSite=Lax — a cross-site form
//     post does not carry it — so the API's CSRF story is the cookie policy.
//     The token is the second lock, and it is what makes the pages' safety a
//     property of the application rather than of every browser's
//     implementation of Lax.

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

// csrf is the middleware every state-changing form post passes through. The
// safe methods — GET, HEAD, OPTIONS — are what a page render is, and they
// carry no token; everything else must present the session's. The submitted
// value is read through echo's FormValue, which parses the urlencoded body
// the pages submit.
//
// The refusal is echo's own 403, so it leaves through the one error handler
// in the one error shape — {"code":"forbidden","message":"invalid CSRF
// token"} — exactly like every other refusal this application makes. No
// handler runs, so nothing is written.
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
````


## `internal/web/csrf_test.go`

````go
package web_test

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
)

// The CSRF contract, from the outside: every state-changing form post must
// present the token the session holds, and a post that does not — or one
// that presents another session's — is refused with the one error shape
// before any handler runs.

// TestCSRF_RefusesPostWithoutToken is the chapter's first failing test: a
// form post with a live session but no token is a 403 in the house shape,
// and nothing reaches the store. The token is what makes the post a request
// the user meant to send; without it, the session cookie alone — which a
// browser attaches to a cross-site post, SameSite's history being what it is
// — must not be enough to write.
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

// TestCSRF_RefusesAnotherSessionsToken pins the compare: both sessions hold
// a token, and the post presents the other one. The answer is the same 403
// as a missing token — the client learns nothing about which half failed —
// and the mismatch is caught by a constant-time compare.
func TestCSRF_RefusesAnotherSessionsToken(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	e, sessions := newWebAPI(t, st)
	mine := testSession(t, sessions)
	other := testSession(t, sessions)

	myToken := csrfToken(t, e, "/tasks/new", mine)
	otherToken := csrfToken(t, e, "/tasks/new", other)
	require.NotEqual(t, myToken, otherToken, "one token per session")

	rec := postForm(t, e, "/tasks", url.Values{
		"csrf_token": {otherToken},
		"title":      {"buy milk"},
	}, mine)

	require.Equal(t, http.StatusForbidden, rec.Code)
	assert.JSONEq(t, `{"code":"forbidden","message":"invalid CSRF token"}`, rec.Body.String())

	tasks, err := st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, tasks)
}

// TestCSRF_EveryFormCarriesTheSessionToken pins the other half: the token is
// per session, and every form the session's pages render embeds it — the
// list's complete, delete, and logout forms, the new-task form, and the edit
// form. The same token on every page is the point of the synchronizer
// pattern: it belongs to the session, not to the page, so a second tab is
// not a second token.
func TestCSRF_EveryFormCarriesTheSessionToken(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	tt := seed(t, st, testUserID, "buy milk", nil)
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)

	token := ""
	for _, target := range []string{"/", "/tasks/new", "/tasks/" + tt.ID.String() + "/edit"} {
		rec := get(t, e, target, cookie)
		require.Equal(t, http.StatusOK, rec.Code, target)

		got := csrfFrom(t, rec.Body.String())
		if token == "" {
			token = got
		}
		assert.Equal(t, token, got, "one token per session, not per page: %s", target)
	}
}

// TestCSRF_LoginFormCarriesTheToken pins the login page's half: the page an
// anonymous visitor sees is the page that starts the session the token lives
// in, so the login post is protected the same way — a login is a
// state-changing request too.
func TestCSRF_LoginFormCarriesTheToken(t *testing.T) {
	t.Parallel()

	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), &fakeAuth{})

	rec := get(t, e, "/login")

	require.Equal(t, http.StatusOK, rec.Code)
	assert.NotEmpty(t, csrfFrom(t, rec.Body.String()))

	// The token lives in the session the page's response set; a post
	// without that cookie cannot present it.
	post := postForm(t, e, "/login", url.Values{
		"email":    {"ada@example.com"},
		"password": {"correct horse battery staple"},
	})
	assert.Equal(t, http.StatusForbidden, post.Code)
}
````


## `internal/web/flash.go`

````go
package web

import (
	"context"
	"encoding/json"

	"todo/internal/web/views"
)

// Flash messages: the feedback PRG's redirect would otherwise lose. A post
// that succeeds cannot answer with the page that says so — the browser would
// re-post on reload — so it redirects, and the message rides the session to
// the page the redirect names. The next render pops it: a flash is shown
// once, then it is gone.
//
// The payload is a JSON string rather than a struct. scs's gob codec
// decodes session values into any, and a concrete struct there would need
// global registration (gob.Register) for a one-shot message; strings are the
// shape the codec handles without ceremony, and JSON is already this
// application's way of spelling structured text. A flash that cannot be
// decoded is dropped, not fatal: a message is a nicety, and a page that
// 500s over one would be the wrong trade.

// flashKey is the session key the flash lives under.
const flashKey = "flash"

// putFlash stores the next page's message. It is called after a write has
// succeeded (or after a classified failure the redirect answers for), and
// before the redirect is returned: the session commit that carries it rides
// the same response.
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
````


## `internal/web/forms_test.go`

````go
package web_test

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/task"
)

// The form edge's contract: create, edit, complete, and delete as form
// posts, POST → redirect → GET, with the same store and the same domain
// rules the JSON edge uses. The redirect's status is 303 — the browser
// follows with a GET — and the flash the next page shows is the redirect's
// feedback.

// TestCreateTask_PRG is the chapter's second failing test: a post with the
// token is a 303 back to the list, and the task — parsed, validated, and
// stored through the same domain constructor the API uses — exists in the
// caller's scope. The follow-up GET shows the flash, and the one after that
// does not: the flash is shown once.
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
	assert.Equal(t, task.Priority(5), tasks[0].Priority)
	assert.Equal(t, time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), tasks[0].Due)
	assert.Equal(t, []string{"book", "go"}, tasks[0].Tags)

	followed := get(t, e, "/", cookie)
	require.Equal(t, http.StatusOK, followed.Code)
	assert.Contains(t, followed.Body.String(), "Task created.")
	assert.Contains(t, followed.Body.String(), "write the chapter")

	again := get(t, e, "/", cookie)
	assert.NotContains(t, again.Body.String(), "Task created.", "the flash is shown once")
}

// TestCreateTask_Validation is the round-trip: a post that breaks the rules
// is re-rendered — 422, the same status the JSON edge answers with — the
// submitted values survive, and the messages are the domain's own. The
// second post, fixed, is the 303 the first one was not.
func TestCreateTask_Validation(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/tasks/new", cookie)

	rec := postForm(t, e, "/tasks", url.Values{
		"csrf_token": {token},
		"title":      {""},
		"priority":   {"9"},
		"due":        {"next tuesday"},
		"tags":       {"book, go"},
	}, cookie)

	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, "cannot be empty", "the title rule is the domain's")
	assert.Contains(t, body, "must be between 1 and 5")
	assert.Contains(t, body, "unrecognized date")
	assert.Contains(t, body, `value="book, go"`, "the submitted values survive the re-render")
	assert.Contains(t, body, `value="next tuesday"`)
	assert.NotEmpty(t, csrfFrom(t, body), "the re-rendered form is submittable")

	tasks, err := st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	assert.Empty(t, tasks, "a rejected form writes nothing")

	rec = postForm(t, e, "/tasks", url.Values{
		"csrf_token": {token},
		"title":      {"write the chapter"},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	tasks, err = st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, "write the chapter", tasks[0].Title)
}

// TestEditTaskPage_RendersValues pins the edit form's read half: the stored
// task's values are in the inputs — the selected priority, the due date, the
// tags — and the hidden version is the snapshot the write must carry back.
func TestEditTaskPage_RendersValues(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	tt := seed(t, st, testUserID, "buy milk", func(t *task.Task) {
		t.Priority = 5
		t.Due = time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
		t.Tags = []string{"errands", "home"}
	})
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)

	rec := get(t, e, "/tasks/"+tt.ID.String()+"/edit", cookie)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, echo.MIMETextHTMLCharsetUTF8, rec.Header().Get(echo.HeaderContentType))
	body := rec.Body.String()
	assert.Contains(t, body, `value="buy milk"`)
	assert.Contains(t, body, `<option value="5" selected>5</option>`)
	assert.Contains(t, body, `value="2026-10-20"`)
	assert.Contains(t, body, `value="errands, home"`)
	assert.Contains(t, body, `name="version" value="1"`)
	assert.Contains(t, body, `action="/tasks/`+tt.ID.String()+`"`)
}

// TestEditTaskPage_ForeignTask pins the scope on the read half: a task
// another user owns is a miss on the form edge exactly as it is on the JSON
// edge — the same 404 shape, not a page that would leak the task's
// existence.
func TestEditTaskPage_ForeignTask(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	foreign := seed(t, st, otherUserID, "another user's task", nil)
	e, sessions := newWebAPI(t, st)

	rec := get(t, e, "/tasks/"+foreign.ID.String()+"/edit", testSession(t, sessions))

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.JSONEq(t, `{"code":"not_found","message":"task not found"}`, rec.Body.String())
}

// TestUpdateTask_PRG pins the write half: the edit form's post replaces the
// editable fields, keeps the status the form never showed, and bumps the
// version through the store's compare-and-swap.
func TestUpdateTask_PRG(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	tt := seed(t, st, testUserID, "buy milk", func(t *task.Task) {
		t.Status = task.StatusDone
		t.Priority = 5
		t.Tags = []string{"errands", "home"}
	})
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/tasks/"+tt.ID.String()+"/edit", cookie)

	rec := postForm(t, e, "/tasks/"+tt.ID.String(), url.Values{
		"csrf_token": {token},
		"version":    {strconv.Itoa(tt.Version)},
		"title":      {"buy oat milk"},
		"priority":   {"2"},
		"due":        {"2026-11-02"},
		"tags":       {"errands"},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))

	stored, err := st.Scoped(testUserID).Get(context.Background(), tt.ID)
	require.NoError(t, err)
	assert.Equal(t, "buy oat milk", stored.Title)
	assert.Equal(t, task.Priority(2), stored.Priority)
	assert.Equal(t, time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC), stored.Due)
	assert.Equal(t, []string{"errands"}, stored.Tags)
	assert.Equal(t, task.StatusDone, stored.Status, "the form never showed the status, so it does not write it")
	assert.Equal(t, tt.Version+1, stored.Version)
}

// TestCompleteTask_PRG pins the one-click verb: a post with the version the
// row rendered moves the task to Done and redirects, and the next page shows
// the new state and the flash.
func TestCompleteTask_PRG(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	tt := seed(t, st, testUserID, "buy milk", nil)
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/", cookie)

	rec := postForm(t, e, "/tasks/"+tt.ID.String()+"/complete", url.Values{
		"csrf_token": {token},
		"version":    {strconv.Itoa(tt.Version)},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))

	stored, err := st.Scoped(testUserID).Get(context.Background(), tt.ID)
	require.NoError(t, err)
	assert.Equal(t, task.StatusDone, stored.Status)

	followed := get(t, e, "/", cookie)
	assert.Contains(t, followed.Body.String(), "Task completed.")
	assert.Contains(t, followed.Body.String(), `<span class="status">Done</span>`)
}

// TestDeleteTask_PRG pins the destructive verb: the post deletes at the
// version the row rendered, redirects, and the flash names it.
func TestDeleteTask_PRG(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	tt := seed(t, st, testUserID, "buy milk", nil)
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/", cookie)

	rec := postForm(t, e, "/tasks/"+tt.ID.String()+"/delete", url.Values{
		"csrf_token": {token},
		"version":    {strconv.Itoa(tt.Version)},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))

	_, err := st.Scoped(testUserID).Get(context.Background(), tt.ID)
	assert.ErrorIs(t, err, store.ErrNotFound)

	followed := get(t, e, "/", cookie)
	assert.Contains(t, followed.Body.String(), "Task deleted.")
	assert.NotContains(t, followed.Body.String(), "buy milk")
}

// TestCompleteTask_StaleVersion pins the compare-and-swap on the form edge:
// the row's version moved on, so the post writes nothing and redirects to
// the list with the sentinel's own words — the same words the JSON edge puts
// in message — as an error flash.
func TestCompleteTask_StaleVersion(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	tt := seed(t, st, testUserID, "buy milk", nil)
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/", cookie)

	// The task moved on since the page was rendered: complete it out of
	// band, through the API's own call.
	require.NoError(t, st.Scoped(testUserID).Complete(context.Background(), tt.ID, tt.Version))

	rec := postForm(t, e, "/tasks/"+tt.ID.String()+"/complete", url.Values{
		"csrf_token": {token},
		"version":    {strconv.Itoa(tt.Version)},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))

	followed := get(t, e, "/", cookie)
	assert.Contains(t, followed.Body.String(), store.ErrConflict.Error())
}

// TestUpdateTask_StaleVersion pins where a conflict on the edit form lands:
// the edit page, re-read, so the user sees the values their post lost
// against — and the flash says why. A 409 body would leave the browser on a
// stale form; the redirect is the form edge's answer.
func TestUpdateTask_StaleVersion(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	tt := seed(t, st, testUserID, "buy milk", nil)
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/tasks/"+tt.ID.String()+"/edit", cookie)

	// Another writer moved the task on.
	updated, err := st.Scoped(testUserID).Update(context.Background(), task.Task{
		ID: tt.ID, Version: tt.Version, Title: "buy oat milk", Status: task.StatusTodo, Priority: 3,
	})
	require.NoError(t, err)
	require.Equal(t, tt.Version+1, updated.Version)

	rec := postForm(t, e, "/tasks/"+tt.ID.String(), url.Values{
		"csrf_token": {token},
		"version":    {strconv.Itoa(tt.Version)},
		"title":      {"buy milk, again"},
		"priority":   {"3"},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	require.Equal(t, "/tasks/"+tt.ID.String()+"/edit", rec.Header().Get(echo.HeaderLocation))

	followed := get(t, e, rec.Header().Get(echo.HeaderLocation), cookie)
	require.Equal(t, http.StatusOK, followed.Code)
	body := followed.Body.String()
	assert.Contains(t, body, store.ErrConflict.Error())
	assert.Contains(t, body, `value="buy oat milk"`, "the form shows the state the post lost against")
	assert.Contains(t, body, `name="version" value="2"`)

	stored, err := st.Scoped(testUserID).Get(context.Background(), tt.ID)
	require.NoError(t, err)
	assert.Equal(t, "buy oat milk", stored.Title, "the stale post wrote nothing")
}

// TestCompleteTask_ForeignTask pins the scope on the write half: another
// user's task is a miss, and the miss reads exactly like a task that does
// not exist — the same flash, no leak of which half was true.
func TestCompleteTask_ForeignTask(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	foreign := seed(t, st, otherUserID, "another user's task", nil)
	e, sessions := newWebAPI(t, st)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/", cookie)

	rec := postForm(t, e, "/tasks/"+foreign.ID.String()+"/complete", url.Values{
		"csrf_token": {token},
		"version":    {strconv.Itoa(foreign.Version)},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)
	assert.Equal(t, "/", rec.Header().Get(echo.HeaderLocation))
	assert.Contains(t, get(t, e, "/", cookie).Body.String(), store.ErrNotFound.Error())

	stored, err := st.Scoped(otherUserID).Get(context.Background(), foreign.ID)
	require.NoError(t, err)
	assert.Equal(t, task.StatusTodo, stored.Status, "a foreign task is untouched")
}

// TestTaskForm_Shapes pins the parsing rules the form edge adds on top of
// the domain's: the priority select's default, a comma-separated tag input
// whose empty segments are typing artifacts, and a due date in the same
// forms the CLI accepts. The pages' clock is the seeded one, so "tomorrow"
// is an exact date rather than a race with midnight — the same seam the
// page goldens render through.
func TestTaskForm_Shapes(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	e, sessions := newWebAPIWithClock(t, st, stubAuth{}, seededClock)
	cookie := testSession(t, sessions)
	token := csrfToken(t, e, "/tasks/new", cookie)

	// seededClock is 2026-10-15 12:00 UTC, so "tomorrow" is the 16th.
	wantDue := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)

	rec := postForm(t, e, "/tasks", url.Values{
		"csrf_token": {token},
		"title":      {"  buy milk  "},
		"due":        {"tomorrow"},
		"tags":       {" errands , , home ,"},
	}, cookie)

	require.Equal(t, http.StatusSeeOther, rec.Code)

	tasks, err := st.Scoped(testUserID).List(context.Background())
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, "buy milk", tasks[0].Title, "the domain constructor trims")
	assert.Equal(t, task.PriorityDefault, tasks[0].Priority, "no priority in the post is the default")
	assert.Equal(t, []string{"errands", "home"}, tasks[0].Tags, "empty segments are dropped")
	assert.Equal(t, wantDue, tasks[0].Due, "tomorrow resolves against the seeded clock")
}
````


## `internal/web/render_bench_test.go`

````go
package web_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"testing"
	"time"

	"todo/internal/task"
	"todo/internal/web/views"
)

// benchPageSize is the task list every measurement renders. A thousand tasks
// is a page large enough that the two write paths differ by more than the
// fixed costs both share; the numbers scale with it, and the shape does not
// change.
const benchPageSize = 1000

// benchBase is the fixed reference date for seeded due dates: the seeding
// helper never reads the clock, so every run renders the same page.
var benchBase = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

// benchTags is the fixed tag pool the seeding helper draws from.
var benchTags = []string{"go", "book", "urgent", "home", "work"}

// benchCtx is the context every render receives. It is never done, so it
// adds no cancellation case to the code under measurement.
var benchCtx = context.Background()

// benchTasks builds the deterministic task list every measurement renders:
// the status cycles between Todo and Done, every other task has a due date,
// most carry tags — the shape internal/store's benchmarks seed, so the page
// both numbers render is one page.
func benchTasks(n int) []task.Task {
	tasks := make([]task.Task, n)
	for i := range tasks {
		t := task.Task{
			Title:    fmt.Sprintf("task-%05d", i),
			Status:   task.StatusTodo,
			Priority: task.PriorityDefault,
		}
		if i%3 == 0 {
			t.Status = task.StatusDone
		}
		if i%2 == 0 {
			t.Due = benchBase.AddDate(0, 0, i%60)
		}
		if i%7 != 0 {
			t.Tags = []string{benchTags[i%len(benchTags)], benchTags[(i+1)%len(benchTags)]}
		}
		tasks[i] = t
	}
	return tasks
}

// benchSink keeps the materialized page reachable, so the compiler cannot
// discard the work that built it.
var benchSink string

// BenchmarkRenderDirect measures the shape the chapter ships: the page
// renders through templ's pooled, fixed-size buffer straight into the
// writer. Peak extra memory is the buffer, not the page.
func BenchmarkRenderDirect(b *testing.B) {
	page := views.IndexPage(benchTasks(benchPageSize), views.Page{CSRFToken: "bench-token"})
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if err := page.Render(benchCtx, io.Discard); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkRenderMaterialized measures the alternative the chapter's memory
// box contrasts: the page is built in a bytes.Buffer first — which grows
// with the page — and then handed on as one string, the shape a
// string-taking write path needs.
func BenchmarkRenderMaterialized(b *testing.B) {
	page := views.IndexPage(benchTasks(benchPageSize), views.Page{CSRFToken: "bench-token"})
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		var buf bytes.Buffer
		if err := page.Render(benchCtx, &buf); err != nil {
			b.Fatal(err)
		}
		s := buf.String()
		if _, err := io.WriteString(io.Discard, s); err != nil {
			b.Fatal(err)
		}
		benchSink = s
	}
}
````


## `internal/web/security_test.go`

````go
// Package web_test — the hardening case the pages own. The login limiter is
// a stack layer (internal/api's, see its ratelimit.go), not a middleware
// either edge mounts, and this case is why: the budget must be one budget
// per source address across the form edge and the JSON edge, so alternating
// between them cannot double an attacker's attempts.
package web_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/auth"
	"todo/internal/store"
)

// TestLoginLimiter_OneBudgetAcrossEdges pins the sharing: five failed form
// logins exhaust the source's budget, and the JSON edge's next attempt is
// refused before its handler runs.
func TestLoginLimiter_OneBudgetAcrossEdges(t *testing.T) {
	t.Parallel()

	authn := &fakeAuth{authErr: auth.ErrInvalidCredentials}
	e, _ := newWebAPIWithAuth(t, store.NewMemoryStore(), authn)
	cookie, token := loginForm(t, e)

	for i := range 5 {
		rec := postForm(t, e, "/login", url.Values{
			"csrf_token": {token},
			"email":      {"ada@example.com"},
			"password":   {"wrong horse"},
		}, cookie)
		require.Equal(t, http.StatusUnauthorized, rec.Code, "attempt %d", i+1)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"ada@example.com","password":"wrong horse"}`))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	require.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.JSONEq(t, `{"code":"too_many_requests","message":"too many login attempts"}`, rec.Body.String())
	assert.Equal(t, "10", rec.Header().Get(echo.HeaderRetryAfter))
}

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
````


## `internal/web/snapshots_test.go`

````go
// Package web_test — the page goldens. Chapter 40's contract is a snapshot
// of every page a browser reads — the login page, the list, the list with
// its flash, the new and edit forms, the form re-rendered with validation
// errors, and the error body a miss leaves — plus a heading-structure smoke
// check. The snapshot cases drive the real stack the way the other page
// cases do, and the values that are random by design — the store-assigned
// ids and the session's CSRF tokens — are normalized out before the golden
// sees them; everything else the page renders is pinned.
package web_test

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gkampitakis/go-snaps/snaps"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/store"
	"todo/internal/task"
)

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

// matchPage matches one rendered page against its golden. Raw serialization
// keeps the file the page itself rather than a Go-quoted string of it.
func matchPage(t *testing.T, body string) {
	t.Helper()
	snaps.WithConfig(snaps.Raw()).MatchSnapshot(t, normalizePage(body))
}

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

// TestPages_Snapshots pins the pages as goldens. Each case drives one
// request — or one POST → redirect → GET flow — through a fresh stack and
// matches the response body against __snapshots__/snapshots_test.snap. The
// first run writes the missing entries and reports each as added: that run
// is the review prompt, not a green light, and under CI go-snaps refuses to
// write at all — a golden must be reviewed and committed by a person.
func TestPages_Snapshots(t *testing.T) {
	t.Parallel()

	t.Run("login", func(t *testing.T) {
		t.Parallel()

		e, _ := newWebAPI(t, store.NewMemoryStore())
		rec := get(t, e, "/login")

		require.Equal(t, http.StatusOK, rec.Code)
		matchPage(t, rec.Body.String())
	})

	t.Run("list", func(t *testing.T) {
		t.Parallel()

		st, _ := pageFixture(t)
		e, sessions := newWebAPI(t, st)
		rec := get(t, e, "/", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		matchPage(t, rec.Body.String())
	})

	t.Run("list with a flash", func(t *testing.T) {
		t.Parallel()

		st, rich := pageFixture(t)
		e, sessions := newWebAPI(t, st)
		cookie := testSession(t, sessions)
		token := csrfToken(t, e, "/", cookie)

		rec := postForm(t, e, "/tasks/"+rich.ID.String()+"/complete", url.Values{
			"csrf_token": {token},
			"version":    {strconv.Itoa(rich.Version)},
		}, cookie)
		require.Equal(t, http.StatusSeeOther, rec.Code)

		followed := get(t, e, "/", sessionFrom(t, rec, cookie))
		require.Equal(t, http.StatusOK, followed.Code)
		matchPage(t, followed.Body.String())
	})

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

	t.Run("new form", func(t *testing.T) {
		t.Parallel()

		e, sessions := newWebAPI(t, store.NewMemoryStore())
		rec := get(t, e, "/tasks/new", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		matchPage(t, rec.Body.String())
	})

	t.Run("edit form", func(t *testing.T) {
		t.Parallel()

		st, rich := pageFixture(t)
		e, sessions := newWebAPI(t, st)
		rec := get(t, e, "/tasks/"+rich.ID.String()+"/edit", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		matchPage(t, rec.Body.String())
	})

	t.Run("form with errors", func(t *testing.T) {
		t.Parallel()

		e, sessions := newWebAPI(t, store.NewMemoryStore())
		cookie := testSession(t, sessions)
		token := csrfToken(t, e, "/tasks/new", cookie)

		rec := postForm(t, e, "/tasks", url.Values{
			"csrf_token": {token},
			"title":      {""},
			"priority":   {"9"},
			"due":        {"next tuesday"},
			"tags":       {"book, go"},
		}, cookie)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		matchPage(t, rec.Body.String())
	})

	t.Run("a miss's error body", func(t *testing.T) {
		t.Parallel()

		e, sessions := newWebAPI(t, store.NewMemoryStore())
		missing := uuid.MustParse("0199cafe-0042-7000-8000-000000000040")
		rec := get(t, e, "/tasks/"+missing.String()+"/edit", testSession(t, sessions))

		require.Equal(t, http.StatusNotFound, rec.Code)
		matchPage(t, rec.Body.String())
	})
}

// headingPattern matches any heading element's opening tag.
var headingPattern = regexp.MustCompile(`<h([1-6])[^>]*>`)

// headingLevels returns the heading levels of a page in document order.
func headingLevels(body string) []int {
	var levels []int
	for _, m := range headingPattern.FindAllStringSubmatch(body, -1) {
		levels = append(levels, int(m[1][0]-'0'))
	}
	return levels
}

// countLevel returns how many of levels sit at the given heading level.
func countLevel(levels []int, level int) int {
	n := 0
	for _, l := range levels {
		if l == level {
			n++
		}
	}
	return n
}

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

// TestPages_Headings is the accessibility smoke check: every page a browser
// reads renders one top-level heading and one section heading, with no level
// skipped. That is the whole claim. Not claimed: contrast, focus order,
// labels, landmarks, keyboard behavior, or anything an automated audit would
// call WCAG conformance — heading structure is the one property a page's
// outline can assert without a browser, and chapter 39's live check is the
// only rendering proof this suite has.
func TestPages_Headings(t *testing.T) {
	t.Parallel()

	t.Run("login", func(t *testing.T) {
		t.Parallel()

		e, _ := newWebAPI(t, store.NewMemoryStore())
		rec := get(t, e, "/login")

		require.Equal(t, http.StatusOK, rec.Code)
		assertHeadings(t, rec.Body.String())
	})

	t.Run("list", func(t *testing.T) {
		t.Parallel()

		st, _ := pageFixture(t)
		e, sessions := newWebAPI(t, st)
		rec := get(t, e, "/", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		assertHeadings(t, rec.Body.String())
	})

	t.Run("new form", func(t *testing.T) {
		t.Parallel()

		e, sessions := newWebAPI(t, store.NewMemoryStore())
		rec := get(t, e, "/tasks/new", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		assertHeadings(t, rec.Body.String())
	})

	t.Run("edit form", func(t *testing.T) {
		t.Parallel()

		st, rich := pageFixture(t)
		e, sessions := newWebAPI(t, st)
		rec := get(t, e, "/tasks/"+rich.ID.String()+"/edit", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		assertHeadings(t, rec.Body.String())
	})

	t.Run("form with errors", func(t *testing.T) {
		t.Parallel()

		e, sessions := newWebAPI(t, store.NewMemoryStore())
		cookie := testSession(t, sessions)
		token := csrfToken(t, e, "/tasks/new", cookie)

		rec := postForm(t, e, "/tasks", url.Values{
			"csrf_token": {token},
			"title":      {""},
			"priority":   {"9"},
			"due":        {"next tuesday"},
		}, cookie)

		require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
		assertHeadings(t, rec.Body.String())
	})
}
````


## `internal/web/static.go`

````go
package web

import (
	"strings"

	"github.com/labstack/echo/v4"

	"todo/internal/web/assets"
)

// The static surface: the embedded design system, served under /static with
// the cache policy in one place.
//
// The policy is revalidation, not fingerprinting. The URL is stable —
// /static/app.css, the path the layout spells — and every response carries
// a strong validator (the embedded bytes' ETag, see assets.ETags) plus
// Cache-Control: no-cache, which tells a cache "store it, but ask before
// reusing it". The 304 that follows is http.ServeContent's, inside echo's
// static handler: with the ETag already on the response, it evaluates
// If-None-Match itself and answers 304 with no body. The alternative —
// fingerprinting, a content hash in the filename with a year-long max-age —
// saves the conditional request but threads generated URLs through every
// view; for one stylesheet, revalidation is the better trade, and the
// stable path is what the layout can link without knowing a hash.
//
// The mount lives in Register (see web.go): echo's StaticFS registers the
// route but takes no middleware, and the policy must run before the file is
// written, so the assets are mounted as a group whose middleware is
// cacheAssets below.
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
````


## `internal/web/tasks.go`

````go
package web

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"todo/internal/store"
	"todo/internal/task"
	"todo/internal/web/views"
)

// The task form routes: the pages that render the forms and the posts that
// submit them. Every post follows POST → redirect → GET — the redirect is a
// 303, so the browser follows with a GET and a reload cannot re-post — and
// the two exceptions are deliberate: a post whose input breaks a rule is
// re-rendered (422, the same status the JSON edge answers a rule with)
// because the user's input must survive, and a post whose id is malformed is
// the house 400. The version hidden field is the store's compare-and-swap on
// this edge, exactly as the JSON body's version is on the other.
//
// The parsing layer is what the form edge adds on top of the domain: the
// browser sends flat strings, and the JSON edge's typed DTOs get their types
// for free from encoding/json. parseTaskForm turns the strings into a
// domain task and collects one message per field that failed, through the
// domain's own rules — task.NewTask for the title, Priority.Valid for the
// priority, ParseDue for the due date — so the edges cannot drift.

// taskFormFrom reads the submitted task form off the request. Every field is
// a string; the typed decisions happen in parseTaskForm.
func taskFormFrom(c echo.Context) views.TaskInput {
	return views.TaskInput{
		Title:    c.FormValue("title"),
		Priority: c.FormValue("priority"),
		Due:      c.FormValue("due"),
		Tags:     c.FormValue("tags"),
		Version:  c.FormValue("version"),
	}
}

// parseTaskForm turns the submitted strings into a domain task, or into one
// message per field that failed. An empty priority is the default — the
// select always sends one, and a post without it means "no preference" — and
// an empty due means no due date.
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

// fieldOf names the field a domain error belongs to, falling back to the
// given name for an error the domain did not shape.
func fieldOf(err error, fallback string) string {
	var invalid task.ValidationError
	if errors.As(err, &invalid) {
		return invalid.Field
	}
	return fallback
}

// messageOf is a domain error's message for the form.
func messageOf(err error) string {
	var invalid task.ValidationError
	if errors.As(err, &invalid) {
		return invalid.Message
	}
	return err.Error()
}

// parseTags splits the form's comma-separated tag input. The JSON edge
// validates a []string and refuses an empty element; the form has one flat
// input, where an empty segment ("a, b,") is a typing artifact rather than a
// tag, so the segments are trimmed and the empty ones dropped. The rule that
// matters is downstream and shared: the store receives a []string with no
// empty element.
func parseTags(s string) []string {
	var tags []string
	for _, tag := range strings.Split(s, ",") {
		if tag = strings.TrimSpace(tag); tag != "" {
			tags = append(tags, tag)
		}
	}
	return tags
}

// taskID parses the :id path parameter. An id that is not a UUID names no
// resource that could exist, so it is a 400 — the request is malformed —
// rather than a 404 that pretends the route was understood. The JSON edge
// makes the same call on the same input.
func taskID(c echo.Context) (uuid.UUID, error) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return uuid.Nil, echo.NewHTTPError(http.StatusBadRequest, "invalid task id")
	}
	return id, nil
}

// taskVersion parses the version the form carried. The hidden field is the
// page's own output, not user input: a missing or unusable one is a
// malformed request — the house 400 — not a validation round-trip, because
// there is no value the user could correct.
func taskVersion(c echo.Context) (int, error) {
	version, err := strconv.Atoi(c.FormValue("version"))
	if err != nil || version < 1 {
		return 0, echo.NewHTTPError(http.StatusBadRequest, "version must be a positive integer")
	}
	return version, nil
}

// storeFailure answers a classified store failure with a redirect: the flash
// carries the sentinel's own text — the same words the JSON edge puts in
// message — and the redirect names the page that shows the state the failure
// left behind: conflictTarget for a stale snapshot (the edit form the
// conflict was about, for an update; the list, for the one-click verbs) and
// the list for a miss, which has no page left to show. A failure the store
// did not classify is not a client-facing condition and returns unchanged,
// to the one error handler.
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

// newTaskPage answers GET /tasks/new: the empty form, with the default
// priority selected.
func (s *Server) newTaskPage(c echo.Context) error {
	form := views.TaskInput{Priority: strconv.Itoa(int(task.PriorityDefault))}
	return render(c, http.StatusOK, views.TaskFormPage("New task", "/tasks", form, s.page(c.Request().Context()), nil))
}

// createTask answers POST /tasks. A post that breaks a rule is re-rendered —
// 422, the values as submitted, one message per field — and one that passes
// is stored through the same domain task the API's create builds, then
// answered with a redirect and the flash the list shows.
func (s *Server) createTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))

	form := taskFormFrom(c)
	t, errs := parseTaskForm(form, s.now())
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

// editTaskPage answers GET /tasks/:id/edit: the stored task as the form's
// submitted shape, with the version the post must carry back. A task the
// caller's scope does not hold is the store's miss, which the error handler
// renders as the same 404 the JSON edge answers — the task's existence is
// not disclosed either way.
func (s *Server) editTaskPage(c echo.Context) error {
	ctx := c.Request().Context()
	id, err := taskID(c)
	if err != nil {
		return err
	}
	t, err := s.store.Scoped(userID(ctx)).Get(ctx, id)
	if err != nil {
		return err
	}
	return render(c, http.StatusOK,
		views.TaskFormPage("Edit task", "/tasks/"+id.String(), editForm(t), s.page(ctx), nil))
}

// editForm renders a stored task as the form's submitted shape: the same
// strings the browser would have sent for these values.
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

// updateTask answers POST /tasks/:id. The stored task is the merge base —
// the form showed the editable fields, not the status, so the status is the
// stored one — and the version the form carried is what the store's
// compare-and-swap compares: a stale snapshot is a conflict, and the
// redirect lands on the edit page, re-read, so the user sees the values
// their post lost against.
func (s *Server) updateTask(c echo.Context) error {
	ctx := c.Request().Context()
	view := s.store.Scoped(userID(ctx))

	id, err := taskID(c)
	if err != nil {
		return err
	}
	version, err := taskVersion(c)
	if err != nil {
		return err
	}
	form := taskFormFrom(c)
	edited, errs := parseTaskForm(form, s.now())
	if len(errs) > 0 {
		return render(c, http.StatusUnprocessableEntity,
			views.TaskFormPage("Edit task", "/tasks/"+id.String(), form, s.page(ctx), errs))
	}

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
}

// completeTask answers POST /tasks/:id/complete: the list's one-click verb,
// a compare-and-swap at the version the row rendered. A stale snapshot or a
// miss redirects to the list with the sentinel's words as an error flash —
// the list is where the task's current state is.
func (s *Server) completeTask(c echo.Context) error {
	ctx := c.Request().Context()
	id, err := taskID(c)
	if err != nil {
		return err
	}
	version, err := taskVersion(c)
	if err != nil {
		return err
	}
	if err := s.store.Scoped(userID(ctx)).Complete(ctx, id, version); err != nil {
		return s.storeFailure(c, err, "/")
	}
	s.putFlash(ctx, views.FlashSuccess, "Task completed.")
	return c.Redirect(http.StatusSeeOther, "/")
}

// deleteTask answers POST /tasks/:id/delete: the same compare-and-swap as
// complete, with the same answers.
func (s *Server) deleteTask(c echo.Context) error {
	ctx := c.Request().Context()
	id, err := taskID(c)
	if err != nil {
		return err
	}
	version, err := taskVersion(c)
	if err != nil {
		return err
	}
	if err := s.store.Scoped(userID(ctx)).Delete(ctx, id, version); err != nil {
		return s.storeFailure(c, err, "/")
	}
	s.putFlash(ctx, views.FlashSuccess, "Task deleted.")
	return c.Redirect(http.StatusSeeOther, "/")
}
````


## `internal/web/testdata/bench/baseline.txt`

````text
goos: linux
goarch: amd64
pkg: todo/internal/web
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
# control-ref: 8787d107f68542231244cd9afe5019dcdc28a55b
BenchmarkRenderDirect-16          	     720	   1651425 ns/op	  493432 B/op	   17755 allocs/op
BenchmarkRenderMaterialized-16    	     460	   2238010 ns/op	 3278794 B/op	   17775 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/web
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkRenderDirect-16          	     679	   1644307 ns/op	  493448 B/op	   17755 allocs/op
BenchmarkRenderMaterialized-16    	     559	   2307470 ns/op	 3278710 B/op	   17774 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/web
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkRenderDirect-16          	     693	   1618444 ns/op	  493436 B/op	   17755 allocs/op
BenchmarkRenderMaterialized-16    	     570	   2211431 ns/op	 3278708 B/op	   17774 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/web
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkRenderDirect-16          	     703	   1545947 ns/op	  493418 B/op	   17755 allocs/op
BenchmarkRenderMaterialized-16    	     421	   2500371 ns/op	 3278815 B/op	   17776 allocs/op
PASS
goos: linux
goarch: amd64
pkg: todo/internal/web
cpu: 12th Gen Intel(R) Core(TM) i5-12500H
BenchmarkRenderDirect-16          	     692	   1606639 ns/op	  493433 B/op	   17755 allocs/op
BenchmarkRenderMaterialized-16    	     536	   2159458 ns/op	 3278755 B/op	   17774 allocs/op
PASS
````


## `internal/web/views/form.templ`

````templ
package views

import (
	"strconv"

	"todo/internal/task"
)

templ TaskFormPage(title string, action string, form TaskInput, page Page, errors map[string]string) {
	@Layout(title, page) {
		<h2>{ title }</h2>
		@TaskForm(action, form, page, errors)
	}
}

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
		<button type="submit" class="primary">Save</button>
	</form>
}
````


## `internal/web/views/layout.templ`

````templ
package views

templ Layout(title string, page Page) {
	<!DOCTYPE html>
	<html lang="en">
		<head>
			<meta charset="utf-8"/>
			<meta name="viewport" content="width=device-width, initial-scale=1"/>
			<title>{ title }</title>
			<link rel="stylesheet" href="/static/app.css"/>
		</head>
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
		</body>
	</html>
}
````


## `internal/web/views/login.templ`

````templ
package views

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
			<button type="submit" class="primary">Log in</button>
		</form>
	}
}
````


## `internal/web/views/tasks.templ`

````templ
package views

import (
	"strconv"
	"strings"

	"todo/internal/task"
)

templ IndexPage(tasks []task.Task, page Page) {
	@Layout("Tasks", page) {
		<h2>Your tasks</h2>
		@TaskList(tasks, page)
	}
}

templ TaskList(tasks []task.Task, page Page) {
	if len(tasks) == 0 {
		<p class="empty">No tasks yet.</p>
	} else {
		<ul class="tasks">
			for _, t := range tasks {
				@TaskRow(t, page)
			}
		</ul>
	}
}

templ TaskRow(t task.Task, page Page) {
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
				<button type="submit" class="danger">Delete</button>
			</form>
		</span>
	</li>
}
````


## `internal/web/views/views.go`

````go
// Package views holds the web surface's templ components and the small view
// models they render. The components are plain functions of their data —
// Page, Flash, and TaskInput are values the handlers build and hand in — and
// templ's auto-escaping is what makes every expression user data rather than
// markup.
package views

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

// The flash kinds.
const (
	// FlashSuccess reports a write that happened.
	FlashSuccess = "success"
	// FlashError reports a write that did not, in the store's own words.
	FlashError = "error"
)

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
````


## `internal/web/web.go`

````go
// Package web is the application's server-rendered surface: the MPA pages a
// browser reads, built with templ and served by the same echo instance that
// serves the JSON API. The pages render straight to the response writer —
// templ writes through a pooled, fixed-size buffer, so the whole page is
// never a []byte or a string in this process — and they are the form edge of
// the application: create, edit, complete, and delete are HTML forms whose
// posts follow POST → redirect → GET, each carrying a CSRF token the session
// holds (see csrf.go), and whose redirects carry flash messages the next
// page shows once (see flash.go). The login form (see auth.go) is the page
// an anonymous visitor is sent to: the gate below redirects where the JSON
// edge's 401 refuses.
//
// One store, two edges. The handlers scope the store to the session's user
// exactly as the API's do — s.store.Scoped(id), with the scope in the
// queries — and they validate through the same domain constructors:
// task.NewTask trims and checks the title, task.Priority.Valid bounds the
// priority, task.ParseDue parses the due date, so the form edge cannot store
// a task the CLI or the API would refuse. What the edges do differently is
// their input's shape and their failure's shape: the JSON edge decodes typed
// DTOs and answers one JSON error object, while the form edge parses flat
// strings (see tasks.go) and answers a re-rendered form or a redirect with a
// flash. The classifications underneath — 422 for a rule, 409 for a stale
// version, 404 for a miss — are the same classifications.
//
// The surface is mounted by its caller, not by internal/api: cmd/todo-server
// builds the API instance and then registers the pages on it, and the tests
// compose the two the same way. That is what keeps the API's route table —
// and the OpenAPI spec's coverage check, which walks it — free of page
// routes that are not API operations.
package web

import (
	"context"
	"net/http"
	"time"

	"github.com/a-h/templ"
	"github.com/alexedwards/scs/v2"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"todo/internal/api"
	"todo/internal/store"
	"todo/internal/web/assets"
	"todo/internal/web/views"
)

// Server is the web surface: the pages' handlers and the dependencies they
// read. New builds it; Register mounts it on the instance its caller
// already built and configured.
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

// New builds the web surface around the store, the authenticator, the
// session manager, and the clock. The store is the unscoped one: each
// request scopes its own view to the authenticated user, exactly as the
// API's handlers do. The authenticator is the same service the API's auth
// routes use — one password check, one audit trail — and the session
// manager is the same manager: one cookie, one session, one login. The
// clock is the reference the form edge resolves relative due dates against
// ("today", "tomorrow" — see task.ParseDue): production passes time.Now,
// and the deterministic cases seed it.
func New(st store.Store, authn Authenticator, sessions *scs.SessionManager, now func() time.Time) *Server {
	return &Server{store: st, auth: authn, sessions: sessions, now: now}
}

// Register mounts the pages on e. The login routes are open — they are how
// an anonymous visitor becomes a user — and every other page sits behind the
// gate: the page's own route for GET /, and the /tasks group for the form
// routes. A group is safe here because its prefix is not empty: the
// catch-all entries echo registers for it stay inside /tasks, where the gate
// belongs, so an unknown path under /tasks is a redirect for an anonymous
// visitor and the stack's 404 for a logged-in one. Chapter 36's mount put
// the gate on the page's own route because a group with an empty prefix
// would have claimed the whole root namespace; this group does not.
//
// The CSRF middleware rides every POST route and skips the safe methods (see
// csrf.go); it sits after the gate in each list, so an anonymous post is a
// redirect to the login page before its token is ever considered. The login
// post is also the form edge's half of the stack's login limiter (see
// internal/api's ratelimit.go): the budget is per source address and shared
// with the JSON edge, which is why the limiter is a stack layer and not a
// middleware mounted here. The pages are registered after the stack is
// installed, and echo applies the instance's middleware at request time, so
// every page request rides the same ids, records, deadlines, headers, and
// session load as the API's.
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

// requireUser is the pages' gate. The identity rule is api.SessionUser —
// the same rule RequireUser, the JSON edge's gate, builds on — and the
// refusal is where the edges part: a request without a live session is a 303
// to the login page, because a browser's answer to "log in" is a form, while
// an API client's is a 401. The id the gate checked travels in the request's
// context (web's own key, below), so a handler cannot re-read a session that
// changed under it and cannot mistake "no user" for the zero id.
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

// userKey is the request context's key for the id the gate checked. It is a
// struct type rather than a string so it cannot collide with a key another
// package sets, and it is web's own — internal/api's key is that package's
// contract, and its RequireUser stays its only setter.
type userKey struct{}

// withUser returns a copy of ctx carrying the authenticated user's id.
// requireUser is the only setter.
func withUser(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, userKey{}, id)
}

// userID returns the authenticated user's id for a handler behind the gate.
// A handler that reaches it without requireUser is a wiring bug, and the
// panic says so: the stack's Recover answers it with a 500, which is what a
// bug gets.
func userID(ctx context.Context) uuid.UUID {
	id, ok := userFrom(ctx)
	if !ok {
		panic("web: page handler reached without the gate")
	}
	return id
}

// userFrom returns the id the gate put in ctx, and whether it was there at
// all. The second return is what keeps "no user" from being mistaken for the
// zero id: uuid.Nil is a real scope — the user-less one — so a helper that
// answered the zero value for an anonymous request would silently serve the
// wrong rows.
func userFrom(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(userKey{}).(uuid.UUID)
	return id, ok
}

// page assembles the data every page render shares: the session's CSRF
// token, minted on first use so a page that carries a form can always be
// submitted; the flash the previous request left, popped so it is shown
// once; and whether the request carries a user, which is what the header's
// logout form needs. The login page calls it too — it is the page that mints
// the first token, and so the page where an anonymous session is born.
func (s *Server) page(ctx context.Context) views.Page {
	_, authenticated := userFrom(ctx)
	return views.Page{
		CSRFToken:     s.csrfToken(ctx),
		Flash:         s.popFlash(ctx),
		Authenticated: authenticated,
	}
}

// render writes an HTML page: the content type first, then the status, then
// the component through echo's Response — the render target chapter 36's
// live capture fixed, which is what lets the request record name the status
// the client received. The status is explicit because the pages have two
// answers to a form: 200 for a page, and 422 for the re-render of a form
// whose post broke a rule.
func render(c echo.Context, status int, component templ.Component) error {
	c.Response().Header().Set(echo.HeaderContentType, echo.MIMETextHTMLCharsetUTF8)
	c.Response().WriteHeader(status)
	return component.Render(c.Request().Context(), c.Response())
}

// index answers GET /: the authenticated user's tasks, rendered as HTML. The
// store view is scoped to the session's user before anything is read — the
// page cannot show a foreign task, because the query cannot return one.
func (s *Server) index(c echo.Context) error {
	ctx := c.Request().Context()
	tasks, err := s.store.Scoped(userID(ctx)).List(ctx)
	if err != nil {
		return err
	}
	return render(c, http.StatusOK, views.IndexPage(tasks, s.page(ctx)))
}
````


## `internal/web/web_test.go`

````go
// Package web_test drives the server-rendered pages through the real stack:
// echo, the middleware stack, the session layer, and the store, composed the
// way cmd/todo-server composes them — api.New builds the instance and the
// web surface mounts onto it. The contract is what a browser sees: the
// status, the content type, the Location of a redirect, and the markup.
package web_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/alexedwards/scs/v2/memstore"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"

	"todo/internal/api"
	"todo/internal/auth"
	"todo/internal/store"
	"todo/internal/task"
	"todo/internal/telemetry"
	"todo/internal/web"
)

// stubAuth is the web cases' Authenticator for the cases that never touch
// the auth routes: every method panics, so a page case that reached auth
// would fail loudly instead of quietly authenticating someone. The login
// cases use fakeAuth instead.
type stubAuth struct{}

// Register panics: no case that uses stubAuth registers users.
func (stubAuth) Register(context.Context, string, string) (auth.User, error) {
	panic("stubAuth.Register called")
}

// Authenticate panics: no case that uses stubAuth logs in.
func (stubAuth) Authenticate(context.Context, string, string) (auth.User, error) {
	panic("stubAuth.Authenticate called")
}

func (stubAuth) UserByID(context.Context, uuid.UUID) (auth.User, error) {
	panic("stubAuth.UserByID called")
}

// Record panics: no case that uses stubAuth audits anything.
func (stubAuth) Record(context.Context, auth.AuditEvent) error {
	panic("stubAuth.Record called")
}

// testUserID is the fixed user the page cases act as — the same
// v7-shaped UUID api_test uses for its own fixed user, one chapter later.
// otherUserID is the second identity the scoping cases need: a task it owns
// must not appear on the first user's page, and its id must be a miss on the
// first user's forms.
var (
	testUserID  = uuid.MustParse("0199cafe-0042-7000-8000-000000000036")
	otherUserID = uuid.MustParse("0199cafe-0042-7000-8000-000000000037")
)

// newWebAPI builds the server the way cmd/todo-server does: api.New installs
// the middleware stack and the API routes, and the web surface mounts onto
// the same instance, so a page request rides the same ids, records,
// deadlines, headers, and session load as an API request. The session
// manager is the production one over scs's in-memory store — the cookie
// policy under test is the one production uses — and the authenticator is
// the panicking stub: the cases that never log in.
func newWebAPI(t *testing.T, st store.Store) (*echo.Echo, *scs.SessionManager) {
	t.Helper()
	return newWebAPIWithAuth(t, st, stubAuth{})
}

// newWebAPIWithAuth is newWebAPI with the web surface's authenticator chosen
// by the caller: the login cases hand it a scripted fake. The pages' clock is
// the wall clock; the deterministic cases pick their own through
// newWebAPIWithClock.
func newWebAPIWithAuth(t *testing.T, st store.Store, authn web.Authenticator) (*echo.Echo, *scs.SessionManager) {
	t.Helper()
	return newWebAPIWithClock(t, st, authn, time.Now)
}

// newWebAPIWithClock is newWebAPIWithAuth with the pages' clock chosen by the
// caller: the deterministic cases seed it, so a form post that says
// "tomorrow" renders a fixed date and the golden pins it.
func newWebAPIWithClock(t *testing.T, st store.Store, authn web.Authenticator, now func() time.Time) (*echo.Echo, *scs.SessionManager) {
	t.Helper()
	sessions := api.NewSessionManager(memstore.New())
	e := api.New(st, stubAuth{}, sessions, slog.New(slog.DiscardHandler),
		otel.GetTracerProvider(), telemetry.NewRegistry())
	web.New(st, authn, sessions, now).Register(e)
	return e, sessions
}

// seededClock is the pages' clock in the deterministic cases: a fixed
// instant, so a relative due date ("tomorrow") renders the same date on
// every run. Production passes time.Now (see cmd/todo-server).
func seededClock() time.Time {
	return time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
}

// testSession mints a committed session for the fixed test user and returns
// the cookie that presents it. It goes through the manager's own Load and
// Commit — the two halves LoadAndSave drives — instead of a login route, so
// no request is logged and no password is hashed: the page cases are about
// what the page renders, not about how a session comes to exist. The session
// carries no CSRF token; a case that needs one fetches a page, which mints
// it, exactly as a browser would.
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

// seed adds a task through one user's store view — the way the API's
// handlers write — and returns the stored task. The title goes through the
// domain constructor, so the seed cannot store a task the application would
// refuse.
func seed(t *testing.T, st store.Store, owner uuid.UUID, title string, mutate func(*task.Task)) task.Task {
	t.Helper()
	tt, err := task.NewTask(title)
	require.NoError(t, err)
	if mutate != nil {
		mutate(&tt)
	}
	stored, err := st.Scoped(owner).Add(context.Background(), tt)
	require.NoError(t, err)
	return stored
}

// get drives one request through the handler without a socket, presenting
// the given cookies, and returns the recorded response.
func get(t *testing.T, h http.Handler, target string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// postForm drives one urlencoded form post through the handler, presenting
// the given cookies, and returns the recorded response. It is the shape
// every form on the pages submits.
func postForm(t *testing.T, h http.Handler, target string, values url.Values, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, target, strings.NewReader(values.Encode()))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationForm)
	for _, cookie := range cookies {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// csrfField matches the hidden input every form carries. templ renders
// attributes in source order, so the name comes before the value.
var csrfField = regexp.MustCompile(`name="csrf_token" value="([^"]+)"`)

// csrfFrom extracts the first CSRF token a page carries. A page with no
// token fails here: every form is supposed to have one.
func csrfFrom(t *testing.T, body string) string {
	t.Helper()
	m := csrfField.FindStringSubmatch(body)
	require.Len(t, m, 2, "the page carries a CSRF token field")
	require.NotEmpty(t, m[1])
	return m[1]
}

// csrfToken fetches a page and returns the token it embedded — the way a
// browser gets one: render the form, read the hidden field, submit it back.
func csrfToken(t *testing.T, h http.Handler, target string, cookies ...*http.Cookie) string {
	t.Helper()
	rec := get(t, h, target, cookies...)
	require.Equal(t, http.StatusOK, rec.Code, "the form page renders")
	return csrfFrom(t, rec.Body.String())
}

// sessionFrom returns the session cookie a response set, falling back to the
// one presented: scs re-sets the cookie whenever it commits a modified
// session, and the newest value is the one a browser would send next.
func sessionFrom(t *testing.T, rec *httptest.ResponseRecorder, presented *http.Cookie) *http.Cookie {
	t.Helper()
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == presented.Name && cookie.Value != "" {
			return cookie
		}
	}
	return presented
}

// captureLogger returns a logger that writes JSON records into a buffer —
// the machine shape the file sink keeps — and the buffer they land in.
func captureLogger() (*slog.Logger, *bytes.Buffer) {
	buf := new(bytes.Buffer)
	return slog.New(slog.NewJSONHandler(buf, nil)), buf
}

// requestLogRecord is the request record's fields the page case reads.
type requestLogRecord struct {
	Msg    string `json:"msg"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Status int    `json:"status"`
}

// requestRecord decodes the one record the request logger wrote. The writes
// are synchronous — the middleware logs inside the request's goroutine — so
// no lock is needed.
func requestRecord(t *testing.T, buf *bytes.Buffer) requestLogRecord {
	t.Helper()
	var record requestLogRecord
	require.NoError(t, json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &record), "one request record")
	require.Equal(t, "request", record.Msg)
	return record
}

// TestIndexPage_RendersTasks is chapter 36's first failing test, still the
// page's contract: GET / is the logged-in user's task list, rendered by
// templ. The subtests pin the page's three shapes — tasks with their fields,
// the escaping rule, and the empty list — and the scoping the page inherits
// from chapter 34.
func TestIndexPage_RendersTasks(t *testing.T) {
	t.Parallel()

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
		assert.Contains(t, body, `href="/tasks/new"`, "the header offers the new-task form")
	})

	t.Run("a task title's markup renders inert", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		seed(t, st, testUserID, `<script>alert("xss")</script>`, nil)

		e, sessions := newWebAPI(t, st)
		rec := get(t, e, "/", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		body := rec.Body.String()
		assert.NotContains(t, body, `<script>alert("xss")</script>`, "a title is data, never markup")
		assert.Contains(t, body, `&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt;`)
	})

	t.Run("a user with no tasks gets the empty state", func(t *testing.T) {
		t.Parallel()

		st := store.NewMemoryStore()
		seed(t, st, otherUserID, "another user's task", nil)

		e, sessions := newWebAPI(t, st)
		rec := get(t, e, "/", testSession(t, sessions))

		require.Equal(t, http.StatusOK, rec.Code)
		assert.Contains(t, rec.Body.String(), "No tasks yet.")
	})
}

// TestIndexPage_RowActions pins the list's action surface: every row carries
// the complete (Todo tasks only), edit, and delete controls, and the
// destructive and completing forms carry the version the page rendered —
// the store's compare-and-swap on the form edge.
func TestIndexPage_RowActions(t *testing.T) {
	t.Parallel()

	st := store.NewMemoryStore()
	todo := seed(t, st, testUserID, "buy milk", nil)
	done := seed(t, st, testUserID, "write the chapter", func(tt *task.Task) {
		tt.Status = task.StatusDone
	})

	e, sessions := newWebAPI(t, st)
	rec := get(t, e, "/", testSession(t, sessions))

	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, `action="/tasks/`+todo.ID.String()+`/complete"`)
	assert.Contains(t, body, `action="/tasks/`+todo.ID.String()+`/delete"`)
	assert.Contains(t, body, `href="/tasks/`+todo.ID.String()+`/edit"`)
	assert.Contains(t, body, `action="/tasks/`+done.ID.String()+`/delete"`)
	assert.NotContains(t, body, `action="/tasks/`+done.ID.String()+`/complete"`,
		"a done task has nothing left to complete")
	assert.Contains(t, body, `name="version" value="1"`)
	assert.Contains(t, body, `action="/logout"`, "the header's logout form rides every page")
}

// TestIndexPage_RequestRecord pins the page's half of the stack contract:
// the request record names the status the client received. Rendering
// straight to the response's Writer bypasses echo's Response — which is what
// tracks the status and the committed flag — and every page record read
// status 0 until the live capture found it; this case is that finding's
// regression.
func TestIndexPage_RequestRecord(t *testing.T) {
	t.Parallel()

	logger, buf := captureLogger()
	st := store.NewMemoryStore()
	sessions := api.NewSessionManager(memstore.New())
	e := api.New(st, stubAuth{}, sessions, logger,
		otel.GetTracerProvider(), telemetry.NewRegistry())
	web.New(st, stubAuth{}, sessions, time.Now).Register(e)

	rec := get(t, e, "/", testSession(t, sessions))

	require.Equal(t, http.StatusOK, rec.Code)
	record := requestRecord(t, buf)
	assert.Equal(t, http.StatusOK, record.Status, "the record names the status the client received")
	assert.Equal(t, "/", record.Path)
	assert.Equal(t, http.MethodGet, record.Method)
}

// TestWebMount_LeavesOtherPathsAlone pins the mount's blast radius: the
// pages' gate rides their own routes — and, from this chapter, the /tasks
// group, whose catch-alls stay inside the pages' namespace — so a path the
// web surface does not own keeps the stack's own answers: an anonymous POST
// /healthz is still the method-not-allowed, and an unknown path is still a
// 404. A gated group with an empty prefix would register echo's catch-all
// entries for the whole root namespace, and both answers would become the
// gate's redirect.
func TestWebMount_LeavesOtherPathsAlone(t *testing.T) {
	t.Parallel()

	e, sessions := newWebAPI(t, store.NewMemoryStore())

	post := httptest.NewRequest(http.MethodPost, "/healthz", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, post)
	assert.Equal(t, http.StatusMethodNotAllowed, rec.Code)

	assert.Equal(t, http.StatusNotFound, get(t, e, "/nope").Code)

	// The pages' own namespace is the one place the catch-alls are wanted:
	// an unknown path under /tasks rides the gate, so an anonymous visitor
	// is sent to log in, and a logged-in one meets the stack's 404.
	anonymous := get(t, e, "/tasks/nope")
	assert.Equal(t, http.StatusSeeOther, anonymous.Code)
	assert.Equal(t, "/login", anonymous.Header().Get(echo.HeaderLocation))

	loggedIn := get(t, e, "/tasks/nope", testSession(t, sessions))
	assert.Equal(t, http.StatusNotFound, loggedIn.Code)
}

// TestPageGate_RedirectsAnonymous replaces chapter 36's 401 seam: an
// anonymous request for a task page is a 303 to the login page — the same
// condition the JSON edge refuses with its 401, answered the way a browser
// can act on. The redirect is the seam chapter 36's notes left open.
func TestPageGate_RedirectsAnonymous(t *testing.T) {
	t.Parallel()

	e, sessions := newWebAPI(t, store.NewMemoryStore())

	for name, cookies := range map[string][]*http.Cookie{
		"no cookie": nil,
		// The forged cookie carries the production name and flags: a forged
		// token travels the way a genuine one would.
		"a forged cookie": {{
			Name:     sessions.Cookie.Name,
			Value:    "not-a-real-token",
			Path:     "/",
			Secure:   true,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			for _, target := range []string{"/", "/tasks/new"} {
				rec := get(t, e, target, cookies...)

				require.Equal(t, http.StatusSeeOther, rec.Code, target)
				assert.Equal(t, "/login", rec.Header().Get(echo.HeaderLocation), target)
			}
		})
	}
}
````
