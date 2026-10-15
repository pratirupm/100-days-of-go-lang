---
title: Beyond this book
sidebar:
  order: 2
---

The app is finished, and it works. This page is a map of what to explore
next: how to keep reading Go, the tools the book chose, and a few roads out.

## Keep reading the standard library

The standard library is not a phase you finish; it is the code you keep
rereading, always on demand.

- **[pkg.go.dev](https://pkg.go.dev)** is the index: search, read the overview
  and the examples, then follow the `[src]` link — the implementation is
  often shorter than the prose around it.
- **`go doc`** answers without a browser: `go doc strings.Builder`, or
  `go doc -src errors.Is` to read one function's source.
- **Your editor** can jump straight to the definition of anything you call,
  the standard library included. Follow one call down and back.

## The tools this book chose

Every tool below earned its place in the build, and each has alternatives —
trying one is a good exercise.

- **echo** — the web API's router and middleware. Alternatives: `chi`, `gin`.
- **templ** — typed HTML components. Alternative: the standard library's
  `html/template`.
- **sqlc** — SQL in, typed Go out. Alternative: hand-written `database/sql`.
- **goose** — SQL migrations, embedded in the binary.
- **cobra** — the command-line tool's command tree.
- **log/slog** — structured logging. Alternatives: `zap`, `zerolog`.
- **testify**, **go-cmp**, **go-snaps**, **moq** — assertions, diffs,
  snapshots, and generated test doubles.
- **Bubble Tea** — the terminal interface's event loop, with Lip Gloss for
  styling.
- **OpenTelemetry** and **Prometheus** — traces and metrics.
- **GoReleaser** — cross-compiled releases.

## Roads out

A few directions, each with a first step:

- **Another database.** `pgx` is the common Postgres driver, and both sqlc
  and goose speak Postgres. The store interface is the seam; start with a
  scratch module against a database in a container.
- **Another interface.** `htmx` adds interactivity without a full JavaScript
  app; `Wails` wraps a desktop window around your Go backend; `Gio` is the
  immediate-mode toolkit closest to the terminal interface's loop; WebAssembly
  builds Go for the browser.
- **Background work.** A timer or a cron-style scheduler covers time-based
  jobs; when a job must survive a restart, move it to a durable queue.
- **More observability.** The OpenTelemetry Collector, dashboards, and
  alerts on top of the traces and metrics the app already emits.
- **More performance.** Profile-guided optimization, garbage-collector tuning,
  and longer benchmark series — one change at a time.
- **More correctness.** Longer fuzzing campaigns and mutation testing, which
  asks whether your tests would notice a bug at all.

Everything here is optional; the habit under it is not: read the code you
depend on, reach for `go doc` and the `[src]` link before a search engine,
and when the bug is in someone else's package, send the fix.
