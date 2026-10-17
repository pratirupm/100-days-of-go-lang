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

console.log('wrote icons to public/icons (192, 512, maskable-512, apple-touch-icon) and public/favicon.svg');
