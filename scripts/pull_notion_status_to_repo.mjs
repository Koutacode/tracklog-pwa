import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const OUTPUT_FILE = 'docs/NOTION_SYNC_STATUS.md';

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

async function notionRequest(token, path) {
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    headers: notionHeaders(token),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${path} failed (${response.status}): ${text}`);
  }
  return response.json();
}

function renderMarkdown(rows, note = '') {
  const now = new Date().toISOString();
  const header = [
    '# Notion Sync Status',
    '',
    'このファイルは自動生成です。Notion側の最終更新時刻をGitHub側へミラーします。',
    '',
    `- Generated at (UTC): ${now}`,
    note ? `- Note: ${note}` : null,
    '',
    '| Page | Last Edited (UTC) | URL |',
    '| --- | --- | --- |',
  ].filter(Boolean);

  const body = rows.map(row => `| ${row.label} | ${row.lastEdited} | ${row.url} |`);
  return `${header.join('\n')}\n${body.join('\n')}\n`;
}

async function main() {
  const notionToken = getEnv('NOTION_TOKEN');
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
  ];

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });

  if (!notionToken) {
    const markdown = renderMarkdown(
      pages.map(page => ({ label: page.label, lastEdited: 'N/A', url: 'N/A' })),
      'NOTION_TOKEN is not configured',
    );
    await writeFile(OUTPUT_FILE, markdown, 'utf8');
    console.log('NOTION_TOKEN is not set; wrote placeholder status file.');
    return;
  }

  const rows = [];
  for (const page of pages) {
    try {
      const data = await notionRequest(notionToken, `/pages/${page.id}`);
      rows.push({
        label: page.label,
        lastEdited: data?.last_edited_time ?? 'unknown',
        url: data?.url ?? 'unknown',
      });
    } catch (error) {
      rows.push({
        label: page.label,
        lastEdited: 'error',
        url: `error: ${error.message.replace(/\|/g, '/')}`,
      });
    }
  }

  const markdown = renderMarkdown(rows);
  await writeFile(OUTPUT_FILE, markdown, 'utf8');
  console.log(`Wrote ${OUTPUT_FILE}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
