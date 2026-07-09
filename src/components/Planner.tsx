'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useGameData } from '@/lib/game-data';
import {
  type PlannerData,
  type PlannerUnit,
  type PlannerItem,
  type Cell,
  BOARD_COLS,
  BOARD_SIZE,
  emptyBoard,
  computeActiveTraits,
  encodeBoard,
  decodeBoard,
  encodeRiotCode,
  decodeRiotCode,
} from '@/lib/planner/core';

const COST_CLASS = (cost: number) => `c${Math.min(Math.max(cost, 0), 5)}`;

export default function Planner({ data }: { data: PlannerData }) {
  const unitsById = useMemo(() => new Map(data.units.map((u) => [u.id, u])), [data.units]);
  const itemsById = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items]);
  const unitsByPlannerCode = useMemo(
    () => new Map(data.units.filter((u) => u.plannerCode).map((u) => [u.plannerCode!, u.id])),
    [data.units],
  );

  const [board, setBoard] = useState<Cell[]>(() => emptyBoard());
  const [selected, setSelected] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ cell: number; slot: number } | null>(null);
  const [status, setStatus] = useState('');
  const [mounted, setMounted] = useState(false);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // sanitise a decoded board against the current catalog
  const sanitize = (b: Cell[]): Cell[] =>
    b.map((c) =>
      c && unitsById.has(c.unitId)
        ? { unitId: c.unitId, items: c.items.filter((id) => itemsById.has(id)).slice(0, 3) }
        : null,
    );

  // hydrate from the URL hash once; setMounted(true) is batched with setBoard so the
  // sync effect below only runs after both state updates are applied together.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      const decoded = decodeBoard(hash);
      if (decoded) setBoard(sanitize(decoded));
    }
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mirror the board into the URL hash (replace, so we don't spam history).
  // Skipped until mounted so the initial empty board never clobbers the URL hash.
  useEffect(() => {
    if (!mounted) return;
    const code = encodeBoard(board);
    history.replaceState(null, '', code ? `#${code}` : window.location.pathname);
  }, [board, mounted]);

  const flash = (msg: string) => {
    setStatus(msg);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(''), 1800);
  };

  const activeTraits = useMemo(
    () => computeActiveTraits(board, unitsById, itemsById, data.traits),
    [board, unitsById, itemsById, data.traits],
  );

  // ── board ops ──────────────────────────────────────────────
  const placeUnit = (unitId: string, at?: number) => {
    let idx = at;
    if (idx == null || board[idx]) idx = board.findIndex((c) => c === null);
    if (idx == null || idx === -1) {
      flash('Board is full');
      return;
    }
    const target = idx;
    setBoard((prev) => {
      const next = prev.slice();
      next[target] = { unitId, items: [] };
      return next;
    });
    setSelected(target);
  };

  const placeAt = (at: number, unitId: string) => {
    setBoard((prev) => {
      const next = prev.slice();
      next[at] = { unitId, items: next[at]?.unitId === unitId ? next[at]!.items : [] };
      return next;
    });
    setSelected(at);
  };

  const moveCell = (from: number, to: number) => {
    if (from === to) return;
    setBoard((prev) => {
      const next = prev.slice();
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
    setSelected(to);
  };

  const removeUnit = (at: number) => {
    setBoard((prev) => {
      const next = prev.slice();
      next[at] = null;
      return next;
    });
    setSelected(null);
  };

  const setItem = (at: number, slot: number, itemId: string | null) => {
    setBoard((prev) => {
      const next = prev.slice();
      const cell = next[at];
      if (!cell) return prev;
      const items = cell.items.slice();
      if (itemId == null) items.splice(slot, 1);
      else items[slot] = itemId;
      next[at] = { ...cell, items: items.filter(Boolean).slice(0, 3) };
      return next;
    });
  };

  const clearBoard = () => {
    setBoard(emptyBoard());
    setSelected(null);
    setPicker(null);
    flash('Cleared');
  };

  const copyCode = async () => {
    const code = encodeBoard(board);
    if (!code) {
      flash('Board is empty');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      flash('Team code copied');
    } catch {
      window.prompt('Copy this team code:', code);
    }
  };

  const copyRiotCode = async () => {
    const code = encodeRiotCode(board, unitsById, data.setNumber);
    if (!code) {
      flash('No exportable units on board');
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      flash('TFT code copied — paste in-game');
    } catch {
      window.prompt('Copy this TFT team code:', code);
    }
  };

  const applyCode = (raw: string | null) => {
    if (!raw) return;
    const code = raw.trim();

    // Detect official Riot format: starts with "01" + hex slots + "TFTSetN"
    if (/^02[0-9A-Fa-f]+(TFTSet\d+)$/.test(code)) {
      const unitIds = decodeRiotCode(code, unitsByPlannerCode);
      if (!unitIds || unitIds.length === 0) {
        flash('No matching units found');
        return;
      }
      const next = emptyBoard();
      let slot = 0;
      for (const unitId of unitIds) {
        while (slot < BOARD_SIZE && next[slot] !== null) slot++;
        if (slot >= BOARD_SIZE) break;
        if (unitsById.has(unitId)) next[slot++] = { unitId, items: [] };
      }
      setBoard(next);
      setSelected(null);
      flash('Team loaded');
      return;
    }

    // Custom format (position-preserving)
    const decoded = decodeBoard(code);
    if (!decoded) {
      flash('Invalid team code');
      return;
    }
    setBoard(sanitize(decoded));
    setSelected(null);
    flash('Team loaded');
  };

  const pasteCode = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) applyCode(text.trim());
      else flash('Clipboard is empty');
    } catch {
      const text = window.prompt('Paste a team code:');
      if (text) applyCode(text.trim());
    }
  };

  // ── drag & drop ────────────────────────────────────────────
  const onCellDrop = (e: React.DragEvent, target: number) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData('text/plain');
    if (payload.startsWith('new:')) placeAt(target, payload.slice(4));
    else if (payload.startsWith('move:')) moveCell(Number(payload.slice(5)), target);
  };

  const { showTooltip, hideTooltip, openModal } = useGameData();

  const selUnit = selected != null && board[selected] ? unitsById.get(board[selected]!.unitId) : null;

  return (
    <div className="planner">
      <div className="pl-toolbar">
        <div className="pl-tt">
          <h1>Team Planner</h1>
        </div>
        <div className="pl-actions">
          {status && <span className="pl-status">{status}</span>}
          <button className="pl-btn" onClick={pasteCode}>Paste</button>
          <button className="pl-btn" onClick={copyCode}>Copy code</button>
          <button className="pl-btn accent" onClick={copyRiotCode}>Copy for TFT</button>
          <button className="pl-btn danger" onClick={clearBoard}>Clear</button>
        </div>
      </div>

      <div className="planner-layout">
        <div className="pl-left">
          <div className="pl-boardwrap">
            {Array.from({ length: BOARD_SIZE / BOARD_COLS }).map((_, row) => (
              <div className={`hexrow ${row % 2 === 1 ? 'odd' : ''}`} key={row}>
                {Array.from({ length: BOARD_COLS }).map((__, col) => {
                  const index = row * BOARD_COLS + col;
                  const cell = board[index];
                  const unit = cell ? unitsById.get(cell.unitId) : null;
                  return (
                    <div key={index} className="hexcell-wrap">
                      <div
                        className={`hexcell ${cell ? 'filled' : 'empty'} ${
                          unit ? COST_CLASS(unit.cost) : ''
                        } ${selected === index ? 'sel' : ''}`}
                        onClick={() => setSelected(cell ? index : null)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => onCellDrop(e, index)}
                        draggable={!!cell}
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', `move:${index}`)}
                        onMouseEnter={unit ? (e) => showTooltip(e, 'unit', cell!.unitId, unit.name) : undefined}
                        onMouseLeave={unit ? hideTooltip : undefined}
                      >
                        {unit && (
                          <span
                            className="hex-inner"
                            style={
                              unit.iconUrl ? { backgroundImage: `url(${unit.iconUrl})` } : undefined
                            }
                          >
                            {!unit.iconUrl && <span className="hex-letter">{unit.name[0]}</span>}
                          </span>
                        )}
                      </div>
                      {cell && cell.items.length > 0 && (
                        <div className="hex-items">
                          {cell.items.map((id, k) => {
                            const it = itemsById.get(id);
                            return it?.iconUrl ? (
                              <img
                                key={k}
                                className="hex-item-icon"
                                src={it.iconUrl}
                                alt={it.name}
                                style={{ cursor: 'pointer' }}
                                onMouseEnter={(e) => { e.stopPropagation(); showTooltip(e, 'item', id, it.name); }}
                                onMouseLeave={hideTooltip}
                                onClick={(e) => { e.stopPropagation(); openModal('item', id, it.name); }}
                              />
                            ) : (
                              <i key={k} title={it?.name} />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {selUnit && selected != null ? (
            <div className="sel-strip">
              <span className={`sel-port ${COST_CLASS(selUnit.cost)}`} style={selUnit.iconUrl ? { backgroundImage: `url(${selUnit.iconUrl})` } : undefined}>
                {!selUnit.iconUrl && selUnit.name[0]}
              </span>
              <div className="sel-info">
                <b>{selUnit.name}</b>
                <div className="sel-slots">
                  {[0, 1, 2].map((slot) => {
                    const itemId = board[selected]!.items[slot];
                    const item = itemId ? itemsById.get(itemId) : null;
                    return item ? (
                      <button
                        key={slot}
                        className={`slot filled ${item.kind}`}
                        onClick={() => setItem(selected, slot, null)}
                        title={`${item.name} — click to remove`}
                      >
                        {item.iconUrl && <img className="slot-icon" src={item.iconUrl} alt="" />}
                        <span className="slot-name">{item.name}</span>
                      </button>
                    ) : (
                      <button
                        key={slot}
                        className="slot"
                        onClick={() => setPicker({ cell: selected, slot })}
                        title="Add item"
                      >
                        +
                      </button>
                    );
                  })}
                </div>
              </div>
              <button className="sel-remove" onClick={() => removeUnit(selected)}>
                Remove
              </button>
            </div>
          ) : (
            <div className="sel-strip empty-hint">Click a unit on the board to add items, or drag units to rearrange.</div>
          )}
        </div>

        <div
          className="pl-side"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const payload = e.dataTransfer.getData('text/plain');
            if (payload.startsWith('move:')) removeUnit(Number(payload.slice(5)));
          }}
        >
          <TraitPanel traits={activeTraits} />
          <UnitPicker units={data.units} onPick={placeUnit} />
        </div>
      </div>

      {picker && (
        <ItemPicker
          items={data.items}
          onClose={() => setPicker(null)}
          onPick={(itemId) => {
            setItem(picker.cell, picker.slot, itemId);
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

// ── active traits ────────────────────────────────────────────
function TraitPanel({ traits }: { traits: ReturnType<typeof computeActiveTraits> }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  const active = traits.filter((t) => t.style > 0);
  const inactive = traits.filter((t) => t.style === 0);
  return (
    <div className="trait-panel">
      <div className="panel-head">Active traits {active.length > 0 && <span>{active.length}</span>}</div>
      {traits.length === 0 ? (
        <p className="panel-empty">Add units to see traits.</p>
      ) : (
        <div className="trait-list">
          {active.map((t) => (
            <span
              className={`chip ${t.unique ? 'unique' : `s${t.style}`}`}
              key={t.id}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => showTooltip(e, 'trait', t.id, t.name)}
              onMouseLeave={hideTooltip}
              onClick={() => openModal('trait', t.id, t.name)}
            >
              {t.iconUrl ? <img className="chipimg" src={t.iconUrl} alt="" /> : <span className="dot" />}
              {t.name}
              <span className="n">{t.count}</span>
            </span>
          ))}
          {inactive.map((t) => (
            <span
              className="chip"
              key={t.id}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => showTooltip(e, 'trait', t.id, t.name)}
              onMouseLeave={hideTooltip}
              onClick={() => openModal('trait', t.id, t.name)}
            >
              {t.iconUrl ? <img className="chipimg" src={t.iconUrl} alt="" /> : <span className="dot" />}
              {t.name}
              <span className="n">
                {t.count}
                {t.nextAt ? `/${t.nextAt}` : ''}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── unit picker ──────────────────────────────────────────────
function UnitPicker({ units, onPick }: { units: PlannerUnit[]; onPick: (id: string) => void }) {
  const { showTooltip, hideTooltip } = useGameData();
  const [q, setQ] = useState('');
  const [cost, setCost] = useState<number | null>(null);
  const costs = useMemo(() => {
    const set = new Set(units.map((u) => u.cost).filter((c) => c > 0));
    return Array.from(set).sort((a, b) => a - b);
  }, [units]);

  const filtered = units.filter((u) => {
    if (cost != null && u.cost !== cost) return false;
    if (q && !u.name.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="unit-picker">
      <div className="panel-head">Units</div>
      <input className="up-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search units…" />
      <div className="up-filters">
        <button className={cost == null ? 'on' : ''} onClick={() => setCost(null)}>All</button>
        {costs.map((c) => (
          <button key={c} className={`${cost === c ? 'on' : ''} ${COST_CLASS(c)}`} onClick={() => setCost(c)}>
            {c}
          </button>
        ))}
      </div>
      <div className="up-grid">
        {filtered.map((u) => (
          <button
            key={u.id}
            className={`up-cell ${COST_CLASS(u.cost)}`}
            onClick={() => onPick(u.id)}
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', `new:${u.id}`)}
            onMouseEnter={(e) => showTooltip(e, 'unit', u.id, u.name)}
            onMouseLeave={hideTooltip}
            style={u.iconUrl ? { backgroundImage: `url(${u.iconUrl})` } : undefined}
          >
            {!u.iconUrl && <span className="up-letter">{u.name[0]}</span>}
            <span className="up-name">{u.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── item picker overlay ──────────────────────────────────────
const ITEM_KINDS: (PlannerItem['kind'] | null)[] = [
  null, 'component', 'craftable', 'emblem', 'artifact', 'other',
];
const KIND_LABEL: Record<PlannerItem['kind'], string> = {
  component: 'Components',
  craftable: 'Craftable',
  emblem: 'Emblems',
  artifact: 'Artifacts',
  other: 'Other',
};

function ItemPicker({
  items,
  onPick,
  onClose,
}: {
  items: PlannerItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<PlannerItem['kind'] | null>(null);
  const [q, setQ] = useState('');

  const list = items
    .filter((i) => kind === null || i.kind === kind)
    .filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="ip-backdrop" onClick={onClose}>
      <div className="item-pick" onClick={(e) => e.stopPropagation()}>
        <div className="ip-head">
          <div className="ip-tabs">
            {ITEM_KINDS.map((k) => (
              <button key={k ?? 'all'} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === null ? 'All' : KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <button className="ip-close" onClick={onClose}>✕</button>
        </div>
        <input
          className="up-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search items…"
          autoFocus
        />
        <div className="ip-list">
          {list.map((i) => (
            <button key={i.id} className={`ip-item ${i.kind}`} onClick={() => onPick(i.id)} title={i.name}>
              {i.iconUrl && <img className="ip-item-icon" src={i.iconUrl} alt="" />}
              <span className="ip-item-name">{i.name}</span>
            </button>
          ))}
          {list.length === 0 && <p className="panel-empty">No items.</p>}
        </div>
      </div>
    </div>
  );
}
