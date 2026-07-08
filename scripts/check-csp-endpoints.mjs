import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');

const requiredConnectSources = [
  { source: 'https://*.supabase.co', reason: 'Supabase API' },
  { source: 'wss://*.supabase.co', reason: 'Supabase realtime/session transport' },
  { source: 'https://geoapi.heartrails.com', reason: 'reverse geocoding' },
  { source: 'https://api.github.com', reason: 'release update checks' },
  { source: 'https://maps.mail.ru', reason: 'IC / expressway fallback resolution' },
  { source: 'https://overpass-api.de', reason: 'IC / expressway resolution' },
  { source: 'https://router.project-osrm.org', reason: 'route map correction' },
];

const cspMatch = indexHtml.match(
  /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*\scontent="([^"]+)"/i,
);

if (!cspMatch) {
  console.error('Content-Security-Policy meta tag was not found in index.html.');
  process.exit(1);
}

const directives = new Map(
  cspMatch[1]
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [name, ...sources] = part.split(/\s+/);
      return [name, sources];
    }),
);

const connectSources = directives.get('connect-src') ?? [];
const missing = requiredConnectSources.filter(item => !connectSources.includes(item.source));

if (missing.length > 0) {
  console.error('CSP connect-src is missing required source(s):');
  for (const item of missing) {
    console.error(`- ${item.source} (${item.reason})`);
  }
  process.exit(1);
}

console.log(`CSP connect-src check passed (${requiredConnectSources.length} required source(s)).`);
