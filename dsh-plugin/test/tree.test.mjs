import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTree, nodeCaps } from '../lib/tree/caps.mjs';
import { locate, renderTree, subtree } from '../lib/tree/view.mjs';

const graph = {
  nodes: [
    { id: 'root', type: 'root' },
    { id: 'cat', type: 'category', parent: 'root' },
    ...['a', 'b', 'c'].map((id) => ({ id, type: 'branch', parent: 'cat' })),
    ...['one', 'two', 'three'].map((id, i) => ({ id, type: 'plugin', parent: ['a', 'b', 'c'][i] })),
  ],
};
const plugins = [
  { id: 'one', provides: ['侧边栏'], tools: ['search'] },
  { id: 'two', capabilities: ['共同功能'] },
  { id: 'three', capabilities: ['共同功能'] },
];
test('能力、树视图和定位', () => {
  const index = buildTree({ graph, plugins });
  const caps = nodeCaps(index, 'a');
  assert.equal(caps.ui[0].capability, '侧边栏');
  assert.equal(caps.tools[0].capability, 'search');
  assert.ok(!caps.unique.some((x) => x.capability === '侧边栏'));
  assert.ok(nodeCaps(index, 'one').unique.some((x) => x.capability === '侧边栏'));
  assert.ok(caps.missing.some((x) => x.capability === '共同功能'));
  assert.match(renderTree(index, { root: 'cat' }), /├─/);
  assert.equal(
    locate(index, '侧边栏').some((x) => x.id === 'one'),
    true,
  );
  assert.equal(subtree(index, 'cat', 1).children.length, 3);
});

test('归一化、分类、叶分支近义合并与能力文件', () => {
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'r', type: 'root' },
        { id: 'leaf', type: 'branch', parent: 'r' },
        ...['p1', 'p2', 'p3'].map((id) => ({ id, type: 'plugin', parent: 'leaf' })),
      ],
    },
    plugins: [
      { id: 'p1', provides: ['ＡＢＣＤＥ', '侧边栏视图', '查询接口'], tools: ['open'] },
      { id: 'p2', capabilities: ['abcdｅ', 'abcdef'] },
      { id: 'p3', provides: ['abcde'] },
    ],
    capabilities: { leaf: { union: [{ capability: '外部能力', provided_by: ['p1', 'p2'] }] } },
  });
  const caps = nodeCaps(index, 'leaf');
  assert.equal(caps.other.find((c) => c.label === 'abcde').count, 3);
  assert.equal(caps.ui[0].label, '侧边栏视图');
  assert.deepEqual(caps.tools.map((c) => c.label).sort(), ['open', '查询接口']);
  assert.deepEqual(caps.other.find((c) => c.label === '外部能力').provided_by, ['p1', 'p2']);
  assert.equal(index.pluginToLeaf.get('p1'), 'leaf');
  assert.equal(index.children.get('leaf').length, 3);
  assert.ok(index.caps.has('leaf'));
});

test('兄弟阈值和插件按需差异使用归一化精确比较', () => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'root', type: 'root' },
        ...names.map((id) => ({ id, type: 'branch', parent: 'root' })),
        ...names.map((id) => ({ id: `p${id}`, type: 'plugin', parent: id })),
        ...['x', 'y', 'z'].map((id) => ({ id, type: 'plugin', parent: 'a' })),
      ],
    },
    plugins: [
      { id: 'pa', provides: ['独有项目'] },
      { id: 'pb', provides: ['共享项目'] },
      { id: 'pc', provides: ['共享项目'] },
      { id: 'pd', provides: ['单独项目'] },
      { id: 'pe' },
      { id: 'x', provides: ['私有能力'] },
      { id: 'y', provides: ['共同能力'] },
      { id: 'z', provides: ['共同能力'] },
    ],
  });
  assert.ok(nodeCaps(index, 'a').missing.some((c) => c.label === '共享项目' && c.count === 2));
  assert.ok(!nodeCaps(index, 'a').missing.some((c) => c.label === '单独项目'));
  assert.equal(index.nodes.get('x').detail, undefined);
  const detail = nodeCaps(index, 'x');
  assert.ok(detail.unique.some((c) => c.label === '私有能力'));
  assert.ok(detail.missing.some((c) => c.label === '共同能力' && c.count === 2));
  assert.equal(index.nodes.get('y').detail, undefined);
});

test('真实总数不受展示限制且聚合独有能力至少由两个插件提供', () => {
  const labels = Array.from({ length: 320 }, (_, i) => `ui ${createHash('sha256').update(String(i)).digest('hex')}`);
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'root', type: 'root' },
        { id: 'a', type: 'branch', parent: 'root' },
        { id: 'b', type: 'branch', parent: 'root' },
        ...['p1', 'p2'].map((id) => ({ id, type: 'plugin', parent: 'a' })),
        { id: 'p3', type: 'plugin', parent: 'b' },
      ],
    },
    plugins: [
      { id: 'p1', provides: [...labels, '单独功能'] },
      { id: 'p2', provides: labels },
      { id: 'p3', provides: ['别的功能'] },
    ],
  });
  for (const id of ['a', 'root']) {
    const caps = nodeCaps(index, id);
    assert.equal(caps.totals.ui, 320);
    assert.equal(caps.totals.unique, 320);
    assert.equal(caps.ui.length, 12);
    assert.equal(caps.unique.length, 12);
  }
  assert.ok(nodeCaps(index, 'p1').unique.some((c) => c.label === '单独功能'));
});

test('泛词在插件与分支能力全集中均被过滤，且不影响差异和总数', () => {
  const noise = [
    'dsh',
    'ＤＳＨ－ＰＬＵＧＩＮ',
    'plugin',
    'plugins',
    '插件',
    'deepseek',
    'deepseek harness',
    'harness',
    'cordis',
    'cordis plugin',
    'mcp',
    'tool',
    'tools',
    '工具',
    '扩展',
    'extension',
    'agent',
    '智能体',
    'ＡＢ',
    'x',
    '12',
  ];
  const index = buildTree({
    graph: {
      nodes: [
        { id: 'root', type: 'root' },
        ...['a', 'b', 'c'].map((id) => ({ id, type: 'branch', parent: 'root' })),
        ...['a', 'b', 'c'].map((id) => ({ id: `p${id}`, type: 'plugin', parent: id })),
      ],
    },
    plugins: [
      { id: 'pa', provides: [...noise, '界面布局'], tools: noise },
      { id: 'pb', capabilities: noise },
      { id: 'pc', capabilities: noise },
    ],
    capabilities: { a: { union: [...noise.map((capability) => ({ capability })), { capability: '外部功能' }] } },
  });
  for (const id of ['root', 'a', 'b', 'c', 'pa', 'pb', 'pc']) {
    const caps = nodeCaps(index, id);
    const expected =
      id === 'root' || id === 'a'
        ? { ui: 1, tools: 0, other: 1 }
        : id === 'pa'
          ? { ui: 1, tools: 0, other: 0 }
          : { ui: 0, tools: 0, other: 0 };
    for (const key of ['ui', 'tools', 'other']) assert.equal(caps.totals[key], expected[key], `${id} ${key}`);
    assert.equal(caps.totals.missing, 0, id);
    assert.ok([...caps.unique, ...caps.missing].every((entry) => !noise.includes(entry.label)));
  }
  assert.equal(nodeCaps(index, 'pa').totals.unique, 1);
  assert.equal(nodeCaps(index, 'b').totals.unique, 0);
});
