#!/usr/bin/env bun
/**
 * Generate the 60 day pages and the days index from the course plan.
 *
 * The plan: 50 build days (one chapter each) + 10 review days, one at the
 * end of every part. Times are calibrated from the first edition's own
 * per-chapter estimates, scaled ~0.8 for the shorter reader-facing text and
 * no bookkeeping, rounded to half hours.
 *
 * Run: bun run days
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'src/content/docs/days');
const CHAPTERS = join(ROOT, 'src/chapters');

type Chapter = {
	n: number;
	title: string;
	slug: string;
	hours: number;
	bullets: string[];
	split?: string;
};

type Part = {
	roman: string;
	name: string;
	chapters: Chapter[];
	review: string;
};

const parts: Part[] = [
	{
		roman: 'I',
		name: 'Getting started',
		chapters: [
			{ n: 1, title: 'The first test', slug: '/part-i/01-toolchain-first-test/', hours: 1.5, bullets: ['have the `todo` module and a test that passes — written before the code it tests;', 'know the loop every chapter runs: write the test, watch it fail, make it pass.'] },
			{ n: 2, title: 'Structs and methods', slug: '/part-i/02-structs-and-methods/', hours: 2.5, bullets: ['give a task a status, a priority, and an optional due date — with a constructor that refuses a blank title;', 'teach a type to describe itself in one line with `String()`.'] },
			{ n: 3, title: 'A list of tasks', slug: '/part-i/03-slices-and-maps/', hours: 3, bullets: ['keep tasks in an in-memory store that adds, lists, filters, counts, and sorts;', 'read and write slices and maps, and hide a store’s internals behind methods.'] },
			{ n: 4, title: 'When things go wrong', slug: '/part-i/04-errors-as-values/', hours: 2.5, bullets: ['return errors as values, wrap them with context, and match them by identity with `errors.Is` and `errors.As`;', 'explain why error text is not an API.'] },
		],
		review: 'run `go test -v ./...` and read the names of the tests you wrote this week — each one is a claim you decided.',
	},
	{
		roman: 'II',
		name: 'Structuring the code',
		chapters: [
			{ n: 5, title: 'Interfaces and fakes', slug: '/part-ii/05-interfaces-and-fakes/', hours: 2.5, bullets: ['describe what the store must do with an interface, and write a fake that fails on command;', 'recognize interface satisfaction and the embedding trick.'] },
			{ n: 6, title: 'Organizing the code', slug: '/part-ii/06-packages-and-layout/', hours: 2.5, bullets: ['move the packages under `internal/` and write the first runnable command;', 'explain why `internal/` keeps code private.'] },
			{ n: 7, title: 'Generics', slug: '/part-ii/07-generics-and-stdlib/', hours: 2.5, bullets: ['write a function that works for many types with a type parameter;', 'reach for the standard library’s `slices` and `maps` helpers first.'] },
			{ n: 8, title: 'Custom types', slug: '/part-ii/08-custom-types-encodings/', hours: 2.5, bullets: ['define custom types that know how to render and parse themselves;', 'round-trip them through text and pin the encodings with table tests.'] },
		],
		review: 'open [the finished app’s appendix](/appendices/the-finished-app/) and find the `Store` interface — see how small it stayed.',
	},
	{
		roman: 'III',
		name: 'Testing',
		chapters: [
			{ n: 9, title: 'Table-driven tests', slug: '/part-iii/09-table-tests-testify/', hours: 3, bullets: ['turn every test into a table with named subtests, using testify;', 'run cases in parallel safely.'] },
			{ n: 10, title: 'Snapshot tests', slug: '/part-iii/10-golden-snapshots/', hours: 2.5, bullets: ['record golden snapshots and read the diff when the output changes;', 'explain why a snapshot is only as good as its last review.'] },
			{ n: 11, title: 'Coverage, races, and fuzzing', slug: '/part-iii/11-coverage-race-fuzz/', hours: 3, bullets: ['measure coverage and read the report for what it hides;', 'run the race detector and write a fuzz target that keeps its corpus.'] },
			{ n: 12, title: 'Benchmarks', slug: '/part-iii/12-benchmarks-benchstat/', hours: 3, bullets: ['write benchmarks and compare two candidates with benchstat;', 'read the numbers honestly — what `allocs/op` guarantees and `B/op` doesn’t.'] },
			{ n: 13, title: 'Linters and code generation', slug: '/part-iii/13-vet-lint-codegen/', hours: 3, bullets: ['run vet and gofmt, and put golangci-lint behind a config;', 'generate a mock with a `//go:generate` directive, and keep the Makefile’s named commands.'] },
		],
		review: 'run `go test -count=1 -cover ./...` and see the numbers your work put there.',
	},
	{
		roman: 'IV',
		name: 'Concurrency',
		chapters: [
			{ n: 14, title: 'Goroutines and channels', slug: '/part-iv/14-goroutines-channels/', hours: 3, bullets: ['run work in goroutines and pass results over channels;', 'wait for a group, and recognize the races the detector finds.'] },
			{ n: 15, title: 'select and timeouts', slug: '/part-iv/15-select-timeouts/', hours: 2.5, bullets: ['wait on several channels at once with `select`, and put timeouts on the waits;', 'build a worker pool that can stop early.'] },
			{ n: 16, title: 'Context and cancellation', slug: '/part-iv/16-context/', hours: 3, bullets: ['thread `context` through the store so callers can cancel work;', 'delete the hand-rolled cancel plumbing in favor of `ctx`.'] },
			{ n: 17, title: 'Mutexes and atomics', slug: '/part-iv/17-sync-atomics/', hours: 3, bullets: ['guard shared state with a read-write lock and count with atomics;', 'explain what a lock’s happens-before promise buys.'] },
			{ n: 18, title: 'Running work in parallel', slug: '/part-iv/18-errgroup-parallelism/', hours: 3, bullets: ['bound parallelism with errgroup: a fixed crew, fail-fast, siblings cancelled;', 'measure whether the parallel version is actually faster.'] },
		],
		review: 'run the race detector over the store tests once more — and watch it stay quiet.',
	},
	{
		roman: 'V',
		name: 'The data layer',
		chapters: [
			{ n: 19, title: 'Export and import', slug: '/part-v/19-export-import/', hours: 3, bullets: ['define a versioned JSON document and export and import the store through it;', 'write files atomically and refuse documents the app didn’t write.'] },
			{ n: 20, title: 'Adding a database', slug: '/part-v/20-turso/', hours: 4, bullets: ['open a real database — Turso, with no C compiler in sight;', 'run one conformance suite against both the memory and database stores.'], split: 'stop after “Watch it fail” passes, and pick up at “The schema and the handle” tomorrow.' },
			{ n: 21, title: 'Database migrations', slug: '/part-v/21-migrations-goose/', hours: 3, bullets: ['write SQL migrations, embed them in the binary, and apply them at boot;', 'keep a golden schema that fails when the shape drifts.'] },
			{ n: 22, title: 'Queries with sqlc', slug: '/part-v/22-sqlc-queries/', hours: 3, bullets: ['write the queries in SQL and generate typed Go from them with sqlc;', 'keep generated code out of hand edits.'] },
			{ n: 23, title: 'IDs and time', slug: '/part-v/23-ids-and-time/', hours: 3, bullets: ['move to UUIDv7 ids and keep times in UTC;', 'migrate existing rows safely and version the export format.'] },
			{ n: 24, title: 'Transactions', slug: '/part-v/24-transactions/', hours: 4, bullets: ['make multi-step writes all-or-nothing with transactions;', 'add optimistic concurrency — a version column, compare-and-swap, retries — and keep the importer atomic.'], split: 'stop after “The compare-and-swap” passes, and pick up at “Every write rides a transaction” tomorrow.' },
		],
		review: 'open the appendix’s `schema.sql` beside the migrations you wrote — you can read the database’s shape now.',
	},
	{
		roman: 'VI',
		name: 'The command-line app',
		chapters: [
			{ n: 25, title: 'A command-line tool', slug: '/part-vi/25-cobra-commands/', hours: 3, bullets: ['build a command tree with cobra: add, list, done, and friends;', 'test the commands and read the help they print.'] },
			{ n: 26, title: 'Configuration', slug: '/part-vi/26-config-paths/', hours: 3, bullets: ['resolve settings from flag → environment → sensible defaults;', 'test the whole ladder as a table.'] },
			{ n: 27, title: 'Output formats', slug: '/part-vi/27-output-formats/', hours: 3, bullets: ['print both a human table and machine JSON;', 'keep the JSON shape stable and record it as a snapshot.'] },
			{ n: 28, title: 'Integration tests', slug: '/part-vi/28-cli-integration/', hours: 3, bullets: ['black-box test the real binary with testscript;', 'keep scenarios in txtar files and measure the binary’s coverage.'] },
			{ n: 29, title: 'Logging', slug: '/part-vi/29-logging-slog/', hours: 3, bullets: ['log structured records with slog, with levels and a flag;', 'write JSON to a file while humans get readable lines.'] },
		],
		review: 'run `./todo --help`, then `./todo list --json` — the tool answers like a real program.',
	},
	{
		roman: 'VII',
		name: 'The HTTP API',
		chapters: [
			{ n: 30, title: 'The first API endpoint', slug: '/part-vii/30-echo-first-handler/', hours: 3, bullets: ['serve the first HTTP endpoints with echo: liveness and readiness;', 'shut the server down gracefully, and test it black-box.'] },
			{ n: 31, title: 'Tasks over HTTP', slug: '/part-vii/31-crud-validation/', hours: 3, bullets: ['build the task CRUD endpoints, with validation that answers 422;', 'keep every failure in one error shape.'] },
			{ n: 32, title: 'Middleware', slug: '/part-vii/32-middleware-stack/', hours: 3, bullets: ['assemble the middleware stack: request ids, logging, recovery, security headers;', 'handle errors in one place.'] },
			{ n: 33, title: 'Users and sessions', slug: '/part-vii/33-auth-sessions/', hours: 3, bullets: ['register, log in, and log out users;', 'hash passwords with argon2id and carry identity in a cookie session that rotates on login.'] },
			{ n: 34, title: 'Authorization', slug: '/part-vii/34-authorization/', hours: 3, bullets: ['scope every task to its owner;', 'grant an admin, and leave an audit trail of who did what.'] },
			{ n: 35, title: 'API documentation', slug: '/part-vii/35-openapi-swagger/', hours: 3, bullets: ['annotate the API and generate an OpenAPI spec;', 'serve Swagger UI and keep the docs under test.'] },
		],
		review: 'open `/swagger/index.html` and click through the endpoints you built.',
	},
	{
		roman: 'VIII',
		name: 'The web UI',
		chapters: [
			{ n: 36, title: 'The first web page', slug: '/part-viii/36-templ-basics/', hours: 3, bullets: ['render the first server-side page with templ components;', 'lay out a page, and let escaping keep it safe.'] },
			{ n: 37, title: 'Forms', slug: '/part-viii/37-forms-csrf/', hours: 3, bullets: ['build the login and task forms with CSRF protection;', 'use submit-then-redirect so refreshes don’t repeat actions.'] },
			{ n: 38, title: 'CSS and static files', slug: '/part-viii/38-assets-embed/', hours: 3, bullets: ['style the pages with a small design system;', 'embed the assets in the binary and serve them with cache validation.'] },
			{ n: 39, title: 'Web security', slug: '/part-viii/39-web-security/', hours: 3, bullets: ['harden the web app: CSP, HSTS, cookie rules, and a login limiter;', 'explain each header in one sentence.'] },
			{ n: 40, title: 'Testing the pages', slug: '/part-viii/40-web-snapshot-tests/', hours: 3, bullets: ['snapshot-test whole pages;', 'prove the flows through the real binary.'] },
		],
		review: 'view the source of the login page and find the CSRF token your own middleware put there.',
	},
	{
		roman: 'IX',
		name: 'The terminal UI',
		chapters: [
			{ n: 41, title: 'A terminal interface', slug: '/part-ix/41-tui-basics/', hours: 3, bullets: ['run a full-screen terminal interface with Bubble Tea’s event loop;', 'drive it with keys and a model.'] },
			{ n: 42, title: 'Styling the terminal UI', slug: '/part-ix/42-tui-styling/', hours: 3, bullets: ['style the interface with lipgloss;', 'make a frame that fits the terminal it runs in.'] },
			{ n: 43, title: 'Talking to the API', slug: '/part-ix/43-tui-client/', hours: 3, bullets: ['give the interface an HTTP client that talks to the API;', 'handle the live conflict and sign in from the TUI.'] },
			{ n: 44, title: 'Testing the terminal UI', slug: '/part-ix/44-tui-tests-logging/', hours: 3, bullets: ['test the interface with teatest and golden frames;', 'read its debug log when a session goes wrong.'] },
		],
		review: 'resize the terminal while the interface runs — the frame follows.',
	},
	{
		roman: 'X',
		name: 'Shipping it',
		chapters: [
			{ n: 45, title: 'Tracing and metrics', slug: '/part-x/45-observability/', hours: 3, bullets: ['trace requests and expose Prometheus metrics;', 'profile the server with pprof when the numbers look wrong.'] },
			{ n: 46, title: 'Secrets', slug: '/part-x/46-secrets/', hours: 3, bullets: ['load secrets from the environment or a mode-checked file;', 'rotate the admin key without leaving it in any log.'] },
			{ n: 47, title: 'The security audit', slug: '/part-x/47-security-audit/', hours: 3, bullets: ['write a threat model and keep the dependency list allowlisted;', 'run the vulnerability scan, the SBOM, and the lint floors as named commands.'] },
			{ n: 48, title: 'Deploying', slug: '/part-x/48-deploy/', hours: 3, bullets: ['deploy with a systemd unit and Caddy TLS;', 'back the database up on a timer and follow the runbook.'] },
			{ n: 49, title: 'Releases', slug: '/part-x/49-release/', hours: 3, bullets: ['stamp the version into the binary;', 'cut release archives and a container image with GoReleaser.'] },
			{ n: 50, title: 'Making it faster', slug: '/part-x/50-performance-tuning/', hours: 3, bullets: ['profile before changing anything;', 'make the list fast with an index and a merge join, and record the measurements that refused.'] },
		],
		review: 'read `deploy/RUNBOOK.md` in the appendix and try one drill — then take a break. You finished the course.',
	},
];

const hours = (h: number) => (h === Math.floor(h) ? `${h} hours` : `${h} hours`);

// The lesson body for chapter N, read from the source tree (front matter
// stripped — the day page carries its own).
async function lessonFor(n: number): Promise<string> {
	const prefix = String(n).padStart(2, '0') + '-';
	const files = (await readdir(CHAPTERS)).filter((f) => f.startsWith(prefix));
	if (files.length !== 1) throw new Error(`chapter ${n}: expected one source, found ${files.length}`);
	const text = await readFile(join(CHAPTERS, files[0]!), 'utf8');
	const match = text.match(/^---\n[\s\S]*?\n---\n+/);
	return (match ? text.slice(match[0].length) : text).trimEnd();
}

const dayPages: { day: number; text: string }[] = [];
let day = 1;
const indexLines: string[] = [];

indexLines.push(`---
title: The 60 days
sidebar:
  label: Overview
  order: 0
---

This book is a **60-day course**: fifty build days — one chapter each — and
ten review days, one at the end of every part. A build day takes about two
and a half to three hours; a review day about one and a half. The days don't
have to be consecutive: the plan is a pace, not a deadline.

The app is complete and working by Day 47 (the web interface, tested); the
last parts ship it and tune it, and Day 60 closes the course.

Your progress is saved **in this browser only** — nothing about it leaves
your device.

<div id="tracker-overview"></div>

## The days
`);

for (const part of parts) {
	indexLines.push(`\n### Part ${part.roman} — ${part.name}\n`);
	for (const c of part.chapters) {
		const badge = hours(c.hours);
		const lesson = await lessonFor(c.n);
		dayPages.push({
			day,
			text: `---
title: "Day ${day} — ${c.title}"
sidebar:
  order: ${day}
chapter: ${c.n}
---

**About ${badge}** · Part ${part.roman}, day ${part.chapters.indexOf(c) + 1} of ${part.chapters.length}.

**You'll be able to:**

${c.bullets.map((b) => `- ${b}`).join('\n')}
${c.split ? `\n:::tip[If you only have two hours]\n${c.split}\n:::\n` : ''}
---

${lesson}

<div class="day-tracker" data-day="${day}"></div>
`,
		});
		indexLines.push(`- [Day ${day} — ${c.title}](/days/day-${String(day).padStart(2, '0')}/) · about ${badge}\n`);
		day++;
	}
	dayPages.push({
		day,
		text: `---
title: "Day ${day} — Review: Part ${part.roman}"
sidebar:
  order: ${day}
---

**No new chapter today** — about an hour and a half.

- Re-run the whole suite: \`go test ./...\`.
- Read any **Going deeper** boxes you skipped on days ${day - part.chapters.length}–${day - 1}.
- Compare your tree with [The finished app](/appendices/the-finished-app/).
- If everything is green, take the win. And if you're curious: ${part.review}

<div class="day-tracker" data-day="${day}"></div>
`,
	});
	indexLines.push(`- [Day ${day} — Review: Part ${part.roman}](/days/day-${String(day).padStart(2, '0')}/) · about 1.5 hours\n`);
	day++;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const page of dayPages) {
	await writeFile(join(OUT, `day-${String(page.day).padStart(2, '0')}.md`), page.text);
}
await writeFile(join(OUT, 'index.md'), indexLines.join(''));
console.log(`wrote ${dayPages.length} day pages + index to ${OUT}`);
