import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-internal-'));
process.env.ATLAS_STATE_DIR = path.join(tmp, 'state');
process.env.ATLAS_INTERNAL_TEST = '1';
process.env.ATLAS_DISABLE_MODEL = '1';
process.env.ATLAS_DATA_DIR = tmp;
process.env.ATLAS_INDEX_PATH = path.join(tmp, 'index.sqlite');
try {
  await fs.cp(new URL('./fixtures/', import.meta.url), tmp, { recursive: true });
  const file = path.join(tmp, 'plugins.jsonl');
  const plugins = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  plugins[0].readme_path = 'readmes/test.md';
  await fs.mkdir(path.join(tmp, 'readmes'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'readmes/test.md'), 'dynamictoken ' + 'x'.repeat(210000));
  await fs.writeFile(file, plugins.map(JSON.stringify).join('\n'));
  const { reload, status, search, readmeDetail, treeApi, server, internalState } = await import('./server.mjs');
  const request = (url) =>
    new Promise((resolve) =>
      server.emit(
        'request',
        { url, method: 'GET', headers: {} },
        {
          setHeader() {},
          writeHead(status) {
            this.status = status;
          },
          end(body) {
            resolve({ status: this.status, body: JSON.parse(body) });
          },
        },
      ),
    );
  const first = await reload();
  assert.ok(first.timings.index_changed > 0);
  assert.ok(status().memory.rss_mb > 0);
  const query = (q, mode = 'fulltext', limit = 20) =>
    search(new URL('http://localhost/api/search?' + new URLSearchParams({ q, mode, limit, include_github_only: 1 })));
  assert.ok((await query('dynamictoken')).results.some((x) => x.id === plugins[0].id));
  assert.ok(Buffer.byteLength(readmeDetail(plugins[0].readme_path, tmp)) <= 200 * 1024);
  assert.equal((await reload()).timings.index_changed, 0);
  await fs.writeFile(path.join(tmp, 'readmes/test.md'), 'changedtoken');
  assert.equal((await reload()).timings.index_changed, 1);
  assert.equal((await query('dynamictoken')).results.length, 0);
  assert.ok((await query('changedtoken')).results.length);
  const top = await query('示例', 'semantic', 3);
  assert.ok(top.results.length);
  assert.ok(top.results.length <= 3);
  assert.ok(top.results.every((r, i, a) => !i || a[i - 1].score >= r.score));
  const db = new DatabaseSync(path.join(tmp, 'readme-store.sqlite'));
  db.exec('CREATE TABLE readmes(path TEXT PRIMARY KEY,body BLOB,sha256 TEXT)');
  db.prepare('INSERT INTO readmes(path,body) VALUES (?,?)').run(
    'db.md',
    brotliCompressSync(Buffer.from('stored readme')),
  );
  db.close();
  assert.equal(readmeDetail('db.md', tmp), 'stored readme');
  const caps = await treeApi(new URL('http://localhost/api/tree-node?id=root'));
  assert.ok(Array.isArray(caps.ui));
  let summary = (await request('/api/families?summary=1')).body;
  assert.deepEqual(Object.keys(summary).sort(), ['computing', 'families', 'stale', 'with_plan']);
  let all = await request('/api/families');
  if (summary.computing) assert.ok([200, 202].includes(all.status));
  for (let i = 0; i < 200 && all.status === 202; i++) {
    await new Promise((r) => setTimeout(r, 20));
    all = await request('/api/families');
  }
  assert.equal(all.status, 200);
  summary = (await request('/api/families?summary=1')).body;
  assert.equal(summary.families, all.body.families.length);
  const graphFamily = all.body.families.find((f) => f.members.length);
  const snapshot = internalState();
  snapshot.fusion = null;
  snapshot.fusionPromise = new Promise(() => {});
  snapshot.graphCache.clear();
  const branchGraph = await request(`/api/branch-graph?family=${encodeURIComponent(graphFamily.id)}&expand=1`);
  assert.equal(branchGraph.status, 200);
  assert.equal(branchGraph.body.family, graphFamily.id);
  assert.equal(branchGraph.body.nodes.length, graphFamily.members.length);
  assert.equal((await request('/api/branch-graph?family=missing')).status, 404);
  assert.equal(summary.computing, false);
  const branch = await request('/api/families?branch=web');
  assert.deepEqual(
    branch.body.families,
    all.body.families.filter((f) => f.branch === 'web'),
  );
  const found = (await request('/api/tree-find?q=web&limit=2')).body.matches;
  assert.ok(found.length <= 2);
  assert.ok(found.length);
  assert.deepEqual(Object.keys(found[0]).sort(), ['id', 'label', 'match', 'path', 'type']);
  assert.deepEqual((await request('/api/plan?id=web')).body, {
    id: 'web',
    status: 'none',
    command: '/atlas plan web --dry-run',
  });
  await fs.mkdir(path.join(tmp, 'state', 'plans'), { recursive: true });
  await fs.writeFile(
    path.join(tmp, 'state', 'plans', 'web.json'),
    JSON.stringify({ family: 'web', fingerprint: 'old' }),
  );
  {
    const result = await request('/api/plan?id=web');
    assert.equal(result.body.status, 'stale', JSON.stringify(result));
  }
  const { loadIndex } = await import('../dsh-plugin/lib/pipeline/plan.mjs');
  const { familyFingerprint } = await import('../dsh-plugin/lib/tree/families.mjs');
  const { readmeHash, readReadme } = await import('../dsh-plugin/lib/readme-store.mjs');
  const index = await loadIndex({ dataDir: tmp });
  const fingerprint = familyFingerprint(
    index,
    'web',
    (p) => readmeHash(tmp, p.readme_path) || createHash('sha256').update(readReadme(tmp, p.readme_path)).digest('hex'),
  );
  await fs.writeFile(path.join(tmp, 'state', 'plans', 'web.json'), JSON.stringify({ family: 'web', fingerprint }));
  assert.equal((await request('/api/plan?id=web')).body.status, 'fresh');
  await reload();
  let updated = await request('/api/families');
  for (let i = 0; i < 200 && updated.status === 202; i++) {
    await new Promise((r) => setTimeout(r, 20));
    updated = await request('/api/families');
  }
  assert.equal(updated.status, 200);
  assert.equal((await request('/api/families?summary=1')).body.with_plan, 1);
  const lite = (await request('/api/node/web?lite=1')).body;
  assert.deepEqual(Object.keys(lite).sort(), [
    'ancestors',
    'branch_capabilities',
    'capabilities',
    'children_total',
    'node',
    'plugin',
  ]);
  assert.ok(!('plugin_ids' in lite.node));
  for (const c of [lite.capabilities, lite.branch_capabilities]) if (c) assert.ok(c.union.length <= 20);
  const tree = (await request('/api/tree')).body;
  const root = tree.nodes.find((n) => n.id === 'root');
  assert.deepEqual(
    root.badges,
    Object.fromEntries(['ui', 'tools', 'unique', 'missing'].map((k) => [k, caps.totals[k]])),
  );

  plugins.shift();
  await fs.writeFile(file, plugins.map(JSON.stringify).join('\n'));
  await reload();
  assert.equal((await query('changedtoken')).results.length, 0);
  console.log('internal tests passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
