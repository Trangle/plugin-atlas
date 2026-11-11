import fs from 'node:fs/promises';
import path from 'node:path';
async function readJson(p, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
async function readLines(p) {
  try {
    return (await fs.readFile(p, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
async function write(p, value) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, value);
  await fs.rename(tmp, p);
}
const json = (p, x) => write(p, JSON.stringify(x, null, 2) + '\n');
const lines = (p, x) => write(p, x.map((v) => JSON.stringify(v)).join('\n') + (x.length ? '\n' : ''));
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
export { json, lines, readJson, readLines, stamp, write };
