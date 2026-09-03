// Admin page for crawl health. Lives in the guarded (panel) route group, so
// requireAdmin() in the layout covers it. Server component, no client JS beyond
// the shared AutoRefresh; reuses the .ops-* vocabulary from admin.css so it
// reads as one panel with the pipeline page rather than a second design.
//
// It answers what the pipeline page cannot: SUPPLY (are there seeds to crawl),
// FLOW (is anything actually landing) and CONSISTENCY (do the derived tables and
// the read path still agree). See crawl-health-service.ts for why each of those
// earned a place.

import { getCrawlHealth } from '@/server/crawl-health-service';
import { bucketLabel } from '@/config/rank-buckets';
import { AutoRefresh } from '@/components/admin/AutoRefresh';

export const dynamic = 'force-dynamic';

const ago = (iso: string | null): string => {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m ago` : `${Math.floor(h / 24)}d ago`;
};

const until = (iso: string | null): string => {
  if (!iso) return '—';
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  return mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};

export default async function CrawlHealthPage() {
  const h = await getCrawlHealth();

  // SEED-STARVED is the state that looked like "slow" for hours: eligible seeds
  // sitting unused while the queue drains to nothing. Either half alone is
  // normal; together they mean the producer is not producing.
  const matchFetch = h.queues.find((q) => q.name === 'match-fetch');
  const seedStarved = h.apexDrainable > 0 && (matchFetch?.waiting ?? 0) < 20;
  const brokenScopes = h.scopeChecks.filter((s) => !s.ok);
  const staleFlow = h.byBucket.length === 0;

  return (
    <section className="ops">
      <div className="ops-head">
        <h1>Crawl health</h1>
        <AutoRefresh seconds={30} />
      </div>

      <p className="ops-foot">
        Scope: <b>{h.scope.tiers.join(', ')}</b> on <b>{h.scope.platforms.join(', ')}</b> ·
        re-crawl window <b>{h.scope.recrawlHours}h</b>
        {h.scope.buckets ? <> · buckets {h.scope.buckets.join(', ')}</> : <> · no bucket gate</>}
      </p>

      <div className="ops-grid">
        <div className={`ops-card${h.apexTotal === 0 ? ' is-warn' : ''}`}>
          <span className="ops-label">Seeds in scope</span>
          <span className="ops-n">{h.apexTotal}</span>
        </div>
        <div className={`ops-card${seedStarved ? ' is-warn' : ''}`}>
          <span className="ops-label">Drainable now</span>
          <span className="ops-n">{h.apexDrainable}</span>
        </div>
        <div className={`ops-card${staleFlow ? ' is-warn' : ''}`}>
          <span className="ops-label">Boards / hour</span>
          <span className="ops-n">{h.boardsPerHour.toLocaleString()}</span>
        </div>
        <div className={`ops-card${brokenScopes.length > 0 ? ' is-warn' : ''}`}>
          <span className="ops-label">Scopes readable</span>
          <span className="ops-n">
            {h.scopeChecks.length - brokenScopes.length}/{h.scopeChecks.length}
          </span>
        </div>
      </div>

      {seedStarved && (
        <div className="ops-section">
          <h2>Seed-starved</h2>
          <p className="ops-empty">
            {h.apexDrainable} account(s) are eligible to crawl but only{' '}
            {matchFetch?.waiting ?? 0} match-fetch job(s) are queued. The producer is not
            enqueuing — check ladder-crawl on the pipeline page. Ingestion can look merely
            slow in this state, because the queue keeps draining whatever was already in it.
          </p>
        </div>
      )}

      {brokenScopes.length > 0 && (
        <div className="ops-section">
          <h2>Scopes the read path cannot see</h2>
          <p className="ops-empty">
            comp_stats has boards for these scopes but the read path&apos;s own region
            expansion finds none, so the tier list will render while every board under it is
            empty.
          </p>
          <table className="ops-table">
            <thead>
              <tr>
                <th>Patch</th>
                <th>Region</th>
                <th>Bucket</th>
                <th className="num">comp_stats</th>
                <th className="num">read path</th>
              </tr>
            </thead>
            <tbody>
              {brokenScopes.map((s) => (
                <tr key={`${s.patchId}-${s.region}-${s.rankBucket}`}>
                  <td className="mono">{s.patchId}</td>
                  <td>{s.region}</td>
                  <td>{bucketLabel(s.rankBucket)}</td>
                  <td className="num">{s.statBoards.toLocaleString()}</td>
                  <td className="num">{s.readBoards.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="ops-section">
        <h2>Seed supply</h2>
        {h.apex.length === 0 ? (
          <p className="ops-empty">
            No accounts match the configured tier scope. The crawl has nothing to drain —
            widen CRAWL_TIERS, or wait for the apex ladders to fill if a set has just started.
          </p>
        ) : (
          <>
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th className="num">Accounts</th>
                  <th className="num">Drainable</th>
                </tr>
              </thead>
              <tbody>
                {h.apex.map((r) => (
                  <tr key={r.tier}>
                    <td>{r.tier}</td>
                    <td className="num">{r.accounts.toLocaleString()}</td>
                    <td className="num">{r.drainable.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="ops-foot">
              Next locked-out seed becomes eligible {until(h.nextDrainable)}. A pool this size
              is exhausted in minutes, so the re-crawl window — not the API budget — is
              usually what caps throughput.
            </p>
          </>
        )}
      </div>

      <div className="ops-section">
        <h2>Queues</h2>
        <table className="ops-table">
          <thead>
            <tr>
              <th>Queue</th>
              <th className="num">Waiting</th>
              <th className="num">Active</th>
              <th className="num">Delayed</th>
              <th className="num">Failed</th>
            </tr>
          </thead>
          <tbody>
            {h.queues.map((q) => (
              <tr key={q.name}>
                <td className="mono">{q.name}</td>
                <td className="num">{q.waiting.toLocaleString()}</td>
                <td className="num">{q.active}</td>
                <td className="num">{q.delayed}</td>
                {/* Zeros are dimmed, failures are not — a failed count is the
                    thing you came here to see, so it must not be the quietest
                    number on the row. */}
                <td className={`num${q.failed === 0 ? ' dim' : ''}`}>{q.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {h.waitingByBucket.length > 0 && (
          <p className="ops-foot">
            Waiting match-fetch work by bucket:{' '}
            {h.waitingByBucket.map((b) => `${bucketLabel(b.bucket)} ${b.jobs}`).join(' · ')}. Work
            for a bucket outside the current scope is a backlog from before the scope changed;
            the worker drops it on the next restart.
          </p>
        )}
      </div>

      <div className="ops-section">
        <h2>Ingest · last {h.flowMinutes} min</h2>
        {h.byBucket.length === 0 ? (
          <p className="ops-empty">
            No boards ingested in the last {h.flowMinutes} minutes. If seeds are drainable and
            the queue is empty, the producer is failing rather than idle.
          </p>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th>Rank bucket</th>
                <th className="num">Boards</th>
                <th>Newest</th>
              </tr>
            </thead>
            <tbody>
              {h.byBucket.map((b) => (
                <tr key={b.bucket}>
                  <td>{bucketLabel(b.bucket)}</td>
                  <td className="num">{b.boards.toLocaleString()}</td>
                  <td className="dim">{ago(b.newest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {h.byPlatform.length > 0 && (
        <div className="ops-section">
          <h2>By platform · last {h.flowMinutes} min</h2>
          <table className="ops-table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Super-region</th>
                <th className="num">Boards</th>
              </tr>
            </thead>
            <tbody>
              {h.byPlatform.map((p) => (
                <tr key={p.region}>
                  <td className="mono">{p.region}</td>
                  <td className="dim">{p.superRegion ?? '—'}</td>
                  <td className="num">{p.boards.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ops-foot">
            A configured platform contributing nothing here is the shape a dead ladder or a bad
            route takes — it fails quietly, because the other platforms keep the totals healthy.
          </p>
        </div>
      )}

      <div className="ops-section">
        <h2>Per-board tier coverage</h2>
        <p className="ops-empty">
          {h.tierCoverage.withTier.toLocaleString()} of {h.tierCoverage.boards.toLocaleString()}{' '}
          live-set boards carry their player&apos;s own tier
          {h.tierCoverage.boards > 0
            ? ` (${((h.tierCoverage.withTier / h.tierCoverage.boards) * 100).toFixed(1)}%)`
            : ''}
          . The rank bucket is the tier of the player the crawl drained to reach a lobby; this
          is the tier of the player who actually played the board, and the cumulative scopes
          select on it. It rises on its own as the crawl resolves more accounts.
        </p>
      </div>
    </section>
  );
}
