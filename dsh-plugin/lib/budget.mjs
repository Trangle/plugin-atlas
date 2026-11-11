import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, json } from './io.mjs';
class BudgetExceeded extends Error {
  constructor() {
    super('token 预算已用尽');
    this.name = 'BudgetExceeded';
    this.code = 'BUDGET_EXCEEDED';
  }
}
class Budget {
  constructor(cfg, limit = cfg.runBudgetTokens) {
    this.cfg = cfg;
    this.limit = Number(limit) || cfg.runBudgetTokens;
    this.runUsed = 0;
    this.pending = 0;
    this.queue = Promise.resolve();
  }
  async init() {
    this.used = await readJson(path.join(this.cfg.stateDir, 'budget.json'), {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    this.used.mock ||= { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return this;
  }
  reserve(n) {
    if (
      this.runUsed + this.pending + n > this.limit ||
      this.used.totalTokens + this.pending + n > this.cfg.budgetTokens
    )
      throw new BudgetExceeded();
    this.pending += n;
  }
  release(n) {
    this.pending -= n;
  }
  async record(usage, detail = {}) {
    const inputTokens = Number(usage?.inputTokens) || 0,
      outputTokens = Number(usage?.outputTokens) || 0,
      totalTokens = Number(usage?.totalTokens ?? inputTokens + outputTokens);
    this.queue = this.queue.then(async () => {
      const target = detail.backend === 'mock' ? this.used.mock : this.used;
      target.inputTokens += inputTokens;
      target.outputTokens += outputTokens;
      target.totalTokens += totalTokens;
      if (detail.backend !== 'mock') this.runUsed += totalTokens;
      await json(path.join(this.cfg.stateDir, 'budget.json'), this.used);
      await fs.appendFile(
        path.join(this.cfg.stateDir, 'usage.jsonl'),
        JSON.stringify({ ...detail, inputTokens, outputTokens, totalTokens, at: new Date().toISOString() }) + '\n',
      );
    });
    return this.queue;
  }
}
export { Budget, BudgetExceeded };
