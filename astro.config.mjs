// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

// Build a Todo App in Go — the book site.
// Astro + Starlight, run with Bun. `bun run build` emits a static site to dist/.
import stripVerifyMarkers from './src/integrations/strip-verify-markers.mjs';

export default defineConfig({
	// Placeholder until the book has a real home; keeps the sitemap happy.
	site: 'https://example.com/',
	integrations: [
		// Verification markers stay in the source for `bun run verify`,
		// but are stripped from the pages readers see.
		stripVerifyMarkers(),
		starlight({
			title: 'Build a Todo App in Go',
			description:
				'A beginner-friendly, step-by-step course that builds a real Go application from an empty folder.',
			customCss: ['./src/styles/custom.css'],
			// Long code lines wrap instead of clipping — a beginner must
			// never wonder whether a line continues past the edge.
			expressiveCode: {
				defaultProps: { wrap: true },
			},
			// Arrow-key navigation between chapters, matching the reading
			// flow (the prev/next cards at the foot of every page).
			head: [{ tag: 'script', attrs: { src: '/keys.js', defer: true } }],
			plugins: [starlightLinksValidator()],
			sidebar: [
				{ label: 'Start here', slug: 'start-here' },
				{
					label: 'Part I — Getting started',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-i' } }],
				},
				{
					label: 'Part II — Structuring the code',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-ii' } }],
				},
				{
					label: 'Part III — Testing',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-iii' } }],
				},
				{
					label: 'Part IV — Concurrency',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-iv' } }],
				},
				{
					label: 'Part V — The data layer',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-v' } }],
				},
				{
					label: 'Part VI — The command-line app',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-vi' } }],
				},
				{
					label: 'Part VII — The HTTP API',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-vii' } }],
				},
				{
					label: 'Part VIII — The web UI',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-viii' } }],
				},
				{
					label: 'Part IX — The terminal UI',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-ix' } }],
				},
				{
					label: 'Part X — Shipping it',
					collapsed: true,
					items: [{ autogenerate: { directory: 'part-x' } }],
				},
				{
					label: 'Appendices',
					collapsed: true,
					items: [{ autogenerate: { directory: 'appendices' } }],
				},
			],
		}),
	],
});
