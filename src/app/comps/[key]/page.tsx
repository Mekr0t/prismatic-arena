// /comps/[key] — archetype detail drill-down (M6). The key is the URL-encoded
// grouping key ('m:<meta_comp label>' or 'c:<comp_id>'), linked from the tier
// list rows. Selection context (?patch=&region=&bucket=) mirrors /comps and
// resolves with the same defaults.

import { notFound, redirect } from 'next/navigation';
import { getCompDetailCached } from '@/server/comp-detail-service';
import { CompDetail } from '@/components/CompDetail';

export const dynamic = 'force-dynamic';

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function CompDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ patch?: string; region?: string; bucket?: string; variant?: string }>;
}) {
  const { key } = await params;
  const sp = await searchParams;
  const patchId = sp.patch ? Number(sp.patch) : undefined;

  const detail = await getCompDetailCached(decodeKey(key), {
    patchId: Number.isFinite(patchId) ? patchId : undefined,
    region: sp.region,
    rankBucket: sp.bucket,
    variant: sp.variant,
  });
  if (!detail) notFound();

  const back = new URLSearchParams({
    patch: String(detail.selection.patchId),
    region: detail.selection.region,
    bucket: detail.selection.rankBucket,
  });

  // The key we were asked for is not the key that matched, so the merge renamed
  // this archetype since the link was made. getCompDetail chased it; send the
  // visitor to the canonical URL so the bookmark stops being stale instead of
  // silently serving the right comp under a dead address forever.
  //
  // TEMPORARY on purpose: meta_comp is derived and can move again, so promising
  // permanence here would be a lie a browser would cache.
  if (detail.groupKey !== decodeKey(key)) {
    const qs = new URLSearchParams(back);
    if (sp.variant) qs.set('variant', sp.variant);
    redirect(`/comps/${encodeURIComponent(detail.groupKey)}?${qs.toString()}`);
  }
  // Base href for variant links: same key + selection, swap the ?variant.
  const variantBase = `/comps/${encodeURIComponent(decodeKey(key))}?${back.toString()}`;

  return (
    <main className="page">
      <CompDetail detail={detail} backHref={`/comps?${back.toString()}`} variantBase={variantBase} />
    </main>
  );
}
