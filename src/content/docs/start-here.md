---
title: Start here
description: What you need and how this book works.
---

This book is a programming course that builds one real application, from an
empty folder to a working todo app — the kind of app you might use to keep
track of what needs doing. You'll write every line of it yourself, and by the
end you'll understand every part of it.

No programming experience is needed. If you can open a terminal, run a
command, and edit a file, you're ready.

## What you need

- **Go 1.26 or newer.** Install it from [go.dev/doc/install](https://go.dev/doc/install).
  To check, run `go version` — it should print something like
  `go version go1.26.8 linux/amd64`.
- **A terminal.** Everything in this book happens on the command line.
- **An editor.** VS Code with the Go extension is a good default; any editor
  works.

## How this book works

Each chapter adds one small piece to the app, and every piece follows the
same three steps:

1. **Write a test that describes what the piece should do** — and run it, so
   you watch it fail. The failure tells us exactly what's missing.
2. **Write the smallest amount of code that makes the test pass.**
3. **Run the tests again** to see everything pass.

You type everything yourself — that's the point. Reading code is not the
same as writing it. The code blocks show exactly what to type, and the
terminal blocks show what you should see when you run it.

A few conventions worth knowing now:

- Terminal commands start with `$`. Type what follows the `$`.
- Long output is trimmed, and the trimmed part is marked with `...`.
- A block that quotes a file carries the file's name above it, like
  `task/task.go`.

If a chapter ends with a **Going deeper** box, you can skip it. It's extra
background, not part of the build.

A word on the shape of the journey: the app becomes complete and working well
before the last page. The final parts go further — a terminal interface, then
the operator's work of shipping, observing, and tuning a service — and they
are there when you want them; nothing essential waits at the very end.

## If you get stuck

- Compare your code with the chapter's blocks — a typo is the usual suspect.
- Chapters list the errors they can produce, with the fix, under
  "If something went wrong".
- As a last resort, the finished app appears in full in
  [The finished app (spoilers)](/appendices/the-finished-app/) — but give it
  an honest try first. Struggling a little is how the learning happens.

Ready? [Day 1 — The first test](/days/day-01/) is next.
