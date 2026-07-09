'use client';

import { useRouter } from 'next/navigation';

const REGIONS = [
  { label: 'EUW', value: 'euw1' },
  { label: 'NA', value: 'na1' },
  { label: 'KR', value: 'kr' },
  { label: 'EUNE', value: 'eun1' },
  { label: 'BR', value: 'br1' },
  { label: 'JP', value: 'jp1' },
  { label: 'OCE', value: 'oc1' },
  { label: 'LAN', value: 'la1' },
  { label: 'LAS', value: 'la2' },
  { label: 'TR', value: 'tr1' },
  { label: 'RU', value: 'ru' },
];

export default function RegionSelect({
  region,
  tier,
}: {
  region: string;
  tier: string;
}) {
  const router = useRouter();

  return (
    <select
      className="region lb-region"
      value={region}
      onChange={(e) => router.push(`/leaderboard/${e.target.value}?tier=${tier}`)}
      aria-label="Leaderboard region"
    >
      {REGIONS.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}