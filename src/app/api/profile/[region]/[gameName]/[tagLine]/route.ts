import { NextResponse } from 'next/server';
import { getPlayerProfile, ProfileNotFoundError } from '@/server/profile-service';
import { isPlatform } from '@/config/regions';
import { handleApiError } from '@/app/api/utils';

// This route calls Riot on demand, so it must not be statically cached.
export const dynamic = 'force-dynamic';

// GET /api/profile/euw1/Faker/KR1
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ region: string; gameName: string; tagLine: string }> },
) {
  const { region, gameName, tagLine } = await ctx.params;

  if (!isPlatform(region)) {
    return NextResponse.json({ error: `Unknown platform '${region}'` }, { status: 400 });
  }

  const name = decodeURIComponent(gameName).trim();
  const tag = decodeURIComponent(tagLine).trim();
  if (!name || name.length > 16 || !tag || tag.length > 5) {
    return NextResponse.json({ error: 'Invalid Riot ID' }, { status: 400 });
  }

  try {
    const profile = await getPlayerProfile(region, name, tag);
    return NextResponse.json(profile);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return handleApiError(err);
  }
}
