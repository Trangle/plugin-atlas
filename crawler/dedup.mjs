// Plugin Atlas r4：GitHub 数据去重（纯函数 + 只读本地缓存，零网络、零依赖，可重复运行）
//
// 键：标准化后的 GitHub owner/name（忽略大小写、.git 后缀、末尾斜杠、http/https/www/git+/ssh 前缀、/tree/... 子路径）。
// 合并规则（github_only 记录 G 并入「市场插件」M，或并入另一个 github_only 规范记录）：
//   1. repo         —— G 与 M 的 repo 键相同；
//   2. rename       —— GitHub 改名/转移：data/raw/github/repos/<o>__<r>.json 的 full_name 或同一 numeric repo id
//                      指向另一个键（例如 Entity-Him/dsh-doc-quick → QinpanWan/dsh-doc-quick）；
//   3. homepage     —— M 的 homepage 是 GitHub 仓库 G；或 G 的 homepage 是 npmjs.com/package/<pkg>
//                      且 M=npm:<pkg> 没有 GitHub repo 或包名与仓库名相同；
//   4. owner+name   —— G 的 owner 与 M 的 repo owner 相同，且 G 的仓库名 == M 的包名（去 scope）。
// 市场插件之间（例如 monorepo 多个 npm 包共用一个仓库）不合并。
// 合并后：M 保留 id/摘要/分类；补 stars(取大)、updated_at(取新)、readme_path(M 缺失时)、gh_* 字段、
// keywords 并集、markets 并集（保留来源），并在 merged_from 里记录 {id, markets, rule, key}。
import fs from 'node:fs';
import path from 'node:path';

export function repoKey(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (/^github:/i.test(s)) s = s.slice(7);
  s = s.replace(/^git\+/i, '').replace(/^(?:https?|git|ssh):\/\//i, '').replace(/^git@github\.com[:/]/i, 'github.com/').replace(/^www\./i, '');
  s = s.split('#')[0].split('?')[0];
  let m = s.match(/^github\.com\/([^/\s]+)\/([^/\s]+)/i);
  if (!m && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(s)) m = [null, ...s.replace(/\/$/, '').split('/')];
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const name = m[2].toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

const isGithubOnlyRaw = (p) => !p.package && !(p.markets || []).includes('index:awesome-dsh-plugin') && !(p.markets || []).some((m) => String(m).startsWith('inventory:'));
const uniq = (a) => [...new Set(a.filter((x) => x != null && x !== ''))];
const unscoped = (pkg) => String(pkg || '').split('/').pop().toLowerCase();
const keyOfRecord = (p) => repoKey(p.repo) || (String(p.id).startsWith('github:') ? repoKey(p.id) : null);

/** 读取本地 GitHub 缓存，得到 alias 键 -> 规范键（改名/转移）以及 键 -> 仓库 homepage */
export function loadGithubAliases(dataDir) {
  const alias = new Map();
  const homepage = new Map();
  const byNumeric = new Map();
  const reposDir = path.join(dataDir, 'raw', 'github', 'repos');
  const fullDir = path.join(dataDir, 'raw', 'github', 'full');
  const walk = (d) => { let out = []; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) out = out.concat(walk(f)); else if (e.name.endsWith('.json')) out.push(f); } } catch { /* none */ } return out; };
  for (const f of walk(fullDir)) {
    let doc; try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const it of doc?.items || []) {
      const k = repoKey(it.full_name); if (!k) continue;
      if (it.homepage) homepage.set(k, String(it.homepage));
      if (it.id != null) byNumeric.set(it.id, k);
    }
  }
  let files = []; try { files = fs.readdirSync(reposDir).filter((x) => x.endsWith('.json')); } catch { /* none */ }
  for (const f of files) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(reposDir, f), 'utf8')); } catch { continue; }
    if (!d || typeof d !== 'object' || !d.full_name) continue;
    const requested = repoKey(f.slice(0, -5).replace('__', '/'));
    const actual = repoKey(d.full_name);
    if (actual && d.homepage && !homepage.has(actual)) homepage.set(actual, String(d.homepage));
    if (requested && actual && requested !== actual) alias.set(requested, actual);
    if (d.id != null && byNumeric.has(d.id) && requested && byNumeric.get(d.id) !== requested) alias.set(requested, byNumeric.get(d.id));
  }
  // 解析链式 alias
  for (const [k] of alias) { let v = alias.get(k); const seen = new Set([k]); while (alias.has(v) && !seen.has(v)) { seen.add(v); v = alias.get(v); } alias.set(k, v); }
  return { alias, homepage };
}

function absorb(target, src, rule, key) {
  const ts = (x) => (x ? Date.parse(x) || 0 : 0);
  if (src.stars != null && (target.stars == null || src.stars > target.stars)) target.stars = src.stars;
  if (ts(src.updated_at) > ts(target.updated_at)) target.updated_at = src.updated_at;
  if (!target.readme_path && src.readme_path) target.readme_path = src.readme_path;
  if (!target.description && src.description) target.description = src.description;
  if (!target.homepage && src.homepage) target.homepage = src.homepage;
  for (const k of Object.keys(src)) if (k.startsWith('gh_') && target[k] == null) target[k] = src[k];
  target.keywords = uniq([...(target.keywords || []), ...(src.keywords || [])]);
  target.markets = uniq([...(target.markets || []), ...(src.markets || [])]);
  target.merged_from = [...(target.merged_from || []), { id: src.id, markets: src.markets || [], repo: src.repo || null, rule, key }];
  if (!target.repo && src.repo) target.repo = src.repo;
}

/**
 * base: plugins_base 记录数组（不修改入参）
 * 返回 { plugins, merged: [{id, into, rule, key}], stats }
 */
export function dedupPlugins(base, { dataDir } = {}) {
  const { alias, homepage } = dataDir ? loadGithubAliases(dataDir) : { alias: new Map(), homepage: new Map() };
  const canon = (k) => (k && alias.has(k) ? alias.get(k) : k);
  const recs = base.map((p) => ({ ...p }));
  const market = recs.filter((p) => !isGithubOnlyRaw(p));
  const gonly = recs.filter((p) => isGithubOnlyRaw(p));

  // 市场插件索引
  const mByRepo = new Map(); const mByHome = new Map(); const mByPkg = new Map(); const mByOwnerPkg = new Map();
  for (const m of market) {
    const k = canon(keyOfRecord(m));
    if (k && !mByRepo.has(k)) mByRepo.set(k, m);
    const hk = canon(repoKey(m.homepage));
    if (hk && hk !== k && !mByHome.has(hk)) mByHome.set(hk, m);
    if (m.package) {
      mByPkg.set(m.package.toLowerCase(), m);
      if (k) { const ok = `${k.split('/')[0]}/${unscoped(m.package)}`; if (ok !== k && !mByOwnerPkg.has(ok)) mByOwnerPkg.set(ok, m); }
    }
  }
  const merged = [];
  const stats = { input: base.length, input_github_only: gonly.length, input_market: market.length, merged_into_market: 0, merged_github_aliases: 0, by_rule: {} };
  const hit = (rule) => { stats.by_rule[rule] = (stats.by_rule[rule] || 0) + 1; };
  const keepG = new Map(); // 规范键 -> 保留的 github_only 记录
  const gSorted = gonly.slice().sort((a, b) => {
    // 规范键与自身键一致（即非旧名）的优先作为保留记录
    const ca = keyOfRecord(a) === canon(keyOfRecord(a)) ? 0 : 1; const cb = keyOfRecord(b) === canon(keyOfRecord(b)) ? 0 : 1;
    return ca - cb || String(a.id).localeCompare(String(b.id));
  });
  for (const g of gSorted) {
    const own = keyOfRecord(g); const k = canon(own);
    let target = null; let rule = null;
    if (k && mByRepo.has(k)) { target = mByRepo.get(k); rule = (own !== k || keyOfRecord(target) !== k) ? 'rename' : 'repo'; }
    else if (k && mByHome.has(k)) { target = mByHome.get(k); rule = 'homepage'; }
    else if (k) {
      const hp = homepage.get(k) || homepage.get(own) || '';
      const nm = hp.match(/npmjs\.(?:com|org)\/(?:package\/)?((?:@[^/]+\/)?[^/?#\s]+)/i);
      const m = nm ? mByPkg.get(nm[1].toLowerCase()) : null;
      if (m && (!keyOfRecord(m) || unscoped(m.package) === k.split('/')[1])) { target = m; rule = 'homepage'; }
      else if (mByOwnerPkg.has(k)) { target = mByOwnerPkg.get(k); rule = 'owner+name'; }
    }
    if (target) { absorb(target, g, rule, k); merged.push({ id: g.id, into: target.id, rule, key: k }); stats.merged_into_market++; hit(rule); continue; }
    if (k && keepG.has(k)) { const t = keepG.get(k); absorb(t, g, own !== k ? 'rename' : 'repo', k); merged.push({ id: g.id, into: t.id, rule: own !== k ? 'rename' : 'repo', key: k }); stats.merged_github_aliases++; hit('github-alias'); continue; }
    if (k) keepG.set(k, g);
  }
  const dropped = new Set(merged.map((m) => m.id));
  const plugins = recs.filter((p) => !dropped.has(p.id));
  stats.output = plugins.length;
  stats.output_github_only = plugins.filter(isGithubOnlyRaw).length;
  const marketIds = new Set(market.map((x) => x.id));
  stats.market_records_enriched = new Set(merged.filter((m) => marketIds.has(m.into)).map((m) => m.into)).size;
  return { plugins, merged, stats };
}

export { isGithubOnlyRaw };
