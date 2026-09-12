import type { Metadata } from 'next';
import { SiteHeader } from './site-header';
import './globals.css';

export const metadata: Metadata = {
  title: 'NEXORA // ISP OS',
  description: 'NEXORA ISP Operating System — control plane',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        {children}
        <footer>NEXORA ISP OS // multi-tenant control plane</footer>
      </body>
    </html>
  );
}
