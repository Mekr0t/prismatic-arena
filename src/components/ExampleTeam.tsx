'use client';

// The example team — "how this comp looks most of the time." A strip of active
// traits (icon + count, no name) above the most-common board. Units show a pip
// ONLY when their modal star is 3 (no pip = 2-star, the standard convention);
// items are deferred (step 3). Everything wires the shared useGameData popups.

import { useGameData } from '@/lib/game-data';
import type { ExampleUnitVM, ExampleTraitVM, ExampleTeamVM } from '@/server/comps-service';

function ExampleUnit({ unit }: { unit: ExampleUnitVM }) {
  const { showTooltip, hideTooltip, openModal } = useGameData();
  return (
    <div className="ex-unit">
      <div className={`ex-star${unit.star === 3 ? '' : ' hide'}`}>★★★</div>
      <div
        className={`ex-tile c${unit.cost || 1}`}
        onMouseEnter={(e) => showTooltip(e, 'unit', unit.characterId, unit.name)}
        onMouseLeave={hideTooltip}
        onClick={() => openModal('unit', unit.characterId, unit.name)}
      >
        {unit.iconUrl ? <img src={unit.iconUrl} alt={unit.name} /> : <span>{unit.name}</span>}
      </div>
      {unit.items.length > 0 && (
        <div className="ex-items">
          {unit.items.map((it, i) =>
            it.iconUrl ? (
              <img
                key={`${it.itemId}:${i}`}
                className="ex-itemimg"
                src={it.iconUrl}
                alt={it.name}
                onMouseEnter={(e) => { e.stopPropagation(); showTooltip(e, 'item', it.itemId, it.name); }}
                onMouseLeave={hideTooltip}
                onClick={(e) => { e.stopPropagation(); openModal('item', it.itemId, it.name); }}
              />
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
  const { showTooltip, hideTooltip, openModal } = useGameData();
  return (
    <span
      className={`ex-trait ${trait.unique ? 'unique' : `s${trait.style}`}`}
      onMouseEnter={(e) => showTooltip(e, 'trait', trait.traitId, trait.name)}
      onMouseLeave={hideTooltip}
      onClick={() => openModal('trait', trait.traitId, trait.name)}
    >
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
