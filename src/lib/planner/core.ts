// Pure, client-safe planner core: types, team-code encode/decode, trait engine.

export interface PlannerUnit {
  id: string; // character_id, e.g. TFT17_Ezreal
  name: string;
  cost: number;
  traits: string[]; // trait ids (apiNames)
  iconUrl: string | null;
  plannerCode: number | null; // Riot team-planner slot code, used for official export
}

export interface Breakpoint {
  minUnits: number;
  style: number; // 1 bronze · 2 silver · 3 gold · 4 prismatic
}

export interface PlannerTrait {
  id: string;
  name: string;
  iconUrl: string | null;
  breakpoints: Breakpoint[]; // ascending by minUnits
}

export interface PlannerItem {
  id: string;
  name: string;
  iconUrl: string | null;
  kind: 'component' | 'emblem' | 'craftable' | 'artifact' | 'other';
  trait?: string; // emblems: the trait id they grant (+1)
}

export interface PlannerData {
  units: PlannerUnit[];
  traits: PlannerTrait[];
  items: PlannerItem[];
  setNumber: number;
}

export type Cell = { unitId: string; items: string[] } | null;

export const BOARD_COLS = 7;
export const BOARD_ROWS = 4;
export const BOARD_SIZE = BOARD_COLS * BOARD_ROWS; // 28

export interface ActiveTrait {
  id: string;
  name: string;
  iconUrl: string | null;
  count: number;
  style: number; // 0 = inactive
  unique: boolean; // single-breakpoint trait (no bronze/silver/gold/prismatic scaling)
  nextAt: number | null; // next breakpoint threshold, or null if maxed
}

export function emptyBoard(): Cell[] {
  return Array.from({ length: BOARD_SIZE }, () => null);
}

/** Count unique units per trait (innate + emblem grants) and resolve the active tier. */
export function computeActiveTraits(
  board: Cell[],
  unitsById: Map<string, PlannerUnit>,
  itemsById: Map<string, PlannerItem>,
  traits: PlannerTrait[],
): ActiveTrait[] {
  const traitUnits = new Map<string, Set<string>>();
  const add = (traitId: string, unitId: string) => {
    let s = traitUnits.get(traitId);
    if (!s) {
      s = new Set();
      traitUnits.set(traitId, s);
    }
    s.add(unitId);
  };

  for (const cell of board) {
    if (!cell) continue;
    const u = unitsById.get(cell.unitId);
    if (u) for (const t of u.traits) add(t, cell.unitId);
    for (const itemId of cell.items) {
      const it = itemsById.get(itemId);
      if (it?.kind === 'emblem' && it.trait) add(it.trait, cell.unitId);
    }
  }

  const byId = new Map(traits.map((t) => [t.id, t]));
  const result: ActiveTrait[] = [];
  for (const [traitId, set] of traitUnits) {
    const def = byId.get(traitId);
    const count = set.size;
    let style = 0;
    let nextAt: number | null = null;
    if (def && def.breakpoints.length) {
      for (const bp of def.breakpoints) {
        if (count >= bp.minUnits) style = bp.style;
        else {
          nextAt = bp.minUnits;
          break;
        }
      }
    }
    const unique = def?.breakpoints.length === 1;
    result.push({ id: traitId, name: def?.name ?? traitId, iconUrl: def?.iconUrl ?? null, count, style, unique, nextAt });
  }

  result.sort(
    (a, b) => b.style - a.style || b.count - a.count || a.name.localeCompare(b.name),
  );
  return result;
}

// ── team code (versioned, URL-safe base64 of occupied cells) ────────────────

interface Packed {
  i: number;
  u: string;
  it?: string[];
}

export function encodeBoard(board: Cell[]): string {
  const occupied: Packed[] = [];
  board.forEach((c, i) => {
    if (c) occupied.push(c.items.length ? { i, u: c.unitId, it: c.items } : { i, u: c.unitId });
  });
  if (occupied.length === 0) return '';
  const b64 = btoa(JSON.stringify(occupied));
  return '1' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── official Riot TFT team-planner format ────────────────────────────────────
// Format: "01" + up to 10 × 2-digit uppercase hex (champion plannerCode, "00" = empty) + "TFTSetN"
// Example: "010E0F01...TFTSet17"
// Positions are not stored; order is preserved but not board cells.

/**
 * Encodes the current board into the official Riot TFT team-planner string.
 * - Deduplicates by unit id (first occurrence wins — order on board is preserved).
 * - Skips units with no plannerCode (they won't import into the game anyway).
 * - Caps at 10 champions; pads remaining slots with "00".
 * Returns null when no encodeable unit is on the board.
 */
export function encodeRiotCode(
  board: Cell[],
  unitsById: Map<string, PlannerUnit>,
  setNumber: number,
): string | null {
  const seen = new Set<string>();
  const codes: number[] = [];
  for (const cell of board) {
    if (!cell) continue;
    if (seen.has(cell.unitId)) continue;
    seen.add(cell.unitId);
    const unit = unitsById.get(cell.unitId);
    if (!unit?.plannerCode) continue;
    codes.push(unit.plannerCode);
    if (codes.length === 10) break;
  }
  if (codes.length === 0) return null;
  while (codes.length < 10) codes.push(0);
  const hex = codes.map((c) => c.toString(16).padStart(3, '0').toUpperCase()).join('');
  return `02${hex}TFTSet${setNumber}`;
}

/**
 * Decodes a Riot TFT team-planner code into an ordered list of unit ids.
 * unitsByCode maps plannerCode → character_id.
 * Returns null if the string doesn't match the expected format.
 */
export function decodeRiotCode(
  code: string,
  unitsByCode: Map<number, string>,
): string[] | null {
  const m = code.trim().match(/^02([0-9A-Fa-f]+)(TFTSet\d+)$/);
  if (!m || m[1].length % 3 !== 0) return null;
  const hex = m[1];
  const result: string[] = [];
  for (let i = 0; i < hex.length; i += 3) {
    const val = parseInt(hex.slice(i, i + 3), 16);
    if (val === 0) continue;
    const unitId = unitsByCode.get(val);
    if (unitId) result.push(unitId);
  }
  return result.length > 0 ? result : null;
}

export function decodeBoard(code: string): Cell[] | null {
  try {
    const v = code.trim();
    if (!v) return emptyBoard();
    const body = v.startsWith('1') ? v.slice(1) : v;
    let b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const arr = JSON.parse(atob(b64)) as Packed[];
    if (!Array.isArray(arr)) return null;
    const board = emptyBoard();
    for (const e of arr) {
      if (typeof e?.i === 'number' && e.i >= 0 && e.i < BOARD_SIZE && typeof e.u === 'string') {
        board[e.i] = { unitId: e.u, items: Array.isArray(e.it) ? e.it.slice(0, 3) : [] };
      }
    }
    return board;
  } catch {
    return null;
  }
}
