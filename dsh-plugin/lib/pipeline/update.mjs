import fs from 'node:fs/promises';
import path from 'node:path';
import { readLines, readJson, json, lines, stamp } from '../io.mjs';
import { runScript } from './collect.mjs';
import { service } from './service.mjs';
/** 处理对应的图谱操作。 */
async function merge(cfg, opts = {}) {
  const mergedFile = path.join(cfg.stateDir, 'merged.json');
  const merged = await readJson(mergedFile, {});
  const overlay = (await readLines(path.join(cfg.stateDir, 'overlay.jsonl'))).filter(
    (x) => (!opts.ids || opts.ids.includes(x.id)) && (opts.all || !x.fingerprint || merged[x.id] !== x.fingerprint),
  );
  if (opts.dryRun !== false)
    return {
      status: 'dry-run',
      count: overlay.length,
      ids: overlay.slice(0, 20).map((x) => x.id),
      plan: ['备份', '合并', '去重', '相关性', '刷新能力', '重载服务'],
    };
  const target = path.join(cfg.dataDir, 'plugins.jsonl');
  const records = await readLines(target);
  const base = new Map((await readLines(path.join(cfg.dataDir, 'plugins_base.jsonl'))).map((x) => [x.id, x]));
  const map = new Map(records.map((x) => [x.id, x]));
  const updated = overlay.filter((x) => map.has(x.id)).length;
  const added = overlay.length - updated;
  for (const x of overlay) map.set(x.id, { ...(map.get(x.id) || base.get(x.id) || { id: x.id }), ...x });
  const id = stamp(),
    backup = path.join(cfg.stateDir, 'backups', id);
  await fs.mkdir(backup, { recursive: true });
  await fs.copyFile(target, path.join(backup, 'plugins.jsonl')).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  await lines(target, [...map.values()]);
  for (const x of overlay) if (x.fingerprint) merged[x.id] = x.fingerprint;
  await json(mergedFile, merged);
  const log = path.join(cfg.logsDir, `atlas-plugin-update-${id}.log`);
  const steps = [];
  if (!opts.skipScripts)
    for (const script of ['dedup.mjs', 'relevance.mjs', 'refresh-capabilities.mjs'])
      steps.push(await (opts.runner || runScript)(cfg, script, [], log, opts.signal));
  let reload = null;
  if (!opts.skipScripts) {
    const svc = opts.service || service(cfg);
    reload = (await svc.status()).ok ? await svc.reload() : { ok: true, text: '服务未运行，跳过 reload' };
  }
  return { status: 'completed', count: overlay.length, updated, added, backup, backupRelative: path.relative(cfg.root, backup), steps, reload };
}
export { merge };
