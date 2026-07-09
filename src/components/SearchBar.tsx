'use client';

import { useState } from 'react';
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

export default function SearchBar() {
  const router = useRouter();
  const [region, setRegion] = useState('euw1');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const [name, tag] = q.split('#');
    if (!name?.trim() || !tag?.trim()) {
      setError('Enter your Riot ID as Name#TAG');
      return;
    }
    setError('');
    router.push(
      `/${region}/${encodeURIComponent(name.trim())}/${encodeURIComponent(tag.trim())}`
    );
  }

  return (
    <form className="search" onSubmit={submit}>
      <select
        className="region"
        value={region}
        onChange={(e) => setRegion(e.target.value)}
        aria-label="Region"
      >
        {REGIONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      <div className="field">
        <svg className="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>

        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); if (error) setError(''); }}
          placeholder="Search Riot ID (Name#TAG)"
          aria-label="Riot ID"
          aria-invalid={!!error}
        />
      </div>
      {error && <span className="search-error" role="alert">{error}</span>}
    </form>
  );
}