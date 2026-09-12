'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, session, fmtKes, getMe, can, isOwner, type Me, ApiCallError } from '@/lib/api';

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

type Tab = 'overview' | 'customers' | 'packages' | 'users' | 'ops' | 'billing' | 'settings' | 'triggers';

// Each tab is visible only if the signed-in staff member holds the permission.
const TAB_PERMS: Array<[Tab, string, string]> = [
  ['overview', 'OVERVIEW', 'monitoring.read'],
  ['customers', 'CUSTOMERS', 'customer.read'],
  ['packages', 'PACKAGES', 'package.read'],
  ['ops', 'NETWORK', 'network_operation.read'],
  ['users', 'STAFF', 'user.read'],
  ['billing', 'BILLING', 'payment.config.manage'],
  ['settings', 'SETTINGS', 'tenant.manage'],
  ['triggers', 'TRIGGERS', 'monitoring.read'],
];

export default function AdminPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tabs, setTabs] = useState<Array<[Tab, string]>>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [toast, setToast] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);

  useEffect(() => {
    void (async () => {
      if (session.token('user') === null) {
        window.location.href = '/auth/login';
        return;
      }
      const identity = await getMe();
      if (identity === null) {
        window.location.href = '/auth/login';
        return;
      }
      if (isOwner(identity)) {
        window.location.href = '/owner';
        return;
      }
      setMe(identity);
      const visible: Array<[Tab, string]> = [];
      for (const [t, label, perm] of TAB_PERMS) {
        // Triggers exposes two independent operational actions — show it if the
        // caller can run either reconciliation.
        if (t === 'triggers') {
          if (can(identity, 'payment.reconciliation.run') || can(identity, 'router.manage')) visible.push([t, label]);
        } else if (can(identity, perm)) {
          visible.push([t, label]);
        }
      }
      setTabs(visible);
      if (visible.length > 0 && !visible.some(([t]) => t === 'overview')) setTab(visible[0][0]);
    })();
  }, []);

  const has = useCallback((p: string) => me?.permissions.includes(p) ?? false, [me]);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3500);
  }, []);

  // Gentle error handler: only a 401 ends the session; a 403 on one widget
  // (a role that lacks one sub-permission) just surfaces a toast.
  const call = useCallback(async <T,>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      const err = e as ApiCallError;
      if (err?.status === 401) {
        session.signOut();
        window.location.href = '/auth/login';
      } else {
        flash(err?.message ?? 'Request failed');
      }
      return null;
    }
  }, [flash]);

  const retryOp = async (id: string): Promise<void> => {
    await api(`/api/v1/admin/network-operations/${id}/retry`, { method: 'POST' });
    flash('Operation re-queued.');
  };

  if (me === null) return <main><div className="card mono">AUTHORIZING…</div></main>;

  return (
    <main>
      <h1>ADMIN — {me.tenant.name}</h1>
      <div className="sub">// {me.user.role} · business state · desired state · actual state · audit</div>
      {toast !== null && <div className="toast mono">{toast}</div>}
      <div className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setDetail(null); }}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview call={call} has={has} />}
      {tab === 'customers' && <Customers call={call} detail={detail} setDetail={setDetail} />}
      {tab === 'packages' && <Packages call={call} flash={flash} has={has} />}
      {tab === 'users' && <Users call={call} flash={flash} />}
      {tab === 'ops' && <Ops call={call} retryOp={retryOp} flash={flash} />}
      {tab === 'billing' && <Billing call={call} flash={flash} />}
      {tab === 'settings' && <Settings call={call} flash={flash} />}
      {tab === 'triggers' && <Triggers call={call} flash={flash} has={has} />}
    </main>
  );
}

type CallFn = <T,>(run: () => Promise<T>) => Promise<T | null>;
type Flash = (m: string) => void;
type Has = (p: string) => boolean;

function Overview({ call, has }: { call: CallFn; has: Has }) {
  const [summary, setSummary] = useState<Summary['summary'] | null>(null);
  const [payments, setPayments] = useState<PaymentsResponse['data']>([]);
  const [ops, setOps] = useState<OpsResponse['data']>([]);
  const showPayments = has('payment.read');
  const showOps = has('network_operation.read');

  useEffect(() => {
    void call(async () => {
      const s = await api<Summary>('/api/v1/admin/summary');
      setSummary(s.summary);
    });
    // Payments/ops widgets are separately permissioned — only fetch what this
    // role may read, so a NETWORK_ADMIN or ANALYST sees no spurious errors.
    if (showPayments) void call(async () => setPayments((await api<PaymentsResponse>('/api/v1/admin/payments?limit=12')).data));
    if (showOps) void call(async () => setOps((await api<OpsResponse>('/api/v1/admin/network-operations?limit=12')).data));
    const poll = setInterval(() => void call(async () => {
      setSummary((await api<Summary>('/api/v1/admin/summary')).summary);
    }), 15_000);
    return () => clearInterval(poll);
  }, [call, showPayments, showOps]);

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
        {showPayments && (
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
        )}
        {showOps && (
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
        )}
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
      <div className="k">Customers — INSPECT for 3-pane state view</div><br />
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

function Packages({ call, flash, has }: { call: CallFn; flash: Flash; has: Has }) {
  const [packages, setPackages] = useState<PackagesResponse['data']>([]);
  const [form, setForm] = useState({ name: '', priceMinor: '', durationSeconds: '', downloadKbps: '', uploadKbps: '', fupLimitBytes: '' });
  const [busy, setBusy] = useState(false);
  const canWrite = has('package.write');

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
      flash('Package created.');
      setForm({ name: '', priceMinor: '', durationSeconds: '', downloadKbps: '', uploadKbps: '', fupLimitBytes: '' });
      load();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid c2">
      <div className="card">
        <div className="k">Packages (edits version — history immutable)</div><br />
        <table>
          <thead><tr><th>Name</th><th>v</th><th>Status</th><th>Price</th><th>Speed</th><th></th></tr></thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>v{p.version}</td>
                <td><span className={`pill ${p.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING'}`}>{p.status}</span></td>
                <td>{fmtKes(p.priceMinor)}</td>
                <td>{p.policy ? `${p.policy.downloadKbps}/${p.policy.uploadKbps}k` : '—'}</td>
                <td>{canWrite && p.status === 'ACTIVE' && (
                  <button className="ghost" onClick={() => void call(async () => { await api(`/api/v1/admin/packages/${p.id}`, { method: 'DELETE' }); flash('Retired.'); load(); })}>RETIRE</button>
                )}</td>
              </tr>
            ))}
            {packages.length === 0 && <tr><td colSpan={6} className="sub">none</td></tr>}
          </tbody>
        </table>
      </div>
      {canWrite ? (
      <div className="card">
        <div className="k">Create package</div><br />
        <input placeholder="name (e.g. Month Pass)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="price minor units (50000 = KES 500)" value={form.priceMinor} onChange={(e) => setForm({ ...form, priceMinor: e.target.value })} />
        <input placeholder="duration seconds (2592000 = 30d)" value={form.durationSeconds} onChange={(e) => setForm({ ...form, durationSeconds: e.target.value })} />
        <input placeholder="download kbps" value={form.downloadKbps} onChange={(e) => setForm({ ...form, downloadKbps: e.target.value })} />
        <input placeholder="upload kbps" value={form.uploadKbps} onChange={(e) => setForm({ ...form, uploadKbps: e.target.value })} />
        <input placeholder="FUP limit bytes (optional)" value={form.fupLimitBytes} onChange={(e) => setForm({ ...form, fupLimitBytes: e.target.value })} />
        <button disabled={busy} onClick={() => void create()}>CREATE</button>
      </div>
      ) : (
        <div className="card muted"><div className="k">Read-only</div><p className="sub" style={{ marginTop: 8 }}>Your role can view the catalogue but not edit it.</p></div>
      )}
    </div>
  );
}

function Users({ call, flash }: { call: CallFn; flash: Flash }) {
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
      flash(`Role → ${role}; live sessions revoked.`);
      load();
    } catch (e) {
      flash((e as Error).message);
    }
  };

  return (
    <div className="grid c2">
      <div className="card">
        <div className="k">Staff users (role changes revoke sessions)</div><br />
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} onChange={(e) => void assignRole(u.id, e.target.value)} style={{ width: 'auto', padding: 4, marginBottom: 0 }}>
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
        <button onClick={() => void call(async () => { await api('/api/v1/admin/users', { method: 'POST', body: JSON.stringify(form) }); flash('User created.'); load(); })}>
          CREATE
        </button>
      </div>
    </div>
  );
}

function Ops({ call, retryOp, flash }: { call: CallFn; retryOp: (id: string) => Promise<void>; flash: Flash }) {
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
                <td><button className="ghost" onClick={() => void call(async () => { await api(`/api/v1/admin/sessions/${s.id}/disconnect`, { method: 'POST' }); flash('Disconnect queued.'); load(); })}>DISCONNECT</button></td>
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

// ---- Billing: the company's OWN platform subscription (ISP pays NEXORA) ---

interface BillingResponse {
  plan: { code: string; name: string; priceMinor: number; interval: string } | null;
  planStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  invoices: Array<{ id: string; number: string; plan: string | null; amountMinor: number; status: string; dueDate: string; periodEnd: string; paidAt: string | null; paymentInFlight: boolean }>;
}

function Billing({ call, flash }: { call: CallFn; flash: Flash }) {
  const [data, setData] = useState<BillingResponse | null>(null);

  const load = useCallback((): void => {
    void call(async () => setData(await api<BillingResponse>('/api/v1/admin/billing')));
  }, [call]);
  useEffect(load, [load]);

  const pay = async (id: string): Promise<void> => {
    const phone = window.prompt('M-Pesa phone number to charge (e.g. 0712345678):');
    if (phone === null || phone.trim() === '') return;
    try {
      await api(`/api/v1/admin/billing/invoices/${id}/pay`, { method: 'POST', body: JSON.stringify({ phone }) });
      flash('STK push sent — approve on your phone.');
      setTimeout(load, 4000);
    } catch (e) {
      flash((e as Error).message);
    }
  };

  if (data === null) return <div className="card mono">LOADING…</div>;

  return (
    <div className="grid c2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="k">Your NEXORA subscription</div><br />
        <table><tbody>
          <tr><td>Plan</td><td>{data.plan ? `${data.plan.name} · ${fmtKes(data.plan.priceMinor)}/${data.plan.interval.toLowerCase()}` : 'none assigned'}</td></tr>
          <tr><td>Status</td><td><span className={`pill ${data.planStatus === 'ACTIVE' || data.planStatus === 'TRIALING' ? 'ACTIVE' : data.planStatus === 'PAST_DUE' ? 'FAILED' : 'PENDING'}`}>{data.planStatus}</span></td></tr>
          <tr><td>Trial ends</td><td>{data.trialEndsAt ? new Date(data.trialEndsAt).toLocaleDateString() : '—'}</td></tr>
          <tr><td>Period ends</td><td>{data.currentPeriodEnd ? new Date(data.currentPeriodEnd).toLocaleDateString() : '—'}</td></tr>
        </tbody></table>
        <p className="sub" style={{ marginTop: 10, lineHeight: 1.5 }}>Pay an outstanding invoice by STK push to the NEXORA platform. Your own customer billing is configured under Settings.</p>
      </div>
      <div className="card">
        <div className="k">Invoices</div><br />
        <table>
          <thead><tr><th>Number</th><th>Period</th><th>Amount</th><th>Due</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data.invoices.map((i) => (
              <tr key={i.id}>
                <td className="mono">{i.number}</td>
                <td>{i.periodEnd ? new Date(i.periodEnd).toLocaleDateString() : '—'}</td>
                <td>{fmtKes(i.amountMinor)}</td>
                <td>{new Date(i.dueDate).toLocaleDateString()}</td>
                <td><span className={`pill ${i.status}`}>{i.status}</span></td>
                <td>{(i.status === 'PENDING' || i.status === 'OVERDUE')
                  ? (i.paymentInFlight ? <span className="sub">paying…</span> : <button className="ghost" onClick={() => void pay(i.id)}>PAY</button>)
                  : (i.paidAt ? new Date(i.paidAt).toLocaleDateString() : '')}</td>
              </tr>
            ))}
            {data.invoices.length === 0 && <tr><td colSpan={6} className="sub">no invoices yet — you may be on a free trial</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Settings: the company's OWN M-Pesa config + profile ------------------

interface TenantConfig {
  tenant: { name: string; slug: string; status: string; contactEmail: string | null; contactPhone: string | null; supportPhone: string | null; supportEmail: string | null };
  payment: { channel: string | null; environment: string | null; shortcode: string | null; partyB: string | null; credentialsConfigured: boolean; encryptionAvailable: boolean };
}

function Settings({ call, flash }: { call: CallFn; flash: Flash }) {
  const [cfg, setCfg] = useState<TenantConfig | null>(null);
  const [pay, setPay] = useState({ channel: 'PAYBILL', env: 'sandbox', shortcode: '', partyB: '', consumerKey: '', consumerSecret: '', passkey: '' });
  const [profile, setProfile] = useState({ name: '', supportPhone: '', supportEmail: '' });

  const load = useCallback((): void => {
    void call(async () => {
      const r = await api<TenantConfig>('/api/v1/admin/tenant');
      setCfg(r);
      setPay((p) => ({ ...p, channel: r.payment.channel ?? 'PAYBILL', env: r.payment.environment ?? 'sandbox', shortcode: r.payment.shortcode ?? '', partyB: r.payment.partyB ?? '' }));
      setProfile({ name: r.tenant.name, supportPhone: r.tenant.supportPhone ?? '', supportEmail: r.tenant.supportEmail ?? '' });
    });
  }, [call]);
  useEffect(load, [load]);

  const saveMpesa = async (): Promise<void> => {
    try {
      const body: Record<string, string> = { channel: pay.channel, env: pay.env, shortcode: pay.shortcode };
      if (pay.partyB) body.partyB = pay.partyB;
      if (pay.consumerKey) body.consumerKey = pay.consumerKey;
      if (pay.consumerSecret) body.consumerSecret = pay.consumerSecret;
      if (pay.passkey) body.passkey = pay.passkey;
      await api('/api/v1/admin/tenant/payment-config', { method: 'PUT', body: JSON.stringify(body) });
      flash('M-Pesa configuration saved.');
      setPay((p) => ({ ...p, consumerKey: '', consumerSecret: '', passkey: '' }));
      load();
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const saveProfile = async (): Promise<void> => {
    try {
      await api('/api/v1/admin/tenant', { method: 'PATCH', body: JSON.stringify({ name: profile.name, supportPhone: profile.supportPhone, supportEmail: profile.supportEmail }) });
      flash('Company profile saved.');
    } catch (e) {
      flash((e as Error).message);
    }
  };

  if (cfg === null) return <div className="card mono">LOADING…</div>;

  return (
    <div className="grid c2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="k">M-Pesa — how you collect from YOUR customers</div><br />
        <table><tbody>
          <tr><td>Credentials</td><td><span className={`pill ${cfg.payment.credentialsConfigured ? 'SUCCESS' : 'PENDING'}`}>{cfg.payment.credentialsConfigured ? 'configured' : 'not set'}</span></td></tr>
          <tr><td>Encryption</td><td><span className={`pill ${cfg.payment.encryptionAvailable ? 'SUCCESS' : 'FAILED'}`}>{cfg.payment.encryptionAvailable ? 'available' : 'KEY MISSING'}</span></td></tr>
        </tbody></table>
        <br />
        <label className="f">Channel</label>
        <select value={pay.channel} onChange={(e) => setPay({ ...pay, channel: e.target.value })}>
          <option value="PAYBILL">PAYBILL</option><option value="TILL">TILL (Buy Goods)</option>
        </select>
        <label className="f">Environment</label>
        <select value={pay.env} onChange={(e) => setPay({ ...pay, env: e.target.value })}>
          <option value="sandbox">sandbox</option><option value="production">production</option>
        </select>
        <label className="f">Shortcode / store</label>
        <input value={pay.shortcode} onChange={(e) => setPay({ ...pay, shortcode: e.target.value })} />
        <label className="f">Till / Party B (optional)</label>
        <input value={pay.partyB} onChange={(e) => setPay({ ...pay, partyB: e.target.value })} />
        <label className="f">Consumer key (blank = keep)</label>
        <input type="password" value={pay.consumerKey} onChange={(e) => setPay({ ...pay, consumerKey: e.target.value })} />
        <label className="f">Consumer secret</label>
        <input type="password" value={pay.consumerSecret} onChange={(e) => setPay({ ...pay, consumerSecret: e.target.value })} />
        <label className="f">Passkey</label>
        <input type="password" value={pay.passkey} onChange={(e) => setPay({ ...pay, passkey: e.target.value })} />
        <button onClick={() => void saveMpesa()}>SAVE M-PESA</button>
      </div>
      <div className="card">
        <div className="k">Company profile</div><br />
        <label className="f">Company name</label>
        <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
        <label className="f">Support phone</label>
        <input value={profile.supportPhone} onChange={(e) => setProfile({ ...profile, supportPhone: e.target.value })} />
        <label className="f">Support email</label>
        <input value={profile.supportEmail} onChange={(e) => setProfile({ ...profile, supportEmail: e.target.value })} />
        <button onClick={() => void saveProfile()}>SAVE PROFILE</button>
        <p className="sub" style={{ marginTop: 12, lineHeight: 1.5 }}>Handle <span className="mono">{cfg.tenant.slug}</span> · status <span className={`pill ${cfg.tenant.status}`}>{cfg.tenant.status}</span></p>
      </div>
    </div>
  );
}

function Triggers({ call, flash, has }: { call: CallFn; flash: Flash; has: Has }) {
  return (
    <div className="grid c2">
      {has('payment.reconciliation.run') && (
        <div className="card">
          <div className="k">Payment reconciliation</div><br />
          <p className="sub" style={{ lineHeight: 1.5 }}>Sweeps in-flight payments to a terminal state (SUCCESS / CANCELLED / EXPIRED) so nothing hangs.</p>
          <button className="ghost" onClick={() => void call(async () => { await api('/api/v1/admin/payment-config/reconcile', { method: 'POST' }); flash('Payment reconciliation queued.'); })}>
            RUN PAYMENT RECONCILIATION
          </button>
        </div>
      )}
      {has('router.manage') && (
        <div className="card">
          <div className="k">Network reconciliation</div><br />
          <p className="sub" style={{ lineHeight: 1.5 }}>Detects desired-vs-actual drift across subscribers and queues repair operations with read-back verification.</p>
          <button className="ghost" onClick={() => void call(async () => { await api('/api/v1/admin/network/reconcile', { method: 'POST' }); flash('Network reconciliation queued.'); })}>
            RUN NETWORK RECONCILIATION
          </button>
        </div>
      )}
    </div>
  );
}
