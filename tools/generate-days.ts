#!/usr/bin/env bun
/**
 * Generate the day pages and the days index from the course plan.
 *
 * Written chapters get a page; planned chapters are listed in the index but
 * wait for their chapter source and transcript capture. A review day appears
 * once its part is complete.
 *
 * Run: bun run days
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parts, type Part } from './course-plan';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'src/content/docs/days');
const CHAPTERS = join(ROOT, 'src/chapters');

// The base path, read from astro.config.mjs (one source of truth). Links the
// generator writes must carry it — Starlight's link validator checks sources
// against base-prefixed routes.
const config = await readFile(join(ROOT, 'astro.config.mjs'), 'utf8');
const BASE = config.match(/const base = '([^']+)'/)?.[1] ?? '';

const hours = (h: number) => (h === Math.floor(h) ? `${h} hours` : `${h} hours`);

// The lesson body and description for chapter N, read from the source tree
// (front matter stripped — the day page carries its own).
async function chapterFor(n: number): Promise<{ description: string; body: string }> {
	const prefix = String(n).padStart(2, '0') + '-';
	const files = (await readdir(CHAPTERS)).filter((f) => f.startsWith(prefix));
	if (files.length !== 1) throw new Error(`chapter ${n}: expected one source, found ${files.length}`);
	const text = await readFile(join(CHAPTERS, files[0]!), 'utf8');
	const match = text.match(/^---\n([\s\S]*?)\n---\n+/);
	const front = match ? match[1]! : '';
	const description = (front.match(/^description:\s*(.+)$/m)?.[1] ?? '').trim();
	const body = (match ? text.slice(match[0].length) : text).trimEnd();
	return { description, body };
}

function legacyReviewPage(part: Part, day: number): string {
	return `---
title: "Day ${day} — Review: Part ${part.roman}"
description: "Review day ${day} of 100 Days of Go Lang: catch up, re-run the suite, and compare your tree with the finished app."
sidebar:
  order: ${day}
---

**About 1.5 hours** · Part ${part.roman}, review.

- Re-run the whole suite: \`go test ./...\`.
- Read any **Going deeper** boxes you skipped on days ${day - part.chapters.length}–${day - 1}.
- Compare your tree with [The finished app](${BASE}/appendices/the-finished-app/).
- If everything is green, take the win. And if you're curious: ${part.review.replaceAll('{{BASE}}', BASE)}

<div class="day-tracker" data-day="${day}"></div>
`;
}

function productionReviewPage(part: Part, day: number): string {
	return `---
title: "Day ${day} — Review: Part ${part.roman}"
description: "Review day ${day} of 100 Days of Go Lang: ${part.production ? 'the production drills' : 'the drills'} for Part ${part.roman}."
sidebar:
  order: ${day}
${part.production ? 'style: production\n' : ''}---

**About 1.5 hours** · Part ${part.roman}, review.

${(part.reviewItems ?? []).map((item) => `- ${item}`).join('\n')}

${part.review}

<div class="day-tracker" data-day="${day}"></div>
`;
}

// Count what is written before writing the index intro. The plan is
// sequential, so the last written page is also the number of finished days.
let lastWrittenDay = 0;
let expectedDay = 1;
let writtenChapters = 0;
let writtenReviews = 0;
for (const part of parts) {
	for (const chapter of part.chapters) {
		if (chapter.status !== 'planned') {
			writtenChapters++;
			lastWrittenDay = expectedDay;
		}
		expectedDay++;
	}
	if (part.chapters.every((chapter) => chapter.status !== 'planned')) {
		writtenReviews++;
		lastWrittenDay = expectedDay;
	}
	expectedDay++;
}

const dayPages: { day: number; text: string }[] = [];
let day = 1;
const indexLines: string[] = [];

indexLines.push(`---
title: The days
description: "The 100 Days of Go Lang course plan: written build days and review days that take you from an empty folder to a working Go app — your progress is saved in this browser only."
sidebar:
  label: Overview
  order: 0
---

This book is a **100-day course**. ${lastWrittenDay} days are written —
${writtenChapters} build days and ${writtenReviews} review days, one review at
the end of every part. A build day takes about two and a half to three
hours; a review day about one and a half. The days don't have to be
consecutive: the plan is a pace, not a deadline.

The first sixty days build the whole app and put it on a server. Days 61–90
take it onto production ground — containers, a cloud, a real database,
services, and streams — and [ten more](${BASE}/dsa-10/whats-coming/) cover
data structures and algorithms. [The production ground](${BASE}/next-30/whats-coming/)
holds the working map.

The app is complete and working by Day 47 (the web interface, tested); the
last days of the first stretch ship it and tune it, and Day 60 closes it.

Your progress is saved **in this browser only** — nothing about it leaves
your device.

<div id="tracker-overview"></div>

## The days
`);

for (const part of parts) {
	indexLines.push(`\n### Part ${part.roman} — ${part.name}\n`);
	const partComplete = part.chapters.every((chapter) => chapter.status !== 'planned');

	for (const c of part.chapters) {
		const badge = hours(c.hours);

		if (c.status === 'planned') {
			// A source that exists but is still marked planned would silently
			// disappear from the site; catch the forgotten status flip.
			const prefix = String(c.n).padStart(2, '0') + '-';
			const sources = (await readdir(CHAPTERS)).filter((f) => f.startsWith(prefix));
			if (sources.length > 0) {
				throw new Error(`chapter ${c.n}: source exists but the plan still says planned`);
			}
			indexLines.push(`- Day ${day} — ${c.title} · coming\n`);
			day++;
			continue;
		}

		const lesson = await chapterFor(c.n);
		dayPages.push({
			day,
			text: `---
title: "Day ${day} — ${c.title}"
description: ${JSON.stringify(
				lesson.description
					? `${lesson.description} — Day ${day} of 100 Days of Go Lang.`
					: `Day ${day} of 100 Days of Go Lang: ${c.title}.`,
			)}
sidebar:
  order: ${day}
chapter: ${c.n}
${part.production ? 'style: production\n' : ''}---

**About ${badge}** · Part ${part.roman}, day ${part.chapters.indexOf(c) + 1} of ${part.chapters.length}.

**You'll be able to:**

${c.bullets.map((b) => `- ${b}`).join('\n')}
${c.split ? `\n:::tip[If you only have two hours]\n${c.split}\n:::\n` : ''}
---

${lesson.body}

<div class="day-tracker" data-day="${day}"></div>
`,
		});
		indexLines.push(`- [Day ${day} — ${c.title}](${BASE}/days/day-${String(day).padStart(2, '0')}/) · about ${badge}\n`);
		day++;
	}

	if (partComplete) {
		dayPages.push({
			day,
			text: part.reviewItems ? productionReviewPage(part, day) : legacyReviewPage(part, day),
		});
		indexLines.push(`- [Day ${day} — Review: Part ${part.roman}](${BASE}/days/day-${String(day).padStart(2, '0')}/) · about 1.5 hours\n`);
	} else {
		indexLines.push(`- Day ${day} — Review: Part ${part.roman} · coming\n`);
	}
	day++;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const page of dayPages) {
	await writeFile(join(OUT, `day-${String(page.day).padStart(2, '0')}.md`), page.text);
}
await writeFile(join(OUT, 'index.md'), indexLines.join(''));
console.log(`wrote ${dayPages.length} day pages + index to ${OUT}`);
