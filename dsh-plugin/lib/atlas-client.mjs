const DEFAULT_URL = 'http://127.0.0.1:4380';
function resolveConfig(config = {}, env = process.env) {
  return {
    baseUrl: String(config.baseUrl || env.PLUGIN_ATLAS_URL || DEFAULT_URL).replace(/\/+$/, ''),
    timeoutMs: Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 15e3,
  };
}
async function fetchJson(base, path, { signal, timeoutMs = 15e3 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${base}${path}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
const loadingText = 'Plugin Atlas 正在加载索引，请约 1–2 分钟后重试。';
const unavailableText = (base) =>
  `Plugin Atlas 本地服务未运行（${base}），启动方法：在仓库根目录运行 bash web/start.sh（端口 4380，首次加载约 2 分钟，可用 curl ${base}/api/status 查看 loading），或设置 PLUGIN_ATLAS_URL 指向其他地址。`;
const failure = (error, cfg) => ({
  ok: false,
  text:
    error?.status === 503 && error.message === 'loading'
      ? loadingText
      : error?.status
        ? `Plugin Atlas 请求失败：${error.message}`
        : unavailableText(cfg.baseUrl),
  data: null,
});
const arr = (value) => (Array.isArray(value) ? value : []);
const short = (value) =>
  Array.from(
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
    .slice(0, 160)
    .join('');
const withJson = (text, data) => {
  const compact = JSON.stringify(data);
  return compact.length <= 2e3
    ? `${text}
${compact}`
    : text;
};
async function atlasStatus(config = {}, signal) {
  const cfg = resolveConfig(config);
  try {
    const data = await fetchJson(cfg.baseUrl, '/api/status', { signal, timeoutMs: cfg.timeoutMs });
    if (data?.loading) return { ok: false, text: loadingText, data };
    const text = `Plugin Atlas 服务已就绪。插件数：${data?.counts?.plugins ?? '未知'}；语义后端：${data?.semantic_backend ?? '未知'}。
${atlasOpenInfo(cfg)}`;
    return {
      ok: true,
      text: withJson(text, {
        loading: false,
        counts: data?.counts,
        semantic_backend: data?.semantic_backend,
        url: cfg.baseUrl,
      }),
      data,
    };
  } catch (error) {
    return failure(error, cfg);
  }
}
function detailParts(detail, id) {
  const plugin = detail?.plugin || {};
  const ancestors = arr(detail?.ancestors)
    .filter((a) => a?.id !== 'root')
    .map((a) => a?.label || a?.id)
    .filter(Boolean);
  let caps = arr(detail?.branch_capabilities?.union)
    .filter((c) => arr(c?.provided_by).includes(id))
    .map((c) => c?.capability)
    .filter(Boolean);
  if (!caps.length) caps = arr(plugin.capabilities).filter((c) => typeof c === 'string');
  return { plugin, category: ancestors.join(' > '), capabilities: caps.slice(0, 5) };
}
function compactDetail(detail, id) {
  if (!detail) return null;
  const { plugin, category, capabilities } = detailParts(detail, id);
  const pick = {};
  for (const k of [
    'id',
    'name',
    'package',
    'version',
    'summary',
    'summary_source',
    'markets',
    'repo',
    'homepage',
    'install',
    'tools',
    'downloads',
    'stars',
    'github_only',
    'relevance',
    'category_id',
    'branch_id',
  ]) {
    if (plugin[k] !== void 0 && plugin[k] !== null && plugin[k] !== '') pick[k] = plugin[k];
  }
  return { id: plugin.id || detail?.node?.id || id, path: category, capabilities, plugin: pick };
}
/** 处理对应的图谱操作。 */
function formatResult(result, index, detail) {
  const id = result?.id || result?.node_id || '未知';
  const { plugin, category, capabilities } = detailParts(detail, id);
  const flags = [
    result?.github_only || plugin.github_only ? 'github_only' : '',
    plugin.relevance === 'suspect' ||
    plugin.suspect_irrelevant === true ||
    result?.relevance === 'suspect' ||
    result?.suspect_irrelevant === true
      ? '疑似'
      : '',
  ].filter(Boolean);
  return `${index + 1}. ${result?.title || plugin.name || id}（${id}）${flags.length ? ` [${flags.join('、')}]` : ''}
   分类：${category || '未知'}
   摘要：${(plugin.summary ? short(plugin.summary) : Array.from(String(plugin.description || '').replace(/\s+/g, ' ').trim()).slice(0, 120).join('')) || '暂无'}
   能力：${capabilities.join('、') || '暂无'}`;
}
async function atlasSearch(
  { q, limit = 8, mode = 'hybrid', includeGithubOnly = false } = {},
  config = {},
  signal,
) {
  const cfg = resolveConfig(config);
  const status = await atlasStatus(cfg, signal);
  if (!status.ok) return status;
  try {
    const params = new URLSearchParams({
      q: String(q ?? ''),
      limit: String(Math.min(Math.max(1, Number(limit) || 8), 30)),
      mode,
      type: 'plugin',
    });
    if (includeGithubOnly) params.set('include_github_only', '1');
    const data = await fetchJson(cfg.baseUrl, `/api/search?${params}`, { signal, timeoutMs: cfg.timeoutMs });
    const results = arr(data?.results);
    const nodes = new Array(results.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, results.length) }, async () => {
      while (next < results.length) {
        const i = next++;
        const id = results[i]?.node_id || results[i]?.id;
        if (!id) { nodes[i] = null; continue; }
        try {
          nodes[i] = await fetchJson(cfg.baseUrl, `/api/node/${encodeURIComponent(id)}`, { signal, timeoutMs: cfg.timeoutMs });
        } catch (error) {
          if (signal?.aborted) throw error;
          nodes[i] = null;
        }
      }
    }));
    const text = results.length
      ? `找到 ${results.length} 个插件：
${results.map((r, i) => formatResult(r, i, nodes[i])).join('\n')}`
      : '没有找到匹配的插件。';
    const compact = {
      q: data?.q,
      mode: data?.mode,
      semantic_backend: data?.semantic_backend,
      results: results.map((r) => ({
        id: r?.id,
        title: r?.title,
        score: typeof r?.score === 'number' ? Number(r.score.toFixed(4)) : r?.score,
        github_only: !!r?.github_only,
      })),
      details: nodes.map((n, i) => compactDetail(n, results[i]?.node_id || results[i]?.id)),
    };
    return { ok: true, text: withJson(text, compact), data: compact };
  } catch (error) {
    return failure(error, cfg);
  }
}
async function atlasNode(id, config = {}, signal) {
  const cfg = resolveConfig(config);
  const status = await atlasStatus(cfg, signal);
  if (!status.ok) return status;
  try {
    const data = await fetchJson(cfg.baseUrl, `/api/node/${encodeURIComponent(id)}`, {
      signal,
      timeoutMs: cfg.timeoutMs,
    });
    const plugin = data?.plugin || {};
    const text = formatResult(
      { id: plugin.id || data?.node?.id || id, title: plugin.name || data?.node?.label || id },
      0,
      data,
    );
    const compact = compactDetail(data, id);
    return { ok: true, text: withJson(text, compact), data: compact };
  } catch (error) {
    return failure(error, cfg);
  }
}
function atlasOpenInfo(config = {}) {
  const { baseUrl } = resolveConfig(config);
  return `网页地址：${baseUrl}。请在浏览器（或 dsh web 内置浏览器标签页）打开。若服务未启动，请在仓库根目录运行 bash web/start.sh；首次加载约 1–2 分钟，可用 curl ${baseUrl}/api/status 查看 loading。`;
}
export { atlasNode, atlasOpenInfo, atlasSearch, atlasStatus, compactDetail, fetchJson, resolveConfig };
