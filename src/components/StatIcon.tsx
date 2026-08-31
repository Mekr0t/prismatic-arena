import React from 'react';
import { STAT_ICONS, ATLAS_W, ATLAS_H, ATLAS_URL, statIconKey, type StatIconKey } from '@/lib/stat-icons';

// One in-game stat glyph, cut out of TFT's shared icon atlas.
//
// The atlas maths lives HERE rather than in a stylesheet on purpose: the
// rectangles come from `stat-icons.ts`, and a CSS copy of the same numbers would
// eventually disagree with it — silently showing the wrong glyph, which is the
// one failure mode nobody notices. Computing them means there is one source.
//
// The icons are not a uniform size in the atlas (18, 20 and 24 px), so each one
// scales the whole sheet by `size / n` to land at the same rendered size.
// Everything is expressed in `em`, so an icon tracks the font size of whatever
// text it sits in.

export function StatIcon({
  iconKey,
  size = '1.05em',
  className,
}: {
  iconKey: StatIconKey;
  /** Rendered edge length. Any CSS length; `em` keeps it tied to the text. */
  size?: string;
  className?: string;
}): React.ReactElement {
  const { x, y, n, label } = STAT_ICONS[iconKey];
  const per = `(${size} / ${n})`; // one atlas pixel, in rendered units
  return (
    <span
      className={className ? `si ${className}` : 'si'}
      role="img"
      aria-label={label}
      title={label}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${ATLAS_URL})`,
        backgroundSize: `calc(${ATLAS_W} * ${per}) calc(${ATLAS_H} * ${per})`,
        backgroundPosition: `calc(-${x} * ${per}) calc(-${y} * ${per})`,
      }}
    />
  );
}

/**
 * A stat's name preceded by its glyph, when one exists.
 *
 * The label always stays: the icon is a scanning aid, not a replacement, and a
 * stat we have no glyph for must still read normally rather than losing its
 * name. Shared by the unit stat grid and both item stat lists so those three
 * cannot drift into showing the same stat differently.
 */
export function StatLabel({ label }: { label: string }): React.ReactElement {
  const key = statIconKey(label);
  return (
    <>
      {key ? <StatIcon iconKey={key} /> : null}
      {key ? ' ' : ''}
      {label}
    </>
  );
}
