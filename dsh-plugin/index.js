import { defineTool } from '@deepseek-ai/dsh-tools';
import { createToolSpecs } from './lib/tools.mjs';
import { getPipeline } from './lib/pipeline/index.mjs';
import { installScheduler } from './lib/scheduler.mjs';
import { skill } from './lib/skill.mjs';
const name = 'plugin-atlas';
const inject = ['tools'];
function apply(ctx, config = {}) {
  const p = getPipeline(config);
  for (const spec of createToolSpecs(config)) ctx.tools.register(defineTool(spec));
  ctx.inject?.(['llm', 'agentDefaultModel'], (sub) => {
    p.setServices({ llm: sub.llm, agentDefaultModel: sub.agentDefaultModel });
  });
  ctx.inject?.(['skills'], (sub) => sub.skills.register(skill));
  installScheduler(ctx, p);
  if (p.cfg.autoStartService) p.service.ensure().catch(() => {});
}
export { apply, inject, name };
