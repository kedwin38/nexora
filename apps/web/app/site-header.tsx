'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getMe, isOwner, logout, session, type Me } from '@/lib/api';

/**
 * Auth-aware site header. Renders role-appropriate navigation and a Logout
 * control, so an ISP's admin/billing/network staff, a customer, and the
 * platform owner each see only what applies to them. Re-reads identity on
 * route changes via a lightweight interval + storage listener.
 */
export function SiteHeader() {
  const [me, setMe] = useState<Me | null>(null);
  const [hasCustomer, setHasCustomer] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const sync = async (): Promise<void> => {
      const identity = await getMe();
      if (!alive) return;
      setMe(identity);
      setHasCustomer(session.token('customer') !== null);
      setReady(true);
    };
    void sync();
    // Reflect sign-in/out that happens on other tabs or after navigation.
    const onStorage = (): void => void sync();
    window.addEventListener('storage', onStorage);
    const poll = setInterval(() => void sync(), 4000);
    return () => {
      alive = false;
      window.removeEventListener('storage', onStorage);
      clearInterval(poll);
    };
  }, []);

  const staff = me !== null;
  const owner = isOwner(me);

  return (
    <header>
      <Link href="/" className="brand">
        NEXORA <small>// ISP OS</small>
      </Link>
      <nav>
        {owner && <Link href="/owner">Owner</Link>}
        {staff && !owner && <Link href="/admin">Admin</Link>}
        {hasCustomer && !staff && <Link href="/dashboard">Dashboard</Link>}
        <Link href="/packages">Packages</Link>
        <Link href="/guide">Guide</Link>
        {ready && (staff || hasCustomer) ? (
          <>
            {staff && <span className="who mono">{me?.user.displayName ?? me?.user.email}</span>}
            <button className="logout" onClick={() => void logout()}>
              LOGOUT
            </button>
          </>
        ) : ready ? (
          <Link href="/auth/login">Sign in</Link>
        ) : null}
      </nav>
    </header>
  );
}
