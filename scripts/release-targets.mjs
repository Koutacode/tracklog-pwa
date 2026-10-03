export const SOURCE_REPOSITORY = 'Koutacode/tracklog-pwa';
export const DISTRIBUTION_REPOSITORY = 'Koutacode/tracklog-releases';
export const APK_NAME = 'tracklog-assist-debug.apk';

export function releaseTargets(pkg) {
  const config = pkg.tracklogRelease;
  if (`${config?.githubOwner}/${config?.githubRepo}` !== DISTRIBUTION_REPOSITORY
      || config?.apkAssetName !== APK_NAME
      || !['bridge', 'distribution'].includes(config?.migrationPhase)) {
    throw new Error('Unreviewed release destination or migration phase');
  }
  return config.migrationPhase === 'bridge'
    ? [DISTRIBUTION_REPOSITORY, SOURCE_REPOSITORY]
    : [DISTRIBUTION_REPOSITORY];
}

// Never delete the bridge APK: old installations can only see the source repo.
export function removableAssets(releases, currentTag, repository) {
  if (repository !== DISTRIBUTION_REPOSITORY) return [];
  return releases.filter(release => !release.draft && release.tag_name !== currentTag)
    .flatMap(release => release.assets ?? [])
    .filter(asset => [APK_NAME, `${APK_NAME}.sha256`].includes(asset.name));
}
