import { createCommandSpecs } from './lib/commands.mjs';
import { getPipeline } from './lib/pipeline/index.mjs';
const name = 'plugin-atlas-commands';
const inject = ['commands'];
function apply(ctx, config = {}) {
  const p = getPipeline(config);
  for (const spec of createCommandSpecs(config)) ctx.commands.register(spec);
  ctx.inject?.(['llm', 'agentDefaultModel'], (sub) => {
    p.setServices({ llm: sub.llm, agentDefaultModel: sub.agentDefaultModel });
  });
}
export { apply, inject, name };
