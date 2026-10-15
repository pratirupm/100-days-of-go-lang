#!/usr/bin/env bun
/**
 * Prose lint — keeps the beginner-first house style honest.
 *
 * FAILs on bookkeeping vocabulary that must never reach reader pages
 * (git, commits, checkpoints, CI). WARNs on style smells that deserve a
 * human look (long paragraphs, checkpoint-era phrasing).
 *
 * Run: bun run lint
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCS = join(ROOT, 'src/content/docs');

// Generated code pages are not prose; the lint does not apply to them.
const SKIP = new Set(['appendices/the-finished-app.md']);

const FAIL: Array<{ re: RegExp; why: string }> = [
	{ re: /\bcommits?(ed|ing)?\b/i, why: 'git bookkeeping is out of the reader path' },
	{ re: /\bcheckpoints?\b/i, why: 'checkpoints are out of the reader path' },
	{ re: /\bgit\b/i, why: 'the book does not teach git' },
	{ re: /\bCI\b/, why: 'no CI talk in reader pages' },
	{ re: /\bworkflows?\b/i, why: 'no CI talk in reader pages' },
	{ re: /\bred\s*(?:→|->|to|[-–—])\s*green\b/i, why: 'use plain words for the test-first loop' },
];

const WARN: Array<{ re: RegExp; why: string }> = [
	{ re: /\bgates?\b/i, why: 'checkpoint-era vocabulary' },
	{ re: /\btags?\b/i, why: 'checkpoint-era vocabulary (fine if it is HTML tag talk)' },
	{ re: /\brepositor(y|ies)\b/i, why: 'keep the book self-contained' },
];

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) yield path;
	}
}

let failures = 0;
let warnings = 0;

for await (const file of walk(DOCS)) {
	const rel = relative(DOCS, file);
	if (SKIP.has(rel)) continue;

	const lines = (await readFile(file, 'utf8')).split('\n');
	let inFence = false;
	let inFrontmatter = lines[0]?.trim() === '---';
	let paraStart = 0;
	let paraLines = 0;

	const flushPara = () => {
		if (paraLines > 7) {
			console.log(`${rel}:${paraStart}  [warn] paragraph runs ${paraLines} lines — consider splitting`);
			warnings++;
		}
		paraLines = 0;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const n = i + 1;

		if (inFrontmatter) {
			if (i > 0 && line.trim() === '---') inFrontmatter = false;
			continue;
		}
		if (line.trimStart().startsWith('```')) {
			inFence = !inFence;
			flushPara();
			continue;
		}
		if (inFence) continue;

		for (const { re, why } of FAIL) {
			if (re.test(line)) {
				console.log(`${rel}:${n}  [fail] ${why} — ${line.trim().slice(0, 90)}`);
				failures++;
			}
		}
		for (const { re, why } of WARN) {
			if (re.test(line)) {
				console.log(`${rel}:${n}  [warn] ${why} — ${line.trim().slice(0, 90)}`);
				warnings++;
			}
		}

		const isProse = line.trim() !== '' && !/^[#>\-*|]|^\d+\.|^<!--|^\s{2,}/.test(line);
		if (isProse) {
			if (paraLines === 0) paraStart = n;
			paraLines++;
		} else {
			flushPara();
		}
	}
	flushPara();
}

console.log(`\n${failures} failure(s), ${warnings} warning(s)`);
process.exit(failures > 0 ? 1 : 0);
