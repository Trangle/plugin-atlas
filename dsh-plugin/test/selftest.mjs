import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { atlasSearch, atlasNode, resolveConfig } from '../lib/atlas-client.mjs';
import { createToolSpecs, createCommandSpecs } from '../lib/tools.mjs';

let state = 'ready';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  let data;
  if (url.pathname === '/api/status') data = { loading: state === 'loading', counts: { plugins: 1 }, semantic_backend: 'test' };
  else if (state === '503') { res.statusCode = 503; data = { error: 'loading' }; }
  else if (url.pathname === '/api/search') data = { q: url.searchParams.get('q'), results: [{ id: 'example', node_id: 'example', title: '示例插件', snippet: '摘要' }] };
  else if (url.pathname === '/api/node/example') data = { node: { id: 'example' }, plugin: { id: 'example', name: '示例插件', summary: '插件摘要' }, ancestors: [{ label: '分类' }, { label: '分支' }], branch_capabilities: { union: [{ capability: '记忆能力', provided_by: ['example'] }] } };
  else { res.statusCode = 404; data = { error: 'not found' }; }
  res.end(JSON.stringify(data));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 3000 };
try {
  assert.equal(resolveConfig({ baseUrl: 'http://example/' }, { PLUGIN_ATLAS_URL: 'http://other' }).baseUrl, 'http://example');
  const result = await atlasSearch({ q: 'memory' }, cfg);
  assert.equal(result.ok, true);
  for (const part of ['示例插件', '记忆能力', '分类 > 分支']) assert.ok(result.text.includes(part));
  assert.ok((await atlasNode('example', cfg)).text.includes('插件摘要'));
  console.log('PASS 搜索与节点详情');
  state = 'loading';
  assert.match((await atlasSearch({ q: 'x' }, cfg)).text, /正在加载索引/);
  state = '503';
  assert.match((await atlasSearch({ q: 'x' }, cfg)).text, /正在加载索引/);
  state = 'ready';
  console.log('PASS 加载中与 503');
  const closed = http.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  await new Promise((resolve, reject) => closed.close(error => error ? reject(error) : resolve()));
  const unavailable = await atlasSearch({ q: 'x' }, { baseUrl: `http://127.0.0.1:${port}` });
  assert.match(unavailable.text, /未运行/);
  assert.match(unavailable.text, /web\/start\.sh/);
  console.log('PASS 服务未运行');
  const ctx = { tools: { items: [], register(spec) { this.items.push(spec); } }, commands: { items: [], register(spec) { this.items.push(spec); } } };
  for (const spec of createToolSpecs(cfg)) ctx.tools.register(spec);
  for (const spec of createCommandSpecs(cfg)) ctx.commands.register(spec);
  assert.match((await ctx.tools.items.find(x => x.name === 'plugin_atlas_search').execute({ q: 'x' }, {})).text, /记忆能力/);
  assert.match((await ctx.tools.items.find(x => x.name === 'plugin_atlas_node').execute({ id: 'example' }, {})).text, /示例插件/);
  assert.match((await ctx.tools.items.find(x => x.name === 'plugin_atlas_status').execute({}, {})).text, /浏览器/);
  assert.equal((await ctx.commands.items.find(x => x.name === 'atlas').handler({ rawInput: 'x' })).kind, 'success');
  assert.equal((await ctx.commands.items.find(x => x.name === 'atlas').handler({ rawInput: '' })).kind, 'error');
  assert.match((await ctx.commands.items.find(x => x.name === 'atlas-open').handler({})).text, /web\/start\.sh/);
  for (const c of createCommandSpecs({})) {
    assert.match(c.name, /^[a-z0-9_-]+$/, '命令名须为小写');
    if (c.input !== undefined) assert.ok(c.input.hint && c.input.hint.trim(), `命令 ${c.name} 的 input.hint 不能为空（dsh-commands 会拒绝）`);
  }
  console.log('PASS 工具与命令');
  if (process.env.ATLAS_LIVE === '1') {
    const live = await atlasSearch({ q: 'memory' }, { baseUrl: 'http://127.0.0.1:4380' });
    assert.equal(live.ok, true, live.text);
    assert.ok(live.data.results.length > 0, '真实服务应返回搜索结果');
    console.log('PASS 真实服务搜索 memory');
  }
  console.log('selftest: all passed');
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
