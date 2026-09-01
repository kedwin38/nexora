'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { session } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    if (session.token('customer')) router.replace('/dashboard');
    else if (session.token('user')) router.replace('/admin');
    else router.replace('/auth/login');
  }, [router]);
  return (
    <main>
      <div className="card mono">ROUTING…</div>
    </main>
  );
}
