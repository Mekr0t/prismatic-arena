import Link from 'next/link';
import SearchBar from './SearchBar';
import Nav from './Nav';

export default function Header() {
  return (
    <header className="header">
      <Link href="/" className="brand">
        <img src="/logo.png" className="brand-logo" alt="Prismatic Arena" />
        <b>Prismatic Arena</b>
      </Link>
      <SearchBar />
      <Nav />
    </header>
  );
}
