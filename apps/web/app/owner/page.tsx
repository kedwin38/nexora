'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, getMe, isOwner, session, fmtKes, fmtDate, fmtWhen, ApiCallError } from '@/lib/api';

/** Platform-owner console: the owner sits above every company. */

type Tab = 'analytics' | 'companies' | 'plans' | 'invoices' | 'payments' | 'insights';
const TABS: Array<[Tab, string]> = [
  ['analytics', 'ANALYTICS'],
  ['companies', 'COMPANIES'],
  ['plans', 'PLANS'],
  ['invoices', 'INVOICES'],
  ['payments', 'PAYMENTS'],
  ['insights', 'AI MONITOR'],
];

export default function OwnerPage() {
  const [tab, setTab] = useState<Tab>('analytics');
  const [toast, setToast] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      if (session.token('user') === null) {
        window.location.href = '/auth/login';
        return;
      }
      const me = await getMe();
      if (!isOwner(me)) {
        window.location.href = '/admin';
        return;
      }
      setReady(true);
    })();
  }, []);

  const flash = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3500);
  }, []);

  if (!ready) return <main><div className="card mono">AUTHORIZING…</div></main>;

  return (
    <main>
      <h1>PLATFORM OWNER</h1>
      <div className="sub">// govern every company · revenue · billing · operations intelligence</div>
      {toast !== null && <div className="toast mono">{toast}</div>}
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      {tab === 'analytics' && <Analytics flash={flash} />}
      {tab === 'companies' && <Companies flash={flash} />}
      {tab === 'plans' && <Plans flash={flash} />}
      {tab === 'invoices' && <Invoices flash={flash} />}
      {tab === 'payments' && <Payments flash={flash} />}
      {tab === 'insights' && <Insights flash={flash} />}
    </main>
  );
}

type Flash = (m: string) => void;

function handle(e: unknown, flash: Flash): void {
  const err = e as ApiCallError;
  if (err?.status === 401) {
    session.signOut();
    window.location.href = '/auth/login';
    return;
  }
  flash(err?.message ?? 'Request failed');
}

// ---- Analytics -----------------------------------------------------------

interface Analytics {
  tenants: number; newTenants30d: number; customers: number; staff: number; activeSubscriptions: number;
  gmvMinor: number; platformRevenueMinor: number; platformPendingMinor: number; mrrMinor: number;
  planBreakdown: Array<{ status: string; count: number }>;
  revenueSeries: Array<{ date: string; amountMinor: number }>;
  topIsps: Array<{ tenantId: string; name: string; slug: string; revenueMinor: number; payments: number }>;
}
interface Health { outboxDead: number; jobsFailed: number; routersOffline: number; liveSessions: number }

function Bars({ series }: { series: Array<{ date: string; amountMinor: number }> }) {
  const max = Math.max(1, ...series.map((p) => p.amountMinor));
  return (
    <div className="bars">
      {series.map((p) => (
        <div key={p.date} className="bar" title={`${p.date}: ${fmtKes(p.amountMinor)}`}>
          <div className="fill" style={{ height: `${Math.max(2, (p.amountMinor / max) * 100)}%` }} />
          <span className="lbl">{p.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function Analytics({ flash }: { flash: Flash }) {
  const [a, setA] = useState<Analytics | null>(null);
  const [h, setH] = useState<Health | null>(null);
  const [openAlerts, setOpenAlerts] = useState<{ total: number; critical: number }>({ total: 0, critical: 0 });

  useEffect(() => {
    void (async () => {
      try {
        const [an, health, ins] = await Promise.all([
          api<{ analytics: Analytics }>('/api/v1/platform/analytics'),
          api<{ health: Health }>('/api/v1/platform/health'),
          api<{ data: Array<{ severity: string }> }>('/api/v1/platform/insights?status=OPEN'),
        ]);
        setA(an.analytics);
        setH(health.health);
        setOpenAlerts({ total: ins.data.length, critical: ins.data.filter((i) => i.severity === 'CRITICAL').length });
      } catch (e) { handle(e, flash); }
    })();
  }, [flash]);

  if (a === null) return <div className="card mono">LOADING…</div>;
  const attention = (h?.outboxDead ?? 0) > 0 || (h?.jobsFailed ?? 0) > 0;

  return (
    <>
      <div className="grid c4">
        <div className="card"><div className="k">Companies (ISPs)</div><div className="v acc">{a.tenants}</div><div className="stat-sub">+{a.newTenants30d} in 30d</div></div>
        <div className="card"><div className="k">Platform MRR</div><div className="v ok">{fmtKes(a.mrrMinor)}</div><div className="stat-sub">recurring / month</div></div>
        <div className="card"><div className="k">Platform revenue</div><div className="v">{fmtKes(a.platformRevenueMinor)}</div><div className="stat-sub">{fmtKes(a.platformPendingMinor)} pending</div></div>
        <div className="card"><div className="k">Total GMV</div><div className="v">{fmtKes(a.gmvMinor)}</div><div className="stat-sub">all ISP collections</div></div>
        <div className="card"><div className="k">Registered users</div><div className="v">{a.customers}</div><div className="stat-sub">{a.staff} staff accounts</div></div>
        <div className="card"><div className="k">Active subscriptions</div><div className="v ok">{a.activeSubscriptions}</div></div>
        <div className="card"><div className="k">System health</div><div className={`v ${attention ? 'crit' : 'ok'}`}>{attention ? 'ATTENTION' : 'HEALTHY'}</div><div className="stat-sub">{h?.routersOffline ?? 0} routers offline</div></div>
        <div className="card"><div className="k">Open alerts</div><div className={`v ${openAlerts.critical > 0 ? 'crit' : ''}`}>{openAlerts.total}</div><div className="stat-sub">{openAlerts.critical} critical</div></div>
      </div>
      <br />
      <div className="grid c2">
        <div className="card"><div className="k">ISP collections — last 14 days</div><br /><Bars series={a.revenueSeries} /></div>
        <div className="card"><div className="k">Plan standing</div><br />
          <table><thead><tr><th>Standing</th><th>Companies</th></tr></thead><tbody>
            {a.planBreakdown.map((p) => <tr key={p.status}><td><span className={`pill ${p.status}`}>{p.status}</span></td><td>{p.count}</td></tr>)}
            {a.planBreakdown.length === 0 && <tr><td colSpan={2} className="sub">no plans assigned</td></tr>}
          </tbody></table>
        </div>
      </div>
      <br />
      <div className="card"><div className="k">Top ISPs by revenue</div><br />
        <table><thead><tr><th>Company</th><th>Handle</th><th>Payments</th><th>Revenue</th></tr></thead><tbody>
          {a.topIsps.map((t) => <tr key={t.tenantId}><td>{t.name}</td><td className="sub">{t.slug}</td><td>{t.payments}</td><td className="acc">{fmtKes(t.revenueMinor)}</td></tr>)}
          {a.topIsps.length === 0 && <tr><td colSpan={4} className="sub">no revenue yet</td></tr>}
        </tbody></table>
      </div>
    </>
  );
}

// ---- Companies -----------------------------------------------------------

interface Company { id: string; slug: string; name: string; status: string; mpesaConfigured: boolean; mpesaChannel: string | null; customers: number; activeSubscriptions: number; revenueMinor: number }
interface Plan { id: string; code: string; name: string; description: string | null; priceMinor: number; currency: string; interval: string; trialDays: number; features: string[]; active: boolean; subscribers: number }

function Companies({ flash }: { flash: Flash }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({ companyName: '', adminName: '', adminEmail: '', adminPassword: '', planId: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void (async () => {
      try {
        const [t, p] = await Promise.all([
          api<{ data: Company[] }>('/api/v1/platform/tenants'),
          api<{ data: Plan[] }>('/api/v1/platform/plans'),
        ]);
        setCompanies(t.data);
        setPlans(p.data);
      } catch (e) { handle(e, flash); }
    })();
  }, [flash]);
  useEffect(load, [load]);

  const setStatus = async (id: string, status: string) => {
    try { await api(`/api/v1/platform/tenants/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); flash(`Company ${status}.`); load(); } catch (e) { handle(e, flash); }
  };
  const assignPlan = async (id: string, planId: string) => {
    if (planId === '') return;
    try { await api(`/api/v1/platform/tenants/${id}/plan`, { method: 'PUT', body: JSON.stringify({ planId }) }); flash('Plan assigned (trial started).'); load(); } catch (e) { handle(e, flash); }
  };
  const createCompany = async () => {
    if (form.companyName.trim() === '' || form.adminEmail.trim() === '' || form.adminPassword.length < 10) {
      flash('Company name, admin email, and a 10+ char password are required.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/v1/platform/tenants', { method: 'POST', body: JSON.stringify({
        companyName: form.companyName, adminName: form.adminName || form.companyName, adminEmail: form.adminEmail,
        adminPassword: form.adminPassword, ...(form.planId ? { planId: form.planId } : {}),
      }) });
      flash('Company created — admin can now sign in.');
      setForm({ companyName: '', adminName: '', adminEmail: '', adminPassword: '', planId: '' });
      load();
    } catch (e) { handle(e, flash); } finally { setBusy(false); }
  };
  const reserved = (slug: string) => slug === 'default' || slug === 'platform';

  return (
    <>
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="k">Onboard a new ISP</div><br />
      <div className="grid c3">
        <input placeholder="company name" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
        <input placeholder="admin name" value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} />
        <input placeholder="admin email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
        <input type="password" placeholder="admin password (min 10)" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} />
        <select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
          <option value="">— no plan (assign later) —</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({fmtKes(p.priceMinor)})</option>)}
        </select>
        <button disabled={busy} onClick={() => void createCompany()}>CREATE COMPANY</button>
      </div>
      <p className="sub" style={{ marginTop: 8 }}>Creates the company, its first SUPER_ADMIN, and a starter catalogue. Works regardless of public-signup settings.</p>
    </div>
    <div className="card">
      <div className="k">All companies on NEXORA</div><br />
      <table>
        <thead><tr><th>Company</th><th>Status</th><th>M-Pesa</th><th>Customers</th><th>Active</th><th>Revenue</th><th>Plan</th><th>Actions</th></tr></thead>
        <tbody>
          {companies.map((c) => (
            <tr key={c.id}>
              <td>{c.name}<br /><span className="sub">{c.slug}</span></td>
              <td><span className={`pill ${c.status}`}>{c.status}</span></td>
              <td>{c.mpesaConfigured ? <span className="pill SUCCESS">{c.mpesaChannel}</span> : <span className="pill PENDING">none</span>}</td>
              <td>{c.customers}</td><td>{c.activeSubscriptions}</td><td className="acc">{fmtKes(c.revenueMinor)}</td>
              <td>{reserved(c.slug) ? <span className="sub">—</span> : (
                <select defaultValue="" onChange={(e) => void assignPlan(c.id, e.target.value)} style={{ width: 'auto', padding: 4, marginBottom: 0 }}>
                  <option value="">— assign —</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({fmtKes(p.priceMinor)})</option>)}
                </select>
              )}</td>
              <td>{reserved(c.slug) ? <span className="sub">reserved</span> : (
                c.status === 'SUSPENDED'
                  ? <button className="ghost" onClick={() => void setStatus(c.id, 'ACTIVE')}>ACTIVATE</button>
                  : <button className="ghost" onClick={() => void setStatus(c.id, 'SUSPENDED')}>SUSPEND</button>
              )}</td>
            </tr>
          ))}
          {companies.length === 0 && <tr><td colSpan={8} className="sub">no companies</td></tr>}
        </tbody>
      </table>
    </div>
    </>
  );
}

// ---- Plans ---------------------------------------------------------------

function Plans({ flash }: { flash: Flash }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({ code: '', name: '', priceMinor: '', trialDays: '14', features: '' });

  const load = useCallback(() => {
    void (async () => {
      try { setPlans((await api<{ data: Plan[] }>('/api/v1/platform/plans')).data); } catch (e) { handle(e, flash); }
    })();
  }, [flash]);
  useEffect(load, [load]);

  const create = async () => {
    try {
      await api('/api/v1/platform/plans', { method: 'POST', body: JSON.stringify({
        code: form.code, name: form.name, priceMinor: Number(form.priceMinor),
        trialDays: Number(form.trialDays) || 14,
        features: form.features.split('\n').map((s) => s.trim()).filter(Boolean),
      }) });
      flash('Plan created.');
      setForm({ code: '', name: '', priceMinor: '', trialDays: '14', features: '' });
      load();
    } catch (e) { handle(e, flash); }
  };
  const editPrice = async (p: Plan) => {
    const price = window.prompt('New monthly price (minor units, e.g. 250000 = KES 2500):', String(p.priceMinor));
    if (price === null) return;
    try { await api(`/api/v1/platform/plans/${p.id}`, { method: 'PATCH', body: JSON.stringify({ priceMinor: Number(price), active: !p.active }) }); flash('Plan updated.'); load(); } catch (e) { handle(e, flash); }
  };

  return (
    <div className="grid c3">
      {plans.map((p) => (
        <div key={p.id} className="plan">
          <div className="plan-head"><span className="name">{p.name}</span><span className={`pill ${p.active ? 'ACTIVE' : 'PENDING'}`}>{p.active ? 'ACTIVE' : 'DRAFT'}</span></div>
          <div className="price">{fmtKes(p.priceMinor)}<small>/{p.interval.toLowerCase()}</small></div>
          <div className="stat-sub">{p.subscribers} subscriber(s) · {p.trialDays}d trial</div>
          <ul className="feat">{p.features.map((f, i) => <li key={i}>{f}</li>)}</ul>
          <button className="ghost" style={{ marginTop: 10 }} onClick={() => void editPrice(p)}>{p.active ? 'RETIRE' : 'ACTIVATE'} / EDIT PRICE</button>
        </div>
      ))}
      <div className="card">
        <div className="k">New plan</div><br />
        <input placeholder="code (e.g. enterprise)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        <input placeholder="name (e.g. Enterprise)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="price minor / month (500000)" value={form.priceMinor} onChange={(e) => setForm({ ...form, priceMinor: e.target.value })} />
        <input placeholder="trial days" value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
        <textarea placeholder="features (one per line)" value={form.features} rows={3} onChange={(e) => setForm({ ...form, features: e.target.value })} />
        <button onClick={() => void create()}>CREATE PLAN</button>
      </div>
    </div>
  );
}

// ---- Invoices ------------------------------------------------------------

interface OwnerInvoice { id: string; number: string; company: string; plan: string | null; amountMinor: number; status: string; periodStart: string; periodEnd: string; dueDate: string; paidAt: string | null }

function Invoices({ flash }: { flash: Flash }) {
  const [invoices, setInvoices] = useState<OwnerInvoice[]>([]);

  const load = useCallback(() => {
    void (async () => {
      try { setInvoices((await api<{ data: OwnerInvoice[] }>('/api/v1/platform/invoices?limit=50')).data); } catch (e) { handle(e, flash); }
    })();
  }, [flash]);
  useEffect(load, [load]);

  const runBilling = async () => {
    try { const r = await api<{ invoicesIssued: number; markedOverdue: number }>('/api/v1/platform/billing/run', { method: 'POST' }); flash(`Billing: ${r.invoicesIssued} issued, ${r.markedOverdue} overdue.`); load(); } catch (e) { handle(e, flash); }
  };

  return (
    <>
      <div className="row"><div className="k">Platform invoices (ISPs → you)</div><div className="spacer" /><button className="ghost" onClick={() => void runBilling()}>RUN BILLING NOW</button></div>
      <div className="card">
        <table>
          <thead><tr><th>Number</th><th>Company</th><th>Plan</th><th>Amount</th><th>Period</th><th>Due</th><th>Status</th><th>Paid</th></tr></thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td className="mono">{i.number}</td><td>{i.company}</td><td>{i.plan ?? '—'}</td><td>{fmtKes(i.amountMinor)}</td>
                <td>{fmtDate(i.periodStart)}→{fmtDate(i.periodEnd)}</td><td>{fmtDate(i.dueDate)}</td>
                <td><span className={`pill ${i.status}`}>{i.status}</span></td><td>{i.paidAt ? fmtDate(i.paidAt) : '—'}</td>
              </tr>
            ))}
            {invoices.length === 0 && <tr><td colSpan={8} className="sub">no invoices yet — assign plans to companies</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Payments (owner Daraja config) --------------------------------------

interface PayCfg { channel: string | null; environment: string | null; shortcode: string | null; partyB: string | null; credentialsConfigured: boolean; encryptionAvailable: boolean }

function Payments({ flash }: { flash: Flash }) {
  const [cfg, setCfg] = useState<PayCfg | null>(null);
  const [form, setForm] = useState({ channel: 'PAYBILL', env: 'sandbox', shortcode: '', partyB: '', consumerKey: '', consumerSecret: '', passkey: '' });

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ payment: PayCfg }>('/api/v1/platform/payment-config');
        setCfg(r.payment);
        setForm((f) => ({ ...f, channel: r.payment.channel ?? 'PAYBILL', env: r.payment.environment ?? 'sandbox', shortcode: r.payment.shortcode ?? '', partyB: r.payment.partyB ?? '' }));
      } catch (e) { handle(e, flash); }
    })();
  }, [flash]);

  const save = async () => {
    try {
      const body: Record<string, string> = { channel: form.channel, env: form.env, shortcode: form.shortcode };
      if (form.partyB) body.partyB = form.partyB;
      if (form.consumerKey) body.consumerKey = form.consumerKey;
      if (form.consumerSecret) body.consumerSecret = form.consumerSecret;
      if (form.passkey) body.passkey = form.passkey;
      await api('/api/v1/platform/payment-config', { method: 'PUT', body: JSON.stringify(body) });
      flash('Platform M-Pesa saved.');
      setForm((f) => ({ ...f, consumerKey: '', consumerSecret: '', passkey: '' }));
    } catch (e) { handle(e, flash); }
  };

  if (cfg === null) return <div className="card mono">LOADING…</div>;

  return (
    <div className="grid c2">
      <div className="card">
        <div className="k">Platform M-Pesa — ISPs pay their subscription here</div><br />
        <table><tbody>
          <tr><td>Channel</td><td><span className={`pill ${cfg.channel ?? 'PENDING'}`}>{cfg.channel ?? 'unset'}</span></td></tr>
          <tr><td>Credentials</td><td><span className={`pill ${cfg.credentialsConfigured ? 'SUCCESS' : 'PENDING'}`}>{cfg.credentialsConfigured ? 'configured' : 'not set'}</span></td></tr>
          <tr><td>Encryption</td><td><span className={`pill ${cfg.encryptionAvailable ? 'SUCCESS' : 'FAILED'}`}>{cfg.encryptionAvailable ? 'available' : 'KEY MISSING'}</span></td></tr>
        </tbody></table>
        <br />
        <label className="f">Channel</label>
        <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
          <option value="PAYBILL">PAYBILL</option><option value="TILL">TILL (Buy Goods)</option>
        </select>
        <label className="f">Environment</label>
        <select value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })}>
          <option value="sandbox">sandbox</option><option value="production">production</option>
        </select>
        <label className="f">Shortcode / store</label>
        <input value={form.shortcode} onChange={(e) => setForm({ ...form, shortcode: e.target.value })} />
        <label className="f">Till / Party B (optional)</label>
        <input value={form.partyB} onChange={(e) => setForm({ ...form, partyB: e.target.value })} />
        <label className="f">Consumer key (blank = keep)</label>
        <input type="password" value={form.consumerKey} onChange={(e) => setForm({ ...form, consumerKey: e.target.value })} />
        <label className="f">Consumer secret</label>
        <input type="password" value={form.consumerSecret} onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })} />
        <label className="f">Passkey</label>
        <input type="password" value={form.passkey} onChange={(e) => setForm({ ...form, passkey: e.target.value })} />
        <button onClick={() => void save()}>SAVE PLATFORM M-PESA</button>
      </div>
      <div className="card muted">
        <div className="k">About this</div>
        <p className="sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
          This is the owner&apos;s own Daraja account — the destination for every ISP&apos;s monthly subscription
          fee. It uses the exact same encrypted, abstracted flow the ISPs use for their own customers
          (AES-256-GCM at rest; secrets never shown back). Set <span className="mono">CREDENTIALS_ENCRYPTION_KEY</span> on
          the api service to enable credential storage.
        </p>
      </div>
    </div>
  );
}

// ---- AI Monitor insights -------------------------------------------------

interface Insight { id: string; code: string; severity: string; category: string; title: string; detail: string; company: string | null; status: string; createdAt: string }

function Insights({ flash }: { flash: Flash }) {
  const [insights, setInsights] = useState<Insight[]>([]);

  const load = useCallback(() => {
    void (async () => {
      try { setInsights((await api<{ data: Insight[] }>('/api/v1/platform/insights?status=OPEN')).data); } catch (e) { handle(e, flash); }
    })();
  }, [flash]);
  useEffect(load, [load]);

  const scan = async () => {
    try { const r = await api<{ insightsCreated: number }>('/api/v1/platform/monitor/run', { method: 'POST' }); flash(`Scan complete: ${r.insightsCreated} new finding(s).`); load(); } catch (e) { handle(e, flash); }
  };
  const ack = async (id: string) => {
    try { await api(`/api/v1/platform/insights/${id}/ack`, { method: 'POST' }); flash('Acknowledged.'); load(); } catch (e) { handle(e, flash); }
  };

  return (
    <>
      <div className="row"><div className="k">AI operations monitor — open findings</div><div className="spacer" /><button className="ghost" onClick={() => void scan()}>RUN SCAN NOW</button></div>
      {insights.length === 0 ? (
        <div className="card muted"><p className="sub" style={{ lineHeight: 1.6 }}>✓ No open findings. The monitor scans the estate every 15 minutes for payment-failure spikes, revenue drops, router outages, backlogs, stuck payments and past-due ISPs.</p></div>
      ) : (
        <div className="grid c2">
          {insights.map((i) => (
            <div key={i.id} className="card">
              <div className="row"><span className={`sev-dot sev-${i.severity}`} /><b>{i.title}</b><div className="spacer" /><span className={`pill ${i.severity === 'CRITICAL' ? 'FAILED' : i.severity === 'WARNING' ? 'PENDING' : 'SUCCESS'}`}>{i.severity}</span></div>
              <p className="sub" style={{ margin: '8px 0', lineHeight: 1.5 }}>{i.detail}</p>
              <div className="row"><span className="sub mono" style={{ fontSize: 10 }}>{i.category} · {i.code}{i.company ? ` · ${i.company}` : ''} · {fmtWhen(i.createdAt)}</span><div className="spacer" /><button className="ghost" onClick={() => void ack(i.id)}>ACKNOWLEDGE</button></div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
