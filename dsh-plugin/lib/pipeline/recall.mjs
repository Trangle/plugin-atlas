import path from 'node:path';
import { atlasSearch } from '../atlas-client.mjs';
import { readLines } from '../io.mjs';
/** 处理对应的图谱操作。 */
async function search(cfg, q, opts = {}) {
  const remote = await atlasSearch({ q, ...opts }, cfg, opts.signal);
  if (remote.ok) return { ...remote, source: 'service' };
  if (opts.signal?.aborted) throw opts.signal.reason;
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const results = (await readLines(path.join(cfg.dataDir, 'plugins.jsonl')))
    .filter((p) => opts.includeGithubOnly || !p.github_only)
    .map((p) => {
      const s = [p.name, p.summary, p.description, ...(p.capabilities || [])].join(' ').toLowerCase();
      return { ...p, score: words.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0) };
    })
    .filter((p) => p.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit || 8);
  return {
    ok: true,
    source: 'local',
    data: { results },
    text: `本地全文找到 ${results.length} 个插件：
${results.map((p) => `${p.id}：${p.summary || p.description || p.name}`).join('\n')}`,
  };
}
export { search };
