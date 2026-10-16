---
title: "The project root — the finished app"
sidebar:
  hidden: true
tableOfContents: false
pagefind: false
---


Part of [The finished app (spoilers)](/appendices/the-finished-app/).


## `go.mod`

````text
module todo

go 1.26.8

require (
	github.com/a-h/templ v0.3.1070
	github.com/alexedwards/scs/v2 v2.9.0
	github.com/charmbracelet/bubbles v1.0.0
	github.com/charmbracelet/bubbletea v1.3.10
	github.com/charmbracelet/lipgloss v1.1.0
	github.com/charmbracelet/x/ansi v0.11.6
	github.com/charmbracelet/x/exp/teatest v0.0.0-20261012121918-43427fdbad12
	github.com/gkampitakis/go-snaps v0.5.23
	github.com/go-playground/validator/v10 v10.30.5
	github.com/google/go-cmp v0.7.0
	github.com/google/uuid v1.6.0
	github.com/labstack/echo/v4 v4.16.0
	github.com/lmittmann/tint v1.2.1
	github.com/muesli/termenv v0.16.0
	github.com/pressly/goose/v3 v3.29.0
	github.com/prometheus/client_golang v1.25.0
	github.com/prometheus/client_model v0.6.3
	github.com/prometheus/common v0.72.1
	github.com/rogpeppe/go-internal v1.16.0
	github.com/spf13/cobra v1.10.2
	github.com/stretchr/testify v1.12.1
	github.com/swaggo/echo-swagger v1.5.2
	github.com/swaggo/swag v1.16.6
	go.opentelemetry.io/otel v1.47.0
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.47.0
	go.opentelemetry.io/otel/sdk v1.47.0
	go.opentelemetry.io/otel/trace v1.47.0
	golang.org/x/crypto v0.58.0
	golang.org/x/sync v0.24.0
	golang.org/x/term v0.47.0
	golang.org/x/time v0.15.0
	turso.tech/database/tursogo v0.8.3
)

require (
	github.com/KyleBanks/depth v1.2.1 // indirect
	github.com/atotto/clipboard v0.1.4 // indirect
	github.com/aymanbagabas/go-osc52/v2 v2.0.1 // indirect
	github.com/aymanbagabas/go-udiff v0.3.1 // indirect
	github.com/charmbracelet/colorprofile v0.4.1 // indirect
	github.com/charmbracelet/x/cellbuf v0.0.15 // indirect
	github.com/charmbracelet/x/exp/golden v0.0.0-20241011142426-46044092ad91 // indirect
	github.com/charmbracelet/x/term v0.2.2 // indirect
	github.com/clipperhouse/displaywidth v0.9.0 // indirect
	github.com/clipperhouse/stringish v0.1.1 // indirect
	github.com/clipperhouse/uax29/v2 v2.5.0 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cenkalti/backoff/v5 v5.0.3 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/ebitengine/purego v0.9.1 // indirect
	github.com/erikgeiser/coninput v0.0.0-20211004153227-1c3628e74d0f // indirect
	github.com/gabriel-vasile/mimetype v1.4.15 // indirect
	github.com/gkampitakis/ciinfo v0.3.4 // indirect
	github.com/go-logr/logr v1.4.4 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/go-openapi/jsonpointer v1.0.0 // indirect
	github.com/go-openapi/jsonreference v1.0.0 // indirect
	github.com/go-openapi/spec v0.22.9 // indirect
	github.com/go-openapi/swag/conv v0.28.0 // indirect
	github.com/go-openapi/swag/jsonutils v0.28.0 // indirect
	github.com/go-openapi/swag/loading v0.28.0 // indirect
	github.com/go-openapi/swag/pools v0.28.0 // indirect
	github.com/go-openapi/swag/stringutils v0.28.0 // indirect
	github.com/go-openapi/swag/typeutils v0.28.0 // indirect
	github.com/go-openapi/swag/yamlutils v0.28.0 // indirect
	github.com/go-playground/locales v0.14.1 // indirect
	github.com/go-playground/universal-translator v0.18.1 // indirect
	github.com/goccy/go-yaml v1.19.2 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.30.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/kr/pretty v0.3.1 // indirect
	github.com/kr/text v0.2.0 // indirect
	github.com/labstack/gommon v0.5.0 // indirect
	github.com/leodido/go-urn v1.5.0 // indirect
	github.com/lucasb-eyer/go-colorful v1.3.0 // indirect
	github.com/mailru/easyjson v0.7.7 // indirect
	github.com/maruel/natural v1.3.0 // indirect
	github.com/mattn/go-colorable v0.1.15 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/mattn/go-localereader v0.0.1 // indirect
	github.com/mattn/go-runewidth v0.0.19 // indirect
	github.com/mfridman/interpolate v0.0.2 // indirect
	github.com/muesli/ansi v0.0.0-20230316100256-276c6243b2f6 // indirect
	github.com/muesli/cancelreader v0.2.2 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/rivo/uniseg v0.4.7 // indirect
	github.com/prometheus/procfs v0.22.0 // indirect
	github.com/sergi/go-diff v1.4.0 // indirect
	github.com/sethvargo/go-retry v0.5.0 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	github.com/sv-tools/openapi v0.2.1 // indirect
	github.com/swaggo/files/v2 v2.0.0 // indirect
	github.com/swaggo/swag/v2 v2.0.0-rc4 // indirect
	github.com/tidwall/gjson v1.19.0 // indirect
	github.com/tidwall/match v1.1.1 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/sjson v1.2.5 // indirect
	github.com/tursodatabase/turso-go-platform-libs v0.8.3 // indirect
	github.com/valyala/bytebufferpool v1.0.0 // indirect
	github.com/valyala/fasttemplate v1.2.2 // indirect
	github.com/xo/terminfo v0.0.0-20220910002029-abceb7e1c41e // indirect
	go.opentelemetry.io/auto/sdk v1.2.1 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.47.0 // indirect
	go.opentelemetry.io/otel/log v1.47.0 // indirect
	go.opentelemetry.io/otel/metric v1.47.0 // indirect
	go.opentelemetry.io/proto/otlp v1.11.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	go.yaml.in/yaml/v3 v3.0.5 // indirect
	golang.org/x/mod v0.41.0 // indirect
	golang.org/x/net v0.61.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.43.0 // indirect
	golang.org/x/tools v0.51.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20261005182115-fad411399dd8 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20261005182115-fad411399dd8 // indirect
	google.golang.org/grpc v1.84.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	sigs.k8s.io/yaml v1.3.0 // indirect
)
````


## `.gitignore`

````text
# the built binary
/todo

# release artifacts (Part X)
/dist/

# local databases (Part V)
*.db
*.db-wal
*.db-log

# coverage output
/coverage.out
/coverage.html
````


## `.golangci.yml`

````yaml
version: "2"

linters:
  # The curated gate: golangci-lint's five standard linters plus gosec.
  # `default: none` makes this list the whole policy: no linter is enabled by
  # accident, and a future tool release cannot add one behind our backs.
  default: none
  enable:
    - errcheck
    - govet
    - staticcheck
    - ineffassign
    - unused
    - gosec

  settings:
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

    errcheck:
      # errcheck layers its own built-in symbol exclusions on top of the
      # presets: fmt.Fprint* to os.Stderr, writes to bytes.Buffer and
      # strings.Builder, and a few hash/rand writes — calls whose error
      # cannot carry information the caller could act on. Kept (upstream
      # default) and made explicit; the arbitrary-io.Writer case is not on
      # that list, so it stays reported.
      disable-default-exclusions: false

  exclusions:
    # Generated files are not ours to fix. `strict` uses Go's own marker
    # (`// Code generated ... DO NOT EDIT.`, via ast.IsGenerated), which is
    # exactly what moq writes into store_moq_test.go.
    generated: strict

    # No exclusion presets, deliberately: v2 presets are opt-in (Default: []),
    # and the one that would matter here is std-error-handling (EXC0001). It
    # hides errcheck's report for any dropped fmt print/Close/Flush error by
    # name — but this CLI writes to an arbitrary io.Writer, and write
    # failures are part of run's error contract, so they must stay visible.
    presets: []
````


## `.goreleaser.yaml`

````yaml
# yaml-language-server: $schema=https://goreleaser.com/static/schema.json
#
# .goreleaser.yaml — the release plan: what a v* tag builds, archives,
# checksums, and drafts. `make release-check` runs the whole pipeline with
# --snapshot — no tag, no token, no publish — which is the dry run this
# chapter's gate is.
#
# The matrix is honest about what the engine can serve. The Turso driver
# calls a native library through purego, and the platform-libs module ships
# that library for exactly five targets: linux/amd64, linux/arm64,
# darwin/amd64, darwin/arm64, and windows/amd64. Two omissions are decisions
# chapter 20 measured, not oversights:
#
#   - windows/arm64: the build succeeds — the module's fallback is an empty
#     embed — and the binary fails at the first store open, with no engine
#     to extract. An artifact that cannot open its own database is not a
#     release target.
#   - 32-bit targets (386, arm): purego's fakecgo has no 32-bit
#     implementation, so the build fails inside the dependency, before any
#     code here compiles. They never enter the list; there is nothing to
#     exclude.
version: 2

project_name: todo

# Versioning: the release's name is its tag, and the tags are semver —
# vMAJOR.MINOR.PATCH. The app is pre-1.0 on purpose (v0.1.0 is the first
# release): the binaries' surface — the CLI's flags and JSON shapes, the
# HTTP API, the export format — can still move, and semver's pre-1.0 rule
# is that a breaking change bumps MINOR, not MAJOR. Once 1.0, the same
# change is a MAJOR. A -rc or -beta suffix makes a prerelease, and the
# release section below lets such a tag publish as one without a second
# switch to forget.

before:
  hooks:
    - go mod verify

builds:
  # One build per binary — the CLI, the server, and the TUI — and one shared
  # matrix: the anchor carries the settings all three agree on, and each
  # entry names only what differs. Every binary is stamped with the tag the
  # release was cut for; `todo version` prints it, the server and the TUI
  # record it at boot.
  - &build
    id: todo
    main: ./cmd/todo
    binary: todo
    env:
      - CGO_ENABLED=0
    flags:
      - -trimpath
    ldflags:
      - -s -w -X todo/internal/version.Version={{ .Version }}
    goos:
      - linux
      - darwin
      - windows
    goarch:
      - amd64
      - arm64
    ignore:
      - goos: windows
        goarch: arm64
  - <<: *build
    id: todo-server
    main: ./cmd/todo-server
    binary: todo-server
  - <<: *build
    id: todo-tui
    main: ./cmd/todo-tui
    binary: todo-tui

archives:
  # One archive per platform, all three binaries inside: a release user
  # unpacks once and has the CLI, the server, and the TUI of the same build.
  # Windows gets a zip because it is the format Windows unpacks without a
  # second tool; the rest get the tarball every Unix already reads.
  - id: todo
    ids:
      - todo
      - todo-server
      - todo-tui
    formats:
      - tar.gz
    format_overrides:
      - goos: windows
        formats:
          - zip
    name_template: todo_{{ .Version }}_{{ .Os }}_{{ .Arch }}
    files:
      - README.md

checksum:
  name_template: checksums.txt

changelog:
  # The changelog is the tag's story, written from the local history the dry
  # run reads too: `use: git` needs no API, no token, and no tags on a
  # remote, so the workflow and a laptop generate the same notes. The groups
  # map onto the conventional prefixes the history already speaks, and the
  # bookkeeping commits — tests, chores — stay out: the release is for
  # readers, not for the repository's own trail.
  use: git
  sort: asc
  abbrev: -1
  groups:
    - title: Features
      regexp: '^feat(\(.+\))?!?:'
      order: 0
    - title: Fixes
      regexp: '^fix(\(.+\))?!?:'
      order: 1
    - title: Documentation
      regexp: '^docs(\(.+\))?!?:'
      order: 2
    - title: Others
      order: 999
  filters:
    exclude:
      - '^test(\(.+\))?!?:'
      - '^chore(\(.+\))?!?:'

release:
  # The tag is the decision; the release it leaves behind is a draft, and
  # publishing is the second, deliberate act. `prerelease: auto` keeps a
  # -rc or -beta tag a prerelease without a second switch to forget.
  draft: true
  prerelease: auto

dockers_v2:
  # One image, two platforms, one Dockerfile: the server binary on a
  # distroless base (deploy/Dockerfile carries the base-image reasoning).
  # GoReleaser feeds the per-platform binaries into the build context, so
  # nothing is built inside the Dockerfile — and the image work happens in
  # the publish phase, where a --snapshot run builds the images locally, one
  # per platform, and a release pushes the manifest.
  #
  # The image name is a placeholder: put your own registry namespace here,
  # and the release workflow's login step pushes it with the repository's
  # token. `latest` follows every non-prerelease tag, the way readers expect
  # a moving name to move.
  - images:
      - ghcr.io/your-org/todo-server
    ids:
      - todo-server
    tags:
      - "{{ .Version }}"
      - "{{ if not .Prerelease }}latest{{ end }}"
    dockerfile: deploy/Dockerfile
    platforms:
      - linux/amd64
      - linux/arm64
````


## `Makefile`

````makefile
# The local gate. CI runs the same targets, so a green run here is a green
# run there. Tool versions are pinned here, once.

GOLANGCI_LINT_VERSION := v2.14.0
MOQ_VERSION           := v0.8.0
SQLC_VERSION          := v1.31.1
SWAG_VERSION          := v1.16.6
TEMPL_VERSION         := v0.3.1070

# The audit's three scanners, pinned like every other tool. gitleaks is
# required through its old module path on purpose: the project renamed to
# github.com/gitleaks/gitleaks, but the module's go.mod still declares
# github.com/zricethezav/gitleaks/v8, and `go run` resolves a tool by its
# declared path — the new path fails with "module declares its path as".
# syft is the heavyweight of the three: `go run` builds it from source,
# which is why `sbom` is a target of its own rather than part of check.
GITLEAKS_VERSION    := v8.30.1
GOVULNCHECK_VERSION := v1.9.0
SYFT_VERSION        := v1.54.1

# GoReleaser, pinned like every other tool — and pinned deliberately below
# the newest release: the v2.18 line's go.mod declares `go 1.27.x`, and this
# module's toolchain is 1.26.8, so `go run` refuses to build the tool at
# all. v2.17.1 is the newest release the pinned toolchain can run; the
# version moves when the Go directive does.
GORELEASER_VERSION := v2.17.1

# benchstat, for the benchmark gate's statistics and the bench target's human
# tables. The gate (cmd/benchgate) shells out to this pin: it builds the
# control revision's test binary and the working tree's, runs them
# alternately, and lets benchstat decide which differences the samples
# support. Nothing else in the module depends on golang.org/x/perf — the pin
# lives here, and the gate takes it as a flag so this stays the one place a
# tool version is written.
BENCHSTAT_VERSION := v0.0.0-20261009192801-be2c69fb417e

BENCHSTAT     := go run golang.org/x/perf/cmd/benchstat@$(BENCHSTAT_VERSION)

GITLEAKS      := go run github.com/zricethezav/gitleaks/v8@$(GITLEAKS_VERSION)
GOLANGCI_LINT := go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)
GORELEASER    := go run github.com/goreleaser/goreleaser/v2@$(GORELEASER_VERSION)
GOVULNCHECK   := go run golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)
SWAG          := go run github.com/swaggo/swag/cmd/swag@$(SWAG_VERSION)
SYFT          := go run github.com/anchore/syft/cmd/syft@$(SYFT_VERSION)
TEMPL         := go run github.com/a-h/templ/cmd/templ@$(TEMPL_VERSION)

.PHONY: fmt vet test race lint vulncheck leaks sbom generate check schema-update bench bench-gate cover deploy-check release-check release

# fmt fails when any .go file is not gofmt-clean.
fmt:
	@unformatted="$$(gofmt -l .)"; \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt would rewrite:"; echo "$$unformatted"; exit 1; \
	fi

vet:
	go vet ./...

test:
	go test -count=1 ./...

race:
	go test -race -count=1 ./...

lint:
	$(GOLANGCI_LINT) run

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

# generate runs every //go:generate directive in the module, then the swag
# pair and templ. The moq and sqlc versions in the directives are written
# literally: go generate expands environment variables ($VAR), never make
# variables, so $(MOQ_VERSION) or $(SQLC_VERSION) there would reach the tool
# as that literal text. The checks below keep each directive and its pin
# above in sync, and keep the query files ASCII: sqlc v1.31.1 counts token
# positions in runes but slices query text in bytes, so one multibyte
# character above a sqlc.slice query corrupts the generated text (reproduced
# with an em dash).
#
# swag is invoked from here rather than from a directive — its arguments are
# paths, and a directive in internal/api would have to spell them relative to
# that directory — so its pin lives only above. The check below keeps that pin
# and go.mod's github.com/swaggo/swag in sync: the generated docs.go imports
# the library, so the generator and the library must be the same version.
# swag fmt runs first, because swag init must generate from formatted
# annotations; a run that reformats anything leaves a diff for the staleness
# step in check to catch.
#
# templ is invoked from here for the same kind of reason: it walks the module
# for .templ files, and its generated _templ.go files import
# github.com/a-h/templ, so the check below keeps this pin and go.mod's in
# sync — a generator ahead of the library can emit code the library cannot
# compile. The .templ files and their generated Go live in internal/web.
generate:
	@pin="$$(grep -o 'matryer/moq@[^ ]*' internal/store/store.go || true)"; \
	if [ -n "$$pin" ] && [ "$$pin" != "matryer/moq@$(MOQ_VERSION)" ]; then \
		echo "internal/store/store.go pins $$pin; the Makefile pins matryer/moq@$(MOQ_VERSION)"; exit 1; \
	fi; \
	pin="$$(grep -o 'github.com/sqlc-dev/sqlc/cmd/sqlc@[^ ]*' internal/store/store.go || true)"; \
	if [ -n "$$pin" ] && [ "$$pin" != "github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)" ]; then \
		echo "internal/store/store.go pins $$pin; the Makefile pins github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)"; exit 1; \
	fi; \
	pin="$$(grep -o 'github.com/swaggo/swag v[^ ]*' go.mod || true)"; \
	if [ -n "$$pin" ] && [ "$$pin" != "github.com/swaggo/swag $(SWAG_VERSION)" ]; then \
		echo "go.mod pins $$pin; the Makefile pins github.com/swaggo/swag $(SWAG_VERSION)"; exit 1; \
	fi; \
	pin="$$(grep -o 'github.com/a-h/templ v[^ ]*' go.mod || true)"; \
	if [ -n "$$pin" ] && [ "$$pin" != "github.com/a-h/templ $(TEMPL_VERSION)" ]; then \
		echo "go.mod pins $$pin; the Makefile pins github.com/a-h/templ $(TEMPL_VERSION)"; exit 1; \
	fi; \
	nonascii="$$(grep -rlP '[^\x00-\x7F]' internal/db/queries || true)"; \
	if [ -n "$$nonascii" ]; then \
		echo "sqlc reads these files; keep them ASCII:"; echo "$$nonascii"; exit 1; \
	fi
	go generate ./...
	$(TEMPL) generate
	$(SWAG) fmt -d cmd/todo-server,internal/api -g main.go
	$(SWAG) init -g cmd/todo-server/main.go -o internal/api/docs --parseInternal

# check is the full local gate: format, vet, lint, the two scanners — the
# vulnerability database and the history's secrets — regenerate — failing if
# that changed anything, because generated code must be committed — then
# test. The schema golden is part of the test step: TestMigratedSchemaMatchesGolden
# compares the migrated schema with internal/db/schema.sql, and schema-update
# below regenerates that file.
check: fmt vet lint vulncheck leaks generate
	@git diff --exit-code || { echo "generated files are stale: run make generate and commit"; exit 1; }
	go test -count=1 ./...

# deploy-check is the deploy dry run: the parts of the deployment that can be
# checked on this machine. systemd-analyze parses the unit files offline —
# no manager needed — and scores the server unit's hardening; the committed
# files name the installed paths, so the check runs on copies with ExecStart
# and the credential path rewritten into a scratch directory (the rewrite is
# the one difference from what the chapter committed). The threshold is the
# score the chapter earned, with room for a systemd version's scoring drift:
# 1.5 exposed is 15%, and the gate refuses over 25%. The drain and the backup
# contracts are the tests the chapter added, run by name so the deploy gate
# is one command.
deploy-check:
	@command -v systemd-analyze >/dev/null || { echo "deploy-check needs systemd-analyze"; exit 1; }
	@tmp="$$(mktemp -d)"; trap 'rm -rf "$$tmp"' EXIT; \
	go build -o "$$tmp/todo-server" ./cmd/todo-server; \
	install -m 0400 /dev/null "$$tmp/admin-key"; \
	install -D -m 0755 deploy/todo-backup.sh "$$tmp/todo-backup"; \
	sed -e "s|/usr/local/bin/todo-server|$$tmp/todo-server|" \
	    -e "s|/etc/todo/admin-key|$$tmp/admin-key|" \
	    deploy/todo-server.service > "$$tmp/todo-server.service"; \
	sed -e "s|/usr/local/lib/todo/todo-backup|$$tmp/todo-backup|" \
	    -e "s|/usr/local/bin/todo|$$tmp/todo-server|" \
	    deploy/todo-backup.service > "$$tmp/todo-backup.service"; \
	cp deploy/todo-backup.timer "$$tmp/todo-backup.timer"; \
	systemd-analyze verify "$$tmp/todo-server.service" "$$tmp/todo-backup.service" "$$tmp/todo-backup.timer"; \
	systemd-analyze security --offline=yes --threshold=25 "$$tmp/todo-server.service" | tail -1
	go test -count=1 -run 'TestGracefulShutdown_Drains|TestBackupScript_Restores' ./cmd/todo-server

# release-check is the release dry run: the whole matrix built, archived,
# and checksummed into dist/ with no tag, no token, and no publish — the
# same pipeline the release workflow runs, minus the two things a laptop
# cannot give it. One of those is the image: the docker phase needs a
# container runtime, and when none is present it is skipped with the reason
# printed rather than failing the gate. The other is the git state: with no
# remote, GoReleaser's git pipe falls back to its fake snapshot info, so the
# dry-run artifacts carry 0.0.0-SNAPSHOT-none and an empty changelog — the
# pipeline is exercised, the version is the tool's placeholder, and the
# notes say so.
release-check:
	@if docker info >/dev/null 2>&1; then \
		$(GORELEASER) release --snapshot --clean; \
	else \
		echo "release-check: no container runtime; skipping the image phase (--skip=docker)"; \
		$(GORELEASER) release --snapshot --clean --skip=docker; \
	fi

# release is the real thing: a tagged commit and GITHUB_TOKEN in the
# environment, leaving a draft on the release page for a human to publish.
# The release workflow runs exactly this target, so the local and the CI
# runs are one command.
release:
	$(GORELEASER) release --clean

# schema-update rewrites the schema golden from the embedded migrations, for
# the one case the drift check cannot decide for you: a schema change you
# made on purpose.
schema-update:
	UPDATE_SCHEMA=1 go test -run TestMigratedSchemaMatchesGolden ./internal/db

bench:
	go test -bench=. -benchmem -count=10 ./internal/store

# bench-gate is the performance gate: the working tree's benchmarks, run
# alternately with a test binary built from the revision each committed
# baseline names in its "# control-ref:" header line, compared by benchstat
# and judged by the policy in internal/benchgate (no extra allocations, no
# more than 5% more bytes, no more than 25% more time, and nothing at all for
# a difference the samples cannot separate from noise).
#
# The two-binary shape is chapter 12's interleaving method, executable: the
# comparison happens inside one session, on one machine, so load, frequency,
# and thermal state are shared and the gate does not depend on where it runs.
# The price is the build: each gate run compiles the control revision's test
# binaries as well as the current ones. It is minutes, not seconds, which is
# why it is its own target and a CI job of its own — not part of check.
bench-gate:
	go run ./cmd/benchgate -benchstat='$(BENCHSTAT)' ./internal/store ./internal/web ./internal/api

cover:
	go test -count=1 -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out | tail -1
````


## `README.md`

````markdown
# todo — the reference application

The finished todo application from the book **Build a Todo App in Go** — the
tree every quote and transcript in the book was captured from.

It is not a starter project: the book carries the finished tree in full in
its reference appendix, and readers build their own from chapter one.
````


## `sqlc.yaml`

````yaml
# sqlc's config: SQL in, Go out. The schema source is the goose migration
# directory, not a second copy of the DDL — sqlc's goose parser reads only the
# statements between -- +goose Up and -- +goose Down, so the migration files
# stay the one place the schema lives, and internal/db/schema.sql keeps
# pinning what they produce for the tests. The queries live in their own
# directory; `out` is the db package itself, so the generated files sit next
# to migrate.go and share its package. Every path is relative to this file,
# which is what makes the //go:generate directive in internal/store/store.go
# work from a different working directory.
version: "2"
sql:
  - engine: "sqlite"
    schema: "internal/db/migrations"
    queries: "internal/db/queries"
    gen:
      go:
        package: "db"
        out: "internal/db"
````
