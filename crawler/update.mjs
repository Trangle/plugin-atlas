#!/usr/bin/env node
/**
 * Plugin Atlas 增量爬虫（Node 24 / ESM / 零第三方依赖 / 全局 fetch）
 *
 * 抓取源（见 data/markets.json、data/markets_notes.md）：
 *   1. index:awesome-dsh-plugin     https://awesome-dsh-plugin.com/plugins.json（主数据源，失败回退 jsDelivr 镜像）
 *   2. npm:dsh-plugin / npm:cordis-plugin  registry search（size=250，分页到 total 或窗口上限）
 *   3. inventory:dsh-official-on-demand    本机 dsh 安装目录 app-boot lib/index.js 常量（0 请求）
 *   4. github:blue-whale-harness           repos.txt（1 请求）
 *   5. github:dsh-plugin-hub               GitHub Search 两条查询 × 3 页 × 100（≤6 匿名请求）
 *
 * 所有网络响应缓存在 data/raw/ 下，状态写 data/raw/state.json；第二次运行只做条件请求/内容哈希比较。
 * 归一化 + 去重后输出 data/plugins_base.jsonl（字段见 CONTRACT.md，另含若干附加种子字段）。
 *
 * 用法：
 *   node crawler/update.mjs [--offline] [--readme-limit N] [--skip-github] [--help]
 * 环境变量：README_LIMIT（默认 1500）、NPM_SEARCH_WINDOW（默认 5500）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ─────────────────────────────────────────────────────────────────────────────
// 常量与参数
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const READMES_DIR = path.join(DATA_DIR, 'readmes');
const STATE_PATH = path.join(RAW_DIR, 'state.json');
const OUT_PATH = path.join(DATA_DIR, 'plugins_base.jsonl');
const REPORT_PATH = path.join(RAW_DIR, 'crawl-report.json');
const ANALYZE_PATH = path.join(__dirname, 'analyze.mjs');
const WEB_RELOAD_URL = 'http://127.0.0.1:4380/api/reload';
const WEB_STATUS_URL = 'http://127.0.0.1:4380/api/status';

const CRAWLER_VERSION = '1.0.0';
const UA = 'plugin-atlas-crawler/1.0 (+https://github.com/plugin-atlas)';

const INDEX_URL = 'https://awesome-dsh-plugin.com/plugins.json';
const INDEX_MIRROR_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json';
const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const BLUE_WHALE_URL = 'https://raw.githubusercontent.com/leenkcool/Blue-Whale-Harness/main/repos.txt';
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';

const MARKET_ORDER = [
  'index:awesome-dsh-plugin',
  'npm:dsh-plugin',
  'npm:cordis-plugin',
  'github:dsh-plugin-hub',
  'github:blue-whale-harness',
  'inventory:dsh-official-on-demand',
];

const NPM_SEARCH_WINDOW = Math.max(250, Number(process.env.NPM_SEARCH_WINDOW) || 5500);
const NPM_PAGE_SIZE = 250;
const GH_MIN_REMAINING = 5;      // 剩余请求 < 5 时停止 GitHub 请求
// 每条 GitHub 搜索查询抓几页（每页 100）：匿名固定 ≤3；有 GITHUB_TOKEN 时可用 GITHUB_SEARCH_PAGES 提到 ≤10（GitHub 搜索上限 1000 条）
const GH_SEARCH_PAGES = Math.max(1, Math.min((process.env.GITHUB_TOKEN || '').trim() ? 10 : 3, Math.floor(Number(process.env.GITHUB_SEARCH_PAGES) || 3)));
const README_CONCURRENCY = 6;    // README / package.json 抓取并发上限
const README_MAX_BYTES = 4 * 1024 * 1024;

const ARGS = parseArgs(process.argv.slice(2));

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const safeId = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');
const uniq = (arr) => [...new Set((Array.isArray(arr) ? arr : []).filter((v) => v != null && v !== ''))];
const isEmptyValue = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJsonFile(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
/** 同目录 tmp 文件 + fsync + rename，保证 data/*.jsonl、data/*.json 不会写出半截 */
function writeFileAtomic(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, p);
  } catch (e) {
    try { if (fd != null) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}
function writeJsonAtomic(p, obj) { writeFileAtomic(p, JSON.stringify(obj, null, 1) + '\n'); }

// ── 可选 GitHub token（只从环境变量 GITHUB_TOKEN 读取；绝不打印/写日志/写盘）──
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const GITHUB_AUTH_MODE = GITHUB_TOKEN ? 'token' : 'anonymous';
/** 把任何输出里可能出现的 token 脱敏 */
function redact(v) {
  let t = typeof v === 'string' ? v : (v instanceof Error ? (v.stack || v.message) : (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)));
  if (GITHUB_TOKEN) t = t.split(GITHUB_TOKEN).join('***');
  return t.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***').replace(/(authorization:\s*)(bearer|token)\s+\S+/gi, '$1$2 ***');
}
/** 只给 api.github.com 的请求加 Authorization 头（raw.githubusercontent / npm / jsDelivr 一律不带） */
function githubAuthHeaders(url) {
  if (!GITHUB_TOKEN) return {};
  try { if (new URL(url).hostname !== 'api.github.com') return {}; } catch { return {}; }
  return { authorization: `Bearer ${GITHUB_TOKEN}` };
}
function log(...a) { console.log(...a.map((x) => (typeof x === 'string' ? redact(x) : x))); }
function warn(...a) { console.warn('[warn]', ...a.map((x) => redact(x))); }

function parseArgs(argv) {
  const opts = {
    offline: false,
    skipGithub: false,
    readmeLimit: Number(process.env.README_LIMIT) > 0 ? Math.floor(Number(process.env.README_LIMIT)) : 1500,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--skip-github') opts.skipGithub = true;
    else if (a === '--github-full') opts.githubFull = true;
    else if (a === '--no-analyze') opts.noAnalyze = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--readme-limit') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error('--readme-limit 需要一个非负整数');
      opts.readmeLimit = Math.floor(n);
    } else if (a.startsWith('--readme-limit=')) {
      const n = Number(a.slice('--readme-limit='.length));
      if (!Number.isFinite(n) || n < 0) throw new Error('--readme-limit 需要一个非负整数');
      opts.readmeLimit = Math.floor(n);
    } else {
      warn(`忽略未知参数: ${a}`);
    }
  }
  return opts;
}

function printHelp() {
  log(`Plugin Atlas 增量爬虫 v${CRAWLER_VERSION}

用法: node crawler/update.mjs [选项]

选项:
  --offline            只用 data/raw/ 已有缓存重建 data/plugins_base.jsonl，不发起任何网络请求
  --readme-limit N     只抓取 (downloads, stars) 排名前 N 的插件 README（默认 env README_LIMIT 或 1500）
  --skip-github        跳过两个 GitHub 市场（blue-whale repos.txt 与 dsh-plugin-hub search）
  -h, --help           显示帮助

环境变量:
  README_LIMIT         --readme-limit 的默认值（1500）
  NPM_SEARCH_WINDOW    npm search 深分页窗口上限（默认 5500）

输出:
  data/plugins_base.jsonl   合并去重后的插件基础数据（CONTRACT.md fields + 种子附加字段）
  data/raw/state.json       缓存/增量状态（etag、last-modified、版本、README 状态）
  data/raw/crawl-report.json 本次运行统计
  data/plugins.jsonl / data/graph.json  若 data/work 已有分析结果，结束时自动增量 merge 并 reload
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 全局统计与状态
// ─────────────────────────────────────────────────────────────────────────────

const stats = {
  started_at: nowIso(),
  finished_at: null,
  mode: ARGS.offline ? 'offline' : 'online',
  github_enabled: !ARGS.skipGithub,
  readme_limit: ARGS.readmeLimit,
  requests: 0,
  http_200: 0,
  http_304: 0,
  http_unchanged: 0,
  http_404: 0,
  http_error: 0,
  cache_hits: 0,
  stale_cache_hits: 0,
  bytes_downloaded: 0,
  status_counts: {}, // 所有 HTTP 响应的状态码分布（含 README / package.json 请求）
  readme: { targets: 0, written: 0, cached: 0, none: 0, error: 0, offline_skipped: 0 },
  package_json: { targets: 0, written: 0, cached: 0, none: 0, error: 0 },
  github: {
    requests: 0,
    pages_from_cache: 0,
    remaining: null,
    limit: null,
    reset: null,
    rate_limited: false,
    stopped_early: false,
  },
  markets: {},
  records: { total: 0, with_npm: 0, github_only: 0, skipped_no_id: 0 },
  output: { path: 'data/plugins_base.jsonl', lines: 0, bytes: 0, readme_paths: 0, skipped_no_id: 0 },
};

let state = readJsonFile(STATE_PATH, null);
if (!isPlainObject(state)) state = {};
state.schema_version = 1;
state.crawler_version = CRAWLER_VERSION;
if (!isPlainObject(state.http)) state.http = {};
if (!isPlainObject(state.markets)) state.markets = {};
if (!isPlainObject(state.readmes)) state.readmes = {};
if (!isPlainObject(state.pkgjs)) state.pkgjs = {};
if (!isPlainObject(state.github)) state.github = {};

let stateDirty = false;
let lastStateSave = 0;
function scheduleStateSave() {
  stateDirty = true;
  const t = Date.now();
  if (t - lastStateSave > 2000) writeStateNow();
}
function writeStateNow() {
  state.saved_at = nowIso();
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 1));
  lastStateSave = Date.now();
  stateDirty = false;
}
function flushState() { if (stateDirty || lastStateSave === 0) writeStateNow(); }

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + 缓存（etag / last-modified / sha256 内容对比）
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOnce(url, headers, timeoutMs) {
  stats.requests++;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    stats.status_counts.error = (stats.status_counts.error || 0) + 1;
    throw e;
  }
  stats.status_counts[res.status] = (stats.status_counts[res.status] || 0) + 1;
  return res;
}

/**
 * 单次请求（含 429/5xx/网络错误的重试）。返回 {status, headers, buffer, error}。
 * 304 时 buffer 为空；413 表示超过 maxBytes。
 */
async function request(url, { headers = {}, timeoutMs = 25000, retries = 1, maxBytes = 0 } = {}) {
  const allHeaders = { 'user-agent': UA, ...headers, ...githubAuthHeaders(url) };
  let res = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      res = await fetchOnce(url, allHeaders, timeoutMs);
    } catch (e) {
      res = null;
      lastErr = e;
    }
    const retryable = !res || res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (!retryable) break;
    if (res && res.status === 429) {
      // 尊重 Retry-After；否则指数退避
      let wait = 0;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) wait = ra * 1000;
      else wait = Math.min(2000 * 2 ** attempt, 12000) + Math.floor(Math.random() * 500);
      try { await res.body?.cancel(); } catch { /* ignore */ }
      if (attempt < retries) await sleep(wait);
      continue;
    }
    if (attempt < retries) await sleep(1000 * (attempt + 1));
  }
  if (!res) return { status: 0, buffer: Buffer.alloc(0), headers: {}, error: redact(String(lastErr || 'fetch failed')) };

  const headersObj = {};
  for (const [k, v] of res.headers.entries()) headersObj[k.toLowerCase()] = v;

  if (res.status === 304) return { status: 304, buffer: Buffer.alloc(0), headers: headersObj };
  if (maxBytes > 0 && Number(res.headers.get('content-length') || 0) > maxBytes) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { status: 413, tooLarge: true, buffer: Buffer.alloc(0), headers: headersObj };
  }
  let buffer = Buffer.alloc(0);
  try {
    buffer = Buffer.from(await res.arrayBuffer());
    if (res.status >= 200 && res.status < 300) stats.bytes_downloaded += buffer.length;
  } catch { /* 204 等无 body */ }
  return { status: res.status, buffer, headers: headersObj };
}

/**
 * 带本地缓存的 GET。
 *  - 有 etag/last-modified → 条件请求；304 直接复用缓存
 *  - 200 → 与缓存 sha256 比较，内容一致则标记 unchanged（不重写文件）
 *  - 网络失败且已有缓存 → 回退旧缓存（stale）
 */
async function fetchCached({ key, url, file, headers = {}, timeoutMs = 30000, retries = 1, maxBytes = 0 }) {
  const abs = path.join(ROOT, file);
  const meta = state.http[key] || null;
  const hasFile = exists(abs);

  if (ARGS.offline) {
    if (hasFile) {
      stats.cache_hits++;
      return { status: 200, buffer: fs.readFileSync(abs), headers: {}, cached: true, unchanged: true };
    }
    stats.http_error++;
    return { status: 0, error: 'offline cache miss', missing: true };
  }

  const reqHeaders = { ...headers };
  if (hasFile && meta?.etag) reqHeaders['if-none-match'] = meta.etag;
  else if (hasFile && meta?.last_modified) reqHeaders['if-modified-since'] = meta.last_modified;

  const r = await request(url, { headers: reqHeaders, timeoutMs, retries, maxBytes });

  if (r.status === 304 && hasFile) {
    stats.http_304++;
    state.http[key] = { ...(meta || {}), url, file, status: 304, fetched_at: nowIso(), checked_at: nowIso() };
    scheduleStateSave();
    return { status: 304, buffer: fs.readFileSync(abs), headers: r.headers, cached: true, notModified: true };
  }

  if (r.status === 200) {
    const buf = r.buffer;
    const hash = sha256(buf);
    const unchanged = hasFile && meta?.sha256 === hash;
    if (!unchanged) writeFileAtomic(abs, buf);
    state.http[key] = {
      url,
      file,
      status: 200,
      etag: r.headers.etag || meta?.etag || null,
      last_modified: r.headers['last-modified'] || meta?.last_modified || null,
      fetched_at: nowIso(),
      sha256: hash,
      size: buf.length,
    };
    if (unchanged) stats.http_unchanged++; else stats.http_200++;
    scheduleStateSave();
    return { status: 200, buffer: buf, headers: r.headers, cached: unchanged, unchanged };
  }

  if (r.status === 404 || r.status === 410) {
    stats.http_404++;
    state.http[key] = { url, file, status: r.status, fetched_at: nowIso() };
    scheduleStateSave();
    return { status: r.status, buffer: null, headers: r.headers, notFound: true };
  }

  stats.http_error++;
  const err = r.error || `HTTP ${r.status}`;
  if (hasFile) {
    stats.stale_cache_hits++;
    state.http[key] = { ...(meta || {}), url, file, stale: true, last_error: err, checked_at: nowIso() };
    scheduleStateSave();
    return { status: 200, buffer: fs.readFileSync(abs), headers: r.headers, cached: true, stale: true, error: err };
  }
  return { status: r.status || 0, buffer: null, headers: r.headers, error: err };
}

// ─────────────────────────────────────────────────────────────────────────────
// URL / 名称归一化
// ─────────────────────────────────────────────────────────────────────────────

function normalizeRepoUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (/^github:/i.test(s)) s = `https://github.com/${s.slice(7)}`;
  s = s.replace(/^git\+/, '');
  // git@github.com:owner/repo.git
  const ssh = s.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/i);
  if (ssh) s = `https://${ssh[1]}/${ssh[2].replace(/\.git$/, '')}`;
  // GitHub 仓库地址统一成 https://github.com/<owner>/<repo>（去掉 /tree/<branch>/<subdir> 等路径）
  const gh = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (gh) return `https://github.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}`;
  s = s.replace(/\.git$/, '').replace(/\/$/, '');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return `https://github.com/${s}`;
  return s;
}

function repoSlug(repoUrlOrSlug) {
  if (!repoUrlOrSlug) return null;
  let s = String(repoUrlOrSlug).trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
  const m = s.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (m) return `${m[1]}/${m[2]}`;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return s;
  return null;
}

function jsdelivrPkgBase(pkg, version) {
  const p = String(pkg);
  return version
    ? `https://cdn.jsdelivr.net/npm/${p}@${encodeURIComponent(version)}`
    : `https://cdn.jsdelivr.net/npm/${p}`;
}
function jsdelivrFileUrl(pkg, version, filename) { return `${jsdelivrPkgBase(pkg, version)}/${filename}`; }
function registryPackumentUrl(pkg) {
  const p = String(pkg);
  return `https://registry.npmjs.org/${p.startsWith('@') ? p.replace('/', '%2f') : p}`;
}
function registryVersionUrl(pkg, version) {
  return `https://registry.npmjs.org/${String(pkg).startsWith('@') ? String(pkg).replace('/', '%2f') : pkg}/${encodeURIComponent(version)}`;
}

function isDshDepName(name) {
  return /^@deepseek-ai\//.test(name) || /^dsh-/.test(name) || /^cordis-/.test(name) || /^@cordis\//.test(name);
}
function sortMarkets(markets) {
  const set = new Set(markets || []);
  const ordered = MARKET_ORDER.filter((m) => set.has(m));
  for (const m of set) if (!ordered.includes(m)) ordered.push(m);
  return ordered;
}

// ─────────────────────────────────────────────────────────────────────────────
// 源 1：index:awesome-dsh-plugin（plugins.json，主数据源，失败回退 jsDelivr）
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCatalogIndex() {
  const marketId = 'index:awesome-dsh-plugin';
  const t0 = Date.now();
  const before = { req: stats.requests, nm: stats.http_304, un: stats.http_unchanged };

  let data = null;
  let source = 'awesome-dsh-plugin.com';
  let mirrorUsed = false;

  const r = await fetchCached({
    key: 'index:awesome-dsh-plugin',
    url: INDEX_URL,
    file: 'data/raw/index/awesome-plugins.json',
  });
  if (r.buffer) {
    try { data = JSON.parse(r.buffer.toString('utf8')); } catch (e) { warn(`plugins.json 解析失败: ${e.message}`); }
  }
  if (!data || !Array.isArray(data.plugins) || data.plugins.length === 0) {
    warn('主数据源不可用，回退 jsDelivr 镜像 dsh-plugin-catalog/plugins.json');
    mirrorUsed = true;
    source = 'cdn.jsdelivr.net/npm/dsh-plugin-catalog';
    const r2 = await fetchCached({
      key: 'index:awesome-dsh-plugin:mirror',
      url: INDEX_MIRROR_URL,
      file: 'data/raw/index/awesome-plugins-mirror.json',
    });
    if (r2.buffer) {
      try { data = JSON.parse(r2.buffer.toString('utf8')); } catch (e) { warn(`镜像 plugins.json 解析失败: ${e.message}`); }
    }
  }

  const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
  stats.markets[marketId] = {
    records: plugins.length,
    requests: stats.requests - before.req,
    not_modified: stats.http_304 - before.nm,
    unchanged: stats.http_unchanged - before.un,
    source,
    mirror_fallback: mirrorUsed,
    catalog_updated: data?.updated || null,
    catalog_count: data?.count ?? null,
    elapsed_ms: Date.now() - t0,
  };
  state.markets[marketId] = {
    fetched_at: nowIso(),
    source,
    mirror_fallback: mirrorUsed,
    catalog_updated: data?.updated || null,
    catalog_count: data?.count ?? null,
    records: plugins.length,
  };
  log(`[index] ${plugins.length} 条（source=${source}${mirrorUsed ? '，镜像回退' : ''}，catalog.updated=${data?.updated || '?'}）`);
  return plugins;
}

// ─────────────────────────────────────────────────────────────────────────────
// 源 2：npm registry search（size=250 分页，本地校验 keywords）
// ─────────────────────────────────────────────────────────────────────────────

async function fetchNpmSearch(marketId, keyword) {
  const t0 = Date.now();
  const before = { req: stats.requests, nm: stats.http_304, un: stats.http_unchanged };
  const dir = `data/raw/npm-search/${marketId.replace(/[^A-Za-z0-9.-]+/g, '_')}`;
  const packages = new Map(); // lower name -> search object
  let total = null;
  let pages = 0;
  let fetchedObjects = 0;
  let validated = 0;
  let pageErrors = 0;
  let from = 0;

  while (from < NPM_SEARCH_WINDOW) {
    if (total != null && from >= total) break;
    if (from > 0 && !ARGS.offline) await sleep(500); // 控制请求速率，避免 registry 429（离线不等待）
    const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(`keywords:${keyword}`)}&size=${NPM_PAGE_SIZE}&from=${from}`;
    const file = `${dir}/page-${String(from).padStart(6, '0')}.json`;
    const r = await fetchCached({ key: `npm-search:${marketId}:${from}`, url, file, headers: { accept: 'application/json' }, retries: 4 });
    if (!r.buffer) {
      pageErrors++;
      warn(`[${marketId}] from=${from} 抓取失败（${r.error || r.status}），停止该市场分页`);
      break;
    }
    let d;
    try { d = JSON.parse(r.buffer.toString('utf8')); } catch (e) {
      pageErrors++;
      warn(`[${marketId}] from=${from} JSON 解析失败: ${e.message}`);
      break;
    }
    pages++;
    if (total == null) {
      total = typeof d.total === 'number' ? d.total : null;
      log(`[${marketId}] total=${total}，窗口上限 ${NPM_SEARCH_WINDOW}`);
    }
    const objects = Array.isArray(d.objects) ? d.objects : [];
    fetchedObjects += objects.length;
    for (const obj of objects) {
      const pkg = obj?.package;
      if (!pkg?.name) continue;
      const kws = Array.isArray(pkg.keywords) ? pkg.keywords.map((k) => String(k).toLowerCase()) : [];
      if (!kws.includes(keyword)) continue; // 本地校验 keywords，过滤模糊匹配
      validated++;
      const key = pkg.name.toLowerCase();
      const prev = packages.get(key);
      if (!prev || (obj.downloads?.monthly || 0) > (prev.downloads?.monthly || 0)) packages.set(key, obj);
    }
    if (objects.length < NPM_PAGE_SIZE) break; // 结果不足一页 → 到底
    from += NPM_PAGE_SIZE;
  }

  const pageCount = pages;
  stats.markets[marketId] = {
    records: packages.size,
    requests: stats.requests - before.req,
    not_modified: stats.http_304 - before.nm,
    unchanged: stats.http_unchanged - before.un,
    total,
    pages: pageCount,
    fetched_objects: fetchedObjects,
    validated,
    page_errors: pageErrors,
    window_cap: NPM_SEARCH_WINDOW,
    keyword,
    elapsed_ms: Date.now() - t0,
  };
  state.markets[marketId] = {
    fetched_at: nowIso(),
    keyword,
    total,
    pages: pageCount,
    fetched_objects: fetchedObjects,
    validated,
    unique: packages.size,
    window_cap: NPM_SEARCH_WINDOW,
  };
  log(`[${marketId}] ${packages.size} 个包（pages=${pageCount}, 返回对象=${fetchedObjects}, 校验通过=${validated}）`);
  return packages;
}

// ─────────────────────────────────────────────────────────────────────────────
// 源 3：inventory:dsh-official-on-demand（本机 dsh 安装包常量，0 请求）
// ─────────────────────────────────────────────────────────────────────────────

function extractConstArray(text, name) {
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`);
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '[') return null;
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const literal = text.slice(i, j + 1);
        // 只解析本机 dsh 安装目录中的可信常量字面量
        return new Function(`"use strict"; return (${literal});`)();
      }
    }
  }
  return null;
}

function findAppBoot() {
  const rel = 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
  const roots = [];
  if (process.env.DSH_INSTALL_ROOT) roots.push(process.env.DSH_INSTALL_ROOT);
  try {
    const which = execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) {
      let real = which;
      try { real = fs.realpathSync(which); } catch { /* keep */ }
      const m = real.match(/^(.*?)\/lib\/node_modules\/@deepseek-ai\/dsh\//);
      if (m) roots.push(m[1]);
      const binIdx = real.indexOf('/bin/dsh');
      if (binIdx > 0) roots.push(real.slice(0, binIdx));
    }
  } catch { /* dsh 未在 PATH，忽略 */ }
  roots.push(path.join(os.homedir(), '.local/opt/dsh'), '/usr/local', '/opt/dsh', '/usr');

  const candidates = roots.map((r) => path.join(r, rel));
  candidates.push(path.join(ROOT, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'));

  for (const idx of candidates) {
    if (!exists(idx)) continue;
    let version = null;
    try {
      const dshPkg = path.resolve(path.dirname(idx), '../../../../package.json');
      version = readJsonFile(dshPkg, null)?.version || null;
    } catch { /* ignore */ }
    return { indexPath: idx, version };
  }
  return null;
}

function loadInventory() {
  const marketId = 'inventory:dsh-official-on-demand';
  const t0 = Date.now();
  const cacheRel = 'data/raw/inventory/dsh-official-on-demand.json';
  const cacheAbs = path.join(ROOT, cacheRel);
  const found = findAppBoot();
  let entries = null;
  let dshVersion = null;
  let source = null;

  if (found) {
    try {
      const text = fs.readFileSync(found.indexPath, 'utf8');
      const catalog = extractConstArray(text, 'OFFICIAL_ON_DEMAND_CATALOG');
      const onDemand = extractConstArray(text, 'ON_DEMAND_BUNDLES');
      if (Array.isArray(catalog)) {
        entries = catalog;
        dshVersion = found.version;
        source = found.indexPath;
        writeJsonAtomic(cacheAbs, {
          dsh_version: dshVersion,
          source,
          extracted_at: nowIso(),
          catalog: entries,
          on_demand_bundles: Array.isArray(onDemand) ? onDemand : [],
        });
      }
    } catch (e) {
      warn(`读取本机 app-boot 常量失败: ${e.message}`);
    }
  }

  if (!entries && exists(cacheAbs)) {
    const cached = readJsonFile(cacheAbs, null);
    if (Array.isArray(cached?.catalog)) {
      entries = cached.catalog;
      dshVersion = cached.dsh_version || null;
      source = `cache:${cacheRel}`;
      warn('未找到本机 dsh 安装目录，使用上次提取的 inventory 缓存');
    }
  }
  if (!entries) {
    warn('inventory:dsh-official-on-demand 为空（本机未找到 dsh-app-boot 常量，也无缓存）');
    entries = [];
  }

  stats.markets[marketId] = {
    records: entries.length,
    requests: 0,
    dsh_version: dshVersion,
    source,
    elapsed_ms: Date.now() - t0,
  };
  state.markets[marketId] = { fetched_at: nowIso(), dsh_version: dshVersion, source, records: entries.length };
  log(`[inventory] ${entries.length} 条官方 on-demand bundle（dsh ${dshVersion || '?'}，0 请求）`);
  return { entries, dshVersion };
}

// ─────────────────────────────────────────────────────────────────────────────
// 源 4：github:blue-whale-harness（repos.txt，1 请求）
// ─────────────────────────────────────────────────────────────────────────────

async function fetchBlueWhale() {
  const marketId = 'github:blue-whale-harness';
  const t0 = Date.now();
  const before = { req: stats.requests, nm: stats.http_304, un: stats.http_unchanged };
  const r = await fetchCached({
    key: 'github:blue-whale-repos',
    url: BLUE_WHALE_URL,
    file: 'data/raw/github/blue-whale-repos.txt',
    headers: { accept: 'text/plain' },
  });
  const repos = [];
  const seen = new Set();
  if (r.buffer) {
    const lines = r.buffer.toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const slug = repoSlug(t);
      if (!slug) continue;
      const key = slug.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(slug);
    }
  } else {
    warn(`[blue-whale] repos.txt 获取失败（${r.error || r.status}）`);
  }
  stats.markets[marketId] = {
    records: repos.length,
    requests: stats.requests - before.req,
    not_modified: stats.http_304 - before.nm,
    unchanged: stats.http_unchanged - before.un,
    elapsed_ms: Date.now() - t0,
  };
  state.markets[marketId] = { fetched_at: nowIso(), records: repos.length };
  log(`[blue-whale] ${repos.length} 个 repo`);
  return repos;
}

// ─────────────────────────────────────────────────────────────────────────────
// 源 5：github:dsh-plugin-hub（GitHub Search 两条查询 × 3 页 × 100）
// ─────────────────────────────────────────────────────────────────────────────

const GH_QUERIES = [
  { slug: 'topic-dsh-plugin', q: 'topic:dsh-plugin' },
  { slug: 'name-desc-dsh-plugin', q: '"dsh-plugin" in:name,description' },
];

function ghRateFromHeaders(headers) {
  const rem = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  const resource = headers['x-ratelimit-resource'];
  if (rem == null) return;
  if (resource != null && resource !== 'search') return;
  state.github.remaining = Number(rem);
  state.github.auth_mode = GITHUB_AUTH_MODE; // 只记录模式，不记录 token
  state.github.limit = headers['x-ratelimit-limit'] != null ? Number(headers['x-ratelimit-limit']) : state.github.limit;
  state.github.reset = reset != null ? Number(reset) : state.github.reset;
  stats.github.remaining = state.github.remaining;
  stats.github.limit = state.github.limit;
  stats.github.reset = state.github.reset;
}

function ghRateOk() {
  const rem = state.github.remaining;
  const reset = state.github.reset;
  if (rem == null) return true; // 未知 → 先请求一次
  if (rem >= GH_MIN_REMAINING) return true;
  if (reset && Date.now() / 1000 >= reset) return true; // 窗口已重置
  return false;
}

async function fetchGithubHub() {
  const marketId = 'github:dsh-plugin-hub';
  const t0 = Date.now();
  const before = { req: stats.requests, nm: stats.http_304, un: stats.http_unchanged };
  const items = new Map(); // lower full_name -> item
  let pagesNetwork = 0;
  let pagesUsed = 0;
  let totalCount = null;
  let stoppedEarly = false;
  const perQuery = [];

  const addItems = (d) => {
    const arr = Array.isArray(d?.items) ? d.items : [];
    for (const item of arr) {
      if (!item?.full_name) continue;
      const key = item.full_name.toLowerCase();
      const prev = items.get(key);
      if (!prev || (item.stargazers_count || 0) > (prev.stargazers_count || 0)) items.set(key, item);
    }
    return Array.isArray(d?.items) ? d.items.length : 0;
  };

  for (const query of GH_QUERIES) {
    let qTotal = null;
    let qPages = 0;
    for (let page = 1; page <= GH_SEARCH_PAGES; page++) {
      const key = `github:search:${query.slug}:page-${page}`;
      const file = `data/raw/github/search/${query.slug}-p${page}.json`;
      const hasCache = exists(path.join(ROOT, file));

      if (!ghRateOk()) {
        // 剩余额度不足：停止请求并记录；已有缓存仍然复用（保证重建数据完整）
        stoppedEarly = true;
        if (hasCache) {
          const d = readJsonFile(path.join(ROOT, file), null);
          if (d) {
            addItems(d);
            if (page === 1 && qTotal == null) qTotal = d.total_count ?? null;
            if (totalCount == null) totalCount = d.total_count ?? null;
            qPages++;
            pagesUsed++;
            stats.github.pages_from_cache++;
          }
        }
        continue;
      }

      const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(query.q)}&per_page=100&page=${page}&sort=stars&order=desc`;
      stats.github.requests++;
      const r = await fetchCached({
        key,
        url,
        file,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        timeoutMs: 25000,
        retries: 1,
      });
      ghRateFromHeaders(r.headers || {});
      if (r.buffer) {
        let d = null;
        try { d = JSON.parse(r.buffer.toString('utf8')); } catch (e) { warn(`[github] ${query.slug} p${page} JSON 解析失败: ${e.message}`); }
        if (d) {
          addItems(d);
          if (page === 1) qTotal = d.total_count ?? null;
          if (totalCount == null) totalCount = d.total_count ?? null;
          pagesNetwork++;
          pagesUsed++;
          qPages++;
        }
      } else if (!r.notModified && !r.cached) {
        warn(`[github] ${query.slug} p${page} 获取失败（${r.error || r.status}）`);
      }

      if (!ghRateOk()) stoppedEarly = true;
    }
    perQuery.push({ query: query.q, pages: qPages, total_count: qTotal });
  }

  stats.github.stopped_early = stoppedEarly;
  stats.github.rate_limited = stoppedEarly;
  stats.markets[marketId] = {
    records: items.size,
    requests: stats.requests - before.req,
    not_modified: stats.http_304 - before.nm,
    unchanged: stats.http_unchanged - before.un,
    pages: pagesNetwork,
    pages_used: pagesUsed,
    total_count: totalCount,
    stopped_early: stoppedEarly,
    rate_limit_remaining: state.github.remaining,
    queries: perQuery,
    elapsed_ms: Date.now() - t0,
  };
  state.github.last_run = {
    at: nowIso(),
    pages: pagesUsed,
    pages_network: pagesNetwork,
    items: items.size,
    total_count: totalCount,
    stopped_early: stoppedEarly,
    remaining: state.github.remaining,
    limit: state.github.limit,
    reset: state.github.reset,
    queries: perQuery,
  };
  state.markets[marketId] = {
    fetched_at: nowIso(),
    records: items.size,
    pages: pagesNetwork,
    pages_used: pagesUsed,
    total_count: totalCount,
    stopped_early: stoppedEarly,
    rate_limit_remaining: state.github.remaining,
  };
  log(`[github-hub] ${items.size} 个 repo（pages=${pagesNetwork}${pagesUsed !== pagesNetwork ? `，缓存复用页=${pagesUsed - pagesNetwork}` : ''}, total_count=${totalCount ?? '?'}, rate_remaining=${state.github.remaining ?? '?'}${stoppedEarly ? '，已按限频提前停止' : ''}）`);
  return [...items.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// 候选记录构造（按市场）
// ─────────────────────────────────────────────────────────────────────────────

function candidateFromCatalog(p) {
  const repoUrl = normalizeRepoUrl(p.url);
  const slug = repoSlug(repoUrl) || (p.owner && p.name ? `${p.owner}/${p.name}` : null);
  const repo = slug ? `https://github.com/${slug}` : null;
  const caps = Array.isArray(p.capabilities) ? p.capabilities.map(String) : [];
  return {
    __market: 'index:awesome-dsh-plugin',
    name: p.name || null,
    package: p.npm || null,
    version: p.version || null,
    description: p.description?.zh || p.description?.en || null,
    description_en: p.description?.en || null,
    repo,
    homepage: null,
    keywords: [],
    author: p.owner || null,
    stars: Number.isFinite(p.stars) ? p.stars : null,
    updated_at: p.capabilityCheckedAt || p.downloadsCheckedAt || null,
    markets: ['index:awesome-dsh-plugin'],
    category_id: p.category || null,
    capabilities: caps,           // 种子：catalog 能力标注（分析阶段可覆盖）
    seed_category: p.category || null,
    catalog_capabilities: caps,
    capability_red_lines: Array.isArray(p.capabilityRedLines) ? p.capabilityRedLines.map(String) : [],
    downloads: Number.isFinite(p.downloads) ? p.downloads : null,
    install: p.install || null,
  };
}

function candidateFromNpmSearch(obj, marketId) {
  const pkg = obj?.package || {};
  const links = pkg.links || {};
  let repo = normalizeRepoUrl(links.repository);
  if (!repo) repo = normalizeRepoUrl(pkg.repository?.url || pkg.repository);
  return {
    __market: marketId,
    name: pkg.name || null,
    package: pkg.name || null,
    version: pkg.version || null,
    description: pkg.description || null,
    description_en: null,
    repo,
    homepage: links.homepage || null,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.map(String) : [],
    author: pkg.publisher?.username || pkg.maintainers?.[0]?.username || null,
    stars: null,
    updated_at: pkg.date || obj.updated || null,
    markets: [marketId],
    downloads: Number.isFinite(obj?.downloads?.monthly) ? obj.downloads.monthly : null,
    install: null,
  };
}

function candidateFromGithubItem(item, marketId) {
  return {
    __market: marketId,
    name: item.full_name || null,
    package: null,
    version: null,
    description: item.description || null,
    description_en: null,
    repo: item.html_url || (item.full_name ? `https://github.com/${item.full_name}` : null),
    homepage: item.homepage || null,
    keywords: Array.isArray(item.topics) ? item.topics.map(String) : [],
    author: item.owner?.login || null,
    stars: Number.isFinite(item.stargazers_count) ? item.stargazers_count : null,
    updated_at: item.pushed_at || item.updated_at || null,
    markets: [marketId],
    install: null,
  };
}

function candidateFromBlueWhale(slug, marketId) {
  return {
    __market: marketId,
    name: slug,
    package: null,
    version: null,
    description: null,
    description_en: null,
    repo: `https://github.com/${slug}`,
    homepage: null,
    keywords: [],
    author: slug.split('/')[0],
    stars: null,
    updated_at: null,
    markets: [marketId],
    install: null,
  };
}

function candidateFromInventory(entry, marketId, dshVersion) {
  const pkgName = entry.packageName;
  if (!pkgName) return null;
  const meta = entry.meta || {};
  return {
    __market: marketId,
    name: meta.title?.zh || meta.title?.en || pkgName,
    package: pkgName,
    version: dshVersion || null,
    description: meta.description?.zh || meta.description?.en || null,
    description_en: meta.description?.en || null,
    repo: null,
    homepage: null,
    keywords: [],
    author: 'DeepSeek',
    stars: null,
    updated_at: null,
    markets: [marketId],
    install: dshVersion ? `dsh plugin add ${pkgName}@${dshVersion}` : `dsh plugin add ${pkgName}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 合并去重（notes §4：npm 包优先作 id；同一条目合并 markets[]；目录信息优先）
// ─────────────────────────────────────────────────────────────────────────────

const ARRAY_UNION_FIELDS = new Set(['keywords', 'provides', 'tools', 'deps_dsh', 'capabilities', 'catalog_capabilities', 'capability_red_lines']);

function createStore() {
  return { records: [], byPackage: new Map(), byRepo: new Map() };
}

function mergeCandidate(rec, cand) {
  for (const [k, v] of Object.entries(cand)) {
    if (k.startsWith('__') || k === 'markets') continue;
    if (ARRAY_UNION_FIELDS.has(k)) {
      rec[k] = uniq([...(rec[k] || []), ...(Array.isArray(v) ? v : [])]);
    } else if (isEmptyValue(rec[k]) && !isEmptyValue(v)) {
      rec[k] = v;
    }
  }
  rec.markets = uniq([...(rec.markets || []), ...(cand.markets || [])]);
}

function indexRecord(store, rec) {
  if (rec.package) store.byPackage.set(rec.package.toLowerCase(), rec);
  if (rec.repo) {
    const slug = repoSlug(rec.repo);
    if (slug) store.byRepo.set(slug.toLowerCase(), rec);
  }
}

function addCandidate(store, cand) {
  if (!cand) return;
  const pkgKey = cand.package ? cand.package.toLowerCase() : null;
  const slug = cand.repo ? repoSlug(cand.repo) : null;
  const slugKey = slug ? slug.toLowerCase() : null;

  let rec = null;
  if (pkgKey) {
    rec = store.byPackage.get(pkgKey) || null;
    if (!rec && slugKey) {
      const byRepo = store.byRepo.get(slugKey);
      // 仅在对方没有 npm 包（或就是同一个包）时按 repo 合并，避免 monorepo 多插件被折叠
      if (byRepo && (!byRepo.package || byRepo.package.toLowerCase() === pkgKey)) rec = byRepo;
    }
  } else if (slugKey) {
    rec = store.byRepo.get(slugKey) || null;
  }
  if (!rec) {
    rec = { markets: [] };
    store.records.push(rec);
  }
  mergeCandidate(rec, cand);
  indexRecord(store, rec);
}

function deriveId(rec) {
  if (rec.package) return `npm:${rec.package}`;
  const slug = repoSlug(rec.repo);
  return slug ? `github:${slug}` : null;
}

function normalizeTimestamp(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function finalizeRecord(rec, crawlTime) {
  const id = deriveId(rec);
  if (!id) return null;
  const slug = repoSlug(rec.repo);
  return {
    id,
    name: rec.name || rec.package || slug || id,
    package: rec.package || null,
    version: rec.version || null,
    markets: sortMarkets(rec.markets),
    description: rec.description || '',
    repo: rec.repo || (slug ? `https://github.com/${slug}` : null),
    homepage: rec.homepage || null,
    keywords: uniq(rec.keywords || []),
    author: rec.author || null,
    stars: Number.isFinite(rec.stars) ? Math.trunc(rec.stars) : null,
    updated_at: normalizeTimestamp(rec.updated_at) || crawlTime,
    readme_path: null,
    provides: uniq(rec.provides || []),
    tools: uniq(rec.tools || []),
    deps_dsh: uniq(rec.deps_dsh || []),
    category_id: rec.category_id || null,
    summary: null,
    capabilities: uniq(rec.capabilities || []),
    // ── 附加种子字段（CONTRACT 允许附加字段）──
    seed_category: rec.seed_category || null,
    catalog_capabilities: uniq(rec.catalog_capabilities || []),
    capability_red_lines: uniq(rec.capability_red_lines || []),
    downloads: Number.isFinite(rec.downloads) ? Math.trunc(rec.downloads) : null,
    install: rec.install || null,
    description_en: rec.description_en || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// README 抓取
// ─────────────────────────────────────────────────────────────────────────────

function rankForReadme(plugins) {
  // (downloads, stars) 排名：有 downloads 用 downloads；没有（典型为仅 GitHub 插件）用 stars 参与排名
  const key = (p) => (p.downloads != null ? p.downloads : p.stars != null ? p.stars : -1);
  return [...plugins].sort((a, b) => {
    const kd = key(b) - key(a);
    if (kd !== 0) return kd;
    const sd = (b.stars ?? -1) - (a.stars ?? -1);
    if (sd !== 0) return sd;
    return a.id.localeCompare(b.id);
  });
}

function assignReadmeFiles(targets) {
  const map = new Map();
  const used = new Map();
  for (const p of targets) {
    let base = safeId(p.id);
    if (used.has(base) && used.get(base) !== p.id) base = `${base}-${sha256(p.id).slice(0, 8)}`;
    used.set(base, p.id);
    map.set(p.id, path.posix.join('data/readmes', `${base}.md`));
  }
  return map;
}

async function readmeOne(p, fileRel) {
  const abs = path.join(ROOT, fileRel);
  const prev = state.readmes[p.id];
  const verKey = p.version ?? null;
  const sameVersion = prev != null && String(prev.version ?? '') === String(verKey ?? '');

  if (sameVersion && prev.status === 'ok' && exists(abs)) {
    stats.readme.cached++;
    p.readme_path = fileRel;
    return;
  }
  if (sameVersion && prev.status === 'none') {
    stats.readme.cached++; // 404 已记录，版本未变不再重试
    return;
  }
  if (ARGS.offline) {
    stats.readme.offline_skipped++;
    if (exists(abs)) p.readme_path = fileRel;
    return;
  }

  let outcome = null;
  let sawNotFound = false;

  if (p.package) {
    for (const name of ['README.md', 'readme.md']) {
      const url = jsdelivrFileUrl(p.package, p.version, name);
      const r = await request(url, { retries: 1, timeoutMs: 25000, maxBytes: README_MAX_BYTES });
      if (r.status === 200 && r.buffer.length > 0) {
        outcome = { text: r.buffer.toString('utf8'), source: 'jsdelivr', url };
        break;
      }
      if (r.status === 404 || r.status === 410) { sawNotFound = true; continue; }
      if (r.status === 413) break;
      // 其它错误继续尝试下一个候选
    }
    if (!outcome && !ARGS.offline) {
      // 再回退 registry packument 顶层的 readme 字段
      const pr = await fetchCached({
        key: `packument:${p.package}`,
        url: registryPackumentUrl(p.package),
        file: `data/raw/packument/${safeId(p.id)}.json`,
        maxBytes: 16 * 1024 * 1024,
        retries: 1,
      });
      if (pr.buffer) {
        try {
          const doc = JSON.parse(pr.buffer.toString('utf8'));
          const txt = typeof doc.readme === 'string' && doc.readme.trim()
            ? doc.readme
            : (p.version && doc.versions?.[p.version]?.readme) || null;
          if (txt && String(txt).trim()) outcome = { text: String(txt), source: 'registry-packument', url: `registry.npmjs.org/${p.package}` };
        } catch (e) {
          warn(`packument 解析失败 ${p.package}: ${e.message}`);
        }
      } else if (pr.notFound) {
        sawNotFound = true;
      }
    }
  } else {
    const slug = repoSlug(p.repo);
    if (slug) {
      const url = `https://raw.githubusercontent.com/${slug}/${p.gh_default_branch || 'HEAD'}/README.md`;
      const r = await request(url, { retries: 1, timeoutMs: 25000, maxBytes: README_MAX_BYTES });
      if (r.status === 200 && r.buffer.length > 0) outcome = { text: r.buffer.toString('utf8'), source: 'raw.githubusercontent', url };
      else if (r.status === 404 || r.status === 410) sawNotFound = true;
    }
  }

  if (outcome) {
    writeFileAtomic(abs, outcome.text);
    p.readme_path = fileRel;
    state.readmes[p.id] = {
      version: verKey,
      status: 'ok',
      path: fileRel,
      source: outcome.source,
      url: outcome.url,
      fetched_at: nowIso(),
      bytes: Buffer.byteLength(outcome.text),
    };
    stats.readme.written++;
  } else if (sawNotFound) {
    state.readmes[p.id] = { version: verKey, status: 'none', path: null, fetched_at: nowIso() };
    stats.readme.none++;
  } else {
    state.readmes[p.id] = { version: verKey, status: 'error', path: null, fetched_at: nowIso() };
    stats.readme.error++;
  }
}

async function pool(items, concurrency, worker, label) {
  let next = 0;
  let done = 0;
  const total = items.length;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      try { await worker(items[i], i); } catch (e) { warn(`${label} #${i} 失败: ${e.message}`); }
      done++;
      if (done % 100 === 0) {
        log(`  ${label}: ${done}/${total}`);
        writeStateNow();
      }
    }
  });
  await Promise.all(workers);
}

async function runReadmeStage(plugins) {
  const t0 = Date.now();
  const targets = plugins.filter((p) => p.package || repoSlug(p.repo));
  stats.readme.targets = targets.length;
  const files = assignReadmeFiles(targets);
  log(`[readme] 目标 ${targets.length} 个（README_LIMIT=${ARGS.readmeLimit}，并发 ${README_CONCURRENCY}）`);
  await pool(targets, README_CONCURRENCY, (p) => readmeOne(p, files.get(p.id)), 'README');
  writeStateNow();
  stats.readme.elapsed_ms = Date.now() - t0;
  log(`[readme] 完成：新写 ${stats.readme.written}，缓存命中 ${stats.readme.cached}，404=${stats.readme.none}，错误=${stats.readme.error}`);
  return targets;
}

// ─────────────────────────────────────────────────────────────────────────────
// package.json / deps_dsh / provides / tools
// ─────────────────────────────────────────────────────────────────────────────

const DECL_RESERVED = new Set(['name', 'id', 'description', 'version', 'enabled', 'config', 'type', 'title', 'default', 'dependencies', 'peerDependencies', 'icon', 'author', 'homepage', 'license']);
const PROVIDES_KEYS = ['provides', 'provide', 'services', 'service'];
const TOOLS_KEYS = ['tools', 'tool'];
// 只从 dsh/cordis 的显式声明容器里取名字（不扫描 compatibility/catalog 等元数据，
// 避免把 capabilities.services 之类的目录信息误当成插件提供的服务）。
const DECL_CONTAINER_KEYS = ['plugin', 'manifest', 'meta', 'metadata', 'declarations', 'exports'];

function collectDeclNames(value, out, depth = 0) {
  if (depth > 5 || value == null) return;
  if (typeof value === 'string') { if (value.trim()) out.add(value.trim()); return; }
  if (Array.isArray(value)) { for (const v of value) collectDeclNames(v, out, depth + 1); return; }
  if (isPlainObject(value)) {
    const name = value.name || value.id || value.tool || value.service;
    if (typeof name === 'string' && name.trim()) { out.add(name.trim()); return; }
    for (const [k, v] of Object.entries(value)) {
      if (DECL_RESERVED.has(k)) continue;
      if (typeof v === 'string' && v.trim()) out.add(k);
      else if (Array.isArray(v) || isPlainObject(v)) collectDeclNames(v, out, depth + 1);
    }
  }
}

function extractDeclarationsFrom(container, provides, tools) {
  if (!isPlainObject(container)) return;
  for (const [k, v] of Object.entries(container)) {
    const key = k.toLowerCase();
    if (PROVIDES_KEYS.includes(key)) collectDeclNames(v, provides);
    else if (TOOLS_KEYS.includes(key)) collectDeclNames(v, tools);
  }
}

function extractDeclarations(root, provides, tools) {
  if (!isPlainObject(root)) return;
  extractDeclarationsFrom(root, provides, tools);
  for (const [k, v] of Object.entries(root)) {
    if (DECL_CONTAINER_KEYS.includes(k.toLowerCase()) && isPlainObject(v)) extractDeclarationsFrom(v, provides, tools);
  }
}

function applyPackageJson(p, pj) {
  const depNames = [];
  for (const field of ['dependencies', 'peerDependencies']) {
    const deps = pj[field];
    if (!isPlainObject(deps)) continue;
    for (const name of Object.keys(deps)) if (isDshDepName(name)) depNames.push(name);
  }
  p.deps_dsh = uniq([...p.deps_dsh, ...depNames]);

  if (Array.isArray(pj.keywords)) p.keywords = uniq([...p.keywords, ...pj.keywords.map(String)]);

  const provides = new Set();
  const tools = new Set();
  for (const field of ['dsh', 'cordis']) {
    const v = pj[field];
    if (v == null) continue;
    extractDeclarations(v, provides, tools, 0);
  }
  if (provides.size) p.provides = uniq([...p.provides, ...provides]);
  if (tools.size) p.tools = uniq([...p.tools, ...tools]);
}

async function pkgJsonOne(p) {
  const ver = p.version ?? null;
  const cacheRel = path.posix.join('data/raw/package-json', `${safeId(p.package)}@${safeId(ver || 'latest')}.json`);
  const abs = path.join(ROOT, cacheRel);
  const prev = state.pkgjs[p.id];
  const sameVersion = prev != null && String(prev.version ?? '') === String(ver ?? '');

  if (sameVersion && prev.status === 'ok' && exists(abs)) {
    stats.package_json.cached++;
    const doc = readJsonFile(abs, null);
    if (doc) applyPackageJson(p, doc);
    return;
  }
  if (sameVersion && prev.status === 'none') {
    stats.package_json.cached++;
    return;
  }
  if (ARGS.offline) {
    if (exists(abs)) {
      stats.package_json.cached++;
      const doc = readJsonFile(abs, null);
      if (doc) applyPackageJson(p, doc);
    }
    return;
  }

  let doc = null;
  let source = null;
  let sawNotFound = false;

  const url = jsdelivrFileUrl(p.package, ver, 'package.json');
  const r = await request(url, { retries: 1, timeoutMs: 20000, maxBytes: 2 * 1024 * 1024 });
  if (r.status === 200) {
    try { doc = JSON.parse(r.buffer.toString('utf8')); source = 'jsdelivr'; } catch { doc = null; }
  } else if (r.status === 404 || r.status === 410) {
    sawNotFound = true;
  }

  if (!doc && ver) {
    // jsDelivr 不可用（404/403/5xx 等）时回退 registry 精确版本 manifest
    const r2 = await request(registryVersionUrl(p.package, ver), { retries: 1, timeoutMs: 20000, maxBytes: 4 * 1024 * 1024 });
    if (r2.status === 200) {
      try { doc = JSON.parse(r2.buffer.toString('utf8')); source = 'registry'; } catch { doc = null; }
    } else if (r2.status === 404 || r2.status === 410) {
      sawNotFound = true;
    }
  }

  if (doc) {
    writeFileAtomic(abs, JSON.stringify(doc));
    applyPackageJson(p, doc);
    state.pkgjs[p.id] = { version: ver, status: 'ok', source, file: cacheRel, fetched_at: nowIso() };
    stats.package_json.written++;
  } else if (sawNotFound) {
    state.pkgjs[p.id] = { version: ver, status: 'none', fetched_at: nowIso() };
    stats.package_json.none++;
  } else {
    state.pkgjs[p.id] = { version: ver, status: 'error', fetched_at: nowIso() };
    stats.package_json.error++;
  }
}

async function runPackageJsonStage(targets) {
  const t0 = Date.now();
  const npmTargets = targets.filter((p) => p.package);
  stats.package_json.targets = npmTargets.length;
  log(`[pkgjson] 目标 ${npmTargets.length} 个 npm 包（提取 deps_dsh / provides / tools）`);
  await pool(npmTargets, README_CONCURRENCY, (p) => pkgJsonOne(p), 'pkgjson');
  writeStateNow();
  stats.package_json.elapsed_ms = Date.now() - t0;
  log(`[pkgjson] 完成：新写 ${stats.package_json.written}，缓存命中 ${stats.package_json.cached}，缺失 ${stats.package_json.none}，错误 ${stats.package_json.error}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 输出与报告
// ─────────────────────────────────────────────────────────────────────────────

function writeOutput(plugins) {
  const lines = plugins.map((p) => JSON.stringify(p));
  writeFileAtomic(OUT_PATH, lines.join('\n') + '\n');
  stats.output.lines = lines.length;
  stats.output.bytes = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  stats.output.readme_paths = plugins.filter((p) => p.readme_path).length;
}

function buildReport() {
  stats.finished_at = nowIso();
  stats.records.total = stats.output.lines;
  stats.records.with_npm = stats.output.with_npm;
  stats.records.github_only = stats.output.github_only;
  stats.records.skipped_no_id = stats.output.skipped_no_id;
  return {
    schema_version: 1,
    crawler_version: CRAWLER_VERSION,
    generated_at: stats.finished_at,
    mode: stats.mode,
    github_enabled: stats.github_enabled,
    readme_limit: stats.readme_limit,
    elapsed_ms: Date.parse(stats.finished_at) - Date.parse(stats.started_at),
    markets: stats.markets,
    records: stats.records,
    readme: stats.readme,
    package_json: stats.package_json,
    http: {
      requests: stats.requests,
      status_counts: stats.status_counts,
      http_200: stats.http_200,
      http_304: stats.http_304,
      http_unchanged: stats.http_unchanged,
      http_404: stats.http_404,
      http_error: stats.http_error,
      cache_hits: stats.cache_hits,
      stale_cache_hits: stats.stale_cache_hits,
      bytes_downloaded: stats.bytes_downloaded,
    },
    github: stats.github,
  };
}

function printReport(report) {
  const m = stats.markets;
  const fmt = (id, detail) => `  ${id.padEnd(34)} ${detail}`;
  log('');
  log('════════════════ Plugin Atlas 增量抓取报告 ════════════════');
  log(`模式: ${stats.mode}    GitHub 市场: ${stats.github_enabled ? '开' : '关'}    README_LIMIT=${ARGS.readmeLimit}`);
  log('市场明细:');
  if (m['index:awesome-dsh-plugin']) {
    const x = m['index:awesome-dsh-plugin'];
    log(fmt('index:awesome-dsh-plugin', `catalog=${x.records}  source=${x.source}  请求=${x.requests} 304=${x.not_modified} unchanged=${x.unchanged}`));
  }
  for (const id of ['npm:dsh-plugin', 'npm:cordis-plugin']) {
    const x = m[id];
    if (!x) continue;
    log(fmt(id, `total=${x.total ?? '?'}  pages=${x.pages}  返回=${x.fetched_objects}  校验通过=${x.validated}  唯一包=${x.records}  请求=${x.requests} 304=${x.not_modified} unchanged=${x.unchanged}`));
  }
  if (m['inventory:dsh-official-on-demand']) {
    const x = m['inventory:dsh-official-on-demand'];
    log(fmt('inventory:dsh-official-on-demand', `entries=${x.records}  dsh=${x.dsh_version || '?'}  请求=0`));
  }
  if (m['github:blue-whale-harness']) {
    const x = m['github:blue-whale-harness'];
    log(fmt('github:blue-whale-harness', `repos=${x.records}  请求=${x.requests} 304=${x.not_modified} unchanged=${x.unchanged}`));
  }
  if (m['github:dsh-plugin-hub']) {
    const x = m['github:dsh-plugin-hub'];
    const reuse = x.pages_used != null && x.pages_used !== x.pages ? `（另复用缓存页 ${x.pages_used - x.pages}）` : '';
    log(fmt('github:dsh-plugin-hub', `repos=${x.records}  pages=${x.pages}${reuse}  total_count=${x.total_count ?? '?'}  请求=${x.requests} 304=${x.not_modified} unchanged=${x.unchanged}  remaining=${x.rate_limit_remaining ?? '?'}${x.stopped_early ? '  [已按限频提前停止]' : ''}`));
  }
  log('');
  log(`合并后插件总数: ${report.records.total}`);
  log(`  npm 包: ${report.records.with_npm}    仅 GitHub: ${report.records.github_only}    无 id 跳过: ${report.records.skipped_no_id}`);
  log(`README: 目标=${stats.readme.targets} 新写=${stats.readme.written} 缓存=${stats.readme.cached} 404=${stats.readme.none} 错误=${stats.readme.error} → readme_path 非空=${stats.output.readme_paths}`);
  log(`package.json: 目标=${stats.package_json.targets} 新写=${stats.package_json.written} 缓存=${stats.package_json.cached} 缺失=${stats.package_json.none} 错误=${stats.package_json.error}`);
  log('');
  const statusDist = Object.entries(stats.status_counts)
    .sort((a, b) => (a[0] === 'error' ? 1 : b[0] === 'error' ? -1 : Number(a[0]) - Number(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  log(`HTTP: 请求=${stats.requests}  (含 README/package.json)；状态分布: ${statusDist}`);
  log(`      缓存端点: 304=${stats.http_304}  200-内容未变=${stats.http_unchanged}  缓存端点200=${stats.http_200}  404=${stats.http_404}  错误=${stats.http_error}`);
  log(`      离线/陈旧缓存命中=${stats.cache_hits}  陈旧回退=${stats.stale_cache_hits}  下载字节=${stats.bytes_downloaded}`);
  log(`用时: ${(report.elapsed_ms / 1000).toFixed(1)}s`);
  log(`输出: data/plugins_base.jsonl (${report.records.total} 行)`);
  log(`状态: data/raw/state.json`);
  log('══════════════════════════════════════════════════════════');
}

// ─────────────────────────────────────────────────────────────────────────────
// 抓取结束后的自动分析（merge + reload）
// ─────────────────────────────────────────────────────────────────────────────

function hasAnalysisWork() {
  for (const stage of ['classify', 'branches', 'summarize']) {
    const dir = path.join(DATA_DIR, 'work', stage);
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.out.json'))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

function runAnalysisAfterCrawl() {
  if (!hasAnalysisWork()) {
    log('[analyze] data/work 下暂无分析结果，跳过自动 merge');
    return;
  }
  if (!exists(ANALYZE_PATH)) {
    warn('[analyze] 找不到 crawler/analyze.mjs，跳过自动 merge');
    return;
  }
  log('[analyze] 检测到 data/work 分析结果，执行增量 merge（node crawler/analyze.mjs --merge-only --no-reload）…');
  try {
    const childEnv = { ...process.env }; delete childEnv.GITHUB_TOKEN; delete childEnv.GH_TOKEN;
    const out = execFileSync(process.execPath, [ANALYZE_PATH, '--merge-only', '--no-reload'], {
      cwd: ROOT,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (out.trim()) log(out.trim());
  } catch (e) {
    warn(`[analyze] 自动 merge 失败（不影响抓取结果）：${(e.stderr || e.message || '').toString().trim()}`);
    return;
  }
  const curl = (args) => {
    try {
      return execFileSync('curl', ['-sS', '--max-time', '180', ...args], { encoding: 'utf8', timeout: 190_000 });
    } catch (e) {
      warn(`[web] curl ${args.join(' ')} 失败（服务不可达？）：${e.message}`);
      return null;
    }
  };
  const reloadRes = curl(['-X', 'POST', WEB_RELOAD_URL]);
  if (reloadRes != null) log(`[web] reload: ${reloadRes.trim()}`);
  const statusRes = curl([WEB_STATUS_URL]);
  if (statusRes != null) log(`[web] status: ${statusRes.trim()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GitHub 全量（--github-full，需 GITHUB_TOKEN）：搜索按 created 日期二分分片突破 1000 条上限；
// /repos 元数据补全；所有 GitHub-only 仓库 README（raw.githubusercontent，不带 token）。
// 限频：core 剩余 < GH_CORE_MIN(200) 暂停到 reset；search 剩余 < 3 暂停到 reset；403/429 二级限频退避。
// ─────────────────────────────────────────────────────────────────────────────
const GH_CORE_MIN = Math.max(1, Number(process.env.GITHUB_CORE_MIN_REMAINING) || 200);
const GH_SEARCH_MIN = 3;
const ghRates = {}; // resource -> {remaining, reset, limit}
function ghTrack(h) {
  const res = h['x-ratelimit-resource']; if (!res || h['x-ratelimit-remaining'] == null) return;
  ghRates[res] = { remaining: Number(h['x-ratelimit-remaining']), reset: Number(h['x-ratelimit-reset']), limit: Number(h['x-ratelimit-limit']) };
  state.github.rates = { ...(state.github.rates || {}), [res]: { ...ghRates[res], at: nowIso() } };
  state.github.auth_mode = GITHUB_AUTH_MODE;
}
async function ghWait(resource) {
  const r = ghRates[resource]; const min = resource === 'search' ? GH_SEARCH_MIN : GH_CORE_MIN;
  if (r && r.remaining < min && r.reset * 1000 > Date.now()) {
    const ms = r.reset * 1000 - Date.now() + 3000;
    log(`[github] ${resource} 剩余 ${r.remaining} < ${min}，暂停 ${Math.ceil(ms / 1000)}s 等额度重置`);
    stats.github.pauses = (stats.github.pauses || 0) + 1;
    writeStateNow();
    await new Promise((res) => setTimeout(res, ms));
  }
}
async function ghGet(key, url, file) {
  const resource = url.includes('/search/') ? 'search' : 'core';
  for (let attempt = 0; attempt < 3; attempt++) {
    await ghWait(resource);
    stats.github.requests++;
    stats.github[`requests_${resource}`] = (stats.github[`requests_${resource}`] || 0) + 1;
    const r = await fetchCached({ key, url, file, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, timeoutMs: 30000, retries: 1 });
    ghTrack(r.headers || {});
    if ((r.status === 403 || r.status === 429) && !r.cached) {
      const ra = Number(r.headers?.['retry-after']);
      const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60000;
      warn(`[github] ${r.status}（可能是二级限频），${Math.round(ms / 1000)}s 后重试`);
      await new Promise((res) => setTimeout(res, ms));
      continue;
    }
    return r;
  }
  return { status: 0, error: 'github retries exhausted' };
}
const GH_FULL_QUERIES = [
  { slug: 'topic-dsh-plugin', q: 'topic:dsh-plugin' },
  { slug: 'name-desc-dsh-plugin', q: '"dsh-plugin" in:name,description' },
];
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
async function fetchGithubFull() {
  const t0 = Date.now();
  const items = new Map();
  const add = (d) => { for (const it of (d?.items || [])) { if (it?.full_name) items.set(it.full_name.toLowerCase(), it); } };
  const shards = [];
  async function page(query, from, to, p) {
    const q = `${query.q} created:${from}..${to}`;
    const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(q)}&per_page=100&page=${p}`;
    const r = await ghGet(`github:full:${query.slug}:${from}:${to}:p${p}`, url, `data/raw/github/full/${query.slug}/${from}_${to}-p${p}.json`);
    if (!r.buffer) { warn(`[github-full] ${q} p${p} 失败（${r.error || r.status}）`); return null; }
    try { return JSON.parse(r.buffer.toString('utf8')); } catch { return null; }
  }
  async function shard(query, fromT, toT) {
    const from = dayStr(fromT), to = dayStr(toT);
    const d = await page(query, from, to, 1);
    if (!d) return;
    const total = d.total_count || 0;
    if (total > 1000 && toT - fromT >= 2 * 86400000) {
      const mid = fromT + Math.floor((toT - fromT) / 2 / 86400000) * 86400000;
      await shard(query, fromT, mid);
      await shard(query, mid + 86400000, toT);
      return;
    }
    add(d);
    const pages = Math.min(10, Math.ceil(Math.min(total, 1000) / 100));
    for (let p = 2; p <= pages; p++) { const dp = await page(query, from, to, p); if (dp) add(dp); }
    shards.push({ q: query.q, from, to, total_count: total, pages, truncated: total > 1000 });
  }
  const start = Date.parse('2008-01-01T00:00:00Z');
  const end = Date.parse(dayStr(Date.now()) + 'T00:00:00Z');
  for (const query of GH_FULL_QUERIES) {
    await shard(query, start, end);
    log(`[github-full] ${query.q}: 累计 ${items.size} 个 repo，分片 ${shards.filter((s) => s.q === query.q).length}`);
    writeStateNow();
  }
  stats.markets['github:dsh-plugin-hub:full'] = { records: items.size, shards: shards.length, truncated_shards: shards.filter((s) => s.truncated).length, elapsed_ms: Date.now() - t0 };
  state.github.full_last_run = { at: nowIso(), items: items.size, shards: shards.length, truncated: shards.filter((s) => s.truncated).length };
  return [...items.values()];
}
/** GitHub-only 记录补元数据：GET /repos/{slug}（ETag 缓存；304 不计额度） */
async function enrichGithubRepos(plugins, knownSlugs) {
  const targets = plugins.filter((p) => !p.package && repoSlug(p.repo) && !knownSlugs.has(repoSlug(p.repo).toLowerCase()) && (p.stars == null || !p.description));
  log(`[github-repos] 需补元数据 ${targets.length} 个仓库`);
  let n = 0, filled = 0, missing = 0;
  for (const p of targets) {
    const slug = repoSlug(p.repo);
    const r = await ghGet(`github:repo:${slug.toLowerCase()}`, `https://api.github.com/repos/${slug}`, `data/raw/github/repos/${slug.replace('/', '__')}.json`);
    n++;
    if (r.notFound) { missing++; state.github.repos_missing = (state.github.repos_missing || 0); continue; }
    if (r.buffer) { try { applyGithubRepo(p, JSON.parse(r.buffer.toString('utf8'))); filled++; } catch { /* ignore */ } }
    if (n % 200 === 0) { log(`  github-repos: ${n}/${targets.length}（core 剩余 ${ghRates.core?.remaining ?? '?'}）`); writeStateNow(); }
  }
  stats.github.repos_enriched = filled; stats.github.repos_missing = missing;
  log(`[github-repos] 完成：补全 ${filled}，404 ${missing}`);
}
function applyGithubRepo(p, d) {
  if (!d || !d.full_name) return;
  if (!p.description && d.description) p.description = d.description;
  if (p.stars == null && Number.isFinite(d.stargazers_count)) p.stars = d.stargazers_count;
  if (!p.homepage && d.homepage) p.homepage = d.homepage;
  if (Array.isArray(d.topics) && d.topics.length) p.keywords = uniq([...(p.keywords || []), ...d.topics.map(String)]);
  if (d.pushed_at) p.updated_at = d.pushed_at;
  if (d.default_branch) p.gh_default_branch = d.default_branch;
  if (d.archived) p.gh_archived = true;
  if (d.fork) p.gh_fork = true;
}
/** 离线/后续运行：从缓存的 /repos 响应补元数据（0 请求） */
function applyCachedGithubRepos(plugins) {
  const dir = path.join(RAW_DIR, 'github', 'repos'); if (!exists(dir)) return 0;
  let n = 0;
  for (const p of plugins) {
    if (p.package) continue; const slug = repoSlug(p.repo); if (!slug) continue;
    const f = path.join(dir, `${slug.replace('/', '__')}.json`);
    if (exists(f)) { try { applyGithubRepo(p, JSON.parse(fs.readFileSync(f, 'utf8'))); n++; } catch { /* ignore */ } }
  }
  return n;
}
/** 任何之前成功抓过 README 且文件仍在的插件都挂上 readme_path（保证 README_LIMIT 之外的 README 不丢） */
function attachKnownReadmes(plugins) {
  let n = 0;
  for (const p of plugins) {
    if (p.readme_path) continue;
    const st = state.readmes[p.id];
    if (st && st.status === 'ok' && st.path && exists(path.join(ROOT, st.path))) { p.readme_path = st.path; n++; }
  }
  return n;
}

async function main() {
  log(`[github] 认证模式: ${GITHUB_AUTH_MODE}（每查询 ${GH_SEARCH_PAGES} 页）`);
  if (ARGS.help) { printHelp(); return; }
  ensureDir(RAW_DIR);
  ensureDir(READMES_DIR);
  ensureDir(path.join(RAW_DIR, 'index'));
  ensureDir(path.join(RAW_DIR, 'npm-search'));
  ensureDir(path.join(RAW_DIR, 'github', 'search'));
  ensureDir(path.join(RAW_DIR, 'inventory'));
  ensureDir(path.join(RAW_DIR, 'packument'));
  ensureDir(path.join(RAW_DIR, 'package-json'));

  log(`Plugin Atlas 增量爬虫 v${CRAWLER_VERSION}（${ARGS.offline ? 'offline 只用缓存' : 'online'}${ARGS.skipGithub ? '，跳过 GitHub 市场' : ''}，README_LIMIT=${ARGS.readmeLimit}）`);

  const store = createStore();
  let ghFullSlugs = new Set();
  const t0 = Date.now();

  // ── 1. 主索引目录 ──────────────────────────────────────────────────────────
  const catalogPlugins = await fetchCatalogIndex();
  for (const p of catalogPlugins) addCandidate(store, candidateFromCatalog(p));
  flushState();

  // ── 2. npm 关键词搜索（dsh-plugin 为主，cordis-plugin 补充）─────────────────
  for (const [marketId, keyword] of [['npm:dsh-plugin', 'dsh-plugin'], ['npm:cordis-plugin', 'cordis-plugin']]) {
    const packages = await fetchNpmSearch(marketId, keyword);
    for (const obj of packages.values()) addCandidate(store, candidateFromNpmSearch(obj, marketId));
    flushState();
  }

  // ── 3. 本机官方 on-demand 清单（0 请求）────────────────────────────────────
  const inventory = loadInventory();
  for (const entry of inventory.entries) addCandidate(store, candidateFromInventory(entry, 'inventory:dsh-official-on-demand', inventory.dshVersion));
  flushState();

  // ── 4/5. GitHub 市场（可 --skip-github 跳过）────────────────────────────────
  if (!ARGS.skipGithub) {
    const hubItems = await fetchGithubHub();
    for (const item of hubItems) addCandidate(store, candidateFromGithubItem(item, 'github:dsh-plugin-hub'));
    flushState();

    const blueWhale = await fetchBlueWhale();
    for (const slug of blueWhale) addCandidate(store, candidateFromBlueWhale(slug, 'github:blue-whale-harness'));
    flushState();

    if (ARGS.githubFull && !ARGS.offline) {
      if (!GITHUB_TOKEN) throw new Error('--github-full 需要 GITHUB_TOKEN 环境变量');
      const fullItems = await fetchGithubFull();
      for (const item of fullItems) addCandidate(store, candidateFromGithubItem(item, 'github:dsh-plugin-hub'));
      ghFullSlugs = new Set(fullItems.map((i) => i.full_name.toLowerCase()));
      flushState();
    } else if (exists(path.join(RAW_DIR, 'github', 'full'))) {
      // 复用以前全量抓取的缓存分片（0 请求）
      const dir = path.join(RAW_DIR, 'github', 'full'); let n = 0;
      for (const q of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, q))) {
        const d = readJsonFile(path.join(dir, q, f), null);
        for (const it of (d?.items || [])) { if (it?.full_name) { addCandidate(store, candidateFromGithubItem(it, 'github:dsh-plugin-hub')); ghFullSlugs.add(it.full_name.toLowerCase()); n++; } }
      }
      log(`[github-full] 复用缓存分片 ${n} 条`);
    }
  } else {
    log('[github] 已按 --skip-github 跳过 github:dsh-plugin-hub 与 github:blue-whale-harness');
  }

  // ── 归一化 / 去重 / 输出结构 ──────────────────────────────────────────────
  const crawlTime = nowIso();
  const plugins = [];
  for (const rec of store.records) {
    const p = finalizeRecord(rec, crawlTime);
    if (!p) { stats.output.skipped_no_id++; continue; }
    plugins.push(p);
  }
  // 保险：按 id 再兜底去重（理论上前面的索引已保证唯一）
  const byId = new Map();
  for (const p of plugins) {
    const prev = byId.get(p.id);
    if (!prev) { byId.set(p.id, p); continue; }
    prev.markets = sortMarkets([...prev.markets, ...p.markets]);
    for (const k of ['keywords', 'provides', 'tools', 'deps_dsh', 'capabilities', 'catalog_capabilities', 'capability_red_lines']) {
      prev[k] = uniq([...(prev[k] || []), ...(p[k] || [])]);
    }
    for (const k of Object.keys(p)) {
      if (['id', 'markets', 'keywords', 'provides', 'tools', 'deps_dsh', 'capabilities', 'catalog_capabilities', 'capability_red_lines'].includes(k)) continue;
      if (isEmptyValue(prev[k]) && !isEmptyValue(p[k])) prev[k] = p[k];
    }
  }
  const finalPlugins = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  stats.output.with_npm = finalPlugins.filter((p) => p.package).length;
  stats.output.github_only = finalPlugins.length - stats.output.with_npm;
  log(`[merge] 合并去重后 ${finalPlugins.length} 个插件（npm 包 ${stats.output.with_npm}，仅 GitHub ${stats.output.github_only}）`);

  // ── README（按 (downloads, stars) 取前 README_LIMIT）──────────────────────
  const ranked = rankForReadme(finalPlugins);
  const readmeTargets = ranked.filter((p) => p.package || repoSlug(p.repo)).slice(0, ARGS.readmeLimit);
  // GitHub-only 仓库元数据（--github-full 时联网补全，否则只用缓存）
  if (ARGS.githubFull && !ARGS.offline && GITHUB_TOKEN) await enrichGithubRepos(finalPlugins, ghFullSlugs);
  const cachedRepoN = applyCachedGithubRepos(finalPlugins);
  if (cachedRepoN) log(`[github-repos] 从缓存补元数据 ${cachedRepoN} 个`);
  let readmeAll = readmeTargets;
  if (ARGS.githubFull) {
    const ids = new Set(readmeTargets.map((p) => p.id));
    const extra = finalPlugins.filter((p) => !p.package && repoSlug(p.repo) && !ids.has(p.id) && !p.gh_archived);
    log(`[readme] --github-full：追加 GitHub-only 仓库 README ${extra.length} 个（raw.githubusercontent，不带 token）`);
    readmeAll = [...readmeTargets, ...extra];
  }
  await runReadmeStage(readmeAll);
  const attached = attachKnownReadmes(finalPlugins);
  if (attached) log(`[readme] 复用已缓存 README ${attached} 个（README_LIMIT 之外）`);

  // ── package.json → deps_dsh / provides / tools ───────────────────────────
  await runPackageJsonStage(readmeTargets);

  // ── 输出 ──────────────────────────────────────────────────────────────────
  writeOutput(finalPlugins);
  flushState();

  const report = buildReport();
  writeJsonAtomic(REPORT_PATH, report);
  printReport(report);
  log(`总用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (finalPlugins.length === 0) {
    console.error('[error] 合并后为空：没有可用缓存且所有抓取失败，未覆盖已有输出');
    process.exitCode = 1;
    return;
  }

  // ── 自动分析：有 data/work 分析结果时增量 merge 并通知 web 重新加载 ──────────
  if (ARGS.noAnalyze) { log('[analyze] --no-analyze：跳过自动 merge/reload'); return; }
  runAnalysisAfterCrawl();
}

main().catch((e) => {
  console.error('[fatal]', redact(e?.stack || e));
  try { flushState(); } catch { /* ignore */ }
  process.exitCode = 1;
});
