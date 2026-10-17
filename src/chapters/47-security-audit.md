---
title: The security audit
day: 56
time: "3 hours"
description: Walk through the app asking how it could be abused, then write the checks that keep the answers honest.
sidebar:
  order: 47
---

The app now holds things that matter: task lists, a password, a session cookie, and the key that opens the admin account. Before anyone trusts it with a real list, it gets what every serious product gets: a security review.

A **security review** is a walk through the app with one question at every stop: how could this be abused? Not "is the code pretty" — "if a stranger wanted to read someone else's tasks, guess a password, or slip in code of their own, where would they try?" The places to ask are the places the app meets the outside world: the network door, the password and the session, the database file, the operator's key, and the code we did not write — the packages other people wrote that our app runs.

The review has two halves. One is a document a person writes: what the app protects, who can reach it, and what stops them. The other is a set of checks a computer runs, so a promise made today cannot quietly become false tomorrow.

By the end, a new package's tests will refuse an undocumented dependency and an unexplained exception, the project will carry a written inventory of everything it is built from, a scanner will check that inventory for known bugs, and the review itself will live in `docs/threat-model.md`.

## The tests come first

The checks live in a new package, `internal/audit`. Nothing in the app calls it while running, and that is the design: a package the app never imports cannot slow it down, while its tests run with every `go test ./...`. Each test is a policy — a fact about the project that fails loudly the moment it stops being true.

Three test files, one per policy. `deps_test.go` guards the dependency list; `suppressions_test.go` guards the exceptions the security linter is allowed to ignore; `sbom_test.go` guards the inventory. The finished app's appendix holds all six files in full, and the pieces quoted here are the ones that carry the idea.

The first file's heart is the test a new, undocumented dependency fails. A **dependency** is a package written by someone else that our code calls — code we did not write, running inside our app.

<!-- verify: internal/audit/deps_test.go at=audit -->
```go title="internal/audit/deps_test.go"
// repoFile reads a file at the ... root. The package's tests run with
// the working directory set to the package, so the root is two levels up;
// reading the ... own documents — go.mod, docs/sbom.cdx.json — is
// what makes these tests the audit rather than a fixture exercise.
func repoFile(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", filepath.FromSlash(name)))
	require.NoError(t, err)
	return data
}
...
// TestDependenciesAreAllowlisted is the audit's gate on the module: every
// direct requirement of go.mod must be on the allowlist, with its reason.
// This is the test a rogue direct dependency fails — the red the chapter
// shows first — and the failure names the module, so the fix is one edit:
// the allowlist entry, or the removal of the requirement.
func TestDependenciesAreAllowlisted(t *testing.T) {
	t.Parallel()

	mods, err := audit.Requires(repoFile(t, "go.mod"))
	require.NoError(t, err)

	unlisted := audit.Unlisted(audit.Direct(mods), audit.Allowlist)
	assert.Empty(t, unlisted,
		"direct requirements with no allowlist entry: add each to internal/audit's Allowlist with its reason, or remove it from go.mod")
}
```

The helper is how a test reads the project's own files: while a test runs, the working folder is the package's folder, so `..` twice lands at the root. The test itself is the policy in one function: read `go.mod`, keep the direct requirements, and refuse any the allowlist does not name. The failure message is the fix — add the entry with its reason, or remove the dependency.

The same file asks the question backwards: an entry for a dependency the project no longer has. And one more case refuses an entry whose reason is empty.

The second file's subject is the **suppression**: a note to the security linter that a flagged pattern is fine at this one call site. The linter recognizes the note when a comment begins with `#nosec`, and the policy is that every such note carries its reason after `--`. The fixture below is that recognition rule made concrete — eight little files, three suppressions.

<!-- verify: internal/audit/suppressions_test.go at=audit -->
```go title="internal/audit/suppressions_test.go"
	fsys := fstest.MapFS{
		"a.go":         {Data: []byte("package a\n\nvar _ = 1 // #nosec G404 -- deterministic test data\n")},
		"b.go":         {Data: []byte("package b\n\nvar _ = 2 // #nosec G204\n")},
		"block.go":     {Data: []byte("package block\n\n/* #nosec G304 -- the block form is a directive too */\nvar _ = 3\n")},
		"prose.go":     {Data: []byte("package prose\n\n// The #nosec directive mid-sentence is prose, not a suppression.\nvar _ = 4\n")},
		"literal.go":   {Data: []byte("package literal\n\nvar _ = \"// #nosec G204 -- inside a string\"\n")},
		"gen.go":       {Data: []byte("// Code generated by tool. DO NOT EDIT.\n\npackage gen\n\nvar _ = 5 // #nosec G204\n")},
		"note.md":      {Data: []byte("#nosec G204\n")},
		".hidden/c.go": {Data: []byte("package c\n\nvar _ = 6 // #nosec G204\n")},
	}

	got, err := audit.Suppressions(fsys)
	require.NoError(t, err)
	assert.Equal(t, []audit.Suppression{
		{File: "a.go", Line: 3, Reason: "deterministic test data"},
		{File: "b.go", Line: 3},
		{File: "block.go", Line: 3, Reason: "the block form is a directive too"},
	}, got)
```

Read the three that come back: a directive with a reason, a directive without one — the `Reason` is empty, and the caller decides what that means — and the block-comment form. The mentions, mid-sentence in prose and inside a string, are not directives; the generated file and the hidden folder are skipped.

The third file guards the inventory. A **bill of materials** is the list of everything the app is built from, like an ingredients label. Ours is a machine-readable document, `docs/sbom.cdx.json`, and the test checks it against `go.mod` in both directions: every requirement named in the document, and every module in the document still a requirement.

<!-- verify: internal/audit/sbom_test.go at=audit -->
```go title="internal/audit/sbom_test.go"
// readSBOM reads the ... bill of materials. It reads the file whole
// rather than opening it, so the test has no descriptor to close and the
// failure names the fix: `make sbom`.
func readSBOM(t *testing.T) audit.SBOM {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "sbom.cdx.json"))
	require.NoError(t, err, "docs/sbom.cdx.json is ...; run `make sbom` to write it")
	sbom, err := audit.ReadSBOM(bytes.NewReader(data))
	require.NoError(t, err)
	return sbom
}
```

The first direction walks every requirement and asks the document to name it at the pinned version; the second walks the document and asks `go.mod` to still require each module.

<!-- verify: internal/audit/sbom_test.go at=audit -->
```go title="internal/audit/sbom_test.go"
	inDocument := map[string]bool{}
	for _, m := range named {
		inDocument[m.Path+"@"+m.Version] = true
	}
	for _, m := range mods {
		assert.True(t, inDocument[m.Path+"@"+m.Version],
			"%s@%s is required by go.mod but missing from docs/sbom.cdx.json; run `make sbom`", m.Path, m.Version)
	}
```

Now run the tests, before the package has any code in it.

```bash
$ go test -count=1 ./...
todo/internal/audit: no non-test Go files in …/internal/audit
ok  	todo/cmd/todo	2.451s
ok  	todo/cmd/todo-server	2.693s
?   	todo/cmd/todo-tui	[no test files]
ok  	todo/internal/api	1.153s
?   	todo/internal/api/docs	[no test files]
FAIL	todo/internal/audit [build failed]
ok  	todo/internal/auth	1.129s
...
FAIL
```

Read the first and the middle lines together: the folder holds tests but no code a build can use, so the package fails to build. Every other package stays as it was — this lesson adds checks, it does not move the app.

:::note
The red here is a build failure, not a failed assertion: a folder with tests and no regular Go files is not a package yet. It is still the right first step — the tests are the contract the code must satisfy.
:::

## A reader for `go.mod`

The first policy needs a reader: something that turns `go.mod` — the file that lists the project's dependencies — into values a test can compare. `internal/audit/deps.go` opens by saying what the package is, and defines the value a requirement becomes.

<!-- verify: internal/audit/deps.go at=audit -->
```go title="internal/audit/deps.go"
// Package audit holds the ... supply-chain checks: the readers for
// the two documents the audit trusts — go.mod and the ... CycloneDX
// bill of materials — and the policies they are checked against: the
// dependency allowlist every direct requirement must be on, and the rule
// that every `#nosec` suppression carries its reason.
//
// Nothing at runtime imports this package. Its tests are the gate — they run
// with `go test ./...`, which is what makes each policy a fact about the
// ... rather than a paragraph in a document — and the failing test is
// the red the chapter shows first: a rogue direct dependency, a suppression
// without a reason, a bill of materials that drifted from go.mod.
package audit
```

A **requirement** is one entry in that list: a dependency, with the exact version the project will use. The `// indirect` marker in a requirement's comment means the project does not call that module itself: it arrived because something else does. The allowlist is about the direct ones.

<!-- verify: internal/audit/deps.go at=audit -->
```go title="internal/audit/deps.go"
// Module is one requirement of go.mod: the module path, the version the
// module pins, and whether the requirement is indirect — the toolchain's
// `// indirect` marker, which says no package in this module imports the
// module directly. The allowlist is about the direct ones; the bill of
// materials is checked against all of them.
type Module struct {
	Path     string
	Version  string
	Indirect bool
}
```

The reader itself walks the file line by line, and its shape is worth reading slowly.

<!-- verify: internal/audit/deps.go at=audit -->
```go title="internal/audit/deps.go"
// Requires parses a go.mod document and returns every requirement in file
// order. It reads the canonical shape the toolchain writes — the require
// blocks, single-line requires, and the `// indirect` comments — and refuses
// a requirement-shaped line it cannot read: a parser that silently skips
// what it does not understand is a parser a rogue dependency can hide from.
func Requires(gomod []byte) ([]Module, error) {
	var mods []Module
	inBlock := false
	for i, raw := range strings.Split(string(gomod), "\n") {
		line := i + 1
		code, comment := splitComment(raw)
		trimmed := strings.TrimSpace(code)
		switch {
		case inBlock:
			if trimmed == ")" {
				inBlock = false
				continue
			}
			if trimmed == "" {
				continue
			}
			m, err := parseRequirement(trimmed, comment, line)
			if err != nil {
				return nil, err
			}
			mods = append(mods, m)
		case trimmed == "require (":
			inBlock = true
		case strings.HasPrefix(trimmed, "require "):
			m, err := parseRequirement(strings.TrimSpace(strings.TrimPrefix(trimmed, "require ")), comment, line)
			if err != nil {
				return nil, err
			}
			mods = append(mods, m)
		}
	}
	if inBlock {
		return nil, errors.New("go.mod: unterminated require block")
	}
	return mods, nil
}
```

The loop reads the file in three cases: inside a require block, a line that opens one, and a single-line `require` outside one. A block that never closes is an error, not a silent stop. And the helpers are where the refusals live.

<!-- verify: internal/audit/deps.go at=audit -->
```go title="internal/audit/deps.go"
// splitComment splits a go.mod line into its code and its comment. A
// requirement line holds no quoted string, so the first `//` is the
// comment's start; a `//` inside a path or a version is not a shape go.mod
// has.
func splitComment(line string) (code, comment string) {
	if i := strings.Index(line, "//"); i >= 0 {
		return line[:i], line[i+2:]
	}
	return line, ""
}

// parseRequirement reads one requirement: a path and a version, with the
// `// indirect` marker in the line's comment. Anything else is an error
// naming the line, so a refusal is as reviewable as a requirement.
func parseRequirement(code, comment string, line int) (Module, error) {
	fields := strings.Fields(code)
	if len(fields) != 2 {
		return Module{}, fmt.Errorf("go.mod line %d: %q is not a requirement (path version)", line, strings.TrimSpace(code))
	}
	return Module{
		Path:     fields[0],
		Version:  fields[1],
		Indirect: strings.Contains(comment, "indirect"),
	}, nil
}
```

`parseRequirement` reads two fields and refuses anything else with an error that names the line. That refusal is the reader's security argument in one decision: a line the reader cannot understand is an error, not a line to skip, because a dependency could hide in the part a reader quietly ignored. `Direct` is the filter the allowlist's tests start from.

<!-- verify: internal/audit/deps.go at=audit -->
```go title="internal/audit/deps.go"
// Direct returns the requirements that are not indirect, in file order: the
// set the allowlist documents and the tests check.
func Direct(mods []Module) []Module {
	direct := make([]Module, 0, len(mods))
	for _, m := range mods {
		if !m.Indirect {
			direct = append(direct, m)
		}
	}
	return direct
}
```

The test that pins the reader is `TestRequires`, and its most interesting cases are the two refusals.

<!-- verify: internal/audit/deps_test.go at=audit -->
```go title="internal/audit/deps_test.go"
		{
			name:    "an unterminated block",
			gomod:   "require (\n\tgithub.com/a/b v1.2.3\n",
			wantErr: "unterminated",
		},
		{
			name:    "a line that is not a requirement",
			gomod:   "require (\n\tgithub.com/a/b\n)\n",
			wantErr: "not a requirement",
		},
```

Each case pins the exact message the reader returns: `unterminated` for the block that never closes, and `not a requirement` for the line it cannot read.

## The allowlist

The reader gives us the requirements. The policy is the map beside it: every direct requirement, with the reason it is here.

<!-- verify: internal/audit/deps.go at=audit -->
```go title="internal/audit/deps.go"
// Allowlist is the documented set of direct requirements this module may
// have: every path maps to the reason the module is here. The list is the
// supply-chain policy — a direct requirement is a dependency the application
// has chosen to trust, and the reason is what makes the choice reviewable —
// and the tests enforce it in both directions: a direct requirement the list
// does not name fails TestDependenciesAreAllowlisted, and a list entry no
...
var Allowlist = map[string]string{
...
}
```

Thirty-two entries in our copy, one per direct requirement; yours will match your own `go.mod`. The reasons in ours name the part of the book that brought the module in, which is how the stack's history stays readable. Indirect requirements are deliberately not listed: they arrive through the direct ones' own files, and the inventory is what pins them.

<!-- verify: internal/audit/deps.go at=audit -->
```go title="internal/audit/deps.go"
// Unlisted returns the paths of the requirements the allowlist does not
// name, sorted and deduplicated: the direct dependencies the module has not
// documented, which is the change the audit refuses.
func Unlisted(requires []Module, allowlist map[string]string) []string {
	var unlisted []string
	for _, m := range requires {
		if _, ok := allowlist[m.Path]; !ok {
			unlisted = append(unlisted, m.Path)
		}
	}
	return sortedUnique(unlisted)
}

// Stale returns the allowlist paths no requirement carries, sorted: entries
// whose module left the module graph, which is drift the audit refuses for
// the same reason — an allowlist is only documentation while it matches.
func Stale(requires []Module, allowlist map[string]string) []string {
	direct := map[string]bool{}
	for _, m := range requires {
		direct[m.Path] = true
	}
	var stale []string
	for path := range allowlist {
		if !direct[path] {
			stale = append(stale, path)
		}
	}
	return sortedUnique(stale)
}

// sortedUnique sorts paths and drops duplicates, so a failure message is
// stable however the input was ordered.
func sortedUnique(paths []string) []string {
	slices.Sort(paths)
	return slices.Compact(paths)
}
```

`Unlisted` asks which direct dependencies the list forgot; `Stale` asks which entries outlived their dependency. Both sort and drop duplicates, so a failure message reads the same on every run. The list names paths, not versions: versions are `go.mod`'s job, and the inventory pins them.

This is what the first test looks like when it works. The capture adds a
scratch package that imports `github.com/sirupsen/logrus` and runs `go mod
tidy` first, so a dependency becomes part of the app and the list does not
grow.

```bash
$ go test -count=1 -run TestDependenciesAreAllowlisted ./internal/audit/
--- FAIL: TestDependenciesAreAllowlisted (0.00s)
    deps_test.go:99:
        	Error Trace:	…/internal/audit/deps_test.go:99
        	Error:      	Should be empty, but was [github.com/sirupsen/logrus]
        	Test:       	TestDependenciesAreAllowlisted
        	Messages:   	direct requirements with no allowlist entry: add each to internal/audit's Allowlist with its reason, or remove it from go.mod
FAIL
FAIL	todo/internal/audit	0.002s
```

The failure names the module, so the fix is one edit: the entry with its reason, or the removal. A new dependency is a change to the trust list, and the test refuses to let the list change by accident.

## The suppression sweep

The second policy is about exceptions. gosec — the security linter in the project's rule set — flags suspicious patterns, and sometimes a finding is a false alarm. The accepted way to say so at one call site is a suppression — a comment beginning with `#nosec` — and the rule is that a suppression without a reason is an exception nobody can review. `internal/audit/suppressions.go` is the reader that enforces it.

<!-- verify: internal/audit/suppressions.go at=audit -->
```go title="internal/audit/suppressions.go"
// The suppressions rule: every `#nosec` directive — gosec's way of accepting
// a finding at one call site — must carry the reason it is accepted, after
// `--`. A suppression without a reason is an exception nobody can review,
// and the lint config's promise that "the deliberate exceptions carry their
// reasons at the call site" is only a promise until a test enforces it. This
// file is that test's reader.
//
// The reader parses each file and looks at its comments, not its text: a
// directive is a comment line whose text begins with the tag, by gosec's own
// recognition rule, so a mention mid-sentence or inside a string literal is
// prose rather than a suppression. The reader is deliberately a little
// stricter than gosec: the reason must be on the directive's own line.

// Suppression is one `#nosec` directive: where it is and what it says.
type Suppression struct {
	File   string
	Line   int
	Reason string
}
```

Then the sweep itself: walk the project's files, parse each one, and look at its comments.

<!-- verify: internal/audit/suppressions.go at=audit -->
```go title="internal/audit/suppressions.go"
// Suppressions walks fsys for .go files and returns every `#nosec` directive
// they hold, in walk order. Files marked generated — the standard
// `// Code generated ... DO NOT EDIT.` header before the package clause, the
// same marker the linter's `generated: strict` exclusion uses — are skipped:
// they are not ours to edit. A directive with no `-- reason` on its line
// comes back with an empty Reason; the caller decides what that means.
func Suppressions(fsys fs.FS) ([]Suppression, error) {
	var out []Suppression
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != "." && strings.HasPrefix(d.Name(), ".") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		src, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, p, src, parser.ParseComments)
		if err != nil {
			return fmt.Errorf("audit: parse %s: %w", p, err)
		}
		if generated(file) {
			return nil
		}
		for _, group := range file.Comments {
			for _, c := range group.List {
				text := strings.TrimSpace(commentText(c.Text))
				if !strings.HasPrefix(text, "#nosec") {
					continue
				}
				out = append(out, Suppression{
					File:   p,
					Line:   fset.Position(c.Pos()).Line,
					Reason: justification(text),
				})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
```

The walk visits every `.go` file, skips folders whose names begin with a dot, and skips generated files — the ones carrying the standard "Code generated … DO NOT EDIT" header, because those are not ours to edit. Each remaining file goes through Go's own parser, and a directive is a comment whose text begins with `#nosec`. A mention inside a string, or in the middle of a sentence, is invisible to the sweep — it is prose about the rule, not a use of it. The reader is deliberately a little stricter than the linter: the reason must be on the directive's own line.

The helpers are each one decision.

<!-- verify: internal/audit/suppressions.go at=audit -->
```go title="internal/audit/suppressions.go"
// commentText strips a comment's markers, leaving its text.
func commentText(text string) string {
	switch {
	case strings.HasPrefix(text, "//"):
		return text[2:]
	case strings.HasPrefix(text, "/*"):
		return strings.TrimSuffix(text[2:], "*/")
	}
	return text
}

// justification returns the reason after the directive's first `--`.
func justification(text string) string {
	if i := strings.Index(text, "--"); i >= 0 {
		return strings.TrimSpace(text[i+2:])
	}
	return ""
}

// generated reports whether the file carries the standard generated-code
// header: a comment before the package clause naming "Code generated" and
// "DO NOT EDIT" — the marker ast.IsGenerated looks for.
func generated(file *ast.File) bool {
	for _, group := range file.Comments {
		if group.Pos() > file.Package {
			break
		}
		text := group.Text()
		if strings.Contains(text, "Code generated") && strings.Contains(text, "DO NOT EDIT") {
			return true
		}
	}
	return false
}
```

`commentText` strips the `//` or `/* */` markers; `justification` is everything after the first `--`; `generated` looks for the two phrases the linter itself uses to recognize generated code. Then the rule is a test over the whole project.

<!-- verify: internal/audit/suppressions_test.go at=audit -->
```go title="internal/audit/suppressions_test.go"
// TestSuppressionsCarryReasons is the rule the gosec configuration leans on:
// a `#nosec` without a reason is an exception nobody can review. The sweep
// walks the ... — generated files excluded — so the assertion is
// about every directive the lint gate could take, not the ones a reader
// happened to remember.
func TestSuppressionsCarryReasons(t *testing.T) {
	t.Parallel()

	got, err := audit.Suppressions(os.DirFS(filepath.Join("..", "..")))
	require.NoError(t, err)
	require.NotEmpty(t, got, "the sweep found no #nosec directives; the reader is broken")

	for _, s := range got {
		assert.NotEmpty(t, s.Reason, "%s:%d: a #nosec directive must carry its reason after --", s.File, s.Line)
	}
}
```

The `require.NotEmpty` guard is what keeps a broken reader from passing silently: a reader that finds nothing has nothing to complain about. Today the sweep finds thirty-two directives, every one with a reason.

## The bill of materials

Now the inventory. `docs/sbom.cdx.json` is a **CycloneDX** document — the standard format for these lists — written by a tool called `syft`. It names every Go module the project is built from, direct and indirect, plus the app itself. The reader for it is the smallest of the three, because the document is JSON.

<!-- verify: internal/audit/sbom.go at=audit -->
```go title="internal/audit/sbom.go"
// SBOM is the part of a CycloneDX document the audit reads: the component
// list. Everything else — the schema, the tool metadata, the dependency
// graph — is the generator's business.
type SBOM struct {
	Components []Component `json:"components"`
}

// Component is one entry of the bill of materials. The purl is the
// component's identity and the audit's key: a Go module's purl is
// pkg:golang/<path>@<version>, which is what ties a component back to a
// requirement of go.mod.
type Component struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	PURL    string `json:"purl"`
}

// ReadSBOM decodes a CycloneDX JSON document.
func ReadSBOM(r io.Reader) (SBOM, error) {
	var sbom SBOM
	if err := json.NewDecoder(r).Decode(&sbom); err != nil {
		return SBOM{}, fmt.Errorf("read sbom: %w", err)
	}
	return sbom, nil
}
```

A **purl** is a package's address: `pkg:golang/` plus the module path, then `@` and the version. `GoModules` turns those addresses back into the requirements the tests compare.

<!-- verify: internal/audit/sbom.go at=audit -->
```go title="internal/audit/sbom.go"
func (s SBOM) GoModules() ([]Module, error) {
	var mods []Module
	for _, c := range s.Components {
		if !strings.HasPrefix(c.PURL, "pkg:golang/") {
			continue
		}
		id := strings.TrimPrefix(c.PURL, "pkg:golang/")
		if i := strings.Index(id, "?"); i >= 0 {
			id = id[:i]
		}
		path, version, ok := strings.Cut(id, "@")
		if !ok {
			// The main module: no version, because nothing tags it yet.
			continue
		}
		if path == "" || version == "" {
			return nil, fmt.Errorf("sbom: component %q has unreadable purl %q", c.Name, c.PURL)
		}
		mods = append(mods, Module{Path: path, Version: version})
	}
	return mods, nil
}
```

Read the skips: a component that is not a Go module is skipped, and a Go purl with no version — the app itself — is skipped. But a module purl the reader cannot parse is an error, because an entry the audit cannot read is an entry it cannot check. The third case in the test file is the portability rule, one loop long.

<!-- verify: internal/audit/sbom_test.go at=audit -->
```go title="internal/audit/sbom_test.go"
	for _, c := range sbom.Components {
		assert.NotEmpty(t, c.PURL, "%s has no purl; the SBOM must name packages, not paths", c.Name)
	}
```

Every component must carry a purl, so a path-named file component cannot come back.

Create a `docs` folder in the project root if it is not there yet, then run the generator.

```bash
$ go run github.com/anchore/syft/cmd/syft@v1.54.1 scan dir:. --source-name todo --select-catalogers=-file --quiet -o cyclonedx-json=docs/sbom.cdx.json
```

`syft` reads the project's own files — `go.mod` above all — and writes the document. The flag keeps file paths out of it, so every entry is a package with a name, not a place on this machine. Then the inventory test.

```bash
$ go test -count=1 -run TestSBOM ./internal/audit/
ok  	todo/internal/audit	0.004s
```

Green. The document is a snapshot, and the test is what keeps it honest: a dependency change that forgot to regenerate the document fails here instead of shipping a stale inventory. The serial number and the timestamp inside the document change on every run, which is why the test compares meaning — the modules and their versions — instead of bytes.

## The vulnerability scan

A **vulnerability** is a known bug with a security impact, and a public database tracks them for Go packages. `govulncheck` reads the project's dependencies, asks that database, and reports only what the code can reach.

```bash
$ go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
=== Symbol Results ===

No vulnerabilities found.

Your code is affected by 0 vulnerabilities.
This scan also found 0 vulnerabilities in packages you import and 1
vulnerability in modules you require, but your code doesn't appear to call these
vulnerabilities.
Use '-show verbose' for more details.
```

No finding: the code can reach nothing known-broken. The last lines still carry one number — a vulnerability in a module we require — and the verbose run names it.

```bash
$ go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -show verbose ./...
=== Module Results ===

Vulnerability #1: GO-2026-5932
    The golang.org/x/crypto/openpgp package is unmaintained, unsafe by design,
    and has known security issues
  More info: https://pkg.go.dev/vuln/GO-2026-5932
  Module: golang.org/x/crypto
    Found in: golang.org/x/crypto@v0.58.0
    Fixed in: N/A
```

`x/crypto` is on the allowlist because the app hashes passwords with its `argon2` package. `openpgp` lives in the same module, nothing here imports it, and there is nothing to upgrade to: the package is abandoned, not patched. The report is recorded rather than hidden, because an audit that hides what it found is not an audit.

## Names for the scanners

The commands in the last two sections are long, and they are meant to be run again — after a dependency moves, whenever the review asks. The `Makefile` keeps the project's long commands under names, and the audit adds three. Each name is a recipe around one pinned scanner:

<!-- verify: Makefile at=audit -->
```make title="Makefile"
# vulncheck runs the Go vulnerability database over the module and reports
# what the code can reach. A module-level advisory for a package nothing
# imports is not a finding the gate can fix, and the tool's summary says so
# in its own words: symbol results, then package results, then module
# results. The database is fetched from vuln.go.dev on first run and cached.
vulncheck:
	$(GOVULNCHECK) ./...

# leaks scans the whole git history — every commit, not the working tree —
# for credentials. A key that reached a commit reached every clone, so the
# scan is over history, and the CI checkout is deep for the same reason.
leaks:
	$(GITLEAKS) git . --no-banner --no-color

# sbom writes the CycloneDX bill of materials the audit commits. It scans
# the repository's manifests: the Go module graph and the workflow's actions.
# The file catalogers are off (-file), so every component is a package purl
# and nothing carries the machine's own paths — that is what makes the
# committed document portable and what the SBOM test checks. Regenerating it
# is a deliberate act (syft is a heavyweight build, and the timestamp and
# serial change on every run), so this target is not part of check; the test
# in internal/audit is what keeps the committed copy honest.
sbom:
	$(SYFT) scan dir:. --source-name todo --select-catalogers=-file --quiet -o cyclonedx-json=docs/sbom.cdx.json
```

Read the three names against the sections above. `make vulncheck` runs the same `govulncheck` command the vulnerability scan showed, built from the pin at the top of the file the way every other tool in the file is built. `make sbom` runs the same `syft` command that wrote the document — and the SBOM test's failure message has been naming `make sbom` since the test was written, so the message and the recipe now agree. The third name is for credentials: `gitleaks` reads the project's recorded history for a secret that should never have been written down, and `make leaks` is how it runs.

## Turning the floors up

The linter's policy file gets two settings the review insists on. Add them under `linters.settings`, beside the `errcheck` block that is already there.

<!-- verify: .golangci.yml at=audit -->
```yaml title=".golangci.yml"
    staticcheck:
      # golangci-lint's staticcheck defaults leave the ST1xxx documentation
      # checks off; the audit turns them on, so a comment that no longer
      # matches its symbol — or an exported symbol without one — is a
      # finding, not a style opinion. The one report this produced is fixed
      # in internal/api: the session policy comment now leads with its
      # constructor.
      checks: ["all"]

    gosec:
      # gosec's whole rule set runs at the widest floors: no rule excluded
      # and nothing filtered by severity or confidence. The deliberate
      # exceptions live at the call site as `#nosec Gxxx -- reason`, and the
      # audit's suppression test (internal/audit) fails a directive without
      # a reason, so "deliberate" is enforced rather than asserted.
      severity: low
      confidence: low
      excludes: []
```

The first setting turns on staticcheck's full check set: a comment that no longer matches the name it describes becomes a finding. The second runs gosec — the security rules — at the widest setting, with nothing excluded; the suppression sweep is what keeps its exceptions honest.

Run the linter. The first full run over the project found three things — two in an early shape of the SBOM test's file reader, and one that is in your copy.

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
internal/audit/sbom_test.go:57:15: Error return value of `f.Close` is not checked (errcheck)
	defer f.Close()
	             ^
internal/audit/sbom_test.go:94:15: Error return value of `f.Close` is not checked (errcheck)
	defer f.Close()
	             ^
internal/api/sessions.go:16:1: ST1020: comment on exported function NewSessionManager should be of the form "NewSessionManager ..." (staticcheck)
// Session policy: the manager's configuration, in one place.
^
3 issues:
* errcheck: 2
* staticcheck: 1
```

The last one is the real find: the comment on `NewSessionManager` in `internal/api/sessions.go` no longer begins with the function's own name, and staticcheck's documentation checks want it to. Replace its first line with the sentence below; the policy prose that follows stays as it is.

<!-- verify: internal/api/sessions.go at=audit -->
```go title="internal/api/sessions.go"
// NewSessionManager builds the session manager over store, with the cookie
// policy in one place.
```

The two `Close` findings were in a version of the SBOM test that opened the document and deferred the close; the shape this lesson writes reads the file whole, so there is no open resource to close. "If something went wrong" shows that message for the day you write a reader of your own. Run the linter again.

```bash
$ go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0 run
0 issues.
```

Zero issues: the comment was the only thing standing between the project and its own floors.

## The threat model

The machine-checked half of the audit is in place. The human half is `docs/threat-model.md` — the document a person reads. It begins by naming its own scope and its own limits.

<!-- verify: docs/threat-model.md at=audit -->
```markdown title="docs/threat-model.md"
This is the audit's document: what the application protects, who can reach
it, where the trust boundaries are, and which threats the controls answer.
```

A **trust boundary** is a place where data crosses from something we control to something we do not — the network, the database file, another module. The document then walks the system in the order a stranger would meet it: the boundaries, then the **assets** (the things worth protecting), the **actors** (who can reach them), and a table of threats. Every threat pairs with the control that answers it and the test that proves the control is there.

<!-- verify: docs/threat-model.md at=audit -->
```markdown title="docs/threat-model.md"
| Session theft | reference token, digest at rest, `__Host-` + Secure + HttpOnly + SameSite=Lax, fixed 24 h lifetime | `internal/api/sessions.go`, `internal/auth/session.go`; `TestSessionCookie_HostPrefix`, `TestSessionStore_HashesTokenAtRest` |
| IDOR / BOLA (a foreign task) | the scope lives in the queries; a foreign id answers exactly what a missing id answers | `internal/api/authorization.go`; `TestTask_Foreign_Returns404` |
...
| Rogue direct dependency | the allowlist test refuses a direct requirement with no documented reason | `internal/audit`; `TestDependenciesAreAllowlisted` |
| Stale bill of materials | the SBOM test checks the ... document against `go.mod` in both directions | `internal/audit`; `TestSBOMNamesEveryRequirement` |
| Undocumented lint suppression | every `#nosec` must carry its reason; generated files are excluded | `internal/audit`; `TestSuppressionsCarryReasons` |
```

The document's middle maps the app to OWASP ASVS — the Application Security
Verification Standard, a public checklist of application-security
requirements — marking each one *met*, *partial*, *gap*, or *n/a* with the
reason in the same row. It ends with the part that keeps it honest — the residual risks, the gaps named instead of glossed.

<!-- verify: docs/threat-model.md at=audit -->
```markdown title="docs/threat-model.md"
1. **No MFA, no password change or recovery.** A stolen password is a full
   account compromise until the operator rotates it.
2. **No inactivity timeout.** A session lives its fixed 24 h however idle;
   a stolen cookie is usable for that window.
...
6. **`GO-2026-5932` (x/crypto/openpgp) is unfixable at module level.** The
   package is unmaintained; the application imports `argon2` from the same
   module and never `openpgp`, and `govulncheck`'s symbol analysis is what
   says so — the module-level report is recorded rather than hidden.
```

Write yours the same way: every claim gets a control and the evidence that proves it, and every gap gets a name. A threat model that claims more than it shows is worse than none, because it is trusted.

## Run it green

With all three readers in place, the audit package's cases pass.

```bash
$ go test -count=1 -v ./internal/audit
--- PASS: TestDependenciesAreAllowlisted (0.00s)
--- PASS: TestAllowlistHasNoStaleEntries (0.00s)
--- PASS: TestAllowlistReasonsAreDocumented (0.00s)
--- PASS: TestRequires (0.00s)
    --- PASS: TestRequires/a_require_block,_direct_and_indirect (0.00s)
    --- PASS: TestRequires/an_unterminated_block (0.00s)
    --- PASS: TestRequires/a_line_that_is_not_a_requirement (0.00s)
--- PASS: TestGoModules (0.00s)
...
--- PASS: TestSuppressionsCarryReasons (0.03s)
ok  	todo/internal/audit	0.030s
```

The order is a presentation, not a property — the cases run in parallel and finish in a different order each time. Then the whole module.

```bash
$ go test -count=1 ./...
ok  	todo/cmd/todo	1.984s
ok  	todo/cmd/todo-server	2.701s
ok  	todo/internal/audit	0.061s
...
ok  	todo/internal/web	0.226s
?   	todo/internal/web/views	[no test files]
```

Every package passes, and the audit added no dependency: the package is all standard library. Nothing in the app's behavior changed — the review's only fix was a comment.

## If something went wrong

**`todo/internal/audit: no non-test Go files in …/internal/audit`.** You ran the tests before writing the readers. A folder with tests and no regular Go files is not a package a build can see. Write `deps.go`, `suppressions.go`, and `sbom.go`; the message disappears.

**The allowlist test failed and named a module you do not recognize.** A dependency became direct and the list did not grow.

```bash
--- FAIL: TestDependenciesAreAllowlisted (0.00s)
    deps_test.go:99:
        	Error Trace:	…/internal/audit/deps_test.go:99
        	Error:      	Should be empty, but was [github.com/sirupsen/logrus]
        	Test:       	TestDependenciesAreAllowlisted
        	Messages:   	direct requirements with no allowlist entry: add each to internal/audit's Allowlist with its reason, or remove it from go.mod
FAIL
FAIL	todo/internal/audit	0.002s
```

The fix is the one the message names: the entry with its reason, or the removal. The other direction fails too — an entry no direct requirement carries.

```bash
--- FAIL: TestAllowlistHasNoStaleEntries (0.00s)
    deps_test.go:113:
        	Error Trace:	…/internal/audit/deps_test.go:113
        	Error:      	Should be empty, but was [github.com/example/gone]
        	Test:       	TestAllowlistHasNoStaleEntries
        	Messages:   	allowlist entries no direct requirement carries: remove them, or restore the requirement
FAIL
FAIL	todo/internal/audit	0.002s
```

Remove the entry, or restore the dependency.

**`a #nosec directive must carry its reason after --`.** The sweep found a suppression without one.

```bash
--- FAIL: TestSuppressionsCarryReasons (0.02s)
    suppressions_test.go:58:
        	Error Trace:	…/internal/audit/suppressions_test.go:58
        	Error:      	Should NOT be empty, but was
        	Test:       	TestSuppressionsCarryReasons
        	Messages:   	internal/secret/load.go:64: a #nosec directive must carry its reason after --
FAIL
FAIL	todo/internal/audit	0.023s
```

The message names the file and the line. Add the reason on the directive's own line, after `--`.

**The SBOM test failed after a dependency change.** The document and `go.mod` disagree.

```bash
--- FAIL: TestSBOMNamesEveryRequirement (0.00s)
    sbom_test.go:80:
        	Error Trace:	…/internal/audit/sbom_test.go:80
        	Error:      	Should be true
        	Test:       	TestSBOMNamesEveryRequirement
        	Messages:   	github.com/google/uuid@v1.6.0 is required by go.mod but missing from docs/sbom.cdx.json; run `make sbom`
FAIL
FAIL	todo/internal/audit	0.004s
```

The message names the fix: `make sbom` runs the `syft` command from "The bill of materials" and writes the document again.

**`ST1020: comment on exported function NewSessionManager should be of the form "NewSessionManager ..." (staticcheck)`.** The comment no longer leads with its function's name. Make it begin with the name and keep the prose that follows.

**`Error return value of `f.Close` is not checked (errcheck)`.** Your own version of the SBOM test opened the file and deferred the close.

```bash
internal/audit/sbom_test.go:57:15: Error return value of `f.Close` is not checked (errcheck)
	defer f.Close()
	             ^
```

Read the file whole instead: `os.ReadFile` hands back the bytes, so there is no open resource to close.

<details>
<summary>Going deeper: why the reader refuses what it cannot read</summary>

The interesting `go.mod` is not the tidy one the toolchain just wrote — it is the line a hand edit or a future tool left in a shape the reader does not recognize. Skipping that line would let a dependency sit in the file while the policy never parsed it. Refusing it means the audit fails loudly on the next run, which is the whole point: a check that quietly ignores what it does not understand is a check a rogue dependency can hide behind.

</details>

<details>
<summary>Going deeper: what a purl is, and why the tests compare meaning, not bytes</summary>

A purl is a package URL: a standard address for one piece of software, `pkg:golang/<module>@<version>` for a Go module. It is how the bill of materials names its entries, and how the test ties a component back to a requirement. Byte freshness would be impossible even if it were desirable — the document's serial number and timestamp change on every run — so the test compares the module set instead: the modules and their versions, in both directions. That is also why regenerating the document is a deliberate command rather than a step in every test run.

</details>

<details>
<summary>Going deeper: symbols, packages, modules — the three layers of a vulnerability scan</summary>

`govulncheck` reports at three depths. A symbol result is a known-broken function the code can actually reach — the only kind of finding a project can fix. A package result is a mention in a package the code imports. A module result is a fact about the inventory: a module the project requires carries a known issue somewhere, whether or not anything calls it. Our one advisory is the third kind, in an abandoned package nothing imports. Recording it keeps the audit honest; suppressing it would only make the output prettier.

</details>

<details>
<summary>Going deeper: what the threat model's status words mean</summary>

Every requirement in the document is marked *met* (the control exists and a test proves it), *partial* (the control exists with a named limitation), *gap* (the control is absent, and the gap is listed in the residual risks), or *n/a* (the mechanism does not exist here, so the question does not apply). The words are the document's honesty: they make it impossible to claim coverage without showing the control. The app claims full coverage of the lowest level and names its higher-level gaps rather than implying them.

</details>

The review is written and enforced; next, the app steps out of the loopback address and onto the network.
