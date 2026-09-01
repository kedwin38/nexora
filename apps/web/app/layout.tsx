import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'NEXORA // ISP OS',
  description: 'NEXORA ISP Operating System — control plane',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <div className="brand">
            NEXORA <small>// ISP OS</small>
          </div>
          <nav>
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/packages">Packages</Link>
            <Link href="/admin">Admin</Link>
          </nav>
        </header>
        {children}
        <footer>NEXORA ISP OS // CONTROL PLANE // PHASE 1</footer>
      </body>
    </html>
  );
}
