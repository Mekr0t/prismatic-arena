import { getPlannerData } from '@/server/planner-data';
import Planner from '@/components/Planner';

export const dynamic = 'force-dynamic';

export default async function PlannerPage() {
  const data = await getPlannerData();
  return (
    <main className="page">
      <Planner data={data} />
    </main>
  );
}
