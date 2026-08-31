'use client';

import { useState, useMemo, useCallback } from 'react';
import type { LibraryData, LibUnit, LibTrait, LibItem, LibAugment, AugmentTier } from '@/server/library-data';
import { RichText } from '@/lib/rich-text';
import { UnitStatsGrid } from '@/components/UnitStatsGrid';
import { StatLabel } from './StatIcon';

type Tab = 'units' | 'traits' | 'items' | 'augments';

const BP_STYLE_NAME = ['', 'Bronze', 'Silver', 'Gold', 'Prismatic'];

const ROLE_LABEL: Record<string, string> = {
  APCaster:     'AP Caster',
  APCarry:      'AP Carry',
  APFighter:    'AP Fighter',
  APReaper:     'AP Reaper',
  APTank:       'AP Tank',
  ADCarry:      'AD Carry',
  ADCaster:     'AD Caster',
  ADFighter:    'AD Fighter',
  ADReaper:     'AD Reaper',
  ADSpecialist: 'AD Specialist',
  ADTank:       'AD Tank',
  HFighter:     'Fighter',
};

type TooltipState = { text?: string; trait?: LibTrait; x: number; y: number } | null;

export default function Library({ data }: { data: LibraryData }) {
  const [tab, setTab] = useState<Tab>('units');
  const [tooltip, setTooltip] = useState<TooltipState>(null);

  // Rich trait hover: full effect + all breakpoints (not just a first line).
  // Takes a SyntheticEvent, not a MouseEvent, so focus can open it too — this
  // tooltip is the ONLY way to read a trait's breakpoints from the unit detail
  // panel, and hover-only made it unreachable by keyboard (WCAG 1.4.13).
  const showTraitTooltip = useCallback((e: React.SyntheticEvent, trait: LibTrait | undefined) => {
    if (!trait) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(r.left, window.innerWidth - 360);
    setTooltip({ trait, x, y: r.bottom + 6 });
  }, []);
  const hideTooltip = useCallback(() => setTooltip(null), []);
  const [search, setSearch] = useState('');
  const [costFilter, setCostFilter] = useState<number | null>(null);
  const [kindFilter, setKindFilter] = useState<LibItem['kind'] | null>(null);
  const [tierFilter, setTierFilter] = useState<AugmentTier | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const traitById = useMemo(() => new Map(data.traits.map((t) => [t.id, t])), [data.traits]);
  const q = search.toLowerCase();

  const filteredUnits = useMemo(() => {
    let list = data.units;
    if (costFilter !== null) list = list.filter((u) => u.cost === costFilter);
    if (q) list = list.filter((u) => u.name.toLowerCase().includes(q));
    return list;
  }, [data.units, costFilter, q]);

  const filteredTraits = useMemo(
    () => (q ? data.traits.filter((t) => t.name.toLowerCase().includes(q)) : data.traits),
    [data.traits, q],
  );

  const filteredItems = useMemo(() => {
    let list = kindFilter ? data.items.filter((it) => it.kind === kindFilter) : data.items;
    if (q) list = list.filter((it) => it.name.toLowerCase().includes(q));
    return list;
  }, [data.items, kindFilter, q]);

  const filteredAugments = useMemo(() => {
    let list = tierFilter ? data.augments.filter((a) => a.tier === tierFilter) : data.augments;
    if (q) list = list.filter((a) => a.name.toLowerCase().includes(q));
    return list;
  }, [data.augments, tierFilter, q]);

  const selected = useMemo((): LibUnit | LibTrait | LibItem | LibAugment | null => {
    if (!selectedId) return null;
    if (tab === 'units') return data.units.find((u) => u.id === selectedId) ?? null;
    if (tab === 'traits') return data.traits.find((t) => t.id === selectedId) ?? null;
    if (tab === 'items') return data.items.find((it) => it.id === selectedId) ?? null;
    return data.augments.find((a) => a.id === selectedId) ?? null;
  }, [selectedId, tab, data]);

  function selectItem(id: string) {
    setSelectedId((prev) => (prev === id ? null : id));
  }

  function switchTab(t: Tab) {
    setTab(t);
    setSearch('');
    setSelectedId(null);
    setCostFilter(null);
    setKindFilter(null);
    setTierFilter(null);
  }

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: 'units', label: 'Units', count: data.units.length },
    { key: 'traits', label: 'Traits', count: data.traits.length },
    { key: 'items', label: 'Items', count: data.items.length },
    { key: 'augments', label: 'Augments', count: data.augments.length },
  ];

  return (
    <div className="library">
      <div className="lib-head">
        <div>
          <h1 className="lib-title">Library</h1>
          <div className="lib-set-label">Set {data.setNumber}</div>
        </div>
        <input
          className="lib-search"
          type="text"
          placeholder={`Search ${tab}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="lib-tabs">
        {TABS.map(({ key, label, count }) => (
          <button key={key} className={`lib-tab${tab === key ? ' on' : ''}`} onClick={() => switchTab(key)}>
            {label} <span className="lib-tab-count">{count}</span>
          </button>
        ))}
      </div>

      {tab === 'units' && (
        <div className="lib-filters">
          {([null, 1, 2, 3, 4, 5] as (number | null)[]).map((c) => (
            <button
              key={c ?? 'all'}
              className={`lib-filter-btn${costFilter === c ? ' on' : ''}`}
              style={c !== null ? { color: `var(--c${c})` } : undefined}
              onClick={() => { setCostFilter(c); setSelectedId(null); }}
            >
              {c === null ? 'All' : `${c} cost`}
            </button>
          ))}
        </div>
      )}

      {tab === 'items' && (
        <div className="lib-filters">
          {([null, 'component', 'craftable', 'emblem', 'artifact', 'other'] as (LibItem['kind'] | null)[]).map((k) => (
            <button
              key={k ?? 'all'}
              className={`lib-filter-btn${kindFilter === k ? ' on' : ''}`}
              onClick={() => { setKindFilter(k); setSelectedId(null); }}
            >
              {k === null ? 'All' : k.charAt(0).toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      )}

      {tab === 'augments' && (
        <div className="lib-filters">
          {([null, 'Silver', 'Gold', 'Prismatic'] as (AugmentTier | null)[]).map((t) => (
            <button
              key={t ?? 'all'}
              className={`lib-filter-btn${tierFilter === t ? ' on' : ''}${t ? ` tier-btn-${t.toLowerCase()}` : ''}`}
              onClick={() => { setTierFilter(t); setSelectedId(null); }}
            >
              {t ?? 'All'}
            </button>
          ))}
        </div>
      )}


      <div className={`lib-layout${selected ? ' has-detail' : ''}`}>
        <div className="lib-grid-wrap">

          {tab === 'units' && (
            <div className="lib-unit-grid">
              {filteredUnits.map((u) => (
                <button
                  key={u.id}
                  className={`lib-unit-card c${u.cost}${selectedId === u.id ? ' sel' : ''}`}
                  style={u.iconUrl ? { backgroundImage: `url(${u.iconUrl})` } : undefined}
                  onClick={() => selectItem(u.id)}
                >
                  {!u.iconUrl && <span className="lib-unit-letter">{u.name[0]}</span>}
                  <span className="lib-unit-name">{u.name}</span>
                </button>
              ))}
              {filteredUnits.length === 0 && <p className="lib-empty">No units match &ldquo;{search}&rdquo;</p>}
            </div>
          )}

          {tab === 'traits' && (
            <div className="lib-trait-grid">
              {filteredTraits.map((t) => (
                <button
                  key={t.id}
                  className={`lib-trait-card${selectedId === t.id ? ' sel' : ''}`}
                  onClick={() => selectItem(t.id)}
                >
                  {t.iconUrl && <img src={t.iconUrl} className="lib-trait-icon" alt="" />}
                  <span>{t.name}</span>
                </button>
              ))}
              {filteredTraits.length === 0 && <p className="lib-empty">No traits match &ldquo;{search}&rdquo;</p>}
            </div>
          )}

          {tab === 'items' && (
            <div className="lib-item-grid">
              {filteredItems.map((it) => (
                <button
                  key={it.id}
                  className={`lib-item-card${selectedId === it.id ? ' sel' : ''}`}
                  onClick={() => selectItem(it.id)}
                >
                  {it.iconUrl
                    ? <img src={it.iconUrl} className="lib-item-icon" alt={it.name} />
                    : <div className="lib-item-ph" />
                  }
                  <span className="lib-card-name">{it.name}</span>
                </button>
              ))}
              {filteredItems.length === 0 && <p className="lib-empty">No items match &ldquo;{search}&rdquo;</p>}
            </div>
          )}

          {tab === 'augments' && (
            <div className="lib-aug-list">
              {filteredAugments.map((a) => (
                <button
                  key={a.id}
                  className={`lib-aug-row${selectedId === a.id ? ' sel' : ''}`}
                  onClick={() => selectItem(a.id)}
                >
                  {a.iconUrl
                    ? <img src={a.iconUrl} className="lib-aug-icon" alt="" />
                    : <div className="lib-aug-ph" />
                  }
                  <span className="lib-aug-name">{a.name}</span>
                  <span className={`lib-aug-tier tier-${a.tier.toLowerCase()}`}>{a.tier}</span>
                </button>
              ))}
              {filteredAugments.length === 0 && <p className="lib-empty">No augments match &ldquo;{search}&rdquo;</p>}
            </div>
          )}

        </div>

        {selected && (
          <aside className="lib-detail">
            <button className="lib-detail-close" onClick={() => setSelectedId(null)} aria-label="Close">✕</button>

            {tab === 'units' && (() => {
              const u = selected as LibUnit;
              return (
                <>
                  <div className="lib-detail-hero">
                    <div
                      className={`lib-detail-tile c${u.cost}`}
                      style={u.iconUrl ? { backgroundImage: `url(${u.iconUrl})` } : undefined}
                    />
                    <div>
                      <div className="lib-detail-name">{u.name}</div>
                      <div className="lib-detail-sub" style={{ color: `var(--c${u.cost})` }}>
                        {u.cost} cost
                      </div>
                    </div>
                  </div>

                  {u.traits.length > 0 && (
                    <div className="lib-detail-traits">
                      {u.traits.map((tid) => {
                        const t = traitById.get(tid);
                        return (
                          <span key={tid} className="chip"
                            tabIndex={0}
                            onMouseEnter={(e) => showTraitTooltip(e, t)}
                            onMouseLeave={hideTooltip}
                            onFocus={(e) => showTraitTooltip(e, t)}
                            onBlur={hideTooltip}
                          >
                            {t?.iconUrl && <img src={t.iconUrl} className="chipimg" alt="" />}
                            {t?.name ?? tid}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {u.role && (
                    <div className="lib-section">
                      <div className="lib-section-label">Role</div>
                      <div className="lib-role">{ROLE_LABEL[u.role] ?? u.role}</div>
                    </div>
                  )}

                  {(u.abilityName || u.abilityDesc) && (
                    <div className="lib-section">
                      <div className="lib-section-label">Ability</div>
                      {u.abilityName && <div className="lib-ability-name">{u.abilityName}</div>}
                      <RichText text={u.abilityDesc} className="lib-desc rt" />
                    </div>
                  )}

                  {u.stats && (
                    <div className="lib-section">
                      <div className="lib-section-label">Base Stats</div>
                      <UnitStatsGrid stats={u.stats} />
                    </div>
                  )}
                </>
              );
            })()}

            {tab === 'traits' && (() => {
              const t = selected as LibTrait;
              return (
                <>
                  <div className="lib-detail-hero">
                    {t.iconUrl && <img src={t.iconUrl} className="lib-detail-trait-icon" alt="" />}
                    <div className="lib-detail-name">{t.name}</div>
                  </div>
                  <RichText text={t.description} className="lib-desc rt" />
                  {t.breakpoints.length > 0 && (
                    <div className="lib-section">
                      <div className="lib-section-label">Breakpoints</div>
                      <div className="bp-list">
                        {t.breakpoints.map((bp) => {
                          const isUnique = t.breakpoints.length === 1;
                          return (
                            <div key={bp.minUnits} className="bp-row">
                              <span className={`lib-bp-badge ${isUnique ? 'unique' : `s${bp.style}`}`}>
                                {bp.minUnits}
                              </span>
                              {bp.effect ? (
                                <RichText text={bp.effect} className="bp-eff rt" />
                              ) : (
                                <span className="bp-eff dim">
                                  {isUnique ? 'Unique' : BP_STYLE_NAME[bp.style]}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}

            {tab === 'items' && (() => {
              const it = selected as LibItem;
              return (
                <>
                  <div className="lib-detail-hero">
                    {it.iconUrl
                      ? <img src={it.iconUrl} className="lib-detail-item-icon" alt="" />
                      : <div className="lib-detail-item-ph" />
                    }
                    <div>
                      <div className="lib-detail-name">{it.name}</div>
                      <span className={`lib-kind-badge kind-${it.kind}`}>{it.kind}</span>
                    </div>
                  </div>
                  {it.stats.length > 0 && (
                    <div className="istat-list">
                      {it.stats.map((s) => (
                        <span key={s.label} className="istat">
                          <b>{s.value}</b> <StatLabel label={s.label} />
                        </span>
                      ))}
                    </div>
                  )}
                  <RichText text={it.description} className="lib-desc rt" />
                </>
              );
            })()}

            {tab === 'augments' && (() => {
              const a = selected as LibAugment;
              return (
                <>
                  <div className="lib-detail-hero">
                    {a.iconUrl
                      ? <img src={a.iconUrl} className="lib-detail-aug-icon" alt="" />
                      : <div className="lib-detail-aug-ph" />
                    }
                    <div className="lib-detail-name">{a.name}</div>
                  </div>
                  <RichText text={a.description} className="lib-desc rt" />
                </>
              );
            })()}
          </aside>
        )}
      </div>

      {tooltip && (
        <div
          role="tooltip"
          className={`lib-tooltip${tooltip.trait ? ' gd-tt-trait' : ''}`}
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.trait ? (
            <>
              <span className="gd-tt-name">{tooltip.trait.name}</span>
              {tooltip.trait.description && (
                <RichText text={tooltip.trait.description} className="gd-tt-desc rt" />
              )}
              {tooltip.trait.breakpoints.length > 0 && (
                <div className="bp-list">
                  {tooltip.trait.breakpoints.map((b, i) => {
                    const isUnique = tooltip.trait!.breakpoints.length === 1;
                    return (
                      <div key={i} className="bp-row">
                        <span className={`lib-bp-badge ${isUnique ? 'unique' : `s${b.style}`}`}>
                          {b.minUnits}
                        </span>
                        {b.effect ? (
                          <RichText text={b.effect} className="bp-eff rt" />
                        ) : (
                          <span className="bp-eff dim">
                            {isUnique ? 'Unique' : BP_STYLE_NAME[b.style]}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            tooltip.text
          )}
        </div>
      )}
    </div>
  );
}
