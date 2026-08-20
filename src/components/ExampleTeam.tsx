'use client';

// The example team — "how this comp looks most of the time." A strip of active
// traits (icon + count, no name) above the most-common board. Units show a pip
// ONLY when their modal star is 3 (no pip = 2-star, the standard convention);
// items are deferred (step 3). Everything wires the shared useGameData popups.

import { useEntityTrigger } from '@/lib/game-data';
import type { ExampleUnitVM, ExampleTraitVM, ExampleTeamVM } from '@/server/comps-service';

function ExampleItem({ item }: { item: ExampleUnitVM['items'][number] }) {
  const trigger = useEntityTrigger({
    type: 'item',
    id: item.itemId,
    name: item.name,
    stopPropagation: true,
  });
  return <img className="ex-itemimg" src={item.iconUrl ?? ''} alt={item.name} {...trigger} />;
}

function ExampleUnit({ unit }: { unit: ExampleUnitVM }) {
  const trigger = useEntityTrigger({
    type: 'unit',
    id: unit.characterId,
    name: unit.name,
    label: unit.star === 3 ? `${unit.name}, 3 star` : unit.name,
  });
  return (
    <div className="ex-unit">
      <div className={`ex-star${unit.star === 3 ? '' : ' hide'}`} aria-hidden>
        ★★★
      </div>
      <div className={`ex-tile c${unit.cost || 1}`} {...trigger}>
        {unit.iconUrl ? <img src={unit.iconUrl} alt="" /> : <span>{unit.name}</span>}
      </div>
      {unit.items.length > 0 && (
        <div className="ex-items">
          {unit.items.map((it, i) =>
            it.iconUrl ? (
              <ExampleItem key={`${it.itemId}:${i}`} item={it} />
            ) : (
              <i key={`${it.itemId}:${i}`} className="ex-itemimg ex-item-ph" title={it.name} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ExampleTrait({ trait }: { trait: ExampleTraitVM }) {
  const trigger = useEntityTrigger({
    type: 'trait',
    id: trait.traitId,
    name: trait.name,
    label: `${trait.name}, ${trait.numUnits} units`,
  });
  return (
    <span className={`ex-trait ${trait.unique ? 'unique' : `s${trait.style}`}`} {...trigger}>
      {trait.iconUrl ? <img src={trait.iconUrl} alt="" /> : <span className="ex-dot" />}
      <span className="ex-n">{trait.numUnits}</span>
    </span>
  );
}

export function ExampleTeam({ team }: { team: ExampleTeamVM }) {
  if (team.units.length === 0 && team.traits.length === 0) {
    return <div className="ex-team ex-empty">no board data</div>;
  }
  return (
    <div className="ex-team">
      {team.traits.length > 0 && (
        <div className="ex-traits">
          {team.traits.map((t) => (
            <ExampleTrait key={t.traitId} trait={t} />
          ))}
        </div>
      )}
      <div className="ex-units">
        {team.units.map((u, i) => (
          <ExampleUnit key={`${u.characterId}:${i}`} unit={u} />
        ))}
      </div>
    </div>
  );
}
