#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { compactRaw, writeRaw, readRaw, writeReadme, readReadme, truncateForIndex } from './lib/store.mjs';

const args = process.argv.slice(2);
let dir = process.env.ATLAS_DATA_DIR || 'data',
  backup,
  mode = 'dry-run',
  protectedBefore;
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' || args[i] === '--backup') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`missing value for ${args[i]}`);
      if (args[i] === '--data-dir') dir = args[++i];
      else backup = args[++i];
    } else if (args[i] === '--apply') mode = 'apply';
    else if (args[i] === '--verify') mode = 'verify';
    else if (args[i] === '--dry-run') mode = 'dry-run';
    else throw Error(`unsupported argument: ${args[i]}`);
  }
  dir = path.resolve(dir);
  process.env.ATLAS_DATA_DIR = dir;
} catch (e) {
  console.error(e.stack || e);
  process.exitCode = e.protectedChanged ? 3 : 2;
}

const digest = (b) => createHash('sha256').update(b).digest('hex');
function files(root) {
  const result = [];
  function walk(p) {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) result.push(f);
    }
  }
  walk(root);
  return result;
}
function progress(label, n) {
  if (n % 1000 === 0) console.error(`${label}: ${n}`);
}
function protectedHashes() {
  const names = ['plugins.jsonl', 'plugins_base.jsonl', 'graph.json', 'filtered-out.jsonl', 'dedup-merged.jsonl'];
  const all = [...names.map((n) => path.join(dir, n)), ...files(path.join(dir, 'capabilities'))];
  return Object.fromEntries(
    all.map((f) => [path.relative(dir, f), fs.existsSync(f) ? digest(fs.readFileSync(f)) : null]),
  );
}
function assertProtected(before) {
  if (!isDeepStrictEqual(before, protectedHashes())) {
    const e = Error('protected files changed during migration');
    e.protectedChanged = true;
    throw e;
  }
}
function plugins() {
  const f = path.join(dir, 'plugins.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter((s) => s.trim())
    .map((s) => JSON.parse(s));
}
function hasContent(v) {
  return typeof v === 'string'
    ? !!v.trim()
    : Array.isArray(v)
      ? v.length > 0
      : v && typeof v === 'object'
        ? Object.keys(v).length > 0
        : !!v;
}
function readmePolicies() {
  const m = new Map();
  for (const p of plugins())
    if (p.readme_path) {
      const truncate = !!(hasContent(p.summary) && hasContent(p.capabilities));
      // If multiple plugins share a README, retain the full text if any needs it.
      m.set(p.readme_path, (m.get(p.readme_path) ?? true) && truncate);
    }
  return m;
}
function readmeKey(f) {
  return 'data/' + path.relative(dir, f).split(path.sep).join('/');
}
function keyFor(f) {
  return readmeKey(f);
}
function backupValid(file) {
  return new Promise((resolve, reject) => {
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile())
      return reject(Error('apply requires an existing --backup archive'));
    const child = spawn('tar', ['-tzf', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '',
      raw = false,
      readmes = false,
      err = '';
    const line = (s) => {
      s = s.replace(/^(\.\/)+/, '');
      if (/^data\/raw\//.test(s)) raw = true;
      if (/^data\/readmes\//.test(s)) readmes = true;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      err = (err + chunk).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending) line(pending);
      code === 0 && raw && readmes
        ? resolve()
        : reject(Error(`invalid backup: tar exit ${code}, raw=${raw}, readmes=${readmes}: ${err}`));
    });
  });
}
function rawCompact(f) {
  const body = fs.readFileSync(f, 'utf8'),
    key = keyFor(f);
  if (key.endsWith('.txt')) return { body, compact: body };
  try {
    return { body, compact: JSON.stringify(compactRaw(key, JSON.parse(body))) };
  } catch (e) {
    if (key.endsWith('.json')) throw e;
    return { body, compact: body };
  }
}
function workPlan() {
  const input = [],
    outputs = new Map(),
    log = [];
  for (const f of files(path.join(dir, 'work'))) {
    const rel = path.relative(path.join(dir, 'work'), f),
      parts = rel.split(path.sep),
      name = parts.at(-1);
    if (/\.in\./.test(name)) input.push(f);
    else if (/\.out\./.test(name)) {
      const stage = parts.length > 1 ? parts[0] : 'work';
      if (!outputs.has(stage)) outputs.set(stage, []);
      outputs.get(stage).push(f);
    } else if (rel === 'log.jsonl') log.push(f);
  }
  return { input, outputs, log };
}
function inventory() {
  const raw = files(path.join(dir, 'raw')).filter(
    (f) => !['state.json', 'crawl-report.json'].includes(path.basename(f)),
  );
  const readmes = files(path.join(dir, 'readmes')).filter((f) => f.endsWith('.md'));
  const policy = readmePolicies();
  // Preserve the exact paths used by plugins, including a possible ./ prefix.
  const aliases = new Map();
  for (const [p, t] of policy) {
    const rel = p.replace(/^\.\/?data\//, '').replace(/^data\//, '');
    const f = path.resolve(dir, rel);
    if (f.startsWith(dir + path.sep)) {
      if (!aliases.has(f)) aliases.set(f, []);
      aliases.get(f).push([p, t]);
    }
  }
  const entries = readmes.map((f) => ({ f, paths: aliases.get(f) || [[readmeKey(f), false]] }));
  return { raw, entries, work: workPlan() };
}
function size(f) {
  return fs.statSync(f).size;
}
function total(fs_) {
  return fs_.reduce((n, f) => n + size(f), 0);
}
function diskUsage(root) {
  let bytes = 0;
  const seen = new Set();
  function walk(p) {
    const st = fs.lstatSync(p),
      id = `${st.dev}:${st.ino}`;
    if (seen.has(id)) return;
    seen.add(id);
    bytes += st.blocks * 512;
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  }
  if (fs.existsSync(root)) walk(root);
  return bytes;
}
function estimate(inv) {
  let rawBr = 0,
    readmeBr = 0,
    trunc = 0,
    full = 0,
    truncBytes = 0,
    fullBytes = 0;
  for (let i = 0; i < inv.raw.length; i++) {
    rawBr += brotliCompressSync(Buffer.from(rawCompact(inv.raw[i]).compact)).length;
    progress('raw', i + 1);
  }
  for (let i = 0; i < inv.entries.length; i++) {
    const { f, paths } = inv.entries[i],
      text = fs.readFileSync(f, 'utf8');
    const isTruncated = paths.every(([, t]) => t);
    if (isTruncated) {
      trunc++;
      truncBytes += size(f);
    } else {
      full++;
      fullBytes += size(f);
    }
    for (const [, t] of paths) readmeBr += brotliCompressSync(Buffer.from(t ? truncateForIndex(text) : text)).length;
    progress('readmes', i + 1);
  }
  const outs = [...inv.work.outputs.values()].flat(),
    workFiles = [...inv.work.input, ...outs, ...inv.work.log];
  // SQLite page/index overhead and cache serialization are not included in the estimate.
  const workOutBytes = total(outs),
    logBr = inv.work.log.reduce((n, f) => n + brotliCompressSync(fs.readFileSync(f)).length, 0);
  const current = total(files(dir));
  return {
    mode: 'dry-run',
    raw: { files: inv.raw.length, bytes: total(inv.raw), compact_brotli_bytes: rawBr },
    readmes: {
      files: inv.entries.length,
      bytes: truncBytes + fullBytes,
      truncated: { files: trunc, bytes: truncBytes },
      full: { files: full, bytes: fullBytes },
      brotli_bytes: readmeBr,
    },
    work: {
      input_files: inv.work.input.length,
      output_files: outs.length,
      log_files: inv.work.log.length,
      cleanable_bytes: total(workFiles),
    },
    current_bytes: current,
    estimated_after_bytes:
      current - total(inv.raw) - truncBytes - fullBytes - total(workFiles) + rawBr + readmeBr + workOutBytes + logBr,
    estimate_note: 'Compressed payload estimate; excludes SQLite overhead and approximates cache output bytes.',
  };
}
function openStore(name) {
  return new DatabaseSync(path.join(dir, `${name}-store.sqlite`), { readOnly: true });
}
function mergeWork(work) {
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  for (const [stage, outputs] of work.outputs) {
    if (stage === 'relevance') {
      const target = path.join(cache, 'relevance-verdicts.json');
      const merged = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {};
      if (!merged || Array.isArray(merged) || typeof merged !== 'object') throw Error('invalid relevance cache');
      let count = 0;
      const seen = new Set();
      for (const [i, f] of outputs.entries()) {
        progress(`work ${stage}`, i + 1);
        const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!obj || Array.isArray(obj) || typeof obj !== 'object') throw Error(`invalid relevance output ${f}`);
        for (const [id, v] of Object.entries(obj)) {
          if (seen.has(id)) throw Error(`duplicate relevance verdict ${id}`);
          seen.add(id);
          merged[id] = { ...v, batch: path.basename(f, '.out.json') };
          count++;
        }
      }
      fs.writeFileSync(target, JSON.stringify(merged));
      const check = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (
        [...seen].filter((id) => Object.hasOwn(check, id) && isDeepStrictEqual(check[id], merged[id])).length !== count
      )
        throw Error('relevance verdict count mismatch');
    } else {
      const target = path.join(cache, `${stage}.jsonl`);
      const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const rows = outputs.map((f, i) => {
        progress(`work ${stage}`, i + 1);
        return {
          file: path.relative(path.join(dir, 'work'), f).split(path.sep).join('/'),
          data: f.endsWith('.json') ? JSON.parse(fs.readFileSync(f, 'utf8')) : fs.readFileSync(f, 'utf8'),
        };
      });
      // Replace rows for the same sources so retries do not duplicate them.
      const names = new Set(rows.map((r) => r.file));
      const old = previous
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((r) => !names.has(r.file));
      fs.writeFileSync(target, [...old, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const check = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
      if (
        !isDeepStrictEqual(
          check.filter((r) => names.has(r.file)),
          rows,
        )
      )
        throw Error(`cache verification failed for ${stage}`);
    }
  }
  if (work.log.length) {
    const target = path.join(cache, 'work-log.jsonl.br');
    const old = fs.existsSync(target) ? brotliDecompressSync(fs.readFileSync(target)) : Buffer.alloc(0);
    const current = fs.readFileSync(work.log[0]);
    // A retry after a failed verification must not append the same log twice.
    const combined =
      current.length && old.length >= current.length && old.subarray(old.length - current.length).equals(current)
        ? old
        : Buffer.concat([old, old.length && old.at(-1) !== 10 ? Buffer.from('\n') : Buffer.alloc(0), current]);
    fs.writeFileSync(target, brotliCompressSync(combined));
    if (!brotliDecompressSync(fs.readFileSync(target)).equals(combined)) throw Error('work log verification failed');
  }
}
function removeEmpty(p, root) {
  while (p.startsWith(root) && p !== root && fs.existsSync(p) && fs.readdirSync(p).length === 0) {
    fs.rmdirSync(p);
    p = path.dirname(p);
  }
}
async function main() {
  if (mode === 'verify') {
    for (const name of ['raw', 'readme']) {
      if (!fs.existsSync(path.join(dir, `${name}-store.sqlite`))) throw Error(`missing ${name} store`);
      const db = openStore(name);
      try {
        if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
          throw Error(`${name} store integrity check failed`);
        const table = name === 'raw' ? 'responses' : 'readmes';
        let checked = 0;
        for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) {
          progress(`verify ${name}`, ++checked);
          const text = brotliDecompressSync(row.body).toString('utf8');
          if (name === 'raw' && row.key.endsWith('.json')) JSON.parse(text);
          if (
            name === 'readme' &&
            (row.truncated
              ? text.length > 16000 + '\n\n<!-- atlas:signals -->\n'.length + 6000
              : digest(text) !== row.sha256 || Buffer.byteLength(text) !== row.bytes || text.length !== row.chars)
          )
            throw Error(`invalid stored README ${row.path}`);
        }
      } finally {
        db.close();
      }
    }
    let n = 0;
    for (const p of plugins())
      if (p.readme_path) {
        if (readReadme(p.readme_path, dir) === null) throw Error(`missing README ${p.readme_path}`);
        progress('verify readmes', ++n);
      }
    console.log(JSON.stringify({ mode, readme_paths: n, ok: true }));
    return;
  }
  if (mode === 'apply') await backupValid(backup);
  const before = mode === 'apply' ? protectedHashes() : null;
  protectedBefore = before;
  const inv = inventory();
  if (mode === 'dry-run') {
    console.log(JSON.stringify(estimate(inv), null, 2));
    return;
  }
  const beforeBytes = total(files(dir)),
    beforeDu = diskUsage(dir);
  for (let i = 0; i < inv.raw.length; i++) {
    const f = inv.raw[i],
      { body, compact } = rawCompact(f),
      key = keyFor(f);
    writeRaw(key, { body });
    const stored = readRaw(key, dir);
    if (
      !stored ||
      (stored.body !== compact &&
        (!key.endsWith('.json') || !isDeepStrictEqual(JSON.parse(stored.body), JSON.parse(compact))))
    )
      throw Error(`raw verification failed: ${f}`);
    progress('raw', i + 1);
  }
  for (let i = 0; i < inv.entries.length; i++) {
    const { f, paths } = inv.entries[i],
      text = fs.readFileSync(f, 'utf8');
    for (const [p, t] of paths) writeReadme(p, text, { truncate: t });
    progress('readmes', i + 1);
  }
  // Read the stored rows directly: readReadme intentionally prefers the legacy file.
  if (inv.entries.length) {
    const db = openStore('readme');
    try {
      const get = db.prepare('SELECT * FROM readmes WHERE path = ?');
      for (const { f, paths } of inv.entries) {
        const text = fs.readFileSync(f, 'utf8');
        for (const [p, t] of paths) {
          const row = get.get(p);
          if (
            !row ||
            row.sha256 !== digest(text) ||
            row.bytes !== Buffer.byteLength(text) ||
            row.chars !== text.length ||
            row.truncated !== Number(t) ||
            brotliDecompressSync(row.body).toString('utf8') !== (t ? truncateForIndex(text) : text)
          )
            throw Error(`README verification failed: ${p}`);
        }
      }
    } finally {
      db.close();
    }
  }
  // Empty stores are still created so --verify has a consistent target.
  for (const name of ['raw', 'readme'])
    if (!fs.existsSync(path.join(dir, `${name}-store.sqlite`))) {
      const db = new DatabaseSync(path.join(dir, `${name}-store.sqlite`));
      db.exec(
        name === 'raw'
          ? 'CREATE TABLE responses(key TEXT PRIMARY KEY, url TEXT, etag TEXT, last_modified TEXT, sha256 TEXT, status INTEGER, fetched_at TEXT, meta TEXT, body BLOB)'
          : 'CREATE TABLE readmes(path TEXT PRIMARY KEY, sha256 TEXT, bytes INTEGER, chars INTEGER, truncated INTEGER, body BLOB, updated_at TEXT, features TEXT)',
      );
      db.close();
    }
  mergeWork(inv.work);
  // Ensure all declared paths will remain readable after deletion.
  const db = openStore('readme');
  try {
    const get = db.prepare('SELECT 1 FROM readmes WHERE path=?');
    for (const p of plugins())
      if (p.readme_path && !get.get(p.readme_path)) throw Error(`missing stored README ${p.readme_path}`);
  } finally {
    db.close();
  }
  assertProtected(before);
  const deleting = [
    ...inv.raw,
    ...inv.entries.map((e) => e.f),
    ...inv.work.input,
    ...[...inv.work.outputs.values()].flat(),
    ...inv.work.log,
  ];
  for (const f of deleting) {
    fs.unlinkSync(f);
    removeEmpty(path.dirname(f), dir);
  }
  for (const name of ['raw', 'readme']) {
    const db = new DatabaseSync(path.join(dir, `${name}-store.sqlite`));
    try {
      db.exec('PRAGMA busy_timeout=5000; VACUUM');
    } finally {
      db.close();
    }
  }
  assertProtected(before);
  console.log(
    JSON.stringify(
      {
        mode,
        before_bytes: beforeBytes,
        after_bytes: total(files(dir)),
        before_du_bytes: beforeDu,
        after_du_bytes: diskUsage(dir),
        deleted_files: deleting.length,
      },
      null,
      2,
    ),
  );
}

if (!process.exitCode)
  try {
    await main();
  } catch (e) {
    if (protectedBefore) {
      try {
        assertProtected(protectedBefore);
      } catch (changed) {
        e = changed;
      }
    }
    console.error(e.stack || e);
    process.exitCode = e.protectedChanged ? 3 : 2;
  }
