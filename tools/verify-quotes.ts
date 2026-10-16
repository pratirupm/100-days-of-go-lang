#!/usr/bin/env bun
/**
 * Quote verification — checks code quotes against the application that
 * produced them (the internal validation app, never shipped with the book).
 *
 * A quote is marked by an HTML comment directly above its fence:
 *
 *   <!-- verify: task/task.go at=toolchain -->
 *   ```go title="task/task.go"
 *   ...
 *   ```
 *
 * Rules:
 * - Without elisions, the fence body must appear as a contiguous run of
 *   lines in the app file (trailing whitespace ignored).
 * - With elisions — a line that is just `...` or `…`, optionally prefixed
 *   by `//`, `#`, or `--` — the remaining lines must appear in order.
 * - `at=` selects the app revision (a checkpoint tag); the default is HEAD.
 *
 * Run: bun run verify
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCS = join(ROOT, 'src/content/docs');
const APP = join(ROOT, '..', 'go-todo-app');

const MARKER = /^<!--\s*verify:\s*(\S+)(?:\s+at=(\S+))?\s*-->\s*$/;
const ELISION = /^(?:(?:\/\/|#|--)\s*)?(?:\.\.\.|…)$/;

async function* walk(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) yield path;
	}
}

function appFile(ref: string, path: string): string[] | null {
	const r = spawnSync('git', ['-C', APP, 'show', `${ref}:${path}`], { encoding: 'utf8' });
	if (r.status !== 0) return null;
	return r.stdout.replace(/\n$/, '').split('\n');
}

function check(body: string[], file: string[]): string | null {
	const trim = (l: string) => l.replace(/\s+$/, '');
	const block = body.map(trim);
	const hasElision = block.some((l) => ELISION.test(l.trim()));
	const seq = block.filter((l) => !ELISION.test(l.trim()));

	// A line containing an inline `...`/`…` matches any file line that
	// contains the segments around it, in order. This is how a leaked
	// path inside a frozen quote is redacted without breaking the check.
	const inline = /\.\.\.|…/;
	const matches = (blockLine: string, fileLine: string): boolean => {
		if (!inline.test(blockLine)) return fileLine === blockLine;
		const segments = blockLine
			.split(inline)
			.map((s) => s.trim())
			.filter((s) => s !== '');
		let cursor = 0;
		for (const segment of segments) {
			const at = fileLine.indexOf(segment, cursor);
			if (at === -1) return false;
			cursor = at + segment.length;
		}
		return true;
	};

	if (!hasElision) {
		for (let start = 0; start + seq.length <= file.length; start++) {
			let ok = true;
			for (let k = 0; k < seq.length; k++) {
				if (!matches(seq[k]!, trim(file[start + k]!))) {
					ok = false;
					break;
				}
			}
			if (ok) return null;
		}
		return 'not found as a contiguous block';
	}

	let cursor = 0;
	for (const line of seq) {
		let found = false;
		for (; cursor < file.length; cursor++) {
			if (matches(line, trim(file[cursor]!))) {
				found = true;
				cursor++;
				break;
			}
		}
		if (!found) return `line not found in order: ${line.trim().slice(0, 80)}`;
	}
	return null;
}

let checked = 0;
let failed = 0;

for await (const md of walk(DOCS)) {
	const rel = relative(DOCS, md);
	const lines = (await readFile(md, 'utf8')).split('\n');
	let pending: { path: string; ref: string; line: number } | null = null;
	let fence: { info: string; body: string[] } | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		const marker = line.match(MARKER);
		if (marker) {
			pending = { path: marker[1]!, ref: marker[2] ?? 'HEAD', line: i + 1 };
			continue;
		}

		if (line.startsWith('```')) {
			if (fence === null) {
				fence = { info: line.slice(3).trim(), body: [] };
			} else {
				if (pending) {
					checked++;
					const file = appFile(pending.ref, pending.path);
					if (file === null) {
						console.log(`${rel}:${pending.line}  [fail] no such file at ${pending.ref}: ${pending.path}`);
						failed++;
					} else {
						const problem = check(fence.body, file);
						if (problem) {
							console.log(`${rel}:${pending.line}  [fail] ${pending.path} (${pending.ref}) — ${problem}`);
							failed++;
						}
					}
				}
				fence = null;
				pending = null;
			}
			continue;
		}

		if (fence) fence.body.push(line);
	}
}

console.log(`\n${checked} quote(s) checked, ${failed} failure(s)`);
process.exit(failed > 0 ? 1 : 0);
