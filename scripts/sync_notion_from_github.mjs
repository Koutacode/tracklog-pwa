import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DEFAULT_REPO = 'Koutacode/tracklog-pwa';
const DEFAULT_APK_NAME = 'tracklog-assist-debug.apk';
const DEFAULT_LOCAL_APK_PATH = 'output/tracklog-assist-debug.apk';
const DEFAULT_APP_ID = 'com.tracklog.assist';
const DEFAULT_APP_MODE = 'Android Native (Capacitor)';
const DEFAULT_DEVICE_VERIFICATION = '未記録（実機でクラッシュ/ANR/バックグラウンド継続を確認してください）';

function getEnv(name, fallback = '') {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionRequest(token, path, method = 'GET', body = undefined) {
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    method,
    headers: notionHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function plainTextFromBlock(block) {
  const blockType = block?.type;
  if (!blockType) return '';
  const payload = block?.[blockType];
  const richText = payload?.rich_text;
  if (!Array.isArray(richText)) return '';
  return richText.map(item => item?.plain_text ?? '').join('');
}

async function pageContainsMarker(token, pageId, marker) {
  let cursor = null;
  for (;;) {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const data = await notionRequest(token, `/blocks/${pageId}/children?${query.toString()}`);
    const blocks = Array.isArray(data?.results) ? data.results : [];
    if (blocks.some(block => plainTextFromBlock(block).includes(marker))) {
      return true;
    }
    if (!data?.has_more || !data?.next_cursor) {
      return false;
    }
    cursor = data.next_cursor;
  }
}

function richText(content) {
  return [{ type: 'text', text: { content } }];
}

function runGit(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function parseRepoFromRemote(remoteUrl) {
  if (!remoteUrl) return '';
  const normalized = remoteUrl.trim();
  const match = normalized.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!match) return '';
  return `${match[1]}/${match[2]}`;
}

function resolveRepo() {
  const envRepo = getEnv('GITHUB_REPOSITORY');
  if (envRepo) return envRepo;
  const remote = runGit('config', '--get', 'remote.origin.url');
  const parsed = parseRepoFromRemote(remote);
  return parsed || DEFAULT_REPO;
}

function splitList(raw) {
  return raw
    .split(/\r?\n|\|\|/g)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);
}

function resolveChangeItems() {
  const explicit = splitList(getEnv('NOTION_CHANGE_ITEMS'));
  if (explicit.length > 0) return explicit.slice(0, 6);

  const bodyItems = splitList(runGit('log', '-1', '--pretty=%b'));
  if (bodyItems.length > 0) return bodyItems.slice(0, 6);

  const subject = runGit('log', '-1', '--pretty=%s') || '更新内容はコミットを参照';
  return [subject];
}

function resolveCommitSubject() {
  return runGit('log', '-1', '--pretty=%s') || 'manual update';
}

function resolveBranch() {
  return getEnv('GITHUB_REF_NAME') || runGit('rev-parse', '--abbrev-ref', 'HEAD') || 'unknown';
}

async function computeLocalApkDigest(apkPath) {
  try {
    const content = await readFile(apkPath);
    return createHash('sha256').update(content).digest('hex').toUpperCase();
  } catch {
    return '';
  }
}

async function fetchLatestRelease(repo, token) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!response.ok) return null;
  const data = await response.json();
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const preferred =
    assets.find(asset => asset?.name === DEFAULT_APK_NAME) ||
    assets.find(asset => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.apk')) ||
    null;
  return {
    tag: data?.tag_name ?? 'unknown',
    pageUrl: data?.html_url ?? `https://github.com/${repo}/releases/latest`,
    apkName: preferred?.name ?? DEFAULT_APK_NAME,
    apkUrl: preferred?.browser_download_url ?? `https://github.com/${repo}/releases/latest/download/${DEFAULT_APK_NAME}`,
    apkDigest: preferred?.digest ?? 'unknown',
  };
}

async function appendSyncEntry(token, page, payload) {
  const title = `GitHub同期 ${payload.dateLabel}`;
  const marker = `sync:${payload.sha}`;
  const changeBlocks = payload.changeItems.map(item => ({
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: richText(item) },
  }));
  const children = [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: richText(title) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`App: ${payload.appMode} / ${payload.appId}`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`Branch: ${payload.branch}`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`Commit: ${payload.sha} (${payload.subject})`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`Commit URL: ${payload.commitUrl}`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`Release tag: ${payload.releaseTag}`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`Release URL: ${payload.releaseUrl}`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`APK: ${payload.apkName}`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`SHA-256: ${payload.apkDigest}`) },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText('主な変更点') },
    },
    ...changeBlocks,
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText('実機検証') },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(payload.deviceVerification) },
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: richText(marker) },
    },
  ];
  await notionRequest(token, `/blocks/${page.id}/children`, 'PATCH', { children });
}

async function main() {
  const notionToken = getEnv('NOTION_TOKEN');
  if (!notionToken) {
    console.log('NOTION_TOKEN is not set; skip Notion sync.');
    return;
  }

  const repo = resolveRepo();
  const fullSha = getEnv('GITHUB_SHA') || runGit('rev-parse', 'HEAD');
  const sha = fullSha ? fullSha.slice(0, 7) : 'manual';
  const commitUrl = fullSha ? `https://github.com/${repo}/commit/${fullSha}` : `https://github.com/${repo}`;
  const release = await fetchLatestRelease(repo, getEnv('GITHUB_TOKEN'));
  const localApkDigest = await computeLocalApkDigest(getEnv('LOCAL_APK_PATH', DEFAULT_LOCAL_APK_PATH));
  const releaseUrl = release?.apkUrl ?? `https://github.com/${repo}/releases/latest/download/${DEFAULT_APK_NAME}`;
  const apkName = release?.apkName ?? DEFAULT_APK_NAME;
  const apkDigest = release?.apkDigest && release.apkDigest !== 'unknown' ? release.apkDigest : localApkDigest || 'unknown';
  const releaseTag = release?.tag ?? 'unknown';
  const now = new Date();
  const dateLabel = now.toISOString().replace('T', ' ').slice(0, 16);
  const appId = getEnv('TRACKLOG_APP_ID', DEFAULT_APP_ID);
  const appMode = getEnv('TRACKLOG_APP_MODE', DEFAULT_APP_MODE);
  const branch = resolveBranch();
  const subject = resolveCommitSubject();
  const changeItems = resolveChangeItems();
  const deviceVerification = getEnv('NOTION_DEVICE_VERIFICATION', DEFAULT_DEVICE_VERIFICATION);

  const pages = [
    {
      id: getEnv('NOTION_PAGE_TRACKLOG', '30df211614fb81b59890f008e58b0ae1'),
      label: 'TrackLog運行アシスト｜機能・アップデート・配布情報',
    },
    {
      id: getEnv('NOTION_PAGE_APPS', '2cdf211614fb80b58871c794da36f983'),
      label: '個人アプリ',
    },
    {
      id: getEnv('NOTION_PAGE_IMPROVEMENTS', '300f211614fb80c6b8f9d11e4d0bb8b6'),
      label: '改善点',
    },
  ].filter(page => page.id);

  const marker = `sync:${sha}`;
  for (const page of pages) {
    try {
      const exists = await pageContainsMarker(notionToken, page.id, marker);
      if (exists) {
        console.log(`[skip] ${page.label}: marker already exists (${marker})`);
        continue;
      }
      await appendSyncEntry(notionToken, page, {
        sha,
        subject,
        branch,
        appId,
        appMode,
        releaseTag,
        commitUrl,
        releaseUrl,
        apkName,
        apkDigest,
        changeItems,
        deviceVerification,
        dateLabel,
      });
      console.log(`[ok] ${page.label}`);
    } catch (error) {
      console.error(`[error] ${page.label}: ${error.message}`);
      throw error;
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
