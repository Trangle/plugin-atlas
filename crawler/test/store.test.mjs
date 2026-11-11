import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRaw, writeRaw, readReadme, readmeMeta, writeReadme } from '../lib/store.mjs';
import { readReadme as pluginReadme } from '../../dsh-plugin/lib/readme-store.mjs';

test('stores compact JSON and README metadata and reads legacy files first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-store-'));
  process.env.ATLAS_DATA_DIR = dir;
  try {
    writeRaw('data/raw/a.json', { body: '{ "hello": 1 }', etag: 'tag' });
    assert.deepEqual(JSON.parse(readRaw('data/raw/a.json').body), { hello: 1 });
    assert.equal(readRaw('data/raw/a.json').etag, 'tag');
    const text = 'a'.repeat(17000);
    writeReadme('data/readmes/a.md', text, { truncate: true });
    assert.equal(readReadme('data/readmes/a.md'), text.slice(0, 16000));
    assert.equal(pluginReadme(dir, 'data/readmes/a.md'), text.slice(0, 16000));
    assert.equal(readmeMeta('data/readmes/a.md').bytes, 17000);
    fs.mkdirSync(path.join(dir, 'readmes'));
    fs.writeFileSync(path.join(dir, 'readmes/a.md'), 'legacy');
    assert.equal(readReadme('data/readmes/a.md'), 'legacy');
    assert.equal(pluginReadme(dir, 'data/readmes/a.md'), 'legacy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ATLAS_DATA_DIR;
  }
});

import { compactRaw } from '../lib/store.mjs';
import { loadGithubAliases, dedupPlugins, isGithubOnlyRaw } from '../dedup.mjs';
import { readReadmeFor, scoreRelevance, loadRelevanceVerdicts } from '../relevance.mjs';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('dedup and relevance CLI process sample data and emit JSON stats', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cli-'));
  try {
    const records = [
      { id: 'npm:sample', package: 'sample', repo: 'owner/sample' },
      { id: 'github:owner/sample', repo: 'owner/sample' },
      { id: 'github:owner/plugin', repo: 'owner/plugin', description: 'DeepSeek Harness plugin' },
    ];
    fs.writeFileSync(path.join(dir, 'plugins.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
    const env = { ...process.env, ATLAS_DATA_DIR: dir, ATLAS_ROOT: dir };
    delete env.NODE_TEST_CONTEXT;
    const run = async (script) => {
      const out = path.join(dir, `${script}.stdout`);
      const err = path.join(dir, `${script}.stderr`);
      const outFd = fs.openSync(out, 'w');
      const errFd = fs.openSync(err, 'w');
      let status;
      try {
        const child = spawn(process.execPath, [fileURLToPath(new URL(`../${script}.mjs`, import.meta.url))], {
          env,
          timeout: 10000,
          stdio: ['ignore', outFd, errFd],
        });
        status = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
      } finally {
        fs.closeSync(outFd);
        fs.closeSync(errFd);
      }
      const stdout = fs.readFileSync(out, 'utf8');
      const stderr = fs.readFileSync(err, 'utf8');
      assert.equal(status, 0, `${script}: ${stderr}\n${stdout}`);
      return JSON.parse(stdout);
    };
    const dedup = await run('dedup');
    assert.equal(dedup.input, 3);
    assert.equal(dedup.output, 2);
    assert.equal(dedup.merged_into_market, 1);
    const relevance = await run('relevance');
    assert.equal(relevance.github_only_checked, 1);
    assert.equal(relevance.rule_relevant, 1);
    assert.equal(relevance.filtered_out, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('offline reconstruction, aliases and relevance agree with legacy sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-offline-'));
  const root = path.dirname(dir);
  const fixtures = {
    'github/repos/old__repo.json': {
      id: 3,
      full_name: 'new/repo',
      description: 'desc',
      stargazers_count: 7,
      pushed_at: '2020-01-01',
      homepage: 'https://example.org',
      extra: 'discard',
    },
    'github/full/q/shard.json': {
      total_count: 1,
      items: [{ id: 3, full_name: 'new/repo', owner: { login: 'new', extra: 1 }, topics: ['dsh-plugin'], extra: 1 }],
      extra: 1,
    },
    'github/search/topic-dsh-plugin-p1.json': {
      total_count: 1,
      items: [
        { full_name: 'old/repo', owner: { login: 'old' }, description: 'agent tool', stargazers_count: 2, extra: 1 },
      ],
    },
    'github/search/name-desc-dsh-plugin-p1.json': { total_count: 0, items: [] },
    'github/blue-whale-repos.txt': 'old/repo\n',
    'index/awesome-plugins.json': {
      updated: '2020',
      count: 1,
      plugins: [
        { name: 'x', npm: 'dsh-plugin-x', url: 'https://github.com/old/repo', description: { en: 'X' }, extra: 1 },
      ],
    },
    'npm-search/npm_dsh-plugin/page-000000.json': {
      total: 1,
      objects: [
        {
          package: {
            name: 'dsh-plugin-x',
            version: '1',
            keywords: ['dsh-plugin'],
            links: { repository: 'https://github.com/old/repo' },
            extra: 1,
          },
          downloads: { monthly: 5 },
          extra: 1,
        },
      ],
    },
    'npm-search/npm_cordis-plugin/page-000000.json': { total: 0, objects: [] },
    'inventory/dsh-official-on-demand.json': {
      dsh_version: '1',
      catalog: [
        {
          packageName: 'dsh-plugin-inventory',
          meta: { title: { en: 'Inventory' }, description: { en: 'D' } },
          extra: 1,
        },
      ],
      extra: 1,
    },
    'package-json/dsh-plugin-x@1.json': {
      dependencies: { '@deepseek-ai/foo': '1' },
      dsh: { tools: ['foo'] },
      extra: 1,
    },
    'packument/npm_dsh-plugin-x.json': {
      'dist-tags': { latest: '1' },
      versions: { 1: { keywords: ['dsh-plugin'], readme: 'secret' }, 0: { readme: 'old' } },
      readme: 'secret',
      extra: 1,
    },
  };
  const write = (rel, body) => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  };
  const guard = path.join(dir, 'no-network.cjs');
  fs.writeFileSync(guard, "global.fetch = () => { throw new Error('network forbidden in test'); };\n");
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require=${guard}`,
    ATLAS_DATA_DIR: dir,
    ATLAS_ROOT: dir,
    DSH_INSTALL_ROOT: path.join(dir, 'missing'),
  };
  const run = () => {
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../update.mjs', import.meta.url)), '--offline', '--no-analyze', '--readme-limit', '20'],
      { env, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return fs
      .readFileSync(path.join(dir, 'plugins_base.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .map(({ crawled_at, ...p }) => ({
        ...p,
        updated_at: p.updated_at?.startsWith(new Date().toISOString().slice(0, 10)) ? '<runtime>' : p.updated_at,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  };
  try {
    for (const [key, value] of Object.entries(fixtures)) write('raw/' + key, value);
    write('readmes/sample.md', 'A DSH plugin for agent tools');
    write('raw/state.json', {
      readmes: { 'npm:dsh-plugin-x': { version: '1', status: 'ok', path: 'data/readmes/sample.md' } },
    });
    process.env.ATLAS_DATA_DIR = dir;
    const old = run();
    const aliases = loadGithubAliases(dir);
    const score = scoreRelevance(
      { description: 'agent' },
      readReadmeFor(root, { readme_path: 'data/readmes/sample.md' }),
    );
    const dedup = dedupPlugins(old, { dataDir: dir });
    process.env.ATLAS_DATA_DIR = dir;
    for (const [key, value] of Object.entries(fixtures)) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      writeRaw('data/raw/' + key, { body: raw });
    }
    assert.equal(readRaw('data/raw/github/blue-whale-repos.txt').body, fixtures['github/blue-whale-repos.txt']);
    const pk = JSON.parse(readRaw('data/raw/packument/npm_dsh-plugin-x.json').body);
    assert.deepEqual(Object.keys(pk.versions), ['1']);
    assert.equal(pk.readme_length, 6);
    assert.equal(pk.readme, undefined);
    assert.equal(compactRaw('data/raw/github/blue-whale-repos.txt', 'hello'), 'hello');
    writeReadme('data/readmes/sample.md', 'A DSH plugin for agent tools');
    const state = fs.readFileSync(path.join(dir, 'raw/state.json'));
    fs.rmSync(path.join(dir, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'raw'));
    fs.writeFileSync(path.join(dir, 'raw/state.json'), state);
    fs.rmSync(path.join(dir, 'readmes'), { recursive: true });
    const migrated = run();
    assert.deepEqual(migrated, old);
    assert.deepEqual(loadGithubAliases(dir), aliases);
    assert.deepEqual(dedupPlugins(migrated, { dataDir: dir }), dedup);
    assert.deepEqual(
      scoreRelevance({ description: 'agent' }, readReadmeFor(root, { readme_path: 'data/readmes/sample.md' })),
      score,
    );
    write('work/relevance/r1.out.json', { 'github:old/repo': { verdict: 'relevant', confidence: 1 } });
    write('cache/relevance-verdicts.json', { 'github:old/repo': { verdict: 'irrelevant', confidence: 1 } });
    assert.equal(loadRelevanceVerdicts(path.join(dir, 'work')).verdicts.get('github:old/repo').verdict, 'irrelevant');
  } finally {
    delete process.env.ATLAS_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrates legacy README stores and bounds deduplicated signal lines', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { truncateForIndex } = await import('../lib/store.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-legacy-store-'));
  process.env.ATLAS_DATA_DIR = dir;
  try {
    const old = new DatabaseSync(path.join(dir, 'readme-store.sqlite'));
    old.exec(
      'CREATE TABLE readmes(path TEXT PRIMARY KEY, sha256 TEXT, bytes INTEGER, chars INTEGER, truncated INTEGER, body BLOB, updated_at TEXT)',
    );
    old.close();
    const text =
      'x'.repeat(16000) +
      '\n' +
      ('agent ' + 'z'.repeat(400) + '\n').repeat(2) +
      Array.from({ length: 40 }, (_, i) => `\nagent ${i} ${'z'.repeat(290)}`).join('');
    writeReadme('data/readmes/legacy.md', text, { truncate: true });
    const result = readReadme('data/readmes/legacy.md');
    assert.equal(result, truncateForIndex(text));
    const lines = result.split('\n\n<!-- atlas:signals -->\n')[1].split('\n');
    assert.ok(lines.every((line) => line.length <= 300));
    assert.equal(new Set(lines).size, lines.length);
    assert.ok(lines.join('\n').length <= 6000);
    const db = new DatabaseSync(path.join(dir, 'readme-store.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(JSON.parse(db.prepare('SELECT features FROM readmes').get().features), {
        signals: ['ECO_RE'],
        tail_chars: text.length - 16000,
      });
    } finally {
      db.close();
    }
  } finally {
    delete process.env.ATLAS_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('retains late long-line matches, merges windows, and prioritizes strong signals', async () => {
  const { truncateForIndex } = await import('../lib/store.mjs');
  const prefix = 'x'.repeat(16000);
  const line = 'a'.repeat(399) + 'DEEPSEEK_HARNESS' + 'b'.repeat(299) + ' agent';
  const result = truncateForIndex(prefix + '\n' + line);
  const snippets = result.split('\n\n<!-- atlas:signals -->\n')[1].split('\n');
  assert.ok(result.includes('DEEPSEEK_HARNESS'));
  assert.equal(snippets[0], line.slice(279, 399 + 'DEEPSEEK_HARNESS'.length + 120));
  assert.equal(snippets.length, 2);

  const merged = truncateForIndex(
    prefix + '\n' + 'a'.repeat(129) + ' agent ' + 'b'.repeat(100) + 'plugin' + 'c'.repeat(130),
  );
  assert.equal(merged.split('\n\n<!-- atlas:signals -->\n')[1].split('\n').length, 1);

  const crowded =
    prefix +
    '\n' +
    Array.from({ length: 80 }, (_, i) => `agent ${i} ${'z'.repeat(250)}`).join('\n') +
    '\n' +
    'q'.repeat(399) +
    'DEEPSEEK_HARNESS';
  const limited = truncateForIndex(crowded).split('\n\n<!-- atlas:signals -->\n')[1];
  assert.ok(limited.includes('DEEPSEEK_HARNESS'));
  assert.ok(limited.length <= 6000);
});
