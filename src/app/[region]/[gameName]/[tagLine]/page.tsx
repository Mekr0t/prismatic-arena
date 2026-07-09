import { notFound } from 'next/navigation';
import { isPlatform } from '@/config/regions';
import { getPlayerProfile, ProfileNotFoundError, type PlayerProfile } from '@/server/profile-service';
import { getCatalog } from '@/server/static-data';
import { buildProfileVM } from '@/server/view-models';
import ProfileContent from '@/components/ProfileContent';

export const dynamic = 'force-dynamic';

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ region: string; gameName: string; tagLine: string }>;
}) {
  const { region, gameName, tagLine } = await params;
  if (!isPlatform(region)) notFound();

  const name = decodeURIComponent(gameName).trim();
  const tag = decodeURIComponent(tagLine).trim();
  if (!name || name.length > 16 || !tag || tag.length > 5) notFound();

  let profile: PlayerProfile;
  try {
    profile = await getPlayerProfile(region, name, tag);
  } catch (err) {
    if (err instanceof ProfileNotFoundError) notFound();
    throw err;
  }

  const catalog = await getCatalog();
  const vm = buildProfileVM(profile, catalog);

  return (
    <main className="page">
      <ProfileContent vm={vm} />
    </main>
  );
}
