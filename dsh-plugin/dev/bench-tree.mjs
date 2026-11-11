import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { buildTree } from '../lib/tree/caps.mjs';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const graph = JSON.parse(await fs.readFile(path.join(dataDir, 'graph.json'), 'utf8'));
const plugins = (await fs.readFile(path.join(dataDir, 'plugins.jsonl'), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse);
const capabilities = {};
async function readCapabilities(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await readCapabilities(file);
    else if (entry.name.endsWith('.json'))
      capabilities[path.basename(entry.name, '.json')] = JSON.parse(await fs.readFile(file, 'utf8'));
  }
}
await readCapabilities(path.join(dataDir, 'capabilities'));
const start = performance.now();
const index = buildTree({ graph, plugins, capabilities });
console.log(
  `构建耗时：${(performance.now() - start).toFixed(0)} ms；节点：${index.nodes.size}；插件：${plugins.length}`,
);

const { planTreeSync } = await import('../lib/tree/fusion.mjs');
const { readLines } = await import('../lib/io.mjs');
const [dedupMerged, filteredOut] = await Promise.all([
  readLines(path.join(dataDir, 'dedup-merged.jsonl')),
  readLines(path.join(dataDir, 'filtered-out.jsonl')),
]);
const hashes = new Map();
const hashStart = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: 64 }, async () => {
    while (next < plugins.length) {
      const p = plugins[next++];
      if (!p.readme_path) continue;
      const file = path.resolve(dataDir, p.readme_path.replace(/^\.?\/?data\//, ''));
      if (!file.startsWith(dataDir + path.sep)) continue;
      try {
        hashes.set(
          p.id,
          createHash('sha256')
            .update(await fs.readFile(file))
            .digest('hex'),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }),
);
console.log(`README 哈希准备：${(performance.now() - hashStart).toFixed(0)} ms；数量：${hashes.size}`);
const fusionStart = performance.now();
const patch = planTreeSync({
  graph,
  plugins,
  capabilities,
  dedupMerged,
  filteredOut,
  readmeHash: (p) => hashes.get(p.id) || null,
});
console.log(
  `融合耗时：${(performance.now() - fusionStart).toFixed(0)} ms；操作：${JSON.stringify(patch.counts)}；变更：${JSON.stringify(Object.fromEntries(Object.entries(patch.changed).map(([k, v]) => [k, v.length])))}`,
);
