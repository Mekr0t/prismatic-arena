import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="page">
      <div className="notice">
        <h2>Player not found</h2>
        <p>Check the spelling and the tag (the part after #), then try again.</p>
        <Link className="btn" href="/">Back to search</Link>
      </div>
    </main>
  );
}
