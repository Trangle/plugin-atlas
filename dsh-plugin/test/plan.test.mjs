import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTree } from '../lib/tree/caps.mjs';
import { listFamilies, resolveFamily, representatives, draftPlan } from '../lib/tree/families.mjs';
import { plan, listPlans, markStale, refreshStalePlans } from '../lib/pipeline/plan.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { registerBackend } from '../lib/model/index.mjs';

const graph = {
  nodes: [
    { id: 'root', type: 'root' },
    ...['a', 'b'].map((id) => ({ id, type: 'branch', parent: 'root' })),
    ...[
      ['p', 'a'],
      ['q', 'a'],
      ['r', 'b'],
    ].map(([id, parent]) => ({ id, type: 'plugin', parent })),
  ],
};
const plugins = [
  {
    id: 'p',
    name: 'P',
    version: '1',
    stars: 100,
    capabilities: ['共同能力', '面板'],
    tools: ['open'],
    deps_dsh: ['core@1'],
  },
  {
    id: 'q',
    name: 'Q',
    version: '1',
    capabilities: ['共同能力', '额外能力'],
    tools: ['open'],
    deps_dsh: ['core@2'],
    capability_red_lines: ['禁止写入'],
  },
  { id: 'r', name: 'R', version: '1', capabilities: ['其他能力'] },
];
const capabilities = { a: { duplicates: [['p', 'q']], union: [{ capability: '面板', best_impl: 'p' }] } };
const makeIndex = () => buildTree({ graph, plugins, capabilities });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-plan-'));
  const cfg = resolveConfig({
    root,
    dataDir: path.join(root, 'data'),
    stateDir: path.join(root, 'state'),
    backend: 'mock',
  });
  await fs.mkdir(cfg.dataDir, { recursive: true });
  await fs.writeFile(path.join(cfg.dataDir, 'graph.json'), JSON.stringify(graph));
  await fs.writeFile(path.join(cfg.dataDir, 'plugins.jsonl'), plugins.map(JSON.stringify).join('\n'));
  await fs.mkdir(path.join(cfg.dataDir, 'capabilities'));
  await fs.writeFile(path.join(cfg.dataDir, 'capabilities', 'a.json'), JSON.stringify(capabilities.a));
  return cfg;
}
test('分叉族、代表和确定性草案', () => {
  const index = makeIndex();
  assert.deepEqual(
    listFamilies(index).map((x) => x.id),
    ['a', 'dup:a:1', 'b'],
  );
  assert.equal(resolveFamily(index, 'q').id, 'a');
  assert.equal(representatives(index, 'a')[0].id, 'p');
  const draft = draftPlan(index, 'a');
  assert.equal(draft.base, 'p');
  assert.ok(draft.absorb.some((x) => x.from === 'q' && x.capabilities.includes('额外能力')));
  assert.ok(draft.conflicts.some((x) => x.tool === 'open'));
  assert.ok(draft.conflicts.some((x) => x.dep === 'core'));
  assert.ok(draft.conflicts.some((x) => x.red_line));
  assert.ok(draft.steps.length >= 5);
});
test('缓存、过期刷新、dry-run 和预算恢复', async () => {
  const cfg = await setup();
  let calls = 0;
  registerBackend('count-plan', () => ({
    async complete() {
      calls++;
      throw new Error('不可调用');
    },
  }));
  const dry = await plan(cfg, { family: 'a', dryRun: true, backend: 'count-plan' });
  assert.equal(dry.status, 'dry-run');
  assert.equal(calls, 0);
  const first = await plan(cfg, { family: 'a' });
  assert.equal(first.source, 'model');
  await plan(cfg, { family: 'b' });
  assert.equal((await plan(cfg, { family: 'p' })).cached, true);
  const updated = plugins.map((p) => (p.id === 'q' ? { ...p, version: '2' } : p));
  await fs.writeFile(path.join(cfg.dataDir, 'plugins.jsonl'), updated.map(JSON.stringify).join('\n'));
  assert.equal((await plan(cfg, { family: 'a' })).stale, true);
  assert.deepEqual(
    (await listPlans(cfg)).filter((x) => x.stale).map((x) => x.family),
    ['a'],
  );
  const refreshed = await refreshStalePlans(cfg, { budget: 1, concurrency: 1 });
  assert.equal(refreshed.status, 'stopped');
  assert.equal(refreshed.done, 0);
  const resumed = await refreshStalePlans(cfg, { resume: refreshed.runId, budget: 20000 });
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(resumed.completed, ['a']);
  assert.equal((await listPlans(cfg)).filter((x) => x.stale).length, 0);
  await markStale(cfg, ['b']);
  const preview = await refreshStalePlans(cfg, { dryRun: true, backend: 'count-plan' });
  assert.equal(preview.total, 1);
  assert.equal(calls, 0);
  assert.deepEqual((await refreshStalePlans(cfg, {})).completed, ['b']);
});
