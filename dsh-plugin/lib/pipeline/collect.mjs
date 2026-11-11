import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, stamp } from '../io.mjs';
async function runScript(cfg, script, args, log, signal) {
  await fs.mkdir(cfg.logsDir, { recursive: true });
  const handle = await fs.open(log, 'a');
  const start = Date.now();
  try {
    let stdout = '';
    let writes = Promise.resolve();
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(cfg.root, 'crawler', script), ...args], {
        cwd: cfg.root,
        env: { ...process.env, ATLAS_ROOT: cfg.root, ATLAS_DATA_DIR: cfg.dataDir },
        stdio: ['ignore', 'pipe', handle.fd],
        signal,
      });
      child.stdout.on('data', (chunk) => { stdout += chunk; writes = writes.then(() => handle.write(chunk)); });
      child.on('error', reject);
      child.on('close', resolve);
    });
    await writes;
    await handle.write(`${script}: exit=${code} elapsed_ms=${Date.now() - start}
`);
    if (code !== 0) throw new Error(`${script} 退出码 ${code}`);
    const lastLine = stdout.trim().split(/\r?\n/).at(-1) || '';
    return { script, code, elapsedMs: Date.now() - start, stdout: lastLine.slice(0, 300) };
  } finally {
    await handle.close();
  }
}
/** 处理对应的图谱操作。 */
async function collect(cfg, opts = {}) {
  const args = [
    '--no-analyze',
    ...(opts.offline ? ['--offline'] : []),
    ...(opts.skipGithub ? ['--skip-github'] : []),
    ...(opts.readmeLimit ? ['--readme-limit', String(opts.readmeLimit)] : []),
  ];
  const command = ['node', 'crawler/update.mjs', ...args];
  if (opts.dryRun !== false) {
    const state = await readJson(path.join(cfg.dataDir, 'raw/state.json'), {});
    const report = await readJson(
      path.join(cfg.dataDir, 'crawl-report.json'),
      await readJson(path.join(cfg.dataDir, 'raw/crawl-report.json'), {}),
    );
    const markets = [...new Set([...Object.keys(state.markets || {}), ...Object.keys(report.markets || {})])].map(
      (id2) => ({
        id: id2,
        fetched_at: state.markets?.[id2]?.fetched_at || null,
        records: report.markets?.[id2]?.records ?? state.markets?.[id2]?.records ?? null,
        total:
          report.markets?.[id2]?.total ?? report.markets?.[id2]?.total_count ?? state.markets?.[id2]?.total ?? null,
      }),
    );
    return { status: 'dry-run', command, markets };
  }
  const id = stamp();
  const backup = path.join(cfg.stateDir, 'backups', id);
  await fs.mkdir(backup, { recursive: true });
  await fs
    .copyFile(path.join(cfg.dataDir, 'plugins_base.jsonl'), path.join(backup, 'plugins_base.jsonl'))
    .catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  const log = path.join(cfg.logsDir, `atlas-plugin-collect-${id}.log`);
  await runScript(cfg, 'update.mjs', args, log, opts.signal);
  return { status: 'completed', command, log };
}
export { collect, runScript };
