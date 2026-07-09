// Community Dragon stores icons as game asset paths (e.g. "ASSETS/Characters/...").
// The general mapping: lowercase, swap the extension to .png, and serve from the
// CDragon "game" mount. VERIFY against a few real icon_path values from your
// catalog — asset-type prefixes vary, and this is the spot most likely to need a
// small tweak (same caveat as the static-data loader).
export function iconUrl(path?: string | null): string | null {
  if (!path) return null;
  let p = path.toLowerCase().replace(/^\/+/, '');
  p = p.replace(/\.(dds|tex)$/i, '.png');
  if (!p.endsWith('.png')) p += '.png';
  return `https://raw.communitydragon.org/latest/game/${p}`;
}
