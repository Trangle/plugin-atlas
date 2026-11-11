import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { FakeAdapter, apply } from '../dev/fake-llm-provider/index.js';
import { extract } from '../lib/pipeline/extract.mjs';
import { resolveConfig } from '../lib/config.mjs';

const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const message = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

test('registers provider and emits an assembled extract response', async () => {
  let adapter;
  apply({ effect: (fn) => fn(), llm: { registerAdapter: (ids, value) => { assert.deepEqual(ids, ['atlas-fake']); adapter = value; return () => {}; } } });
  assert.deepEqual((await adapter.listModels('atlas-fake'))[0], { provider: 'atlas-fake', id: 'fake-1', name: 'Atlas Fake 1', inputModalities: ['text'] });
  assert.deepEqual((await adapter.resolveModel('atlas-fake', 'fake-1')).context, { contextWindow: 128000 });
  const input = `INPUT_JSON:${JSON.stringify({ categories: [{ id: 'c', branches: ['b'] }], items: [{ id: 'p', name: '😀'.repeat(100) }] })}`;
  const chunks = await collect(adapter.stream({ messages: [message('old'), message(input)] }));
  assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish']);
  const assembler = new BlockAssembler();
  chunks.forEach((c) => assembler.push(c));
  const text = assembler.blocks()[0].text;
  const [item] = JSON.parse(text);
  assert.equal([...item.summary].length, 80);
  assert.deepEqual({ ...item, summary: 'x' }, { id: 'p', summary: 'x', capabilities: ['能力一', '能力二', '能力三'], category_id: 'c', branch_id: 'b' });
  assert.deepEqual(assembler.usage, { inputTokens: Math.ceil(input.length / 4), outputTokens: Math.ceil(text.length / 4), totalTokens: Math.ceil(input.length / 4) + Math.ceil(text.length / 4) });
  assert.deepEqual(assembler.finish, { kind: 'stop' });
});

test('ordinary conversation and cancellation', async () => {
  const adapter = new FakeAdapter();
  const chunks = await collect(adapter.stream({ messages: [message('hello')] }));
  assert.equal(chunks[1].text, '这是 atlas-fake 本地假模型，不会调用真实模型。');
  const controller = new AbortController();
  const stream = adapter.stream({ messages: [message('hello')], signal: controller.signal });
  assert.equal((await stream.next()).value.type, 'block-start');
  controller.abort();
  assert.deepEqual((await stream.next()).value, { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } });
  assert.equal((await stream.next()).done, true);
  assert.equal((await collect(adapter.stream({ messages: [], signal: controller.signal })))[0].reason.kind, 'aborted');
});

test('actual extract parser accepts the assembled fake model output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-fake-'));
  try {
    const data = path.join(root, 'data');
    await fs.mkdir(data);
    await fs.writeFile(path.join(data, 'plugins_base.jsonl'), JSON.stringify({ id: 'p', name: '插件' }) + '\n');
    await fs.writeFile(path.join(data, 'graph.json'), JSON.stringify({ nodes: [{ id: 'c', type: 'category' }] }));
    const adapter = new FakeAdapter();
    const services = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'atlas-fake', model: 'fake-1' }) },
      llm: { prepareCall: async (config) => ({ config, stream: (options) => adapter.stream(options) }) },
    };
    const cfg = resolveConfig({ root, backend: 'llm' });
    const result = await extract(cfg, { includeFiltered: true }, services);
    assert.equal(result.status, 'completed');
    assert.equal(result.done, 1);
    const [item] = (await fs.readFile(path.join(cfg.stateDir, 'overlay.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(item.summary, '【fake】插件');
    assert.equal(item.branch_id, null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
