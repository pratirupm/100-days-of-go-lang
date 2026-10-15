#!/usr/bin/env bun
/**
 * Transcript check — every line of a terminal block in the new book must come
 * from the first-edition chapter it was rewritten from. The first edition is
 * where all the real, captured outputs live; this catches invented commands
 * and invented output.
 *
 * A line passes if it appears verbatim (after stripping the `$ ` prompt and
 * any trailing `...` elision) somewhere in the matching first-edition chapter.
 *
 * Run: bun run transcripts
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const NEW_DOCS = join(ROOT, 'src/content/docs');
const OLD_LESSONS = join(ROOT, '..', 'go-todo-course', 'book', 'lessons');

const SKIP = new Set(['index.mdx', '404.md', 'start-here.md']);

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) yield path;
	}
}

const oldFiles = await readdir(OLD_LESSONS);

function oldSourceFor(rel: string): string | null {
	const base = rel.split('/').pop() ?? '';
	const match = base.match(/^(\d{2})-/);
	if (!match) return null;
	const hit = oldFiles.find((f) => f.startsWith(`${match[1]}-`));
	return hit ? join(OLD_LESSONS, hit) : null;
}

// Fences that hold terminal sessions or raw output.
function isTerminalFence(info: string): boolean {
	const lang = info.split(/\s+/)[0] ?? '';
	if (info.includes('title=')) return false; // file quote — checked by verify-quotes
	return ['bash', 'sh', 'shell', 'console', 'text'].includes(lang);
}

let checked = 0;
let missing = 0;

for await (const file of walk(NEW_DOCS)) {
	const rel = relative(NEW_DOCS, file);
	if (SKIP.has(rel) || rel.startsWith('appendices/')) continue;

	const oldPath = oldSourceFor(rel);
	if (!oldPath) {
		console.log(`${rel}  [fail] no first-edition source found for this chapter`);
		missing++;
		continue;
	}
	const oldText = await readFile(oldPath, 'utf8');
	const lines = (await readFile(file, 'utf8')).split('\n');

	let inFence = false;
	let terminal = false;
	let body: string[] = [];
	const report = (lineNo: number, line: string) => {
		console.log(`${rel}:${lineNo}  [fail] not found in ${oldPath.split('/').pop()} — ${line.trim().slice(0, 90)}`);
		missing++;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith('```')) {
			if (!inFence) {
				inFence = true;
				terminal = isTerminalFence(line.slice(3).trim());
				body = [];
			} else {
				if (terminal) {
					for (let k = 0; k < body.length; k++) {
						let needle = body[k]!.trim();
						if (needle === '' || needle === '...' || needle === '…') continue;
						if (needle.startsWith('$ ')) needle = needle.slice(2);
						const cut = needle.indexOf('...');
						if (cut >= 0) needle = needle.slice(0, cut).trim();
						if (needle === '') continue;
						checked++;
						if (!oldText.includes(needle)) report(i - body.length + k, needle);
					}
				}
				inFence = false;
				terminal = false;
				body = [];
			}
			continue;
		}
		if (inFence && terminal) body.push(line);
	}
}

console.log(`\n${checked} terminal line(s) checked, ${missing} not found`);
process.exit(missing > 0 ? 1 : 0);
