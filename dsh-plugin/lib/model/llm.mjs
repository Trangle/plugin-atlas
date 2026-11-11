function createLlmBackend(services = {}) {
  return {
    name: 'llm',
    available: () => !!(services.llm && services.agentDefaultModel),
    async complete({ system, prompt, maxTokens, signal }) {
      if (!this.available()) throw new Error('llm 或 agentDefaultModel 服务不可用');
      const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm');
      const selection = await services.agentDefaultModel.currentSelection();
      const call = await services.llm.prepareCall(
        { provider: selection.provider, model: selection.model, maxTokens },
        signal,
      );
      const assembler = new BlockAssembler();
      for await (const chunk of call.stream({
        ...call.config,
        messages: [
          createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'dsh-plugin-atlas' } }),
        ],
        system,
        signal,
      }))
        assembler.push(chunk);
      if (['error', 'aborted'].includes(assembler.finish?.kind)) {
        const f = assembler.finish.failure || {};
        const e = new Error(f.message || assembler.finish.kind);
        e.code = f.code || assembler.finish.kind;
        throw e;
      }
      const u = assembler.usage || {};
      return {
        text: assembler
          .blocks()
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join(''),
        usage: {
          inputTokens: u.inputTokens || 0,
          outputTokens: u.outputTokens || 0,
          totalTokens: u.totalTokens ?? (u.inputTokens || 0) + (u.outputTokens || 0),
        },
        model: selection.model,
        provider: selection.provider,
      };
    },
  };
}
export { createLlmBackend };
