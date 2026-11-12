import { renderBranchGraph } from './branch-graph-view.js';
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
const md = (s) => DOMPurify.sanitize(marked.parse(String(s || '')));
const params = (o) => new URLSearchParams(o),
  filter = () => ({ include_github_only: includeGithub ? '1' : '0' });
async function api(path, options) {
  const r = await fetch(path, options);
  let v;
  try {
    v = await r.json();
  } catch {
    throw Error('服务返回了无法读取的数据');
  }
  if (!r.ok) {
    const e = Error(v.error || r.statusText);
    e.status = r.status;
    throw e;
  }
  return v;
}
let tree = { nodes: [] },
  pages = new Map(),
  opened = new Set(),
  caps = new Map(),
  includeGithub = false,
  selected = null,
  detail = null,
  activeTab = '能力',
  requestId = 0,
  statusTimer,
  mainView = 'catalog',
  graphFamily = '',
  graphData = null,
  familyOptions = [];
const nodes = () => {
  const all = new Map(tree.nodes.map((n) => [n.id, n]));
  for (const n of [...pages.values()].flatMap((p) => p.nodes))
    all.set(n.id, n.type === 'plugin' ? n : { ...n, ...all.get(n.id) });
  return all;
};
const skeleton = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
const errorText = (e) =>
  `<p class="error">加载失败：${esc(e.message)}。请重试；如果服务未启动，请运行 <code>/atlas service start</code>。</p>`;
async function loadCaps(id) {
  if (caps.has(id)) return caps.get(id);
  try {
    const c = await api('/api/tree-node?' + params({ id }));
    caps.set(id, c);
    return c;
  } catch {
    return null;
  }
}
async function loadPage(id, more = false, around) {
  const old = pages.get(id),
    p = await api(
      '/api/children?' +
        params({
          ...filter(),
          node: id,
          limit: 200,
          offset: more ? old.offset + old.limit : 0,
          ...(around ? { around } : {}),
        }),
    );
  if (more) p.nodes = [...old.nodes, ...p.nodes];
  pages.set(id, p);
  return p;
}
async function toggle(id, force) {
  const n = nodes().get(id);
  if (!n || n.type === 'plugin') return;
  if (force === false || (force === undefined && opened.has(id))) {
    opened.delete(id);
    draw();
    return;
  }
  opened.add(id);
  if (!pages.has(id)) await loadPage(id);
  draw();
}
function draw() {
  const all = nodes(),
    children = new Map();
  for (const n of all.values()) {
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n);
  }
  let rows = [];
  function visit(n, depth) {
    const b = n.badges || {},
      can = n.type !== 'plugin' && (n.has_children || n.plugin_count > 0 || (children.get(n.id) || []).length);
    rows.push(
      `<div class="tree-row" data-depth="${depth}" style="--depth:${depth}"><button class="node ${selected === n.id ? 'selected' : ''}" role="treeitem" aria-level="${depth + 1}" ${can ? `aria-expanded="${opened.has(n.id)}"` : ''} aria-selected="${selected === n.id}" data-id="${esc(n.id)}" data-type="${esc(n.type)}"><svg class="chevron ${opened.has(n.id) ? 'open' : ''}" viewBox="0 0 12 12" aria-hidden="true">${can ? '<path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/>' : ''}</svg><span class="node-label">${esc(n.label || n.id)}</span>${n.type !== 'plugin' ? `<span class="badge" title="插件数">插件 ${n.plugin_count ?? 0}</span>${`<span class="badge ui" title="界面能力总数">ui ${b.ui ?? 0}</span><span class="badge tools" title="工具能力总数">tools ${b.tools ?? 0}</span>${b.unique > 0 ? `<span class="badge" title="相对同级独有的能力数">独有 ${b.unique}</span>` : ''}${b.missing > 0 ? `<span class="badge" title="相对同级缺失的能力数">缺失 ${b.missing}</span>` : ''}`}` : ''}</button></div>`,
    );
    if (opened.has(n.id)) {
      for (const child of children.get(n.id) || []) visit(child, depth + 1);
      const p = pages.get(n.id);
      if (p?.has_more)
        rows.push(
          `<button class="load-more" data-parent="${esc(n.id)}">加载更多（剩余 ${p.total - p.offset - p.limit}）</button>`,
        );
    }
  }
  for (const n of tree.nodes.filter((n) => !all.has(n.parent))) visit(n, 0);
  $('#graph').innerHTML = rows.join('') || '<p>没有可显示的节点，请重新加载数据。</p>';
  $('#graph')
    .querySelectorAll('.node')
    .forEach((el) => {
      el.onclick = async () => {
        try {
          await toggle(el.dataset.id);
          await select(el.dataset.id);
        } catch (e) {
          $('#detail').innerHTML = errorText(e);
        }
      };
      el.onkeydown = treeKey;
    });
  $('#graph')
    .querySelectorAll('.load-more')
    .forEach(
      (el) =>
        (el.onclick = async () => {
          try {
            await loadPage(el.dataset.parent, true);
            draw();
          } catch (e) {
            $('#detail').innerHTML = errorText(e);
          }
        }),
    );
}
async function treeKey(e) {
  const el = e.currentTarget,
    id = el.dataset.id,
    visible = [...document.querySelectorAll('#graph .node')],
    idx = visible.indexOf(el);
  let target;
  if (e.key === 'ArrowDown') target = visible[idx + 1];
  else if (e.key === 'ArrowUp') target = visible[idx - 1];
  else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (el.hasAttribute('aria-expanded') && !opened.has(id)) {
      await toggle(id, true);
      target = [...document.querySelectorAll('#graph .node')].find((x) => x.dataset.id === id);
    } else target = visible[idx + 1];
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (opened.has(id)) {
      await toggle(id, false);
      target = [...document.querySelectorAll('#graph .node')].find((x) => x.dataset.id === id);
    } else target = visible.find((x) => x.dataset.id === nodes().get(id)?.parent);
  } else return;
  e.preventDefault();
  target?.focus();
}
async function locate(id, missingOk = false) {
  let d;
  try {
    d = await api('/api/node/' + encodeURIComponent(id));
  } catch (e) {
    if (missingOk && e.status === 404) return false;
    throw e;
  }
  if (!d.ancestors.every((a) => tree.nodes.some((n) => n.id === a.id))) return false;
  for (const a of d.ancestors) {
    opened.add(a.id);
    if (!pages.has(a.id)) await loadPage(a.id);
  }
  if (d.node.type === 'plugin' && !nodes().has(id)) await loadPage(d.node.parent, false, id);
  if (!nodes().has(id)) return false;
  await select(id, d);
  const row = [...document.querySelectorAll('#graph .node')].find((x) => x.dataset.id === id);
  row?.scrollIntoView({ block: 'nearest' });
  row?.focus();
  return true;
}
const link = (id, label) => `<button class="linkbtn" data-node="${esc(id)}">${esc(label || id)}</button>`;
async function select(id, known) {
  const seq = ++requestId;
  selected = id;
  activeTab = '能力';
  draw();
  $('#detail').innerHTML = skeleton;
  try {
    const [d, c] = await Promise.all([known || api('/api/node/' + encodeURIComponent(id)), loadCaps(id)]);
    if (seq !== requestId) return;
    detail = { ...d, caps: c };
    renderDetail();
  } catch (e) {
    if (seq === requestId) $('#detail').innerHTML = errorText(e);
  }
}
function capGroup(title, items, total, cls = '') {
  return `<h3 class="group-label ${cls}">${title} <span class="muted">${esc(total ?? items.length)} · 显示前 ${items.length}</span></h3>${items.length ? `<ul class="cap-list">${items.map((x) => `<li><span>${esc(x.label || x.capability || x)}</span>${x.count ? `<span class="muted">${esc(x.count)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">暂无能力数据。</p>'}`;
}
function capabilities() {
  const c = detail.caps;
  if (!c) return '<p>能力数据加载失败，请重新选择节点重试。</p>';
  const parent = detail.ancestors.at(-1);
  return `${['ui', 'tools', 'other'].map((k) => capGroup({ ui: '界面能力', tools: '工具能力', other: '其他能力' }[k], c[k] || [], c.totals?.[k], k)).join('')}<h3>能力对比</h3><p class="muted">能力统计包含仅 GitHub 插件。相对于${parent ? esc(parent.label) + '下的同级' + (detail.node.type === 'plugin' ? '插件' : '节点') : '同级节点'}；缺失项为多个同级节点具备的能力。</p>${capGroup('独有能力', c.unique || [], c.totals?.unique)}${capGroup('缺失能力', c.missing || [], c.totals?.missing)}${detail.capabilities ? `<h3>所属分类 · 能力全集</h3><ul class="cap-list">${(detail.capabilities.union || []).map((u) => `<li><div><strong>${esc(u.capability)}</strong><p class="muted">${esc(u.note || '')}</p><span class="muted">提供插件：${(u.provided_by || []).map((id) => link(id)).join('、') || '未知'}</span>${u.best_impl ? `<p class="muted">最佳实现：${link(u.best_impl)}</p>` : ''}</div></li>`).join('')}</ul>${detail.capabilities.duplicates?.length ? `<h3>重复实现</h3>${detail.capabilities.duplicates.map((group) => `<p>${group.map((id) => link(id)).join(' ≈ ')}</p>`).join('')}` : ''}${detail.capabilities.vision ? `<div class="markdown">${md(detail.capabilities.vision)}</div>` : ''}` : ''}`;
}
function renderDetail() {
  const { node: n, plugin: p, ancestors } = detail;
  $('#detail').innerHTML =
    `<nav class="crumb" aria-label="节点路径">${ancestors.map((a) => link(a.id, a.label)).join(' / ')}${ancestors.length ? ' / ' : ''}${esc(n.label)}</nav><h2>${esc(n.label)}</h2><p class="detail-summary">${esc(n.summary || p?.summary || '暂无摘要')}</p><div class="chips">${n.github_only || p?.github_only ? '<span class="chip github-badge">仅 GitHub</span>' : ''}${p?.relevance === 'suspect' ? `<span class="chip relevance-suspect" title="${esc(p.relevance_reason || '疑似无关')}">疑似无关</span>` : ''}${p?.merged_from?.length ? `<span class="chip merged-from">已合并 ${p.merged_from.length} 个 GitHub 仓库</span>` : ''}${n.summary_source || p?.summary_source ? `<span class="chip summary-source">摘要来源：${esc({ readme: 'README', metadata: '元数据', description_fallback: '描述首句' }[n.summary_source || p.summary_source] || n.summary_source || p.summary_source)}</span>` : ''}</div>${p ? `<div class="plugin-meta"><span>版本 ${esc(p.version || '未知')}</span><span>stars ${esc(p.stars ?? '未知')}</span><span>${esc((p.markets || []).join('、') || '来源未知')}</span>${p.repo && /^https?:\/\//.test(p.repo) ? `<a href="${esc(p.repo)}" target="_blank" rel="noopener noreferrer">代码仓库</a>` : ''}</div>` : ''}<div class="tabs" role="tablist">${['能力', '分叉族', '插件', ...(p ? ['README'] : [])].map((t) => `<button class="tab" role="tab" aria-selected="${activeTab === t}" data-tab="${t}">${t}</button>`).join('')}</div><div class="tab-panel" role="tabpanel">${activeTab === '能力' ? capabilities() : skeleton}</div>`;
  $('#detail')
    .querySelectorAll('[data-node]')
    .forEach((b) => (b.onclick = () => locate(b.dataset.node)));
  $('#detail')
    .querySelectorAll('[data-tab]')
    .forEach(
      (b) =>
        (b.onclick = () => {
          activeTab = b.dataset.tab;
          renderDetail();
        }),
    );
  if (activeTab === 'README')
    $('.tab-panel').innerHTML = detail.readme_markdown
      ? `<div class="markdown">${md(detail.readme_markdown)}</div>`
      : '<p>暂无 README，可查看插件仓库获取说明。</p>';
  if (activeTab === '插件') renderPlugins();
  if (activeTab === '分叉族') renderFamilies();
}
function command(p) {
  return p?.startsWith('npm:') ? 'npm install ' + p.slice(4) : null;
}
function copyButtons(root) {
  root.querySelectorAll('[data-copy]').forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          b.textContent = '已复制';
        } catch {
          b.textContent = '复制失败，请手动选择命令';
        }
      }),
  );
}
async function renderPlugins() {
  const panel = $('.tab-panel'),
    id = selected,
    seq = requestId;
  try {
    const p = await api('/api/children?' + params({ ...filter(), node: id, limit: 50 }));
    if (seq !== requestId || activeTab !== '插件') return;
    let offset = 0;
    async function show(page) {
      if (seq !== requestId || activeTab !== '插件') return;
      const list = page.nodes.filter((n) => n.type === 'plugin');
      panel.innerHTML = `<h3>直接包含的插件</h3>${
        list.length
          ? list
              .map((n) => {
                const cmd = command(n.plugin_id);
                return `<div class="plugin-item"><strong>${link(n.id, n.label)}</strong><div class="plugin-meta"><span>stars ${esc(n.stars ?? '未知')}</span><span>来源 ${esc((n.markets || []).join('、') || '未知')}</span><span class="plugin-id">${esc(n.plugin_id || n.id)}</span></div>${cmd ? `<div class="command"><code>${esc(cmd)}</code><button data-copy="${esc(cmd)}">复制安装命令</button></div>` : '<p class="muted">暂无安装命令，请查看插件详情。</p>'}</div>`;
              })
              .join('')
          : '<p>此节点没有直接包含的插件，请展开子分支查看。</p>'
      }<div class="command"><button id="prev-page" ${offset === 0 ? 'disabled' : ''}>上一页</button><span class="muted">${page.total ? offset + 1 : 0}–${Math.min(offset + page.limit, page.total)} / ${page.total}</span><button id="next-page" ${!page.has_more ? 'disabled' : ''}>下一页</button></div>`;
      panel.querySelectorAll('[data-node]').forEach((b) => (b.onclick = () => locate(b.dataset.node)));
      copyButtons(panel);
      panel.querySelector('#prev-page').onclick = () => turn(-50);
      panel.querySelector('#next-page').onclick = () => turn(50);
    }
    async function turn(delta) {
      offset += delta;
      panel.innerHTML = skeleton;
      try {
        await show(await api('/api/children?' + params({ ...filter(), node: id, limit: 50, offset })));
      } catch (e) {
        panel.innerHTML = errorText(e);
      }
    }
    await show(p);
  } catch (e) {
    if (seq === requestId && activeTab === '插件') panel.innerHTML = errorText(e);
  }
}
async function renderFamilies() {
  const panel = $('.tab-panel'),
    seq = requestId,
    branch = detail.node.type === 'plugin' ? detail.node.parent : detail.node.id;
  try {
    const { families } = await api('/api/families?' + params({ branch }));
    if (seq !== requestId || activeTab !== '分叉族') return;
    if (!families.length) {
      panel.innerHTML = '<p>此节点没有分叉族，请选择含插件的末级分支。</p>';
      return;
    }
    panel.innerHTML = families
      .map(
        (f) =>
          `<section class="family" data-family="${esc(f.id)}"><h3>${esc(f.id.startsWith('dup:') ? '重复关系族' : '分叉族')} · ${esc(f.id)}</h3><p>成员 ${f.members.length} 个 · 合并计划：${esc(f.planStatus)}</p><p>代表节点：${f.representatives.length ? f.representatives.map((x) => link(x.id)).join('、') : '暂无'}</p><p>成员：${f.members.map((x) => link(x)).join('、') || '暂无'}</p><p><button type="button" data-graph="${esc(f.id)}">查看分支图</button></p><p class="muted">${f.id.startsWith('dup:') ? '这些成员存在 fork 或重复关系。' : '此族包含该末级分支的插件；重复关系另列。'}</p><div class="plan">${skeleton}</div></section>`,
      )
      .join('');
    panel.querySelectorAll('[data-node]').forEach((b) => (b.onclick = () => locate(b.dataset.node)));
    panel.querySelectorAll('[data-graph]').forEach((b) => (b.onclick = () => openBranchGraph(b.dataset.graph)));
    copyButtons(panel);
    for (const f of families) {
      const target = [...panel.querySelectorAll('[data-family]')]
        .find((x) => x.dataset.family === f.id)
        ?.querySelector('.plan');
      try {
        const record = await api('/api/plan?' + params({ id: f.id }));
        if (!target || seq !== requestId || activeTab !== '分叉族') continue;
        if (record.status === 'none') {
          target.innerHTML = planCommand(f.id, record.command);
          copyButtons(target);
          continue;
        }
        const p = record.plan || record;
        const fmt = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
        target.innerHTML = `<h4>基底</h4><p>${esc(p.base || '待选择')}</p>${['absorb', 'conflicts', 'steps'].map((k, i) => `<h4>${['吸收项', '冲突', '步骤'][i]}</h4>${p[k]?.length ? `<ul>${p[k].map((x) => `<li>${esc(fmt(x))}</li>`).join('')}</ul>` : '<p>暂无</p>'}`).join('')}`;
      } catch (e) {
        if (target) target.innerHTML = errorText(e);
      }
    }
  } catch (e) {
    if (seq === requestId && activeTab === '分叉族') panel.innerHTML = errorText(e);
  }
}
function planCommand(id, command) {
  const cmd = command || '/atlas plan ' + id + ' --dry-run';
  return `<p>暂无计划，可先生成预览命令。</p><div class="command"><code>${esc(cmd)}</code><button data-copy="${esc(cmd)}">复制生成合并计划命令</button></div>`;
}

function setMainView(view) {
  mainView = view === 'graph' ? 'graph' : 'catalog';
  $('main').classList.toggle('graph-mode', mainView === 'graph');
  if (mainView !== 'graph') closeGraphDrawer();
  const catalog = mainView === 'catalog';
  $('#tab-catalog')?.setAttribute('aria-selected', String(catalog));
  $('#tab-graph')?.setAttribute('aria-selected', String(!catalog));
  const title = $('#view-title');
  if (title) title.textContent = catalog ? '能力目录' : '分支图';
  if ($('#graph')) $('#graph').hidden = !catalog;
  if ($('#branch-graph-view')) $('#branch-graph-view').hidden = catalog;
}
let graphDrawerId = null;
function closeGraphDrawer() {
  graphDrawerId = null;
  $('#graph-drawer').hidden = true;
}
async function openGraphDrawer(id) {
  if (graphDrawerId === id) return closeGraphDrawer();
  const node = graphData?.nodes.find((n) => n.id === id);
  if (!node) return;
  graphDrawerId = id;
  $('#graph-drawer').hidden = false;
  const content = $('#graph-drawer-content');
  const groups = [
    ['新增能力', node.plusCaps],
    ['减少能力', node.minusCaps],
    ['独有能力', node.unique],
  ];
  const diff = groups
    .map(
      ([title, values]) =>
        `<h3>${title}</h3>${values?.length ? `<ul>${values.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : '<p class="muted">暂无</p>'}`,
    )
    .join('');
  content.innerHTML = `<h2>${esc(node.label || id)}</h2>${diff}`;
  try {
    const result = await api('/api/node/' + encodeURIComponent(id));
    if (graphDrawerId !== id) return;
    const info = result.node || {};
    content.innerHTML = `<h2>${esc(info.label || node.label || id)}</h2>${info.summary ? `<p>${esc(info.summary)}</p>` : ''}${diff}`;
  } catch (_) {
    // The graph still supplies the name and diff if details are unavailable.
  }
}
$('#graph-drawer-close').addEventListener('click', closeGraphDrawer);
async function ensureFamilyOptions() {
  if (familyOptions.length) return familyOptions;
  const all = await api('/api/families');
  const list = all.computing ? [] : all.families || [];
  if (all.computing) return [];
  familyOptions = list;
  const datalist = $('#graph-family-list');
  if (datalist)
    datalist.innerHTML = list
      .slice()
      .sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0))
      .slice(0, 400)
      .map((f) => `<option value="${esc(f.id)}">${esc(f.id)}（${f.members.length}）</option>`)
      .join('');
  return list;
}
async function loadBranchGraph(family, expand = $('#graph-expand')?.checked) {
  if (!family) {
    $('#branch-graph').innerHTML = '<p class="muted">选择一个分叉族，查看 git 式分支图。</p>';
    $('#graph-meta').textContent = '';
    return;
  }
  closeGraphDrawer();
  graphFamily = family;
  if ($('#graph-family')) $('#graph-family').value = family;
  $('#branch-graph').innerHTML = skeleton + '<p class="muted">正在加载分支图。</p>';
  $('#graph-meta').textContent = '加载中';
  try {
    const data = await api('/api/branch-graph?' + params({ family, expand: expand ? '1' : '0' }));
    graphData = data;
    const meta = [
      `主干 ${data.nodes.find((n) => n.id === data.trunk)?.label || data.trunk}`,
      `${data.nodes.length} 个节点`,
      data.truncated ? `已折叠 ${data.hidden}` : '已展开',
    ];
    $('#graph-meta').textContent = meta.join(' · ');
    renderBranchGraph($('#branch-graph'), data, {
      selectedId: selected,
      onSelect: async (id) => {
        if (id.startsWith('collapsed:')) {
          if ($('#graph-expand')) $('#graph-expand').checked = true;
          await loadBranchGraph(graphFamily, true);
          return;
        }
        await openGraphDrawer(id);
      },
    });
  } catch (e) {
    $('#branch-graph').innerHTML = errorText(e);
    $('#graph-meta').textContent = '';
  }
}
async function openBranchGraph(family) {
  setMainView('graph');
  await ensureFamilyOptions();
  const id =
    family ||
    graphFamily ||
    (detail?.node?.type === 'plugin' ? detail.node.plugin_id || detail.node.id : detail?.node?.id) ||
    selected;
  await loadBranchGraph(id);
}

async function refresh() {
  const s = await api('/api/status');
  if (!s.counts) {
    statusTimer = setTimeout(() => refresh().catch(showError), 300);
    return;
  }
  tree = await api('/api/tree?' + params(filter()));
  caps.clear();
  pages.clear();
  opened.clear();
  const root = tree.nodes.find((n) => !n.parent);
  if (root) opened.add(root.id);
  for (const n of tree.nodes.filter((n) => n.type === 'category')) opened.add(n.id);
  $('#source').textContent =
    `${s.example || s.source === 'fixtures' ? '示例数据' : '服务已连接'} · 插件 ${s.counts.plugins} · 语义后端 ${s.semantic.label}`;
  $('#github-count').textContent = `(${s.counts.github_only})`;
  $('#counts').textContent = `${root?.plugin_count ?? s.counts.plugin_nodes_visible} 个可见插件 · 选择节点查看详情`;
  draw();
  if (mainView === 'graph' && graphFamily) await loadBranchGraph(graphFamily, $('#graph-expand')?.checked);
  if (selected && !(await locate(selected, true))) {
    selected = null;
    detail = null;
    requestId++;
    $('#detail').innerHTML =
      '<div class="empty"><h2>选择一个节点</h2><p>从左侧能力目录选择分类、分支或插件，或打开分支图查看分叉关系。</p></div>';
    draw();
  }
}
function showError(e) {
  $('#source').textContent = '服务不可用';
  $('#graph').innerHTML = errorText(e);
}
$('#github-only').onchange = async (e) => {
  includeGithub = e.target.checked;
  try {
    await refresh();
    if (!$('#results').hidden) $('#search').requestSubmit();
  } catch (err) {
    showError(err);
  }
};
$('#search').onsubmit = async (e) => {
  e.preventDefault();
  const box = $('#results'),
    q = $('#query').value.trim();
  box.hidden = false;
  if (!q) {
    box.innerHTML = '<p>输入插件名称或能力关键词开始搜索。</p>';
    return;
  }
  box.innerHTML = skeleton;
  try {
    const [r, t] = await Promise.all([
      api('/api/search?' + params({ ...filter(), q, mode: $('#mode').value })),
      api('/api/tree-find?' + params({ q })),
    ]);
    const seen = new Set(r.results.map((x) => x.node_id));
    const extra = t.matches
      .filter((x) => !seen.has(x.id) && nodes().has(x.id))
      .slice(0, 10)
      .map((x) => ({
        title: x.label,
        kind: '节点',
        node_id: x.id,
        snippet: x.path.map((p) => p.label).join(' / '),
      }));
    const results = [...r.results, ...extra];
    box.innerHTML =
      `<div class="muted">${results.length} 条结果 · ${esc(r.semantic.label)}</div>` +
      (results.length
        ? results
            .map(
              (x) =>
                `<button class="result" ${x.node_id ? `data-id="${esc(x.node_id)}"` : 'disabled'}><strong>${esc(x.title)}</strong> <span class="muted">${esc(x.kind)}</span><p>${esc(x.snippet)}</p></button>`,
            )
            .join('')
        : '<p>没有匹配的插件，试试能力关键词或打开“包含仅 GitHub”。</p>');
    box.querySelectorAll('[data-id]').forEach(
      (b) =>
        (b.onclick = async () => {
          box.hidden = true;
          try {
            await locate(b.dataset.id);
          } catch (err) {
            $('#detail').innerHTML = errorText(err);
          }
        }),
    );
  } catch (err) {
    box.innerHTML = errorText(err);
  }
};
$('#reload').onclick = async (e) => {
  e.currentTarget.disabled = true;
  try {
    await api('/api/reload', { method: 'POST' });
    await refresh();
  } catch (err) {
    showError(err);
  } finally {
    e.currentTarget.disabled = false;
  }
};
const theme = $('#theme');
theme.value = localStorage.getItem('atlas-theme') || 'system';
function setTheme() {
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem('atlas-theme', theme.value);
}
theme.onchange = setTheme;
setTheme();
$('#tab-catalog').onclick = () => setMainView('catalog');
$('#tab-graph').onclick = () => openBranchGraph(graphFamily || selected);
$('#graph-load').onclick = () => loadBranchGraph($('#graph-family').value.trim(), $('#graph-expand').checked);
$('#graph-family').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadBranchGraph($('#graph-family').value.trim(), $('#graph-expand').checked);
  }
});
$('#graph-expand').onchange = () => {
  if (graphFamily) loadBranchGraph(graphFamily, $('#graph-expand').checked);
};
ensureFamilyOptions().catch(() => {});
refresh().catch(showError);
