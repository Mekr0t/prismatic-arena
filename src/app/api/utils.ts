import { NextResponse } from 'next/server';
import { RiotApiError } from '@/lib/riot';

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof RiotApiError) {
    const status = err.status >= 500 ? 502 : err.status;
    return NextResponse.json({ error: err.message }, { status });
  }
  console.error(err);
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}
