import { NextResponse } from 'next/server';
import { getMatchDetail } from '@/server/match-service';
import { isPlatform } from '@/config/regions';
import { handleApiError } from '@/app/api/utils';
import { limitRiotRead } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

// e.g. "EUW1_7412345678" — platform prefix, underscore, digits.
const MATCH_ID_RE = /^[A-Za-z0-9]{2,8}_[0-9]{1,24}$/;

// GET /api/match/euw1/EUW1_1234567890
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ region: string; matchId: string }> },
) {
  const { region, matchId } = await ctx.params;

  if (!isPlatform(region)) {
    return NextResponse.json({ error: `Unknown platform '${region}'` }, { status: 400 });
  }

  // Reject a malformed id BEFORE spending a Riot call on it. The client encodes
  // path segments too, so this is the cheap outer layer of the same guard.
  const id = decodeURIComponent(matchId);
  if (!MATCH_ID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid match id' }, { status: 400 });
  }

  const limit = await limitRiotRead('match');
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  try {
    const detail = await getMatchDetail(region, id);
    if (!detail) return NextResponse.json({ error: 'Match not found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (err) {
    return handleApiError(err);
  }
}
