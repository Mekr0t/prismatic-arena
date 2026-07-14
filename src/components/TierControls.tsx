'use client';

// The three selectors + niche toggle, kept as URL state (so a tier-list view is
// shareable and back-button friendly). Selectors cascade: changing patch clears
// region+bucket, changing region clears bucket — the server then re-resolves a
// valid default down the chain rather than landing on a dead (empty) combo.

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import type { SelectorOptions, TierListSelection } from '@/server/comps-service';

function bucketLabel(b: string): string {
  return b.charAt(0).toUpperCase() + b.slice(1);
}

export function TierControls({
  options,
  selection,
  niche,
  nicheAvailable,
}: {
  options: SelectorOptions;
  selection: TierListSelection;
  niche: boolean;
  nicheAvailable: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function push(mutate: (p: URLSearchParams) => void) {
    const p = new URLSearchParams(searchParams?.toString() ?? '');
    mutate(p);
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function onPatch(value: string) {
    push((p) => {
      p.set('patch', value);
      p.delete('region'); // downstream defaults re-resolve server-side
      p.delete('bucket');
    });
  }
  function onRegion(value: string) {
    push((p) => {
      p.set('region', value);
      p.delete('bucket');
    });
  }
  function onBucket(value: string) {
    push((p) => p.set('bucket', value));
  }
  function onNiche(on: boolean) {
    push((p) => (on ? p.set('niche', '1') : p.delete('niche')));
  }

  return (
    <div className="tier-controls">
      <label className="tc-group">
        <span className="tc-label">Patch</span>
        <select
          className="tc-select"
          value={String(selection.patchId)}
          onChange={(e) => onPatch(e.target.value)}
        >
          {options.patches.map((p) => (
            <option key={p.patchId} value={String(p.patchId)}>
              {p.patch}
              {p.isCurrent ? ' (current)' : ''}
              {p.label ? ` — ${p.label}` : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="tc-group">
        <span className="tc-label">Region</span>
        <select
          className="tc-select"
          value={selection.region}
          onChange={(e) => onRegion(e.target.value)}
        >
          {options.regions.map((r) => (
            <option key={r} value={r}>
              {r.toUpperCase()}
            </option>
          ))}
        </select>
      </label>

      <label className="tc-group">
        <span className="tc-label">Rank</span>
        <select
          className="tc-select"
          value={selection.rankBucket}
          onChange={(e) => onBucket(e.target.value)}
        >
          {options.buckets.map((b) => (
            <option key={b} value={b}>
              {bucketLabel(b)}
            </option>
          ))}
        </select>
      </label>

      <label className={`tc-toggle${niche ? ' on' : ''}`}>
        <input type="checkbox" checked={niche} onChange={(e) => onNiche(e.target.checked)} />
        Show niche{nicheAvailable > 0 ? ` (${nicheAvailable})` : ''}
      </label>
    </div>
  );
}
