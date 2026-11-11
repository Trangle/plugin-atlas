function installScheduler(ctx, pipeline) {
  const s = pipeline.cfg.schedule;
  if (!(s.intervalMinutes > 0)) return;
  const timer = setInterval(() => {
    pipeline
      .refresh({ dryRun: s.dryRun !== false })
      .then(() => pipeline.treeSync({ dryRun: true, markPlansStale: true }))
      .catch(() => {});
  }, s.intervalMinutes * 6e4);
  timer.unref?.();
  if (ctx.effect) ctx.effect(() => () => clearInterval(timer));
  else ctx.on?.('dispose', () => clearInterval(timer));
}
export { installScheduler };
