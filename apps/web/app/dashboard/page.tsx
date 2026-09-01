'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, session, fmtBytes } from '@/lib/api';

interface Me {
  customer: { customerNumber: string; phone: string | null; displayName: string | null; status: string; memberSince: string };
  subscription: {
    id: string;
    subscriptionNumber: string;
    status: string;
    packageName: string;
    expiryTime: string | null;
    policySnapshot: { downloadKbps: number; uploadKbps: number };
  } | null;
  fup: { state: string; usedBytes: string; limitBytes: string } | null;
}

export default function DashboardPage() {
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await api<Me>('/api/v1/customers/me'));
    } catch {
      session.signOut();
      window.location.href = '/auth/login';
    }
  }, []);

  useEffect(() => {
    if (session.token('customer') === null) {
      window.location.href = '/auth/login';
      return;
    }
    void load();
    const poll = setInterval(() => void load(), 10_000);
    return () => clearInterval(poll);
  }, [load]);

  if (me === null) {
    return (
      <main>
        <div className="card mono">LOADING…</div>
      </main>
    );
  }

  const snap = me.subscription?.policySnapshot;

  return (
    <main>
      <h1>CUSTOMER DASHBOARD</h1>
      <div className="sub">
        // {me.customer.customerNumber} · {me.customer.phone ?? '-'} · since {new Date(me.customer.memberSince).toLocaleDateString()}
      </div>
      <div className="grid c4">
        <div className="card">
          <div className="k">Account</div>
          <div className={`v ${me.customer.status === 'ACTIVE' ? 'ok' : 'warn'}`}>{me.customer.status}</div>
        </div>
        <div className="card">
          <div className="k">Package</div>
          <div className="v">{me.subscription?.packageName ?? 'NONE'}</div>
          <div className="sub" style={{ marginTop: 6 }}>
            <span className={`pill ${me.subscription?.status ?? ''}`}>{me.subscription?.status ?? '—'}</span>
          </div>
        </div>
        <div className="card">
          <div className="k">Speed</div>
          <div className="v">{snap ? `${snap.downloadKbps}k` : '—'}</div>
          <div className="sub" style={{ marginTop: 6 }}>{snap ? `${snap.uploadKbps}k up` : ''}</div>
        </div>
        <div className="card">
          <div className="k">Expires</div>
          <div className="v">
            {me.subscription?.expiryTime ? new Date(me.subscription.expiryTime).toLocaleDateString() : '—'}
          </div>
        </div>
      </div>
      <br />
      {me.fup !== null && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="k">DATA USAGE (FUP)</div>
          <div className="v">
            {fmtBytes(me.fup.usedBytes)} / {fmtBytes(me.fup.limitBytes)}
          </div>
          <div className="sub" style={{ marginTop: 6 }}>
            <span className={`pill ${me.fup.state === 'THROTTLED' ? 'FUP' : me.fup.state}`}>{me.fup.state}</span>{' '}
            {me.fup.state === 'THROTTLED' ? '— speeds reduced until reset' : ''}
          </div>
        </div>
      )}
      <div className="card">
        <div className="k">QUICK ACTIONS</div>
        <br />
        <Link href="/packages">
          <button className="ghost">BUY / RENEW PACKAGE →</button>
        </Link>
      </div>
    </main>
  );
}
