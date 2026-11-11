import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../lib/config.mjs';
import { extract } from '../lib/pipeline/extract.mjs';
import { merge } from '../lib/pipeline/update.mjs';
import { compare } from '../lib/pipeline/compare.mjs';
import { search } from '../lib/pipeline/recall.mjs';
import { parseCommand, dispatch } from '../lib/commands.mjs';
import { formatResult } from '../lib/format.mjs';
import { registerBackend } from '../lib/model/index.mjs';
const write = (p, x) => fs.writeFile(p, x.map(JSON.stringify).join('\n') + '\n');
test('增量、预算、续跑、合并和本地搜索', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-test-'));
  try {
    const data = path.join(root, 'data');
    await fs.mkdir(path.join(data, 'readmes'), { recursive: true });
    const cfg = resolveConfig({
      root,
      backend: 'mock',
      batchSize: 1,
      concurrency: 2,
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 50,
    });
    const base = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      name: `插件${i}`,
      description: `描述${i}`,
      repo: i < 2 ? 'https://github.com/a/b' : null,
      readme_path: i < 2 ? `data/readmes/${i}.md` : null,
      version: '1',
    }));
    await fs.writeFile(path.join(data, 'readmes/0.md'), '第一份');
    await fs.writeFile(path.join(data, 'readmes/1.md'), '第二份');
    await write(path.join(data, 'plugins_base.jsonl'), base);
    await write(
      path.join(data, 'plugins.jsonl'),
      base
        .slice(0, 2)
        .map((x) => ({ ...x, summary: '摘要', category_id: 'c1', branch_id: 'b1', capabilities: ['甲', '乙', '丙'] })),
    );
    await fs.writeFile(
      path.join(data, 'graph.json'),
      JSON.stringify({
        nodes: [
          { id: 'c1', type: 'category' },
          { id: 'c2', type: 'category' },
          { id: 'b1', type: 'branch', parent: 'c1' },
          { id: 'b2', type: 'branch', parent: 'c1' },
          { id: 'b3', type: 'branch', parent: 'c2' },
        ],
      }),
    );
    const preview = await extract(cfg, { dryRun: true });
    assert.equal(preview.total, 3);
    await assert.rejects(fs.stat(path.join(cfg.stateDir, 'overlay.jsonl')));
    const first = await extract(cfg, {});
    assert.equal(first.done, 3);
    assert.equal(first.status, 'completed');
    const again = await extract(cfg, { resume: first.runId });
    assert.equal(again.done, 0);
    await fs.writeFile(path.join(data, 'readmes/0.md'), '内容变化');
    assert.equal((await extract(cfg, { dryRun: true })).total, 1);
    const before = await fs.readFile(path.join(data, 'plugins.jsonl'), 'utf8');
    assert.equal((await merge(cfg, {})).count, 3);
    assert.equal(await fs.readFile(path.join(data, 'plugins.jsonl'), 'utf8'), before);
    const applied = await merge(cfg, { dryRun: false, skipScripts: true });
    assert.ok(await fs.stat(path.join(applied.backup, 'plugins.jsonl')));
    assert.equal((await compare(cfg, { branchId: 'b1' })).pairs[0].verdict, 'duplicate');
    assert.equal((await search(cfg, '插件0')).source, 'local');
    const limited = await extract(cfg, { force: true, budget: 1, backend: 'llm' });
    assert.equal(limited.status, 'stopped');
    assert.ok(await fs.stat(path.join(cfg.stateDir, 'extract', limited.runId, 'progress.json')));
    assert.equal(parseCommand('memory').sub, 'search');
    for (const cmd of ['update', 'refresh', 'summarize', 'merge', 'status', 'compare', 'service', 'search'])
      assert.equal(parseCommand(cmd).sub, cmd);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('LLM 流式 usage 与额度错误', async () => {
  const { createLlmBackend } = await import('../lib/model/llm.mjs');
  let quota = false;
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
    llm: {
      async prepareCall() {
        return {
          config: {},
          async *stream() {
            if (quota) {
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '额度不足' } } };
              return;
            }
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: '测试' };
            yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    },
  };
  const llm = createLlmBackend(services);
  const r = await llm.complete({ prompt: 'x', system: 's', maxTokens: 30 });
  assert.equal(r.text, '测试');
  assert.equal(r.usage.totalTokens, 15);
  quota = true;
  await assert.rejects(llm.complete({ prompt: 'x', maxTokens: 30 }), (e) => e.code === 'QUOTA');
});

test('并发池、额度中止、陈旧锁和增量合并', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-pool-'));
  try {
    const data = path.join(root, 'data');
    await fs.mkdir(data, { recursive: true });
    const cfg = resolveConfig({ root, backend: 'pool-test', batchSize: 1, concurrency: 2 });
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, name: `插件${i}` }));
    await write(path.join(data, 'plugins_base.jsonl'), items);
    await write(path.join(data, 'plugins.jsonl'), []);
    await fs.writeFile(
      path.join(data, 'graph.json'),
      JSON.stringify({
        nodes: [
          { id: 'c', type: 'category' },
          { id: 'b', type: 'branch', parent: 'c' },
        ],
      }),
    );
    let active = 0,
      maximum = 0,
      calls = 0,
      quota = false;
    registerBackend('pool-test', () => ({
      async complete({ prompt }) {
        active++;
        calls++;
        maximum = Math.max(maximum, active);
        try {
          if (quota) {
            const error = new Error('额度不足');
            error.code = 'QUOTA';
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
          const input = JSON.parse(prompt.split('INPUT_JSON:')[1]);
          return {
            text: JSON.stringify(
              input.items.map((x) => ({
                id: x.id,
                summary: '摘要',
                capabilities: ['甲', '乙', '丙'],
                category_id: 'c',
                branch_id: 'b',
              })),
            ),
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        } finally {
          active--;
        }
      },
    }));
    const result = await extract(cfg);
    assert.equal(result.done, 6);
    assert.equal(maximum, 2);
    await merge(cfg, { dryRun: false, skipScripts: true });
    assert.equal((await merge(cfg, { dryRun: true })).count, 0);
    await fs.writeFile(path.join(cfg.stateDir, 'overlay.jsonl'), '');
    quota = true;
    calls = 0;
    const stopped = await extract(cfg, { force: true });
    assert.equal(stopped.stopReason, 'provider:QUOTA');
    assert.ok(calls <= 2);
    const { getPipeline } = await import('../lib/pipeline/index.mjs');
    await fs.writeFile(
      path.join(cfg.stateDir, 'lock'),
      JSON.stringify({ pid: 2147483647, at: new Date().toISOString() }),
    );
    assert.equal((await getPipeline(cfg).merge({ dryRun: true })).staleLockCleared, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('比较多级分支、能力回退和分支建议', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-compare-'));
  try {
    const dataDir = path.join(root, 'data');
    await fs.mkdir(path.join(dataDir, 'capabilities', 'c'), { recursive: true });
    const nodes = [
      { id: 'c', type: 'category', label: '分类' },
      { id: 'c.main', type: 'branch', parent: 'c', label: '主分支' },
      { id: 'c.main.deep', type: 'branch', parent: 'c.main', label: '深分支', plugin_ids: ['a'] },
      { id: 'c.other', type: 'branch', parent: 'c', label: '其他' },
    ];
    await fs.writeFile(path.join(dataDir, 'graph.json'), JSON.stringify({ nodes }));
    const plugins = [
      { id: 'a', name: '目标', category_id: 'c', summary: '相同摘要', capabilities: ['x'] },
      { id: 'b', category_id: 'c', branch_id: 'c.main.deep', summary: '相同摘要', capabilities: ['x'] },
      { id: 'd', category_id: 'c', branch_id: 'c.main', summary: '不同', capabilities: ['y'] },
      { id: 'e', category_id: 'c', branch_id: 'c.main', summary: '不同', capabilities: ['z'] },
      { id: 'f', category_id: 'c', branch_id: 'c.main', summary: '不同', capabilities: [] },
      { id: 'outside', category_id: 'c', branch_id: 'c.other', summary: '相同摘要', capabilities: ['x'] },
    ];
    await write(path.join(dataDir, 'plugins.jsonl'), plugins);
    await fs.writeFile(path.join(dataDir, 'capabilities', 'c.json'), JSON.stringify({ union: [{ capability: '分类能力', provided_by: [] }] }));
    await fs.writeFile(path.join(dataDir, 'capabilities', 'c', 'c.main.json'), JSON.stringify({ union: [{ capability: '分支能力', provided_by: ['a', 'b'], best_impl: 'a' }] }));
    const cfg = { dataDir };
    const result = await compare(cfg, { ids: ['a', 'b'] });
    assert.equal(result.targets[0].branch, 'c.main.deep');
    assert.equal(result.targets[0].scope, 'c.main');
    assert.equal(result.targets[0].peers[0].plugin.id, 'b');
    assert.equal(result.matrix[0][1], 1);
    assert.match(result.text, /分支能力 · 2 · a · 目标提供 · 目标最佳实现/);
    assert.doesNotMatch(result.text, /outside/);
    const branch = await compare(cfg, { branchId: 'c.main.deep' });
    assert.equal(branch.plugins.length, 2);
    assert.match(branch.text, /分支能力/);
    assert.match((await compare(cfg, { branchId: 'c.other' })).text, /分类能力/);
    assert.equal((await compare(cfg, { branchId: 'c.main.de' })).suggestions[0], 'c.main.deep');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('mock 预算、过滤变更集、overlay 和 merge 输出', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-regression-'));
  try {
    const data = path.join(root, 'data');
    await fs.mkdir(data, { recursive: true });
    const cfg = resolveConfig({ root, backend: 'mock', batchSize: 1 });
    const base = ['kept', 'filtered', 'merged', 'new'].map((id) => ({ id, name: id }));
    await write(path.join(data, 'plugins_base.jsonl'), base);
    await write(path.join(data, 'plugins.jsonl'), [{ ...base[0], summary: '摘要', category_id: 'c', branch_id: null }]);
    await write(path.join(data, 'filtered-out.jsonl'), [{ id: 'filtered' }]);
    await write(path.join(data, 'dedup-merged.jsonl'), [{ id: 'merged', into: 'kept' }]);
    await fs.writeFile(path.join(data, 'graph.json'), JSON.stringify({ nodes: [{ id: 'c', type: 'category' }] }));
    const preview = await extract(cfg, { dryRun: true });
    assert.equal(preview.total, 1);
    assert.equal(preview.excludedFiltered, 1);
    assert.equal(preview.excludedDeduped, 1);
    assert.equal((await extract(cfg, { dryRun: true, includeFiltered: true })).total, 3);
    assert.equal((await extract(cfg, { dryRun: true, ids: ['filtered'] })).total, 1);
    const result = await extract(cfg, { budget: 1 });
    assert.equal(result.status, 'completed');
    const budget = JSON.parse(await fs.readFile(path.join(cfg.stateDir, 'budget.json')));
    assert.equal(budget.totalTokens, 0);
    assert.ok(budget.mock.totalTokens > 0);
    const usage = JSON.parse((await fs.readFile(path.join(cfg.stateDir, 'usage.jsonl'), 'utf8')).trim());
    assert.equal(usage.backend, 'mock');
    assert.equal((await extract(cfg, { force: true, ids: ['new'], dryRun: true })).total, 0);
    const applied = await merge(cfg, { dryRun: false, runner: async (_cfg, script) => ({ script, code: 0, elapsedMs: 5, stdout: '{"ok":1}' }), service: { status: async () => ({ ok: false }) } });
    const text = formatResult(applied, 'merge');
    assert.match(text, /备份路径/);
    assert.match(text, /更新.新增：0.1/);
    assert.match(text, /dedup.mjs.*退出码 0.*耗时 5/);
    assert.match(text, /服务未运行，跳过 reload/);
    const limits = [];
    const p = { compare: (opts) => limits.push(opts.limit) };
    await dispatch(p, 'compare a');
    await dispatch(p, 'compare a --limit 3');
    assert.deepEqual(limits, [10, 3]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
