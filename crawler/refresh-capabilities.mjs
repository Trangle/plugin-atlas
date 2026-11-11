// Glue: after a merge changes category/branch membership, refresh capability files' "plugins" lists,
// drop ids that no longer exist; atomic write; then POST /api/reload.
//   data/capabilities/<category_id>.json            -> plugins = all plugins with category_id
//   data/capabilities/<category_id>/<branch_id>.json -> plugins = branch node subtree (graph.json plugin_ids)
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const dataDir = process.env.ATLAS_DATA_DIR || path.join(process.env.ATLAS_ROOT || process.cwd(), 'data');
const L = fs.readFileSync(path.join(dataDir, 'plugins.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const ids = new Set(L.map(p => p.id));
const G = JSON.parse(fs.readFileSync(path.join(dataDir, 'graph.json'), 'utf8'));
const branchIds = new Map(G.nodes.filter(n => n.type === 'branch').map(n => [n.id, n.plugin_ids || []]));
function fix(p, plugins) {
  const o = JSON.parse(fs.readFileSync(p, 'utf8'));
  o.plugins = plugins;
  for (const u of o.union || []) u.provided_by = (u.provided_by || []).filter(x => ids.has(x));
  o.duplicates = (o.duplicates || []).map(g => g.filter(x => ids.has(x))).filter(g => g.length > 1);
  const t = path.join(path.dirname(p), `.${path.basename(p)}.tmp`);
  fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, p);
  return plugins.length;
}
const root = path.join(dataDir, 'capabilities');
for (const f of fs.readdirSync(root)) {
  const full = path.join(root, f);
  if (f.startsWith('.')) continue;
  if (fs.statSync(full).isDirectory()) {
    for (const g of fs.readdirSync(full).filter(x => x.endsWith('.json') && !x.startsWith('.'))) {
      const bid = g.slice(0, -5);
      if (!branchIds.has(bid)) { console.warn('branch no longer in graph:', bid); continue; }
      console.log(`${f}/${bid}`, fix(path.join(full, g), branchIds.get(bid)));
    }
  } else if (f.endsWith('.json')) {
    const c = f.slice(0, -5);
    console.log(c, fix(full, L.filter(x => x.category_id === c).map(x => x.id)));
  }
}
if (!process.env.ATLAS_DATA_DIR) try { console.log(execFileSync('curl', ['-s', '--max-time', '200', '-X', 'POST', 'http://127.0.0.1:4380/api/reload'], { encoding: 'utf8' })); } catch (e) { console.warn('reload failed', e.message); }
