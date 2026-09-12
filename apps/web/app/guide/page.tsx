'use client';

const ROUTER_COMMANDS = `/user group add name=nexora-api policy=api,read,write,test,!local,!telnet,!ssh,!ftp,!reboot,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=nexora group=nexora-api password=STRONG_SECRET comment="NEXORA automation"
/ip service set api-ssl disabled=no port=8729
/ip service disable telnet,ftp,www
/ip hotspot walled-garden add dst-host=YOUR_NEXORA_HOST action=allow`;

export default function GuidePage() {
  return (
    <main>
      <h1>SETUP GUIDE</h1>
      <div className="sub">// company signup · M-Pesa · router · go live</div>

      <div className="grid c2">
        <div className="card">
          <div className="k">1 · Create your company</div><br />
          <p className="sub" style={{ lineHeight: 1.6 }}>
            From the sign-in page choose <b>Create your ISP</b>. You become SUPER_ADMIN with a starter
            catalogue you can edit under Admin → Packages. You are billed by the platform on a monthly
            plan after a 14-day free trial (see Admin → Billing).
          </p>
        </div>
        <div className="card">
          <div className="k">2 · Configure M-Pesa</div><br />
          <p className="sub" style={{ lineHeight: 1.6 }}>
            Admin → Settings. Pick <b>Pay Bill</b> or <b>Till (Buy Goods)</b>, enter your shortcode/till and
            Daraja Consumer Key / Secret + Passkey (from developer.safaricom.co.ke). Credentials are
            encrypted at rest.
          </p>
        </div>
      </div>
      <br />

      <div className="card">
        <div className="k">3 · Prepare a MikroTik (RouterOS) router</div><br />
        <pre className="code">{ROUTER_COMMANDS}</pre>
        <p className="sub" style={{ marginTop: 8, lineHeight: 1.6 }}>
          Store the password in the server variable (e.g. <span className="mono">ROUTER_01_PASSWORD</span>) —
          never the database. Prefer an outbound WireGuard/IPsec tunnel over exposing the API port.
        </p>
      </div>
      <br />

      <div className="card">
        <div className="k">Payment lifecycle — nothing left hanging</div><br />
        <p className="sub" style={{ lineHeight: 1.6 }}>
          Every payment (customer → ISP and ISP → platform) ends as{' '}
          <span className="pill SUCCESS">SUCCESS</span> <span className="pill PENDING">CANCELLED</span>{' '}
          <span className="pill FAILED">EXPIRED</span> or <span className="pill FAILED">FAILED</span>. A
          reconciliation sweep runs continuously to close out anything a callback missed.
        </p>
      </div>
    </main>
  );
}
