export default function Loading() {
  return (
    <main className="page">
      <section className="match-page">
        <header className="mp-head">
          <div className="mp-title">
            <h1>Lobby</h1>
            <span className="skeleton mp-skel-id" />
          </div>
        </header>

        <div className="mp-lobby">
          {Array.from({ length: 8 }).map((_, i) => (
            <div className="pl" key={i}>
              <span className="pl-hex" style={{ background: 'var(--surface-2)' }} />
              <div className="pl-main">
                <div className="pl-top">
                  <span className="skeleton mp-skel-name" />
                </div>
                <div className="units">
                  {Array.from({ length: 7 }).map((__, j) => (
                    <span className="skeleton mp-skel-tile" key={j} />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
