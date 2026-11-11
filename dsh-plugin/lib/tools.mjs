import { formatResult } from './format.mjs';
import { atlasNode, atlasStatus, atlasOpenInfo } from './atlas-client.mjs';
import { getPipeline } from './pipeline/index.mjs';
import { createCommandSpecs } from './commands.mjs';
const output = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true, description: '操作结果' } },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};
const field = (type, description, required = false) => ({ type, description, ...(required ? { required: true } : {}) });
/** 处理对应的图谱操作。 */
function createToolSpecs(config = {}) {
  const p = getPipeline(config);
  const common = {
    apply: field('boolean', '明确允许写数据'),
    dry_run: field('boolean', '只预览'),
    limit: field('integer', '处理数量上限'),
    ids: field('string', '逗号分隔的 ID'),
    backend: field('string', 'mock 或 llm'),
    budget: field('integer', '预算上限'),
    concurrency: field('integer', '并发上限'),
    resume: field('string', '恢复运行 ID'),
    offline: field('boolean', '离线'),
    skip_github: field('boolean', '跳过 GitHub'),
    include_filtered: field('boolean', '包含已过滤或合并的条目'),
    force: field('boolean', '强制提取'),
    all: field('boolean', '合并全部条目'),
  };
  const wrap = (name, description, parameters, fn) => ({
    name: `plugin_atlas_${name}`,
    description,
    parameters,
    output,
    async execute(args, exec = {}) {
      try {
        const r = await fn(args, exec.signal, exec);
        return { text: formatResult(r, name) };
      } catch (e) {
        return { text: `操作失败：${e.message}` };
      }
    },
  });
  const opts = (a, signal, summarize = false) => ({
    ...a,
    ids: a.ids?.split(','),
    skipGithub: a.skip_github,
    includeFiltered: a.include_filtered,
    dryRun: summarize ? !!a.dry_run : !!a.dry_run || !a.apply,
    signal,
  });
  return [
    wrap(
      'search',
      '搜索插件',
      {
        q: field('string', '关键词', true),
        limit: common.limit,
        mode: field('string', '搜索模式'),
        include_github_only: field('boolean', '包含仅 GitHub 插件'),
      },
      (a, signal) => p.search(a.q, { ...a, includeGithubOnly: a.include_github_only, signal }),
    ),
    wrap('node', '查看插件详情', { id: field('string', 'ID', true) }, (a, s) => atlasNode(a.id, config, s)),
    wrap('status', '查看服务状态', {}, async (_, s) => {
      const r = await atlasStatus(config, s);
      return {
        text: r.ok
          ? r.text
          : `${r.text}
${atlasOpenInfo(config)}`,
      };
    }),
    ...['update', 'refresh', 'summarize', 'merge'].map((n) =>
      wrap(n, `${n} 插件图谱`, common, (a, s, exec) =>
        p[n]({
          ...opts(a, s, n === 'summarize'),
          onProgress:
            typeof exec.progress === 'function'
              ? exec.progress.bind(exec)
              : typeof exec.onUpdate === 'function'
                ? exec.onUpdate.bind(exec)
                : void 0,
        }),
      ),
    ),
    wrap('pipeline_status', '查看流水线进度和预算', {}, () => p.status()),
    wrap(
      'compare',
      '比较同分支插件',
      { ids: common.ids, branch_id: field('string', '分支 ID'), limit: common.limit },
      (a) => p.compare({ ids: a.ids?.split(','), branchId: a.branch_id, limit: a.limit }),
    ),
    wrap('service', '管理服务', { action: field('string', 'start、stop、reload、status', true) }, (a) => {
      if (!['start', 'stop', 'reload', 'status'].includes(a.action)) throw new Error('无效服务操作');
      return p.service[a.action]();
    }),
  ];
}
export { createCommandSpecs, createToolSpecs };
