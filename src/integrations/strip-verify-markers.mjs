// Strips internal bookkeeping markers from the built HTML.
//
// The markers (`<!-- verify: path at=tag -->` and `<!-- transcripts: authored -->`)
// stay in the Markdown source — the gates read them — but they name internal
// checkpoint tags, so they must never reach the reader-facing pages.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = /<!--\s*(?:verify|transcripts):[^>]*-->\n?/g;

async function* htmlFiles(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* htmlFiles(path);
		else if (entry.name.endsWith('.html')) yield path;
	}
}

export default function stripVerifyMarkers() {
	return {
		name: 'strip-verify-markers',
		hooks: {
			'astro:build:done': async ({ dir, logger }) => {
				const root = fileURLToPath(dir);
				let stripped = 0;
				for await (const file of htmlFiles(root)) {
					const html = await readFile(file, 'utf8');
					const cleaned = html.replace(MARKER, '');
					if (cleaned !== html) {
						await writeFile(file, cleaned);
						stripped++;
					}
				}
				if (stripped > 0) {
					logger.info(`stripped verification markers from ${stripped} page(s)`);
				}
			},
		},
	};
}
