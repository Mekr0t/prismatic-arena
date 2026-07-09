'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { LibUnit, LibTrait, LibItem, LibraryData } from '@/server/library-data';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntityType = 'unit' | 'trait' | 'item';

interface GameDataStore {
  units: Map<string, LibUnit>;
  unitsByName: Map<string, LibUnit>;
  traits: Map<string, LibTrait>;
  items: Map<string, LibItem>;
  itemsByName: Map<string, LibItem>;
}

interface TooltipState {
  x: number;
  y: number;
  name: string;
  subtitle?: string;
  desc?: string;
}

interface ModalState {
  type: EntityType;
  id: string;
  name: string;
}

interface CtxValue {
  store: GameDataStore | null;
  showTooltip(e: React.MouseEvent, type: EntityType, id: string, name: string): void;
  hideTooltip(): void;
  openModal(type: EntityType, id: string, name: string): void;
}

// ─── Context ─────────────────────────────────────────────────────────────────

const Ctx = createContext<CtxValue | null>(null);

const NOOP = () => {};

export function useGameData(): CtxValue {
  const ctx = useContext(Ctx);
  if (!ctx) return { store: null, showTooltip: NOOP, hideTooltip: NOOP, openModal: NOOP };
  return ctx;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function strip(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function firstLine(text: string, max = 110): string {
  const line = text.split('\n')[0].trim();
  return line.length <= max ? line : line.slice(0, max) + '…';
}

const COST_COLOR = ['', 'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
const BP_NAME = ['', 'Bronze', 'Silver', 'Gold', 'Prismatic'];
const KIND_LABEL: Record<string, string> = {
  component: 'Component',
  craftable: 'Craftable',
  emblem: 'Emblem',
  artifact: 'Artifact',
  other: 'Special',
};

const STAT_ROWS: [string, string][] = [
  ['HP', 'hp'],
  ['AD', 'attackDamage'],
  ['AP', 'abilityPower'],
  ['Atk Speed', 'attackSpeed'],
  ['Armor', 'armor'],
  ['MR', 'magicResist'],
  ['Range', 'range'],
  ['Mana', 'initialMana'],
];

function fmtStat(v: number): string {
  if (v > 1 || Number.isInteger(v)) return Math.round(v).toString();
  return v.toFixed(2);
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function GameDataProvider({ children }: { children: React.ReactNode }) {
  const [store, setStore] = useState<GameDataStore | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);

  useEffect(() => {
    fetch('/api/game-data')
      .then((r) => r.json())
      .then((raw: LibraryData) => {
        setStore({
          units: new Map(raw.units.map((u) => [u.id, u])),
          unitsByName: new Map(raw.units.map((u) => [u.name.toLowerCase(), u])),
          traits: new Map(raw.traits.map((t) => [t.id, t])),
          items: new Map(raw.items.map((it) => [it.id, it])),
          itemsByName: new Map(raw.items.map((it) => [it.name.toLowerCase(), it])),
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!modal) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [modal]);

  const showTooltip = useCallback(
    (e: React.MouseEvent, type: EntityType, id: string, name: string) => {
      if (modal) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = Math.min(rect.left, window.innerWidth - 296);
      const y = rect.bottom + 8;

      let subtitle: string | undefined;
      let desc: string | undefined;

      if (store) {
        if (type === 'unit') {
          const u = store.units.get(id) ?? store.unitsByName.get(name.toLowerCase());
          if (u) {
            subtitle = `${u.cost}-cost${u.role ? ' · ' + u.role.replace(/([A-Z])/g, ' $1').trim() : ''}`;
            if (u.abilityName) desc = `✦ ${u.abilityName}`;
          }
        } else if (type === 'trait') {
          const t = store.traits.get(id);
          if (t) {
            if (t.breakpoints.length) subtitle = t.breakpoints.map((b) => b.minUnits).join(' / ');
            const clean = strip(t.description);
            if (clean) desc = firstLine(clean);
          }
        } else {
          const it = store.items.get(id) ?? store.itemsByName.get(name.toLowerCase());
          if (it) {
            const clean = strip(it.description);
            if (clean) desc = firstLine(clean);
          }
        }
      }

      setTooltip({ x, y, name, subtitle, desc });
    },
    [store, modal],
  );

  const hideTooltip = useCallback(() => setTooltip(null), []);

  const openModal = useCallback((type: EntityType, id: string, name: string) => {
    setTooltip(null);
    setModal({ type, id, name });
  }, []);

  const closeModal = () => setModal(null);

  return (
    <Ctx.Provider value={{ store, showTooltip, hideTooltip, openModal }}>
      {children}

      {tooltip && (
        <div className="gd-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <span className="gd-tt-name">{tooltip.name}</span>
          {tooltip.subtitle && <span className="gd-tt-sub">{tooltip.subtitle}</span>}
          {tooltip.desc && <p className="gd-tt-desc">{tooltip.desc}</p>}
        </div>
      )}

      {modal && (
        <div className="gd-backdrop" role="dialog" aria-modal="true" onClick={closeModal}>
          <div className="gd-modal" onClick={(e) => e.stopPropagation()}>
            <button className="lib-detail-close" onClick={closeModal} aria-label="Close">
              ✕
            </button>
            <PopupContent store={store} modal={modal} />
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

// ─── Modal content ────────────────────────────────────────────────────────────

function PopupContent({ store, modal }: { store: GameDataStore | null; modal: ModalState }) {
  const { type, id, name } = modal;

  if (!store) return <Fallback name={name} />;

  if (type === 'unit') {
    const u = store.units.get(id) ?? store.unitsByName.get(name.toLowerCase());
    return u ? <UnitPopup unit={u} store={store} /> : <Fallback name={name} />;
  }
  if (type === 'trait') {
    const t = store.traits.get(id);
    return t ? <TraitPopup trait={t} /> : <Fallback name={name} />;
  }
  const it = store.items.get(id) ?? store.itemsByName.get(name.toLowerCase());
  return it ? <ItemPopup item={it} /> : <Fallback name={name} />;
}

function Fallback({ name }: { name: string }) {
  return (
    <div className="gd-fallback">
      <p className="lib-detail-name">{name}</p>
      <p className="lib-desc" style={{ marginTop: 8 }}>
        No details available.
      </p>
    </div>
  );
}

function UnitPopup({ unit, store }: { unit: LibUnit; store: GameDataStore }) {
  const costColor = COST_COLOR[unit.cost] ?? 'var(--text-dim)';
  const desc = strip(unit.abilityDesc);
  const traitNames = unit.traits
    .map((id) => store.traits.get(id)?.name)
    .filter((n): n is string => !!n);

  const stats = unit.stats
    ? STAT_ROWS.filter(([, k]) => unit.stats![k] !== undefined)
    : [];

  return (
    <>
      <div className="lib-detail-hero">
        {unit.iconUrl ? (
          <div
            className={`lib-detail-tile c${unit.cost}`}
            style={{ backgroundImage: `url(${unit.iconUrl})` }}
          />
        ) : (
          <div className={`lib-detail-tile c${unit.cost} gd-icon-ph`}>{unit.name[0]}</div>
        )}
        <div>
          <div className="lib-detail-name">{unit.name}</div>
          <div className="lib-detail-sub" style={{ color: costColor }}>
            {unit.cost} cost
            {unit.role && (
              <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>
                {unit.role.replace(/([A-Z])/g, ' $1').trim()}
              </span>
            )}
          </div>
          {traitNames.length > 0 && (
            <div className="lib-detail-traits" style={{ marginTop: 6 }}>
              {traitNames.map((n) => (
                <span key={n} className="gd-trait-pill">
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {stats.length > 0 && (
        <div className="lib-section">
          <div className="lib-section-label">Stats</div>
          <div className="lib-stats-grid">
            {stats.map(([label, key]) => (
              <div key={key} className="lib-stat">
                <span className="lib-stat-k">{label}</span>
                <span className="lib-stat-v">{fmtStat(unit.stats![key])}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(unit.abilityName || desc) && (
        <div className="lib-section">
          {unit.abilityName && (
            <div className="lib-section-label">Ability</div>
          )}
          {unit.abilityName && (
            <div className="lib-ability-name">{unit.abilityName}</div>
          )}
          {desc && <p className="lib-desc">{desc}</p>}
        </div>
      )}
    </>
  );
}

function TraitPopup({ trait }: { trait: LibTrait }) {
  const desc = strip(trait.description);
  return (
    <>
      <div className="lib-detail-hero">
        {trait.iconUrl ? (
          <img className="lib-detail-trait-icon" src={trait.iconUrl} alt="" />
        ) : (
          <div className="lib-detail-trait-icon gd-icon-ph">{trait.name[0]}</div>
        )}
        <div>
          <div className="lib-detail-name">{trait.name}</div>
          {trait.breakpoints.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
              {trait.breakpoints.map((b, i) => {
                const isUnique = trait.breakpoints.length === 1;
                return (
                  <span key={i} className={`gd-bp-pill ${isUnique ? 'unique' : `s${b.style}`}`}>
                    {b.minUnits} {isUnique ? 'Unique' : BP_NAME[b.style]}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {desc && (
        <div className="lib-section">
          <div className="lib-section-label">Effect</div>
          <p className="lib-desc">{desc}</p>
        </div>
      )}
    </>
  );
}

function ItemPopup({ item }: { item: LibItem }) {
  const desc = strip(item.description);
  return (
    <>
      <div className="lib-detail-hero">
        {item.iconUrl ? (
          <img className="lib-detail-item-icon" src={item.iconUrl} alt={item.name} />
        ) : (
          <div className="lib-detail-item-ph gd-icon-ph">{item.name[0]}</div>
        )}
        <div>
          <div className="lib-detail-name">{item.name}</div>
          <span className={`lib-kind-badge kind-${item.kind}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
        </div>
      </div>

      {desc && (
        <div className="lib-section">
          <p className="lib-desc">{desc}</p>
        </div>
      )}
    </>
  );
}
