# Plugin Atlas 增量爬虫

`crawler/update.mjs` 是 Plugin Atlas 的数据抓取/归一化脚本：把 DeepSeek Harness（dsh）插件生态里可枚举的 6 个市场抓成一份去重后的插件基础数据 `data/plugins_base.jsonl`。`crawler/analyze.mjs` 负责批量分析：分类、分支设计、README 摘要，最后合并成契约要求的 `data/plugins.jsonl` 与 `data/graph.json`。

- Node **24**（ESM，文件后缀 `.mjs`），**零第三方依赖**，只用全局 `fetch` 与 Node 标准库
- 所有网络响应缓存在 `data/raw/`，下一次运行按 **ETag / Last-Modified / 内容哈希** 跳过未变化数据
- 全程只读外部数据与**本机** dsh 安装目录，不修改 `~/.dsh`、不安装/发布任何东西

## 用法

```bash
# 完整增量抓取（首次约 2~5 分钟；再次运行主要是缓存命中/304）
node crawler/update.mjs

# 只用 data/raw/ 已有缓存重建 data/plugins_base.jsonl，不发起任何网络请求
node crawler/update.mjs --offline

# 只抓 (downloads, stars) 排名前 N 的 README（默认 1500）
node crawler/update.mjs --readme-limit 200

# 跳过两个 GitHub 市场（blue-whale repos.txt + dsh-plugin-hub 搜索）
node crawler/update.mjs --skip-github
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `README_LIMIT` | `1500` | `--readme-limit` 的默认值 |
| `NPM_SEARCH_WINDOW` | `5500` | npm search 深分页窗口上限（registry 只允许枚举约 5,500 条） |
| `DSH_INSTALL_ROOT` | 自动探测 | 本机 dsh 安装根目录（用于读取 app-boot 官方 on-demand 常量） |

退出码：`0` 成功；`1` 致命错误（如合并后为空，此时不会覆盖已有输出）。

## 抓取源、请求预算与缓存

| 市场 id | 端点 | 请求预算 | 缓存文件 |
|---|---|---|---|
| `index:awesome-dsh-plugin` | `https://awesome-dsh-plugin.com/plugins.json`（失败回退 `cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json`） | 1（+1 仅回退时） | `data/raw/index/awesome-plugins.json` |
| `npm:dsh-plugin` | `registry.npmjs.org/-/v1/search?text=keywords:dsh-plugin&size=250&from=N` | `total` 或 5500 窗口 ≈ 22 页 | `data/raw/npm-search/npm_dsh-plugin/page-*.json` |
| `npm:cordis-plugin` | 同上，关键词 `cordis-plugin` | ≈ 11 页 | `data/raw/npm-search/npm_cordis-plugin/page-*.json` |
| `inventory:dsh-official-on-demand` | 本机 dsh 安装目录 `.../dsh-app-boot/lib/index.js` 的 `OFFICIAL_ON_DEMAND_CATALOG` / `ON_DEMAND_BUNDLES` 常量 | **0** | `data/raw/inventory/dsh-official-on-demand.json`（提取结果，供换机/离线使用） |
| `github:blue-whale-harness` | `raw.githubusercontent.com/leenkcool/Blue-Whale-Harness/main/repos.txt` | 1 | `data/raw/github/blue-whale-repos.txt` |
| `github:dsh-plugin-hub` | `api.github.com/search/repositories`，`topic:dsh-plugin` 与 `"dsh-plugin" in:name,description` 各 3 页 × 100 | ≤ 6（匿名） | `data/raw/github/search/<query>-p<N>.json` |

GitHub 匿名限频处理：每次响应读取 `x-ratelimit-remaining/reset` 并写入状态；剩余 **< 5** 时立即停止后续请求（记录 `stopped_early` / `rate_limited`），已缓存页面仍然复用。同一分钟内重跑不会继续消耗额度。

### 增量语义（`data/raw/state.json`）

- `state.http[<key>]`：每个缓存 URL 的 `etag`、`last_modified`、`sha256`、`size`、`fetched_at`。下次运行发送 `If-None-Match` / `If-Modified-Since`；`304` 直接复用缓存；`200` 但 sha256 与缓存一致时标记 `unchanged` 并不重写文件（npm search 等不返回稳定 ETag 的端点靠它兜底）；网络失败时回退旧缓存（stale，报告里单独计数）。
- `state.readmes[<plugin_id>]`：`version` + `status`（`ok` / `none` / `error`）。README 已存在且版本未变 → **不再发请求**；`404` 记为 `none` 不再重试；`error` 下次重试；版本变化（npm 版本号 / 目录里的 version）→ 重新抓取。
- `state.pkgjs[<plugin_id>]`：同上，按 `package@version` 缓存 `package.json`。
- `state.markets`：每个市场最近一次抓取的 total / pages / records / fetched_at，以及 GitHub 的 remaining/reset。
- `state.github.last_run`：最近一次 GitHub 搜索的页数、条数、限频状态。

缓存目录结构：

```
data/raw/
├── state.json                       # 增量状态（etag / 版本 / README 状态）
├── crawl-report.json                # 最近一次运行统计
├── index/awesome-plugins.json       # 主目录原始 JSON
├── npm-search/<market>/page-000000.json
├── github/blue-whale-repos.txt
├── github/search/<query>-p<N>.json
├── inventory/dsh-official-on-demand.json
├── packument/<plugin>.json          # 仅 README 的 jsDelivr 回退失败时用到
└── package-json/<pkg>@<ver>.json    # deps_dsh / provides / tools 来源
data/readmes/<safe-id>.md            # README 原文
```

## README 抓取规则

- 选择范围：合并后插件按 **(downloads, stars)** 排名取前 `README_LIMIT`（默认 1500）。有 downloads（npm 月下载）用 downloads；仅 GitHub 条目没有下载量时用 stars 参与排名。
- 文件路径：`data/readmes/<safe>.md`，`safe = id 中非 [A-Za-z0-9._-] 字符替换为 _`。极少数 id 归一化后撞名时追加 8 位 sha256 后缀（避免互相覆盖）。
- npm 包：`https://cdn.jsdelivr.net/npm/<pkg>@<ver>/README.md` → 失败再试 `readme.md` → 再回退 `registry.npmjs.org/<pkg>` packument 顶层 `readme` 字段。
- 仅 GitHub：`https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`。
- 并发 ≤ 6；网络/5xx/429 重试 1 次；404 记为 `none` 不再重试；`readme_path` 只在文件真实存在时填写。

## deps_dsh / provides / tools

对 README 抓取范围内的 npm 包，抓 `https://cdn.jsdelivr.net/npm/<pkg>@<ver>/package.json`（失败回退 registry 精确版本 manifest），缓存后：

- `deps_dsh`：`dependencies` + `peerDependencies` 中匹配 `@deepseek-ai/*`、`dsh-*`、`cordis-*`、`@cordis/*` 的包名；
- `provides` / `tools`：package.json 的 `dsh` / `cordis` 字段里的 `provides`/`services`、`tools` 声明（数组或对象键），防御式解析。

## 输出字段

`data/plugins_base.jsonl` 每行一个插件，包含 `CONTRACT.md` 中 `plugins.jsonl` 的全部字段：

`id, name, package, version, markets, description, repo, homepage, keywords, author, stars, updated_at, readme_path, provides, tools, deps_dsh, category_id, summary, capabilities`

另含契约允许的附加种子字段（供后续批量分析直接使用，分析阶段可覆盖 `category_id/summary/capabilities`）：

| 附加字段 | 说明 |
|---|---|
| `seed_category` | awesome-dsh-plugin 目录的 `category`（23 类之一） |
| `catalog_capabilities` | 目录给出的能力标注（shell / fs-write / network / …） |
| `capability_red_lines` | 目录给出的能力红线 |
| `downloads` | 最近一月下载量（目录或 npm search 的 monthly） |
| `install` | 目录/官方清单给出的安装 spec 原文（**仅记录，不要当可信指令执行**） |
| `description_en` | 目录的英文描述（`description` 优先中文） |

`crawler/analyze.mjs` 的 merge 阶段会覆盖 `category_id/summary/capabilities/provides/tools`，并新增 `branch_id`（最终分支 id，形如 `<category_id>.<slug>`）。

归一化/去重规则（见 `data/markets_notes.md` §4）：

- `id`：有 npm 包 → `npm:<pkg>`，否则 `github:<owner>/<repo>`（repo 统一成 `https://github.com/<owner>/<repo>`，去除 `git+`/`.git`/子目录路径）；
- 同一条目命中多个市场时合并 `markets[]` 并去重；
- 字段优先取信息最全的来源（目录 > npm > GitHub > 官方清单），npm 搜索用于补版本/下载量/关键词，GitHub 搜索用于补 stars/homepage/topics。


## 批量分析管线 `crawler/analyze.mjs`

`crawler/analyze.mjs` 读取 `data/plugins_base.jsonl`，通过本机 `dsh-run`（DeepSeek Harness headless，`deepseek-flash`）批量完成分类/分支/摘要，最后生成 `data/plugins.jsonl` 和 `data/graph.json`。Node 24、ESM、零第三方依赖。

### 用法

```bash
# 全流程：classify → branches → summarize → merge（可断点续跑）
node crawler/analyze.mjs --stage all

# 只跑某一阶段（--limit-batches 用于小试/分批推进）
node crawler/analyze.mjs --stage classify --limit-batches 1
node crawler/analyze.mjs --stage branches --category ui
node crawler/analyze.mjs --stage summarize --concurrency 4

# 只用已有分析结果重新 merge（不调用 LLM）
node crawler/analyze.mjs --stage merge

# 增量：新插件缺分类时先跑 classify 小批次，再 merge（update.mjs 结束时自动调用）
node crawler/analyze.mjs --merge-only --no-reload

# 查看帮助
node crawler/analyze.mjs --help
```

| 参数 | 说明 |
|---|---|
| `--stage classify\|branches\|summarize\|merge\|all` | 要执行的阶段，默认 `all` |
| `--merge-only` | 增量入口：只为缺分类的新插件跑 classify 小批次，然后 merge |
| `--concurrency N` | LLM 并发数，默认 4 |
| `--limit-batches N` | 每个阶段最多跑 N 个批次（按插件数/分类大小排序，便于小试） |
| `--category <id>` | 只跑某个分类的 branches（补跑/调试） |
| `--no-reload` | 不调用 web `/api/reload`（由调用方负责） |
| `--force` | 忽略已有合法 `out.json`，全部重跑 |

### 阶段 A：classify

- 范围：`plugins_base.jsonl` 中没有 `seed_category` 的插件（约 6,100 条）；有 seed 的直接继承。
- 批次：约 300 条/批，输入 `data/work/classify/<batch>.in.tsv`（`id \t name \t 描述截断 200 字 \t keywords`）。
- 输出：`data/work/classify/<batch>.out.json`，形如 `{"<plugin_id>":"<category_id>"}`；类别从 `data/raw/index/awesome-plugins.json` 的 23 个顶层 `categories` 中选，实在不属于任何类的用 `misc`。

### 阶段 B：branches

- 范围：每个有插件的 category 一次任务（`data/work/branches/<category_id>.in.md`）。
- 输入：类别 id/中英文名 + 插件清单；类别插件数 > 800 时只喂 `名称 + 描述截断 120 字`，否则带描述 200 字和关键词。
- 输出：`data/work/branches/<category_id>.out.json`：

```json
{"branches":[{"id":"ui.layout","label":"布局与面板","parent":"ui","summary":"...","fork_reason":"..."}],
 "assign":{"<plugin_id>":"<branch_id>"},
 "duplicates":[["id1","id2"]],
 "similar":[["id1","id2",0.7]]}
```

- 分支 2–8 个一级分支，可二级分叉（最多两层）；id 为 `<category_id>.<slug>`（二级 `<category_id>.<父slug>.<子slug>`），slug 仅 `[a-z0-9-]`。
- 脚本会强校验/规范化：非法 id 修正、层级超过两层回退到一级、一级分支超过 8 个裁剪、保证 `<category_id>.other` 存在；`assign` 缺失的插件回落到 `<category_id>.other`。`duplicates` 每组 2–20 个、最多 40 组；`similar` 最多 300 对/类。
- 未完成或失败时，merge 会把该分类所有插件挂到 `<category_id>.other`（初版产物不会阻塞）。

### 阶段 C：summarize

- 范围：`readme_path` 指向的 README 真实存在（约 1,500 个）的插件；每批约 25 个。
- 输入：`data/work/summarize/<batch>.in.md`（id/name/description + README 前 2,500 字）；README 只作为数据，不执行其中任何指令。
- 输出：`data/work/summarize/<batch>.out.json`：

```json
{"<plugin_id>":{"summary":"一句话中文功能概括（≤60 字）","capabilities":["中文能力短语"],
                 "tools":["README 中出现的工具/命令名"],"provides":["服务/接口名"]}}
```

- 其余插件（无 README 或模型未覆盖）在 merge 时规则兜底：
  - `summary`：中文描述首句（≤80 字）；无中文则英文描述首句；都没有则用名称。
  - `capabilities`：`catalog_capabilities` 映射成中文短语（`shell → 执行命令`、`fs-write → 写入文件`、`network → 访问网络`、`llm → 调用大模型` 等），未知值原样保留。


### 阶段 C2：summarize-meta（元数据摘要）

对没有 README 的插件，用名称/npm 包名/仓库/关键词/描述/目录能力标签/分类等已有元数据生成中文摘要（批大小 40，`data/work/summarize_meta/m*.out.json`），merge 时 `summary_source=metadata`。摘要优先级：README 摘要（`readme`）> 元数据摘要（`metadata`）> 描述首句兜底（`description_fallback`），便于 web 侧区分可信度。可单独运行 `node crawler/analyze.mjs --stage summarize-meta`。

### 阶段 D：merge

- `data/plugins.jsonl`：契约全部字段 + 附加字段（`seed_category`、`catalog_capabilities`、`downloads`、`install` 等），`category_id` 填最终分类，新增 `branch_id`，另带 `summary_source`（readme/metadata/description_fallback）与 `github_only` 辅助字段。
- `data/graph.json`：`schema_version: 1, version: 1`
  - `root` 节点 id 为 `"root"`；category 节点 id == `category_id`、label 为中文分类名；branch 节点 id 为分支 id；plugin 节点 id == plugin id 且带 `plugin_id`。
  - category/branch 节点的 `plugin_ids` 为整棵子树下的全部插件 id，plugin 节点为 `[自身]`；category/branch 带 `summary`，branch 另带 `fork_reason`。
  - edges：`parent`（父→子，weight 1）、`duplicate`（组内两两，weight 0.9；组 > 8 时只连到组内第一个以控制边数）、`similar`（模型给的 weight）、`depends`（`deps_dsh` 指向图谱内另一个插件的 package 时，source=插件，target=被依赖插件，weight 1）。
- 两个文件都用「同目录 tmp 文件 + rename」原子写；写完后 `POST /api/reload` 并打印 `/api/status`，服务不可达只警告不失败。

### 批次约定、断点续跑与日志

- 每个 LLM 任务都是：输入写到 `data/work/<stage>/<batch>.in.(tsv|md)` → prompt 要求模型「只读这个输入文件，只把严格 JSON 写到 `<batch>.out.json`，不做其他事」→ 脚本读取并校验 JSON。
- 校验失败自动重试 **1 次**；仍不完整时把已合法的部分落盘（`partial`），下次运行继续补。
- 有合法 `out.json` 的批次自动跳过（classify/summarize 按 id 粒度复用结果，branches 按分类复用），因此可以随时中断、断点续跑；`--force` 可强制重跑。
- 每批耗时/状态追加到 `data/work/log.jsonl`；最新一次 merge 的统计写到 `data/work/merge-report.json`。

### LLM 调用约定

- 命令固定为子进程 `dsh-run - <项目根目录>`，prompt 从 stdin 传入；环境变量 `PATH` 含 `$HOME/.local/opt/node24/bin:$HOME/.local/bin`，`DSH_MODEL=deepseek-flash`、`DSH_EFFORT=low`。
- **不设置 `DSH_PROVIDER`**（即使父环境有也会被移除），不会走 `our-free-model`。
- 子进程输出含 `ACCOUNT_SIGN_IN_REQUIRED` 时立即杀掉所有在跑的批次、中止整个管线并以退出码 1 报错。
- 单次调用默认超时 900s（`DSH_TIMEOUT_MS` 可调），失败重试 1 次。

### 本机环境注意

本机根文件系统只读，`~/.dsh` 不可写，而 `dsh` 启动时必须重写 profile 的 `cordis.yml`。脚本检测到默认 `DSH_HOME` 不可写时，会把 `~/.dsh` **只读复制**一份到项目内 `.run/dsh-home`（不修改 `~/.dsh`），并用它作为 `DSH_HOME`；可用 `PLUGIN_ATLAS_DSH_HOME` 指定其他可写副本。每个批次使用独立 session id，避免并发撞会话锁。

## update.mjs 与分析管线的集成

`node crawler/update.mjs` 在抓取、写 `data/plugins_base.jsonl` 和 `data/raw/crawl-report.json`（均为原子写）之后，如果检测到 `data/work/{classify,branches,summarize}` 下已有分析结果，会：

1. 自动运行 `node crawler/analyze.mjs --merge-only --no-reload`（增量：只为缺分类的新插件跑 classify 小批次，然后 merge）；
2. 调用 `POST http://127.0.0.1:4380/api/reload` 并打印 `/api/status`。

该步骤失败只打印警告，不影响抓取结果；没有任何分析结果时跳过。

## 本次分析结果

生成时间：2026-11-11T06:06:30.064Z；数据源：`data/plugins_base.jsonl`（16350 条）。

| 指标 | 数值 |
|---|---|
| 插件总数 | 16350 |
| 分类数 | 24（23 个目录分类 + misc） |
| 分支节点数 | 644 |
| duplicate 组 | 611（展开 4271 条边） |
| similar 边 | 3447 |
| depends 边 | 86 |
| 图谱节点/边 | 17019 / 24822 |
| 有 README 的插件 | 1500，LLM 摘要覆盖 1500 |
| summary 来源 | readme 1500 / metadata 3197 / 描述兜底 11653 |
| 分类来源 | seed 10213 / 模型 6137 / misc 0 |

| 分类 | 中文名 | 插件数 | 分支数 | duplicate 组 |
|---|---|---:|---:|---:|
| `ui` | UI 增强 | 2377 | 28 | 25 |
| `tools` | 工具与能力 | 2150 | 29 | 37 |
| `dev` | 开发与运行时 | 1105 | 29 | 35 |
| `session` | 会话与消息 | 1025 | 29 | 40 |
| `workflow` | 工作流与自动化 | 912 | 28 | 17 |
| `usage` | 用量与计费 | 856 | 24 | 26 |
| `model` | 模型与账号接入 | 822 | 28 | 40 |
| `fun` | 娱乐 | 762 | 27 | 30 |
| `misc` | 其他 | 652 | 26 | 38 |
| `memory` | 记忆 | 638 | 28 | 20 |
| `notify` | 通知与集成 | 569 | 26 | 20 |
| `theme` | 主题与外观 | 525 | 25 | 40 |
| `skill` | 技能包 | 523 | 29 | 19 |
| `security` | 安全与权限 | 480 | 26 | 25 |
| `docs` | 文档与渲染 | 468 | 27 | 35 |
| `remote` | 远程与移动端 | 427 | 24 | 35 |
| `browser` | 浏览器与网页 | 355 | 26 | 23 |
| `market` | 插件市场与管理 | 343 | 28 | 27 |
| `vision` | 视觉与多模态 | 341 | 25 | 20 |
| `identity` | 身份与通信 | 321 | 27 | 18 |
| `git` | Git 与代码评审 | 266 | 26 | 10 |
| `voice` | 语音与音频 | 199 | 28 | 14 |
| `agi` | AGI 架构探索 | 128 | 29 | 9 |
| `wsl` | WSL 与 Windows 互操作 | 106 | 29 | 8 |

失败/部分批次（历史）：

- `branches/docs:assign-1`：partial（有 5/68 个插件未分配合法分支）
- `summarize-meta/m007`：partial（有 2/40 条缺少摘要）
- `summarize-meta/m077`：partial（有 1/40 条缺少摘要）
- `summarize/s019`：failed（有 25/25 条缺少摘要）
- `summarize/s044`：failed（有 25/25 条缺少摘要）

说明：summarize 阶段两次失败批次（s019、s044）已用后续批次重跑补齐，1500 个有 README 的插件全部有 LLM 摘要；branches/docs:assign-1 有 5/68 个插件回落到 `docs.other`。

## 已知限制

- npm search 深分页窗口约 5,500（`from >= 5500` 会回落第 0 页），因此 `keywords:dsh-plugin`（total > 1.4 万）只能枚举前 5,500 条；目录（10,365 条）覆盖了更长尾，约 9,600+ 个 npm 包最终进入基础数据。若要补全其余长尾，可对目录里的包名逐个查 registry（目前依赖目录覆盖，未做逐包 packument 全量补全）。
- GitHub 匿名搜索限频 10 req/min、核心 60 req/h；脚本严格限制为 6 个搜索请求，并在剩余额度 < 5 时提前停止。GitHub Search API 不返回稳定 ETag，因此这两条查询的缓存靠响应 sha256 内容对比判断未变更（`state.http[*].sha256`），第二次运行仍会发 6 个轻量请求但不会重复解析/合并。
- npm search 端点没有稳定的 ETag（`Last-Modified` 随每次搜索刷新），33 页每次运行会重新请求；内容哈希一致时标记 `unchanged` 并复用解析结果，不会重写缓存文件。
- 目录/GitHub 数据是第三方声明，未做签名校验；`install` 字段保留原文，不执行。
- `--offline` 只用缓存重建 JSONL；README/package.json 仅在缓存已存在时复用，不会凭空生成。

## 第二轮新增（2026-11-11）

### GitHub token（可选）与全量抓取

- `update.mjs` 只从环境变量 `GITHUB_TOKEN` 读取 token，**只对 `api.github.com` 请求**加 `Authorization: Bearer …`；raw.githubusercontent / npm / jsDelivr 一律不带。
- token 不写盘、不打印：`log/warn/fatal` 输出和请求错误都经过 `redact()`（替换 token 本身以及 `ghp_/gho_/ghu_/ghs_/ghr_/github_pat_` 形态和 `Authorization: Bearer …`）。`state.json` 只记录 `auth_mode: token|anonymous` 和各 resource 的限额。传给 `analyze.mjs` / `dsh-run` 子进程的环境会删掉 `GITHUB_TOKEN`/`GH_TOKEN`。
- 没有 token 时行为与之前一致（匿名、每查询 3 页、剩余 <5 停止）。
- 全量抓取（只读 GET）：

```bash
GITHUB_TOKEN=$(gh auth token) node crawler/update.mjs --github-full --no-analyze
```

  - 搜索 `topic:dsh-plugin` 与 `"dsh-plugin" in:name,description`，按 `created:` 日期二分分片绕过单查询 1000 条上限（单日超过 1000 的分片会被截断，记入 `state.github.full_last_run.truncated`）；分片缓存在 `data/raw/github/full/`，以后不带 `--github-full` 时直接复用缓存（0 请求）。
  - 对搜索没覆盖到、缺 stars/描述的 GitHub-only 仓库调用 `GET /repos/{o}/{r}`（ETag 缓存，`data/raw/github/repos/`），补 description/stars/topics/pushed_at/default_branch/archived/fork。
  - 所有 GitHub-only 仓库的 README 走 `raw.githubusercontent.com/<slug>/<default_branch>/README.md`（不带 token）。
  - 限频：core 剩余 < `GITHUB_CORE_MIN_REMAINING`（默认 200）时暂停到 reset；search 剩余 < 3 时暂停到 reset；403/429 按 Retry-After（默认 60s）退避重试。
- `--no-analyze`：抓完不自动 merge/reload（批量分析另跑）。
- 之前成功抓过的 README（`state.readmes[id].status=ok` 且文件存在）每次运行都会挂回 `readme_path`，不受 README_LIMIT 影响。

### analyze.mjs 新增

- `--stage summarize-meta`：没有 README 的插件用元数据（描述/关键词/npm 包名/仓库/目录能力标签/已缓存 packument 的 readme 字段）生成摘要，`summary_source: "metadata"`；README 摘要 `summary_source: "readme"`；都没有时 `"description_fallback"`。README 摘要优先于 metadata 摘要。可断点续跑，失败批次下次自动重跑。
- `summarize` 与 `summarize-meta` 默认**跳过 github_only 插件**（GitHub 全量后有 ~2 万个），加 `--include-github-only` 才处理；环境变量 `SUMMARIZE_BATCH`（默认 25）、`SUMMARIZE_README_CHARS`（默认 2500）、`SUMMARIZE_META_BATCH`（默认 40）。
- `branches` 阶段改为增量：读取该类所有已有 `assign-*.out.json` 的合法分配，只为新插件开新块，不会因为插件增加而整类重跑。
- 模型偶尔丢掉 id 前缀（`npm:`/`github:`），读取结果时按已知 id 自动修正。

### 分支级能力全集

```bash
node crawler/capabilities.mjs [--min-category 800] [--min-branch 15] [--all-levels] [--only <cat>] [--concurrency 2] [--force]
node crawler/refresh-capabilities.mjs   # merge 之后刷新所有能力文件的 plugins 列表并 reload
```

产出 `data/capabilities/<category_id>/<branch_id>.json`（默认只做一级分支；已存在的跳过）。

## 第四轮（r4）：去重与相关性过滤

- `crawler/dedup.mjs`：merge 时按标准化 GitHub owner/name 去重（repo / rename / homepage / owner+name 四类规则，只读本地缓存 data/raw/github/{full,repos}），github_only 并入市场插件或规范仓库；明细 `data/dedup-merged.jsonl`。
- `crawler/relevance.mjs` + `node crawler/analyze.mjs --stage relevance [--concurrency 6]`：github_only 规则打分，拿不准的由 Codex gpt-6.1-terra 分批（RELEVANCE_BATCH，默认 40）判定，产物 `data/work/relevance/rNNN.{in.md,out.json}`，断点续跑。
- merge 结果：无关（置信度 ≥0.8）→ `data/filtered-out.jsonl`；拿不准 → `relevance:"suspect"`。恢复：`node crawler/relevance-restore.mjs <id...>|--all`。
- `node crawler/capabilities-category.mjs [--concurrency 6] [--only <cat>] [--force]`：分类级能力全集（gpt-6.1-terra），旧文件备份到 `data/capabilities-legacy-r4/`。
- 串联脚本：`logs/run-r4.sh`（日志 logs/r4-*.log，汇总 logs/r4-summary.txt）。
