import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { resolveConfig } from '../config.mjs';
import { json, readJson, readLines } from '../io.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readReadme, readmeHash } from '../readme-store.mjs';
import { renderTree, locate } from '../tree/view.mjs';
import { listFamilies, representatives } from '../tree/families.mjs';
import { planTreeSync, savePatch, applyTreePatch, rollbackTree, treeHistory } from '../tree/fusion.mjs';
import { loadIndex, listPlans, markStale, plan, refreshStalePlans } from './plan.mjs';
import { collect } from './collect.mjs';
import { extract } from './extract.mjs';
import { merge } from './update.mjs';
import { search } from './recall.mjs';
import { compare } from './compare.mjs';
import { status } from './status.mjs';
import { service } from './service.mjs';

/** 仅把带 crawler/ 与 web/ 的仓库 data/ 视为生产数据，避免插件安装到 node_modules 后守卫失效。 */
function productionDataDirs(cfg) {
  const dirs = [];
  const consider = (root) => {
    if (!root) return;
    if (fsSync.existsSync(path.join(root, 'crawler')) && fsSync.existsSync(path.join(root, 'web'))) {
      dirs.push(path.resolve(root, 'data'));
    }
  };
  consider(cfg.root);
  consider(process.env.PLUGIN_ATLAS_ROOT);
  consider(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
  return [...new Set(dirs)];
}
const cache = new Map();
/** 处理对应的图谱操作。 */
function getPipeline(config = {}) {
  const cfg = resolveConfig(config);
  const key = JSON.stringify(cfg, (_key, value) => (typeof value === 'function' ? undefined : value));
  if (cache.has(key)) return cache.get(key);
  const services = {};
  let busy = false;
  async function locked(fn) {
    if (busy) throw new Error('已有流水线正在运行');
    busy = true;
    let handle;
    let staleLock = false;
    const lock = path.join(cfg.stateDir, 'lock');
    try {
      await fs.mkdir(cfg.stateDir, { recursive: true });
      for (;;) {
        try {
          handle = await fs.open(lock, 'wx');
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let stale = false;
          try {
            const stat = await fs.stat(lock);
            const info = JSON.parse(await fs.readFile(lock, 'utf8'));
            const age = Date.now() - (Date.parse(info.at) || stat.mtimeMs);
            let alive = Number.isInteger(info.pid) && info.pid > 0;
            if (alive) {
              try {
                process.kill(info.pid, 0);
              } catch (e) {
                alive = e.code !== 'ESRCH';
              }
            }
            stale = !alive || age > 6 * 60 * 60 * 1e3;
          } catch (e) {
            if (e.code === 'ENOENT') continue;
            const stat = await fs.stat(lock).catch(() => null);
            stale = !!stat && Date.now() - stat.mtimeMs > 6 * 60 * 60 * 1e3;
          }
          if (!stale) throw new Error('已有流水线正在运行');
          await fs.unlink(lock).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
          staleLock = true;
        }
      }
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      const result = await fn();
      if (staleLock) result.staleLockCleared = true;
      return result;
    } finally {
      if (handle) {
        await handle.close();
        await fs.unlink(lock).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
      busy = false;
    }
  }
  async function stage(name, fn) {
    try {
      const result = await fn();
      await json(path.join(cfg.stateDir, 'runs', `${name}.json`), { at: new Date().toISOString(), result });
      return result;
    } catch (error) {
      await json(path.join(cfg.stateDir, 'runs', `${name}.json`), {
        at: new Date().toISOString(),
        result: { status: 'failed', error: error.message },
      });
      throw error;
    }
  }
  const runCollect = (o) => stage('collect', () => collect(cfg, o));
  const runExtract = (o) => stage('summarize', () => extract(cfg, o, services));
  let treeCache;
  async function index() {
    const stats = await Promise.all(
      ['graph.json', 'plugins.jsonl'].map((name) =>
        fs
          .stat(path.join(cfg.dataDir, name))
          .then((s) => `${s.mtimeMs}:${s.size}`)
          .catch((e) => {
            if (e.code === 'ENOENT') return 'missing';
            throw e;
          }),
      ),
    );
    const key = stats.join('|');
    if (!treeCache || treeCache.key !== key) treeCache = { key, index: await loadIndex(cfg) };
    return treeCache.index;
  }
  async function markKnownStale(familyIds, idx) {
    const plans = await listPlans(cfg, idx);
    const marked = await readJson(path.join(cfg.stateDir, 'plans', '_stale.json'), []);
    const known = new Set([
      ...plans.map((p) => p.family),
      ...(Array.isArray(marked) ? marked : Object.keys(marked).filter((id) => marked[id])),
    ]);
    const selected = [...familyIds].filter((id) => known.has(id));
    if (selected.length) await markStale(cfg, selected);
  }
  async function affectedFamilies(ids, ...indexes) {
    const result = new Set();
    for (const idx of indexes)
      for (const family of listFamilies(idx)) if (family.members.some((id) => ids.has(id))) result.add(family.id);
    if (result.size) await markKnownStale(result, indexes[0]);
  }
  const runMerge = (o = {}) =>
    stage('merge', async () => {
      if (o.dryRun !== false) return merge(cfg, o);
      const before = await index();
      const overlay = await readLines(path.join(cfg.stateDir, 'overlay.jsonl'));
      const merged = await readJson(path.join(cfg.stateDir, 'merged.json'), {});
      const ids = new Set(
        overlay
          .filter(
            (x) => (!o.ids || o.ids.includes(x.id)) && (o.all || !x.fingerprint || merged[x.id] !== x.fingerprint),
          )
          .map((x) => x.id),
      );
      const result = await merge(cfg, o);
      treeCache = null;
      await affectedFamilies(ids, before, await index());
      return result;
    });
  async function sync(o = {}) {
    const idx = await index();
    const graph = await readJson(path.join(cfg.dataDir, 'graph.json'), {});
    const plugins = await readLines(path.join(cfg.dataDir, 'plugins.jsonl'));
    const patch = planTreeSync({
      graph,
      plugins,
      capabilities: idx.capabilities,
      dedupMerged: await readLines(path.join(cfg.dataDir, 'dedup-merged.jsonl')),
      filteredOut: await readLines(path.join(cfg.dataDir, 'filtered-out.jsonl')),
      previousFingerprints: await readJson(path.join(cfg.stateDir, 'tree', 'fingerprints.json'), {}),
      readmeHash: (p) => {
        const stored = readmeHash(cfg.dataDir, p.readme_path);
        if (stored) return stored;
        const text = readReadme(cfg.dataDir, p.readme_path);
        return text ? createHash('sha256').update(text).digest('hex') : null;
      },
      limit: o.limit == null ? undefined : Number(o.limit),
    });
    const file = await savePatch(cfg.stateDir, patch);
    const display = {
      plugins: Object.fromEntries([...idx.plugins].map(([id, p]) => [id, p.name || id])),
      branches: Object.fromEntries([...idx.nodes].map(([id, n]) => [id, n.label || id])),
    };
    if (o.markPlansStale)
      await affectedFamilies(
        new Set([...patch.changed.added, ...patch.changed.updated, ...patch.changed.removed]),
        idx,
      );
    if (!o.apply || o.dryRun) return { status: 'dry-run', patch, file, display };
    const applied = await applyTreePatch({
      dataDir: cfg.dataDir,
      stateDir: cfg.stateDir,
      patch,
      allowProduction: o.allowProduction,
      productionDataDir: productionDataDirs(cfg),
    });
    const ids = new Set(
      Object.values(patch.ops).flatMap((ops) =>
        ops.flatMap((x) => [x.id, x.upstream, x.keep, ...(x.forks || []), ...(x.duplicates || [])]).filter(Boolean),
      ),
    );
    treeCache = null;
    await affectedFamilies(ids, idx, await index());
    const reload = await (services.service || api.service).reload();
    return { status: 'completed', patch, file, display, applied, reload };
  }
  const api = {
    cfg,
    services,
    setServices(s) {
      Object.assign(services, s);
    },
    collect: (o) => locked(() => runCollect(o)),
    summarize: (o) => locked(() => runExtract(o)),
    merge: (o) => locked(() => runMerge(o)),
    search: (q, o) => search(cfg, q, o),
    compare: (o) => compare(cfg, o),
    status: async () => {
      const result = await status(cfg),
        plans = await listPlans(cfg, await index());
      const dir = path.join(cfg.stateDir, 'tree');
      const files = (
        await fs.readdir(dir).catch((e) => {
          if (e.code === 'ENOENT') return [];
          throw e;
        })
      )
        .filter((x) => /^patch-.*\.json$/.test(x))
        .sort();
      const patch = files.length ? await readJson(path.join(dir, files.at(-1)), {}) : {};
      const history = await treeHistory(cfg.stateDir);
      return {
        ...result,
        planCount: plans.length,
        stalePlanCount: plans.filter((p) => p.stale).length,
        pendingTreeOps: Object.values(patch.ops || {}).reduce((n, ops) => n + ops.length, 0),
        lastTreeAction: history.at(-1) || null,
      };
    },
    tree: async (o = {}) => {
      const idx = await index(),
        matches = o.node ? locate(idx, o.node) : [];
      const root = idx.nodes.has(o.node) ? o.node : matches[0]?.id;
      if (o.node && !root) return { text: `未找到节点：${o.node}` };
      const prefix =
        o.node && !idx.nodes.has(o.node) ? `路径：${matches[0].path.map((x) => x.label).join(' / ')}\n` : '';
      return { text: prefix + renderTree(idx, { root, depth: o.depth == null ? 2 : Number(o.depth), caps: o.caps }) };
    },
    treeFind: async (q) => ({ matches: locate(await index(), q) }),
    treeSync: (o) => locked(() => sync(o)),
    treeRollback: (o = {}) =>
      locked(async () => {
        const before = await index(),
          result = await rollbackTree({ dataDir: cfg.dataDir, stateDir: cfg.stateDir, stamp: o.stamp });
        treeCache = null;
        const after = await index();
        await markKnownStale(new Set([...listFamilies(before), ...listFamilies(after)].map((f) => f.id)), before);
        return { status: 'completed', rollback: result, reload: await (services.service || api.service).reload() };
      }),
    treeHistory: async () => ({ history: await treeHistory(cfg.stateDir) }),
    families: async (o = {}) => {
      const idx = await index(),
        plans = await listPlans(cfg, idx),
        byId = new Map(plans.map((p) => [p.family, p]));
      const marked = await readJson(path.join(cfg.stateDir, 'plans', '_stale.json'), []);
      const staleIds = new Set(Array.isArray(marked) ? marked : Object.keys(marked).filter((id) => marked[id]));
      const numberOption = (value, fallback, name) => {
        if (value == null) return fallback;
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} 需要非负整数`);
        return n;
      };
      const limit = numberOption(o.limit, 30, '--limit'),
        offset = numberOption(o.offset, 0, '--offset');
      let families = listFamilies(idx, o).map((f) => ({
        ...f,
        planStatus: byId.has(f.id) ? (byId.get(f.id).stale ? '过期' : '最新') : staleIds.has(f.id) ? '待生成' : '无',
      }));
      if (o.stale) families = families.filter((f) => f.planStatus === '过期' || f.planStatus === '待生成');
      const familyTotal = families.length;
      families = families
        .slice(offset, offset + limit)
        .map((f) => ({
          ...f,
          representatives: representatives(idx, f).map((r) => ({ ...r, name: idx.plugins.get(r.id)?.name })),
        }));
      return { families, familyTotal };
    },
    plan: (o = {}) =>
      locked(async () =>
        plan(cfg, { ...o, family: o.id, dryRun: o.dryRun !== false }, { ...services, index: await index() }),
      ),
    plansRefresh: (o = {}) =>
      locked(async () =>
        refreshStalePlans(cfg, { ...o, dryRun: o.dryRun !== false }, { ...services, index: await index() }),
      ),
    service: service(cfg),
    update: (o) => locked(async () => ({ collect: await runCollect(o), merge: await runMerge(o) })),
    refresh: (o) =>
      locked(async () => {
        const c = await runCollect(o);
        const e = await runExtract(o);
        if (e.status === 'stopped' || e.status === 'partial') return { collect: c, extract: e, status: e.status };
        return { collect: c, extract: e, merge: await runMerge(o) };
      }),
  };
  cache.set(key, api);
  return api;
}
export { getPipeline };
