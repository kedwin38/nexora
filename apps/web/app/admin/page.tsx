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
    displayName: string | null;
    activeSubscription: { packageName: string; status: string; expiryTime: string | null } | null;
  }>;
}

interface CustomerDetail {
  business: {
    customer: { customerNumber: string; accountType: string; status: string; phone: string | null };
    subscription: { subscriptionNumber: string; status: string; packageName: string; expiryTime: string | null; fup: { state: string; usedBytes: string; limitBytes: string } | null } | null;
    payments: Array<{ id: string; status: string; amountMinor: number; receipt: string | null }>;
  };
  desiredNetworkState: { version: number; state: { authorized: boolean; rateLimit: { downloadKbps: number; uploadKbps: number } | null } | null; synchronizedAt: string | null } | null;
  actualNetworkState: { lastOperation: { type: string; status: string; verifiedAt: string | null }; matchesDesired: boolean | null } | null;
  driftVerdict: string;
  devices: Array<{ macAddress: string }>;
}

interface PackagesResponse {
  data: Array<{
    id: string;
    name: string;
    version: number;
    status: string;
    priceMinor: number;
    durationSeconds: number;
    policy: { downloadKbps: number; uploadKbps: number; fupLimitBytes: string | null } | null;
  }>;
}

interface UsersResponse {
  data: Array<{ id: string; email: string; displayName: string; status: string; role: string }>;
}

interface RolesResponse {
  data: Array<{ name: string }>;
}

interface PaymentsResponse {
  data: Array<{ id: string; status: string; amountMinor: number; receipt: string | null; phoneNumber: string; createdAt: string; package: { name: string } | null }>;
}

interface OpsResponse {
  data: Array<{ id: string; type: string; status: string; attempts: string; router: string; lastError: string | null }>;
}

interface SessionsResponse {
  data: Array<{ id: string; macAddress: string; ipAddress: string | null; status: string; downloadBytes: string; uploadBytes: string; customer: string }>;
}

type Tab = 'overview' | 'customers' | 'packages' | 'users' | 'ops' | 'triggers';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [toast, setToast] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const call = useCallback(async <T,>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch {
      session.signOut();
      window.location.href = '/auth/login';
      return null;
    }
  }, []);

  useEffect(() => {
    if (session.token('user') === null) {
      window.location.href = '/auth/login';
    }
  }, []);

  const retryOp = async (id: string): Promise<void> => {
    await api(`/api/v1/admin/network-operations/${id}/retry`, { method: 'POST' });
    setToast('Operation re-queued.');
  };

  return (
    <main>
      <h1>ADMIN COMMAND CENTER</h1>
      <div className="sub">// business state · desired state · actual state · audit</div>
      {toast !== null && <div className="toast mono">{toast}</div>}
      <div className="tabs">
        {(['overview', 'customers', 'packages', 'users', 'ops', 'triggers'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setDetail(null); }}>
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview call={call} />}
      {tab === 'customers' && <Customers call={call} detail={detail} setDetail={setDetail} />}
      {tab === 'packages' && <Packages call={call} setToast={setToast} />}
      {tab === 'users' && <Users call={call} setToast={setToast} />}
      {tab === 'ops' && <Ops call={call} retryOp={retryOp} setToast={setToast} />}
      {tab === 'triggers' && <Triggers call={call} setToast={setToast} />}
    </main>
  );
}

type CallFn = <T,>(run: () => Promise<T>) => Promise<T | null>;

function Overview({ call }: { call: CallFn }) {
  const [summary, setSummary] = useState<Summary['summary'] | null>(null);
  const [payments, setPayments] = useState<PaymentsResponse['data']>([]);
  const [ops, setOps] = useState<OpsResponse['data']>([]);

  useEffect(() => {
    void call(async () => {
      const [s, p, o] = await Promise.all([
        api<Summary>('/api/v1/admin/summary'),
        api<PaymentsResponse>('/api/v1/admin/payments?limit=12'),
        api<OpsResponse>('/api/v1/admin/network-operations?limit=12'),
      ]);
      setSummary(s.summary);
      setPayments(p.data);
      setOps(o.data);
    });
    const poll = setInterval(() => void call(async () => {
      setSummary((await api<Summary>('/api/v1/admin/summary')).summary);
    }), 15_000);
    return () => clearInterval(poll);
  }, [call]);

  if (summary === null) return <div className="card mono">LOADING…</div>;

  return (
    <>
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
      <br />
      <div className="grid c2">
        <div className="card">
          <div className="k">Recent payments</div><br />
          <table>
            <thead><tr><th>Status</th><th>Amount</th><th>Package</th><th>Phone</th><th>Receipt</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td><span className={`pill ${p.status}`}>{p.status}</span></td>
                  <td>{fmtKes(p.amountMinor)}</td>
                  <td>{p.package?.name ?? '—'}</td>
                  <td>{p.phoneNumber}</td>
                  <td>{p.receipt ?? '—'}</td>
                </tr>
              ))}
              {payments.length === 0 && <tr><td colSpan={5} className="sub">no payments</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="k">Network operations</div><br />
          <table>
            <thead><tr><th>Type</th><th>Status</th><th>Att.</th><th>Router</th></tr></thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.id}><td>{o.type}</td><td><span className={`pill ${o.status}`}>{o.status}</span></td><td>{o.attempts}</td><td>{o.router}</td></tr>
              ))}
              {ops.length === 0 && <tr><td colSpan={4} className="sub">queue empty</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Customers({ call, detail, setDetail }: { call: CallFn; detail: CustomerDetail | null; setDetail: (d: CustomerDetail | null) => void }) {
  const [customers, setCustomers] = useState<CustomersResponse['data']>([]);

  useEffect(() => {
    void call(async () => {
      setCustomers((await api<CustomersResponse>('/api/v1/admin/customers?limit=50')).data);
    });
  }, [call]);

  if (detail !== null) {
    const d = detail;
    return (
      <div className="card">
        <button className="ghost" onClick={() => setDetail(null)}>← BACK</button>
        <br /><br />
        <div className="grid c3">
          <div className="card">
            <div className="k">BUSINESS STATE</div><br />
            <table>
              <tbody>
                <tr><td>Number</td><td className="mono">{d.business.customer.customerNumber}</td></tr>
                <tr><td>Type</td><td>{d.business.customer.accountType}</td></tr>
                <tr><td>Subscription</td><td>{d.business.subscription ? <span className={`pill ${d.business.subscription.status}`}>{d.business.subscription.status}</span> : '—'}</td></tr>
                <tr><td>Package</td><td>{d.business.subscription?.packageName ?? '—'}</td></tr>
                <tr><td>FUP</td><td>{d.business.subscription?.fup ? `${d.business.subscription.fup.state} ${(Number(d.business.subscription.fup.usedBytes) / 1e9).toFixed(1)}/${(Number(d.business.subscription.fup.limitBytes) / 1e9).toFixed(1)}GB` : '—'}</td></tr>
                <tr><td>Payments</td><td>{d.business.payments.length}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="k">DESIRED NETWORK STATE</div><br />
            <table>
              <tbody>
                <tr><td>Version</td><td>v{d.desiredNetworkState?.version ?? '—'}</td></tr>
                <tr><td>Authorized</td><td>{String(d.desiredNetworkState?.state?.authorized ?? '—')}</td></tr>
                <tr><td>Rate</td><td>{d.desiredNetworkState?.state?.rateLimit ? `${d.desiredNetworkState.state.rateLimit.downloadKbps}/${d.desiredNetworkState.state.rateLimit.uploadKbps}k` : '—'}</td></tr>
                <tr><td>Synced</td><td>{d.desiredNetworkState?.synchronizedAt ? new Date(d.desiredNetworkState.synchronizedAt).toLocaleString() : 'never'}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="card">
            <div className="k">ACTUAL NETWORK STATE</div><br />
            <table>
              <tbody>
                <tr><td>Last op</td><td>{d.actualNetworkState ? `${d.actualNetworkState.lastOperation.type} (${d.actualNetworkState.lastOperation.status})` : '—'}</td></tr>
                <tr><td>Verified</td><td>{d.actualNetworkState?.lastOperation.verifiedAt ? new Date(d.actualNetworkState.lastOperation.verifiedAt).toLocaleString() : '—'}</td></tr>
                <tr><td>Drift</td><td><span className={`pill ${d.driftVerdict === 'SYNCHRONIZED' ? 'SUCCESS' : d.driftVerdict === 'DRIFTED' ? 'FAILED' : 'PENDING'}`}>{d.driftVerdict}</span></td></tr>
                <tr><td>Devices</td><td>{d.devices.length}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="k">Customers — INSPECT for 3-pane state view (§4.5)</div><br />
      <table>
        <thead><tr><th>Number</th><th>Type</th><th>Status</th><th>Phone</th><th>Package</th><th>Expiry</th><th></th></tr></thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.customerNumber}</td>
              <td>{c.accountType}</td>
              <td><span className={`pill ${c.status}`}>{c.status}</span></td>
              <td>{c.phone ?? '—'}</td>
              <td>{c.activeSubscription?.packageName ?? '—'}</td>
              <td>{c.activeSubscription?.expiryTime ? new Date(c.activeSubscription.expiryTime).toLocaleDateString() : '—'}</td>
              <td>
                <button className="ghost" onClick={() => void call(async () => {
                  setDetail(await api<CustomerDetail>(`/api/v1/admin/customers/${c.id}`));
                })}>INSPECT</button>
              </td>
            </tr>
          ))}
          {customers.length === 0 && <tr><td colSpan={7} className="sub">none</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Packages({ call, setToast }: { call: CallFn; setToast: (t: string) => void }) {
  const [packages, setPackages] = useState<PackagesResponse['data']>([]);
  const [form, setForm] = useState({ name: '', priceMinor: '', durationSeconds: '', downloadKbps: '', uploadKbps: '', fupLimitBytes: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback((): void => {
    void call(async () => {
      setPackages((await api<PackagesResponse>('/api/v1/admin/packages')).data);
    });
  }, [call]);
  useEffect(load, [load]);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      await api('/api/v1/admin/packages', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          priceMinor: Number(form.priceMinor),
          durationSeconds: Number(form.durationSeconds),
          policy: {
            downloadKbps: Number(form.downloadKbps),
            uploadKbps: Number(form.uploadKbps),
            ...(form.fupLimitBytes.length > 0 ? { fupLimitBytes: form.fupLimitBytes } : {}),
          },
        }),
      });
      setToast('Package created.');
      setForm({ name: '', priceMinor: '', durationSeconds: '', downloadKbps: '', uploadKbps: '', fupLimitBytes: '' });
      load();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid c2">
      <div className="card">
        <div className="k">Packages (edits version — history immutable, §4.2)</div><br />
        <table>
          <thead><tr><th>Name</th><th>v</th><th>Status</th><th>Price</th><th>Speed</th><th></th></tr></thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>v{p.version}</td>
                <td><span className={`pill ${p.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING'}`}>{p.status}</span></td>
                <td>{fmtKes(p.priceMinor)}</td>
                <td>{p.policy ? `${p.policy.downloadKbps}/${p.policy.uploadKbps}k` : '—'}</td>
                <td>{p.status === 'ACTIVE' && (
                  <button className="ghost" onClick={() => void api(`/api/v1/admin/packages/${p.id}`, { method: 'DELETE' }).then(() => { setToast('Retired.'); load(); })}>RETIRE</button>
                )}</td>
              </tr>
            ))}
            {packages.length === 0 && <tr><td colSpan={6} className="sub">none</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="k">Create package</div><br />
        <input placeholder="name (e.g. Month Pass)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="price minor units (50000 = KES 500)" value={form.priceMinor} onChange={(e) => setForm({ ...form, priceMinor: e.target.value })} />
        <input placeholder="duration seconds (2592000 = 30d)" value={form.durationSeconds} onChange={(e) => setForm({ ...form, durationSeconds: e.target.value })} />
        <input placeholder="download kbps" value={form.downloadKbps} onChange={(e) => setForm({ ...form, downloadKbps: e.target.value })} />
        <input placeholder="upload kbps" value={form.uploadKbps} onChange={(e) => setForm({ ...form, uploadKbps: e.target.value })} />
        <input placeholder="FUP limit bytes (optional)" value={form.fupLimitBytes} onChange={(e) => setForm({ ...form, fupLimitBytes: e.target.value })} />
        <button disabled={busy} onClick={create}>CREATE</button>
      </div>
    </div>
  );
}

function Users({ call, setToast }: { call: CallFn; setToast: (t: string) => void }) {
  const [users, setUsers] = useState<UsersResponse['data']>([]);
  const [roles, setRoles] = useState<RolesResponse['data']>([]);
  const [form, setForm] = useState({ email: '', password: '', displayName: '', role: 'SUPPORT_AGENT' });

  const load = useCallback((): void => {
    void call(async () => {
      const [u, r] = await Promise.all([
        api<UsersResponse>('/api/v1/admin/users'),
        api<RolesResponse>('/api/v1/admin/roles'),
      ]);
      setUsers(u.data);
      setRoles(r.data);
    });
  }, [call]);
  useEffect(load, [load]);

  const assignRole = async (userId: string, role: string): Promise<void> => {
    try {
      await api(`/api/v1/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      setToast(`Role → ${role}; live sessions revoked.`);
      load();
    } catch (e) {
      setToast((e as Error).message);
    }
  };

  return (
    <div className="grid c2">
      <div className="card">
        <div className="k">Staff users (role changes revoke sessions — §4.3)</div><br />
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>
                  <select
                    value={u.role}
                    onChange={(e) => void assignRole(u.id, e.target.value)}
                    style={{ width: 'auto', padding: 4, marginBottom: 0 }}
                  >
                    {roles.map((r) => <option key={r.name}>{r.name}</option>)}
                  </select>
                </td>
                <td><span className={`pill ${u.status}`}>{u.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="k">Create staff user</div><br />
        <input placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input type="password" placeholder="password (min 10)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <input placeholder="display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {roles.map((r) => <option key={r.name}>{r.name}</option>)}
        </select>
        <button onClick={() => void api('/api/v1/admin/users', { method: 'POST', body: JSON.stringify(form) }).then(() => { setToast('User created.'); load(); }).catch((e: Error) => setToast(e.message))}>
          CREATE
        </button>
      </div>
    </div>
  );
}

function Ops({ call, retryOp, setToast }: { call: CallFn; retryOp: (id: string) => Promise<void>; setToast: (t: string) => void }) {
  const [sessions, setSessions] = useState<SessionsResponse['data']>([]);
  const [ops, setOps] = useState<OpsResponse['data']>([]);

  const load = useCallback((): void => {
    void call(async () => {
      const [s, o] = await Promise.all([
        api<SessionsResponse>('/api/v1/admin/sessions'),
        api<OpsResponse>('/api/v1/admin/network-operations?limit=25'),
      ]);
      setSessions(s.data);
      setOps(o.data);
    });
  }, [call]);
  useEffect(load, [load]);

  return (
    <div className="grid c2">
      <div className="card">
        <div className="k">Live sessions</div><br />
        <table>
          <thead><tr><th>Customer</th><th>MAC</th><th>Status</th><th>↓/↑</th><th></th></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.customer}</td><td className="mono">{s.macAddress}</td>
                <td><span className={`pill ${s.status}`}>{s.status}</span></td>
                <td>{s.downloadBytes}/{s.uploadBytes}</td>
                <td><button className="ghost" onClick={() => void api(`/api/v1/admin/sessions/${s.id}/disconnect`, { method: 'POST' }).then(() => { setToast('Disconnect queued.'); load(); })}>DISCONNECT</button></td>
              </tr>
            ))}
            {sessions.length === 0 && <tr><td colSpan={5} className="sub">no active sessions</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="k">Network operations</div><br />
        <table>
          <thead><tr><th>Type</th><th>Status</th><th>Att.</th><th>Router</th><th></th></tr></thead>
          <tbody>
            {ops.map((o) => (
              <tr key={o.id}>
                <td>{o.type}</td><td><span className={`pill ${o.status}`}>{o.status}</span></td>
                <td>{o.attempts}</td><td>{o.router}</td>
                <td>{o.status === 'PERMANENT_FAILURE' && <button className="ghost" onClick={() => void retryOp(o.id)}>RETRY</button>}</td>
              </tr>
            ))}
            {ops.length === 0 && <tr><td colSpan={5} className="sub">queue empty</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Triggers({ call, setToast }: { call: CallFn; setToast: (t: string) => void }) {
  const [config, setConfig] = useState<{ provider: string; daraja: { configured: boolean; environment: string; callbackUrl: string | null } } | null>(null);

  useEffect(() => {
    void call(async () => {
      setConfig(await api('/api/v1/admin/payment-config'));
    });
  }, [call]);

  return (
    <div className="grid c2">
      <div className="card">
        <div className="k">Payment configuration (§4.1)</div><br />
        {config !== null ? (
          <table>
            <tbody>
              <tr><td>Provider</td><td className="mono">{config.provider}</td></tr>
              <tr><td>Daraja configured</td><td><span className={`pill ${config.daraja.configured ? 'ACTIVE' : 'PENDING'}`}>{String(config.daraja.configured)}</span></td></tr>
              <tr><td>Daraja env</td><td>{config.daraja.environment}</td></tr>
              <tr><td>Callback URL</td><td className="mono">{config.daraja.callbackUrl ?? 'not set'}</td></tr>
            </tbody>
          </table>
        ) : 'LOADING…'}
        <p className="sub" style={{ marginTop: 8 }}>Secrets live in Railway Variables — this view reports presence only.</p>
        <button className="ghost" onClick={() => void api('/api/v1/admin/payment-config/reconcile', { method: 'POST' }).then(() => setToast('Payment reconciliation queued.')).catch((e: Error) => setToast(e.message))}>
          RUN PAYMENT RECONCILIATION
        </button>
      </div>
      <div className="card">
        <div className="k">Network reconciliation (§4.4)</div><br />
        <p className="sub">Detects desired-vs-actual drift across subscribers and queues repair operations with read-back verification.</p>
        <button className="ghost" onClick={() => void api('/api/v1/admin/network/reconcile', { method: 'POST' }).then(() => setToast('Network reconciliation queued.')).catch((e: Error) => setToast(e.message))}>
          RUN NETWORK RECONCILIATION
        </button>
      </div>
    </div>
  );
}
