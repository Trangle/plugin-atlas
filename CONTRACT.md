# Plugin Atlas 数据契约（DeepSeek 侧产出，Codex 侧消费）

目录：仓库根目录（plugin-atlas/）
- crawler/            DeepSeek 侧：市场/npm/GitHub 抓取、缓存、批量分析脚本
- data/raw/           原始抓取缓存（市场索引、npm、GitHub API 响应，带 etag）
- data/readmes/<plugin_id>.md   README 原文
- data/plugins.jsonl  每行一个插件
- data/graph.json     图谱
- data/capabilities/<category_id>.json  能力全集 + vision
- web/                Codex 侧：网页、API、检索索引、可视化

## plugins.jsonl 每行
{ "id": "npm:<pkg>" , "name", "package", "version", "markets": ["..."], "description",
  "repo": "https://github.com/o/r" | null, "homepage", "keywords": [], "author",
  "stars": int|null, "updated_at": ISO, "readme_path": "data/readmes/<safe>.md",
  "provides": ["service/tool 名"], "tools": ["tool 名"], "deps_dsh": ["@deepseek-ai/..."],
  "category_id": "...", "summary": "一句话中文功能概括", "capabilities": ["..."] }

## graph.json
{ "version": 1, "generated_at": ISO,
  "nodes": [ { "id", "type": "root"|"category"|"branch"|"plugin", "label", "parent": id|null,
               "summary", "plugin_ids": [] , "fork_reason": "为何从父类分化" } ],
  "edges": [ { "source", "target", "type": "parent"|"duplicate"|"similar"|"depends"|"extends",
               "weight": 0-1, "note" } ] }
树结构由 node.parent 决定（root→category→branch(可多层)→plugin）；其余关系在 edges。

## capabilities/<category_id>.json
{ "category_id", "label", "plugins": [ids], "union": [ { "capability", "provided_by": [ids], "best_impl": id, "note" } ],
  "best_overall": id, "duplicates": [[id,id,...]], "vision": "markdown", "generated_at" }

更新：crawler 提供 `node crawler/update.mjs`（增量，按 etag/版本跳过）后重写 data/*；
web 侧应监听或提供 /api/reload 重新加载并重建索引。

## 兼容性约定（可选扩展）
- plugin 节点可带 `plugin_id` 对应 plugins.jsonl 的 id；缺省时先以节点 id 关联，再兼容 `plugin_ids[0]`。
- category 节点 id 即 category_id，能力文件为 `capabilities/<category_id>.json`；category_id 应为安全文件名，不能包含路径分隔符或 `..`。
- readme_path 相对项目根目录；独立数据快照也可使用相对其数据目录的 `readmes/*.md`。不存在时 README 视为空。
- markets 为开放字符串数组，例如 npm、dsh、github；未知值原样展示，不限定枚举。
- 文件顶层可新增可选 `schema_version`；graph 可带可选 `example: true` 标识示例。
- 消费端对缺失的文本/数组分别按空字符串/空数组处理，缺失 stars 显示未知；未知字段保留。id 为关联键，缺失 id 的记录可跳过。parent 缺失按无父节点处理，孤立节点仍展示，循环父链截断。缺失能力文件不阻止加载。

## 第二轮扩展（2026-11-11，向后兼容，均为可选字段）
- plugins.jsonl 新增 `github_only: bool`：只在 GitHub 上出现（无 npm 包、未被 awesome-dsh-plugin 目录收录、不在官方 inventory）的仓库为 true（约 1,634 个）。graph.json 的 plugin 节点同样带 `github_only`。网页建议默认隐藏 github_only=true 的插件，提供开关显示。
- plugins.jsonl / plugin 节点新增 `summary_source`："readme"（模型读 README 生成）| "metadata"（无 README，模型依据描述/关键词/npm 元数据/仓库名生成）| "description_fallback"（未经模型，取描述首句）。
- plugins.jsonl 新增 `branch_id`：插件所在最深一层 branch 节点 id（与 graph 中 plugin 节点的 parent 相同）。
- 分支级能力全集：大类（插件数 > ~800，如 ui、tools、misc）按分支生成 `data/capabilities/<category_id>/<branch_id>.json`，结构与分类级能力文件相同，另加 `"branch_id"` 字段；`plugins` 为该分支子树内全部插件 id。branch_id 形如 `<category_id>.<slug>`，为安全文件名。分类级 `capabilities/<category_id>.json` 仍可存在；消费端按节点类型查找：category → `capabilities/<id>.json`，branch → `capabilities/<category_id>/<id>.json`，缺失不报错。
- 能力文件命名核对（2026-11-11）：graph 中 category 节点 id 就是短名（ui、tools、browser、memory、model、session、usage …），因此 `capabilities/browser.json` 等即为 `capabilities/<category_id>.json`，无需改名；/api/node/browser 已能返回 capabilities。
- GitHub 全量抓取后 plugins.jsonl 可能带附加字段：`gh_default_branch`、`gh_archived`、`gh_fork`（来自 GitHub /repos 元数据，可选）。
- github_only 的插件默认不做模型摘要（summary_source 多为 description_fallback），分类与分支照常挂载。
- `summary_source` 取值固定为三种：`readme` | `metadata` | `description_fallback`（与网页端对齐）。

## 第四轮扩展（2026-11-11，r4，向后兼容）
- merge 阶段按标准化 GitHub owner/name 去重：github_only 记录并入同一仓库的市场插件（或改名后的规范仓库），被并入的记录不再单独出现；plugins.jsonl 可带 `merged_from: [{id, markets, repo, rule, key}]`，graph plugin 节点可带 `merged_from: [id]`。明细 data/dedup-merged.jsonl。
- github_only 插件可带 `relevance`（"relevant" | "suspect"）、`relevance_score`（0–100）、`relevance_reason`、`relevance_source`；graph plugin 节点可带 `relevance`。消费端缺失时按相关处理，"suspect" 显示「疑似无关」。
- 判定无关的仓库移到 data/filtered-out.jsonl（不在 plugins.jsonl / graph.json 中），可用 data/relevance-overrides.json {"keep":[],"drop":[]} 恢复或强制移出。
- 所有 24 个分类都有 capabilities/<category_id>.json（文件名 == graph 中 category 节点 id）。

## Changelog
- 2026-11-10：新增可选 node.plugin_id 和关联回退规则，兼容节点与插件使用不同 id 的情况。
- 2026-11-10：明确 category_id 与能力文件定位、安全文件名规则，避免定位歧义。
- 2026-11-10：明确 README 项目根相对路径并允许独立快照相对路径，方便离线示例和临时快照。
- 2026-11-10：明确 markets 为开放集合，允许未来新市场。
- 2026-11-10：新增可选 schema_version、example 和缺失字段容错约定，保证旧数据继续可读。
- 2026-11-11：新增 github_only、summary_source、branch_id 字段，以及分支级能力文件 capabilities/<category_id>/<branch_id>.json（DeepSeek 侧）。
- 2026-11-11：GitHub 全量（token）后插件约 3.5 万（github_only 约 2 万）；新增可选 gh_default_branch / gh_archived / gh_fork。
- 2026-11-11：r4 新增 merged_from、relevance* 字段，data/filtered-out.jsonl、data/dedup-merged.jsonl、data/relevance-overrides.json。
