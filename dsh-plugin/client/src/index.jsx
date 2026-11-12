import { useEffect, useRef, useState } from 'react';
import { renderBranchGraph } from '../../../web/public/branch-graph-view.js';
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
const list = (x) => (Array.isArray(x) ? x : []);
const text = (x) => (typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x));
async function api(base, path) {
  const c = new AbortController(),
    t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(base.replace(/\/+$/, '') + path, { signal: c.signal });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw Error(e.name === 'AbortError' ? '请求超时（30 秒）' : e.message);
  } finally {
    clearTimeout(t);
  }
}
function initialBase() {
  try {
    return localStorage.getItem('plugin-atlas.base') || defaultBase;
  } catch {
    return defaultBase;
  }
}
function Icon({ name }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === 'settings' ? (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 3a7 7 0 0 0-1.7 1L6.1 6l-2 3.5 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.3-1a7 7 0 0 0 1.7 1l.4 3h4l.4-3a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2-1.5a7 7 0 0 0 .1-1Z" />
        </>
      ) : (
        <path d={name === 'down' ? 'm6 9 6 6 6-6' : name === 'back' ? 'm15 18-6-6 6-6' : 'm9 6 6 6-6 6'} />
      )}
    </svg>
  );
}
export const styles = `
.atlas-root{--bg:light-dark(#fff,#1c2225);--surface:light-dark(#f2f5f4,#273033);--text:light-dark(#202b2d,#edf4f2);--muted:light-dark(#536461,#b7c8c3);--line:light-dark(#ccd8d4,#465854);--accent:light-dark(#086e61,#79d8c4);--selected:light-dark(#dcefeb,#304b44);--ui:light-dark(#e1edf6,#263e4c);--tools:light-dark(#f4ead7,#493d29);--other:light-dark(#ecece6,#393e37);background:var(--bg);color:var(--text);font-family:var(--dsh-font-family-text,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);font-size:var(--dsh-content-font-size,13px);line-height:1.45;height:100%;min-width:0;overflow:auto;padding:12px;box-sizing:border-box;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;scrollbar-color:var(--line) transparent;caret-color:var(--accent)}
.atlas-root *{box-sizing:border-box}.atlas-root ::selection{background:var(--selected)}.atlas-root button,.atlas-root input,.atlas-root select{font:inherit;color:inherit;min-width:0}.atlas-root button,.atlas-root input:not([type=checkbox]),.atlas-root select{border:1px solid var(--line);background:var(--bg);border-radius:6px;padding:5px 8px;min-height:32px}.atlas-root button{cursor:pointer;transition:background-color 150ms ease-out,color 150ms ease-out}.atlas-root button:hover{background:var(--surface)}.atlas-root button:active{background:var(--selected)}.atlas-root button:disabled{opacity:.55;cursor:not-allowed}.atlas-root :focus-visible{outline:2px solid var(--accent);outline-offset:2px}.atlas-root input::placeholder{color:var(--muted);opacity:1}.atlas-root svg:not(.bg-svg){width:16px;height:16px;flex:none}.atlas-root .bg-svg{width:auto;height:auto;max-width:none;flex:none}.atlas-root h2,.atlas-root h3,.atlas-root h4{line-height:1.3;margin:20px 0 8px}.atlas-root h2{font-size:16px}.atlas-root h3{font-size:14px}.atlas-root h4{font-size:13px}.atlas-root p{margin:8px 0}.atlas-root small,.atlas-muted{color:var(--muted)}.atlas-head{display:flex;align-items:center;gap:8px;min-width:0}.atlas-head strong{font-size:16px;white-space:nowrap}.atlas-head-status{display:flex;align-items:center;gap:5px;color:var(--muted);white-space:nowrap;font-size:12px}.atlas-count{margin-left:auto;white-space:nowrap;font-size:12px;color:var(--muted)}.atlas-dot{width:7px;height:7px;flex:none;border-radius:50%;background:light-dark(#9a5900,#f3c16f)}.atlas-dot.ready{background:light-dark(#08745c,#79d8b3)}.atlas-dot.offline{background:light-dark(#aa3535,#ffaaaa)}.atlas-icon-button{display:grid;place-items:center;padding:5px!important}.atlas-settings,.atlas-form{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.atlas-form input,.atlas-settings input{flex:1 1 130px}.atlas-tabs{display:flex;background:var(--surface);border-radius:8px;padding:3px;gap:3px;margin:16px 0}.atlas-tabs button{flex:1;border:0;background:transparent;min-width:0}.atlas-tabs button[aria-pressed=true]{background:var(--bg);color:var(--accent);font-weight:700}.atlas-chart-row{display:flex;align-items:center;gap:8px;height:24px;width:100%;text-align:left;border:0!important;padding:0 4px!important;min-height:0!important}.atlas-chart-label{flex:0 1 104px;min-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.atlas-chart-track{flex:1;min-width:0}.atlas-chart-bar{height:8px;border-radius:4px;background:var(--accent);opacity:.7}.atlas-chart-count{width:40px;text-align:right}.atlas-card{border:1px solid var(--line);border-radius:10px;padding:12px;margin:16px 0;min-width:0}.atlas-card h3:first-child{margin-top:0}.atlas-tree-row{display:flex;align-items:center;min-width:0;border-radius:6px}.atlas-tree-row.selected{background:var(--selected)}.atlas-tree-toggle{border:0!important;background:transparent!important;padding:4px!important;min-height:28px!important;display:grid;place-items:center}.atlas-tree-spacer{width:26px;flex:none}.atlas-tree-select{border:0!important;background:transparent!important;display:flex;align-items:center;gap:5px;flex:1;min-width:0;text-align:left;padding:4px!important;min-height:28px!important}.atlas-tree-label{flex:1;min-width:0;overflow-wrap:anywhere;white-space:normal}.atlas-badge{display:inline-block;border-radius:4px;background:var(--other);padding:1px 5px;font-size:12px;line-height:1.5}.atlas-badge.ui{background:var(--ui)}.atlas-badge.tools{background:var(--tools)}.atlas-cap-list{display:flex;flex-wrap:wrap;gap:4px}.atlas-cap-group{margin-top:12px}.atlas-cap-group h4{margin:0 0 5px}.atlas-more{margin-top:5px}.atlas-family{border-top:1px solid var(--line);padding-top:12px;margin-top:16px}.atlas-family h4{margin:0 0 6px}.atlas-code,.atlas-root pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.atlas-code{background:var(--surface);padding:8px;border-radius:6px;margin:8px 0}.atlas-row{display:block;width:100%;height:auto;text-align:left;border:0!important;border-bottom:1px solid var(--line)!important;border-radius:0!important;padding:10px 4px!important}.atlas-snippet{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--muted);margin-top:4px}.atlas-error{color:light-dark(#9d2828,#ffb5b5)}.atlas-root a{color:var(--accent);text-underline-offset:3px}.atlas-readme{max-height:240px;overflow:auto}.atlas-back{display:flex;align-items:center;gap:4px}.atlas-empty{padding:16px 0;color:var(--muted)}.atlas-skeleton span{display:block;height:12px;background:var(--surface);border-radius:4px;margin:12px 0}.atlas-skeleton span:nth-child(2){width:75%}.atlas-skeleton span:nth-child(3){width:50%}.atlas-find-results{border:1px solid var(--line);border-radius:6px;max-height:180px;overflow:auto}.atlas-find-results button{border:0;border-radius:0;width:100%;text-align:left}.atlas-find-results small{display:block}.atlas-root details summary{cursor:pointer}.atlas-root label{display:block;margin:8px 0}.atlas-graph-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0}.atlas-graph-toolbar input{flex:1 1 140px}.atlas-graph .bg-scroll{overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--bg)}.atlas-graph .bg-plot{position:relative}.atlas-graph .bg-svg{position:absolute;inset:0}.atlas-graph .bg-label{position:absolute;display:flex;align-items:center;gap:4px;overflow:hidden;font-size:12px;pointer-events:none}.atlas-graph .bg-name{pointer-events:auto;border:0!important;background:transparent!important;padding:0!important;min-height:0!important;border-radius:0!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:600}.atlas-graph .bg-cap{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:12px;white-space:nowrap;max-width:72px;overflow:hidden;text-overflow:ellipsis}.atlas-graph .bg-diff{white-space:nowrap;flex:none}.atlas-graph .bg-diff .plus{color:var(--accent);font-weight:650}.atlas-graph .bg-diff .minus{color:light-dark(#9d2828,#ffb5b5);font-weight:650}.atlas-graph .bg-meta,.atlas-graph .bg-role,.atlas-graph .bg-count{color:var(--muted);font-size:11px;white-space:nowrap}.atlas-graph .bg-hint{color:var(--muted);margin:0 0 8px}.atlas-graph .bg-dot{fill:var(--accent);stroke:var(--bg);stroke-width:2}.atlas-graph .bg-dot.duplicate,.atlas-graph .bg-dot.dead{fill:var(--muted);opacity:.7}.atlas-graph .bg-dot.collapsed{fill:none;stroke:var(--muted);stroke-dasharray:2 2}.atlas-graph .bg-track{stroke:var(--line);stroke-width:1.5}.atlas-graph .bg-track.trunk{stroke:var(--accent);stroke-width:2;opacity:.55}.atlas-graph .bg-edge{stroke:var(--accent);stroke-width:1.75;fill:none}.atlas-graph .bg-edge.merge-suggest{stroke:var(--muted);stroke-dasharray:5 4;stroke-width:1.5}
.atlas-root.graph-mode{display:flex;flex-direction:column;overflow:hidden}.atlas-root.graph-mode .atlas-graph{display:flex;flex-direction:column;flex:1;min-height:0}.atlas-graph-content:not([hidden]){display:flex;flex-direction:column;flex:1;min-height:0}.atlas-graph .bg-scroll{max-height:none;flex:1;min-height:0;overflow:auto}.atlas-graph .bg-label{font-size:13px;gap:6px}.atlas-graph .bg-name{max-width:none;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left}.atlas-graph .bg-meta{display:none}.atlas-graph .bg-cap{font-size:12px}.atlas-graph-detail{flex:none;max-height:25%;overflow:auto;border-top:1px solid var(--line);padding:6px 0;font-size:12px}.atlas-graph .bg-cluster-toggle{flex:none;font-size:12px;font-weight:650;color:var(--accent);white-space:nowrap;pointer-events:auto}
@media(max-width:390px){.atlas-root{padding:10px}.atlas-head{gap:5px}.atlas-head strong{font-size:14px}.atlas-tree-row .atlas-badge{font-size:11px}}@media(prefers-reduced-motion:reduce){.atlas-root *{scroll-behavior:auto!important;transition:none!important}}`;
export function EmptyState({ children }) {
  return <p className="atlas-empty">{children}</p>;
}
function Skeleton() {
  return (
    <div className="atlas-skeleton" role="status" aria-label="加载中">
      <span />
      <span />
      <span />
    </div>
  );
}
export function CapabilityCard({ node, caps, families, plans, onCopy, familyError, onFamilyRetry, onOpenGraph }) {
  const [more, setMore] = useState({});
  if (!node) return <EmptyState>选择树中的节点，查看能力与分叉族。</EmptyState>;
  return (
    <section className="atlas-card">
      <h3>{node.label || node.id} · 能力</h3>
      {!caps ? (
        <Skeleton />
      ) : caps.error ? (
        <p className="atlas-error">能力加载失败，请重试。</p>
      ) : (
        [
          ['ui', 'UI'],
          ['tools', 'Tools'],
          ['other', '其他'],
          ['unique', '独有'],
          ['missing', '缺失'],
        ].map(([key, label]) => {
          const entries = list(caps[key]);
          return (
            <div className="atlas-cap-group" key={key}>
              <h4>
                {label} <small>{entries.length}</small>
              </h4>
              {entries.length ? (
                <>
                  <div className="atlas-cap-list">
                    {entries.slice(0, more[key] ? undefined : 8).map((c, i) => (
                      <span className={'atlas-badge ' + key} key={i}>
                        {text(c.label || c.capability || c)}
                      </span>
                    ))}
                  </div>
                  {entries.length > 8 && (
                    <button className="atlas-more" onClick={() => setMore((old) => ({ ...old, [key]: !old[key] }))}>
                      {more[key] ? '收起' : `展开更多（${entries.length - 8}）`}
                    </button>
                  )}
                </>
              ) : (
                <small>暂无</small>
              )}
            </div>
          );
        })
      )}
      {familyError ? (
        <div className="atlas-family">
          <p className="atlas-error">加载分叉族：{familyError}</p>
          <button onClick={onFamilyRetry}>重试</button>
        </div>
      ) : families === null ? (
        <Skeleton />
      ) : families.length ? (
        families.map((f) => {
          const record = plans[f.id],
            plan = record?.plan,
            command = record?.command || `/atlas plan ${f.id} --dry-run`;
          return (
            <div className="atlas-family" key={f.id}>
              <h4>
                分叉族 <code>{f.id}</code>
              </h4>
              <p>
                代表节点：
                {list(f.representatives)
                  .map((r) => r.id)
                  .join('、') || '暂无'}
              </p>
              <p>计划状态：{f.planStatus || '无'}</p>
              {onOpenGraph && (
                <p>
                  <button type="button" onClick={() => onOpenGraph(f.id)}>
                    查看分支图
                  </button>
                </p>
              )}
              {record === undefined && f.planStatus !== '无' ? (
                <small>加载计划中</small>
              ) : plan ? (
                <>
                  <p>计划要点：{text(plan.summary) || text(plan.base && `基底：${plan.base}`) || '暂无摘要'}</p>
                  {list(plan.steps).length > 0 && (
                    <ul>
                      {list(plan.steps).map((s, i) => (
                        <li key={i}>{text(s)}</li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <div className="atlas-code">{command}</div>
                  <button onClick={() => onCopy(command)}>复制生成计划命令</button>
                </>
              )}
            </div>
          );
        })
      ) : (
        <p className="atlas-muted">此节点暂无分叉族。</p>
      )}
    </section>
  );
}
export function TreeView({ nodes, expanded, selected, caps, onToggle, onSelect, refs }) {
  const byParent = new Map(),
    ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const parent = n.parent !== n.id && ids.has(n.parent) ? n.parent : null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(n);
  }
  function render(n, depth, seen) {
    if (seen.has(n.id)) return null;
    const children = byParent.get(n.id) || [],
      next = new Set(seen).add(n.id),
      c = n.badges || caps[n.id];
    return (
      <div key={n.id}>
        <div
          className={'atlas-tree-row' + (selected === n.id ? ' selected' : '')}
          ref={(el) => {
            refs.current[n.id] = el;
          }}
          style={{ paddingLeft: Math.min(depth * 12, 72) }}
        >
          {children.length ? (
            <button
              className="atlas-tree-toggle"
              aria-label={(expanded[n.id] ? '折叠' : '展开') + n.label}
              aria-expanded={!!expanded[n.id]}
              onClick={() => onToggle(n)}
            >
              <Icon name={expanded[n.id] ? 'down' : 'right'} />
            </button>
          ) : (
            <span className="atlas-tree-spacer" />
          )}
          <button className="atlas-tree-select" onClick={() => onSelect(n)} aria-pressed={selected === n.id}>
            <span className="atlas-tree-label" title={n.label || n.id}>
              {n.label || n.id}
            </span>
            <small title="插件数">{n.plugin_count ?? (n.type === 'plugin' ? 1 : 0)}</small>
            {c && !c.error && (
              <>
                <span className="atlas-badge ui" title="界面能力总数">
                  ui {typeof c.ui === 'number' ? c.ui : list(c.ui).length}
                </span>
                <span className="atlas-badge tools" title="工具能力总数">
                  tools {typeof c.tools === 'number' ? c.tools : list(c.tools).length}
                </span>
              </>
            )}
          </button>
        </div>
        {expanded[n.id] && children.map((child) => render(child, depth + 1, next))}
      </div>
    );
  }
  return nodes.length ? (
    <div>{(byParent.get(null) || []).map((n) => render(n, 0, new Set()))}</div>
  ) : (
    <EmptyState>暂无能力目录，请检查数据或重试。</EmptyState>
  );
}
function AtlasBody({ useTabInfo }) {
  const { tab } = useTabInfo();
  const [base, setBase] = useState(initialBase),
    [draft, setDraft] = useState(base),
    [retry, setRetry] = useState(0),
    [status, setStatus] = useState(null),
    [statusError, setStatusError] = useState(''),
    [error, setError] = useState('');
  const [view, setView] = useState('概览'),
    [settings, setSettings] = useState(false),
    [tree, setTree] = useState(null),
    [expanded, setExpanded] = useState({}),
    [selected, setSelected] = useState(null),
    [caps, setCaps] = useState({}),
    [families, setFamilies] = useState(null),
    [familySummary, setFamilySummary] = useState(null),
    [summaryError, setSummaryError] = useState(''),
    [summaryRetry, setSummaryRetry] = useState(0),
    [familyError, setFamilyError] = useState(''),
    [familyRetry, setFamilyRetry] = useState(0),
    [plans, setPlans] = useState({});
  const [locate, setLocate] = useState(''),
    [matches, setMatches] = useState(null),
    [query, setQuery] = useState(''),
    [mode, setMode] = useState('hybrid'),
    [github, setGithub] = useState(false),
    [results, setResults] = useState(null),
    [searching, setSearching] = useState(false),
    [detail, setDetail] = useState(null),
    [detailLoading, setDetailLoading] = useState(false),
    [copied, setCopied] = useState(''),
    [graphFamily, setGraphFamily] = useState(''),
    [graphExpand, setGraphExpand] = useState(false),
    [graphClusters, setGraphClusters] = useState([]),
    [graphData, setGraphData] = useState(null),
    [graphSelectedId, setGraphSelectedId] = useState(null),
    [graphError, setGraphError] = useState(''),
    [graphLoading, setGraphLoading] = useState(false);
  const graphRef = useRef(null),
    refs = useRef({}),
    timer = useRef(null),
    pending = useRef(new Set()),
    generation = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!status?.loading || tab.visible === false) return;
    const id = setTimeout(() => setRetry((x) => x + 1), 3000);
    return () => clearTimeout(id);
  }, [status, tab.visible]);
  useEffect(() => {
    if (tab.visible === false) return;
    let active = true;
    generation.current++;
    pending.current.clear();
    setStatus(null);
    setStatusError('');
    setError('');
    setTree(null);
    setCaps({});
    setExpanded({});
    setSelected(null);
    setFamilies(null);
    setPlans({});
    setDetail(null);
    setResults(null);
    api(base, '/api/status')
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch((e) => {
        if (active) setStatusError(e.message);
      });
    api(base, '/api/tree?include_github_only=' + (github ? '1' : '0'))
      .then((t) => {
        if (active) {
          const nodes = list(t.nodes);
          setTree(nodes);
          setExpanded(
            Object.fromEntries(nodes.filter((n) => !n.parent || n.type === 'category').map((n) => [n.id, true])),
          );
        }
      })
      .catch((e) => {
        if (active) {
          setTree([]);
          setError('加载能力目录：' + e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [base, retry, github, tab.visible]);
  useEffect(() => {
    if (tab.visible === false) return;
    let active = true;
    setFamilySummary(null);
    setSummaryError('');
    api(base, '/api/families?summary=1')
      .then((f) => {
        if (active) setFamilySummary(f);
      })
      .catch((e) => {
        if (active) setSummaryError(e.message);
      });
    return () => {
      active = false;
    };
  }, [base, retry, summaryRetry, tab.visible]);
  useEffect(() => {
    if (!selected || !tree) return;
    let node = selected,
      seen = new Set();
    while (node && node.type !== 'branch' && !seen.has(node.id)) {
      seen.add(node.id);
      node = tree.find((n) => n.id === node.parent);
    }
    const branch = node?.id || selected.id;
    let active = true;
    setFamilies(null);
    setFamilyError('');
    setPlans({});
    api(base, '/api/families?' + new URLSearchParams({ branch }))
      .then((f) => {
        if (!active) return;
        const items = list(f.families);
        setFamilies(items);
        items.forEach((item) =>
          api(base, '/api/plan?' + new URLSearchParams({ id: item.id }))
            .then((p) => {
              if (active) setPlans((old) => ({ ...old, [item.id]: p }));
            })
            .catch((e) => {
              if (active) setFamilyError('加载计划：' + e.message);
            }),
        );
      })
      .catch((e) => {
        if (active) setFamilyError(e.message);
      });
    return () => {
      active = false;
    };
  }, [selected, tree, base, familyRetry]);
  function toggle(n) {
    setExpanded((old) => ({ ...old, [n.id]: !old[n.id] }));
  }
  function choose(n) {
    setSelected(n);
    if ((!caps[n.id] || caps[n.id].error) && !pending.current.has(n.id)) {
      const gen = generation.current;
      pending.current.add(n.id);
      api(base, '/api/tree-node?' + new URLSearchParams({ id: n.id }))
        .then((value) => {
          if (gen === generation.current) setCaps((old) => ({ ...old, [n.id]: value }));
        })
        .catch((e) => {
          if (gen === generation.current) setError('加载能力：' + e.message);
        })
        .finally(() => pending.current.delete(n.id));
    }
  }
  async function find(e) {
    e.preventDefault();
    if (!locate.trim()) {
      setMatches([]);
      return;
    }
    try {
      setError('');
      const r = await api(base, '/api/tree-find?' + new URLSearchParams({ q: locate.trim(), limit: '20' }));
      setMatches(list(r.matches));
    } catch (err) {
      setError('定位：' + err.message);
    }
  }
  function locateMatch(match) {
    const path = list(match.path),
      additions = path.map((p, i) => ({
        ...p,
        parent: i ? path[i - 1].id : null,
        type: i === path.length - 1 ? match.type : 'branch',
      })),
      target = tree?.find((n) => n.id === match.id) || additions[additions.length - 1];
    setTree((old) => [...(old || []), ...additions.filter((n) => !(old || []).some((x) => x.id === n.id))]);
    setExpanded((old) => ({ ...old, ...Object.fromEntries(path.slice(0, -1).map((p) => [p.id, true])) }));
    setMatches(null);
    if (target) choose(target);
    requestAnimationFrame(() => refs.current[match.id]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  async function search(e) {
    e.preventDefault();
    setSearching(true);
    setResults(null);
    setError('');
    try {
      setResults(
        await api(
          base,
          '/api/search?' +
            new URLSearchParams({ q: query, mode, limit: '20', include_github_only: github ? '1' : '0' }),
        ),
      );
    } catch (err) {
      setError('搜索：' + err.message);
    } finally {
      setSearching(false);
    }
  }
  async function selectPlugin(id, resolve = false) {
    setDetailLoading(true);
    setDetail(null);
    setError('');
    try {
      if (resolve) {
        const found = await api(
          base,
          '/api/search?' +
            new URLSearchParams({ q: id, mode: 'fulltext', limit: '20', include_github_only: github ? '1' : '0' }),
        );
        id = list(found.results).find((r) => r.id === id || r.node_id === id)?.node_id || id;
      }
      setDetail(await api(base, '/api/node/' + encodeURIComponent(id) + '?lite=1'));
    } catch (err) {
      setError('加载详情：' + err.message);
    } finally {
      setDetailLoading(false);
    }
  }
  async function copy(value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(''), 1500);
    } catch (e) {
      setError('复制失败：' + e.message);
    }
  }
  function saveBase(e) {
    e.preventDefault();
    const next = draft.trim().replace(/\/+$/, '') || defaultBase;
    try {
      localStorage.setItem('plugin-atlas.base', next);
    } catch {}
    setDraft(next);
    setBase(next);
    setRetry((x) => x + 1);
    setSettings(false);
  }
  const categories = list(tree)
      .filter((n) => n.type === 'category')
      .sort((a, b) => (b.plugin_count || 0) - (a.plugin_count || 0))
      .slice(0, 12),
    max = Math.max(1, ...categories.map((n) => n.plugin_count || 0));

  const openGraph = (id) => {
    setGraphFamily(id || '');
    setView('分支图');
    setDetail(null);
  };
  useEffect(() => {
    if (view !== '分支图' || !graphFamily) {
      if (view === '分支图' && !graphFamily && selected) {
        setGraphFamily(selected.plugin_id || selected.id);
      }
      return;
    }
    let cancelled = false;
    setGraphLoading(true);
    setGraphError('');
    api(
      base,
      '/api/branch-graph?' +
        new URLSearchParams({
          family: graphFamily,
          expand: graphExpand ? '1' : '0',
          expandClusters: graphClusters.join(','),
        }),
    )
      .then((data) => {
        if (!cancelled) {
          setGraphData(data);
          setGraphLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setGraphError(e.message);
          setGraphData(null);
          setGraphLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, base, graphFamily, graphExpand, graphClusters, retry]);
  useEffect(() => {
    if (view === '分支图' && graphRef.current && graphData && !graphLoading) {
      renderBranchGraph(graphRef.current, graphData, {
        compact: true,
        hideTags: true,
        selectedId: graphSelectedId,
        onToggleCluster: (id) => {
          setGraphExpand(false);
          setGraphClusters((current) => {
            const selected = graphExpand ? graphData.clusters.map((cluster) => cluster.id) : current;
            return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
          });
        },
        onSelect: (id) => {
          if (id.startsWith('collapsed:')) setGraphExpand(true);
          else {
            setGraphSelectedId(id);
            const node = tree?.find((n) => n.id === id || n.plugin_id === id);
            if (node) choose(node);
            else setSelected({ id });
          }
        },
      });
    }
  }, [view, graphData, graphLoading, graphSelectedId, tree]);
  const related = families;
  const p = detail?.plugin,
    n = detail?.node,
    install = p?.install_command || p?.install || (p?.package ? `npm install ${p.package}` : ''),
    best = [
      ...new Set(
        list(detail?.branch_capabilities?.union)
          .map((u) => u.best_impl)
          .filter((id) => id && id !== p?.id),
      ),
    ];
  const statusKind = statusError ? 'offline' : !status || status.loading ? 'loading' : 'ready';
  return (
    <div className={`atlas-root${view === '分支图' ? ' graph-mode' : ''}`}>
      <style>{styles}</style>
      <header className="atlas-head">
        <strong>Plugin Atlas</strong>
        <span className="atlas-head-status">
          <span className={'atlas-dot ' + statusKind} />
          {statusKind === 'ready' ? '就绪' : statusKind === 'loading' ? '加载中' : '未启动'}
        </span>
        <span className="atlas-count">{status?.counts?.plugins != null ? `${status.counts.plugins} 个插件` : ''}</span>
        <button
          className="atlas-icon-button"
          aria-label="服务地址设置"
          aria-expanded={settings}
          onClick={() => setSettings(!settings)}
        >
          <Icon name="settings" />
        </button>
      </header>
      {settings && (
        <form className="atlas-settings" onSubmit={saveBase}>
          <input aria-label="服务地址" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button>保存地址</button>
        </form>
      )}
      <nav className="atlas-tabs" aria-label="面板视图">
        {['概览', '能力目录', '分支图', '搜索'].map((v) => (
          <button
            key={v}
            aria-pressed={view === v}
            onClick={() => {
              setView(v);
              setDetail(null);
            }}
          >
            {v}
          </button>
        ))}
      </nav>
      {statusError ? (
        <div className="atlas-card">
          <h3>服务未启动</h3>
          <p>启动 Plugin Atlas 服务后重试。</p>
          <div className="atlas-code">/atlas service start</div>
          <button onClick={() => copy('/atlas service start')}>
            {copied === '/atlas service start' ? '已复制' : '复制启动命令'}
          </button>{' '}
          <button onClick={() => setRetry((x) => x + 1)}>重试</button>
          <p className="atlas-muted">{statusError}</p>
        </div>
      ) : (
        <>
          {error && (
            <p role="alert" className="atlas-error">
              {error}
            </p>
          )}
          {view === '概览' &&
            (!status || !tree ? (
              <Skeleton />
            ) : (
              <>
                <h3>分类插件数量</h3>
                {categories.length ? (
                  <div>
                    {categories.map((node) => (
                      <button
                        className="atlas-chart-row"
                        key={node.id}
                        onClick={() => {
                          setView('能力目录');
                          choose(node);
                          const opened = { [node.id]: true };
                          let parent = tree.find((x) => x.id === node.parent);
                          const seen = new Set([node.id]);
                          while (parent && !seen.has(parent.id)) {
                            seen.add(parent.id);
                            opened[parent.id] = true;
                            parent = tree.find((x) => x.id === parent.parent);
                          }
                          setExpanded((old) => ({ ...old, ...opened }));
                        }}
                      >
                        <span className="atlas-chart-label" title={node.label}>
                          {node.label}
                        </span>
                        <span className="atlas-chart-track">
                          <span
                            className="atlas-chart-bar"
                            style={{ display: 'block', width: ((node.plugin_count || 0) / max) * 100 + '%' }}
                          />
                        </span>
                        <span className="atlas-chart-count">{node.plugin_count || 0}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyState>暂无分类数据，请检查数据或重试。</EmptyState>
                )}
                {status.recent_changes != null && <p>最近变化：{text(status.recent_changes)}</p>}
                {summaryError ? (
                  <div className="atlas-family">
                    <p className="atlas-error">加载分叉族概览：{summaryError}</p>
                    <button onClick={() => setSummaryRetry((x) => x + 1)}>重试</button>
                  </div>
                ) : (
                  familySummary && (
                    <p>
                      分叉族：{familySummary.computing ? '计算中' : familySummary.families} · 过期计划：
                      {familySummary.stale}
                    </p>
                  )
                )}
              </>
            ))}
          {view === '能力目录' && (
            <>
              <form className="atlas-form" onSubmit={find}>
                <input
                  placeholder="定位节点或能力"
                  aria-label="定位节点或能力"
                  value={locate}
                  onChange={(e) => setLocate(e.target.value)}
                />
                <button>定位</button>
              </form>
              {matches &&
                (matches.length ? (
                  <div className="atlas-find-results">
                    {matches.slice(0, 20).map((m) => (
                      <button key={m.id} onClick={() => locateMatch(m)}>
                        {m.label}
                        <small>
                          {list(m.path)
                            .map((x) => x.label)
                            .join(' / ')}
                        </small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyState>没有匹配节点，试试其他名称或能力关键词。</EmptyState>
                ))}
              {tree === null ? (
                <Skeleton />
              ) : (
                <TreeView
                  nodes={tree}
                  expanded={expanded}
                  selected={selected?.id}
                  caps={caps}
                  onToggle={toggle}
                  onSelect={choose}
                  refs={refs}
                />
              )}
              <CapabilityCard
                key={selected?.id || 'none'}
                node={selected}
                caps={selected && caps[selected.id]}
                families={related ?? null}
                plans={plans}
                onCopy={copy}
                familyError={familyError}
                onFamilyRetry={() => setFamilyRetry((x) => x + 1)}
                onOpenGraph={openGraph}
              />
            </>
          )}
          {view === '分支图' && (
            <div className="atlas-graph">
              <form
                className="atlas-form atlas-graph-toolbar"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = e.target.elements.family.value.trim();
                  if (value) setGraphFamily(value);
                }}
              >
                <input
                  key={graphFamily}
                  name="family"
                  defaultValue={graphFamily}
                  placeholder="分叉族或插件 id"
                  aria-label="分叉族"
                />
                <button>查看</button>
                <label>
                  <input type="checkbox" checked={graphExpand} onChange={(e) => setGraphExpand(e.target.checked)} />{' '}
                  展开全部
                </label>
              </form>
              {graphLoading && <Skeleton />}
              {graphError && <p className="atlas-error">加载分支图：{graphError}</p>}
              {!graphFamily && !graphLoading && <EmptyState>输入分叉族或从能力目录的分叉族打开分支图。</EmptyState>}
              {graphData && !graphLoading && (
                <p className="atlas-muted">
                  主干 {graphData.trunk}
                  {graphData.truncated ? ` · 已折叠 ${graphData.hidden}` : ''}
                </p>
              )}
              <div className="atlas-graph-content" ref={graphRef} hidden={graphLoading || !graphData} />
              {graphData?.nodes.find((item) => item.id === graphSelectedId) &&
                (() => {
                  const item = graphData.nodes.find((node) => node.id === graphSelectedId);
                  return (
                    <details className="atlas-graph-detail" open>
                      <summary>{item.label}</summary>
                      <div>
                        簇：{item.clusterLabel || '—'} · 对比基准：{item.baseline || '—'}
                      </div>
                      <div>新增：{item.plusCaps?.join('、') || '无'}</div>
                      <div>减少：{item.minusCaps?.join('、') || '无'}</div>
                      <div>独有：{item.unique?.join('、') || '无'}</div>
                      <div>原因：{item.reason || '—'}</div>
                    </details>
                  );
                })()}
            </div>
          )}
          {view === '搜索' &&
            (detailLoading ? (
              <Skeleton />
            ) : detail ? (
              <>
                <button className="atlas-back" onClick={() => setDetail(null)}>
                  <Icon name="back" />
                  返回搜索结果
                </button>
                <h2>{p?.name || n?.label}</h2>
                <p>{p?.summary || p?.description || n?.summary}</p>
                {p?.github_only && <span className="atlas-badge">仅 GitHub</span>}
                {p && (
                  <>
                    <p>市场：{list(p.markets).map(text).join('、') || '未知'}</p>
                    {install && (
                      <>
                        <h3>安装命令</h3>
                        <div className="atlas-code">{text(install)}</div>
                        <button onClick={() => copy(text(install))}>
                          {copied === text(install) ? '已复制' : '复制安装命令'}
                        </button>
                      </>
                    )}
                    <h3>能力</h3>
                    <div className="atlas-cap-list">
                      {list(p.capabilities).length ? (
                        list(p.capabilities).map((c, i) => (
                          <span className="atlas-badge" key={i}>
                            {text(c)}
                          </span>
                        ))
                      ) : (
                        <small>暂无</small>
                      )}
                    </div>
                    <h3>同分支最佳实现</h3>
                    {best.length ? (
                      best.map((id) => (
                        <button className="atlas-row" key={id} onClick={() => selectPlugin(id, true)}>
                          {id}
                        </button>
                      ))
                    ) : (
                      <p className="atlas-muted">暂无</p>
                    )}
                    {p.repo && /^https?:\/\//i.test(p.repo) && (
                      <p>
                        <a href={p.repo} target="_blank" rel="noopener noreferrer">
                          打开代码仓库
                        </a>
                      </p>
                    )}
                    <p className="atlas-muted">轻量详情不包含 README，请查看插件仓库。</p>
                  </>
                )}
              </>
            ) : (
              <>
                <form className="atlas-form" onSubmit={search}>
                  <input
                    placeholder="搜索插件或能力"
                    aria-label="搜索插件"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <select aria-label="搜索模式" value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="hybrid">混合</option>
                    <option value="fulltext">全文</option>
                    <option value="semantic">语义</option>
                  </select>
                  <button>搜索插件</button>
                </form>
                <label>
                  <input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} /> 包含仅 GitHub
                </label>
                {searching ? (
                  <Skeleton />
                ) : results ? (
                  <>
                    <small>
                      {list(results.results).length} 条结果 {results.semantic?.label && ' · ' + results.semantic.label}
                    </small>
                    {list(results.results).length ? (
                      list(results.results).map((r, i) => (
                        <button
                          className="atlas-row"
                          key={r.id + i}
                          disabled={!r.node_id}
                          onClick={() => selectPlugin(r.node_id)}
                        >
                          <strong>{r.title}</strong> <span className="atlas-badge">{r.kind}</span>
                          <span className="atlas-snippet">{r.snippet}</span>
                        </button>
                      ))
                    ) : (
                      <EmptyState>没有匹配的插件，试试能力关键词或勾选包含仅 GitHub。</EmptyState>
                    )}
                  </>
                ) : (
                  <EmptyState>输入插件名称或能力，搜索图谱。</EmptyState>
                )}
              </>
            ))}
        </>
      )}
    </div>
  );
}
