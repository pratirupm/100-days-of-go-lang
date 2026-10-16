#!/usr/bin/env bun
/**
 * Generate the finished-app appendix from the app repository — the internal
 * validation app the book was built against.
 *
 * One page per directory group (plus an index) so no single page carries the
 * whole 33k-line tree; every tracked, hand-written file is included, while
 * generated code and artifacts (sqlc, moq, templ output, SBOM, go.sum, the
 * fuzz corpus) are excluded — the intro says so.
 *
 * Run: bun run appendix
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const APP = join(ROOT, '..', 'go-todo-app');
const OUT_DIR = join(ROOT, 'src/content/docs/appendices/the-finished-app');
const INDEX = join(ROOT, 'src/content/docs/appendices/the-finished-app.md');

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

// Files group by their first path segment; internal/ and cmd/ split one
// level deeper so no page grows past a few hundred kilobytes of source.
function groupFor(path: string): { slug: string; label: string } {
	const parts = path.split('/');
	if (parts.length === 1) return { slug: 'root-files', label: 'The project root' };
	if ((parts[0] === 'internal' || parts[0] === 'cmd') && parts.length > 2) {
		return { slug: `${parts[0]}-${parts[1]}`, label: `${parts[0]}/${parts[1]}` };
	}
	const dir = parts[0]!;
	return { slug: dir.replace(/^\./, ''), label: dir };
}

const INTRO = `> **Spoilers.** The finished application, file by file — the state every
> chapter builds toward, and the tree every quote and transcript in this
> book was captured from. Use it to compare and to unstick; don't copy
> files wholesale. Generated code and artifacts (the \`sqlc\` output, the
> \`moq\` mocks, the \`templ\` output, the SBOM) are not reproduced here —
> \`make generate\` and \`make sbom\` produce them — and \`go.sum\` is what
> \`go mod tidy\` resolves. A few files are the app's own machinery rather
> than part of the build the chapters walk through — the workflow files
> under \`.github/\` and the \`cmd/benchgate\` tool — kept here so the tree
> is complete. Each section is the file's source, exactly as it lives in
> the project.
`;

const tracked = execFileSync('git', ['-C', APP, 'ls-files'], { encoding: 'utf8' })
	.trim()
	.split('\n');
let files = tracked.filter((f) => f && !excluded(f)).sort();
// go.mod leads; the rest stay alphabetical.
files = ['go.mod', ...files.filter((f) => f !== 'go.mod')];

// Group, keeping go.mod first inside its group and groups in a stable order.
const groups = new Map<string, { label: string; files: string[] }>();
for (const file of files) {
	const { slug, label } = groupFor(file);
	const group = groups.get(slug) ?? { label, files: [] };
	group.files.push(file);
	groups.set(slug, group);
}
const order = [...groups.keys()].sort((a, b) => {
	if (a === 'root-files') return -1;
	if (b === 'root-files') return 1;
	return a.localeCompare(b);
});

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const indexParts: string[] = [
	`---\ntitle: The finished app (spoilers)\nsidebar:\n  order: 1\ntableOfContents: false\npagefind: false\n---\n\n`,
	INTRO,
	`\n## The files, by directory\n\n`,
];
for (const slug of order) {
	const group = groups.get(slug)!;
	indexParts.push(`- [${group.label}](/appendices/the-finished-app/${slug}/) — ${group.files.length} files\n`);
}

for (const slug of order) {
	const group = groups.get(slug)!;
	const parts: string[] = [
		`---\ntitle: "${group.label} — the finished app"\nsidebar:\n  hidden: true\ntableOfContents: false\npagefind: false\n---\n\n`,
		`Part of [The finished app (spoilers)](/appendices/the-finished-app/).\n`,
	];
	for (const file of group.files) {
		const content = (await readFile(join(APP, file), 'utf8')).replace(/\n+$/, '');
		parts.push(`\n## \`${file}\`\n\n\`\`\`\`${langFor(file)}\n${content}\n\`\`\`\`\n`);
	}
	await writeFile(join(OUT_DIR, `${slug}.md`), parts.join('\n'));
}

await writeFile(INDEX, indexParts.join(''));
console.log(`wrote ${INDEX} (${groups.size} groups) and ${OUT_DIR} (${files.length} files)`);
