// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

// Build a Todo App in Go — the book site.
// Astro + Starlight, run with Bun. `bun run build` emits a static site to dist/.
export default defineConfig({
	// Placeholder until the book has a real home; keeps the sitemap happy.
	site: 'https://example.com/',
	integrations: [
		starlight({
			title: 'Build a Todo App in Go',
			description:
				'A beginner-friendly, step-by-step course that builds a real Go application from an empty folder.',
			plugins: [starlightLinksValidator()],
			sidebar: [
				{ label: 'Start here', slug: 'start-here' },
				{
					label: 'Part I — Getting started',
					items: [{ autogenerate: { directory: 'part-i' } }],
				},
				{
					label: 'Part II — Structuring the code',
					items: [{ autogenerate: { directory: 'part-ii' } }],
				},
				{
					label: 'Part III — Testing',
					items: [{ autogenerate: { directory: 'part-iii' } }],
				},
				{
					label: 'Part IV — Concurrency',
					items: [{ autogenerate: { directory: 'part-iv' } }],
				},
				{
					label: 'Part V — The data layer',
					items: [{ autogenerate: { directory: 'part-v' } }],
				},
				{
					label: 'Part VI — The command-line app',
					items: [{ autogenerate: { directory: 'part-vi' } }],
				},
				{
					label: 'Part VII — The HTTP API',
					items: [{ autogenerate: { directory: 'part-vii' } }],
				},
				{
					label: 'Part VIII — The web UI',
					items: [{ autogenerate: { directory: 'part-viii' } }],
				},
				{
					label: 'Part IX — The terminal UI',
					items: [{ autogenerate: { directory: 'part-ix' } }],
				},
				{
					label: 'Part X — Shipping it',
					items: [{ autogenerate: { directory: 'part-x' } }],
				},
				{
					label: 'Appendices',
					items: [{ autogenerate: { directory: 'appendices' } }],
				},
			],
		}),
	],
});
