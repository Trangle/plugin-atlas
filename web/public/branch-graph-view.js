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
  const laneW = compact ? 18 : 22;
  const rowH = compact ? 40 : 48;
  const pad = compact ? 12 : 20;
  const labelX = pad + graph.lanes * laneW + 14;
  const labelW = compact ? 280 : 420;
  const width = Math.max(labelX + labelW + pad, compact ? 340 : 560);
  const height = pad * 2 + graph.rows * rowH;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const cx = (lane) => pad + lane * laneW + 6;
  const cy = (row) => pad + row * rowH + rowH / 2;
  const tracks = [];
  for (let lane = 0; lane < graph.lanes; lane++) {
    const nodes = graph.nodes.filter((n) => n.lane === lane);
    if (!nodes.length && lane !== 0) continue;
    const y1 = lane === 0 ? pad : cy(Math.min(...nodes.map((n) => n.row)));
    const y2 = lane === 0 ? height - pad : cy(Math.max(...nodes.map((n) => n.row)));
    tracks.push(
      `<line class="bg-track${lane === 0 ? ' trunk' : ''}" x1="${cx(lane)}" y1="${y1}" x2="${cx(lane)}" y2="${y2}" />`,
    );
  }
  const edges = graph.edges.map((e) => {
    const a = byId.get(e.from),
      b = byId.get(e.to);
    if (!a || !b) return '';
    const x1 = cx(a.lane),
      y1 = cy(a.row),
      x2 = cx(b.lane),
      y2 = cy(b.row);
    const midY = e.type === 'merge-suggest' ? (y1 + y2) / 2 : y1 + Math.min(18, (y2 - y1) / 2);
    const d =
      e.type === 'merge-suggest'
        ? `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
        : x1 === x2
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
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
      n.role === 'trunk' || n.role === 'collapsed'
        ? n.role === 'collapsed'
          ? `<span class="bg-count">${n.count || 0}</span>`
          : '<span class="bg-role">主干</span>'
        : `<span class="bg-diff" title="${esc((n.plusCaps || []).join('、'))}"><span class="plus">+${n.plus || 0}</span></span><span class="bg-diff" title="${esc((n.minusCaps || []).join('、'))}"><span class="minus">−${n.minus || 0}</span></span>`;
    const unique = compact
      ? ''
      : (n.unique || [])
          .slice(0, 4)
          .map((c) => `<span class="bg-cap">${esc(c)}</span>`)
          .join('');
    const selected = options.selectedId === n.id ? ' selected' : '';
    dots.push(
      `<circle class="bg-dot ${esc(n.role)} ${esc(status)}${selected}" data-id="${esc(n.id)}" cx="${x}" cy="${y}" r="${n.role === 'trunk' ? 6 : 5}" />`,
    );
    labels.push(
      `<div class="bg-label ${esc(n.role)} ${esc(status)}${selected}" data-id="${esc(n.id)}" style="left:${labelX}px;top:${y - rowH / 2}px;width:${labelW}px;height:${rowH}px">
          <button type="button" class="bg-name" data-id="${esc(n.id)}" title="${title}">${title}</button>
          <span class="bg-meta">${esc(dateLabel(n.time))}</span>
          ${diff}
          ${unique}
        </div>`,
    );
  }
  const hidden = graph.truncated
    ? `<p class="bg-hint">已折叠 ${graph.hidden} 个分支。可展开全部，或点击「另 N 个分支」查看。</p>`
    : '';
  container.innerHTML = `${hidden}<div class="bg-scroll"><div class="bg-plot" style="width:${width}px;height:${height}px"><svg class="bg-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="分叉族 ${esc(graph.family)} 的分支图">${tracks.join('')}${edges.join('')}${dots.join('')}</svg>${labels.join('')}</div></div>`;
  const select = (id) => {
    if (typeof options.onSelect === 'function') options.onSelect(id);
  };
  container.querySelectorAll('[data-id]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      select(el.getAttribute('data-id'));
    });
  });
}

export { renderBranchGraph, dateLabel };
