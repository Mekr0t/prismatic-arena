import { getLibraryData } from '@/server/library-data';
import { NextResponse } from 'next/server';

export const revalidate = 3600;

export async function GET() {
  try {
    const data = await getLibraryData();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'Failed to load game data' }, { status: 500 });
  }
}
