import { query } from '@/lib/db';

// Read-side service for the admin pipeline-health panel. Reads the two ops
// tables from migration 0007 and shapes them into a plain, serializable VM.
// api_usage is written by the Riot client; ingestion_jobs is written by the
// M4 workers (empty until then — the panel renders that state cleanly).

const WINDOW_MINUTES = 60;
const STALE_AFTER_MINUTES = 60;

export interface UsageMinute {
  minute: string; // ISO timestamp of the minute bucket
  requests: number;
  errors: number; // 429s
}
export interface MethodUsage {
  method: string;
  requests: number;
  errors: number;
  lastSeen: string; // ISO
}
export interface UsageOverview {
  windowMinutes: number;
  totalRequests: number;
  total429: number;
  peakPerMinute: number;
  activeMethods: number;
  series: UsageMinute[]; // exactly WINDOW_MINUTES buckets, oldest → newest (gapless)
  byMethod: MethodUsage[];
}
export interface JobRow {
  id: number;
  jobType: string;
  region: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  itemsDone: number;
  errorCount: number;
  createdAt: string;
}
export interface JobTypeHealth {
  jobType: string;
  lastSuccess: string | null;
  stale: boolean;
}
export interface JobsOverview {
  recent: JobRow[];
  health: JobTypeHealth[];
  staleAfterMinutes: number;
}
export interface OpsOverview {
  usage: UsageOverview;
  jobs: JobsOverview;
}

interface UsageMinuteRow {
  minute: Date;
  requests: number;
  errors: number;
}
interface MethodUsageRow {
  method: string;
  requests: number;
  errors: number;
  last_seen: Date;
}
interface JobRowRaw {
  id: number;
  job_type: string;
  region: string | null;
  status: string;
  started_at: Date | null;
  finished_at: Date | null;
  items_done: number;
  error_count: number;
  created_at: Date;
}
interface JobSuccessRow {
  job_type: string;
  last_success: Date | null;
}

export async function getOpsOverview(): Promise<OpsOverview> {
  const [minutes, methods, recentJobs, successes] = await Promise.all([
    // Gapless per-minute series over the window (minutes with no traffic = 0).
    query<UsageMinuteRow>(
      `SELECT gs AS minute,
              COALESCE(SUM(u.request_count), 0)::int AS requests,
              COALESCE(SUM(u.rate_429), 0)::int     AS errors
       FROM generate_series(
              date_trunc('minute', now()) - make_interval(mins => $1 - 1),
              date_trunc('minute', now()),
              interval '1 minute'
            ) AS gs
       LEFT JOIN api_usage u ON u.window_start = gs
       GROUP BY gs
       ORDER BY gs ASC`,
      [WINDOW_MINUTES],
    ),
    query<MethodUsageRow>(
      `SELECT method,
              SUM(request_count)::int AS requests,
              SUM(rate_429)::int      AS errors,
              MAX(window_start)       AS last_seen
       FROM api_usage
       WHERE window_start >= date_trunc('minute', now()) - make_interval(mins => $1 - 1)
       GROUP BY method
       ORDER BY requests DESC, method ASC`,
      [WINDOW_MINUTES],
    ),
    query<JobRowRaw>(
      `SELECT id::int AS id, job_type, region, status,
              started_at, finished_at, items_done, error_count, created_at
       FROM ingestion_jobs
       ORDER BY created_at DESC
       LIMIT 20`,
    ),
    query<JobSuccessRow>(
      `SELECT job_type, MAX(finished_at) AS last_success
       FROM ingestion_jobs
       WHERE status = 'success'
       GROUP BY job_type`,
    ),
  ]);

  const series: UsageMinute[] = minutes.map((m) => ({
    minute: m.minute.toISOString(),
    requests: m.requests,
    errors: m.errors,
  }));
  const totalRequests = series.reduce((s, m) => s + m.requests, 0);
  const total429 = series.reduce((s, m) => s + m.errors, 0);
  const peakPerMinute = series.reduce((mx, m) => Math.max(mx, m.requests), 0);

  const byMethod: MethodUsage[] = methods.map((m) => ({
    method: m.method,
    requests: m.requests,
    errors: m.errors,
    lastSeen: m.last_seen.toISOString(),
  }));

  const usage: UsageOverview = {
    windowMinutes: WINDOW_MINUTES,
    totalRequests,
    total429,
    peakPerMinute,
    activeMethods: byMethod.length,
    series,
    byMethod,
  };

  const nowMs = Date.now();
  const staleMs = STALE_AFTER_MINUTES * 60 * 1000;
  const health: JobTypeHealth[] = successes
    .map((s) => ({
      jobType: s.job_type,
      lastSuccess: s.last_success ? s.last_success.toISOString() : null,
      stale: s.last_success ? nowMs - s.last_success.getTime() > staleMs : true,
    }))
    .sort((a, b) => a.jobType.localeCompare(b.jobType));

  const recent: JobRow[] = recentJobs.map((j) => ({
    id: j.id,
    jobType: j.job_type,
    region: j.region,
    status: j.status,
    startedAt: j.started_at ? j.started_at.toISOString() : null,
    finishedAt: j.finished_at ? j.finished_at.toISOString() : null,
    itemsDone: j.items_done,
    errorCount: j.error_count,
    createdAt: j.created_at.toISOString(),
  }));

  const jobs: JobsOverview = { recent, health, staleAfterMinutes: STALE_AFTER_MINUTES };

  return { usage, jobs };
}
