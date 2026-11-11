import { atlasSearch, atlasNode, atlasStatus, atlasOpenInfo } from './atlas-client.mjs';

const output = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true, description: 'Readable result and compact JSON when available' } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

export function createToolSpecs(cfg = {}) {
  return [
    {
      name: 'plugin_atlas_search', description: 'Search the DeepSeek Harness plugin ecosystem capability map using the local Plugin Atlas service. 搜索本机 Plugin Atlas 的 DeepSeek Harness 插件生态能力图谱。',
      parameters: {
        q: { type: 'string', required: true, description: '搜索关键词' },
        limit: { type: 'integer', description: '结果数量' },
        mode: { type: 'string', description: 'hybrid、fulltext 或 semantic' },
        include_github_only: { type: 'boolean', description: '包含仅有 GitHub 来源的插件' },
      }, output,
      async execute(args, exec = {}) { const result = await atlasSearch({ q: args.q, limit: args.limit, mode: args.mode, includeGithubOnly: args.include_github_only }, cfg, exec.signal); return { text: result.text }; },
    },
    {
      name: 'plugin_atlas_node', description: 'Get a plugin from the DeepSeek Harness ecosystem capability map via local Plugin Atlas. 查看本机 Plugin Atlas 插件详情。',
      parameters: { id: { type: 'string', required: true, description: '插件或节点 ID' } }, output,
      async execute(args, exec = {}) { const result = await atlasNode(args.id, cfg, exec.signal); return { text: result.text }; },
    },
    {
      name: 'plugin_atlas_status', description: 'Check the local Plugin Atlas DeepSeek Harness ecosystem capability map service and open its website. 查看本机服务状态及网页地址。',
      parameters: {}, output,
      async execute(_args, exec = {}) { const result = await atlasStatus(cfg, exec.signal); return { text: result.ok ? result.text : `${result.text}\n${atlasOpenInfo(cfg)}` }; },
    },
  ];
}

export function createCommandSpecs(cfg = {}) {
  return [
    { name: 'atlas', description: '搜索 Plugin Atlas 插件生态能力图谱', input: { hint: '<关键词>' },
      async handler({ rawInput }) {
        try {
          const q = String(rawInput ?? '').trim();
          if (!q) return { kind: 'error', text: '请输入搜索关键词，例如 /atlas memory' };
          const result = await atlasSearch({ q }, cfg);
          return { kind: result.ok ? 'success' : 'error', text: result.text };
        } catch (error) { return { kind: 'error', text: `搜索失败：${error.message}` }; }
      } },
    { name: 'atlas-open', description: '显示 Plugin Atlas 网页地址与启动方法',
      async handler() { try { return { kind: 'success', text: atlasOpenInfo(cfg) }; } catch (error) { return { kind: 'error', text: `获取网页地址失败：${error.message}` }; } } },
  ];
}
