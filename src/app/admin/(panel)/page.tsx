import { getOpsOverview } from '@/server/ops-service';
import { AutoRefresh } from '@/components/admin/AutoRefresh';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin — Pipeline health' };

function rel(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_BADGE: Record<string, string> = {
  success: 'badge badge-success',
  failed: 'badge badge-failed',
  running: 'badge badge-running',
  queued: 'badge badge-queued',
};

export default async function AdminDashboardPage() {
  const { usage, jobs } = await getOpsOverview();

  // SVG bar-chart geometry (server-rendered; fills come from CSS classes).
  const W = 600;
  const H = 140;
  const padX = 4;
  const padTop = 10;
  const padBottom = 18;
  const plotH = H - padTop - padBottom;
  const slots = Math.max(usage.series.length, 1);
  const slotW = (W - padX * 2) / slots;
  const peak = Math.max(usage.peakPerMinute, 1);
  const y0 = padTop + plotH;
  const bars = usage.series.map((m, i) => {
    const x = padX + i * slotW + slotW * 0.15;
    const bw = slotW * 0.7;
    const totalH = (m.requests / peak) * plotH;
    const errH = (m.errors / peak) * plotH;
    const okH = Math.max(totalH - errH, 0);
    return { i, x, bw, okY: y0 - totalH, okH, errY: y0 - errH, errH };
  });

  return (
    <section className="ops">
      <div className="ops-head">
        <h1>Pipeline health</h1>
        <AutoRefresh seconds={15} />
      </div>

      <div className="ops-grid">
        <div className="ops-card">
          <span className="ops-label">Requests · 60m</span>
          <span className="ops-n">{usage.totalRequests}</span>
        </div>
        <div className={`ops-card${usage.total429 > 0 ? ' is-warn' : ''}`}>
          <span className="ops-label">429s · 60m</span>
          <span className="ops-n">{usage.total429}</span>
        </div>
        <div className="ops-card">
          <span className="ops-label">Peak · req/min</span>
          <span className="ops-n">{usage.peakPerMinute}</span>
        </div>
        <div className="ops-card">
          <span className="ops-label">Methods active</span>
          <span className="ops-n">{usage.activeMethods}</span>
        </div>
      </div>

      <div className="ops-section">
        <h2>Riot requests · last 60 min</h2>
        {usage.totalRequests === 0 ? (
          <p className="ops-empty">
            No Riot requests in the last 60 minutes. Load a profile or leaderboard
            to generate traffic, then this fills in.
          </p>
        ) : (
          <>
            <svg
              className="usage-chart"
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`Riot requests per minute over the last hour; peak ${usage.peakPerMinute} per minute, ${usage.total429} rate-limited`}
            >
              <line className="baseline" x1={padX} y1={y0} x2={W - padX} y2={y0} />
              {bars.map((b) => (
                <g key={b.i}>
                  {b.okH > 0 ? (
                    <rect className="bar-ok" x={b.x} y={b.okY} width={b.bw} height={b.okH} rx={1} />
                  ) : null}
                  {b.errH > 0 ? (
                    <rect className="bar-err" x={b.x} y={b.errY} width={b.bw} height={b.errH} rx={1} />
                  ) : null}
                </g>
              ))}
              <text className="axis-label" x={padX} y={H - 5} textAnchor="start">
                60m ago
              </text>
              <text className="axis-label" x={W - padX} y={H - 5} textAnchor="end">
                now
              </text>
            </svg>
            <div className="ops-legend">
              <span className="dot dot-ok" /> requests
              <span className="dot dot-err" /> 429s
            </div>
          </>
        )}
      </div>

      <div className="ops-section">
        <h2>By endpoint · 60m</h2>
        {usage.byMethod.length === 0 ? (
          <p className="ops-empty">No requests recorded yet.</p>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th>Method</th>
                <th className="num">Requests</th>
                <th className="num">429s</th>
                <th className="num">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {usage.byMethod.map((m) => (
                <tr key={m.method}>
                  <td className="mono">{m.method}</td>
                  <td className="num">{m.requests}</td>
                  <td className={`num${m.errors > 0 ? ' warn' : ''}`}>{m.errors}</td>
                  <td className="num dim">{rel(m.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="ops-section">
        <h2>Ingestion jobs</h2>
        {jobs.recent.length === 0 ? (
          <p className="ops-empty">
            No ingestion jobs yet. The M4 pipeline — ladder crawl, match fetch,
            normalize, rollup, cluster, tier-gen — reports here once it runs.
          </p>
        ) : (
          <>
            {jobs.health.length > 0 ? (
              <div className="ops-health">
                {jobs.health.map((h) => (
                  <div key={h.jobType} className="ops-health-row">
                    <span className="mono">{h.jobType}</span>
                    <span className="dim">last success {rel(h.lastSuccess)}</span>
                    {h.stale ? (
                      <span className="badge badge-stale">stale</span>
                    ) : (
                      <span className="badge badge-success">fresh</span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Region</th>
                  <th>Status</th>
                  <th className="num">Items</th>
                  <th className="num">Errors</th>
                  <th className="num">Started</th>
                  <th className="num">Finished</th>
                </tr>
              </thead>
              <tbody>
                {jobs.recent.map((j) => (
                  <tr key={j.id}>
                    <td className="mono">{j.jobType}</td>
                    <td className="dim">{j.region ?? '—'}</td>
                    <td>
                      <span className={STATUS_BADGE[j.status] ?? 'badge badge-queued'}>
                        {j.status}
                      </span>
                    </td>
                    <td className="num">{j.itemsDone}</td>
                    <td className={`num${j.errorCount > 0 ? ' warn' : ''}`}>{j.errorCount}</td>
                    <td className="num dim">{rel(j.startedAt)}</td>
                    <td className="num dim">{rel(j.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="ops-foot">
              Stale threshold: {jobs.staleAfterMinutes} min without a successful run.
            </p>
          </>
        )}
      </div>
    </section>
  );
}