// Admin page for the merge archetype inspector. Lives in the guarded (panel)
// route group, so requireAdmin() in the layout covers it. Styling is minimal
// inline (dark-friendly). Uses native <details>/<summary>, so expand/collapse
// needs no client JS and this stays a pure server component.

import { loadArchetypeInspector } from '@/server/comp-inspector';
import { currentSet } from '@/server/static-data';

// Always read live merge output; never serve a cached snapshot for a debug view.
export const dynamic = 'force-dynamic';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const place = (x: number) => x.toFixed(2);

export default async function ArchetypeInspectorPage() {
  // Scoped to the LIVE set. Unscoped, this lists every set that has labels —
  // 61 set-17 archetypes interleaved with 33 set-18 ones, set 17 outnumbering
  // the set you are looking at nearly 2:1, with nothing on the row saying which
  // is which. The data was never stale; the scope was missing.
  const { setNumber, archetypes } = await loadArchetypeInspector(await currentSet());
  const totalMembers = archetypes.reduce((s, a) => s + a.memberCount, 0);

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: '0 auto',
        color: '#e6e6f0',
        fontFamily: 'var(--font-body, system-ui, sans-serif)',
      }}
    >
      <h1 style={{ margin: 0 }}>Archetype inspector</h1>
      <p style={{ opacity: 0.7, marginTop: 4 }}>
        {archetypes.length} archetypes · {totalMembers} comps
        {setNumber != null ? ` · set ${setNumber}` : ' · all sets'} — expand a row to
        see the comps merge grouped into it.
      </p>

      {archetypes.map((a) => (
        <details
          key={a.label}
          style={{
            border: '1px solid #2a2a3a',
            borderRadius: 8,
            padding: '10px 14px',
            marginBottom: 8,
            background: '#12121c',
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              display: 'flex',
              gap: 16,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <strong style={{ minWidth: 200 }}>
              {a.carryNames.length ? a.carryNames.join(' + ') : 'no carry'}
            </strong>
            {a.dupUnits.length > 0 && (
              <span
                style={{
                  fontSize: 11,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: '#3a2a12',
                  border: '1px solid #6a4a1a',
                  color: '#f0c987',
                }}
              >
                dup: {a.dupUnits.join(', ')}
              </span>
            )}
            {a.heroAugmentUnit && (
              <span
                style={{
                  fontSize: 11,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: '#241a3a',
                  border: '1px solid #4a2a6a',
                  color: '#c9a3f0',
                }}
              >
                augment: {a.heroAugmentUnit}
              </span>
            )}
            <span style={{ opacity: 0.7 }}>
              {a.memberCount} comp{a.memberCount === 1 ? '' : 's'}
            </span>
            <span style={{ opacity: 0.7 }}>{a.totalBoards} boards</span>
            <span>avg {place(a.avgPlacement)}</span>
            <span>top4 {pct(a.top4Rate)}</span>
            <span>win {pct(a.winRate)}</span>
            <span style={{ opacity: 0.5, fontSize: 12 }}>
              rep: {a.repUnits
                .map((u) => u.name + (u.isThreeStar ? '★' : '') + (u.isHeroAugment ? ' [aug]' : ''))
                .join(', ')}
            </span>
          </summary>

          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              marginTop: 10,
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ textAlign: 'left', opacity: 0.6 }}>
                <th style={{ padding: '4px 6px' }}>comp</th>
                <th style={{ padding: '4px 6px' }}>units</th>
                <th style={{ padding: '4px 6px' }}>boards</th>
                <th style={{ padding: '4px 6px' }}>avg</th>
                <th style={{ padding: '4px 6px' }}>top4</th>
                <th style={{ padding: '4px 6px' }}>win</th>
              </tr>
            </thead>
            <tbody>
              {a.members.map((m) => (
                <tr key={m.compId} style={{ borderTop: '1px solid #23232f' }}>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }} title={m.signature}>
                    #{m.compId}
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    {m.units.map((u, i) => (
                      <span
                        key={`${u.characterId}#${i}`}
                        style={{ marginRight: 8, whiteSpace: 'nowrap', color: u.isHeroAugment ? '#c9a3f0' : undefined }}
                      >
                        {u.name}
                        {u.isThreeStar ? '★' : ''}
                        {u.isHeroAugment ? ' [aug]' : ''}
                      </span>
                    ))}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{m.boards}</td>
                  <td style={{ padding: '4px 6px' }}>{place(m.avgPlacement)}</td>
                  <td style={{ padding: '4px 6px' }}>{pct(m.top4Rate)}</td>
                  <td style={{ padding: '4px 6px' }}>{pct(m.winRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </main>
  );
}