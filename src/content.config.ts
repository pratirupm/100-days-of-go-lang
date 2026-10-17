import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { z } from 'astro/zod';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			// The 60-day plan: which day a chapter is, and how long it takes.
			// Rendered as a badge under the page title.
			extend: z.object({
				day: z.number().optional(),
				time: z.string().optional(),
			}),
		}),
	}),
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
