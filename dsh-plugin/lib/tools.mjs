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
    wrap(
      'tree',
      '查看树',
      { node: field('string', '节点或关键词'), depth: field('integer', '深度'), caps: field('boolean', '显示能力') },
      (a) => p.tree(a),
    ),
    wrap('tree_find', '查找树节点', { q: field('string', '关键词', true) }, (a) => p.treeFind(a.q)),
    wrap(
      'tree_sync',
      '预演或执行树同步',
      {
        apply: common.apply,
        dry_run: common.dry_run,
        allow_production: field('boolean', '允许生产数据'),
        limit: common.limit,
      },
      (a) => p.treeSync({ ...opts(a), allowProduction: a.allow_production }),
    ),
    wrap(
      'tree_rollback',
      '恢复树备份',
      { stamp: field('string', '备份时间戳'), apply: common.apply, dry_run: common.dry_run },
      async (a) => {
        if (!a.apply || a.dry_run) {
          const { history } = await p.treeHistory();
          const entry = a.stamp
            ? history.find((x) => x.stamp === a.stamp && !x.rollback)
            : [...history].reverse().find((x) => !x.rollback);
          return { text: entry ? `dry-run：将恢复树备份 ${entry.stamp}` : 'dry-run：找不到树备份' };
        }
        return p.treeRollback(a);
      },
    ),
    wrap(
      'families',
      '查看分叉族',
      { branch: field('string', '分支 ID'), stale: field('boolean', '只看过期计划') },
      (a) => p.families(a),
    ),
    wrap(
      'plan',
      '生成融合计划',
      {
        id: field('string', '族、分支或插件 ID', true),
        refresh: field('boolean', '刷新'),
        dry_run: common.dry_run,
        apply: common.apply,
        backend: common.backend,
        budget: common.budget,
      },
      (a) => p.plan({ ...a, dryRun: !!a.dry_run || !a.apply }),
    ),
    wrap(
      'plans_refresh',
      '刷新过期计划',
      {
        limit: common.limit,
        concurrency: common.concurrency,
        dry_run: common.dry_run,
        apply: common.apply,
        backend: common.backend,
        budget: common.budget,
        resume: common.resume,
      },
      (a) => p.plansRefresh({ ...a, dryRun: !!a.dry_run || !a.apply }),
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
