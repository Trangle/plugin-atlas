import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'atlas-fake-llm';
export const inject = ['llm'];

export class FakeAdapter extends LlmAdapter {
  async listModels(provider) {
    return [{ provider, id: 'fake-1', name: 'Atlas Fake 1', inputModalities: ['text'] }];
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model === 'fake-1' ? 'Atlas Fake 1' : model,
      inputModalities: ['text'], context: { contextWindow: 128000 }, defaultMaxTokens: 8192 };
  }

  async *stream(options) {
    const aborted = () => ({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } });
    if (options.signal?.aborted) { yield aborted(); return; }
    const user = [...options.messages].reverse().find((message) => message.role === 'user');
    const input = (user?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    const marker = input.indexOf('INPUT_JSON:');
    let text = '这是 atlas-fake 本地假模型，不会调用真实模型。';
    if (marker !== -1) {
      const { categories, items } = JSON.parse(input.slice(marker + 'INPUT_JSON:'.length));
      const category = categories[0];
      text = JSON.stringify(items.map((item) => ({
        id: item.id, summary: [...`【fake】${item.name ?? ''}`].slice(0, 80).join(''),
        capabilities: ['能力一', '能力二', '能力三'], category_id: category.id,
        branch_id: category.branches?.[0] ?? null,
      })));
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    if (options.signal?.aborted) { yield aborted(); return; }
    yield { type: 'text-delta', index: 0, text };
    if (options.signal?.aborted) { yield aborted(); return; }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    if (options.signal?.aborted) { yield aborted(); return; }
    const inputTokens = Math.ceil(input.length / 4), outputTokens = Math.ceil(text.length / 4);
    yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
    if (options.signal?.aborted) { yield aborted(); return; }
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx) {
  const adapter = new FakeAdapter();
  ctx.effect(() => ctx.llm.registerAdapter(['atlas-fake'], adapter));
}
