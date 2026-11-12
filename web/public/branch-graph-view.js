/** Shared git-style branch graph renderer (web + dsh panel). No runtime deps. */
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function dateLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderBranchGraph(container, graph, options = {}) {
  if (!container) return;
  if (!graph || !graph.nodes?.length) {
    container.innerHTML = '<div class="bg-empty">这个分叉族还没有可绘制的分支。</div>';
    return;
  }
  const compact = !!options.compact;
  const rowH = compact ? 52 : 64;
  const pad = compact ? 12 : 20;
  const laneW = 16;
  const labelX = pad + graph.lanes * laneW + 8;
  const width = Math.max(labelX + 200 + pad, container.clientWidth || (compact ? 340 : 560));
  const height = pad * 2 + graph.rows * rowH;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const cx = (lane) => pad + lane * laneW + laneW / 2;
  const cy = (row) => pad + row * rowH + rowH / 2;
  const tracks = [];
  for (let lane = 0; lane < graph.lanes; lane++) {
    const nodes = graph.nodes.filter((n) => n.lane === lane);
    if (!nodes.length) continue;
    const y1 = cy(Math.min(...nodes.map((n) => n.row)));
    const y2 = cy(Math.max(...nodes.map((n) => n.row)));
    tracks.push(
      `<line class="bg-track${lane === 0 ? ' trunk' : ''}" x1="${cx(lane)}" y1="${y1}" x2="${cx(lane)}" y2="${y2}" />`,
    );
  }
  const edges = graph.edges.map((e) => {
    const a = byId.get(e.from),
      b = byId.get(e.to);
    if (!a || !b) return '';
    const x1 = cx(e.fromLane ?? a.lane),
      y1 = cy(e.fromRow ?? a.row),
      x2 = cx(e.toLane ?? b.lane),
      y2 = cy(e.toRow ?? b.row);
    const d = `M ${x1} ${y1} L ${x2} ${y2}`;
    return `<path class="bg-edge ${esc(e.type)}" d="${d}" fill="none" />`;
  });
  const dots = [];
  const labels = [];
  for (const n of graph.nodes) {
    const x = cx(n.lane),
      y = cy(n.row);
    const status = n.status || 'active';
    const title = esc(n.label || n.id);
    const diff =
      n.role === 'trunk' ||
      (n.role === 'cluster-head' && (!n.baseline || n.baseline === n.id)) ||
      n.role === 'collapsed'
        ? n.role === 'collapsed'
          ? `<span class="bg-count">+${n.count || 0}</span>`
          : `<span class="bg-role">${n.role === 'trunk' ? '主干' : '簇代表'}</span>`
        : `<span class="bg-diff" title="${esc((n.plusCaps || []).join('、'))}"><span class="plus">+${n.plus || 0}</span></span><span class="bg-diff" title="${esc((n.minusCaps || []).join('、'))}"><span class="minus">−${n.minus || 0}</span></span>`;
    const allCaps = n.unique || [];
    const unique = options.hideTags
      ? ''
      : allCaps
          .slice(0, 2)
          .map((c) => `<span class="bg-cap">${esc(c)}</span>`)
          .join('') +
        (allCaps.length > 2 ? `<span class="bg-more" data-id="${esc(n.id)}">+${allCaps.length - 2}</span>` : '');
    const selected = options.selectedId === n.id ? ' selected' : '';
    const clusterClick = n.role === 'collapsed' && n.cluster ? ` data-cluster="${esc(n.cluster)}"` : '';
    dots.push(
      `<circle class="bg-dot ${esc(n.role)} ${esc(status)}${selected}" data-id="${esc(n.id)}"${clusterClick} cx="${x}" cy="${y}" r="${n.role === 'trunk' ? 6 : 5}" />`,
    );
    labels.push(
      `<div class="bg-label ${esc(n.role)} ${esc(status)}${selected}" data-id="${esc(n.id)}" style="left:${labelX}px;top:${y - rowH / 2}px;right:${pad}px;height:${rowH}px">
          <button type="button" class="bg-name" data-id="${esc(n.id)}"${clusterClick} title="${title}">${title}</button>
          <span class="bg-meta">${esc(dateLabel(n.time))}</span>
          ${diff}
          ${n.clusterSize ? `<span class="bg-count">${esc(n.clusterLabel)} · ${n.clusterSize}</span><button type="button" class="bg-name bg-cluster-toggle" data-cluster="${esc(n.cluster)}" aria-expanded="${!!n.expanded}">${n.expanded ? '收起' : '展开'}</button>` : ''}
          ${n.baseline && n.baseline !== n.id ? `<span class="bg-meta">对比：${esc(n.baselineLabel || n.baseline)}</span>` : ''}
          ${unique}
        </div>`,
    );
  }
  const hidden = graph.truncated
    ? `<p class="bg-hint">${graph.kind === 'capability' ? `默认只显示簇代表，已隐藏 ${graph.hidden} 个成员。点击簇上的「展开」查看该簇。` : `已折叠 ${graph.hidden} 个分支。可展开全部，或点击折叠行查看。`}</p>`
    : '';
  container.innerHTML = `${hidden}<div class="bg-scroll"><div class="bg-plot" style="width:${width}px;height:${height}px"><svg class="bg-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="分叉族 ${esc(graph.family)} 的分支图">${tracks.join('')}${edges.join('')}${dots.join('')}</svg>${labels.join('')}</div></div>`;
  const select = (id) => {
    if (typeof options.onSelect === 'function') options.onSelect(id);
  };
  container.querySelectorAll('[data-id]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (el.getAttribute('data-cluster')) return;
      select(el.getAttribute('data-id'));
    });
  });
  container.querySelectorAll('[data-cluster]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      options.onToggleCluster?.(el.getAttribute('data-cluster'));
    });
  });
  const trunkNode = graph.nodes.find((n) => n.role === 'trunk');
  const scroll = container.querySelector?.('.bg-scroll');
  if (trunkNode && scroll?.clientHeight) {
    const y = cy(trunkNode.row);
    if (y > scroll.clientHeight * 0.75 || y < 0) {
      scroll.scrollTop = Math.max(0, y - scroll.clientHeight / 3);
    }
  }
}

export { renderBranchGraph, dateLabel };
