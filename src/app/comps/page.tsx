// /comps — the comp tier list. The editorial front door: one opinionated score
// per comp, niche hidden by default, three selectors. Server component driven by
// URL search params (?patch=&region=&bucket=&niche=), matching the match-detail
// page pattern (force-dynamic, async searchParams). No API route in v1.

import { getTierList } from '@/server/comps-service';
import { TierControls } from '@/components/TierControls';
import { TierTable } from '@/components/TierTable';

export const dynamic = 'force-dynamic';

function bucketLabel(b: string): string {
  return b.charAt(0).toUpperCase() + b.slice(1);
}

export default async function CompsPage({
  searchParams,
}: {
  searchParams: Promise<{ patch?: string; region?: string; bucket?: string; niche?: string }>;
}) {
  const sp = await searchParams;
  const patchId = sp.patch ? Number(sp.patch) : undefined;

  const data = await getTierList({
    patchId: Number.isFinite(patchId) ? patchId : undefined,
    region: sp.region,
    rankBucket: sp.bucket,
    niche: sp.niche === '1',
  });

  // Nothing clustered/rolled up yet — no selection is resolvable.
  if (!data.selection) {
    return (
      <main className="page">
        <section className="tier-page">
          <header className="tp-head">
            <h1>Comp tier list</h1>
          </header>
          <div className="tier-empty">
            No comp data yet. Run the <b>cluster</b> and <b>rollup</b> stages to populate the
            tier list.
          </div>
        </section>
      </main>
    );
  }

  const s = data.selection;

  return (
    <main className="page">
      <section className="tier-page">
        <header className="tp-head">
          <h1>Comp tier list</h1>
          <div className="tp-sub">
            Patch <b>{s.patch}</b> · <b>{s.region.toUpperCase()}</b> ·{' '}
            <b>{bucketLabel(s.rankBucket)}</b> — <b>{data.ranked}</b> ranked comp
            {data.ranked === 1 ? '' : 's'} from <b>{data.bucketTotal.toLocaleString()}</b>{' '}
            boards
          </div>
        </header>

        <TierControls
          options={data.options}
          selection={s}
          niche={!!data.niche}
          nicheAvailable={data.nicheAvailable}
        />

        <TierTable groups={data.groups} niche={data.niche} />
      </section>
    </main>
  );
}
