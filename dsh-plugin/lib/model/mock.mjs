function createMockBackend() {
  return {
    name: 'mock',
    available: () => true,
    async complete({ prompt }) {
      const data = JSON.parse(prompt.split('\nINPUT_JSON:')[1]);
      const category = data.categories?.[0];
      const result =
        data.task === 'plan'
          ? {
              summary: `融合 ${data.draft.family} 的插件能力`,
              base: data.draft.base,
              absorb: data.draft.absorb,
              conflicts: data.draft.conflicts,
              steps: data.draft.steps,
            }
          : data.items.map((p) => ({
              id: p.id,
              summary: `提供${p.name || p.id}相关功能`.slice(0, 80),
              capabilities: ['插件集成', '功能调用', '任务支持'],
              category_id: category.id,
              branch_id: category.branches[0] || null,
            }));
      const text = JSON.stringify(result);
      const inputTokens = Math.ceil(prompt.length / 4),
        outputTokens = Math.ceil(text.length / 4);
      return {
        text,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        model: 'mock',
        provider: 'mock',
      };
    },
  };
}
export { createMockBackend };
