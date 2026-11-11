import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dispatch, parseCommand } from '../lib/commands.mjs';
import { formatResult } from '../lib/format.mjs';
import { getPipeline } from '../lib/pipeline/index.mjs';
import { createToolSpecs } from '../lib/tools.mjs';

test('树、族和计划命令与工具使用临时数据', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-commands-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  const graph = {
    nodes: [
      { id: 'root', type: 'root', label: '根', plugin_ids: ['p'] },
      { id: 'a', type: 'branch', parent: 'root', label: '分支甲', plugin_ids: ['p'] },
      { id: 'p', type: 'plugin', parent: 'a', label: '插件甲', plugin_ids: ['p'] },
    ],
  };
  await fs.writeFile(path.join(dataDir, 'graph.json'), JSON.stringify(graph));
  await fs.writeFile(
    path.join(dataDir, 'plugins.jsonl'),
    [
      { id: 'p', name: '插件甲', branch_id: 'a', capabilities: ['面板'] },
      { id: 'q', name: '插件乙', branch_id: 'a', capabilities: ['命令'] },
    ]
      .map(JSON.stringify)
      .join('\n'),
  );
  const cfg = { root, dataDir, stateDir: path.join(root, 'state'), logsDir: path.join(root, 'logs'), backend: 'mock' };
  const pipeline = getPipeline(cfg);
  let reloads = 0;
  pipeline.setServices({
    service: {
      reload: async () => {
        reloads++;
        return { ok: true };
      },
    },
  });
  async function run(raw) {
    return formatResult(await dispatch(pipeline, raw), parseCommand(raw).sub);
  }
  assert.match(await run('tree --depth 1 --caps'), /分支甲/);
  assert.match(await run('tree 插件甲 --depth 0'), /插件甲/);
  assert.match(await run('tree find 插件甲'), /路径.*插件甲/);
  const preview = await run('tree sync --dry-run --limit 5');
  assert.match(preview, /树 attach：1/);
  assert.match(preview, /挂载 插件乙 → 分支甲（a，相似度/);
  assert.match(preview, /用 \/atlas tree sync --apply 执行/);
  assert.doesNotMatch(preview, /\{\"|completed/);
  const applied = await run('tree sync --apply');
  assert.match(applied, /已执行/);
  assert.doesNotMatch(applied, /completed|\{\"/);
  assert.match(await run('families a'), /计划 无/);
  assert.equal(reloads, 1);
  assert.match(await run('tree history'), /apply/);
  assert.match(await run('families a'), /族：a/);
  assert.match(await run('plan p --dry-run --backend mock --budget 20000'), /基底/);
  assert.match(await run('plan a --refresh --backend mock'), /来源/);
  const plugins = (await fs.readFile(path.join(dataDir, 'plugins.jsonl'), 'utf8')).replace(
    '"name":"插件甲"',
    '"name":"插件甲","version":"2"',
  );
  await fs.writeFile(path.join(dataDir, 'plugins.jsonl'), plugins);
  assert.match(await run('families a --stale'), /过期/);
  assert.match(
    await run('plans refresh --dry-run --limit 1 --concurrency 1 --backend mock --budget 20000'),
    /进度：0\/1/,
  );
  assert.match(await run('plans refresh --backend mock'), /进度：1\/1/);
  assert.match(await run('status'), /计划 总数\/过期：1\/0/);
  assert.match(await run('tree rollback'), /已回滚/);
  assert.equal(reloads, 2);
  assert.match(await run('tree history'), /rollback/);
  const tools = createToolSpecs(cfg);
  assert.match((await tools.find((x) => x.name === 'plugin_atlas_tree_sync').execute({})).text, /预演/);
  assert.match(
    (await tools.find((x) => x.name === 'plugin_atlas_plan').execute({ id: 'a', refresh: true })).text,
    /预演/,
  );
});

test('树示例和族分页格式', () => {
  const patch = {
    counts: { fork: 1, duplicate: 1, move: 1 },
    ops: {
      fork: [{ upstream: 'u', forks: ['f'], evidence: ['仓库相同'] }],
      duplicate: [{ keep: 'u', duplicates: ['f'], evidence: ['README 哈希相同'] }],
      move: [{ id: 'f', from: 'a', to: 'b', reason: '相似' }],
    },
  };
  const output = formatResult(
    {
      status: 'dry-run',
      patch,
      file: '/tmp/patch',
      display: { plugins: { u: '上游名', f: '插件名' }, branches: { a: '旧', b: '新' } },
    },
    'tree',
  );
  assert.match(output, /上游 上游名 ← 1 个 fork：插件名（证据：仓库相同）/);
  assert.match(output, /保留 上游名，重复 1 个：插件名/);
  assert.match(output, /移动 插件名：旧 → 新（相似）/);
  assert.doesNotMatch(output, /\{\"|completed/);
});

test('族默认分页及计划状态', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-family-page-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'),
    stateDir = path.join(root, 'state');
  await fs.mkdir(dataDir);
  await fs.writeFile(
    path.join(dataDir, 'graph.json'),
    JSON.stringify({
      nodes: Array.from({ length: 35 }, (_, i) => ({
        id: `b${String(i).padStart(2, '0')}`,
        type: 'branch',
        label: `分支${i}`,
        plugin_ids: [],
      })),
    }),
  );
  await fs.writeFile(path.join(dataDir, 'plugins.jsonl'), '');
  await fs.mkdir(path.join(stateDir, 'plans'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 'plans', '_stale.json'), JSON.stringify(['b00']));
  const pipeline = getPipeline({ root, dataDir, stateDir });
  const result = await dispatch(pipeline, 'families');
  assert.equal(result.families.length, 30);
  assert.equal(result.families[0].planStatus, '待生成');
  assert.equal(result.families[1].planStatus, '无');
  assert.match(formatResult(result, 'families'), /共 35 个族，已显示 30/);
  const page = await dispatch(pipeline, 'families --limit 3 --offset 30');
  assert.deepEqual(
    page.families.map((f) => f.id),
    ['b30', 'b31', 'b32'],
  );
});

test('tree sync --apply 拒绝写入带 crawler/web 的仓库 data，安装布局下仍生效', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-prod-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'crawler'));
  await fs.mkdir(path.join(root, 'web'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  await fs.writeFile(
    path.join(dataDir, 'graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'root', type: 'root', label: '根', plugin_ids: [] },
        { id: 'a', type: 'branch', parent: 'root', label: '分支', plugin_ids: [] },
      ],
    }),
  );
  await fs.writeFile(
    path.join(dataDir, 'plugins.jsonl'),
    JSON.stringify({ id: 'q', name: '插件乙', branch_id: 'a' }) + '\n',
  );
  const pipeline = getPipeline({
    root,
    dataDir,
    stateDir: path.join(root, 'state'),
    logsDir: path.join(root, 'logs'),
    backend: 'mock',
  });
  pipeline.setServices({ service: { reload: async () => ({ ok: true }) } });
  const preview = await dispatch(pipeline, 'tree sync --dry-run');
  assert.equal(preview.status, 'dry-run');
  await assert.rejects(dispatch(pipeline, 'tree sync --apply'), /拒绝写入生产数据/);
  const applied = await dispatch(pipeline, 'tree sync --apply --allow-production');
  assert.equal(applied.status, 'completed');
  assert.ok(applied.applied.stamp && applied.applied.after && applied.applied.after !== applied.applied.before);
  const graph = JSON.parse(await fs.readFile(path.join(dataDir, 'graph.json'), 'utf8'));
  assert.ok(graph.nodes.some((n) => n.id === 'q' && n.parent === 'a'));
});
