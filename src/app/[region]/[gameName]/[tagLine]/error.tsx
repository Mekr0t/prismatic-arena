'use client';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="page">
      <div className="notice">
        <h2>Something went wrong</h2>
        <p>Couldn’t load this profile. The match service may be busy — give it a moment.</p>
        <button onClick={() => reset()}>Try again</button>
      </div>
    </main>
  );
}
