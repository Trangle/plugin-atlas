# dsh-plugin-atlas 0.3.0

宿主侧插件提供插件图谱的采集、增量摘要、搜索、比较和更新。Node.js 24；运行时无第三方依赖（dsh 服务由宿主提供）。

```text
crawler → plugins_base.jsonl → summarize → atlas-state/overlay.jsonl
                                      ↓ merge（备份、去重、相关性、能力刷新）
                                 plugins.jsonl → 本地服务 / 搜索
```

安装：`dsh plugin --profile <p> add file:<repo>/dsh-plugin`。卸载：`dsh plugin --profile <p> remove dsh-plugin-atlas`。Web 页面需要另行启动 `bash <repo>/web/start.sh`。

| 命令                                                                                                                                                                   | 作用                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/atlas update [--apply] [--offline] [--skip-github]`                                                                                                                  | 采集并合并已有 overlay                                                     |
| `/atlas refresh [--apply] [--limit N] [--backend mock]`                                                                                                                | 依次采集、增量摘要、合并                                                   |
| `/atlas summarize --incremental [--limit N] [--ids a,b] [--dry-run] [--backend mock\|llm] [--budget N] [--concurrency N] [--resume id] [--force] [--include-filtered]` | 增量提取摘要到状态目录                                                     |
| `/atlas merge [--apply] [--dry-run] [--all]`                                                                                                                           | 将 overlay 合入插件数据并刷新                                              |
| `/atlas tree [节点或关键词] [--depth N] [--caps]`                                                                                                                      | 查看树和能力                                                               |
| `/atlas tree find <关键词>`                                                                                                                                            | 定位节点和路径                                                             |
| `/atlas tree sync [--dry-run] [--apply] [--allow-production] [--limit N]`                                                                                              | 预演或执行树同步                                                           |
| `/atlas tree rollback [stamp]`、`/atlas tree history`                                                                                                                  | 恢复备份、查看历史                                                         |
| `/atlas families [分支] [--stale]`                                                                                                                                     | 查看族、代表及计划状态                                                     |
| `/atlas plan <族或分支或插件> [--refresh] [--dry-run] [--backend mock\|llm] [--budget N]`                                                                              | 生成融合计划                                                               |
| `/atlas plans refresh [--limit N] [--concurrency N] [--dry-run] [--backend mock\|llm] [--budget N] [--resume id]`                                                      | 刷新过期计划                                                               |
| `/atlas status`                                                                                                                                                        | 服务、进度、预算和 overlay 状态                                            |
| `/atlas compare <id...>` 或 `/atlas compare --branch <id>`                                                                                                             | 相对目标比较分支子树内的同类插件；支持 `--branch` 查看子树能力和疑似重复项 |
| `/atlas service start\|stop\|reload\|status`                                                                                                                           | 管理本地服务                                                               |
| `/atlas search <关键词>` 或 `/atlas <关键词>`                                                                                                                          | 搜索；服务不可用时退回本地全文                                             |
| `/atlas-open`                                                                                                                                                          | 显示网页地址                                                               |

工具对应 `plugin_atlas_update`、`plugin_atlas_refresh`、`plugin_atlas_summarize`、`plugin_atlas_merge`、`plugin_atlas_pipeline_status`、`plugin_atlas_compare`、`plugin_atlas_service`，并保留 `plugin_atlas_search`、`plugin_atlas_node`、`plugin_atlas_status`。工具参数使用下划线，如 `dry_run`、`skip_github`。模型可调用 `plugin-atlas` skill 获取流程与 workflow 模板。

写入数据的 update、refresh、merge 默认预览，必须显式 `--apply` 或工具 `apply=true`；`--dry-run` 优先。summarize 默认仅写状态目录，不更改 plugins.jsonl，`--dry-run` 可预览。采集和合并前分别备份基础数据和插件数据；合并后处理相关性时，缺少判定的候选写入报告，不调用外部模型。单次预算默认 20000 token，状态目录累计预算默认上限 100000；调用前预留输入估算和最大输出，耗尽或模型出错后保存进度，可通过 `--resume` 续跑。模型调用明细在 `usage.jsonl`，每行包含 backend；真实模型用量计入预算，mock 用量单独记录在 `budget.json` 的 mock 字段，不受预算上限限制。

配置项：`root`（自动检测仓库或 `PLUGIN_ATLAS_ROOT`）、`dataDir`（`ATLAS_DATA_DIR`）、`stateDir`、`logsDir`、`baseUrl`（默认 `http://127.0.0.1:4380`）、`backend`（默认 `llm`）、`concurrency`（默认 2、最大 8）、`batchSize`（8）、`budgetTokens`（默认且硬上限 100000）、`maxOutputTokens`（1500）、`schedule.intervalMinutes`（0 关闭）、`schedule.dryRun`（true）、`autoStartService`（false）。

LLM 后端使用宿主 `ctx.llm.prepareCall`、`BlockAssembler` 和 `createUserMessage`，模型由 `ctx.agentDefaultModel.currentSelection()` 提供；两项服务可选，缺失时可使用 mock。API 参考 dsh-llm 与 dsh-agent-default-model，以及 dsh-session-title-llm 的调用实现。`ctx.subagents.startActivation` 需要父 Agent 会话，本插件不直接调用；skill 中的 workflow 模板供模型交给 workflow 工具，由 `agent()` 并行处理。

测试：`npm test`；HTTP 自测会监听临时本地端口，需要在允许监听的环境运行。

| 工具                                                                           | 作用                       |
| ------------------------------------------------------------------------------ | -------------------------- |
| `plugin_atlas_search`、`plugin_atlas_node`、`plugin_atlas_status`              | 搜索、详情、服务状态       |
| `plugin_atlas_update`、`plugin_atlas_refresh`                                  | 采集并合并、完整刷新       |
| `plugin_atlas_summarize`、`plugin_atlas_merge`                                 | 摘要、合并 overlay         |
| `plugin_atlas_tree`、`plugin_atlas_tree_find`                                  | 查看树和定位节点           |
| `plugin_atlas_tree_sync`、`plugin_atlas_tree_rollback`                         | 同步和恢复树               |
| `plugin_atlas_families`、`plugin_atlas_plan`、`plugin_atlas_plans_refresh`     | 查看族、生成及刷新计划     |
| `plugin_atlas_pipeline_status`、`plugin_atlas_compare`、`plugin_atlas_service` | 流水线状态、比较、服务管理 |

| 配置                              | 默认值及作用                                 |
| --------------------------------- | -------------------------------------------- |
| `root`、`dataDir`、`stateDir`     | 仓库根、数据目录、流水线状态目录             |
| `backend`                         | `llm`；可选 `mock`                           |
| `concurrency`、`batchSize`        | 2（最多 8）、8                               |
| `runBudgetTokens`、`budgetTokens` | 单次 20000、跨运行累计 100000                |
| `schedule`                        | `intervalMinutes: 0`（关闭）、`dryRun: true` |
| `autoStartService`                | `false`                                      |

`--budget` / `budget` 覆盖单次预算；累计硬上限记在 `budget.json`，每次调用前同时检查两个上限。额度或认证错误立即停止，普通批次解析失败会记录并继续。`merge --all` 强制重新合并全部 overlay；默认只合并指纹变化的条目。dry-run 返回数量和最多 20 个 ID。summarize 默认排除 relevance 过滤和 dedup 合并的 ID，`--ids` 或 `--include-filtered` 可包含它们；相同指纹已存在于 overlay 时跳过。merge 输出备份路径、更新和新增数、各脚本退出码、耗时及 stdout 最后一行，以及 reload 结果。compare 默认 limit 为 10，可用 `--limit` 覆盖。

宿主接口出处：`ctx.llm` 来自 `@deepseek-ai/dsh-llm` 的 `lib/index.js`；`ctx.agentDefaultModel` 来自 `@deepseek-ai/dsh-agent-default-model`；`ctx.subagents` 来自 `@deepseek-ai/dsh-subagent`；`ctx.skills` 来自 `@deepseek-ai/dsh-skill`；`ctx.workflowEngine` 来自 `@deepseek-ai/dsh-workflow`。摘要使用 `ctx.llm`，因为批处理不需要工具，子 agent 需要父会话，直接调用也更省 token。

比较会在同类不足时上溯父分支，展示能力全集及目标提供和最佳实现的标记；多个目标还会显示相似度矩阵。搜索结果会获取每个插件的分类路径和能力详情。

树同步工具和计划工具默认预演；工具使用 `apply=true` 执行。树同步写入生产数据还需 `allow_production=true`，请先确认预演结果。定时刷新后预演树同步并标记受影响计划过期，不自动生成计划。
