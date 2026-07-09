import { getLibraryData } from '@/server/library-data';
import Library from '@/components/Library';

export const metadata = { title: 'Library — Prismatic Arena' };

export default async function LibraryPage() {
  const data = await getLibraryData();
  return (
    <main className="page">
      <Library data={data} />
    </main>
  );
}
