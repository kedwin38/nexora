'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, session, fmtKes } from '@/lib/api';

interface Summary {
  summary: {
    customers: number;
    activeSubscriptions: number;
    paymentsSuccess: number;
    revenueMinor: number;
    pendingPayments: number;
    queuedNetworkOperations: number;
    failedNetworkOperations: number;
  };
}

interface CustomersResponse {
  data: Array<{
    id: string;
    customerNumber: string;
    accountType: string;
    status: string;
    phone: string | null;
    activeSubscription: { packageName: string; status: string; expiryTime: string | null } | null;
  }>;
  total: number;
}

interface PaymentsResponse {
  data: Array<{
    id: string;
    status: string;
    amountMinor: number;
    receipt: string | null;
    phoneNumber: string;
    createdAt: string;
    package: { name: string } | null;
  }>;
}

interface OpsResponse {
  data: Array<{
    id: string;
    type: string;
    status: string;
    attempts: string;
    router: string;
    lastError: string | null;
    createdAt: string;
  }>;
}

interface SessionsResponse {
  data: Array<{
    id: string;
    macAddress: string;
    ipAddress: string | null;
    status: string;
    downloadBytes: string;
    uploadBytes: string;
    customer: string;
    lastSeenAt: string;
  }>;
}

type Tab = 'overview' | 'customers' | 'payments' | 'sessions' | 'ops';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [summary, setSummary] = useState<Summary['summary'] | null>(null);
  const [customers, setCustomers] = useState<CustomersResponse['data']>([]);
  const [payments, setPayments] = useState<PaymentsResponse['data']>([]);
  const [ops, setOps] = useState<OpsResponse['data']>([]);
  const [sessions, setSessions] = useState<SessionsResponse['data']>([]);
  const [toast, setToast] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, c, p, o, sess] = await Promise.all([
        api<Summary>('/api/v1/admin/summary'),
        api<CustomersResponse>('/api/v1/admin/customers?limit=12'),
        api<PaymentsResponse>('/api/v1/admin/payments?limit=12'),
        api<OpsResponse>('/api/v1/admin/network-operations?limit=12'),
        api<SessionsResponse>('/api/v1/admin/sessions'),
      ]);
      setSummary(s.summary);
      setCustomers(c.data);
      setPayments(p.data);
      setOps(o.data);
      setSessions(sess.data);
    } catch {
      session.signOut();
      window.location.href = '/auth/login';
    }
  }, []);

  useEffect(() => {
    if (session.token('user') === null) {
      window.location.href = '/auth/login';
      return;
    }
    void loadAll();
    const poll = setInterval(() => void loadAll(), 10_000);
    return () => clearInterval(poll);
  }, [loadAll]);

  const retryOp = async (id: string): Promise<void> => {
    await api(`/api/v1/admin/network-operations/${id}/retry`, { method: 'POST' });
    setToast('Operation re-queued.');
    void loadAll();
  };

  const disconnectSession = async (id: string): Promise<void> => {
    await api(`/api/v1/admin/sessions/${id}/disconnect`, { method: 'POST' });
    setToast('Disconnect queued.');
    void loadAll();
  };

  return (
    <main>
      <h1>ADMIN COMMAND CENTER</h1>
      <div className="sub">// business state · desired state · actual state</div>
      {toast !== null && <div className="toast mono">{toast}</div>}
      <div className="tabs">
        {(['overview', 'customers', 'payments', 'sessions', 'ops'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      {tab === 'overview' && summary !== null && (
        <div className="grid c4">
          <div className="card"><div className="k">Customers</div><div className="v">{summary.customers}</div></div>
          <div className="card"><div className="k">Active subs</div><div className="v ok">{summary.activeSubscriptions}</div></div>
          <div className="card"><div className="k">Revenue</div><div className="v">{fmtKes(summary.revenueMinor)}</div></div>
          <div className="card">
            <div className="k">Net ops queued/failed</div>
            <div className={`v ${summary.failedNetworkOperations > 0 ? 'crit' : 'ok'}`}>
              {summary.queuedNetworkOperations}/{summary.failedNetworkOperations}
            </div>
          </div>
        </div>
      )}

      {tab === 'customers' && (
        <div className="card">
          <table>
            <thead><tr><th>Customer</th><th>Type</th><th>Status</th><th>Phone</th><th>Package</th><th>Expiry</th></tr></thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>{c.customerNumber}</td>
                  <td>{c.accountType}</td>
                  <td><span className={`pill ${c.status}`}>{c.status}</span></td>
                  <td>{c.phone ?? '—'}</td>
                  <td>{c.activeSubscription?.packageName ?? '—'}</td>
                  <td>{c.activeSubscription?.expiryTime ? new Date(c.activeSubscription.expiryTime).toLocaleString() : '—'}</td>
                </tr>
              ))}
              {customers.length === 0 && <tr><td colSpan={6} className="sub">no customers</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'payments' && (
        <div className="card">
          <table>
            <thead><tr><th>Status</th><th>Amount</th><th>Package</th><th>Phone</th><th>Receipt</th><th>When</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td><span className={`pill ${p.status}`}>{p.status}</span></td>
                  <td>{fmtKes(p.amountMinor)}</td>
                  <td>{p.package?.name ?? '—'}</td>
                  <td>{p.phoneNumber}</td>
                  <td>{p.receipt ?? '—'}</td>
                  <td>{new Date(p.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {payments.length === 0 && <tr><td colSpan={6} className="sub">no payments</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'sessions' && (
        <div className="card">
          <table>
            <thead><tr><th>Customer</th><th>MAC</th><th>IP</th><th>Status</th><th>↓ / ↑</th><th>Last seen</th><th></th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.customer}</td>
                  <td>{s.macAddress}</td>
                  <td>{s.ipAddress ?? '—'}</td>
                  <td><span className={`pill ${s.status}`}>{s.status}</span></td>
                  <td>{s.downloadBytes} / {s.uploadBytes}</td>
                  <td>{new Date(s.lastSeenAt).toLocaleString()}</td>
                  <td><button className="ghost" onClick={() => void disconnectSession(s.id)}>DISCONNECT</button></td>
                </tr>
              ))}
              {sessions.length === 0 && <tr><td colSpan={7} className="sub">no active sessions</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'ops' && (
        <div className="card">
          <table>
            <thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Router</th><th>Error</th><th></th></tr></thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.id}>
                  <td>{o.type}</td>
                  <td><span className={`pill ${o.status}`}>{o.status}</span></td>
                  <td>{o.attempts}</td>
                  <td>{o.router}</td>
                  <td className="sub">{o.lastError ?? '—'}</td>
                  <td>
                    {o.status === 'PERMANENT_FAILURE' && (
                      <button className="ghost" onClick={() => void retryOp(o.id)}>RETRY</button>
                    )}
                  </td>
                </tr>
              ))}
              {ops.length === 0 && <tr><td colSpan={6} className="sub">queue empty</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
