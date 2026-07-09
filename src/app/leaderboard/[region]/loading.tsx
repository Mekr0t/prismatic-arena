export default function Loading() {
  return (
    <main className="page">
      <section className="lb">
        <div className="lb-head">
          <div className="lb-title">
            <h1>Leaderboard</h1>
            <span className="skeleton lb-skel-sub" />
          </div>
        </div>

        <div className="lb-tabs">
          <span className="on">Challenger</span>
          <span>Grandmaster</span>
          <span>Master</span>
        </div>

        <div className="lb-table">
          <div className="lb-row lb-h">
            <span className="c-rank">#</span>
            <span className="c-name">Player</span>
            <span className="c-lp">LP</span>
            <span className="c-w wl">Wins</span>
            <span className="c-l wl">Losses</span>
            <span className="c-wr">Win%</span>
          </div>

          {Array.from({ length: 12 }).map((_, i) => (
            <div className="lb-row sk" key={i}>
              <span className="c-rank">
                <span className="skeleton" />
              </span>
              <span className="c-name">
                <span className="skeleton" />
              </span>
              <span className="c-lp">
                <span className="skeleton" />
              </span>
              <span className="c-w wl">
                <span className="skeleton" />
              </span>
              <span className="c-l wl">
                <span className="skeleton" />
              </span>
              <span className="c-wr">
                <span className="skeleton" />
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
