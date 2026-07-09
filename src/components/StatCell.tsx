// Compact stat cell for a comp row. The honest 95% intervals live in the hover
// tooltip so the row stays scannable. Server component — no hooks, native title.

import type { CompRowVM } from '@/server/comps-service';

function place(x: number): string {
  return x.toFixed(2);
}
function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function StatCell({ row }: { row: CompRowVM }) {
  const m = row.metrics;
  const tip = [
    `Avg placement ${place(m.avgPlacement)}  (95% CI ${place(m.placementCi95.low)}-${place(
      m.placementCi95.high,
    )})`,
    `Top 4 ${pct(m.top4Rate)}  (95% CI ${pct(m.top4Ci95.low)}-${pct(m.top4Ci95.high)})`,
    `Win ${pct(m.winRate)}`,
    `Play rate ${pct(row.playRate, 1)}`,
    `Sample n = ${m.n}`,
  ].join('   \u00b7   ');

  return (
    <div className="comp-stat" title={tip}>
      <div className="cs-place">
        <span className="cs-num">{place(m.avgPlacement)}</span>
        <span className="cs-cap">avg place</span>
      </div>
      <div className="cs-grid">
        <div className="cs-metric">
          <span className="cs-v">{pct(m.top4Rate)}</span>
          <span className="cs-k">top 4</span>
        </div>
        <div className="cs-metric">
          <span className="cs-v">{pct(m.winRate)}</span>
          <span className="cs-k">win</span>
        </div>
        <div className="cs-metric">
          <span className="cs-v">{pct(row.playRate, 1)}</span>
          <span className="cs-k">play</span>
        </div>
        <div className="cs-metric">
          <span className="cs-v">{m.n.toLocaleString()}</span>
          <span className="cs-k">games</span>
        </div>
      </div>
    </div>
  );
}