import { defineTool } from '@deepseek-ai/dsh-tools';
import { createToolSpecs } from './lib/tools.mjs';

export const name = 'plugin-atlas';
export const inject = ['tools'];
export function apply(ctx, config = {}) {
  for (const spec of createToolSpecs(config)) ctx.tools.register(defineTool(spec));
}
