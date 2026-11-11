import { useEffect, useRef, useState } from 'react';

export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: 'dsh-plugin-atlas',
        kind: 'plugin-atlas',
        priority: 'extension',
        title: () => 'Plugin Atlas',
        guide: [{ id: 'open', order: 60, title: () => 'Plugin Atlas', description: () => '插件生态能力图谱' }],
      }),
    'plugin-atlas.type',
  );
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-plugin-atlas' }, AtlasBody),
      ),
    'plugin-atlas.body',
  );
  window.__pluginAtlasOpen = () => ctx.sidebarRight.openTab('plugin-atlas');
}

const defaultBase = 'http://127.0.0.1:4380';
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value));
async function api(base, path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(base.replace(/\/+$/, '') + path, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? '请求超时（10 秒）' : error.message);
  } finally {
    clearTimeout(timer);
  }
}
function initialBase() {
  try {
    return localStorage.getItem('plugin-atlas.base') || defaultBase;
  } catch {
    return defaultBase;
  }
}

function AtlasBody({ useTabInfo }) {
  const { tab } = useTabInfo();
  const [base, setBase] = useState(initialBase),
    [draft, setDraft] = useState(base);
  const [status, setStatus] = useState(null),
    [statusError, setStatusError] = useState(''),
    [retry, setRetry] = useState(0);
  const [tree, setTree] = useState([]),
    [expanded, setExpanded] = useState({}),
    [pages, setPages] = useState({});
  const [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [mode, setMode] = useState('hybrid'),
    [github, setGithub] = useState(false);
  const [results, setResults] = useState(null),
    [detail, setDetail] = useState(null);
  const [settings, setSettings] = useState(false), [copied, setCopied] = useState(false);
  const refs = useRef({}), timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const filter = github ? '1' : '0';
  useEffect(() => {
    if (tab.visible === false) return;
    let active = true;
    setStatus(null);
    setStatusError('');
    setError('');
    setTree([]);
    setPages({});
    setDetail(null);
    setResults(null);
    api(base, '/api/status')
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch((e) => {
        if (active) setStatusError(e.message);
      });
    api(base, '/api/tree?include_github_only=' + filter)
      .then((t) => {
        if (active) setTree(list(t.nodes));
      })
      .catch((e) => {
        if (active) setError('图谱：' + e.message);
      });
    return () => {
      active = false;
    };
  }, [base, retry, filter, tab.visible]);
  async function loadPage(node, more = false) {
    const previous = pages[node.id];
    const params = new URLSearchParams({
      node: node.id,
      limit: '20',
      offset: String(more ? previous.offset + previous.limit : 0),
      include_github_only: filter,
    });
    try {
      setError('');
      const page = await api(base, '/api/children?' + params);
      setPages((old) => ({
        ...old,
        [node.id]: { ...page, nodes: more ? [...old[node.id].nodes, ...page.nodes] : page.nodes },
      }));
    } catch (e) {
      setError('加载插件：' + e.message);
    }
  }
  function toggle(node) {
    const open = !expanded[node.id];
    setExpanded((old) => ({ ...old, [node.id]: open }));
    if (open && node.type === 'branch' && !pages[node.id]) void loadPage(node);
  }
  async function select(id) {
    try {
      setError('');
      setDetail(null);
      setDetail(await api(base, '/api/node/' + encodeURIComponent(id)));
    } catch (e) {
      setError('详情：' + e.message);
    }
  }
  async function search(event) {
    event.preventDefault();
    try {
      setError('');
      setResults(null);
      const p = new URLSearchParams({ q: query, mode, limit: '20', include_github_only: filter });
      setResults(await api(base, '/api/search?' + p));
    } catch (e) {
      setError('搜索：' + e.message);
    }
  }
  function saveBase(event) {
    event.preventDefault();
    const next = draft.trim().replace(/\/+$/, '') || defaultBase;
    try {
      localStorage.setItem('plugin-atlas.base', next);
    } catch {}
    setDraft(next);
    setBase(next);
    setRetry((x) => x + 1);
  }
  function openCategory(node) {
    const opened = { [node.id]: true };
    let parent = tree.find((n) => n.id === node.parent);
    while (parent) { opened[parent.id] = true; parent = tree.find((n) => n.id === parent.parent); }
    setExpanded((old) => ({ ...old, ...opened }));
    requestAnimationFrame(() => refs.current[node.id]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
  async function selectPlugin(id) {
    const known = Object.values(pages).flatMap((page) => list(page.nodes)).find((n) => n.plugin_id === id || n.id === id);
    if (known) return select(known.id);
    try {
      const found = await api(base, '/api/search?' + new URLSearchParams({ q: id, mode: 'fulltext', limit: '20', include_github_only: filter }));
      const match = list(found.results).find((r) => r.id === id || r.node_id === id);
      await select(match?.node_id || id);
    } catch (e) { setError('详情：' + e.message); }
  }
  async function copyInstall() {
    try { await navigator.clipboard.writeText(text(install)); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1500); }
    catch (e) { setError('复制：' + e.message); }
  }
  function renderNode(node, depth = 0) {
    const children = tree.filter((n) => n.parent === node.id && n.id !== node.id);
    const page = pages[node.id];
    return (
      <div key={node.id} ref={node.type === 'category' ? (el) => { refs.current[node.id] = el; } : undefined} style={{ marginLeft: depth ? 14 : 0 }}>
        <button className="atlas-row" onClick={() => toggle(node)} aria-expanded={!!expanded[node.id]}>
          {expanded[node.id] ? '▾' : '▸'} {node.label} <small>({node.plugin_count ?? 0})</small>
        </button>
        {expanded[node.id] && (
          <div>
            {children.map((n) => renderNode(n, depth + 1))}
            {node.type === 'branch' &&
              (page ? (
                <div style={{ marginLeft: 14 }}>
                  {list(page.nodes)
                    .filter((n) => n.type === 'plugin')
                    .map((n) => (
                      <button className="atlas-row" key={n.id} onClick={() => select(n.id)}>
                        · {n.label}
                      </button>
                    ))}
                  {page.has_more && <button onClick={() => loadPage(node, true)}>加载更多</button>}
                </div>
              ) : (
                <small>加载中…</small>
              ))}
          </div>
        )}
      </div>
    );
  }
  const roots = tree.filter(
    (n) => n.type === 'category' && !tree.some((p) => p.id === n.parent && p.type === 'category'),
  );
  const p = detail?.plugin,
    n = detail?.node;
  const install = p?.install_command || p?.install || (p?.package ? `npm install ${p.package}` : '');
  const provided = list(detail?.branch_capabilities?.union).filter((u) => list(u.provided_by).includes(p?.id));
  const categories = tree.filter((node) => node.type === 'category').sort((a, b) => (b.plugin_count ?? 0) - (a.plugin_count ?? 0)).slice(0, 12);
  const maxCount = Math.max(1, ...categories.map((node) => node.plugin_count ?? 0));
  const best = [...new Set(list(detail?.branch_capabilities?.union).map((u) => u.best_impl).filter((id) => id && id !== p?.id))];
  const source = p?.summary_source || n?.summary_source;
  const statusKind = statusError ? 'offline' : !status || status.loading ? 'loading' : 'ready';
  return (
    <div className="atlas-root">
      <style>{`.atlas-root{padding:12px;color:inherit;font:inherit;overflow:auto;height:100%;min-width:0;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word}.atlas-root *{box-sizing:border-box}.atlas-root button,.atlas-root input,.atlas-root select{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:5px;min-width:0}.atlas-root button,.atlas-root input:not([type=checkbox]),.atlas-root select{height:28px;padding:3px 7px}.atlas-root button{cursor:pointer}.atlas-root button:disabled{opacity:.5;cursor:default}.atlas-root input[type=text]{flex:1;min-width:70px}.atlas-root form{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.atlas-root section,.atlas-status{border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:8px;padding:10px 12px;margin-bottom:12px;min-width:0}.atlas-root h2,.atlas-root h3{font-size:14px;font-weight:700;margin:10px 0 8px}.atlas-root p{margin:8px 0}.atlas-muted,.atlas-root small{opacity:.65}.atlas-status-head{display:flex;align-items:center;gap:7px;min-width:0}.atlas-status-text{flex:1;min-width:0}.atlas-dot{width:8px;height:8px;flex:none;border-radius:50%}.atlas-ready{background:#35a86b}.atlas-loading{background:#e6a23c}.atlas-offline{background:#dc5b5b}.atlas-settings{margin-top:8px}.atlas-row{display:block;text-align:left;border:0!important;width:100%;height:auto!important;min-height:28px;overflow-wrap:anywhere;word-break:break-word}.atlas-result{padding:8px 0!important;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)!important}.atlas-snippet{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;opacity:.65}.atlas-badge{display:inline-block;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:5px;padding:1px 5px;margin:2px 4px 2px 0;font-size:.85em}.atlas-chart{width:100%;margin:4px 0 10px}.atlas-chart-row{display:flex;align-items:center;height:20px;cursor:pointer}.atlas-chart-row:hover,.atlas-chart-row:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent)}.atlas-chart-label{flex:0 0 96px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.atlas-chart-track{flex:1;min-width:0}.atlas-chart-bar{height:8px;border-radius:4px;background:color-mix(in srgb,currentColor 35%,transparent)}.atlas-chart-count{flex:0 0 48px;text-align:right;font-size:11px}.atlas-root pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;margin:6px 0;font-family:monospace}.atlas-readme{max-height:240px;overflow:auto}.atlas-root a{color:inherit}.atlas-error{color:#d86565}.atlas-back{margin-bottom:10px}.atlas-capabilities{display:flex;flex-wrap:wrap;gap:4px}.atlas-root label{display:block;margin:8px 0}`}</style>
      <div className="atlas-status"><div className="atlas-status-head"><span className={'atlas-dot atlas-' + statusKind} /><div className="atlas-status-text"><strong>Plugin Atlas</strong> · {statusKind === 'offline' ? '未运行' : statusKind === 'loading' ? '加载中' : '就绪'}{statusKind === 'ready' && <small> · {status.counts?.plugins ?? 0} 个插件 · {status.semantic_backend || status.semantic?.label || ''}</small>}</div><button type="button" aria-label="服务地址设置" aria-expanded={settings} onClick={() => setSettings(!settings)}>⚙</button></div>
        {settings && <form className="atlas-settings" onSubmit={saveBase}><input type="text" aria-label="服务地址" value={draft} onChange={(e) => setDraft(e.target.value)} /><button>设置地址</button></form>}
        {statusError && <div className="atlas-error"><p>Plugin Atlas 服务未运行：在仓库根目录 bash web/start.sh，或在对话里运行 /atlas service start</p><small>{statusError}</small> <button onClick={() => setRetry((x) => x + 1)}>重试</button></div>}
      </div>
      {error && <p className="atlas-error" role="alert">{error}</p>}
      {detail ? <section><button className="atlas-back" onClick={() => setDetail(null)}>← 返回</button><h2>{p?.name || n?.label}</h2><p>{p?.summary || p?.description || n?.summary}</p>
        {(p?.github_only || n?.github_only) && <span className="atlas-badge">仅 GitHub</span>}
        {(p?.relevance === 'suspect' || n?.relevance === 'suspect' || p?.suspect_irrelevant || n?.suspect_irrelevant) && <span className="atlas-badge" title={p?.relevance_reason || n?.relevance_reason}>疑似无关</span>}
        {source && <span className="atlas-badge">摘要来源：{({ readme: 'README', metadata: '元数据', description_fallback: '描述首句（未经模型）' })[source] || source}</span>}
        {p && <><p>市场：{list(p.markets).map(text).join('、') || '未知'}</p>{install && <div><h3>安装命令</h3><pre>{text(install)}</pre><button onClick={copyInstall}>{copied ? '已复制' : '复制'}</button></div>}
          <h3>能力</h3><div className="atlas-capabilities">{list(p.capabilities).length ? list(p.capabilities).map((cap, i) => <span className="atlas-badge" key={i}>{text(cap)}</span>) : <small>暂无</small>}</div>
          <h3>所属分支能力</h3>{provided.length ? provided.map((u, i) => <p key={i}>{u.best_impl === p.id && '★ '}{text(u.capability)}{u.note ? ' · ' + text(u.note) : ''}</p>) : <p className="atlas-muted">暂无匹配条目</p>}
          <h3>同分支其他最佳实现</h3>{best.length ? best.map((id) => <button className="atlas-row" key={id} onClick={() => selectPlugin(id)}>★ {id}</button>) : <p className="atlas-muted">暂无</p>}
          {p.repo && /^https?:\/\//i.test(p.repo) && <a href={p.repo} target="_blank" rel="noopener noreferrer">代码仓库 ↗</a>}<h3>README</h3><pre className="atlas-readme">{detail.readme_markdown ? detail.readme_markdown.slice(0, 2000) : '暂无 README'}</pre></>}
      </section> : <><section><h3>搜索</h3><form onSubmit={search}><input type="text" aria-label="搜索插件" placeholder="搜索插件或能力" value={query} onChange={(e) => setQuery(e.target.value)} /><select aria-label="搜索模式" value={mode} onChange={(e) => setMode(e.target.value)}><option value="hybrid">混合</option><option value="fulltext">全文</option><option value="semantic">语义</option></select><button>搜索</button></form><label><input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} /> 包含仅 GitHub</label>
        {results && <div><small>{list(results.results).length} 条结果 · {results.semantic?.label}</small>{!list(results.results).length && <p>没有结果</p>}{list(results.results).map((r, i) => <button className="atlas-row atlas-result" key={r.id + i} disabled={!r.node_id} onClick={() => select(r.node_id)}><b>{r.title}</b> <span className="atlas-badge">{r.kind}</span><span className="atlas-snippet">{r.snippet}</span></button>)}</div>}</section>
        <section><h3>图谱</h3>{categories.length > 0 && <div className="atlas-chart" aria-label="分类插件数量排行">{categories.map((node) => <div className="atlas-chart-row" key={node.id} role="button" tabIndex={0} aria-label={node.label + '，' + (node.plugin_count ?? 0) + ' 个插件'} title={node.label + '：' + (node.plugin_count ?? 0)} onClick={() => openCategory(node)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCategory(node); } }}><div className="atlas-chart-label">{node.label}</div><div className="atlas-chart-track"><div className="atlas-chart-bar" style={{ width: (node.plugin_count ?? 0) / maxCount * 100 + '%' }} /></div><div className="atlas-chart-count">{node.plugin_count ?? 0}</div></div>)}</div>}{roots.map((node) => renderNode(node))}{!tree.length && <small>暂无图谱</small>}</section></>}
    </div>
  );
}
