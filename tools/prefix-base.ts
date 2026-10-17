#!/usr/bin/env bun
/**
 * Prefixes internal absolute links in the book's sources with the site's
 * base path.
 *
 * Astro requires internal links to include `base` (a GitHub Pages project
 * site serves everything under /<repo>/), and Starlight's link validator
 * checks the sources — so the links are normalized here, once, with the base
 * read from astro.config.mjs. Idempotent: already-prefixed links, external
 * URLs, and relative links are left alone.
 *
 * Run: bun run prefix-base
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const config = await readFile(join(ROOT, 'astro.config.mjs'), 'utf8');
const base = config.match(/const base = '([^']+)'/)?.[1] ?? '';
if (!base) {
	console.log('no base configured; nothing to do');
	process.exit(0);
}
const prefix = base.replace(/^\//, '');

async function* markdownFiles(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* markdownFiles(path);
		else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) yield path;
	}
}

let files = 0;
let links = 0;
for (const root of [join(ROOT, 'src/content/docs'), join(ROOT, 'src/chapters')]) {
	for await (const file of markdownFiles(root)) {
		const text = await readFile(file, 'utf8');
		// Markdown links and images whose target is an internal absolute path.
		const out = text.replace(/\]\(\/(?!\/)([^)#\s]*)(#[^)\s]*)?\)/g, (match, path, hash = '') => {
			if (path.startsWith(prefix)) return match;
			links++;
			return `](${base}/${path}${hash})`;
		});
		if (out !== text) {
			await writeFile(file, out);
			files++;
		}
	}
}
console.log(`prefixed ${links} link(s) across ${files} file(s) with ${base}`);
