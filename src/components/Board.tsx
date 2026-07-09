'use client';

import { useGameData } from '@/lib/game-data';
import type { UnitVM, TraitVM, BoardVM, Bucket } from '@/server/view-models';

export function PlacementBadge({
  placement,
  bucket,
  variant = 'row',
}: {
  placement: number;
  bucket: Bucket;
  variant?: 'row' | 'lobby';
}) {
  return <div className={`${variant === 'lobby' ? 'pl-hex' : 'hex'} ${bucket}`}>{placement}</div>;
}

export function UnitTile({ unit }: { unit: UnitVM }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  const stars = unit.star > 1 ? '★'.repeat(unit.star) : '★';
  return (
    <div className="unit">
      <div className={`stars ${unit.star > 1 ? '' : 's0'}`}>{stars}</div>
      <div
        className={`tile c${unit.cost || 1}`}
        style={{ cursor: 'pointer' }}
        onMouseEnter={(e) => showTooltip(e, 'unit', unit.characterId, unit.name)}
        onMouseLeave={hideTooltip}
        onClick={() => openModal('unit', unit.characterId, unit.name)}
      >
        {unit.iconUrl ? (
          <img className="tileimg" src={unit.iconUrl} alt={unit.name} />
        ) : (
          <span>{unit.name}</span>
        )}
      </div>
      <div className="items">
        {unit.items.slice(0, 3).map((it, i) =>
          it.iconUrl ? (
            <img
              key={i}
              className="itemimg"
              src={it.iconUrl}
              alt={it.name}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => { e.stopPropagation(); showTooltip(e, 'item', it.itemId, it.name); }}
              onMouseLeave={hideTooltip}
              onClick={(e) => { e.stopPropagation(); openModal('item', it.itemId, it.name); }}
            />
          ) : (
            <i key={i} title={it.name} />
          ),
        )}
      </div>
    </div>
  );
}

export function TraitChip({ trait }: { trait: TraitVM }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  return (
    <span
      className={`chip ${trait.unique ? 'unique' : `s${trait.style}`}`}
      style={{ cursor: 'pointer' }}
      onMouseEnter={(e) => showTooltip(e, 'trait', trait.traitId, trait.name)}
      onMouseLeave={hideTooltip}
      onClick={() => openModal('trait', trait.traitId, trait.name)}
    >
      {trait.iconUrl ? <img className="chipimg" src={trait.iconUrl} alt="" /> : <span className="dot" />}
      {trait.name} <span className="n">{trait.numUnits}</span>
    </span>
  );
}

export function BoardStrip({ board, maxTraits }: { board: BoardVM; maxTraits?: number }) {
  const shown = maxTraits !== undefined ? board.traits.slice(0, maxTraits) : board.traits;
  const more = board.traits.length - shown.length;
  return (
    <>
      <div className="units">
        {board.units.map((u, i) => (
          <UnitTile key={`${u.characterId}-${i}`} unit={u} />
        ))}
      </div>
      <div className="traits">
        {shown.map((t) => (
          <TraitChip key={t.traitId} trait={t} />
        ))}
        {more > 0 && <span className="chip more">+{more}</span>}
      </div>
    </>
  );
}
