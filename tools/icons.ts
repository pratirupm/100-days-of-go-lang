#!/usr/bin/env bun
/**
 * Generate the app icons from one SVG mark: an amber check on the book's
 * espresso ground (the todo app's own tick). Rendered with sharp, which
 * Astro already depends on.
 *
 * Run: bun run icons
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'public/icons');

const BG = '#1e1915'; // espresso, the book's dark ground
const FG = '#e8a33e'; // amber accent

// A rounded-square tile with a check; `pad` shrinks the check for the
// maskable variant's safe zone.
const svg = (pad: number) => {
	const s = 512;
	const inset = s * pad;
	const box = s - inset * 2;
	const check = `M ${inset + box * 0.22} ${inset + box * 0.54} L ${inset + box * 0.43} ${inset + box * 0.74} L ${inset + box * 0.8} ${inset + box * 0.3}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
	<rect width="${s}" height="${s}" rx="${s * 0.18}" fill="${BG}"/>
	<path d="${check}" fill="none" stroke="${FG}" stroke-width="${box * 0.12}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
};

await mkdir(OUT, { recursive: true });

const icon = svg(0.16);
const maskable = svg(0.24);

await sharp(Buffer.from(icon)).resize(192, 192).png().toFile(join(OUT, 'icon-192.png'));
await sharp(Buffer.from(icon)).resize(512, 512).png().toFile(join(OUT, 'icon-512.png'));
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile(join(OUT, 'maskable-512.png'));
await sharp(Buffer.from(icon)).resize(180, 180).png().toFile(join(OUT, 'apple-touch-icon.png'));
await writeFile(join(ROOT, 'public/favicon.svg'), icon + '\n');

// The Open Graph card: 1200×630, espresso ground, amber check, the name.
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
	<rect width="1200" height="630" fill="${BG}"/>
	<path d="M 520 200 L 570 250 L 690 130" fill="none" stroke="${FG}" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
	<text x="600" y="400" text-anchor="middle" font-family="DejaVu Sans, Verdana, sans-serif" font-size="76" font-weight="bold" fill="${FG}">100 Days of Go Lang</text>
	<text x="600" y="480" text-anchor="middle" font-family="DejaVu Sans, Verdana, sans-serif" font-size="34" fill="#e8e2d8">A 100-day Go course for beginners</text>
</svg>`;
await sharp(Buffer.from(og)).png().toFile(join(ROOT, 'public/og.png'));

console.log('wrote icons to public/icons (192, 512, maskable-512, apple-touch-icon), public/favicon.svg, and public/og.png');
