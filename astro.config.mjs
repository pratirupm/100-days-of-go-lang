// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

// 100 Days of Go Lang — the book site.
// Astro + Starlight, run with Bun. `bun run build` emits a static site to dist/.
import stripVerifyMarkers from './src/integrations/strip-verify-markers.mjs';
import pwa from './src/integrations/pwa.mjs';

// Register the service worker only in production builds; the dev server
// must never cache itself.
const isBuild = process.env.NODE_ENV === 'production';

export default defineConfig({
	// Placeholder until the book has a real home; keeps the sitemap happy.
	site: 'https://example.com/',
	integrations: [
		// Verification markers stay in the source for `bun run verify`,
		// but are stripped from the pages readers see.
		stripVerifyMarkers(),
		starlight({
			title: '100 Days of Go Lang',
			description:
				'A 100-day Go course: the first 60 days build a real application from an empty folder; the next 40 are on the way.',
			customCss: ['./src/styles/custom.css'],
			components: {
				// Dark is the default theme for a reader with no stored choice.
				ThemeProvider: './src/components/ThemeProvider.astro',
			},
			// Long code lines wrap instead of clipping — a beginner must
			// never wonder whether a line continues past the edge. The warm
			// gruvbox pair matches the paper-and-amber palette.
			expressiveCode: {
				defaultProps: { wrap: true },
				themes: ['gruvbox-light-soft', 'gruvbox-dark-soft'],
			},
			// Arrow-key navigation between chapters, and the client-side
			// progress tracker (localStorage only). The first script gives a
			// first-time visitor a stored `dark` choice — Starlight's theme
			// select otherwise re-applies `auto` (the system setting) on
			// load, undoing the dark-first default. An explicit `auto` (an
			// empty stored value) is respected.
			head: [
				{
					tag: 'script',
					content:
						"(() => { try { if (localStorage.getItem('starlight-theme') === null) localStorage.setItem('starlight-theme', 'dark'); } catch {} })();",
				},
				{ tag: 'script', attrs: { src: '/keys.js', defer: true } },
				{ tag: 'script', attrs: { src: '/tracker.js', defer: true } },
				// Installable, offline-first: manifest, theme chrome, and the
				// service-worker registration (production builds only).
				{ tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' } },
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#1e1915' } },
				{ tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
				{ tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: 'Todo in Go' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' } },
				...(isBuild
					? [
							{
								tag: 'script',
								content:
									"if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));",
							},
						]
					: []),
			],
			plugins: [starlightLinksValidator()],
			sidebar: [
				{ label: 'Start here', slug: 'start-here' },
				{
					label: 'The 60 days',
					collapsed: true,
					items: [{ autogenerate: { directory: 'days' } }],
				},
				{
					label: 'The next 30 days',
					collapsed: true,
					items: [{ autogenerate: { directory: 'next-30' } }],
				},
				{
					label: 'The 10 days of DSA',
					collapsed: true,
					items: [{ autogenerate: { directory: 'dsa-10' } }],
				},
				{
					label: 'Appendices',
					collapsed: true,
					items: [{ autogenerate: { directory: 'appendices' } }],
				},
				{ label: 'Credits', slug: 'credits' },
				{ label: 'Disclaimer', slug: 'disclaimer' },
			],
		}),
		// The offline-first service worker + precache manifest, written into
		// dist at the end of every build. Last, so Starlight's Pagefind
		// index exists by the time the manifest is collected.
		pwa(),
	],
});
