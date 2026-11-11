import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig } from '../config.mjs';
import { json } from '../io.mjs';
import { collect } from './collect.mjs';
import { extract } from './extract.mjs';
import { merge } from './update.mjs';
import { search } from './recall.mjs';
import { compare } from './compare.mjs';
import { status } from './status.mjs';
import { service } from './service.mjs';
const cache = new Map();
/** 处理对应的图谱操作。 */
function getPipeline(config = {}) {
  const cfg = resolveConfig(config);
  const key = `${cfg.root}\0${cfg.dataDir}\0${cfg.stateDir}`;
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
  const runMerge = (o) => stage('merge', () => merge(cfg, o));
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
    status: () => status(cfg),
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
