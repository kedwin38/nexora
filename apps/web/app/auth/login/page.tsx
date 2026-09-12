'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, session, clearMe, ApiCallError } from '@/lib/api';

interface LoginResponse {
  token: string;
  user: { role: string };
}

type Mode = 'staff' | 'customer' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // staff
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // customer
  const [cPhone, setCPhone] = useState('');
  const [cPassword, setCPassword] = useState('');
  // company signup
  const [co, setCo] = useState({ companyName: '', adminName: '', adminEmail: '', adminPassword: '' });

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  const staffLogin = () => run(async () => {
    const r = await api<LoginResponse>('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    session.signIn('user', r.token);
    clearMe();
    router.push(r.user.role === 'PLATFORM_OWNER' ? '/owner' : '/admin');
  });

  const customerLogin = () => run(async () => {
    const r = await api<LoginResponse>('/api/v1/customers/login', { method: 'POST', body: JSON.stringify({ phone: cPhone, password: cPassword }) });
    session.signIn('customer', r.token);
    router.push('/dashboard');
  });

  const customerRegister = () => run(async () => {
    const r = await api<LoginResponse>('/api/v1/customers/register', { method: 'POST', body: JSON.stringify({ phone: cPhone, password: cPassword }) });
    session.signIn('customer', r.token);
    router.push('/dashboard');
  });

  const companySignup = () => run(async () => {
    const r = await api<LoginResponse>('/api/v1/tenants/signup', { method: 'POST', body: JSON.stringify(co) });
    session.signIn('user', r.token);
    clearMe();
    router.push('/admin');
  });

  return (
    <main>
      <h1>ACCESS</h1>
      <div className="sub">// authenticate to the NEXORA control plane</div>
      {error !== null && <div className="toast err mono">{error}</div>}

      <div className="tabs">
        <button className={mode === 'staff' ? 'active' : ''} onClick={() => setMode('staff')}>OPERATOR / STAFF</button>
        <button className={mode === 'customer' ? 'active' : ''} onClick={() => setMode('customer')}>CUSTOMER</button>
        <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>CREATE YOUR ISP</button>
      </div>

      {mode === 'staff' && (
        <div className="card" style={{ maxWidth: 460 }}>
          <div className="k">Operator / staff sign-in</div><br />
          <input placeholder="admin@nexora.isp" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button disabled={busy} onClick={staffLogin}>AUTHENTICATE</button>
          <p className="sub" style={{ marginTop: 10 }}>Company admins, billing/network staff, and the platform owner sign in here.</p>
        </div>
      )}

      {mode === 'customer' && (
        <div className="card" style={{ maxWidth: 460 }}>
          <div className="k">Customer</div><br />
          <input placeholder="0712345678" value={cPhone} onChange={(e) => setCPhone(e.target.value)} />
          <input type="password" placeholder="password (min 8 chars)" value={cPassword} onChange={(e) => setCPassword(e.target.value)} />
          <button disabled={busy} onClick={customerLogin}>SIGN IN</button>
          <button className="ghost" disabled={busy} onClick={customerRegister} style={{ width: '100%', marginTop: 8 }}>CREATE ACCOUNT</button>
          <p className="sub" style={{ marginTop: 10 }}>Phone-number identity · <Link href="/packages">browse packages</Link></p>
        </div>
      )}

      {mode === 'signup' && (
        <div className="card" style={{ maxWidth: 460 }}>
          <div className="k">Launch your ISP on NEXORA</div><br />
          <input placeholder="company name (e.g. Acme Networks)" value={co.companyName} onChange={(e) => setCo({ ...co, companyName: e.target.value })} />
          <input placeholder="your name" value={co.adminName} onChange={(e) => setCo({ ...co, adminName: e.target.value })} />
          <input placeholder="admin email" value={co.adminEmail} onChange={(e) => setCo({ ...co, adminEmail: e.target.value })} />
          <input type="password" placeholder="admin password (min 10 chars)" value={co.adminPassword} onChange={(e) => setCo({ ...co, adminPassword: e.target.value })} />
          <button disabled={busy} onClick={companySignup}>CREATE COMPANY</button>
          <p className="sub" style={{ marginTop: 10 }}>You become SUPER_ADMIN with a starter catalogue and a 14-day free trial. Configure M-Pesa under Admin → Settings.</p>
        </div>
      )}
    </main>
  );
}
