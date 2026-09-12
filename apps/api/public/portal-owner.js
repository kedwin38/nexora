// NEXORA portal — platform OWNER console (elite) + setup guide. Depends on index.html globals.

views.owner = async (tab) => {
  if (!store.get('user_token')) { toast('Owner login required', true); return location.href = '/auth/login'; }
  if (!ME) await loadMe();
  if (!isOwner()) { toast('Platform owner access required.', true); return location.href = '/admin'; }
  const tabs = [['analytics', 'Analytics'], ['companies', 'Companies'], ['plans', 'Plans'], ['invoices', 'Invoices'], ['payments', 'Payments'], ['insights', 'AI Monitor']];
  tab = tab || views.owner._tab || 'analytics'; views.owner._tab = tab;
  $('#view').innerHTML = `<h1>Platform Owner <span class="dim" style="font-size:13px">console</span></h1>
    <div class="sub">// govern every company · revenue · billing · operations intelligence</div>
    <div class="tabs" id="otabs">${tabs.map(([id, l]) => `<button class="${id === tab ? 'active' : ''}" data-t="${id}">${l}</button>`).join('')}</div>
    <div id="obody"><div class="card mono dim">LOADING…</div></div>`;
  document.querySelectorAll('#otabs button').forEach(b => b.onclick = () => views.owner(b.dataset.t));
  const body = $('#obody');
  const R = { analytics: ownAnalytics, companies: ownCompanies, plans: ownPlans, invoices: ownInvoices, payments: ownPayments, insights: ownInsights };
  await R[tab](body);
};

async function ownAnalytics(body) {
  const [a, health, ins] = await Promise.all([api('/api/v1/platform/analytics'), tget('/api/v1/platform/health'), tget('/api/v1/platform/insights?status=OPEN')]);
  const an = a.analytics; const h = health?.health || {}; const openCrit = (ins?.data || []).filter(i => i.severity === 'CRITICAL').length;
  const series = an.revenueSeries.map(p => ({ label: p.date.slice(5), v: p.amountMinor }));
  body.innerHTML = `<div class="grid c4">
    <div class="card"><div class="k">Companies (ISPs)</div><div class="v acc">${an.tenants}</div><div class="stat-sub">+${an.newTenants30d} in 30d</div></div>
    <div class="card"><div class="k">Platform MRR</div><div class="v ok">${fmtKes(an.mrrMinor)}</div><div class="stat-sub">recurring / month</div></div>
    <div class="card"><div class="k">Platform revenue</div><div class="v">${fmtKes(an.platformRevenueMinor)}</div><div class="stat-sub">${fmtKes(an.platformPendingMinor)} pending</div></div>
    <div class="card"><div class="k">Total GMV</div><div class="v">${fmtKes(an.gmvMinor)}</div><div class="stat-sub">all ISP collections</div></div>
    <div class="card"><div class="k">Registered users</div><div class="v sm">${an.customers} <span class="dim" style="font-size:12px">customers</span></div><div class="stat-sub">${an.staff} staff accounts</div></div>
    <div class="card"><div class="k">Active subscriptions</div><div class="v sm ok">${an.activeSubscriptions}</div></div>
    <div class="card"><div class="k">System health</div><div class="v sm ${h.outboxDead || h.jobsFailed ? 'crit' : 'ok'}">${h.outboxDead || h.jobsFailed ? 'ATTENTION' : 'HEALTHY'}</div><div class="stat-sub">${h.routersOffline || 0} routers offline</div></div>
    <div class="card"><div class="k">Open alerts</div><div class="v sm ${openCrit ? 'crit' : ''}">${(ins?.data || []).length}</div><div class="stat-sub">${openCrit} critical</div></div>
  </div><br/>
  <div class="grid c2">
    <div class="card"><div class="k">ISP collections — last 14 days</div><br>${barChart(series, fmtKes)}</div>
    <div class="card"><div class="k">Plan standing</div><br><table><tr><th>Standing</th><th>Companies</th></tr>
      ${an.planBreakdown.map(p => `<tr><td>${pill(p.status)}</td><td>${p.count}</td></tr>`).join('') || '<tr><td colspan="2" class="dim">no plans assigned</td></tr>'}</table></div>
  </div><br/>
  <div class="card"><div class="k">Top ISPs by revenue</div><br><table><tr><th>Company</th><th>Handle</th><th>Payments</th><th>Revenue</th></tr>
    ${an.topIsps.map(t => `<tr><td>${esc(t.name)}</td><td class="dim">${esc(t.slug)}</td><td>${t.payments}</td><td class="acc">${fmtKes(t.revenueMinor)}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">no revenue yet</td></tr>'}</table></div>`;
}

async function ownCompanies(body) {
  const [t, plans] = await Promise.all([api('/api/v1/platform/tenants'), tget('/api/v1/platform/plans')]);
  const planOpts = (plans?.data || []).map(p => `<option value="${p.id}">${esc(p.name)} (${fmtKes(p.priceMinor)})</option>`).join('');
  body.innerHTML = `<div class="card"><div class="k">All companies on NEXORA</div><br>
    <table><tr><th>Company</th><th>Status</th><th>M-Pesa</th><th>Customers</th><th>Active</th><th>Revenue</th><th>Plan</th><th>Actions</th></tr>
    ${t.data.map(c => `<tr>
      <td>${esc(c.name)}<br><span class="dim">${esc(c.slug)}</span></td>
      <td>${pill(c.status)}</td>
      <td>${c.mpesaConfigured ? pill('SUCCESS') + ' ' + esc(c.mpesaChannel) : pill('PENDING')}</td>
      <td>${c.customers}</td><td>${c.activeSubscriptions}</td><td class="acc">${fmtKes(c.revenueMinor)}</td>
      <td>${c.slug === 'default' || c.slug === 'platform' ? '<span class="dim">—</span>' : `<select class="miniplan" data-id="${c.id}"><option value="">— assign plan —</option>${planOpts}</select>`}</td>
      <td>${c.slug === 'default' || c.slug === 'platform' ? '<span class="dim">reserved</span>' : (c.status === 'SUSPENDED' ? '<button class="ghost mini" data-act="ACTIVE" data-id="' + c.id + '">ACTIVATE</button>' : '<button class="danger mini" data-act="SUSPENDED" data-id="' + c.id + '">SUSPEND</button>')}</td>
    </tr>`).join('') || '<tr><td colspan="8" class="dim">no companies</td></tr>'}
    </table></div>`;
  body.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => { try { await api('/api/v1/platform/tenants/' + b.dataset.id, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.act }) }); toast('Company ' + b.dataset.act + '.'); views.owner('companies'); } catch (e) { toast(e.message, true); } });
  body.querySelectorAll('.miniplan').forEach(s => s.onchange = async () => { if (!s.value) return; try { await api('/api/v1/platform/tenants/' + s.dataset.id + '/plan', { method: 'PUT', body: JSON.stringify({ planId: s.value }) }); toast('Plan assigned (trial started).'); views.owner('companies'); } catch (e) { toast(e.message, true); } });
}

async function ownPlans(body) {
  const plans = await api('/api/v1/platform/plans');
  body.innerHTML = `<div class="grid c3" id="plancards">
    ${plans.data.map(p => `<div class="plan"><div class="row"><div class="name">${esc(p.name)}</div><div class="spacer"></div>${p.active ? pill('ACTIVE') : pill('DRAFT')}</div>
      <div class="price">${fmtKes(p.priceMinor)}<small>/${(p.interval || 'MONTHLY').toLowerCase()}</small></div>
      <div class="stat-sub">${p.subscribers} subscriber(s) · ${p.trialDays}d trial</div>
      <ul>${(p.features || []).map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      <button class="ghost mini" data-edit='${esc(JSON.stringify({ id: p.id, priceMinor: p.priceMinor, active: p.active }))}' style="margin-top:10px">${p.active ? 'RETIRE' : 'ACTIVATE'} / EDIT PRICE</button></div>`).join('')}
    <div class="card"><div class="k">New plan</div>
      <label class="f">Code</label><input id="pl-code" placeholder="enterprise" /><label class="f">Name</label><input id="pl-name" placeholder="Enterprise" />
      <label class="f">Price (minor / month)</label><input id="pl-price" placeholder="500000" /><label class="f">Trial days</label><input id="pl-trial" value="14" />
      <label class="f">Features (one per line)</label><textarea id="pl-feat" rows="3" placeholder="Unlimited routers&#10;Dedicated support"></textarea>
      <button class="wide" id="pl-go" style="margin-top:8px">CREATE PLAN</button></div></div>`;
  body.querySelector('#pl-go').onclick = async () => {
    try { await api('/api/v1/platform/plans', { method: 'POST', body: JSON.stringify({ code: $('#pl-code').value, name: $('#pl-name').value, priceMinor: Number($('#pl-price').value), trialDays: Number($('#pl-trial').value) || 14, features: $('#pl-feat').value.split('\n').map(s => s.trim()).filter(Boolean) }) }); toast('Plan created.'); views.owner('plans'); } catch (e) { toast(e.message, true); } };
  body.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => {
    const d = JSON.parse(b.dataset.edit); const price = prompt('New monthly price (minor units):', d.priceMinor); if (price === null) return;
    try { await api('/api/v1/platform/plans/' + d.id, { method: 'PATCH', body: JSON.stringify({ priceMinor: Number(price), active: !d.active }) }); toast('Plan updated.'); views.owner('plans'); } catch (e) { toast(e.message, true); } });
}

async function ownInvoices(body) {
  const inv = await api('/api/v1/platform/invoices?limit=50');
  body.innerHTML = `<div class="row" style="margin-bottom:12px"><div class="k">Platform invoices (ISPs → you)</div><div class="spacer"></div><button class="ghost mini" id="run-bill">RUN BILLING NOW</button></div>
    <div class="card"><table><tr><th>Number</th><th>Company</th><th>Plan</th><th>Amount</th><th>Period</th><th>Due</th><th>Status</th><th>Paid</th></tr>
    ${inv.data.map(i => `<tr><td>${esc(i.number)}</td><td>${esc(i.company)}</td><td>${esc(i.plan || '—')}</td><td>${fmtKes(i.amountMinor)}</td><td>${fmtDate(i.periodStart)}→${fmtDate(i.periodEnd)}</td><td>${fmtDate(i.dueDate)}</td><td>${pill(i.status)}</td><td>${i.paidAt ? fmtDate(i.paidAt) : '—'}</td></tr>`).join('') || '<tr><td colspan="8" class="dim">no invoices yet — assign plans to companies</td></tr>'}
    </table></div>`;
  body.querySelector('#run-bill').onclick = async () => { try { const r = await api('/api/v1/platform/billing/run', { method: 'POST' }); toast(`Billing: ${r.invoicesIssued} issued, ${r.markedOverdue} overdue.`); views.owner('invoices'); } catch (e) { toast(e.message, true); } };
}

async function ownPayments(body) {
  const t = await api('/api/v1/platform/payment-config'); const p = t.payment;
  body.innerHTML = `<div class="grid c2">
    <div class="card"><div class="k">Platform M-Pesa — ISPs pay their subscription here</div><br><table>
      <tr><td>Channel</td><td>${pill(p.channel)}</td></tr><tr><td>Credentials</td><td>${p.credentialsConfigured ? pill('SUCCESS') : pill('PENDING')}</td></tr>
      <tr><td>Encryption</td><td>${p.encryptionAvailable ? pill('SUCCESS') : pill('FAILED')}</td></tr></table>
      <label class="f">Channel</label><select id="op-ch"><option value="PAYBILL" ${p.channel === 'PAYBILL' ? 'selected' : ''}>PAYBILL</option><option value="TILL" ${p.channel === 'TILL' ? 'selected' : ''}>TILL (Buy Goods)</option></select>
      <label class="f">Environment</label><select id="op-env"><option value="sandbox" ${p.environment !== 'production' ? 'selected' : ''}>sandbox</option><option value="production" ${p.environment === 'production' ? 'selected' : ''}>production</option></select>
      <div class="grid c2" style="gap:8px"><div><label class="f">Shortcode / store</label><input id="op-sc" value="${esc(p.shortcode || '')}" /></div><div><label class="f">Till number</label><input id="op-pb" value="${esc(p.partyB || '')}" /></div></div>
      <label class="f">Consumer key <span class="dim">(blank = keep)</span></label><input id="op-ck" type="password" />
      <label class="f">Consumer secret</label><input id="op-cs" type="password" /><label class="f">Passkey</label><input id="op-pk" type="password" />
      <button class="wide" id="op-save" style="margin-top:8px">SAVE PLATFORM M-PESA</button></div>
    <div class="muted-card">This is the owner's own Daraja account — the destination for every ISP's monthly subscription fee. It uses the exact same encrypted, abstracted flow the ISPs use for their customers (AES-256-GCM at rest; never shown back). Set <span class="mono">CREDENTIALS_ENCRYPTION_KEY</span> to enable.</div></div>`;
  body.querySelector('#op-save').onclick = async () => {
    try { const d = { channel: $('#op-ch').value, env: $('#op-env').value, shortcode: $('#op-sc').value };
      if ($('#op-pb').value) d.partyB = $('#op-pb').value; if ($('#op-ck').value) d.consumerKey = $('#op-ck').value; if ($('#op-cs').value) d.consumerSecret = $('#op-cs').value; if ($('#op-pk').value) d.passkey = $('#op-pk').value;
      await api('/api/v1/platform/payment-config', { method: 'PUT', body: JSON.stringify(d) }); toast('Platform M-Pesa saved.'); views.owner('payments'); } catch (e) { toast(e.message, true); } };
}

async function ownInsights(body) {
  const ins = await api('/api/v1/platform/insights?status=OPEN');
  body.innerHTML = `<div class="row" style="margin-bottom:12px"><div class="k">AI operations monitor — open findings</div><div class="spacer"></div><button class="ghost mini" id="run-mon">RUN SCAN NOW</button></div>
    ${(ins.data || []).length === 0 ? '<div class="muted-card">✓ No open findings. The monitor scans the estate every 15 minutes for payment-failure spikes, revenue drops, router outages, backlogs, stuck payments and past-due ISPs.</div>' :
      '<div class="grid c2">' + ins.data.map(i => `<div class="card hover"><div class="row"><span class="sev-dot sev-${i.severity}"></span><b>${esc(i.title)}</b><div class="spacer"></div>${pill(i.severity)}</div>
        <p class="sub" style="margin:8px 0">${esc(i.detail)}</p>
        <div class="row"><span class="dim mono" style="font-size:10px">${esc(i.category)} · ${esc(i.code)}${i.company ? ' · ' + esc(i.company) : ''} · ${fmtWhen(i.createdAt)}</span><div class="spacer"></div><button class="ghost mini" data-ack="${i.id}">ACKNOWLEDGE</button></div></div>`).join('') + '</div>'}`;
  body.querySelector('#run-mon').onclick = async () => { try { const r = await api('/api/v1/platform/monitor/run', { method: 'POST' }); toast(`Scan complete: ${r.insightsCreated} new finding(s).`); views.owner('insights'); } catch (e) { toast(e.message, true); } };
  body.querySelectorAll('[data-ack]').forEach(b => b.onclick = async () => { try { await api('/api/v1/platform/insights/' + b.dataset.ack + '/ack', { method: 'POST' }); toast('Acknowledged.'); views.owner('insights'); } catch (e) { toast(e.message, true); } });
}

// ---------- SETUP GUIDE ----------
views.guide = () => {
  $('#view').innerHTML = `<h1>Setup Guide</h1><div class="sub">// company signup · M-Pesa · router · go live</div>
    <div class="grid c2">
      <div class="card"><div class="k">1 · Create your company</div><br><p class="sub">From the sign-in page choose <b>Create your ISP</b>. You become SUPER_ADMIN with a starter catalogue you can edit under Admin → Packages. You're billed by the platform on a monthly plan after a 14-day free trial.</p></div>
      <div class="card"><div class="k">2 · Configure M-Pesa</div><br><p class="sub">Admin → Settings → M-Pesa. Pick <b>Pay Bill</b> or <b>Till (Buy Goods)</b>, enter your shortcode/till and Daraja Consumer Key/Secret + Passkey (from developer.safaricom.co.ke). Encrypted at rest.</p></div></div><br/>
    <div class="card"><div class="k">3 · Prepare a MikroTik (RouterOS) router</div><br>
      <pre class="mono" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;white-space:pre-wrap;color:var(--acc);font-size:11px">/user group add name=nexora-api policy=api,read,write,test,!local,!telnet,!ssh,!ftp,!reboot,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=nexora group=nexora-api password=STRONG_SECRET comment="NEXORA automation"
/ip service set api-ssl disabled=no port=8729
/ip service disable telnet,ftp,www
/ip hotspot walled-garden add dst-host=YOUR_NEXORA_HOST action=allow</pre>
      <p class="sub" style="margin-top:8px">Store the password in the server variable (e.g. <span class="mono">ROUTER_01_PASSWORD</span>) — never the database. Prefer an outbound WireGuard/IPsec tunnel over exposing the API port. Full guide: <span class="mono">docs/ROUTER_SETUP.md</span>.</p></div><br/>
    <div class="card"><div class="k">Payment lifecycle — nothing left hanging</div><br><p class="sub">Every payment (customer→ISP and ISP→platform) ends as ${pill('SUCCESS')} ${pill('CANCELLED')} ${pill('EXPIRED')} or ${pill('FAILED')}. A reconciliation sweep runs continuously to close out anything a callback missed.</p></div>`;
};
