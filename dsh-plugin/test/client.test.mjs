import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('browser bundle registers the sidebar extension using shared modules', async () => {
  let registration;
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), { window });
  assert.equal(registration.id, 'dsh-plugin-atlas');
  const required = [];
  const client = registration.factory((name) => {
    required.push(name);
    assert.match(name, /^(react|react-dom|react\/jsx-runtime|@deepseek-ai\/.*)$/);
    return {};
  });
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']);
  assert.equal(typeof client.apply, 'function');
  let definition, body, opened;
  const ctx = {
    effect(fn) {
      fn();
    },
    sidebarRightTabs: {
      register(value) {
        definition = value;
      },
    },
    sidebarRight: {
      openTab(kind) {
        opened = kind;
      },
    },
    slots: {
      inject(name, fn) {
        assert.equal(name, 'sidebar.right.pane.tab');
        fn();
      },
      register(options, component) {
        body = options;
        assert.equal(typeof component, 'function');
      },
    },
  };
  client.apply(ctx);
  assert.equal(definition.kind, 'plugin-atlas');
  assert.equal(body.name, 'sidebar.right.pane.tab');
  assert.equal(body.key, 'dsh-plugin-atlas');
  window.__pluginAtlasOpen();
  assert.equal(opened, 'plugin-atlas');
  assert.ok(required.includes('react'));
});

test('search fetches all details with bounded concurrency and clean summaries', async () => {
  const { atlasSearch } = await import('../lib/atlas-client.mjs');
  const original = globalThis.fetch;
  let active = 0,
    maximum = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    let data;
    if (u.pathname === '/api/status') data = { loading: false };
    else if (u.pathname === '/api/search')
      data = { results: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, snippet: 'raw keywords' })) };
    else {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      const id = decodeURIComponent(u.pathname.split('/').pop());
      data = {
        plugin: { id, description: '字'.repeat(130), capabilities: ['能力'] },
        ancestors: [{ id: 'c', label: '分类' }],
      };
    }
    return { ok: true, json: async () => data };
  };
  try {
    const result = await atlasSearch({ q: 'test' });
    assert.equal(result.data.details.length, 8);
    assert.equal(maximum, 4);
    assert.equal((result.text.match(/分类：分类/g) || []).length, 8);
    assert.equal((result.text.match(/能力：能力/g) || []).length, 8);
    assert.doesNotMatch(result.text, /raw keywords/);
    assert.match(result.text, new RegExp(`摘要：字{120}\\n`));
  } finally {
    globalThis.fetch = original;
  }
});

async function loadComponents() {
  let registration;
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), { window });
  const jsx = (type, props) => ({ type, props: props || {} });
  return registration.factory((name) =>
    name === 'react'
      ? { useState: (v) => [v, () => {}] }
      : name === 'react/jsx-runtime'
        ? { jsx, jsxs: jsx, Fragment: Symbol.for('fragment') }
        : {},
  );
}
function render(element) {
  if (element == null || typeof element === 'boolean') return '';
  if (Array.isArray(element)) return element.map(render).join('');
  if (typeof element !== 'object') return String(element);
  if (typeof element.type === 'function') return render(element.type(element.props));
  return render(element.props.children);
}
test('tree and capability card render hierarchy, badges, family and limited capabilities', async () => {
  const { TreeView, CapabilityCard } = await loadComponents();
  const nodes = [
    { id: 'a', label: '主干', type: 'category' },
    { id: 'b', parent: 'a', label: '分叉', type: 'branch', plugin_count: 3 },
    { id: 'c', parent: 'b', label: '子分叉', type: 'branch' },
  ];
  const caps = {
    ui: [{ label: '面板' }],
    tools: [{ label: '命令' }],
    other: [],
    unique: Array.from({ length: 10 }, (_, i) => ({ label: `独有${i}` })),
    missing: [{ label: '缺失能力' }],
  };
  const tree = render(
    TreeView({
      nodes,
      expanded: { a: true, b: true },
      selected: 'b',
      caps: { b: caps },
      refs: { current: {} },
      onToggle() {},
      onSelect() {},
    }),
  );
  assert.match(tree, /主干/);
  assert.match(tree, /分叉/);
  assert.match(tree, /子分叉/);
  assert.match(tree, /ui 1/);
  assert.match(tree, /tools 1/);
  const card = render(
    CapabilityCard({
      node: nodes[1],
      caps,
      families: [{ id: 'b', representatives: [{ id: 'p' }], planStatus: '无' }],
      plans: {},
      onCopy() {},
    }),
  );
  for (const item of ['面板', '命令', '独有0', '缺失能力', '代表节点', '/atlas plan b --dry-run', '展开更多'])
    assert.ok(card.includes(item), item);
  assert.doesNotMatch(card, /独有8/);
  const planned = render(
    CapabilityCard({
      node: nodes[1],
      caps,
      families: [{ id: 'b', representatives: [], planStatus: '最新' }],
      plans: { b: { plan: { summary: '合并功能', steps: ['验证'] } } },
      onCopy() {},
    }),
  );
  assert.match(planned, /合并功能/);
  assert.match(planned, /验证/);
  const withGraph = render(
    CapabilityCard({
      node: nodes[1],
      caps,
      families: [{ id: 'b', representatives: [], planStatus: '无' }],
      plans: {},
      onCopy() {},
      onOpenGraph() {},
    }),
  );
  assert.match(withGraph, /查看分支图/);
});
test('empty tree and host-aware dark theme tokens render', async () => {
  const { TreeView, CapabilityCard, styles } = await loadComponents();
  assert.match(render(TreeView({ nodes: [], expanded: {}, caps: {}, refs: { current: {} } })), /暂无能力目录/);
  assert.match(render(CapabilityCard({ node: null })), /选择树中的节点/);
  assert.match(styles, /light-dark\(/);
  assert.match(styles, /--dsh-font-family-text/);
  assert.match(styles, /--dsh-content-font-size/);
});
