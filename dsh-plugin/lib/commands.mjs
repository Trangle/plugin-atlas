import { formatResult } from './format.mjs';
import { atlasOpenInfo } from './atlas-client.mjs';
import { getPipeline } from './pipeline/index.mjs';
function parseCommand(raw) {
  const words =
    String(raw || '')
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((x) => x.replace(/^(['"])(.*)\1$/, '$2')) || [];
  const known = ['update', 'refresh', 'summarize', 'merge', 'status', 'compare', 'service', 'search'];
  const sub = known.includes(words[0]) ? words.shift() : 'search';
  const opts = {},
    positional = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('--')) {
      positional.push(w);
      continue;
    }
    const key = w.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (['limit', 'ids', 'backend', 'budget', 'concurrency', 'resume', 'branch', 'readmeLimit'].includes(key)) {
      if (!words[i + 1] || words[i + 1].startsWith('--')) throw new Error(`${w} 需要参数`);
      opts[key] = words[++i];
    } else if (['apply', 'dryRun', 'offline', 'skipGithub', 'incremental', 'force', 'all', 'includeFiltered'].includes(key))
      opts[key] = true;
    else throw new Error(`未知参数：${w}`);
  }
  if (opts.ids) opts.ids = opts.ids.split(',');
  opts.dryRun = opts.dryRun || !opts.apply;
  if (sub === 'summarize') opts.dryRun = !!opts.dryRun && !opts.apply;
  return { sub, opts, positional };
}
async function dispatch(p, raw, signal) {
  const { sub, opts, positional } = parseCommand(raw);
  opts.signal = signal;
  if (sub === 'summarize' && !String(raw).includes('--dry-run')) opts.dryRun = false;
  switch (sub) {
    case 'search':
      if (!positional.length) throw new Error('请输入搜索关键词');
      return p.search(positional.join(' '), opts);
    case 'compare':
      return p.compare({ ids: positional, branchId: opts.branch, limit: Number(opts.limit) || 10 });
    case 'status':
      return p.status();
    case 'service':
      if (!['start', 'stop', 'reload', 'status'].includes(positional[0]))
        throw new Error('服务操作应为 start、stop、reload 或 status');
      return p.service[positional[0]]();
    default:
      return p[sub](opts);
  }
}
/** 处理对应的图谱操作。 */
function createCommandSpecs(config = {}) {
  const p = getPipeline(config);
  return [
    {
      name: 'atlas',
      description: '搜索和维护 Plugin Atlas',
      input: { hint: '<子命令或关键词>' },
      async handler({ rawInput }) {
        try {
          const result = await dispatch(p, rawInput);
          return {
            kind: result.status === 'stopped' || result.ok === false ? 'error' : 'success',
            text: formatResult(result, parseCommand(rawInput).sub),
          };
        } catch (e) {
          return { kind: 'error', text: `操作失败：${e.message}` };
        }
      },
    },
    {
      name: 'atlas-open',
      description: '显示 Plugin Atlas 网页地址',
      async handler() {
        return { kind: 'success', text: atlasOpenInfo(config) };
      },
    },
  ];
}
export { createCommandSpecs, dispatch, parseCommand };
