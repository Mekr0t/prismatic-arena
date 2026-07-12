// rich-text.tsx — render the «class:text» token format that load-static-data.ts
// emits for unit ability / trait / item / augment descriptions.
//
// The loader converts CommunityDragon's semantic tags (physicalDamage,
// scaleHealth, spellActive, …) into compact `«class:text»` tokens — guillemets
// never appear in real TFT text, so the grammar is unambiguous. Tokens may
// NEST (a magic-damage number that also scales with AP). We PARSE the grammar
// into React elements — never innerHTML — so there is no injection surface even
// though the source is trusted. Class names map 1:1 to `.rt-<class>` in
// styles/rich.css. Plain text with no tokens renders unchanged, so pre-reload
// (flattened) descriptions still display correctly.

import React from 'react';

const CLASS_RE = /^[a-z]+$/;

/** Parse from index `i` until an unmatched `»` (span close) or end of string. */
function parse(str: string, i: number, counter: { n: number }): { nodes: React.ReactNode[]; i: number } {
  const nodes: React.ReactNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      nodes.push(buf);
      buf = '';
    }
  };

  while (i < str.length) {
    const ch = str[i];
    if (ch === '»') {
      i++; // consume close, return to caller
      break;
    }
    if (ch === '\n') {
      flush();
      nodes.push(<br key={`br${counter.n++}`} />);
      i++;
      continue;
    }
    if (ch === '«') {
      const colon = str.indexOf(':', i + 1);
      const cls = colon === -1 ? '' : str.slice(i + 1, colon);
      if (colon !== -1 && CLASS_RE.test(cls)) {
        flush();
        const inner = parse(str, colon + 1, counter);
        nodes.push(
          <span key={`s${counter.n++}`} className={`rt-${cls}`}>
            {inner.nodes}
          </span>,
        );
        i = inner.i;
        continue;
      }
      // Not a well-formed token — treat as literal.
    }
    buf += ch;
    i++;
  }
  flush();
  return { nodes, i };
}

/** Render a token string as coloured inline content. Returns null for empty. */
export function RichText({
  text,
  className,
}: {
  text: string | null | undefined;
  className?: string;
}): React.ReactElement | null {
  if (!text) return null;
  const { nodes } = parse(text, 0, { n: 0 });
  return <div className={className ?? 'rt'}>{nodes}</div>;
}

/** Strip tokens + newlines to a single plain line (tooltips, subtitles). */
export function richToPlain(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/«[a-z]+:/g, '')
    .replace(/»/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** First plain-text line, truncated — for compact tooltips. */
export function richFirstLine(text: string | null | undefined, max = 120): string {
  if (!text) return '';
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const line = richToPlain(first);
  return line.length <= max ? line : line.slice(0, max) + '…';
}
