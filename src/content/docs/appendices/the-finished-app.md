---
title: The finished app (spoilers)
description: The finished application, file by file — the state every chapter builds toward, with spoilers.
sidebar:
  order: 1
tableOfContents: false
pagefind: false
---

> **Spoilers.** The finished application, file by file — the state every
> chapter builds toward, and the tree every quote and transcript in this
> book was captured from. Use it to compare and to unstick; don't copy
> files wholesale. Generated code and artifacts (the `sqlc` output, the
> `moq` mocks, the `templ` output, the SBOM) are not reproduced here —
> `make generate` and `make sbom` produce them — and `go.sum` is what
> `go mod tidy` resolves. A few files are the app's own machinery rather
> than part of the build the chapters walk through — the workflow files
> under `.github/` and the `cmd/benchgate` tool — kept here so the tree
> is complete. Each section is the file's source, exactly as it lives in
> the project.

## The files, by directory

- [The project root](/100-days-of-go-lang/appendices/the-finished-app/root-files/) — 7 files
- [cmd/benchgate](/100-days-of-go-lang/appendices/the-finished-app/cmd-benchgate/) — 1 files
- [cmd/todo](/100-days-of-go-lang/appendices/the-finished-app/cmd-todo/) — 7 files
- [cmd/todo-server](/100-days-of-go-lang/appendices/the-finished-app/cmd-todo-server/) — 4 files
- [cmd/todo-tui](/100-days-of-go-lang/appendices/the-finished-app/cmd-todo-tui/) — 1 files
- [deploy](/100-days-of-go-lang/appendices/the-finished-app/deploy/) — 7 files
- [docs](/100-days-of-go-lang/appendices/the-finished-app/docs/) — 1 files
- [.github](/100-days-of-go-lang/appendices/the-finished-app/github/) — 3 files
- [internal/api](/100-days-of-go-lang/appendices/the-finished-app/internal-api/) — 23 files
- [internal/audit](/100-days-of-go-lang/appendices/the-finished-app/internal-audit/) — 6 files
- [internal/auth](/100-days-of-go-lang/appendices/the-finished-app/internal-auth/) — 10 files
- [internal/benchgate](/100-days-of-go-lang/appendices/the-finished-app/internal-benchgate/) — 2 files
- [internal/cli](/100-days-of-go-lang/appendices/the-finished-app/internal-cli/) — 5 files
- [internal/client](/100-days-of-go-lang/appendices/the-finished-app/internal-client/) — 2 files
- [internal/config](/100-days-of-go-lang/appendices/the-finished-app/internal-config/) — 2 files
- [internal/db](/100-days-of-go-lang/appendices/the-finished-app/internal-db/) — 13 files
- [internal/logging](/100-days-of-go-lang/appendices/the-finished-app/internal-logging/) — 2 files
- [internal/secret](/100-days-of-go-lang/appendices/the-finished-app/internal-secret/) — 4 files
- [internal/store](/100-days-of-go-lang/appendices/the-finished-app/internal-store/) — 19 files
- [internal/task](/100-days-of-go-lang/appendices/the-finished-app/internal-task/) — 3 files
- [internal/telemetry](/100-days-of-go-lang/appendices/the-finished-app/internal-telemetry/) — 2 files
- [internal/tui](/100-days-of-go-lang/appendices/the-finished-app/internal-tui/) — 11 files
- [internal/version](/100-days-of-go-lang/appendices/the-finished-app/internal-version/) — 1 files
- [internal/web](/100-days-of-go-lang/appendices/the-finished-app/internal-web/) — 24 files
