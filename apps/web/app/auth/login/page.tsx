'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, session, ApiCallError } from '@/lib/api';

interface LoginResponse {
  token: string;
  user: { role: string };
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cPassword, setCPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staffLogin = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      session.signIn('user', result.token);
      router.push('/admin');
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const customerLogin = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<LoginResponse>('/api/v1/customers/login', {
        method: 'POST',
        body: JSON.stringify({ phone: cPhone, password: cPassword }),
      });
      session.signIn('customer', result.token);
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const customerRegister = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<LoginResponse>('/api/v1/customers/register', {
        method: 'POST',
        body: JSON.stringify({ phone: cPhone, password: cPassword }),
      });
      session.signIn('customer', result.token);
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>ACCESS</h1>
      <div className="sub">// authenticate to the NEXORA control plane</div>
      {error !== null && <div className="toast err mono">{error}</div>}
      <div className="grid c2">
        <div className="card">
          <div className="k">OPERATOR / STAFF</div>
          <br />
          <input placeholder="admin@nexora.isp" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button disabled={busy} onClick={staffLogin}>
            AUTHENTICATE
          </button>
          <p className="sub" style={{ marginTop: 10 }}>
            Seeded admin accounts only — see RAILWAY_SETUP.md.
          </p>
        </div>
        <div className="card">
          <div className="k">CUSTOMER</div>
          <br />
          <input placeholder="0712345678" value={cPhone} onChange={(e) => setCPhone(e.target.value)} />
          <input
            type="password"
            placeholder="password (min 8 chars)"
            value={cPassword}
            onChange={(e) => setCPassword(e.target.value)}
          />
          <button disabled={busy} onClick={customerLogin}>
            SIGN IN
          </button>
          <button className="ghost" disabled={busy} onClick={customerRegister} style={{ width: '100%', marginTop: 8 }}>
            CREATE ACCOUNT
          </button>
          <p className="sub" style={{ marginTop: 10 }}>
            Phone-number identity · <Link href="/packages">browse packages</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
