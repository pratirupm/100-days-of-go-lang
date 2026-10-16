#!/usr/bin/env bun
/**
 * Generate `src/content/docs/appendices/the-finished-app.md` from the app
 * repository — the internal validation app the book was built against.
 *
 * Every tracked, hand-written file is included; generated code and artifacts
 * (sqlc, moq, templ output, SBOM, go.sum, the fuzz corpus) are excluded —
 * the intro says so.
 *
 * Run: bun run appendix
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, '..', 'go-todo-app');
const OUT = join(ROOT, 'src/content/docs/appendices/the-finished-app.md');

const EXCLUDE_EXACT = new Set([
	'go.sum',
	'docs/sbom.cdx.json',
	'internal/db/db.go',
	'internal/db/models.go',
	'internal/db/tasks.sql.go',
	'internal/db/auth.sql.go',
	'internal/store/store_moq_test.go',
	'internal/api/store_moq_test.go',
]);
const EXCLUDE_PREFIXES = ['notes/', 'dist/', '.git/', 'internal/task/testdata/fuzz/'];

function excluded(path: string): boolean {
	if (EXCLUDE_EXACT.has(path)) return true;
	if (EXCLUDE_PREFIXES.some((p) => path.startsWith(p))) return true;
	if (path.endsWith('_templ.go')) return true;
	return false;
}

function langFor(path: string): string {
	const base = basename(path);
	if (base === 'Makefile') return 'makefile';
	if (base === 'Dockerfile') return 'dockerfile';
	if (base === 'go.mod' || base.startsWith('.gitignore')) return 'text';
	if (base === 'Caddyfile') return 'text';
	const byExt: Record<string, string> = {
		'.go': 'go',
		'.sql': 'sql',
		'.yml': 'yaml',
		'.yaml': 'yaml',
		'.toml': 'toml',
		'.md': 'markdown',
		'.templ': 'templ',
		'.css': 'css',
		'.json': 'json',
		'.sh': 'bash',
		'.service': 'ini',
		'.timer': 'ini',
		'.snap': 'text',
		'.golden': 'text',
		'.txtar': 'text',
		'.txt': 'text',
	};
	return byExt[extname(path)] ?? 'text';
}

const HEADER = `---
title: The finished app (spoilers)
sidebar:
  order: 1
tableOfContents: false
pagefind: false
---

> **Spoilers.** The finished application, file by file — the state every
> chapter builds toward, and the tree every quote and transcript in this
> book was captured from. Use it to compare and to unstick; don't copy
> files wholesale. Generated code and artifacts (the \`sqlc\` output, the
> \`moq\` mocks, the \`templ\` output, the SBOM) are not reproduced here —
> \`make generate\` and \`make sbom\` produce them — and \`go.sum\` is what
> \`go mod tidy\` resolves. A few files are the app's own machinery rather
> than part of the build the chapters walk through — the workflow files
> under \`.github/\` and the \`cmd/benchgate\` tool — kept here so the tree
> is complete.
`;

const tracked = execFileSync('git', ['-C', APP, 'ls-files'], { encoding: 'utf8' })
	.trim()
	.split('\n');
let files = tracked.filter((f) => f && !excluded(f)).sort();
// go.mod leads; the rest stay alphabetical.
files = ['go.mod', ...files.filter((f) => f !== 'go.mod')];

const parts: string[] = [HEADER];
for (const file of files) {
	const content = (await readFile(join(APP, file), 'utf8')).replace(/\n+$/, '');
	parts.push(`\n## \`${file}\`\n\n\`\`\`\`${langFor(file)}\n${content}\n\`\`\`\`\n`);
}

await writeFile(OUT, parts.join('\n'));
console.log(`wrote ${OUT}: ${files.length} sections`);
