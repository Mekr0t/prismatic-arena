import { NextResponse } from 'next/server';
import { getMatchDetail } from '@/server/match-service';
import { isPlatform } from '@/config/regions';
import { handleApiError } from '@/app/api/utils';

export const dynamic = 'force-dynamic';

// GET /api/match/euw1/EUW1_1234567890
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ region: string; matchId: string }> },
) {
  const { region, matchId } = await ctx.params;

  if (!isPlatform(region)) {
    return NextResponse.json({ error: `Unknown platform '${region}'` }, { status: 400 });
  }

  try {
    const detail = await getMatchDetail(region, decodeURIComponent(matchId));
    if (!detail) return NextResponse.json({ error: 'Match not found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (err) {
    return handleApiError(err);
  }
}
