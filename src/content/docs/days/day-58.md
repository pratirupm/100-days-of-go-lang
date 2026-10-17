---
title: "Day 58 — Releases"
description: "Stamp a version name into every build, then turn the app into downloadable archives with one command. — Day 58 of 100 Days of Go Lang."
sidebar:
  order: 58
chapter: 49
---

**About 3 hours** · Part X, day 5 of 6.

**You'll be able to:**

- stamp the version into the binary;
- cut release archives and a container image with GoReleaser.

---

Every piece of the app works now: the command line, the server, the web pages,
the terminal interface. The last step is putting the app into files that
someone else can download and run. That set of files is a **release**.

A release is a handful of archives. An **archive** is one file holding several
files, like a folder packed into a single download. There is one archive for
each kind of computer the app runs on, and each holds the ready-to-run
programs. Every build also gets a **version**: a short name, like `v0.1.0`, so
people can say which one they have.

The app learns one new command along the way, `todo version`, which answers
with the name of the build it belongs to — before any data exists, on a
machine that has never seen the app. By the end, a single command builds the
whole set on your machine: five archives, three programs inside each, a
checksum list beside them, and a small Linux image of the server. Then we
unpack one archive and drive it exactly as a stranger would.

## The test comes first

Every feature in this book starts with the test that says what it must do,
and this one has two halves. A plain build — the kind `go build` makes — must
answer `dev`. A build given a stamp while it is being made must answer with
that stamp. Both answers must come out without a database, because a release
user's first command runs before any data exists.

The file `cmd/todo/integration_test.go` already has a helper that runs the
suite's own binary. The new test builds a second binary for itself, so the
helper gains a companion. Give `runBinary` this shape:

<!-- verify: cmd/todo/integration_test.go at=release -->
```go title="cmd/todo/integration_test.go"
// runBinary runs TestMain's binary with the given environment and returns
// what the process printed and how it exited.
func runBinary(t *testing.T, env []string, args ...string) binaryResult {
	t.Helper()
	return runBinaryAt(t, binPath, env, args...)
}

// runBinaryAt runs the binary at bin — TestMain's or one a test built for
// itself — with the given environment and returns what the process printed
// and how it exited.
func runBinaryAt(t *testing.T, bin string, env []string, args ...string) binaryResult {
	t.Helper()
	// #nosec G204 -- bin is built by TestMain or by the calling test from
	// this package's own source, and args are test-authored literals.
	cmd := exec.Command(bin, args...)
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		require.ErrorAs(t, err, &exitErr, "todo %s", strings.Join(args, " "))
		code = exitErr.ExitCode()
	}
	return binaryResult{stdout: stdout.String(), stderr: stderr.String(), code: code}
}
```

`runBinary` keeps its old job — the binary the suite built, kept in `binPath`
— and hands the work to `runBinaryAt`, which takes any binary's path. Then
add the test itself, at the end of the file:

<!-- verify: cmd/todo/integration_test.go at=release -->
```go title="cmd/todo/integration_test.go"
// TestBinary_Version is the version contract: the release stamps the tag
// into the binary with -ldflags -X and the binary reports it. The two builds
// are the two halves — the injected stamp, and the honest default every
// plain `go build` carries — and both must answer without a database, which
// is the one thing `todo version` may not need.
func TestBinary_Version(t *testing.T) {
	t.Parallel()

	// TestMain's binary is what `go build ./cmd/todo` produces, version-wise:
	// -cover instruments it, but no ldflags reach it, so the default must
	// come out and no store may be opened to print it.
	dbPath := filepath.Join(t.TempDir(), "todo.db")
	plain := runBinary(t, binaryEnv(dbPath), "version")
	require.Equal(t, 0, plain.code, "version failed: %s", plain.stderr)
	assert.Equal(t, "dev\n", plain.stdout, "a build without a stamp reports the honest default")
	assert.NoFileExists(t, dbPath, "version answers without opening a store")

	// The stamped build uses the release's own invocation: -X names
	// internal/version's variable, the same string .goreleaser.yaml passes.
	// The test spells the import path out rather than sharing a constant
	// with the code, because the path is the contract — a rename that moved
	// the stamp would fail here exactly as it would fail the release.
	stamped := buildStampedBinary(t, "v9.9.9-test")

	env := binaryEnv(filepath.Join(t.TempDir(), "todo.db"))
	res := runBinaryAt(t, stamped, env, "version")
	require.Equal(t, 0, res.code, "stamped version failed: %s", res.stderr)
	assert.Equal(t, "v9.9.9-test\n", res.stdout)

	json := runBinaryAt(t, stamped, env, "version", "--json")
	require.Equal(t, 0, json.code, "version --json failed: %s", json.stderr)
	assert.JSONEq(t, `{"version":"v9.9.9-test"}`, json.stdout)
}
```

Read the middle. The test builds a stamped copy of the CLI with
`buildStampedBinary(t, "v9.9.9-test")`, runs it, and asks both formats for
the name: one line for a person, one JSON object for a script. Add the helper
below the test:

<!-- verify: cmd/todo/integration_test.go at=release -->
```go title="cmd/todo/integration_test.go"
// buildStampedBinary builds cmd/todo with the release's ldflags shape and
// returns the binary's path. `go test` runs the suite with cmd/todo as the
// working directory, so `.` is the package GoReleaser's main field names.
func buildStampedBinary(t *testing.T, version string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "todo")
	// #nosec G204 -- the command is a literal; the stamp and the output
	// path are test-authored.
	cmd := exec.Command("go", "build", "-o", bin,
		"-ldflags", "-X todo/internal/version.Version="+version, ".")
	cmd.Stderr = os.Stderr
	require.NoError(t, cmd.Run(), "build with the release's ldflags")
	return bin
}
```

The helper is the release's own invocation in miniature: `go build` with
`-ldflags -X todo/internal/version.Version=<name>`. The test spells that
import path out in its own words rather than sharing it with the code,
because the path is the contract between the build and the binary.

With only the test in the tree, run just this case:

```bash
$ go test -count=1 -run TestBinary_Version ./cmd/todo
--- FAIL: TestBinary_Version (0.05s)
    integration_test.go:221:
        	Error Trace:	…/cmd/todo/integration_test.go:221
        	Error:      	Not equal:
        	            	expected: 0
        	            	actual  : 1
        	Test:       	TestBinary_Version
        	Messages:   	version failed: warning: GOCOVERDIR not set, no coverage data emitted
        	            	unknown command "version" for "todo"
FAIL
FAIL	todo/cmd/todo	1.064s
```

`unknown command "version" for "todo"` — the command does not exist yet, so
the test fails, exactly as it should. But read what did *not* fail: the
stamped build inside the test succeeded. The linker took a flag naming a
variable that does not exist and said nothing. A build cannot catch a moved
name; only this test can, and it will.

## A name for every build

A version is a name you give one build, so people can say which one they
have. A build made by hand from the source tree reports `dev` — an honest
label that means "not a release". A release gets a real name, like `v0.1.0`.

The name lives in a package of its own, because all three programs — the
CLI, the server, and the TUI — must report the same one. Create
`internal/version/version.go`:

<!-- verify: internal/version/version.go at=release -->
```go title="internal/version/version.go"
// Package version owns the one string every binary reports about itself.
//
// The variable is the seam the release stamps through: GoReleaser passes
// -ldflags "-X todo/internal/version.Version={{ .Version }}", and the import
// path in that flag is the contract. A package of its own — rather than a
// variable in internal/cli — is what keeps the name stable and the stamp
// reachable from every main under cmd/. The default is honest on purpose: a
// binary built from a working tree is not a release, and "dev" says so.
package version

// Version is the release version, stamped at build time. A plain `go build`
// leaves the default; only the release pipeline changes it, and only to the
// tag the ... was built for.
var Version = "dev"
```

One variable is the whole mechanism, and the comment above it is the
contract. The release passes
`-ldflags "-X todo/internal/version.Version={{ .Version }}"` to the build:
`-ldflags` hands settings to the linker, and `-X importpath.name=value`
fills a text variable in at link time, after the code is compiled.

The import path in that flag has to match the file exactly; a moved variable
would not fail the build, it would just leave `dev` in place — which is what
the test we just wrote is watching.

A plain `go build` passes no such flag, so a binary built by hand always says
`dev`.

## The command that answers

Now the command itself. Create `internal/cli/version.go`:

<!-- verify: internal/cli/version.go at=release -->
```go title="internal/cli/version.go"
package cli

import (
	"fmt"

	"github.com/spf13/cobra"

	"todo/internal/version"
)

// newVersionCmd builds the version command: the release's answer to "which
// build is this?", and the one command that answers without a store. It
// replaces the tree's pre-run hook with an empty one — cobra runs the
// closest PersistentPreRunE, not every ancestor's — so no database path is
// resolved and no store is opened: a release user runs `todo version` before
// any data exists, and the command must not create any. The process logger
// main built still exists; this command writes no records.
func newVersionCmd(sess *session) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the version",
		Long: `Print the version this binary was built with.

Release binaries are stamped at build time from the tag they were built
for; a binary built from a working tree reports "dev".`,
		Args: cobra.NoArgs,
		// The store is opened by the root's pre-run; version answers
		// without a database, so it overrides the hook with an empty one.
		PersistentPreRunE: func(*cobra.Command, []string) error { return nil },
		RunE: func(cmd *cobra.Command, _ []string) error {
			if sess.json {
				return writeJSON(cmd.OutOrStdout(), jsonVersion{Version: version.Version})
			}
			_, err := fmt.Fprintln(cmd.OutOrStdout(), version.Version)
			return err
		},
	}
}

// jsonVersion is version --json's object: one key, under the same
// stable-key discipline as every other command's JSON.
type jsonVersion struct {
	Version string `json:"version"`
}
```

Two details deserve a look. The command defines its own `PersistentPreRunE` —
an empty one — because every other command opens the database before it
runs, and this one has to answer before any data exists: a fresh machine has
no database, and printing a name must not create one. And `--json` follows
the app's two-format rule: one line for a person, one object for a script.

One line joins the command to the tree. In `internal/cli/cli.go`, the list of
commands gains its last entry:

<!-- verify: internal/cli/cli.go at=release -->
```go title="internal/cli/cli.go"
	root.AddCommand(
		newAddCmd(&sess),
		newListCmd(&sess),
		newDoneCmd(&sess),
		newStatsCmd(&sess),
		newImportCmd(&sess),
		newAdminCmd(&sess),
		newVersionCmd(&sess),
	)
```

`Args: cobra.NoArgs` says the command takes no arguments, and the tree
enforces that instead of ignoring them.

Run the test again: it passes now. A plain build reports `dev`, a stamped
build reports `v9.9.9-test`, and neither one creates a database file.

## The stamp at boot

The CLI can be asked which build it is. The server and the TUI run in the
background, where nobody can ask, so they put the name in their first log
record instead. In `cmd/todo-server/main.go`, the listening record gains one
attribute:

<!-- verify: cmd/todo-server/main.go at=release -->
```go title="cmd/todo-server/main.go"
	// The release stamp is part of the boot record: an operator looking at
	// a running host can read which tag built the binary, without asking
	// the deployment. "dev" on a release host is the honest signal that
	// the binary was built by hand.
	logger.Info("server listening", "addr", cfg.Listen, "version", version.Version)
```

The record now carries the name beside the address it listens on, so an
operator reading a running host's log can name the build without asking the
deployment. In `cmd/todo-tui/main.go`, the debug record that names the
resolved paths gains it too:

<!-- verify: cmd/todo-tui/main.go at=release -->
```go title="cmd/todo-tui/main.go"
	// The resolved paths are the first debug record, the CLI's own
	// "why is my data not where I thought" answer, on the TUI's side of the
	// pair. The release stamp rides along: the TUI's only diagnostic surface
	// is this file, and which build wrote it is the first question a bug
	// report asks.
	logger.Debug("config resolved", "api", apiURL, "log", logPath, "version", version.Version)
```

Both files need `todo/internal/version` added to their import lists, beside
the project's other imports. Now the first record a running server writes
names the build it runs — the first fact a bug report needs.

## The release plan

GoReleaser is a tool that reads a plan and builds, archives, and checksums
the programs — on your machine, from your source. Create `.goreleaser.yaml`
at the project root, starting with the shape of the release and the three
programs:

<!-- verify: .goreleaser.yaml at=release -->
```yaml title=".goreleaser.yaml"
version: 2

project_name: todo

# ...

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
```

Read the pieces. `before: go mod verify` re-checks that the module's
fingerprints still match before anything is built for shipping. `builds`
holds one entry per program, each naming the package that carries its `main`.
The first entry is the anchor — `&build` names it, and `<<: *build` copies it
— so settings all three share are written once.

The flags do the packing: `CGO_ENABLED=0` builds without the C toolchain,
`-trimpath` strips the build machine's folder names out of the binary, and
`-s -w` drops the debug information users don't need. `-X` stamps the version
name in. The matrix covers Linux, macOS, and Windows on 64-bit Intel and ARM
chips, minus the one pair in `ignore`.

The other two builds inherit the anchor:

<!-- verify: .goreleaser.yaml at=release -->
```yaml title=".goreleaser.yaml"
  - <<: *build
    id: todo-server
    main: ./cmd/todo-server
    binary: todo-server
  - <<: *build
    id: todo-tui
    main: ./cmd/todo-tui
    binary: todo-tui
```

Each names only what differs from it. The archives carry the project's
`README.md`; if yours has none yet, create a minimal one at the project root
— a title and a sentence about the app are enough. Now the archives and the
checksums:

<!-- verify: .goreleaser.yaml at=release -->
```yaml title=".goreleaser.yaml"
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
```

One archive per platform, with all three programs and the README inside, so
a release user unpacks once and has everything from the same build. Windows
gets a zip — the format Windows opens without another tool — and the rest get
a tarball. The `name_template` is where the version name lands in the file
name, beside the operating system and the chip kind. `checksum:` writes
`checksums.txt`: one short code per archive, so a download can be checked for
damage.

And the image:

<!-- verify: .goreleaser.yaml at=release -->
```yaml title=".goreleaser.yaml"
dockers_v2:
  # One image, two platforms, one Dockerfile: the server binary on a
  # distroless base (deploy/Dockerfile carries the base-image reasoning).
  # GoReleaser feeds the per-platform binaries into the build context, so
  # nothing is built inside the Dockerfile — and the image work happens in
  # the publish phase, where a --snapshot run builds the images locally, one
  # per platform, and a release pushes the manifest.
  #
  # ...
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
```

The plan builds one image of the server from the Dockerfile below — one for
each of the two Linux platforms it ships for. The image's name is a
placeholder to replace with your own registry path, and the `latest` name
follows every full release, the way a moving name is expected to move.

## The release image

A **container image** is a ready-to-run bundle: the server plus the small
slice of Linux it needs, packed as one thing a server can start with a single
command. Create `deploy/Dockerfile`:

<!-- verify: deploy/Dockerfile at=release -->
```dockerfile title="deploy/Dockerfile"
# deploy/Dockerfile — the release image: the server binary on a distroless
# base, nothing else. GoReleaser builds it from the binaries it already
# built; this file copies one into place. The name is deploy/Dockerfile
# because the image is deployment material, next to the unit it is the
# container-shaped alternative to.
#
# ...
FROM debian:12-slim AS data
RUN install -d /data && touch /data/.volume

FROM gcr.io/distroless/base-debian12:nonroot

ARG TARGETPLATFORM
COPY --from=data --chown=65532:65532 /data /data
COPY $TARGETPLATFORM/todo-server /usr/local/bin/todo-server

# The engine extracts its native library on first open — a cache, so the
# container's ephemeral /tmp is exactly the right place — and the database
# is a file on the volume. TODO_LISTEN binds every interface of the
# container's own network namespace, which is the boundary here; the unit's
# loopback default exists because Caddy shares the host with it, and a
# container's neighbors do not. The admin key is the operator's secret to
# mount and name (TODO_ADMIN_KEY_FILE); a container without one serves, and
# has no admin, exactly like a server without one.
ENV TURSO_GO_CACHE_DIR=/tmp/turso-go \
    TODO_DB=/data/todo.db \
    TODO_LOG=/data/todo.log \
    TODO_LISTEN=:8080

VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/todo-server"]
```

Three parts carry the idea. The final image starts from a distroless base —
a Linux with no shell and no package manager, just what a running program
needs. The database engine calls into the system's C library while it runs,
so a truly empty base could not open the store.

The `/data` folder is made in a throwaway first stage, because the final
image has no shell to make folders in, and it belongs to the image's nonroot
user (65532), so a mounted volume can be written.

The server binary is copied in from `$TARGETPLATFORM/todo-server` — a path
GoReleaser fills with the binary it already built, so nothing is compiled
inside the image. The environment block points the database and the log at
`/data`, the engine's cache at `/tmp`, and the server at port 8080.

## One command builds the set

The plan describes; the `Makefile` runs. The project's Makefile keeps its
longer commands under names, and the release adds three things. First the
tool's pin, beside the other pinned tools:

<!-- verify: Makefile at=release -->
```make title="Makefile"
# GoReleaser, pinned like every other tool — and pinned deliberately below
# the newest release: the v2.18 line's go.mod declares `go 1.27.x`, and this
# module's toolchain is 1.26.8, so `go run` refuses to build the tool at
# all. v2.17.1 is the newest release the pinned toolchain can run; the
# version moves when the Go directive does.
GORELEASER_VERSION := v2.17.1
```

The pin names the exact GoReleaser the build uses, and the comment above it
says why it isn't the newest — the error entry below tells that story. The
next line turns the name into a command:

<!-- verify: Makefile at=release -->
```make title="Makefile"
GORELEASER    := go run github.com/goreleaser/goreleaser/v2@$(GORELEASER_VERSION)
```

Every tool in the file has a line like it: `go run` downloads that exact
version, builds it with your Go, and runs it — nothing is installed and
nothing needs upgrading.

One more name sits above the release recipe: the deployment's dry run. It
wraps the parts of the deployment that can be checked on this machine — it
builds the server into a scratch folder, points copies of the unit files at
it, asks `systemd-analyze` to parse them and score the server's hardening,
and runs the two tests that prove a stop drains and a backup restores:

<!-- verify: Makefile at=release -->
```make title="Makefile"
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
```

Every line works on copies in a scratch folder: the unit files in the
project name the installed paths, so the check rewrites them rather than
touching the machine's real ones. And the release recipe itself comes after
it:

<!-- verify: Makefile at=release -->
```make title="Makefile"
release-check:
	@if docker info >/dev/null 2>&1; then \
		$(GORELEASER) release --snapshot --clean; \
	else \
		echo "release-check: no container runtime; skipping the image phase (--skip=docker)"; \
		$(GORELEASER) release --snapshot --clean --skip=docker; \
	fi
```

The recipe asks whether a container tool called Docker is running on this
machine. If one is, the whole build runs, image included; if not, the image
step is skipped with the reason printed, so a skipped step is never a silent
one, and the archives are built either way.

Now run it:

```bash
$ make release-check
release-check: no container runtime; skipping the image phase (--skip=docker)
  • starting release
  • skipping announce, docker, publish, and validate...
  • cleaning distribution directory
  • loading environment variables
  ...
  • building binaries
    • building                                       paths=cmd/todo binaries=todo target=linux_amd64_v1
    • building                                       paths=cmd/todo-server binaries=todo-server target=linux_arm64_v8.0
    • building                                       paths=cmd/todo-tui binaries=todo-tui target=windows_amd64_v1
    ...
  • archives
    • archiving                                      name=dist/todo_0.0.0-SNAPSHOT-none_darwin_amd64.tar.gz
    • archiving                                      name=dist/todo_0.0.0-SNAPSHOT-none_darwin_arm64.tar.gz
    • archiving                                      name=dist/todo_0.0.0-SNAPSHOT-none_linux_amd64.tar.gz
    • archiving                                      name=dist/todo_0.0.0-SNAPSHOT-none_linux_arm64.tar.gz
    • archiving                                      name=dist/todo_0.0.0-SNAPSHOT-none_windows_amd64.zip
  • calculating checksums
  • writing artifacts metadata
  • release succeeded after 15s
  • thanks for using GoReleaser!
```

Read it like a receipt. The first line is the recipe's own note: this machine
has no container runtime, so the image step is skipped. `--snapshot` means
build everything and publish nothing; `--clean` means start from an empty
`dist/` folder.

The tool verifies the module, builds fifteen binaries — five targets times
three programs — packs them into five archives, and writes the checksums.
The name `0.0.0-SNAPSHOT-none` is the tool's placeholder for a rehearsal
build: no version name was given, and the tool says so instead of dressing
the run up. A real release carries the name you gave it, and every binary
reports that.

## A release user's first run

Everything the release ships now sits in `dist/`. Make a scratch folder
called `verify`, unpack the archive for this kind of computer into it, and
look inside:

```bash
$ tar -xzf dist/todo_0.0.0-SNAPSHOT-none_linux_amd64.tar.gz -C verify
$ ls -l verify
-rw-r--r--. 1 pm pm      320 README.md
-rwxr-xr-x. 1 pm pm 26550537 todo
-rwxr-xr-x. 1 pm pm 51061001 todo-server
-rwxr-xr-x. 1 pm pm  8114441 todo-tui
```

One archive, three programs, and the README. The server is the heavyweight —
the database engine, the web stack, and the embedded interface all ride
inside it.

Now drive the CLI the way a stranger would, from inside `verify`:

```bash
$ ./todo version
0.0.0-SNAPSHOT-none

$ ./todo add "a release that runs"
{"time":"…","level":"INFO","msg":"task added","id":"01a13f79-…","title":"a release that runs"}
01a13f79-4af8-73eb-9e29-e60519bf0839

$ ./todo list
01a13f79-4af8-73eb-9e29-e60519bf0839  Todo  a release that runs
```

The CLI answers with the name the rehearsal stamped into it, opens its own
database, adds a task, and lists it. A file built by the release command and
unpacked into a folder runs like any other program.

## If something went wrong

**`requires go >= 1.27.1` — the newest GoReleaser cannot be built.**

```bash
go: github.com/goreleaser/goreleaser/v2@v2.18.3: github.com/goreleaser/goreleaser/v2@v2.18.3 requires go >= 1.27.1 (running go 1.26.8; GOTOOLCHAIN=local)
```

GoReleaser 2.18 is written for a newer Go than this project runs, and Go
refuses to fetch a newer toolchain here, so the newest release of the tool
cannot even be compiled. The fix is the pin: `v2.17.1` is the newest
GoReleaser this project's Go can build, and the comment above the pin says
why, so nobody "updates" it back into a broken state. The rule behind it:
`go run tool@version` builds the tool with your own Go, so the tool's own
`go.mod` is part of the choice.

**`build failed: build for todo does not contain a main function` — the tool
ran without a plan.**

<!-- transcripts: authored -->
```bash
  ⨯ release failed after 0s
    error=
    │ build failed: build for todo does not contain a main function
    │ Learn more at https://goreleaser.com/resources/errors/no-main/
    target=windows_386_sse2
exit status 1
```

With no `.goreleaser.yaml`, the tool guesses: it assumes the main program
sits at the project root — it doesn't; the programs live under `cmd/` — and
it aims at a list that includes 32-bit Windows. The fix is the plan: three
builds with their `main` paths, and the five-target list.

**`field checksums not found in type config.Project` — the key is singular.**
The `checksum:` section writes the checksums file, and the key is singular
even though the file and the idea are plural. Write `checksums:` and the tool
refuses the whole file; its validator names the line, which is how you find
it. The fix is one letter.

**`disk quota exceeded` in the middle of the build.**

```bash
compile: writing output: write $WORK/b220/_pkg_.a: disk quota exceeded
```

Go builds through a scratch folder, and fifteen cross-builds at once can fill
a small one — this machine's scratch space is a 7.7 GiB memory disk. Point
the run at a bigger disk with `TMPDIR=/var/tmp make release-check`. The
message never says "disk", which is why it is worth knowing.

<details>
<summary>Going deeper: why the linker never complains</summary>

`-X importpath.name=value` fills a variable in at link time, and the linker
does not check that the name exists. A flag naming nothing is ignored: the
build succeeds, and the binary carries `dev`. That is why the test spells the
import path out in its own words instead of sharing a constant with the code
— if `Version` were ever renamed, the test would fail loudly while the build
stayed quiet. Three places spell the same path: the package comment, the
plan's `ldflags`, and the test.

</details>

<details>
<summary>Going deeper: why the matrix stops at five targets</summary>

The database engine is a native library — a compiled piece of code, not Go —
and it arrives through a layer that hands the program ready-made versions for
exactly five kinds of computer: linux/amd64, linux/arm64, darwin/amd64,
darwin/arm64, and windows/amd64.

Two omissions follow. `windows/arm64` builds, because the missing library is
replaced by an empty stub, and then dies at the first store open: an artifact
that cannot open its own database is not shipped. And 32-bit targets (386,
arm) do not build at all — the native-call layer has no 32-bit implementation
— so they never enter the list.

</details>

<details>
<summary>Going deeper: what the numbers in a version mean</summary>

`v0.1.0` is the shape: a `v`, then three numbers. The first number changes
when the app breaks a promise its users rely on; the second when it gains
something new; the third when it fixes something. The app sits at 0.x on
purpose — before 1.0, the promises can still move, and the second number
carries that news. A name with an `-rc` suffix marks a preview build.

</details>

<details>
<summary>Going deeper: why `-trimpath` makes two builds come out identical</summary>

A Go binary normally remembers the folder it was built in, so two builds of
one source tree in two folders differ. `-trimpath` strips those folder names
down to their module-relative form. Measure it: copy the project into two
folders and build both with the release's own flags — the same `-s -w` and
`-X` the plan passes — first without `-trimpath`:

```bash
$ sha256sum repro/todo-plain-a repro/todo-plain-b
4c3ff40a7f56889e…  repro/todo-plain-a
e7a54ed8a9737678…  repro/todo-plain-b

$ sha256sum repro/todo-trimpath-a repro/todo-trimpath-b
6695174f43b45a87…  repro/todo-trimpath-a
6695174f43b45a87…  repro/todo-trimpath-b
```

Two codes, so two different files. The second pair of builds adds `-trimpath`
and comes out with one code, twice. The claim is narrow on purpose: the same
source, the same Go, the same flags, the same bytes — not a promise about
another machine's Go.

</details>

The archives are one command away, and every copy says which build it came
from — next, the server inside them gets faster, with numbers to prove it.

<div class="day-tracker" data-day="58"></div>
