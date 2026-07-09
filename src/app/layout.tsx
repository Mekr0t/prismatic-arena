import type { Metadata } from 'next';
import { Space_Grotesk, Hanken_Grotesk, IBM_Plex_Mono } from 'next/font/google';
import Header from '@/components/Header';
import { GameDataProvider } from '@/lib/game-data';
import './globals.css';

const display = Space_Grotesk({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display' });
const body = Hanken_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-body' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Prismatic Arena',
  description: 'Teamfight Tactics player profiles, match history, and stats.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Header />
        <GameDataProvider>
          {children}
        </GameDataProvider>
        <footer className="site-footer">
          Prismatic Arena isn&apos;t endorsed by Riot Games and doesn&apos;t reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
        </footer>
      </body>
    </html>
  );
}
