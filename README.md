# Build a Todo App in Go — the book site

The reader-facing book: a beginner-friendly, step-by-step course that builds
a real Go application from an empty folder. Astro + Starlight, run with Bun.
`bun run build` emits a fully static site (with an offline search index) to
`dist/`.

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Dev server with live reload |
| `bun run build` | Static build to `dist/` (runs the links validator + Pagefind) |
| `bun run preview` | Serve the built site |
| `bun run lint` | Prose lint — fails on bookkeeping vocabulary, warns on style smells |
| `bun run verify` | Checks marked code quotes against the app that produced them |
| `bun run transcripts` | Checks every terminal line against the first edition it came from |
| `bun run appendix` | Regenerates the finished-app appendix from `../go-todo-app` |
| `bun run check` | `lint` + `verify` + `transcripts` + `build` — the full gate |

## Layout

```
src/content/docs/           the book: start-here, part-i…part-x, appendices
tools/lint-prose.ts         the house-style gate
tools/verify-quotes.ts      code-quote verification against ../go-todo-app
tools/check-transcripts.ts  terminal-line verification against the first edition
tools/generate-appendix.ts  regenerates the finished-app appendix
src/integrations/           build-time cleanup (verification markers)
STYLE.md                    the writing rules every chapter follows
```

## Related repositories

- `../go-todo-course` — the first edition of the book (complete course, kept as source material)
- `../go-todo-app` — the internal application the book was built and verified against; never shipped with the book
