// The dense tier table with RICH rows: tiers are sections (a band header per
// tier), each row is the comp's name + archetype tag + example team (trait strip
// + most-common board) on the left, the stat cell on the right. The badge stays
// in the section header (not repeated per row). Niche section appends when the
// toggle is on. Server component rendering the client ExampleTeam as a child.

import Link from 'next/link';
import { ExampleTeam } from './ExampleTeam';
import { StatCell } from './StatCell';
import type { TierGroupVM, CompRowVM } from '@/server/comps-service';

// Display labels for the intent archetype (#3). Standard gets no chip — it's the
// fallback, so a chip on most comps would be noise.
const ARCHETYPE_LABELS: Record<string, string> = {
  '1cost_reroll': '1-Cost Reroll',
  '2cost_reroll': '2-Cost Reroll',
  '3cost_reroll': '3-Cost Reroll',
  fast8: 'Fast 8',
  fast9: 'Fast 9',
};

function archetypeClass(archetype: string | null): string {
  if (!archetype) return '';
  return archetype.includes('reroll') ? 'tag-reroll' : 'tag-fast';
}

function CompRow({ row, detailQuery }: { row: CompRowVM; detailQuery: string }) {
  const archetype = row.identity.archetype;
  const tag = archetype ? ARCHETYPE_LABELS[archetype] : undefined;
  return (
    <div className="rich-row">
      <div className="rr-ident">
        <Link
          className="rr-name"
          href={`/comps/${encodeURIComponent(row.groupKey)}${detailQuery}`}
          title={row.identity.signature}
        >
          {row.identity.displayName ?? '—'}
        </Link>
        {tag && <span className={`rr-tag ${archetypeClass(archetype)}`}>{tag}</span>}
        {row.identity.dupUnits.length > 0 && (
          <span
            className="rr-tag tag-fast"
            title="Duplicate-augment build — fields two copies of these units"
          >
            Augment: 2× {row.identity.dupUnits.join(', ')}
          </span>
        )}
        {row.identity.heroAugmentUnit && (
          <span className="rr-tag tag-reroll" title="Hero-augment build">
            {row.identity.heroAugmentUnit} Hero Aug
          </span>
        )}
      </div>
      <ExampleTeam team={row.exampleTeam} />
      <StatCell row={row} />
    </div>
  );
}

export function TierTable({
  groups,
  niche,
  detailQuery = '',
}: {
  groups: TierGroupVM[];
  niche: CompRowVM[] | null;
  /** Search string appended to detail links so the selection round-trips. */
  detailQuery?: string;
}) {
  const empty = groups.length === 0;

  return (
    <div className="tier-tables">
      <div className="tier-table">
        {empty ? (
          <div className="tier-empty">
            No comps clear the sample threshold for this selection yet.{' '}
            <b>Turn on &ldquo;Show niche&rdquo; to see low-sample comps below the floor.</b>
          </div>
        ) : (
          groups.map((g) => (
            <section className="tier-section" key={g.tier}>
              <div className="tier-band">
                <span className={`tier-badge t-${g.tier}`}>{g.tier}</span>
                <span className="tb-count">
                  {g.comps.length} comp{g.comps.length === 1 ? '' : 's'}
                </span>
              </div>
              {g.comps.map((row) => (
                <CompRow key={row.identity.compId} row={row} detailQuery={detailQuery} />
              ))}
            </section>
          ))
        )}
      </div>

      {niche && niche.length > 0 && (
        <>
          <div className="niche-head">Niche &middot; below sample threshold</div>
          <div className="tier-table">
            {niche.map((row) => (
              <CompRow key={row.identity.compId} row={row} detailQuery={detailQuery} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}