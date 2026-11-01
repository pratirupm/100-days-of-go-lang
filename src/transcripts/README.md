# Transcript captures

The first sixty chapters check their terminal output against the first
edition in `../go-todo-course`. Production-ground chapters have no first
edition, so the captures here are their source of truth.

## Naming

One file per chapter, named with the chapter number:

```
src/transcripts/51-docker-image.md
src/transcripts/52-compose.md
```

## What goes in a capture

Paste the real terminal session, with the `$` prompt on every command and the
output exactly as it appeared:

```text
$ podman build -t todo:dev .
...
$ podman run --rm -p 8080:8080 todo:dev
...
```

`bun run transcripts` checks every terminal block in the generated day page
against this file, line by line. A line that is not here is treated as
invented. Redact account ids, hostnames, and paths with `...` — the checker
accepts an elision on its own line, and the day page should show the same
elision.

Do not paste credentials, private hostnames, or full cloud resource ids. Use
a neutral placeholder and keep the shape of the output.
