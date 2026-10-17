---
title: "internal/audit — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/100-days-of-go-lang/appendices/the-finished-app/).


## `internal/audit/deps.go`

````go
// Package audit holds the repository's supply-chain checks: the readers for
// the two documents the audit trusts — go.mod and the committed CycloneDX
// bill of materials — and the policies they are checked against: the
// dependency allowlist every direct requirement must be on, and the rule
// that every `#nosec` suppression carries its reason.
//
// Nothing at runtime imports this package. Its tests are the gate — they run
// with `go test ./...`, which is what makes each policy a fact about the
// repository rather than a paragraph in a document — and the failing test is
// the red the chapter shows first: a rogue direct dependency, a suppression
// without a reason, a bill of materials that drifted from go.mod.
package audit

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

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

// Allowlist is the documented set of direct requirements this module may
// have: every path maps to the reason the module is here. The list is the
// supply-chain policy — a direct requirement is a dependency the application
// has chosen to trust, and the reason is what makes the choice reviewable —
// and the tests enforce it in both directions: a direct requirement the list
// does not name fails TestDependenciesAreAllowlisted, and a list entry no
// requirement carries fails TestAllowlistHasNoStaleEntries. A new dependency
// is therefore two edits in one commit: go.mod, and this map with its
// reason.
//
// The reasons name the chapter that brought the module in, because the
// project is the finished application the book quotes, and the stack's
// history is part of its documentation. Indirect requirements are
// deliberately not listed: they
// arrive through the direct ones' own go.mod files, and the bill of
// materials (see sbom.go) is what pins them.
var Allowlist = map[string]string{
	"github.com/a-h/templ":                                            "the page templates and their generated Go (chapter 36)",
	"github.com/alexedwards/scs/v2":                                   "the session manager and its store interface (chapter 33)",
	"github.com/charmbracelet/bubbles":                                "the TUI's list, text input, and help components (chapter 42)",
	"github.com/charmbracelet/bubbletea":                              "the TUI's Elm-style runtime (chapter 41)",
	"github.com/charmbracelet/lipgloss":                               "the TUI's styling (chapter 42)",
	"github.com/charmbracelet/x/ansi":                                 "the TUI's width-aware truncation (chapter 41)",
	"github.com/charmbracelet/x/exp/teatest":                          "the TUI's end-to-end test driver (chapter 41)",
	"github.com/gkampitakis/go-snaps":                                 "snapshot assertions for CLI output and pages (chapter 10)",
	"github.com/go-playground/validator/v10":                          "request validation behind echo's Validator hook (chapter 31)",
	"github.com/google/go-cmp":                                        "diffing in tests (chapter 10)",
	"github.com/google/uuid":                                          "UUIDv7 identifiers (chapter 23)",
	"github.com/labstack/echo/v4":                                     "the HTTP router and its middleware stack (chapter 30)",
	"github.com/lmittmann/tint":                                       "human-readable records on a TTY (chapter 29)",
	"github.com/muesli/termenv":                                       "the TUI tests' colour profile (chapter 41)",
	"github.com/pressly/goose/v3":                                     "embedded migrations (chapter 21)",
	"github.com/prometheus/client_golang":                             "the metrics registry and the scrape endpoint (chapter 45)",
	"github.com/prometheus/client_model":                              "the metrics exposition model in tests (chapter 45)",
	"github.com/prometheus/common":                                    "the exposition format parser in tests (chapter 45)",
	"github.com/rogpeppe/go-internal":                                 "the testscript DSL for the CLI's integration tests (chapter 28)",
	"github.com/spf13/cobra":                                          "the CLI's command tree (chapter 25)",
	"github.com/stretchr/testify":                                     "assertions across the suite (chapter 9)",
	"github.com/swaggo/echo-swagger":                                  "the Swagger UI route (chapter 35)",
	"github.com/swaggo/swag":                                          "the generated OpenAPI spec (chapter 35)",
	"go.opentelemetry.io/otel":                                        "the tracing API (chapter 45)",
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp": "the OTLP trace exporter (chapter 45)",
	"go.opentelemetry.io/otel/sdk":                                    "the tracing SDK and the provider (chapter 45)",
	"go.opentelemetry.io/otel/trace":                                  "trace and span ids (chapter 45)",
	"golang.org/x/crypto":                                             "argon2id password hashing (chapter 33)",
	"golang.org/x/sync":                                               "errgroup in the batch importer and the stats workers (chapter 18)",
	"golang.org/x/term":                                               "TTY detection for the log format and the TUI (chapter 29)",
	"golang.org/x/time":                                               "the login limiter's token bucket (chapter 39)",
	"turso.tech/database/tursogo":                                     "the SQLite-compatible database driver (chapter 20)",
}

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
````


## `internal/audit/deps_test.go`

````go
package audit_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/audit"
)

// repoFile reads a file at the repository root. The package's tests run with
// the working directory set to the package, so the root is two levels up;
// reading the repository's own documents — go.mod, docs/sbom.cdx.json — is
// what makes these tests the audit rather than a fixture exercise.
func repoFile(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", filepath.FromSlash(name)))
	require.NoError(t, err)
	return data
}

// TestRequires pins the go.mod reader: the shapes the toolchain writes, and
// the refusals. A requirement-shaped line the reader cannot parse is an
// error, not a line to skip, because a parser that silently skips what it
// does not understand is a parser a rogue dependency can hide from.
func TestRequires(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		gomod   string
		want    []audit.Module
		wantErr string
	}{
		{
			name: "a require block, direct and indirect",
			gomod: "module example\n\ngo 1.26\n\nrequire (\n" +
				"\tgithub.com/a/b v1.2.3\n" +
				"\tgithub.com/c/d v4.5.6 // indirect\n" +
				")\n",
			want: []audit.Module{
				{Path: "github.com/a/b", Version: "v1.2.3"},
				{Path: "github.com/c/d", Version: "v4.5.6", Indirect: true},
			},
		},
		{
			name:  "a single-line require",
			gomod: "module example\n\nrequire github.com/e/f v0.1.0\n",
			want:  []audit.Module{{Path: "github.com/e/f", Version: "v0.1.0"}},
		},
		{
			name:  "comments and blank lines in a block",
			gomod: "require (\n\t// a comment\n\n\tgithub.com/g/h v2.0.0\n)\n",
			want:  []audit.Module{{Path: "github.com/g/h", Version: "v2.0.0"}},
		},
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
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := audit.Requires([]byte(tt.gomod))
			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

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

// TestAllowlistHasNoStaleEntries is the other direction: an allowlist entry
// no direct requirement carries is a document that has drifted from the
// module, and drift is how an allowlist becomes a lie.
func TestAllowlistHasNoStaleEntries(t *testing.T) {
	t.Parallel()

	mods, err := audit.Requires(repoFile(t, "go.mod"))
	require.NoError(t, err)

	stale := audit.Stale(audit.Direct(mods), audit.Allowlist)
	assert.Empty(t, stale,
		"allowlist entries no direct requirement carries: remove them, or restore the requirement")
}

// TestAllowlistReasonsAreDocumented: an entry without a reason is an entry
// nobody can review, which is the one thing an allowlist must not contain.
func TestAllowlistReasonsAreDocumented(t *testing.T) {
	t.Parallel()

	for path, reason := range audit.Allowlist {
		assert.NotEmpty(t, reason, "%s has no reason", path)
	}
}
````


## `internal/audit/sbom.go`

````go
package audit

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// The bill of materials is the audit's inventory: the CycloneDX document
// `make sbom` writes to docs/sbom.cdx.json, naming every Go module the
// module graph holds and every GitHub Action the workflows use. Committing
// it is the snapshot; this reader and the tests beside it are what keep the
// snapshot honest — the tests check it against go.mod in both directions, so
// a dependency change that forgot to regenerate it fails the suite instead
// of shipping a stale inventory.

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

// GoModules returns the Go modules the document names, parsed from their
// purls and in document order. Two kinds of components are skipped: a
// component whose purl is not a Go module's — the workflows' GitHub Actions
// — and a version-less Go purl, which is the main module itself
// (pkg:golang/todo), not a requirement. A dependency purl the reader cannot
// parse is an error, because an inventory entry the audit cannot read is an
// entry it cannot check.
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
````


## `internal/audit/sbom_test.go`

````go
package audit_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/audit"
)

// TestGoModules pins the purl reader: a component's identity is its purl,
// and the reader must refuse one it cannot parse rather than drop it — an
// inventory entry the audit cannot read is an inventory entry it cannot
// check.
func TestGoModules(t *testing.T) {
	t.Parallel()

	sbom, err := audit.ReadSBOM(strings.NewReader(`{
		"bomFormat": "CycloneDX",
		"components": [
			{"name": "github.com/a/b", "version": "v1.2.3", "purl": "pkg:golang/github.com/a/b@v1.2.3"},
			{"name": "actions/checkout", "version": "v5", "purl": "pkg:github/actions/checkout@v5"},
			{"name": "github.com/c/d", "version": "v4.5.6", "purl": "pkg:golang/github.com/c/d@v4.5.6?type=module"},
			{"name": "todo", "version": "UNKNOWN", "purl": "pkg:golang/todo"}
		]
	}`))
	require.NoError(t, err)

	got, err := sbom.GoModules()
	require.NoError(t, err)
	assert.Equal(t, []audit.Module{
		{Path: "github.com/a/b", Version: "v1.2.3"},
		{Path: "github.com/c/d", Version: "v4.5.6"},
	}, got, "the GitHub Action and the main module are not requirements; a qualifier is not part of the version")

	broken, err := audit.ReadSBOM(strings.NewReader(`{"components": [{"name": "x", "purl": "pkg:golang/@v1.2.3"}]}`))
	require.NoError(t, err)
	_, err = broken.GoModules()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "pkg:golang/@v1.2.3")
}

// readSBOM reads the committed bill of materials. It reads the file whole
// rather than opening it, so the test has no descriptor to close and the
// failure names the fix: `make sbom`.
func readSBOM(t *testing.T) audit.SBOM {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "sbom.cdx.json"))
	require.NoError(t, err, "docs/sbom.cdx.json is committed; run `make sbom` to write it")
	sbom, err := audit.ReadSBOM(bytes.NewReader(data))
	require.NoError(t, err)
	return sbom
}

// TestSBOMNamesEveryRequirement pins both directions between go.mod and the
// committed bill of materials: every requirement is in the document at the
// version the module pins, and every Go module in the document is still a
// requirement. A dependency change that forgot `make sbom` fails here, which
// is what keeps the committed snapshot from going stale in silence.
func TestSBOMNamesEveryRequirement(t *testing.T) {
	t.Parallel()

	sbom := readSBOM(t)
	named, err := sbom.GoModules()
	require.NoError(t, err)

	mods, err := audit.Requires(repoFile(t, "go.mod"))
	require.NoError(t, err)

	inDocument := map[string]bool{}
	for _, m := range named {
		inDocument[m.Path+"@"+m.Version] = true
	}
	for _, m := range mods {
		assert.True(t, inDocument[m.Path+"@"+m.Version],
			"%s@%s is required by go.mod but missing from docs/sbom.cdx.json; run `make sbom`", m.Path, m.Version)
	}

	inModule := map[string]bool{}
	for _, m := range mods {
		inModule[m.Path+"@"+m.Version] = true
	}
	for _, m := range named {
		assert.True(t, inModule[m.Path+"@"+m.Version],
			"%s@%s is in docs/sbom.cdx.json but no longer required; run `make sbom`", m.Path, m.Version)
	}
}

// TestSBOMComponentsAreIdentified: every component carries a purl, so the
// document names packages rather than paths — a path-named file component
// would carry the machine's own directory into a committed artifact.
func TestSBOMComponentsAreIdentified(t *testing.T) {
	t.Parallel()

	sbom := readSBOM(t)
	require.NotEmpty(t, sbom.Components)

	for _, c := range sbom.Components {
		assert.NotEmpty(t, c.PURL, "%s has no purl; the SBOM must name packages, not paths", c.Name)
	}
}
````


## `internal/audit/suppressions.go`

````go
package audit

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"strings"
)

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
````


## `internal/audit/suppressions_test.go`

````go
package audit_test

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"todo/internal/audit"
)

// TestSuppressions pins the reader's recognition rule: a directive is a
// comment line whose text begins with the tag — gosec's own rule — so a
// mention mid-sentence or inside a string literal is prose, not a
// suppression, while the block-comment form is a directive like any other.
// Generated files carry the same `Code generated ... DO NOT EDIT.` marker
// the linter's `generated: strict` exclusion uses and are skipped like the
// linter skips them.
func TestSuppressions(t *testing.T) {
	t.Parallel()

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
}

// TestSuppressionsCarryReasons is the rule the gosec configuration leans on:
// a `#nosec` without a reason is an exception nobody can review. The sweep
// walks the repository — generated files excluded — so the assertion is
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
````
