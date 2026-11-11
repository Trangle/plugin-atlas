import path from 'node:path';
import { readJson, readLines } from '../io.mjs';
import { service } from './service.mjs';
/** 处理对应的图谱操作。 */
async function status(cfg) {
  const budget = await readJson(path.join(cfg.stateDir, 'budget.json'), { totalTokens: 0 });
  const merged = await readJson(path.join(cfg.stateDir, 'merged.json'), {});
  const overlay = await readLines(path.join(cfg.stateDir, 'overlay.jsonl'));
  const runs = {};
  for (const stage of ['collect', 'summarize', 'merge']) {
    runs[stage] = await readJson(path.join(cfg.stateDir, 'runs', `${stage}.json`), null);
  }
  return {
    service: await service(cfg).status(),
    runs,
    budget,
    budgetLimit: cfg.budgetTokens,
    runBudgetTokens: cfg.runBudgetTokens,
    remainingTokens: Math.max(0, cfg.budgetTokens - budget.totalTokens),
    overlayCount: overlay.filter((x) => !x.fingerprint || merged[x.id] !== x.fingerprint).length,
    fingerprintCount: Object.keys(await readJson(path.join(cfg.stateDir, 'fingerprints.json'), {})).length,
    schedule: cfg.schedule,
  };
}
export { status };
