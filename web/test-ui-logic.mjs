import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const elements = new Map();
function element(selector) {
  if (!elements.has(selector))
    elements.set(selector, {
      innerHTML: '',
      textContent: '',
      dataset: {},
      hidden: true,
      value: '',
      checked: false,
      disabled: false,
      addEventListener() {},
      setAttribute() {},
      querySelectorAll: () => [],
      querySelector: () => element('.tab-panel'),
    });
  return elements.get(selector);
}
const rows = () =>
  [...element('#graph').innerHTML.matchAll(/<button class="node ([^"]*)"[^>]*data-id="([^"]+)"/g)].map((match) => ({
    dataset: { id: match[2] },
    selected: match[1].includes('selected'),
    scrollIntoView() {},
    focus() {},
    hasAttribute: () => true,
  }));
const treeNodes = [
  { id: 'root', type: 'root', label: 'root', parent: null, has_children: true },
  { id: 'category', type: 'category', label: 'category', parent: 'root', has_children: true },
  { id: 'branch', type: 'branch', label: 'branch', parent: 'category', has_children: true },
];
const plugin = { id: 'plugin', type: 'plugin', label: 'plugin', parent: 'branch', github_only: true };
let missing = false;
let serviceError = false;
const context = vm.createContext({
  document: {
    querySelector: element,
    querySelectorAll: (s) => (s === '#graph .node' ? rows() : []),
    documentElement: { dataset: {} },
  },
  localStorage: { getItem: () => null, setItem() {} },
  URLSearchParams,
  setTimeout,
  clearTimeout,
  DOMPurify: { sanitize: (s) => s },
  marked: { parse: (s) => s },
  renderBranchGraph() {},
  fetch: async (path) => {
    const url = new URL(path, 'http://localhost');
    let value;
    let status = 200;
    if (url.pathname === '/api/status') value = { counts: { plugins: 1, github_only: 1 }, semantic: { label: 'test' } };
    else if (url.pathname === '/api/tree') value = { nodes: treeNodes };
    else if (url.pathname === '/api/tree-node') value = {};
    else if (url.pathname === '/api/children') {
      const id = url.searchParams.get('node');
      const children = [...treeNodes, ...(url.searchParams.get('include_github_only') === '1' ? [plugin] : [])].filter(
        (n) => n.parent === id,
      );
      value = { nodes: children, offset: 0, limit: 200, total: children.length, has_more: false };
    } else if (url.pathname.startsWith('/api/node/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/node/'.length));
      const node = [...treeNodes, plugin].find((n) => n.id === id);
      if (serviceError || missing || !node) {
        status = serviceError ? 500 : 404;
        value = { error: 'failure' };
      } else {
        const ancestors = [];
        let parent = treeNodes.find((n) => n.id === node.parent);
        while (parent) {
          ancestors.unshift(parent);
          parent = treeNodes.find((n) => n.id === parent.parent);
        }
        value = { node, ancestors };
      }
    } else if (url.pathname === '/api/families') value = { families: [] };
    else if (url.pathname === '/api/branch-graph')
      value = { family: 'branch', trunk: 'plugin', nodes: [], edges: [], lanes: 1, rows: 0 };
    else throw new Error(`Unexpected request: ${path}`);
    return { ok: status === 200, status, statusText: 'error', json: async () => value };
  },
});
// Suppress only startup; exercise the actual browser functions below.
vm.runInContext(
  source
    .replace(/^import \{ renderBranchGraph \} from '\.\/branch-graph-view\.js';\n/, '')
    .replace(/refresh\(\)\.catch\(showError\);\s*$/, '') +
    `\n globalThis.ui = {
  refresh, locate, treeKey,
  setGithub(value) { includeGithub = value; },
  get selected() { return selected; },
  get opened() { return [...opened]; }
};`,
  context,
);
const { ui } = context;
await ui.refresh();
for (const id of ['root', 'category', 'branch']) {
  assert.equal(await ui.locate(id), true);
  assert.equal(ui.selected, id);
  assert.ok(
    rows().some((row) => row.dataset.id === id && row.selected),
    id,
  );
}
assert.ok(ui.opened.includes('root') && ui.opened.includes('category'));
await ui.treeKey({ currentTarget: rows()[0], key: 'ArrowDown', preventDefault() {} });
ui.setGithub(true);
await ui.refresh();
assert.equal(await ui.locate('plugin'), true);
assert.ok(ui.opened.includes('branch'));
assert.ok(rows().some((row) => row.dataset.id === 'plugin' && row.selected));
ui.setGithub(false);
await ui.refresh();
assert.equal(ui.selected, null);
assert.match(element('#detail').innerHTML, /选择一个节点/);
await ui.locate('root');
missing = true;
await ui.refresh();
assert.equal(ui.selected, null);
missing = false;
await ui.locate('root');
serviceError = true;
await assert.rejects(ui.refresh(), /failure/);
console.log('通过：路径定位、选中状态清理、键盘导航及服务错误传播。');
