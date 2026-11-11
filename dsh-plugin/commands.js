import { createCommandSpecs } from './lib/tools.mjs';

export const name = 'plugin-atlas-commands';
export const inject = ['commands'];
export function apply(ctx, config = {}) {
  for (const spec of createCommandSpecs(config)) ctx.commands.register(spec);
}
