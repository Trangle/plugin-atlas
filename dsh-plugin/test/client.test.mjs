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
  let active = 0, maximum = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    let data;
    if (u.pathname === '/api/status') data = { loading: false };
    else if (u.pathname === '/api/search') data = { results: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, snippet: 'raw keywords' })) };
    else {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      const id = decodeURIComponent(u.pathname.split('/').pop());
      data = { plugin: { id, description: '字'.repeat(130), capabilities: ['能力'] }, ancestors: [{ id: 'c', label: '分类' }] };
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
  } finally { globalThis.fetch = original; }
});
