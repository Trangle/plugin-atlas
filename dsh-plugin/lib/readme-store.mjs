import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliDecompressSync } from 'node:zlib';

const databases = new Map();
function statements(dbPath) {
  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const old = databases.get(dbPath);
    if (old) {
      old.db.close();
      databases.delete(dbPath);
    }
    return null;
  }
  const old = databases.get(dbPath);
  if (old && old.mtimeMs === stat.mtimeMs && old.ino === stat.ino && old.size === stat.size) return old;
  if (old) {
    old.db.close();
    databases.delete(dbPath);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const entry = {
      db,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      size: stat.size,
      body: db.prepare('SELECT body FROM readmes WHERE path = ?'),
      hash: db.prepare('SELECT sha256 FROM readmes WHERE path = ?'),
    };
    databases.set(dbPath, entry);
    return entry;
  } catch (error) {
    db.close();
    throw error;
  }
}

// root is the configured data directory, independent of the crawler checkout.
export function readReadme(root, readmePath) {
  if (!readmePath) return '';
  root = path.resolve(root);
  const rel = String(readmePath)
    .replace(/^\.\/?data\//, '')
    .replace(/^data\//, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const dbPath = path.join(root, 'readme-store.sqlite');
  const row = statements(dbPath)?.body.get(readmePath);
  return row ? brotliDecompressSync(row.body).toString('utf8') : '';
}

// Use the full-text hash for change detection when the stored body is truncated.
export function readmeHash(root, readmePath) {
  if (!readmePath) return null;
  root = path.resolve(root);
  const rel = String(readmePath)
    .replace(/^\.\/?data\//, '')
    .replace(/^data\//, '');
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  if (fs.existsSync(file)) return null; // Caller hashes the disk text.
  const dbPath = path.join(root, 'readme-store.sqlite');
  return statements(dbPath)?.hash.get(readmePath)?.sha256 || null;
}
