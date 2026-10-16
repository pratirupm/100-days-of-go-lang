---
title: The finished app (spoilers)
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

- [The project root](/appendices/the-finished-app/root-files/) — 7 files
- [cmd/benchgate](/appendices/the-finished-app/cmd-benchgate/) — 1 files
- [cmd/todo](/appendices/the-finished-app/cmd-todo/) — 7 files
- [cmd/todo-server](/appendices/the-finished-app/cmd-todo-server/) — 4 files
- [cmd/todo-tui](/appendices/the-finished-app/cmd-todo-tui/) — 1 files
- [deploy](/appendices/the-finished-app/deploy/) — 7 files
- [docs](/appendices/the-finished-app/docs/) — 1 files
- [.github](/appendices/the-finished-app/github/) — 3 files
- [internal/api](/appendices/the-finished-app/internal-api/) — 23 files
- [internal/audit](/appendices/the-finished-app/internal-audit/) — 6 files
- [internal/auth](/appendices/the-finished-app/internal-auth/) — 10 files
- [internal/benchgate](/appendices/the-finished-app/internal-benchgate/) — 2 files
- [internal/cli](/appendices/the-finished-app/internal-cli/) — 5 files
- [internal/client](/appendices/the-finished-app/internal-client/) — 2 files
- [internal/config](/appendices/the-finished-app/internal-config/) — 2 files
- [internal/db](/appendices/the-finished-app/internal-db/) — 13 files
- [internal/logging](/appendices/the-finished-app/internal-logging/) — 2 files
- [internal/secret](/appendices/the-finished-app/internal-secret/) — 4 files
- [internal/store](/appendices/the-finished-app/internal-store/) — 19 files
- [internal/task](/appendices/the-finished-app/internal-task/) — 3 files
- [internal/telemetry](/appendices/the-finished-app/internal-telemetry/) — 2 files
- [internal/tui](/appendices/the-finished-app/internal-tui/) — 11 files
- [internal/version](/appendices/the-finished-app/internal-version/) — 1 files
- [internal/web](/appendices/the-finished-app/internal-web/) — 24 files
