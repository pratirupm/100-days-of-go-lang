# House style

The rules every page in this book follows. They are distilled from the
writing that tested best on real beginners — short paragraphs, one idea at
a time, nothing to trip over. The prose lint (`bun run lint`) enforces the
hard rules; the rest is craft, checked by reading each chapter once as a
person who has never written code before.

## Who this book is for

Readers with little or no programming experience. They can open a terminal,
run a command, and edit a file. They have never written a program, and they
do not know the vocabulary yet. Every page is written for a smart, motivated
person who is seeing this material for the first time.

## The voice

- **"We" do the building together; "you" type and decide.** Never "I".
- **Plain words first.** Jargon only when the build genuinely needs it, and
  defined right where it first appears.
- **Short sentences, short paragraphs** (2–4 sentences). If a paragraph
  needs a fifth sentence, it probably wants to be two paragraphs.
- **Warm, never condescending.** If something looks strange, say so and
  explain it. "This looks like a lot — it's three lines" beats silence.
- Contractions are fine. Light humor is fine. Exclamation marks, rarely.

## Chapter anatomy

1. **Opening: 2–4 short paragraphs.** What we're building, why it matters,
   what it will feel like when it works. No lists, no meta ("in this chapter
   you will learn…"), no time estimates.
2. **Sections (`##`): 200–800 words each.** One idea per section. Headings
   say what the section does, in plain words.
3. **"If something went wrong"** where the chapter can produce errors: the
   real messages, and the fix, as plain text — no tables of jargon.
4. **"Going deeper": optional depth** at the end, wrapped in
   `<details>…</details>`. Skippable without missing the build. This is the
   only place background theory lives.
5. **A one-line closing** that points at what's next — never "chapter N".

Target length: **1,200–4,000 words** per chapter.

## Hard rules (enforced by `bun run lint`)

- No git vocabulary: git, commit, repository, branch, stage. The book never
  mentions version control.
- No CI vocabulary: CI, workflow, gate, pipeline.
- No checkpoint vocabulary: checkpoint, tag, "red"/"green" as test states.
  A test *fails* or *passes*.
- No chapter-number cross references ("chapter 7", "as we saw in chapter 3").
  Use "later in the book", "in a moment", "as we just saw".
- No time estimates and no "you build / answer key" meta blocks.

## Code presentation

- **File quotes carry a title:** ` ```go title="task/task.go" `. The title
  bar is how the reader knows what file the block belongs to.
- **Quotes are verified.** A file quote carries a marker comment directly
  above the fence; `bun run verify` checks the lines against the app that
  produced them:

  ```
  <!-- verify: task/task.go at=toolchain -->
  ```go title="task/task.go"
  ```

- **Terminal blocks show the `$` prompt.** Commands are `$`-prefixed; output
  follows on the lines below, exactly as it appeared. One block per step.
- **Elisions are a lone `...` line** inside a block, or `...` inline. Never
  silently drop lines.
- **Keep blocks small** — aim for 25 lines or fewer. Quote the interesting
  part, not the whole file.
- **Every code block is followed by at least one sentence** saying what to
  look at or what should happen next.

## Asides

- `:::tip` — advice that makes life easier.
- `:::note` — context that prevents confusion.
- `:::caution` — something that will bite, with the fix.
- `<details>` — "Going deeper" depth, at chapter end only.

Use at most a handful per chapter. If everything is highlighted, nothing is.

## Vocabulary

| Avoid | Prefer |
| --- | --- |
| instantiate, invoke, utilize, leverage | create, call, use |
| prior to, in order to | before, to |
| refactor | clean up the code |
| the gate, run the gate | run the tests |
| the repository, the repo | the project, the app |
| red test, green test | a failing test, a passing test |
| execute | run |

## Checklist for every chapter

- [ ] Opening is plain-language, short, and free of meta
- [ ] One idea per section; headings say what the section does
- [ ] Every code block has a following "what to look at" sentence
- [ ] Errors get their real message and a plain-language fix
- [ ] No banned vocabulary (`bun run lint` is clean)
- [ ] No chapter numbers, no git/CI/checkpoint talk
- [ ] "Going deeper" is genuinely skippable
- [ ] Length within 1,200–4,000 words
