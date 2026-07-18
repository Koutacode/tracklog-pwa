import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const sourceRoot = join(root, 'src');

function listSourceFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? listSourceFiles(path)
      : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const forbidden = [];
for (const path of listSourceFiles(sourceRoot)) {
  const source = readFileSync(path, 'utf8');
  if (source.includes('driverSupabase.auth')) {
    forbidden.push(relative(root, path));
  }
}
if (forbidden.length > 0) {
  throw new Error(`Android data client must never own Auth refresh: ${forbidden.join(', ')}`);
}

const supabaseSource = readFileSync(join(sourceRoot, 'services', 'supabase.ts'), 'utf8');
if (!supabaseSource.includes('accessToken: getNativeDriverAccessToken')) {
  throw new Error('Android data requests must obtain access tokens from the native owner');
}
if (!supabaseSource.includes('export const driverAuthSupabase')) {
  throw new Error('Driver Auth and Android data clients must remain separate');
}

const resolverSource = readFileSync(join(sourceRoot, 'services', 'icResolver.ts'), 'utf8');
if (!resolverSource.includes('forceRefresh: true')) {
  throw new Error('Android IC resolver 401 retries must force refresh through the native owner');
}

console.log('driverAuthOwnership: 4 checks passed');
