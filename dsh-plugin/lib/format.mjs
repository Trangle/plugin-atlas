/** 处理对应的图谱操作。 */
function formatResult(result, kind = '') {
  if (result.text) return result.text;
  const lines = [`${kind || '操作'}：${result.status || (result.ok === false ? '失败' : '完成')}`];
  const add = (key, value) => lines.push(`- ${key}：${value ?? '无'}`);
  if (kind === 'service' && !result.runs) {
    add('状态', !result.ok ? '未运行' : result.loading ? '加载中' : '运行');
    add('插件数', result.counts?.plugins ?? '未知');
    add('语义后端', result.semantic_backend ?? '未知');
  }
  if (result.staleLockCleared) add('锁', '已清理陈旧锁');
  if (result.runId) {
    add('runId', result.runId);
    add('进度', `${result.done}/${result.total}`);
    add('批次 完成/失败/总数', `${result.completedBatches}/${result.failedBatches?.length || 0}/${result.batches}`);
    add(
      '本次 usage input/output/total',
      `${result.usage.inputTokens}/${result.usage.outputTokens}/${result.usage.totalTokens}`,
    );
    add('真实模型累计/上限', `${result.budget?.used ?? '未知'}/${result.budget?.limit ?? '未知'}`);
    add('mock 累计', result.budget?.mock ?? 0);
    add('本次后端', result.budget?.backend);
    add('status', result.status);
    add('stopReason', result.stopReason || '无');
  }
  if (result.service && result.runs) {
    const s = result.service;
    add(
      '服务',
      `${!s.ok ? '未运行' : s.loading ? '加载中' : '运行'}，插件数 ${s.counts?.plugins ?? '未知'}，语义后端 ${s.semantic_backend ?? '未知'}`,
    );
    for (const name of ['collect', 'summarize', 'merge']) {
      const run = result.runs[name];
      add(`最近 ${name}`, run ? `${run.at} ${run.result.status || '完成'}` : '无');
    }
    add('真实模型累计/上限', `${result.budget.totalTokens}/${result.budgetLimit}`);
    add('mock 累计', result.budget.mock?.totalTokens ?? 0);
    add('单次预算', result.runBudgetTokens);
    add('overlay 待合并', result.overlayCount);
    add('指纹条数', result.fingerprintCount);
    add('定时任务', `${result.schedule.intervalMinutes} 分钟，dry-run ${result.schedule.dryRun}`);
  }
  if (result.pairs && result.capabilities) {
    for (const pair of result.pairs)
      add(
        '同类插件',
        `${pair.ids.join(' / ')} · ${pair.similarity.toFixed(2)} · ${pair.verdict === 'different' ? 'peer' : pair.verdict}`,
      );
    for (const [branch, data] of Object.entries(result.capabilities)) {
      for (const item of data.branch?.union || data.category?.union || [])
        add(`分支能力 ${branch}`, `${item.capability} · ${item.best_impl || '无'}`);
    }
  }
  if (result.command) add('命令', result.command.join(' '));
  if (result.markets)
    for (const m of result.markets)
      add('市场', `${m.id} · ${m.fetched_at || '未知'} · ${m.records ?? '未知'}/${m.total ?? '未知'}`);
  if (result.count != null) add('数量', result.count);
  if (result.backupRelative != null) add('备份路径', result.backupRelative);
  if (result.updated != null) add('合并 更新/新增', `${result.updated}/${result.added}`);
  for (const step of result.steps || []) add(step.script, `退出码 ${step.code} · 耗时 ${step.elapsedMs} ms · stdout ${String(step.stdout || '').slice(0, 300)}`);
  if (result.reload) add('reload', result.reload.text || result.reload.error || JSON.stringify(result.reload));
  if (result.excludedFiltered != null) add('排除 relevance/去重合并', `${result.excludedFiltered}/${result.excludedDeduped}`);
  if (result.ids?.length) add('ID', result.ids.join('、'));
  if (result.changed != null)
    add('变更/处理/批次/预估 token', `${result.changed}/${result.total}/${result.batches}/${result.estimatedTokens}`);
  if (result.error) add('错误', result.error);
  for (const name of ['collect', 'extract', 'merge']) if (result[name]) lines.push(formatResult(result[name], name));
  return lines.join('\n');
}
export { formatResult };
