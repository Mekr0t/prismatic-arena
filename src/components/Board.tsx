'use client';

import { useEntityTrigger } from '@/lib/game-data';
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

/** One item icon on a unit tile. Separate component so it can use the trigger
 *  hook; `stopPropagation` keeps a click here off the sibling unit tile. */
function ItemIcon({ item }: { item: UnitVM['items'][number] }) {
  const trigger = useEntityTrigger({
    type: 'item',
    id: item.itemId,
    name: item.name,
    stopPropagation: true,
  });
  return <img className="itemimg" src={item.iconUrl ?? ''} alt={item.name} {...trigger} />;
}

export function UnitTile({ unit }: { unit: UnitVM }) {
  const trigger = useEntityTrigger({ type: 'unit', id: unit.characterId, name: unit.name });
  const stars = unit.star > 1 ? '★'.repeat(unit.star) : '★';
  return (
    <div className="unit">
      <div className={`stars ${unit.star > 1 ? '' : 's0'}`} aria-hidden>
        {stars}
      </div>
      <div className={`tile c${unit.cost || 1}`} {...trigger}>
        {unit.iconUrl ? (
          <img className="tileimg" src={unit.iconUrl} alt="" />
        ) : (
          <span>{unit.name}</span>
        )}
      </div>
      <div className="items">
        {unit.items.slice(0, 3).map((it, i) =>
          it.iconUrl ? (
            <ItemIcon key={`${it.itemId}:${i}`} item={it} />
          ) : (
            <i key={`${it.itemId}:${i}`} title={it.name} />
          ),
        )}
      </div>
    </div>
  );
}

export function TraitChip({ trait }: { trait: TraitVM }) {
  // The visible content is an icon plus a bare count, so the accessible name has
  // to be spelled out — "Dark Star, 4 units" rather than "4".
  const trigger = useEntityTrigger({
    type: 'trait',
    id: trait.traitId,
    name: trait.name,
    label: `${trait.name}, ${trait.numUnits} units`,
  });
  return (
    <span className={`chip ${trait.unique ? 'unique' : `s${trait.style}`}`} {...trigger}>
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
