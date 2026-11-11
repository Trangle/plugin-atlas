# Plugin Atlas Web

## 运行与边界

Node 24、原生 HTTP、node:sqlite，无前端构建。默认监听 0.0.0.0:4380；PORT=0 使用独立随机端口。只读 ../data/ 和 ../CONTRACT.md，依赖、fixtures、模型缓存、截图均位于 web/。不使用账号、付费服务或 CDN。

```bash
PORT=0 ATLAS_DATA_DIR=/tmp/atlas-fixture ATLAS_DISABLE_MODEL=1 node server.mjs
ATLAS_TEST_URL= node test.mjs
node screenshot.mjs --out screenshot.png --expand auto
```

ATLAS_DATA_DIR 指定独立快照；未指定时使用 ../data/。数据不可解析或为空时回退 web/fixtures/，status.warning 说明原因。ATLAS_DISABLE_MODEL=1 完全跳过模型导入与下载，采用 TF-IDF。

## 快照与性能

先 listen，再后台异步加载。无快照时 status 返回 loading:true，其它数据 API 返回 503 `{error:'loading'}`；reload 接口可等待初始加载。已有快照时重建期间继续服务旧数据。并发 reload 合并为同一 promise，完整构建后原子切换；构建失败不替换旧快照。无文件监控，数据生产者宜原子替换输入文件后调用 reload。stop.sh 发送 SIGTERM 后最多等待 10 秒再 SIGKILL，确保 start.sh 立即重启时端口已释放。

JSONL 解析、FTS 插入和 TF-IDF 按批次通过 setImmediate 让出事件循环。README 使用 fs.promises、16 路有限并发读取。单个 JSON.parse、单次 SQLite 调用仍是同步工作。节点 id、插件 id、插件到节点反查、parent→children、关系邻接表均预建；不再逐插件扫描全图。父关系以 node.parent 为准，关系查询将原有非 parent 边和派生 parent 边建入邻接表。

FTS5 trigram 每篇文档只索引 body 前 12000 字符（ATLAS_FTS_BODY 可调）；TF-IDF 仅使用 body 前 1500 字符（ATLAS_TFIDF_BODY 可调）。MiniLM 向量就绪后释放该快照的 TF-IDF 稀疏向量（降低 reload 期间新旧两份快照并存时的堆占用；r4 之前 reload 时曾因此 OOM）。截断只作用于索引输入，文档 body 本身不变，因此 MiniLM 向量缓存键不受影响。reload 响应提供 timings.parse/readmes/fts/tfidf/total（毫秒）及兼容 took_ms。readmes 阶段包含能力文件读取；parse 包含解析和结构索引建立。

性能实测（2026-11-10，真实数据：16399 节点 / 16350 插件 / 32918 检索文档，8 核）：

| 项目 | 改动前 | 改动后 |
| --- | --- | --- |
| 冷启动到可监听 | ≈52–83 s（listen 前同步 reload） | ≈1.2 s |
| 冷启动到真实数据可用 | 同上 | ≈22 s（加载期间 /api/status 返回 loading） |
| /api/reload | 52.5 s，期间事件循环阻塞 | ≈23 s（parse 0.4 / readmes 0.2 / fts 9.9 / tfidf 12.6 s），期间旧快照继续响应（tree ≈0.05 s、search ≈0.4 s） |
| MiniLM 向量就绪 | 每次 reload 全量重算 32918 篇（≈4 min） | 首次 ≈4 min 后写缓存；之后 reload 全部命中，reload 完成后 ≈1 s 切换到 MiniLM |
| 首屏图数据 | /api/graph 8.1 MB | /api/tree ≈12.6 KB（49 个非插件节点） |
| 默认 SVG 渲染 | 16399 节点，≈4.4 s | 49 节点，≈0.17 s |
| 展开一页（200 插件） | — | /api/children ≈66 KB，≈0.02 s |

## 数据兼容与过滤

保留未知字段；缺失文本和数组按空值展示。插件关联按 plugin_id、节点 id、plugin_ids[0] 顺序尝试。父链循环截断，孤立节点仍展示。README 支持项目根相对路径和数据目录相对路径，拒绝越出对应目录。

github_only：插件字段是布尔时直接使用，否则 markets 非空且每项为 github 或以 github: 开头时判定为 true。插件节点自身布尔值优先，否则继承关联插件判定。tree、children、graph、search 默认过滤；include_github_only=1 包含。search 过滤 plugin 文档及 plugin 类型 node 文档，保留 capability 文档。node 直接访问不做过滤，并返回 node/plugin 的判定值。status.counts 提供 plugins_visible、github_only、plugin_nodes_visible；前两项按插件记录计算，后一项按插件节点计算。

能力文件兼容 capabilities/<category_id>.json，以及 capabilities/<category_id>/<branch_id>.json；分支 id 以 category_id. 开头时也尝试去掉前缀的文件名，完整 id 优先。文件名拒绝路径分隔符和 ..。node.capabilities 是分类级视图，branch_capabilities 来自自身或最近分支祖先；缺失均为 null。分类旧文件不存在而分类目录含分支文件时，合并各文件 union/duplicates 并标记 merged_from_branches:true。所有分支文件均进入能力文档索引，旧文件存在时也不遗漏分支索引。

详情显示可选 relevance 标签：plugin.relevance（或节点 relevance、旧字段 suspect_irrelevant:true）为 "suspect" 时显示「疑似无关」徽标（.relevance-suspect，title 为 relevance_reason）；字段缺失或为其它值时不显示、不报错。plugin.merged_from 非空时显示「已合并 N 个 GitHub 仓库」（title 列出被合并的 id）。/api/children 的插件精简字段带 relevance。status.counts 另提供 relevance_suspect（suspect 插件数）与 filtered_out（数据目录 filtered-out.jsonl 行数，文件不存在为 null）。

详情显示可选 summary_source 标签：readme→README、metadata→元数据、description_fallback→描述首句（未经模型），未知值原样显示，缺失不显示。仅 GitHub 插件显示对应徽标。

## 检索与语义后端

文档分 node/plugin/capability。全文模式用 SQLite FTS5 trigram、BM25；查询用转义引号作为字面短语，少于三个 Unicode 字符用转义 LIKE，支持短中文和特殊字符。语义降级采用英文词及中文 1–3 字符 n-gram TF-IDF 余弦。混合模式：全文名次倒数×0.55 + 语义余弦×0.45。

Transformers.js 优先 Xenova/paraphrase-multilingual-MiniLM-L12-v2，加载失败尝试 Xenova/all-MiniLM-L6-v2，再降级 TF-IDF。采用 q8、CPU、mean pooling、L2 归一化；查询只在本机推理。模型及文档输入取前 4000 字符，FTS 保留全文。

semanticBackend() 是显示名称的单一来源。status 与 search 均返回 semantic:{backend:'minilm'|'tfidf',model,label,reason}，并保留 semantic_backend=semantic.label。向量就绪时 label 为 `transformers.js MiniLM (<实际模型名>)`；其它情况显示 `TF-IDF（降级：<原因>）`，区分加载、计算进度、禁用和失败。页面头部和结果头直接显示对应响应 semantic.label。

文档向量以模型名和 SHA1(输入前4000字符)为缓存键，写入 web/.models/embeddings-<安全化模型名>.bin 与 .json 索引。bin 为 little-endian Float32，索引记录字节偏移与维度；先写临时文件再替换；有新向量时最多每 30 秒落盘一次，任务结束或快照过期时再落盘（避免每批重写约 50 MB 的 bin）。reload 复用命中向量，仅对新增/变化内容推理。embedding:{done,total,cached} 展示进度，整套向量完成前仍使用当前快照 TF-IDF。向量任务串行，快照过期时结束旧任务，避免缓存写入交错。

## 接口

- GET /api/status：加载状态、计数、语义名称、嵌入进度、timings、数据源及 warning。
- GET /api/tree?include_github_only=0|1：所有 type!=='plugin' 节点，附 plugin_count（当前过滤后直接/子孙插件数）、plugin_count_all、has_children；不返回体积巨大的 plugin_ids，改为 plugin_ids_count；edges 仅含非插件节点之间的非 parent 边。
- GET /api/children?node=<id>&include_github_only=0|1&offset=0&limit=200&around=<plugin-node-id>：直接子节点 nodes、total、offset、limit、has_more；limit 上限1000。around 将 offset 定位到目标所在页（未找到时保留 offset）。插件返回精简字段；额外 edges 提供当前页节点关联的非 parent 边，前端只绘制端点均已渲染的边。
- GET /api/graph?include_github_only=0|1：保留全图接口，默认过滤 github_only；**前端不再使用此接口**。
- GET /api/search?q=&mode=fulltext|semantic|hybrid&type=plugin|node|capability&limit=20&include_github_only=0|1：limit上限100。
- GET /api/search?node=<id>&rel=parent|children|duplicate|similar|depends|extends|all：通过邻接表查询关系。
- GET /api/node/<encodeURIComponent(id)>：完整节点/插件、README、祖先、直接子节点（最多 500 个，另给 children_total）、关系、capabilities、branch_capabilities。只有 type=plugin 的节点才关联插件记录（避免分支节点经 plugin_ids[0] 被误当成插件）。详情页对分支只列非插件子节点，并显示可见插件数。
- GET 或 POST /api/reload：异步重建，返回 ok、status 字段、timings、took_ms。

## 前端与验证

原生 JS + SVG，默认只绘制 root/category/branch。点击分支展开或折叠，并显示插件数；每次加载200个直接子节点，通过“加载更多（剩余 N）”追加。搜索结果先取 node 详情、展开祖先，再用 around 获取目标所在页，高亮并滚动定位。GitHub 开关刷新树及已展开分支，并影响搜索。关系弧线仅在两个端点都已渲染时显示。marked 与 DOMPurify 使用本地 vendor 文件，Markdown 清洗、普通字段转义。

test.mjs 在临时 fixture 副本上启动 PORT=0、禁用模型的独立服务，覆盖接口、过滤优先级、分页 around、语义名称、能力路径、重载回退恢复、缺失字段、编码 id、plugin_ids 兼容，以及 Chrome 的展开、追加、搜索定位和详情标签。ATLAS_TEST_URL 显式非空时仅对目标服务进行轻量只读检查；变量未设置时可探测4380，设为空时跳过主服务。测试不会 reload 主服务。

screenshot.mjs 默认1600×1000视口截图到 web/screenshot.png；支持 --out 文件及 --expand 分支id|auto，auto 选插件数最多的分支。仅截视口，避免全图长图。

## r3 运维备注（2026-11-11）
- 数据规模：plugins.jsonl 35,266 条（github_only 20,509，默认隐藏可见 14,757），图 35,942 节点 / 43,606 边，检索文档 75,629 篇。
- start.sh 默认以 `--max-old-space-size=8192`（可用 ATLAS_HEAP_MB 覆盖）启动；默认堆在此规模下 OOM。首次加载约 4 分钟（FTS ≈83 s、TF-IDF ≈146 s），常驻内存约 8.5 GB。
- MiniLM 依赖 web/node_modules（`npm ci` 安装 @huggingface/transformers）；node_modules 缺失时 status 显示 `TF-IDF（降级：模型失败）`。7.5 万篇首次向量计算期间显示 `TF-IDF（降级：向量计算中 x/y）`，完成后切换为 `transformers.js MiniLM (Xenova/paraphrase-multilingual-MiniLM-L12-v2)`，向量缓存在 .models/。

## r4 数据清洗（2026-11-11）
- 去重：crawler/dedup.mjs 在 analyze.mjs merge 阶段执行（plugins_base.jsonl 保持原样，可重复运行）。键为标准化 GitHub owner/name（忽略大小写、.git、末尾斜杠、http/https/www/git+/ssh 前缀与 /tree 子路径）；规则 repo / rename（本地 GitHub 缓存里的改名、转移、同 numeric id）/ homepage / owner+name。github_only 记录并入市场插件时补 stars、updated_at、README、gh_*、keywords，markets 取并集保留来源，并在 plugins.jsonl 的 merged_from 记录 {id, markets, repo, rule, key}；graph 插件节点的 merged_from 只列 id。全部合并明细在 data/dedup-merged.jsonl。
- 相关性：crawler/relevance.mjs 规则打分（0–100），强信号（DeepSeek Harness、@deepseek-ai/、dsh plugin、dsh.yml、~/.dsh、cordis 等）直接判相关；其余由 `node crawler/analyze.mjs --stage relevance`（Codex gpt-6.1-terra，data/work/relevance/rNNN.in.md/out.json，校验 + 重试）判定。irrelevant 且置信度 ≥0.8 → 移出到 data/filtered-out.jsonl（filter_reason/filter_score/filter_confidence/filter_signals）；低置信 irrelevant、uncertain、模型缺失 → 保留并标记。
- github_only 插件新增字段：`relevance`（"relevant" | "suspect"）、`relevance_score`、`relevance_reason`、`relevance_source`（rule | gpt-6.1-terra，可带 +override-keep/drop）。市场插件不带此字段。
- 恢复：`node crawler/relevance-restore.mjs <id...>|--all|--list` 写 data/relevance-overrides.json 的 keep（drop 可强制移出），然后 `node crawler/analyze.mjs --stage merge && node crawler/refresh-capabilities.mjs`。恢复的仓库标记为 suspect。
- 分类能力：crawler/capabilities-category.mjs（gpt-6.1-terra）为每个 category 节点生成 data/capabilities/<category_id>.json（generator: r4-capabilities-category）；被覆盖的旧文件先复制到 data/capabilities-legacy-r4/。
