const skill = {
  name: 'plugin-atlas',
  description: '搜索、比较与维护 Plugin Atlas 插件图谱',
  whenToUse: '需要查找、比较或更新插件生态信息时',
  invocation: { modelInvocable: true, userInvocable: true },
  content: `先用 plugin_atlas_search 搜索，plugin_atlas_node 查看详情，plugin_atlas_compare 比较同分支插件。维护流程：plugin_atlas_update 采集，plugin_atlas_summarize 增量提取，plugin_atlas_merge 合并；plugin_atlas_refresh 可串联全流程。写数据默认 dry_run，必须明确 apply=true；summarize 仅写状态目录。先用 plugin_atlas_pipeline_status 查看预算，预算耗尽会停止并可续跑。服务由 plugin_atlas_service 管理。

以下模板可交给 workflow 工具；按实际 workflow 语法和分支替换占位符：
\`\`\`js
const branches = ['<branch-a>', '<branch-b>'];
const results = await Promise.all(branches.map(branch => agent({ task: '使用 plugin_atlas_compare 比较分支 ' + branch })));
return results;
\`\`\``,
};
export { skill };
