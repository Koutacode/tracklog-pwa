import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const swPath = path.join(distDir, 'sw.js');

async function listFiles(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      files.push(...await listFiles(absolute));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

const source = await readFile(swPath, 'utf8');
if (source.includes('__TRACKLOG_')) {
  throw new Error('sw.jsに未展開のプレースホルダーがあります');
}

const manifestMatch = source.match(/const PRECACHE = (\[[^\n]*\]);/);
if (!manifestMatch) {
  throw new Error('sw.jsのPRECACHEを読み取れません');
}

const precache = new Set(JSON.parse(manifestMatch[1]));
const required = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/apple-touch-icon.png',
  '/pwa-192.png',
  '/pwa-512.png',
  '/tiger-hero.svg',
];
for (const asset of required) {
  if (!precache.has(asset)) {
    throw new Error(`必須オフライン資産がありません: ${asset}`);
  }
}

const builtAssets = (await listFiles(path.join(distDir, 'assets')))
  .map(file => `/${path.relative(distDir, file).replace(/\\/g, '/')}`);
for (const asset of builtAssets) {
  if (!precache.has(asset)) {
    throw new Error(`ビルド資産がPRECACHEにありません: ${asset}`);
  }
}

if (!source.includes("cache.match('/index.html')")) {
  throw new Error('オフライン時の画面遷移fallbackがありません');
}

console.log(`Offline service worker check passed (${precache.size} precached files, ${builtAssets.length} build assets).`);
