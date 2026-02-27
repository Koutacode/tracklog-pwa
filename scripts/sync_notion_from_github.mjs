const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DEFAULT_REPO = 'Koutacode/tracklog-pwa';
const DEFAULT_APK_NAME = 'tracklog-assist-debug.apk';

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
  const children = [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: richText(title) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`Commit: ${payload.sha}`) },
    },
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: richText(`Commit URL: ${payload.commitUrl}`) },
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

  const repo = getEnv('GITHUB_REPOSITORY', DEFAULT_REPO);
  const sha = getEnv('GITHUB_SHA', '').slice(0, 7) || 'manual';
  const commitUrl =
    sha === 'manual' ? `https://github.com/${repo}` : `https://github.com/${repo}/commit/${getEnv('GITHUB_SHA')}`;
  const release = await fetchLatestRelease(repo, getEnv('GITHUB_TOKEN'));
  const releaseUrl = release?.apkUrl ?? `https://github.com/${repo}/releases/latest/download/${DEFAULT_APK_NAME}`;
  const apkName = release?.apkName ?? DEFAULT_APK_NAME;
  const apkDigest = release?.apkDigest ?? 'unknown';
  const now = new Date();
  const dateLabel = now.toISOString().replace('T', ' ').slice(0, 16);

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
        commitUrl,
        releaseUrl,
        apkName,
        apkDigest,
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
