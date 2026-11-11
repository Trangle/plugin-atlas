import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { README_SIGNAL_PATTERNS } from './signals.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const dataDir = () =>
  path.resolve(process.env.ATLAS_DATA_DIR || path.join(process.env.ATLAS_ROOT || process.cwd(), 'data'));
const connections = new Map();
function db(name, dir = dataDir()) {
  const file = path.join(dir, name + '-store.sqlite');
  if (connections.has(file)) return connections.get(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  if (name === 'raw')
    d.exec(
      'CREATE TABLE IF NOT EXISTS responses(key TEXT PRIMARY KEY, url TEXT, etag TEXT, last_modified TEXT, sha256 TEXT, status INTEGER, fetched_at TEXT, meta TEXT, body BLOB)',
    );
  else {
    d.exec(
      'CREATE TABLE IF NOT EXISTS readmes(path TEXT PRIMARY KEY, sha256 TEXT, bytes INTEGER, chars INTEGER, truncated INTEGER, body BLOB, updated_at TEXT, features TEXT)',
    );
    if (
      !d
        .prepare('PRAGMA table_info(readmes)')
        .all()
        .some((column) => column.name === 'features')
    )
      d.exec('ALTER TABLE readmes ADD COLUMN features TEXT');
  }
  connections.set(file, d);
  return d;
}
const readers = new Map();
function existing(name, dir = dataDir()) {
  const file = path.join(dir, name + '-store.sqlite');
  if (connections.has(file)) return connections.get(file);
  if (!fs.existsSync(file)) return null;
  if (!readers.has(file)) readers.set(file, new DatabaseSync(file, { readOnly: true }));
  return readers.get(file);
}
export function readRaw(key, dir = dataDir()) {
  const d = existing('raw', dir);
  const row = d?.prepare('SELECT * FROM responses WHERE key = ?').get(key);
  return row ? { ...row, body: brotliDecompressSync(row.body).toString('utf8') } : null;
}
// Every retained field below is consumed by update's candidate builders, pagination,
// enrichment or package declarations, or by dedup's alias/homepage matching.
const pick = (o, keys) =>
  o && typeof o === 'object' && !Array.isArray(o)
    ? Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]))
    : o;
// id/full_name: dedup aliases; html_url, owner.login, description, homepage,
// topics, stargazers_count, pushed_at, updated_at: GitHub candidates; default_branch,
// archived, fork: repo enrichment and README URL.
const github = (o) => {
  const x = pick(o, [
    'id',
    'full_name',
    'html_url',
    'description',
    'homepage',
    'topics',
    'stargazers_count',
    'pushed_at',
    'updated_at',
    'default_branch',
    'archived',
    'fork',
    'owner',
  ]);
  if (x?.owner) x.owner = pick(x.owner, ['login']);
  return x;
};
// package manifest: dependencies/peerDependencies identify DSH dependencies;
// keywords enrich search; dsh/cordis contain nested service and tool declarations.
const manifest = (o) => pick(o, ['dependencies', 'peerDependencies', 'keywords', 'dsh', 'cordis']);
export function compactRaw(key, doc) {
  if (/^data\/raw\/github\/repos\//.test(key)) return github(doc);
  if (/^data\/raw\/github\/(search|full)\//.test(key)) {
    // total_count controls pagination; items feed candidate construction and dedup.
    const x = pick(doc, ['total_count', 'items']);
    if (Array.isArray(x?.items)) x.items = x.items.map(github);
    return x;
  }
  if (key.startsWith('data/raw/package-json/')) return manifest(doc);
  if (key.startsWith('data/raw/packument/')) {
    // dist-tags select retained versions; readme digest/length record removed text.
    const x = pick(doc, ['dist-tags', 'versions']);
    if (!x || typeof x !== 'object') return x;
    const versions = {};
    for (const v of Object.values(x['dist-tags'] || {}))
      if (doc.versions?.[v]) {
        const version = doc.versions[v];
        versions[v] = manifest(version);
        if (typeof version.readme === 'string') {
          versions[v].readme_sha256 = hash(version.readme);
          versions[v].readme_length = version.readme.length;
        }
      }
    if (x.versions) x.versions = versions;
    if (typeof doc.readme === 'string') {
      x.readme_sha256 = hash(doc.readme);
      x.readme_length = doc.readme.length;
    }
    return x;
  }
  if (key.startsWith('data/raw/npm-search/')) {
    // total/objects control pagination; package metadata and monthly downloads build candidates.
    const x = pick(doc, ['total', 'objects']);
    if (Array.isArray(x?.objects))
      x.objects = x.objects.map((o) => {
        const y = pick(o, ['package', 'updated', 'downloads']);
        if (y.package) {
          y.package = pick(y.package, [
            'name',
            'version',
            'description',
            'keywords',
            'links',
            'repository',
            'publisher',
            'maintainers',
            'date',
          ]);
          if (y.package.links) y.package.links = pick(y.package.links, ['repository', 'homepage']);
          if (y.package.repository && typeof y.package.repository === 'object')
            y.package.repository = pick(y.package.repository, ['url']);
          if (y.package.publisher) y.package.publisher = pick(y.package.publisher, ['username']);
          if (Array.isArray(y.package.maintainers))
            y.package.maintainers = y.package.maintainers.map((m) => pick(m, ['username']));
        }
        if (y.downloads) y.downloads = pick(y.downloads, ['monthly']);
        return y;
      });
    return x;
  }
  if (key.startsWith('data/raw/index/')) {
    // updated/count report catalog status; plugin fields form catalog candidates.
    const x = pick(doc, ['updated', 'count', 'plugins']);
    if (Array.isArray(x?.plugins))
      x.plugins = x.plugins.map((p) => {
        const y = pick(p, [
          'url',
          'owner',
          'name',
          'npm',
          'version',
          'description',
          'capabilities',
          'stars',
          'capabilityCheckedAt',
          'downloadsCheckedAt',
          'category',
          'capabilityRedLines',
          'downloads',
          'install',
        ]);
        if (y.description) y.description = pick(y.description, ['zh', 'en']);
        return y;
      });
    return x;
  }
  if (key.startsWith('data/raw/inventory/')) {
    // dsh_version and catalog supply official package candidates and install version.
    const x = pick(doc, ['dsh_version', 'catalog']);
    if (Array.isArray(x?.catalog))
      x.catalog = x.catalog.map((e) => {
        const y = pick(e, ['packageName', 'meta']);
        if (y.meta) {
          y.meta = pick(y.meta, ['title', 'description']);
          for (const k of ['title', 'description']) if (y.meta[k]) y.meta[k] = pick(y.meta[k], ['zh', 'en']);
        }
        return y;
      });
    return x;
  }
  return doc;
}
export function listRaw(prefix, dir = dataDir()) {
  const keys = new Set(
    existing('raw', dir)
      ?.prepare('SELECT key FROM responses WHERE substr(key, 1, ?) = ? ORDER BY key')
      .all(prefix.length, prefix)
      .map((r) => r.key) || [],
  );
  const walk = (d, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const k = rel + '/' + e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), k);
      else keys.add(k);
    }
  };
  const rel = prefix.replace(/\/$/, '');
  walk(path.join(dir, rel.replace(/^data\//, '')), rel);
  return [...keys].filter((k) => k.startsWith(prefix)).sort();
}
export function writeRaw(
  key,
  { url = null, etag = null, last_modified = null, sha256 = null, status = 200, body, meta = null },
) {
  const original = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  let compact = original.toString('utf8');
  if (!key.endsWith('.txt'))
    try {
      compact = JSON.stringify(compactRaw(key, JSON.parse(compact)));
    } catch {
      /* non-JSON source */
    }
  db('raw')
    .prepare('INSERT OR REPLACE INTO responses VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      key,
      url,
      etag,
      last_modified,
      sha256 || hash(original),
      status,
      new Date().toISOString(),
      meta == null ? null : JSON.stringify(meta),
      brotliCompressSync(Buffer.from(compact)),
    );
}
function diskPath(p, dir = dataDir()) {
  const rel = String(p)
    .replace(/^\.\/?data\//, '')
    .replace(/^data\//, '');
  const target = path.resolve(dir, rel);
  return target.startsWith(dir + path.sep) ? target : null;
}
export function readReadme(p, dir = dataDir()) {
  const file = diskPath(p, dir);
  if (file)
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  const row = existing('readme', dir)?.prepare('SELECT body FROM readmes WHERE path = ?').get(p);
  return row ? brotliDecompressSync(row.body).toString('utf8') : null;
}
export function readmeMeta(p) {
  const file = diskPath(p);
  if (file)
    try {
      const text = fs.readFileSync(file, 'utf8');
      return { path: p, sha256: hash(text), bytes: Buffer.byteLength(text), chars: text.length, truncated: 0 };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  const d = existing('readme');
  if (!d) return null;
  const hasFeatures = d
    .prepare('PRAGMA table_info(readmes)')
    .all()
    .some((column) => column.name === 'features');
  return (
    d
      .prepare(
        `SELECT path, sha256, bytes, chars, truncated, updated_at${hasFeatures ? ', features' : ''} FROM readmes WHERE path = ?`,
      )
      .get(p) || null
  );
}
const SIGNAL_SEPARATOR = '\n\n<!-- atlas:signals -->\n';
function indexFeatures(text) {
  const tail = text.slice(16000);
  const signals = new Set();
  const windows = [];
  let used = 0;
  const candidates = [];
  const sourceLines = tail.split(/\r?\n/);
  for (const [lineIndex, line] of sourceLines.entries()) {
    for (const [name, pattern] of Object.entries(README_SIGNAL_PATTERNS)) {
      const globalPattern = new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
      );
      for (const match of line.matchAll(globalPattern)) {
        signals.add(name);
        candidates.push({
          lineIndex,
          start: Math.max(0, match.index - 120),
          end: Math.min(line.length, match.index + match[0].length + 120),
          priority: name === 'STRONG_RE' ? 0 : name === 'MEDIUM_RE' ? 1 : 2,
        });
      }
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.lineIndex - b.lineIndex || a.start - b.start);
  for (const candidate of candidates) {
    const overlapping = windows.filter(
      (w) => w.lineIndex === candidate.lineIndex && w.start <= candidate.end && candidate.start <= w.end,
    );
    const start = Math.min(candidate.start, ...overlapping.map((w) => w.start));
    const end = Math.max(candidate.end, ...overlapping.map((w) => w.end));
    const added = end - start + 1 - overlapping.reduce((sum, w) => sum + w.end - w.start + 1, 0);
    if (used + added > 6001) continue;
    for (const window of overlapping) windows.splice(windows.indexOf(window), 1);
    windows.push({ lineIndex: candidate.lineIndex, start, end });
    used += added;
  }
  windows.sort((a, b) => a.lineIndex - b.lineIndex || a.start - b.start);
  const lines = new Set(windows.map((w) => sourceLines[w.lineIndex].slice(w.start, w.end)));
  return { signals: [...signals], tail_chars: tail.length, lines: [...lines] };
}
export function truncateForIndex(text) {
  text = String(text);
  const { lines } = indexFeatures(text);
  return text.slice(0, 16000) + (lines.length ? SIGNAL_SEPARATOR + lines.join('\n') : '');
}
export function writeReadme(p, text, { truncate = false } = {}) {
  text = String(text);
  const { signals, tail_chars } = indexFeatures(text);
  db('readme')
    .prepare(
      'INSERT OR REPLACE INTO readmes (path, sha256, bytes, chars, truncated, body, updated_at, features) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      p,
      hash(text),
      Buffer.byteLength(text),
      text.length,
      truncate ? 1 : 0,
      brotliCompressSync(Buffer.from(truncate ? truncateForIndex(text) : text)),
      new Date().toISOString(),
      JSON.stringify({ signals, tail_chars }),
    );
}
