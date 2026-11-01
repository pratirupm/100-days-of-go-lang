# Backlog

Ideas agreed on but not scheduled. Roughly in order of impact.

## Content

- **A human read-through** — pick three or four days across the book, read
  them as a beginner would, and note anything that reads oddly. The highest
  quality lever left on an AI-written book.
- **Trim the roadmap list** — where the first 60 days already cover a topic
  (observability, performance, testing, security), fold it in rather than
  repeating it.

## Site and readers

- **PDF / EPUB export** — a "download the whole book" build. PDF via
  Playwright's print-to-PDF; EPUB via pandoc.
- **Comments or feedback beyond the report link** — only if the issue-based
  loop proves too quiet or too noisy.

## Engineering

- **Bump the GitHub Actions to their Node-24 versions** — clears the
  deprecation annotations from `checkout@v4`, `configure-pages@v5`, and
  `upload-artifact@v4`.
- **Dependabot** — keep actions and npm dependencies current automatically.
- **Register the `day` parameter as a custom dimension in GA** — the
  `day_complete` event fires; the dimension makes it reportable.

## Publishing and discovery

- **Google Search Console** — submit
  `https://pratirupm.github.io/100-days-of-go-lang/sitemap.xml` under the
  URL-prefix property (both `sitemap.xml` and `sitemap-index.xml` serve the
  index). Optionally Bing Webmaster Tools with the same URL.
- **Repo social preview** — upload `public/og.png` in Settings → Social
  preview (not settable via API).
- **Share it** — r/golang, Hacker News, and anywhere else a beginner-friendly
  Go course fits.

## Done

- Days 61–90 (production ground) — 30 days, 25 lessons + 5 reviews, with app tags and transcript captures
- Days 91–100 (data structures and algorithms) — 10 days, 9 lessons + 1 review, with benchmarks and captures
- Report-a-problem link (footer, prefilled GitHub issue)
- Progress export/import (JSON, merged on import)
- GA `day_complete` events
- Offline indicator chip
- Licenses (MIT code, CC BY-NC-SA 4.0 prose)
- Sitemap alias, repo description/topics/homepage, README landing
- SEO pass (titles, descriptions, OG card, JSON-LD, FAQ)
- The 100-day rebrand, the day-page merge, the tracker, the warm theme,
  the offline-first PWA, and the consistency sweep
