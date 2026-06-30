export function formatAppVersion(version: string) {
  return version.startsWith("v") ? version : `v${version}`;
}
