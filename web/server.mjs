import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readReadme } from '../crawler/lib/store.mjs';
const WEB = path.dirname(fileURLToPath(import.meta.url)),
  ROOT = path.dirname(WEB),
  arr = (x) => (Array.isArray(x) ? x : []),
  str = (x) => (typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x));
fs.mkdirSync(path.join(WEB, '.index'), { recursive: true });
let state,
  extractor,
  modelName = '',
  modelState = process.env.ATLAS_DISABLE_MODEL === '1' ? 'disabled' : 'loading',
  modelError = '',
  generation = 0,
  reloadPromise;
const githubOnly = (p) =>
  typeof p.github_only === 'boolean'
    ? p.github_only
    : arr(p.markets).length > 0 && p.markets.every((m) => m === 'github' || String(m).startsWith('github:'));
const included = (u) => u.searchParams.get('include_github_only') === '1';
const FTS_BODY = Math.max(2000, Number(process.env.ATLAS_FTS_BODY) || 12000),
  TFIDF_BODY = Math.max(1000, Number(process.env.ATLAS_TFIDF_BODY) || 1500);
const safe = (x) => typeof x === 'string' && !/[\\/]/.test(x) && !x.includes('..');
const json = async (p) => JSON.parse(await fs.promises.readFile(p, 'utf8'));
const ancestor = (s, n, type) => {
  const seen = new Set();
  while (n && !seen.has(n.id)) {
    if (n.type === type) return n.id;
    seen.add(n.id);
    n = s.nm.get(n.parent);
  }
  return null;
};
const tokens = (s) => {
  const t = str(s).toLowerCase(),
    a = t.match(/[a-z0-9_]+/g) || [];
  for (let n = 1; n <= 3; n++)
    for (let i = 0; i <= t.length - n; i++) {
      const v = t.slice(i, i + n);
      if (/[^\x00-\x7f]/.test(v) && !/\s/.test(v)) a.push(v);
    }
  return a;
};
const dot = (a, b) => {
  let n = 0;
  for (const [k, v] of a) n += v * (b.get(k) || 0);
  return n;
};
function vector(t, idf) {
  const m = new Map();
  for (const k of tokens(t)) m.set(k, (m.get(k) || 0) + 1);
  let norm = 0;
  for (const [k, v] of m) {
    const x = (1 + Math.log(v)) * (idf.get(k) || 1);
    m.set(k, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [k, v] of m) m.set(k, v / norm);
  return m;
}
function confined(base, p) {
  const target = path.resolve(base, p);
  return target.startsWith(path.resolve(base) + path.sep) ? target : null;
}
function readmeDetail(p, dir) {
  const bytes = Buffer.from(readReadme(p, dir) || '');
  return bytes.length <= 200 * 1024
    ? bytes.toString('utf8')
    : bytes
        .subarray(0, 200 * 1024)
        .toString('utf8')
        .replace(/\uFFFD$/, '');
}
async function indexReadme(p, dir, hash, limit) {
  const rel = String(p)
    .replace(/^\.\/?data\//, '')
    .replace(/^data\//, '');
  let file = confined(dir, rel);
  if (!file) return '';
  try {
    await fs.promises.access(file);
    let prefix = '',
      decoder = new TextDecoder();
    for await (const chunk of fs.createReadStream(file)) {
      hash.update(chunk);
      if (prefix.length < limit) prefix += decoder.decode(chunk, { stream: true }).slice(0, limit - prefix.length);
    }
    return prefix;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const text = readReadme(p, dir) || '';
    hash.update(text);
    return text.slice(0, limit);
  }
}
function pluginFor(s, n) {
  if (n.type !== 'plugin') return undefined;
  return s.pm.get(n.plugin_id || n.id) || s.pm.get(arr(n.plugin_ids)[0]);
}
function category(s, n) {
  const seen = new Set();
  while (n && !seen.has(n.id)) {
    if (n.type === 'category') return n.id;
    seen.add(n.id);
    n = s.nm.get(n.parent);
  }
  return null;
}
function reload() {
  if (reloadPromise) return reloadPromise;
  reloadPromise = buildSnapshot().finally(() => {
    reloadPromise = null;
  });
  return reloadPromise;
}
async function buildSnapshot() {
  const start = performance.now(),
    timings = {};
  let loaded,
    dir,
    warning = '';
  for (const candidate of process.env.ATLAS_DATA_DIR
    ? [path.resolve(process.env.ATLAS_DATA_DIR), path.join(WEB, 'fixtures')]
    : [path.join(ROOT, 'data'), path.join(WEB, 'fixtures')]) {
    try {
      const graph = await json(path.join(candidate, 'graph.json'));
      const text = await fs.promises.readFile(path.join(candidate, 'plugins.jsonl'), 'utf8');
      const plugins = [];
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) {
          const p = JSON.parse(lines[i]);
          if (p?.id) plugins.push({ ...p, github_only: githubOnly(p) });
        }
        if (i % 256 === 0) await yieldNow();
      }
      if (!arr(graph.nodes).length || !plugins.length) throw Error('数据为空');
      graph.nodes = graph.nodes
        .filter((n) => n?.id)
        .map((n) => ({
          ...n,
          type: typeof n.type === 'string' ? n.type : 'branch',
          label: n.label || n.id,
          summary: n.summary || '',
        }));
      graph.edges = arr(graph.edges);
      loaded = { graph, plugins };
      dir = candidate;
      break;
    } catch (e) {
      warning += `${candidate}: ${e.message}; `;
    }
  }
  if (!loaded) throw Error(warning);
  const s = {
    ...loaded,
    dir,
    source: dir === path.join(WEB, 'fixtures') ? 'fixtures' : 'data',
    warning,
    nm: new Map(),
    pm: new Map(),
    pn: new Map(),
    children: new Map(),
    adj: new Map(),
    caps: new Map(),
    branchCaps: new Map(),
    docs: [],
    vectors: null,
    embedding: { done: 0, total: 0, cached: 0 },
    generation: ++generation,
  };
  for (const p of s.plugins) s.pm.set(p.id, p);
  for (const n of s.graph.nodes) {
    s.nm.set(n.id, n);
    if (!s.children.has(n.parent)) s.children.set(n.parent, []);
    s.children.get(n.parent).push(n);
    if (n.type === 'plugin') {
      const p = pluginFor(s, n);
      n.github_only = typeof n.github_only === 'boolean' ? n.github_only : !!p?.github_only;
      if (p && !s.pn.has(p.id)) s.pn.set(p.id, n);
    }
  }
  s.relations = [
    ...s.graph.edges.filter((e) => e.type !== 'parent'),
    ...s.graph.nodes.filter((n) => n.parent).map((n) => ({ source: n.parent, target: n.id, type: 'parent' })),
  ];
  for (const e of s.relations)
    for (const id of new Set([e.source, e.target])) {
      if (!s.adj.has(id)) s.adj.set(id, []);
      s.adj.get(id).push(e);
    }
  const counts = new Map();
  for (const n of s.graph.nodes)
    if (n.type === 'plugin') {
      let p = s.nm.get(n.parent);
      const seen = new Set();
      while (p && !seen.has(p.id)) {
        seen.add(p.id);
        const c = counts.get(p.id) || [0, 0];
        c[1]++;
        if (!n.github_only) c[0]++;
        counts.set(p.id, c);
        p = s.nm.get(p.parent);
      }
    }
  let filteredOut = null;
  try {
    filteredOut = (await fs.promises.readFile(path.join(dir, 'filtered-out.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim()).length;
  } catch {}
  s.counts = counts;
  s.statCounts = {
    plugins_visible: s.plugins.filter((p) => !p.github_only).length,
    github_only: s.plugins.filter((p) => p.github_only).length,
    plugin_nodes_visible: s.graph.nodes.filter((n) => n.type === 'plugin' && !n.github_only).length,
    relevance_suspect: s.plugins.filter((p) => p.relevance === 'suspect' || p.suspect_irrelevant === true).length,
    filtered_out: filteredOut,
  };
  timings.parse = performance.now() - start;
  const readStart = performance.now();
  const normalize = (c) => ({
    ...c,
    union: arr(c.union)
      .filter((u) => u && typeof u === 'object')
      .map((u) => ({ ...u, provided_by: arr(u.provided_by) })),
    duplicates: arr(c.duplicates).filter(Array.isArray),
  });
  for (const n of s.graph.nodes.filter((n) => n.type === 'category' && safe(n.id))) {
    try {
      s.caps.set(n.id, normalize(await json(path.join(dir, 'capabilities', n.id + '.json'))));
    } catch {}
    const directory = path.join(dir, 'capabilities', n.id);
    let files = [];
    try {
      files = await fs.promises.readdir(directory);
    } catch {}
    const loadedFiles = new Map();
    for (const f of files.filter((f) => f.endsWith('.json') && safe(f)))
      try {
        loadedFiles.set(f, normalize(await json(path.join(directory, f))));
      } catch {}
    for (const b of s.graph.nodes.filter(
      (b) => b.type === 'branch' && ancestor(s, b, 'category') === n.id && safe(b.id),
    )) {
      const c =
        loadedFiles.get(b.id + '.json') ||
        loadedFiles.get(b.id.startsWith(n.id + '.') ? b.id.slice(n.id.length + 1) + '.json' : '');
      if (c) s.branchCaps.set(b.id, c);
    }
    if (!s.caps.has(n.id) && loadedFiles.size)
      s.caps.set(n.id, {
        category_id: n.id,
        merged_from_branches: true,
        union: [...loadedFiles.values()].flatMap((c) => c.union),
        duplicates: [...loadedFiles.values()].flatMap((c) => c.duplicates),
      });
    // Index every branch file, including files whose branch is absent from this graph.
    for (const [f, c] of loadedFiles) s.branchCaps.set(n.id + '/' + f, c);
  }
  timings.readmes = performance.now() - readStart;
  const ftsStart = performance.now();
  s.db = new DatabaseSync(process.env.ATLAS_INDEX_PATH || path.join(WEB, '.index', 'atlas.sqlite'));
  s.db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS docs(rowid INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, node_id TEXT, github_only INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(kind,id)); CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title,body,content='docs',content_rowid='rowid',tokenize='trigram');",
  );
  const existing = new Map(
    s.db
      .prepare('SELECT rowid,kind,id,hash FROM docs')
      .all()
      .map((d) => [d.kind + '\0' + d.id, d]),
  );
  const ins = s.db.prepare('INSERT INTO docs(kind,id,title,node_id,github_only,hash,body) VALUES(?,?,?,?,?,?,?)');
  const upd = s.db.prepare('UPDATE docs SET title=?,node_id=?,github_only=?,hash=?,body=? WHERE rowid=?');
  const fadd = s.db.prepare('INSERT INTO docs_fts(rowid,title,body) VALUES(?,?,?)');
  const fdel = s.db.prepare(
    "INSERT INTO docs_fts(docs_fts,rowid,title,body) SELECT 'delete',rowid,title,body FROM docs WHERE rowid=?",
  );
  const del = s.db.prepare('DELETE FROM docs WHERE rowid=?');
  let changed = 0;
  s.db.exec('BEGIN IMMEDIATE');
  try {
    const add = async (kind, id, title, body, node_id, github_only = false, readmePath = null) => {
      title = str(title);
      body = str(body);
      const hash = createHash('sha256').update(
        JSON.stringify([kind, id, title, body, node_id, !!github_only, FTS_BODY]),
      );
      if (readmePath) {
        const result = await indexReadme(readmePath, dir, hash, Math.max(0, FTS_BODY - body.length - 1));
        body += ' ' + result;
      }
      body = body.slice(0, FTS_BODY);
      const digest = hash.digest('hex'),
        key = kind + '\0' + id,
        old = existing.get(key);
      existing.delete(key);
      let rowid;
      if (old) {
        rowid = old.rowid;
        if (old.hash !== digest) {
          fdel.run(rowid);
          upd.run(title, node_id, github_only ? 1 : 0, digest, body, rowid);
          fadd.run(rowid, title, body);
          changed++;
        }
      } else {
        rowid = Number(ins.run(kind, id, title, node_id, github_only ? 1 : 0, digest, body).lastInsertRowid);
        fadd.run(rowid, title, body);
        changed++;
      }
      s.docs.push({ rowid, kind, github_only: !!github_only });
    };
    for (const n of s.graph.nodes)
      await add(
        'node',
        n.id,
        n.label,
        [n.summary, n.fork_reason].map(str).join(' '),
        n.id,
        n.type === 'plugin' && n.github_only,
      );
    for (const p of s.plugins)
      await add(
        'plugin',
        p.id,
        p.name || p.id,
        [p.description, p.summary, p.keywords, p.capabilities, p.tools, p.provides].map(str).join(' '),
        s.pn.get(p.id)?.id || null,
        p.github_only,
        p.readme_path,
      );
    for (const [id, c] of [...s.caps, ...s.branchCaps]) {
      const node = s.nm.has(id) ? id : id.split('/')[0];
      for (const [i, u] of arr(c.union).entries())
        await add(
          'capability',
          id + ':' + i,
          u.capability,
          [u.note, u.provided_by, u.best_impl].map(str).join(' '),
          node,
        );
      if (c.vision) await add('capability', id + ':vision', (c.label || id) + ' · 愿景', c.vision, node);
    }
    for (const d of existing.values()) {
      fdel.run(d.rowid);
      del.run(d.rowid);
      changed++;
    }
    s.db.exec('COMMIT');
  } catch (e) {
    s.db.exec('ROLLBACK');
    s.db.close();
    throw e;
  }
  timings.fts = performance.now() - ftsStart;
  timings.index_changed = changed;
  timings.tfidf = 0;
  for (const n of s.graph.nodes)
    if (n.type !== 'plugin' && Array.isArray(n.plugin_ids)) {
      n.plugin_ids_count = n.plugin_ids.length;
      delete n.plugin_ids;
    }
  timings.total = performance.now() - start;
  s.timings = timings;
  s.embedding.total = s.docs.length;
  const old = state;
  if (
    old &&
    changed === 0 &&
    old.docs.length === s.docs.length &&
    s.docs.every((d, i) => d.rowid === old.docs[i].rowid)
  ) {
    s.vectors = old.vectors;
    s.dim = old.dim;
    s.tfidf = old.tfidf;
    s.embedding = old.embedding;
  }
  state = s;
  startFamilyComputation(s);
  if (old) {
    old.familyWorker?.terminate();
    old.retired = true;
    if (!old.users) old.db.close();
  }
  if (extractor && !s.vectors) void embedState(s);
  return { ...status(), ok: true, timings, took_ms: Math.round(timings.total) };
}
function semanticBackend(s = state) {
  const ready = !!s?.vectors;
  const reason = ready
    ? null
    : modelState === 'disabled'
      ? '模型已禁用'
      : modelState === 'failed'
        ? '模型失败'
        : extractor
          ? `向量计算中 ${s?.embedding.done || 0}/${s?.docs.length || 0}`
          : '模型加载中';
  const tf = !!s?.tfidf || ['disabled', 'failed'].includes(modelState);
  return {
    backend: ready ? 'minilm' : tf ? 'tfidf' : 'fulltext',
    model: modelName || null,
    label: ready
      ? `transformers.js MiniLM (${modelName})`
      : tf
        ? `TF-IDF（降级：${reason}）`
        : `全文检索（降级：${reason}）`,
    reason,
  };
}
function status() {
  const semantic = semanticBackend(),
    m = process.memoryUsage(),
    memory = { rss_mb: m.rss / 1048576, heap_used_mb: m.heapUsed / 1048576, external_mb: m.external / 1048576 };
  if (!state)
    return { loading: true, semantic, semantic_backend: semantic.label, model_status: modelState, memory, timings: {} };
  const s = state;
  return {
    loading: !!reloadPromise,
    source: s.source,
    data_dir: s.dir,
    example: s.graph.example === true,
    counts: {
      nodes: s.graph.nodes.length,
      plugins: s.plugins.length,
      ...s.statCounts,
      edges: s.graph.edges.length,
      capabilities: s.caps.size,
    },
    index: {
      documents: s.docs.length,
      fulltext: 'sqlite-fts5-trigram',
      vectors: s.vectors ? s.docs.length : s.tfidf ? s.docs.length : 0,
    },
    semantic,
    semantic_backend: semantic.label,
    embedding: s.embedding,
    model_status: modelState,
    model_error: modelError || undefined,
    warning: s.warning || undefined,
    timings: s.timings,
    memory,
  };
}
let embeddingQueue = Promise.resolve();
function embedState(s) {
  embeddingQueue = embeddingQueue.catch(() => {}).then(() => embedSnapshot(s));
  return embeddingQueue;
}
async function embedSnapshot(s) {
  if (!s || state !== s) return;
  const base = path.join(WEB, '.models', 'embeddings-' + modelName.replace(/[^a-z0-9_-]/gi, '_'));
  await fs.promises.mkdir(path.dirname(base), { recursive: true });
  let index = {};
  try {
    index = await json(base + '.json');
  } catch {}
  const file = await fs.promises.open(base + '.bin', 'a+');
  let length = (await file.stat()).size,
    matrix,
    dim = 0;
  const get = s.db.prepare('SELECT title,body FROM docs WHERE rowid=?');
  try {
    for (let i = 0; i < s.docs.length; i++) {
      if (state !== s) return;
      const d = get.get(s.docs[i].rowid),
        text = (d.title + ' ' + d.body).slice(0, 4000),
        key = createHash('sha1')
          .update(modelName + '\0' + text)
          .digest('hex'),
        hit = index[key];
      let v;
      if (hit && hit.offset + hit.length * 4 <= length) {
        const b = Buffer.allocUnsafe(hit.length * 4);
        await file.read(b, 0, b.length, hit.offset);
        v = new Float32Array(b.buffer, b.byteOffset, hit.length);
        s.embedding.cached++;
      } else {
        v = (await extractor(text, { pooling: 'mean', normalize: true })).data;
        const b = Buffer.from(new Float32Array(v).buffer);
        await file.write(b, 0, b.length, length);
        index[key] = { offset: length, length: v.length };
        length += b.length;
      }
      if (!matrix) {
        dim = v.length;
        matrix = new Float32Array(s.docs.length * dim);
      }
      if (v.length !== dim) throw Error('embedding dimension mismatch');
      matrix.set(v, i * dim);
      s.embedding.done++;
      if (i % 256 === 0) await yieldNow();
    }
    await fs.promises.writeFile(base + '.json.tmp', JSON.stringify(index));
    await fs.promises.rename(base + '.json.tmp', base + '.json');
    if (state === s) {
      s.vectors = matrix;
      s.dim = dim;
      s.tfidf = null;
    }
  } catch (e) {
    modelError = e.message;
    modelState = 'failed';
  } finally {
    await file.close();
  }
}
async function initModel() {
  if (process.env.ATLAS_DISABLE_MODEL === '1') {
    modelState = 'disabled';
    return;
  }
  try {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(WEB, '.models');
    env.allowLocalModels = false;
    for (const name of ['Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'Xenova/all-MiniLM-L6-v2']) {
      try {
        extractor = await pipeline('feature-extraction', name, { dtype: 'q8', device: 'cpu' });
        modelName = name;
        modelState = 'ready';
        modelError = '';
        await embedState(state);
        return;
      } catch (e) {
        modelError = e.message;
        console.error('Model failed:', name, e.message);
      }
    }
    modelState = 'failed';
  } catch (e) {
    modelState = 'failed';
    modelError = e.message;
  }
}
function apiNode(s, n) {
  if (!n || n.type === 'plugin' || n.plugin_ids_count === undefined) return n;
  const ids = [],
    todo = [n],
    seen = new Set();
  while (todo.length) {
    const x = todo.pop();
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    if (x.type === 'plugin') {
      const p = pluginFor(s, x);
      ids.push(p?.id || x.plugin_id || x.id);
    } else todo.push(...(s.children.get(x.id) || []));
  }
  const { plugin_ids_count, ...rest } = n;
  return { ...rest, plugin_ids: ids };
}
async function treeIndex(s) {
  if (!s.treeIndexPromise)
    s.treeIndexPromise = import('../dsh-plugin/lib/pipeline/plan.mjs').then(({ loadIndex }) =>
      loadIndex({ dataDir: s.dir }),
    );
  return s.treeIndexPromise;
}
async function plansFor(s, index) {
  if (!process.env.ATLAS_STATE_DIR) return [];
  const { listPlans } = await import('../dsh-plugin/lib/pipeline/plan.mjs');
  return listPlans({ stateDir: path.resolve(process.env.ATLAS_STATE_DIR), dataDir: s.dir }, index);
}
function startFamilyComputation(s) {
  s.familyCache = { computing: true, families: null, with_plan: 0, stale: 0 };
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { familyWorker: true, dir: s.dir, stateDir: process.env.ATLAS_STATE_DIR },
  });
  s.familyWorker = worker;
  worker.on('message', (result) => {
    if (state === s) Object.assign(s.familyCache, result, { computing: false });
  });
  worker.on('error', (e) => {
    if (state === s) Object.assign(s.familyCache, { computing: false, error: e.message });
    console.error('Family computation failed:', e);
  });
  worker.on('exit', (code) => {
    if (code && state === s && s.familyCache.computing)
      Object.assign(s.familyCache, { computing: false, error: `worker exited ${code}` });
  });
}
async function computeFamilies({ dir, stateDir }) {
  const { loadIndex, listPlans } = await import('../dsh-plugin/lib/pipeline/plan.mjs');
  const { listFamilies, representatives } = await import('../dsh-plugin/lib/tree/families.mjs');
  const index = await loadIndex({ dataDir: dir }),
    plans = stateDir ? await listPlans({ stateDir: path.resolve(stateDir), dataDir: dir }, index) : [],
    byId = new Map(plans.map((p) => [p.family, p]));
  const families = listFamilies(index).map((f) => {
    const plan = byId.get(f.id);
    return {
      ...f,
      representatives: representatives(index, f),
      planStatus: plan ? (plan.stale ? '过期' : '最新') : '无',
    };
  });
  return {
    families,
    with_plan: families.filter((f) => byId.has(f.id)).length,
    stale: families.filter((f) => byId.get(f.id)?.stale).length,
  };
}
async function treeApi(u, s = state) {
  const route = u.pathname,
    id = u.searchParams.get('id');
  if (route === '/api/families' && !u.searchParams.get('branch')) {
    const c = s.familyCache;
    if (u.searchParams.get('summary') === '1')
      return { families: c.families?.length || 0, with_plan: c.with_plan, stale: c.stale, computing: c.computing };
    if (c.error) throw Error(c.error);
    return c.computing ? { computing: true } : { families: c.families };
  }
  const index = await treeIndex(s);
  if (route === '/api/tree-node') {
    const { nodeCaps } = await import('../dsh-plugin/lib/tree/caps.mjs');
    return nodeCaps(index, id);
  }
  if (route === '/api/tree-find') {
    const { normalize } = await import('../dsh-plugin/lib/tree/caps.mjs');
    const q = normalize(u.searchParams.get('q') || ''),
      limit = Math.min(100, Math.max(1, parseInt(u.searchParams.get('limit')) || 20)),
      matches = [];
    if (q)
      for (const node of index.nodes.values()) {
        const p = index.plugins.get(node.plugin_id || node.id);
        const match = [
          node.id,
          node.label,
          p?.name,
          ...Object.values(node.groups)
            .flat()
            .map((c) => c.capability),
        ].find((v) => normalize(v).includes(q));
        if (match === undefined) continue;
        const path = [],
          seen = new Set();
        let n = node;
        while (n && !seen.has(n.id)) {
          seen.add(n.id);
          path.unshift({ id: n.id, label: n.label || n.id });
          n = index.nodes.get(n.parent);
        }
        matches.push({ id: node.id, label: node.label || node.id, type: node.type, path, match });
        if (matches.length >= limit) break;
      }
    return { matches };
  }
  const plans = await plansFor(s, index);
  if (route === '/api/plan') {
    const plan = plans.find((p) => p.family === id);
    return plan
      ? { status: plan.stale ? 'stale' : 'fresh', plan }
      : { id, status: 'none', command: `/atlas plan ${id} --dry-run` };
  }
  const { listFamilies, representatives } = await import('../dsh-plugin/lib/tree/families.mjs');
  const families = listFamilies(index, { branch: u.searchParams.get('branch') }).map((f) => {
    const plan = plans.find((p) => p.family === f.id);
    return {
      ...f,
      representatives: representatives(index, f),
      planStatus: plan ? (plan.stale ? '过期' : '最新') : '无',
    };
  });
  return { families };
}
function relations(id, rel = 'all', s = state) {
  if (!s.nm.has(id)) return null;
  const edges = (s.adj.get(id) || []).filter((e) =>
    rel === 'children'
      ? e.type === 'parent' && e.source === id
      : rel === 'parent'
        ? e.type === 'parent' && e.target === id
        : rel === 'all' || e.type === rel,
  );
  const ids = new Set(edges.flatMap((e) => [e.source, e.target]).filter((x) => x !== id));
  return { node: apiNode(s, s.nm.get(id)), nodes: [...ids].map((x) => apiNode(s, s.nm.get(x))).filter(Boolean), edges };
}
function graphView(u, tree = false, stateSnapshot = state) {
  const state = stateSnapshot;
  const nodes = state.graph.nodes.filter(
    (n) => (!tree || n.type !== 'plugin') && (included(u) || n.type !== 'plugin' || !n.github_only),
  );
  const ids = new Set(nodes.map((n) => n.id));
  return {
    ...state.graph,
    nodes: tree
      ? nodes.map(({ plugin_ids, ...n }) => ({
          ...n,
          plugin_ids_count: n.plugin_ids_count ?? arr(plugin_ids).length,
          plugin_count: (state.counts.get(n.id) || [0, 0])[included(u) ? 1 : 0],
          plugin_count_all: (state.counts.get(n.id) || [0, 0])[1],
          has_children: (state.children.get(n.id) || []).some(
            (c) => included(u) || c.type !== 'plugin' || !c.github_only,
          ),
        }))
      : nodes.map((n) => apiNode(state, n)),
    edges: state.graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && (!tree || e.type !== 'parent')),
  };
}
function childrenPage(u) {
  const id = u.searchParams.get('node');
  if (!state.nm.has(id)) return null;
  const children = (state.children.get(id) || []).filter((n) => included(u) || n.type !== 'plugin' || !n.github_only),
    limit = Math.min(1000, Math.max(1, parseInt(u.searchParams.get('limit')) || 200));
  let offset = Math.max(0, parseInt(u.searchParams.get('offset')) || 0);
  const around = children.findIndex((n) => n.id === u.searchParams.get('around'));
  if (around >= 0) offset = Math.floor(around / limit) * limit;
  return {
    nodes: children.slice(offset, offset + limit).map((n) => {
      if (n.type !== 'plugin') return apiNode(state, n);
      const p = pluginFor(state, n);
      return {
        id: n.id,
        type: n.type,
        label: n.label,
        parent: n.parent,
        summary: n.summary,
        plugin_id: p?.id || n.plugin_id,
        github_only: n.github_only,
        relevance: p?.relevance || n.relevance || (p?.suspect_irrelevant ? 'suspect' : undefined),
        markets: p?.markets || [],
        stars: p?.stars ?? null,
      };
    }),
    edges: [...new Set(children.slice(offset, offset + limit).flatMap((n) => state.adj.get(n.id) || []))].filter(
      (e) => e.type !== 'parent',
    ),
    total: children.length,
    offset,
    limit,
    has_more: offset + limit < children.length,
  };
}
async function buildTfidf(s) {
  const started = performance.now();
  const df = new Map(),
    get = s.db.prepare('SELECT title,body FROM docs WHERE rowid=?');
  for (const d of s.docs) {
    const r = get.get(d.rowid);
    for (const t of new Set(tokens(r.title + ' ' + r.body.slice(0, TFIDF_BODY)))) df.set(t, (df.get(t) || 0) + 1);
  }
  const vocab = new Map(),
    idf = new Map();
  for (const [t, n] of df) {
    vocab.set(t, vocab.size);
    idf.set(t, Math.log(1 + s.docs.length / (1 + n)) + 1);
  }
  const offsets = new Int32Array(s.docs.length + 1),
    ids = [],
    values = [];
  for (let i = 0; i < s.docs.length; i++) {
    const r = get.get(s.docs[i].rowid),
      v = vector(r.title + ' ' + r.body.slice(0, TFIDF_BODY), idf);
    for (const [t, x] of v) {
      ids.push(vocab.get(t));
      values.push(x);
    }
    offsets[i + 1] = ids.length;
    if (i % 256 === 0) await yieldNow();
  }
  if (state === s) {
    s.tfidf = { vocab, idf, offsets, ids: Int32Array.from(ids), values: Float32Array.from(values) };
    s.timings.tfidf = performance.now() - started;
  }
}
async function search(u) {
  const s = state;
  s.users = (s.users || 0) + 1;
  try {
    return await searchSnapshot(u, s);
  } finally {
    if (!--s.users && s.retired) s.db.close();
  }
}
async function searchSnapshot(u, s) {
  const q = (u.searchParams.get('q') || '').trim().slice(0, 500),
    mode = u.searchParams.get('mode') || 'hybrid',
    type = u.searchParams.get('type'),
    limit = Math.min(100, Math.max(1, parseInt(u.searchParams.get('limit')) || 20));
  if (!['fulltext', 'semantic', 'hybrid'].includes(mode)) throw Error('未知检索模式');
  const full = new Map();
  if (q) {
    let rows;
    if ([...q].length < 3)
      rows = s.db
        .prepare("SELECT rowid FROM docs WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'")
        .all(...Array(2).fill('%' + q.replace(/[\\%_]/g, '\\$&') + '%'));
    else
      rows = s.db
        .prepare('SELECT rowid,bm25(docs_fts) AS rank FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank')
        .all('"' + q.replaceAll('"', '""') + '"');
    rows.forEach((r, i) => full.set(r.rowid, 1 / (1 + i)));
  }
  if (q && mode !== 'fulltext' && !s.vectors && ['disabled', 'failed'].includes(modelState) && !s.tfidf) {
    if (!s.tfidfPromise)
      s.tfidfPromise = buildTfidf(s).finally(() => {
        s.tfidfPromise = null;
      });
    await s.tfidfPromise;
  }
  let query = null;
  if (q && mode !== 'fulltext' && s.vectors && extractor)
    query = (await extractor(q, { pooling: 'mean', normalize: true })).data;
  else if (q && mode !== 'fulltext' && s.tfidf) {
    query = new Map();
    for (const [t, v] of vector(q, s.tfidf.idf)) {
      const id = s.tfidf.vocab.get(t);
      if (id !== undefined) query.set(id, v);
    }
  }
  const heap = [];
  function push(x) {
    if (heap.length < limit) {
      heap.push(x);
      let i = heap.length - 1;
      while (i) {
        const p = (i - 1) >> 1;
        if (heap[p].score <= x.score) break;
        heap[i] = heap[p];
        i = p;
      }
      heap[i] = x;
    } else if (x.score > heap[0].score) {
      heap[0] = x;
      let i = 0;
      while (true) {
        let c = i * 2 + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1].score < heap[c].score) c++;
        if (heap[i].score <= heap[c].score) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
  }
  for (let i = 0; i < s.docs.length; i++) {
    const d = s.docs[i];
    if ((!included(u) && d.github_only) || (type && d.kind !== type)) continue;
    const f = full.get(d.rowid) || 0;
    let sem = 0;
    if (query && s.vectors) {
      for (let j = 0; j < s.dim; j++) sem += s.vectors[i * s.dim + j] * query[j];
    } else if (query && s.tfidf) {
      const t = s.tfidf;
      for (let j = t.offsets[i]; j < t.offsets[i + 1]; j++) sem += (query.get(t.ids[j]) || 0) * t.values[j];
    } else sem = f;
    const score = mode === 'fulltext' ? f : mode === 'semantic' ? sem : 0.55 * f + 0.45 * sem;
    if (score > 0) push({ rowid: d.rowid, score });
  }
  const get = s.db.prepare('SELECT kind,id,title,body,node_id,github_only FROM docs WHERE rowid=?');
  const results = heap
    .sort((a, b) => b.score - a.score)
    .map((x) => {
      const d = get.get(x.rowid);
      if (!d) return null;
      const at = d.body.toLowerCase().indexOf(q.toLowerCase());
      return {
        github_only: !!d.github_only,
        kind: d.kind,
        id: d.id,
        title: d.title,
        snippet: d.body.slice(Math.max(0, at - 30), Math.max(0, at - 30) + 220),
        score: x.score,
        node_id: d.node_id,
      };
    })
    .filter(Boolean);
  const semantic = semanticBackend(s);
  return { q, mode, semantic, semantic_backend: semantic.label, results };
}
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    const u = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    const loopbackOrigin =
      typeof origin === 'string' && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin);
    if (
      u.pathname.startsWith('/api/') &&
      u.pathname !== '/api/reload' &&
      loopbackOrigin &&
      (req.method === 'GET' || (req.method === 'OPTIONS' && req.headers['access-control-request-method'] === 'GET'))
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.writeHead(204);
        return res.end();
      }
    }
    if (u.pathname === '/api/status') return send(200, status());
    if (u.pathname === '/api/reload') {
      if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'GET 或 POST' });
      return send(200, await reload());
    }
    if (u.pathname.startsWith('/api/') && !state) return send(503, { error: 'loading' });
    if (['/api/tree-node', '/api/tree-find', '/api/families', '/api/plan'].includes(u.pathname)) {
      if (req.method !== 'GET') return send(405, { error: 'GET' });
      const result = await treeApi(u);
      return send(
        result?.computing && u.pathname === '/api/families' && !u.searchParams.has('summary')
          ? 202
          : result
            ? 200
            : 404,
        result || { error: '不存在' },
      );
    }
    if (u.pathname === '/api/tree') {
      const s = state,
        index = await treeIndex(s),
        { nodeCaps } = await import('../dsh-plugin/lib/tree/caps.mjs');
      const view = graphView(u, true, s);
      for (const n of view.nodes) {
        const t = nodeCaps(index, n.id)?.totals;
        n.badges = Object.fromEntries(['ui', 'tools', 'unique', 'missing'].map((k) => [k, t?.[k] || 0]));
      }
      return send(200, view);
    }
    if (u.pathname === '/api/children') {
      const result = childrenPage(u);
      return send(result ? 200 : 404, result || { error: '节点不存在' });
    }
    if (u.pathname === '/api/graph') return send(200, graphView(u));
    if (u.pathname === '/api/search') {
      if (u.searchParams.has('node')) {
        const result = relations(u.searchParams.get('node'), u.searchParams.get('rel') || 'all');
        return send(result ? 200 : 404, result || { error: '节点不存在' });
      }
      return send(200, await search(u));
    }
    if (u.pathname.startsWith('/api/node/')) {
      const id = decodeURIComponent(u.pathname.slice(10)),
        s = state,
        node = s.nm.get(id);
      if (!node) return send(404, { error: '节点不存在' });
      const plugin = pluginFor(s, node),
        ancestors = [],
        seen = new Set([id]);
      let parent = s.nm.get(node.parent);
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        ancestors.unshift(parent);
        parent = s.nm.get(parent.parent);
      }
      if (u.searchParams.get('lite') === '1') {
        const compact = (n) => {
          const { plugin_ids, plugin_ids_count, ...rest } = n;
          return rest;
        };
        const cap = (c) => (c ? { ...c, union: arr(c.union).slice(0, 20) } : null);
        return send(200, {
          node: compact(node),
          plugin: plugin || null,
          ancestors: ancestors.map(compact),
          children_total: (s.children.get(id) || []).length,
          capabilities: cap(s.caps.get(category(s, node))),
          branch_capabilities: cap(s.branchCaps.get(ancestor(s, node, 'branch'))),
        });
      }
      return send(200, {
        node: apiNode(s, node),
        plugin: plugin || null,
        readme_markdown: plugin?.readme_path ? readmeDetail(plugin.readme_path, s.dir) : '',
        ancestors: ancestors.map((n) => apiNode(s, n)),
        children: (s.children.get(id) || []).slice(0, 500).map((n) => apiNode(s, n)),
        children_total: (s.children.get(id) || []).length,
        edges: relations(id, 'all', s).edges,
        capabilities: s.caps.get(category(s, node)) || null,
        branch_capabilities: s.branchCaps.get(ancestor(s, node, 'branch')) || null,
      });
    }
    if (u.pathname.startsWith('/api/')) return send(404, { error: '未知接口' });
    const name = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname).replace(/^\//, '');
    const target = confined(path.join(WEB, 'public'), name);
    if (!target) return send(403, { error: '禁止访问' });
    const bytes = await fs.promises.readFile(target);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(target)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(bytes);
  } catch (e) {
    send(e.code === 'ENOENT' ? 404 : 400, { error: e.message });
  }
});
if (!isMainThread && workerData?.familyWorker)
  computeFamilies(workerData)
    .then((result) => parentPort.postMessage(result))
    .catch((e) => {
      throw e;
    });
if (isMainThread && process.env.ATLAS_INTERNAL_TEST !== '1')
  server.listen(Number(process.env.PORT ?? 4380), '0.0.0.0', () => {
    console.log('Plugin Atlas listening', server.address(), status());
    void reload().catch((e) => console.error(e));
    void initModel();
  });

export { reload, status, search, readmeDetail, treeApi, server };
