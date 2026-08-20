// Shown instead of a page body when the Riot-backed read limiter rejects a
// request (src/server/rate-limit.ts). Deliberately plain-language and honest
// about the cause — the copy convention from TFT-Frontend-Spec.md §6: never
// system terms, never apologies.

export function RateLimited({ retryAfter }: { retryAfter: number }) {
  const wait = retryAfter > 60 ? `${Math.ceil(retryAfter / 60)} minutes` : `${retryAfter} seconds`;
  return (
    <div className="notice">
      <h2>Busy right now</h2>
      <p>
        We&rsquo;re fetching more from Riot than the API budget allows. Try again in about {wait}.
      </p>
    </div>
  );
}
