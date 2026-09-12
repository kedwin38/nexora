'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { session, getMe, isOwner } from '@/lib/api';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    void (async () => {
      if (session.token('customer') !== null && session.token('user') === null) {
        router.replace('/dashboard');
        return;
      }
      if (session.token('user') !== null) {
        const me = await getMe();
        router.replace(isOwner(me) ? '/owner' : '/admin');
        return;
      }
      router.replace('/auth/login');
    })();
  }, [router]);
  return (
    <main>
      <div className="card mono">ROUTING…</div>
    </main>
  );
}
