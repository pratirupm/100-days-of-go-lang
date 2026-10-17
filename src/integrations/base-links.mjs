// Rewrites internal absolute links in the built HTML to include the site's
// base path.
//
// Astro prefixes its own asset and navigation URLs with `base`, but links
// written in Markdown are emitted as-is (documented Astro behavior) — and a
// GitHub Pages project site serves everything under /<repo>/. This pass runs
// before Starlight's link validator, so the validator sees the final hrefs.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK = /(href|src)="\/([^"#]*)(#[^"]*)?"/g;

async function* htmlFiles(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* htmlFiles(path);
		else if (entry.name.endsWith('.html')) yield path;
	}
}

export default function baseLinks({ base = '' } = {}) {
	return {
		name: 'base-links',
		hooks: {
			'astro:build:done': async ({ dir, logger }) => {
				if (!base || base === '/') return;
				const root = fileURLToPath(dir);
				const prefix = base.replace(/^\//, '');
				let rewritten = 0;
				for await (const file of htmlFiles(root)) {
					const html = await readFile(file, 'utf8');
					const out = html.replace(LINK, (match, attr, path, hash = '') => {
						// Protocol-relative URLs stay untouched.
						if (path.startsWith('/')) return match;
						// Already prefixed by Astro.
						if (path.startsWith(prefix)) return match;
						rewritten++;
						return `${attr}="${base}/${path}${hash}"`;
					});
					if (out !== html) await writeFile(file, out);
				}
				logger.info(`prefixed ${rewritten} internal link(s) with the base path`);
			},
		},
	};
}
