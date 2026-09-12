// NEXORA portal — company admin console (role-aware). Depends on globals from index.html.

views.admin = async (tab) => {
  if (!store.get('user_token')) { toast('Operator login required', true); return location.href = '/auth/login'; }
  if (!ME) await loadMe();
  if (isOwner()) return location.href = '/owner';

  // Role-gated tabs.
  const all = [
    ['overview', 'Overview', 'monitoring.read'],
    ['customers', 'Customers', 'customer.read'],
    ['packages', 'Packages', 'package.read'],
    ['ops', 'Network', 'network_operation.read'],
    ['users', 'Staff', 'user.read'],
    ['billing', 'Billing', 'tenant.read'],
    ['settings', 'Settings', 'tenant.manage'],
    ['triggers', 'Automation', 'monitoring.read'],
  ];
  const tabs = all.filter(([, , perm]) => can(perm));
  if (tabs.length === 0) { $('#view').innerHTML = `<div class="card">Your role has no console access. Contact your admin.</div>`; return; }
  tab = tab && tabs.some(t => t[0] === tab) ? tab : (views.admin._tab && tabs.some(t => t[0] === views.admin._tab) ? views.admin._tab : tabs[0][0]);
  views.admin._tab = tab;

  $('#view').innerHTML = `<h1>${esc(ME.tenant ? ME.tenant.name : 'Admin')} <span class="dim" style="font-size:13px">console</span></h1>
    <div class="sub">// ${esc(ME.user.role)} · business · desired · actual · audit</div>
    <div class="tabs" id="tabs">${tabs.map(([id, label]) => `<button class="${id === tab ? 'active' : ''}" data-t="${id}">${label}</button>`).join('')}</div>
    <div id="body"><div class="card mono dim">LOADING…</div></div>`;
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => views.admin(b.dataset.t));
  const body = $('#body');
  const R = { overview: admOverview, customers: admCustomers, packages: admPackages, ops: admOps, users: admUsers, billing: admBilling, settings: admSettings, triggers: admTriggers };
  await R[tab](body);
};

async function admOverview(body) {
  const [sum, pays, ops] = await Promise.all([
    tget('/api/v1/admin/summary'), tget('/api/v1/admin/payments?limit=10'), tget('/api/v1/admin/network-operations?limit=10'),
  ]);
  const s = sum?.summary || {};
  body.innerHTML = `<div class="grid c4">
    <div class="card"><div class="k">Customers</div><div class="v">${s.customers ?? '—'}</div></div>
    <div class="card"><div class="k">Active subscriptions</div><div class="v ok">${s.activeSubscriptions ?? '—'}</div></div>
    <div class="card"><div class="k">Revenue</div><div class="v acc">${s.revenueMinor != null ? fmtKes(s.revenueMinor) : '—'}</div></div>
    <div class="card"><div class="k">Pending / unresolved pay</div><div class="v sm ${s.unresolvedPayments ? 'warn' : ''}">${s.pendingPayments ?? 0} / ${s.unresolvedPayments ?? 0}</div></div>
  </div><br/>
  <div class="grid c2">
    <div class="card"><div class="k">Recent payments</div><br><table><tr><th>Status</th><th>Amount</th><th>Package</th><th>When</th></tr>
      ${(pays?.data || []).map(p => `<tr><td>${pill(p.status)}</td><td>${fmtKes(p.amountMinor)}</td><td>${esc(p.package?.name || '—')}</td><td>${fmtWhen(p.createdAt)}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">no payments yet</td></tr>'}</table></div>
    <div class="card"><div class="k">Network operations</div><br><table><tr><th>Type</th><th>Status</th><th>Att.</th><th>Router</th></tr>
      ${(ops?.data || []).map(o => `<tr><td>${esc(o.type)}</td><td>${pill(o.status)}</td><td>${esc(o.attempts)}</td><td>${esc(o.router)}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">queue empty</td></tr>'}</table></div>
  </div>`;
}

async function admCustomers(body) {
  const cs = await api('/api/v1/admin/customers?limit=50');
  body.innerHTML = `<div class="card"><div class="k">Customers — click INSPECT for the 3-pane view</div><br>
    <table><tr><th>Number</th><th>Type</th><th>Status</th><th>Phone</th><th>Package</th><th>Expiry</th><th></th></tr>
    ${cs.data.map(c => `<tr><td>${esc(c.customerNumber)}</td><td>${esc(c.accountType)}</td><td>${pill(c.status)}</td><td>${esc(c.phone || '—')}</td><td>${esc(c.activeSubscription?.packageName || '—')}</td><td>${c.activeSubscription?.expiryTime ? fmtWhen(c.activeSubscription.expiryTime) : '—'}</td><td><button class="ghost mini" data-c="${c.id}">INSPECT</button></td></tr>`).join('') || '<tr><td colspan="7" class="dim">none</td></tr>'}
    </table></div><div id="detail"></div>`;
  body.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
    const d = await api('/api/v1/admin/customers/' + b.dataset.c); const dv = d.desiredNetworkState, ac = d.actualNetworkState, biz = d.business;
    $('#detail').innerHTML = `<br><div class="grid c3">
      <div class="card"><div class="k">Business state</div><br><table>
        <tr><td>Subscription</td><td>${pill(biz.subscription?.status || 'NONE')}</td></tr>
        <tr><td>Package</td><td>${esc(biz.subscription?.packageName || '—')}</td></tr>
        <tr><td>FUP</td><td>${biz.subscription?.fup ? pill(biz.subscription.fup.state) + ' ' + gb(biz.subscription.fup.usedBytes) + '/' + gb(biz.subscription.fup.limitBytes) : '—'}</td></tr>
        <tr><td>Payments</td><td>${biz.payments.length}</td></tr></table></div>
      <div class="card"><div class="k">Desired network state</div><br><table>
        <tr><td>Version</td><td>v${dv?.version ?? '—'}</td></tr>
        <tr><td>Authorized</td><td>${dv?.state?.authorized ?? '—'}</td></tr>
        <tr><td>Rate</td><td>${dv?.state?.rateLimit ? dv.state.rateLimit.downloadKbps + 'k/' + dv.state.rateLimit.uploadKbps + 'k' : '—'}</td></tr>
        <tr><td>Synced</td><td>${dv?.synchronizedAt ? fmtWhen(dv.synchronizedAt) : 'never'}</td></tr></table></div>
      <div class="card"><div class="k">Actual network state</div><br><table>
        <tr><td>Last op</td><td>${ac ? esc(ac.lastOperation.type) + ' ' + pill(ac.lastOperation.status) : '—'}</td></tr>
        <tr><td>Drift</td><td>${pill(d.driftVerdict === 'SYNCHRONIZED' ? 'SUCCESS' : d.driftVerdict === 'DRIFTED' ? 'FAILED' : 'PENDING')}</td></tr>
        <tr><td>Devices</td><td>${d.devices.length}</td></tr></table></div></div>`;
  });
}

async function admPackages(body) {
  const pkgs = await api('/api/v1/admin/packages'); const w = can('package.write');
  body.innerHTML = `<div class="grid c2">
    <div class="card"><div class="k">Packages (edits create new versions)</div><br>
      <table><tr><th>Name</th><th>v</th><th>Status</th><th>Price</th><th>Speed</th><th></th></tr>
      ${pkgs.data.map(p => `<tr><td>${esc(p.name)}</td><td>v${p.version}</td><td>${pill(p.status)}</td><td>${fmtKes(p.priceMinor)}</td><td>${p.policy ? p.policy.downloadKbps + '/' + p.policy.uploadKbps + 'k' : '—'}</td><td>${w && p.status === 'ACTIVE' ? '<button class="danger mini" data-r="' + p.id + '">RETIRE</button>' : ''}</td></tr>`).join('')}
      </table></div>
    ${w ? `<div class="card"><div class="k">Create package</div>
      <label class="f">Name</label><input id="np-name" placeholder="Month Pass" />
      <div class="grid c2" style="gap:8px"><div><label class="f">Price (minor, e.g. 50000)</label><input id="np-price" /></div><div><label class="f">Duration (seconds)</label><input id="np-dur" placeholder="2592000" /></div></div>
      <div class="grid c2" style="gap:8px"><div><label class="f">Download kbps</label><input id="np-down" placeholder="10240" /></div><div><label class="f">Upload kbps</label><input id="np-up" placeholder="5120" /></div></div>
      <label class="f">FUP limit bytes (optional)</label><input id="np-fup" placeholder="53687091200" />
      <button class="wide" id="np-go">CREATE</button></div>` : '<div class="muted-card">You do not have package-write permission.</div>'}</div>`;
  if (w) {
    body.querySelector('#np-go').onclick = async () => {
      try { await api('/api/v1/admin/packages', { method: 'POST', body: JSON.stringify({ name: $('#np-name').value, priceMinor: Number($('#np-price').value), durationSeconds: Number($('#np-dur').value), policy: { downloadKbps: Number($('#np-down').value), uploadKbps: Number($('#np-up').value), ...($('#np-fup').value ? { fupLimitBytes: $('#np-fup').value } : {}) } }) }); toast('Package created.'); views.admin('packages'); } catch (e) { toast(e.message, true); } };
    body.querySelectorAll('[data-r]').forEach(b => b.onclick = async () => { try { await api('/api/v1/admin/packages/' + b.dataset.r, { method: 'DELETE' }); toast('Retired.'); views.admin('packages'); } catch (e) { toast(e.message, true); } });
  }
}

async function admOps(body) {
  const [sessions, ops] = await Promise.all([tget('/api/v1/admin/sessions'), tget('/api/v1/admin/network-operations?limit=25')]);
  const disc = can('session.disconnect'), retry = can('network_operation.retry');
  body.innerHTML = `<div class="grid c2">
    <div class="card"><div class="k">Live sessions</div><br><table><tr><th>Customer</th><th>MAC</th><th>Status</th><th>↓/↑</th><th></th></tr>
      ${(sessions?.data || []).map(s => `<tr><td>${esc(s.customer)}</td><td>${esc(s.macAddress)}</td><td>${pill(s.status)}</td><td>${gb(s.downloadBytes)}/${gb(s.uploadBytes)}</td><td>${disc ? '<button class="danger mini" data-d="' + s.id + '">DISCONNECT</button>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">no active sessions</td></tr>'}</table></div>
    <div class="card"><div class="k">Network operations</div><br><table><tr><th>Type</th><th>Status</th><th>Att.</th><th>Router</th><th></th></tr>
      ${(ops?.data || []).map(o => `<tr><td>${esc(o.type)}</td><td>${pill(o.status)}</td><td>${esc(o.attempts)}</td><td>${esc(o.router)}</td><td>${retry && o.status === 'PERMANENT_FAILURE' ? '<button class="ghost mini" data-y="' + o.id + '">RETRY</button>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">queue empty</td></tr>'}</table></div></div>`;
  body.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { try { await api('/api/v1/admin/sessions/' + b.dataset.d + '/disconnect', { method: 'POST' }); toast('Disconnect queued.'); views.admin('ops'); } catch (e) { toast(e.message, true); } });
  body.querySelectorAll('[data-y]').forEach(b => b.onclick = async () => { try { await api('/api/v1/admin/network-operations/' + b.dataset.y + '/retry', { method: 'POST' }); toast('Re-queued.'); views.admin('ops'); } catch (e) { toast(e.message, true); } });
}

async function admUsers(body) {
  const [users, roles] = await Promise.all([api('/api/v1/admin/users'), api('/api/v1/admin/roles')]);
  const roleNames = roles.data.map(r => r.name).filter(n => n !== 'PLATFORM_OWNER'); const w = can('user.write');
  body.innerHTML = `<div class="grid c2">
    <div class="card"><div class="k">Staff</div><br><table><tr><th>Email</th><th>Role</th><th>Status</th><th>Last login</th></tr>
      ${users.data.map(u => `<tr><td>${esc(u.email)}</td><td>${w ? `<select data-u="${u.id}">${roleNames.map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(u.role)}</td><td>${pill(u.status)}</td><td>${u.lastLoginAt ? fmtWhen(u.lastLoginAt) : '—'}</td></tr>`).join('')}</table></div>
    ${w ? `<div class="card"><div class="k">Add staff</div>
      <label class="f">Email</label><input id="nu-email" /><label class="f">Password (min 10)</label><input id="nu-pass" type="password" />
      <label class="f">Display name</label><input id="nu-name" /><label class="f">Role</label><select id="nu-role">${roleNames.map(r => `<option>${r}</option>`).join('')}</select>
      <button class="wide" id="nu-go">CREATE</button><p class="sub" style="margin-top:8px">Role changes revoke live sessions. All audited.</p></div>` : '<div class="muted-card">You cannot manage staff.</div>'}</div>`;
  if (w) {
    body.querySelectorAll('select[data-u]').forEach(s => s.onchange = async () => { try { await api('/api/v1/admin/users/' + s.dataset.u, { method: 'PATCH', body: JSON.stringify({ role: s.value }) }); toast('Role updated + sessions revoked.'); } catch (e) { toast(e.message, true); } });
    body.querySelector('#nu-go').onclick = async () => { try { await api('/api/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: $('#nu-email').value, password: $('#nu-pass').value, displayName: $('#nu-name').value, role: $('#nu-role').value }) }); toast('Staff created.'); views.admin('users'); } catch (e) { toast(e.message, true); } };
  }
}

async function admBilling(body) {
  const b = await api('/api/v1/admin/billing');
  const owed = b.invoices.filter(i => i.status === 'PENDING' || i.status === 'OVERDUE');
  body.innerHTML = `<div class="grid c3">
    <div class="card"><div class="k">Your plan</div><div class="v sm acc">${esc(b.plan?.name || 'No plan')}</div><div class="stat-sub">${b.plan ? fmtKes(b.plan.priceMinor) + ' / ' + b.plan.interval.toLowerCase() : 'Ask the platform owner to assign one'}</div></div>
    <div class="card"><div class="k">Standing</div><div class="v sm">${pill(b.planStatus)}</div><div class="stat-sub">${b.trialEndsAt && b.planStatus === 'TRIALING' ? 'Trial ends ' + fmtDate(b.trialEndsAt) : b.currentPeriodEnd ? 'Renews ' + fmtDate(b.currentPeriodEnd) : ''}</div></div>
    <div class="card"><div class="k">Outstanding</div><div class="v sm ${owed.length ? 'warn' : 'ok'}">${owed.length}</div><div class="stat-sub">${owed.length ? 'invoice(s) to pay' : 'all settled'}</div></div>
  </div><br/>
  <div class="card"><div class="k">Platform invoices (you → NEXORA)</div><br>
    <table><tr><th>Number</th><th>Period end</th><th>Amount</th><th>Due</th><th>Status</th><th></th></tr>
    ${b.invoices.map(i => `<tr><td>${esc(i.number)}</td><td>${fmtDate(i.periodEnd)}</td><td>${fmtKes(i.amountMinor)}</td><td>${fmtDate(i.dueDate)}</td><td>${pill(i.status)}</td><td>${(i.status === 'PENDING' || i.status === 'OVERDUE') && can('payment.config.manage') ? (i.paymentInFlight ? '<span class="dim">paying…</span>' : '<button class="ghost mini" data-pay="' + i.id + '">PAY</button>') : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">no invoices yet — you may be on a free trial</td></tr>'}
    </table></div>`;
  body.querySelectorAll('[data-pay]').forEach(btn => btn.onclick = async () => {
    const phone = prompt('M-Pesa phone to pay from (07…):'); if (!phone) return;
    try { await api('/api/v1/admin/billing/invoices/' + btn.dataset.pay + '/pay', { method: 'POST', body: JSON.stringify({ phone }) }); toast('STK sent — approve on your phone.'); setTimeout(() => views.admin('billing'), 4000); } catch (e) { toast(e.message, true); }
  });
}

async function admSettings(body) {
  const t = await api('/api/v1/admin/tenant'); const ten = t.tenant, pay = t.payment;
  body.innerHTML = `<div class="grid c2">
    <div class="card"><div class="k">Company profile</div><br><table>
      <tr><td>Name</td><td>${esc(ten.name)}</td></tr><tr><td>Handle</td><td>${esc(ten.slug)}</td></tr>
      <tr><td>Status</td><td>${pill(ten.status)}</td></tr><tr><td>Country</td><td>${esc(ten.country)}</td></tr></table>
      <label class="f">Support phone</label><input id="t-sp" value="${esc(ten.supportPhone || '')}" />
      <label class="f">Support email</label><input id="t-se" value="${esc(ten.supportEmail || '')}" />
      <label class="f">Brand colour (#hex)</label><input id="t-col" value="${esc(ten.primaryColor || '')}" />
      <button class="wide ghost" id="t-save" style="margin-top:10px">SAVE PROFILE</button></div>
    <div class="card"><div class="k">M-Pesa collection (your customers → you)</div><br><table>
      <tr><td>Channel</td><td>${pill(pay.channel)}</td></tr>
      <tr><td>Credentials</td><td>${pay.credentialsConfigured ? pill('SUCCESS') : pill('PENDING')}</td></tr>
      <tr><td>Encryption</td><td>${pay.encryptionAvailable ? pill('SUCCESS') : pill('FAILED')}</td></tr></table>
      <label class="f">Channel</label><select id="pm-ch"><option value="PAYBILL" ${pay.channel === 'PAYBILL' ? 'selected' : ''}>PAYBILL (Pay Bill)</option><option value="TILL" ${pay.channel === 'TILL' ? 'selected' : ''}>TILL (Buy Goods)</option></select>
      <label class="f">Environment</label><select id="pm-env"><option value="sandbox" ${pay.environment !== 'production' ? 'selected' : ''}>sandbox</option><option value="production" ${pay.environment === 'production' ? 'selected' : ''}>production</option></select>
      <div class="grid c2" style="gap:8px"><div><label class="f">Shortcode / store</label><input id="pm-sc" value="${esc(pay.shortcode || '')}" /></div><div><label class="f">Till number (Buy Goods)</label><input id="pm-pb" value="${esc(pay.partyB || '')}" /></div></div>
      <label class="f">Consumer key <span class="dim">(blank = keep)</span></label><input id="pm-ck" type="password" />
      <label class="f">Consumer secret</label><input id="pm-cs" type="password" />
      <label class="f">Passkey</label><input id="pm-pk" type="password" />
      <button class="wide" id="pm-save" style="margin-top:8px">SAVE M-PESA CONFIG</button>
      <p class="sub" style="margin-top:8px">Credentials are encrypted at rest &amp; never shown back.</p></div></div>`;
  body.querySelector('#t-save').onclick = async () => { try { await api('/api/v1/admin/tenant', { method: 'PATCH', body: JSON.stringify({ supportPhone: $('#t-sp').value || undefined, supportEmail: $('#t-se').value || undefined, primaryColor: $('#t-col').value || undefined }) }); toast('Profile saved.'); } catch (e) { toast(e.message, true); } };
  body.querySelector('#pm-save').onclick = async () => {
    try { const p = { channel: $('#pm-ch').value, env: $('#pm-env').value, shortcode: $('#pm-sc').value };
      if ($('#pm-pb').value) p.partyB = $('#pm-pb').value; if ($('#pm-ck').value) p.consumerKey = $('#pm-ck').value; if ($('#pm-cs').value) p.consumerSecret = $('#pm-cs').value; if ($('#pm-pk').value) p.passkey = $('#pm-pk').value;
      await api('/api/v1/admin/tenant/payment-config', { method: 'PUT', body: JSON.stringify(p) }); toast('M-Pesa configuration saved.'); views.admin('settings'); } catch (e) { toast(e.message, true); } };
}

async function admTriggers(body) {
  const pc = await tget('/api/v1/admin/payment-config');
  body.innerHTML = `<div class="grid c2">
    <div class="card"><div class="k">Automation status</div><br><table>
      <tr><td>Provider</td><td>${esc(pc?.provider || '—')}</td></tr>
      <tr><td>Platform Daraja</td><td>${pc?.daraja?.configured ? pill('SUCCESS') : pill('PENDING')}</td></tr>
      <tr><td>Reconciliation</td><td>${pill('every 2m')}</td></tr>
      <tr><td>FUP / expiry / usage</td><td>${pill('scheduled')}</td></tr></table>
      ${can('payment.reconciliation.run') ? '<button class="ghost wide" id="t-pay" style="margin-top:10px">RUN PAYMENT RECONCILIATION</button>' : ''}</div>
    <div class="card"><div class="k">Network reconciliation</div><br><p class="sub">Detects desired-vs-actual drift and queues verified repairs.</p>
      ${can('router.manage') ? '<button class="ghost wide" id="t-net" style="margin-top:10px">RUN NETWORK RECONCILIATION</button>' : ''}</div></div>`;
  const p = body.querySelector('#t-pay'); if (p) p.onclick = async () => { try { await api('/api/v1/admin/payment-config/reconcile', { method: 'POST' }); toast('Payment reconciliation queued.'); } catch (e) { toast(e.message, true); } };
  const n = body.querySelector('#t-net'); if (n) n.onclick = async () => { try { await api('/api/v1/admin/network/reconcile', { method: 'POST' }); toast('Network reconciliation queued.'); } catch (e) { toast(e.message, true); } };
}
