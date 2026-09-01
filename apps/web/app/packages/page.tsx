'use client';

import { useEffect, useState } from 'react';
import { api, session, fmtKes, ApiCallError } from '@/lib/api';

interface PackageItem {
  id: string;
  name: string;
  priceMinor: number;
  durationSeconds: number;
  maxDevices: number;
  speed: { downKbps: number; upKbps: number } | null;
}

interface InitiateResponse {
  paymentId: string;
  status: string;
}

interface PaymentStatus {
  payment: { status: string; failureReason: string | null };
}

export default function PackagesPage() {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [selected, setSelected] = useState<PackageItem | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session.token('customer') === null) {
      window.location.href = '/auth/login';
      return;
    }
    void api<{ data: PackageItem[] }>('/api/v1/packages').then((r) => setPackages(r.data));
  }, []);

  useEffect(() => {
    if (status === null || !status.includes('Polling')) return;
    const paymentId = localStorage.getItem('nexora_pending_payment');
    if (paymentId === null) return;
    const poll = setInterval(async () => {
      try {
        const result = await api<PaymentStatus>(`/api/v1/payments/${paymentId}`);
        if (result.payment.status === 'SUCCESS') {
          clearInterval(poll);
          setStatus('CONFIRMED — service active.');
          window.location.href = '/dashboard';
        }
        if (result.payment.status === 'FAILED') {
          clearInterval(poll);
          setStatus(`FAILED — ${result.payment.failureReason ?? 'try again'}`);
          setBusy(false);
        }
      } catch {
        // keep polling
      }
    }, 3000);
    return () => clearInterval(poll);
  }, [status]);

  const pay = async (): Promise<void> => {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    setStatus('Initiating M-Pesa STK push…');
    try {
      const result = await api<InitiateResponse>('/api/v1/payments/initiate', {
        method: 'POST',
        body: JSON.stringify({
          packageId: selected.id,
          ...(phone.length > 0 ? { phone } : {}),
          idempotencyKey: crypto.randomUUID(),
          macAddress: `02:00:${Math.floor(Math.random() * 0xffffff)
            .toString(16)
            .padStart(6, '0')
            .match(/.{2}/g)!
            .join(':')
            .toUpperCase()}`,
        }),
      });
      localStorage.setItem('nexora_pending_payment', result.paymentId);
      setStatus('STK push sent — check your phone. Polling…');
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : 'Payment failed');
      setStatus(null);
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>PACKAGES</h1>
      <div className="sub">// pay via M-Pesa STK push — service activates on confirmation</div>
      {error !== null && <div className="toast err mono">{error}</div>}
      <div className="grid c4">
        {packages.map((p) => (
          <div
            key={p.id}
            className={`pkg ${selected?.id === p.id ? 'sel' : ''}`}
            onClick={() => setSelected(p)}
          >
            <div className="mono">{p.name}</div>
            <div className="price">{fmtKes(p.priceMinor)}</div>
            <div className="meta">
              {p.durationSeconds / 3600}h · {p.speed ? `${p.speed.downKbps}k↓` : ''} · {p.maxDevices} dev
            </div>
          </div>
        ))}
        {packages.length === 0 && <div className="card mono">NO PACKAGES</div>}
      </div>
      <br />
      {selected !== null && (
        <div className="card">
          <div className="k">PAYMENT — {selected.name} · {fmtKes(selected.priceMinor)}</div>
          <br />
          <input placeholder="M-Pesa phone (optional — defaults to your number)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button disabled={busy} onClick={pay}>
            {busy ? 'PROCESSING…' : 'PAY NOW'}
          </button>
          {status !== null && <p className="sub mono" style={{ marginTop: 10 }}>{status}</p>}
        </div>
      )}
    </main>
  );
}
