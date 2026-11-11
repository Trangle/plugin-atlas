// 恢复被相关性过滤移出的仓库：写入 data/relevance-overrides.json 的 keep 列表，然后重新 merge。
//   node crawler/relevance-restore.mjs github:owner/repo [...]   # 恢复指定 id（恢复后标记为 relevance:"suspect"）
//   node crawler/relevance-restore.mjs --all                      # 恢复 data/filtered-out.jsonl 里的全部
//   node crawler/relevance-restore.mjs --list                     # 只列出当前被移出的 id、分数与原因
// 之后运行：node crawler/analyze.mjs --stage merge && node crawler/refresh-capabilities.mjs
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const F = path.join(ROOT, 'data', 'filtered-out.jsonl'), O = path.join(ROOT, 'data', 'relevance-overrides.json');
const filtered = fs.existsSync(F) ? fs.readFileSync(F, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const args = process.argv.slice(2);
if (!args.length || args.includes('--list')) { for (const p of filtered) console.log(`${p.id}\tscore=${p.filter_score}\tconf=${p.filter_confidence}\t${p.filter_reason}`); console.log(`共 ${filtered.length} 条`); process.exit(0); }
const ids = args.includes('--all') ? filtered.map((p) => p.id) : args;
let o = { keep: [], drop: [] }; try { o = { keep: [], drop: [], ...JSON.parse(fs.readFileSync(O, 'utf8')) }; } catch { /* new */ }
o.keep = [...new Set([...(o.keep || []), ...ids])]; o.drop = (o.drop || []).filter((x) => !ids.includes(x));
const t = O + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 1) + '\n'); fs.renameSync(t, O);
console.log(`已加入 keep：${ids.length} 个 → ${path.relative(ROOT, O)}。现在运行 node crawler/analyze.mjs --stage merge && node crawler/refresh-capabilities.mjs`);
