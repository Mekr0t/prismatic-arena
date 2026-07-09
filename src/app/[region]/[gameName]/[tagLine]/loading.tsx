export default function Loading() {
  return (
    <main className="page">
      <div className="skeleton sk-header" />
      <div className="matches">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton sk-row" />
        ))}
      </div>
    </main>
  );
}
