import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readRaw, readReadme } from '../lib/store.mjs';

const script = fileURLToPath(new URL('../slim.mjs', import.meta.url));
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-slim-')),
    dir = path.join(root, 'data');
  const put = (name, body) => {
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  };
  const long = '中a'.repeat(9000);
  put(
    'plugins.jsonl',
    JSON.stringify({ readme_path: 'data/readmes/a.md', summary: 'yes', capabilities: ['a'] }) +
      '\n' +
      JSON.stringify({ readme_path: 'data/readmes/b.md', summary: '', capabilities: ['a'] }) +
      '\n',
  );
  put('readmes/a.md', long);
  put('readmes/b.md', 'full');
  put('readmes/orphan.md', 'orphan');
  put('raw/github/repos/a.json', { full_name: 'a/b', extra: 'discard' });
  put('raw/state.json', '{}');
  put('raw/crawl-report.json', '{}');
  put('work/relevance/a.out.json', { id: { verdict: 'relevant', confidence: 1 } });
  put('work/relevance/a.in.md', 'input');
  put('work/analyze/a.out.json', { id: { summary: 's' } });
  put('work/log.jsonl', '{"ok":true}\n');
  for (const name of [
    'plugins_base.jsonl',
    'graph.json',
    'filtered-out.jsonl',
    'dedup-merged.jsonl',
    'capabilities/a.json',
  ])
    put(name, 'protected');
  const backup = path.join(root, 'backup.tgz');
  const tar = spawn('tar', ['-czf', backup, 'data/raw', 'data/readmes'], { cwd: root });
  assert.equal((await once(tar, 'close'))[0], 0);
  return { root, dir, put, long, backup };
}
async function run(x, ...args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = path.join(x.root, 'stdout'),
    err = path.join(x.root, 'stderr');
  const outFd = fs.openSync(out, 'w'),
    errFd = fs.openSync(err, 'w');
  const child = spawn(process.execPath, [script, '--data-dir', x.dir, ...args], {
    env,
    stdio: ['ignore', outFd, errFd],
  });
  const [status] = await once(child, 'close');
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return { status, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') };
}
function snapshot(dir) {
  const result = {};
  function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else result[path.relative(dir, f)] = createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    }
  }
  walk(dir);
  return result;
}
test('dry-run estimates without writes and rejects missing or invalid backups', async () => {
  const x = await fixture();
  try {
    const before = snapshot(x.dir),
      r = await run(x);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.raw.files, 1);
    assert.equal(report.readmes.truncated.files, 1);
    assert.equal(report.readmes.full.files, 2);
    assert.deepEqual(snapshot(x.dir), before);
    assert.equal((await run(x, '--apply')).status, 2);
    fs.writeFileSync(path.join(x.root, 'bad.tgz'), 'bad');
    assert.equal((await run(x, '--apply', '--backup', path.join(x.root, 'bad.tgz'))).status, 2);
    assert.deepEqual(snapshot(x.dir), before);
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});
test('apply verifies stores and caches before removing files and preserves protected hashes', async () => {
  const x = await fixture();
  try {
    const before = snapshot(x.dir);
    const r = await run(x, '--apply', '--backup', x.backup);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readReadme('data/readmes/a.md', x.dir), x.long.slice(0, 16000));
    assert.equal(readReadme('data/readmes/orphan.md', x.dir), 'orphan');
    assert.deepEqual(JSON.parse(readRaw('data/raw/github/repos/a.json', x.dir).body), { full_name: 'a/b' });
    assert.equal(fs.existsSync(path.join(x.dir, 'readmes')), false);
    assert.equal(fs.existsSync(path.join(x.dir, 'raw/state.json')), true);
    assert.equal(fs.existsSync(path.join(x.dir, 'work/relevance/a.out.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(x.dir, 'cache/relevance-verdicts.json'))).id.verdict, 'relevant');
    const after = snapshot(x.dir);
    for (const name of [
      'plugins.jsonl',
      'plugins_base.jsonl',
      'graph.json',
      'filtered-out.jsonl',
      'dedup-merged.jsonl',
      'capabilities/a.json',
    ])
      assert.equal(after[name], before[name]);
    const verified = await run(x, '--verify');
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});
test('a cache validation failure leaves all source files in place', async () => {
  const x = await fixture();
  try {
    x.put('work/relevance/b.out.json', { id: { verdict: 'irrelevant' } });
    const r = await run(x, '--apply', '--backup', x.backup);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /duplicate relevance/);
    for (const name of [
      'raw/github/repos/a.json',
      'readmes/a.md',
      'work/relevance/a.out.json',
      'work/relevance/a.in.md',
      'work/log.jsonl',
    ])
      assert.equal(fs.existsSync(path.join(x.dir, name)), true, name);
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});

test('slim preserves relevance signals found after the README prefix', async () => {
  const x = await fixture();
  try {
    const { scoreRelevance } = await import('../relevance.mjs');
    const { DatabaseSync } = await import('node:sqlite');
    const text = 'x'.repeat(20000) + '\nDeepSeek Harness plugin\n';
    x.put('readmes/a.md', text);
    const before = scoreRelevance({}, text);
    assert.equal(before.band, 'relevant');
    const r = await run(x, '--apply', '--backup', x.backup);
    assert.equal(r.status, 0, r.stderr);
    const stored = readReadme('data/readmes/a.md', x.dir);
    assert.deepEqual(scoreRelevance({}, stored), before);
    assert.match(stored, /<!-- atlas:signals -->\nDeepSeek Harness plugin/);
    const db = new DatabaseSync(path.join(x.dir, 'readme-store.sqlite'), { readOnly: true });
    try {
      const features = JSON.parse(
        db.prepare('SELECT features FROM readmes WHERE path = ?').get('data/readmes/a.md').features,
      );
      assert.deepEqual(features, { signals: ['STRONG_RE', 'MEDIUM_RE', 'ECO_RE'], tail_chars: text.length - 16000 });
    } finally {
      db.close();
    }
    const verified = await run(x, '--verify');
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    fs.rmSync(x.root, { recursive: true, force: true });
  }
});
