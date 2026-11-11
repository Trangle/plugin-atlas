import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function resolveConfig(c = {}, env = process.env) {
  const root = path.resolve(
    c.root ||
      (fs.existsSync(path.join(candidate, 'crawler')) && fs.existsSync(path.join(candidate, 'web'))
        ? candidate
        : env.PLUGIN_ATLAS_ROOT || candidate),
  );
  const dataDir = path.resolve(c.dataDir || env.ATLAS_DATA_DIR || path.join(root, 'data'));
  const positive = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
  return {
    ...c,
    root,
    dataDir,
    stateDir: path.resolve(c.stateDir || path.join(dataDir, 'atlas-state')),
    logsDir: path.resolve(c.logsDir || path.join(root, 'logs')),
    baseUrl: String(c.baseUrl || env.PLUGIN_ATLAS_URL || 'http://127.0.0.1:4380').replace(/\/+$/, ''),
    backend: c.backend || 'llm',
    concurrency: Math.min(8, positive(c.concurrency, 2)),
    batchSize: positive(c.batchSize, 8),
    runBudgetTokens: positive(c.runBudgetTokens, 2e4),
    budgetTokens: positive(c.budgetTokens, 1e5),
    maxOutputTokens: positive(c.maxOutputTokens, 1500),
    schedule: { intervalMinutes: 0, dryRun: true, ...c.schedule },
    autoStartService: c.autoStartService === true,
  };
}
export { resolveConfig };
