import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchJson } from '../atlas-client.mjs';
const exec = promisify(execFile);
/** 处理对应的图谱操作。 */
function service(cfg) {
  async function log(action2, result) {
    await fs.mkdir(cfg.logsDir, { recursive: true });
    await fs.appendFile(
      path.join(cfg.logsDir, 'atlas-plugin-service.log'),
      JSON.stringify({ at: new Date().toISOString(), action: action2, ...result }) + '\n',
    );
  }
  async function status() {
    try {
      const data = await fetchJson(cfg.baseUrl, '/api/status', { timeoutMs: cfg.timeoutMs || 1500 });
      await log('status', { ok: true });
      return { ok: true, ...data };
    } catch (e) {
      await log('status', { ok: false, error: e.message });
      return { ok: false, error: e.message };
    }
  }
  async function action(name) {
    try {
      let result;
      if (name === 'reload') {
        const r = await fetch(`${cfg.baseUrl}/api/reload`, {
          method: 'POST',
          signal: AbortSignal.timeout(cfg.timeoutMs || 15e3),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        result = await r.text();
      } else {
        if (name === 'start' && (await status()).ok) {
          await log(name, { ok: true, alreadyRunning: true });
          return { ok: true, text: '服务已在运行' };
        }
        const url = new URL(cfg.baseUrl);
        result = (
          await exec('bash', [path.join(cfg.root, 'web', `${name}.sh`)], {
            cwd: cfg.root,
            env: { ...process.env, ATLAS_DATA_DIR: cfg.dataDir, ATLAS_LOG_DIR: cfg.logsDir, PORT: url.port || '4380' },
          })
        ).stdout;
      }
      if (name === 'start') {
        const deadline = Date.now() + 1e4;
        do {
          const state = await status();
          if (state.ok) {
            await log(name, { ok: true, loading: state.loading });
            return {
              ok: true,
              text: `服务已启动
- 状态：${state.loading ? '加载中' : '运行'}
- 插件数：${state.counts?.plugins ?? '未知'}
- 语义后端：${state.semantic_backend ?? '未知'}`,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        } while (Date.now() < deadline);
        throw new Error('服务启动后 10 秒内未响应');
      }
      await log(name, { ok: true });
      return { ok: true, text: `服务${name === 'stop' ? '已停止' : '已重载'}` };
    } catch (e) {
      await log(name, { ok: false, error: e.message });
      return { ok: false, error: e.message };
    }
  }
  return {
    status,
    start: () => action('start'),
    stop: () => action('stop'),
    reload: () => action('reload'),
    ensure: async () => (cfg.autoStartService ? action('start') : status()),
  };
}
export { service };
