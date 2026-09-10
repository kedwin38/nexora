# Router Setup Guide

NEXORA provisions internet access by driving your edge router. This guide
gives you the exact commands to prepare a router for a NEXORA site. Two
vendors are supported today: **MikroTik (RouterOS)** — the recommended
platform — and **Tenda**.

> NEXORA never stores a router password in the database. You store the
> password in a server environment variable and register only its **name**
> on the router record (see ADR-008). Example below uses `ROUTER_01_PASSWORD`.

---

## 1. MikroTik (RouterOS) — recommended

NEXORA talks to MikroTik over the RouterOS API (port `8728`, or `8729` for
API-over-TLS). It authorises a subscriber by MAC address, applies a rate
limit (a `queue`), and can disconnect a session on demand.

### 1.1 Create a dedicated API user

Never use the `admin` account for automation. Create a least-privilege user
that NEXORA authenticates as:

```routeros
# On the router terminal (Winbox > New Terminal, or SSH):
/user group add name=nexora-api policy=api,read,write,test,!local,!telnet,!ssh,!ftp,!reboot,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=nexora group=nexora-api password=CHANGE_ME_STRONG comment="NEXORA automation"
```

Put `CHANGE_ME_STRONG` into the server variable you will reference (e.g.
`ROUTER_01_PASSWORD`), not into NEXORA's database.

### 1.2 Enable the API service

```routeros
# Plain API (inside a trusted management network/VPN only):
/ip service set api address=10.0.0.0/24 disabled=no port=8728

# Preferred: API over TLS
/ip service set api-ssl disabled=no port=8729
# (import or generate a certificate first: /certificate ...)
/ip service disable telnet,ftp,www
```

### 1.3 Hotspot (captive portal) basics

If you run a hotspot so customers land on the purchase page:

```routeros
# Assuming a bridge 'bridge-hotspot' carrying your access ports:
/ip pool add name=hotspot-pool ranges=10.50.0.10-10.50.0.254
/ip dhcp-server add name=hotspot-dhcp interface=bridge-hotspot address-pool=hotspot-pool disabled=no
/ip hotspot setup
#   ... follow the wizard: interface=bridge-hotspot, address pool=hotspot-pool,
#   DNS, and the login page (point it at your NEXORA portal URL).

# Send unauthenticated users to the NEXORA portal:
/ip hotspot walled-garden add dst-host=YOUR_NEXORA_HOST action=allow
```

### 1.4 How NEXORA authorises a subscriber (for reference)

NEXORA issues these through the API — you do **not** type them by hand, but
this is what an AUTHORIZE / rate-limit / disconnect looks like:

```routeros
# Authorize a MAC on the hotspot:
/ip hotspot ip-binding add mac-address=AA:BB:CC:DD:EE:FF type=bypassed comment="NEXORA sub SUB-XXX"
# Apply a 5M/2M plan as a simple queue:
/queue simple add name=NEXORA-AA:BB:CC:DD:EE:FF target=10.50.0.23/32 max-limit=2M/5M
# Throttle on FUP (reduce to 25%):
/queue simple set NEXORA-AA:BB:CC:DD:EE:FF max-limit=512k/1280k
# Deauthorize on expiry:
/ip hotspot ip-binding remove [find comment="NEXORA sub SUB-XXX"]
/queue simple remove [find name=NEXORA-AA:BB:CC:DD:EE:FF]
```

### 1.5 Register the router in NEXORA

As a company admin, open **Admin → Network** (or call the API) and add the
router with: name, vendor `MIKROTIK`, host/IP, port `8728` (or `8729`),
username `nexora`, and the **password variable name** `ROUTER_01_PASSWORD`.
Then set that variable on the server/Railway:

```bash
ROUTER_01_PASSWORD=CHANGE_ME_STRONG
```

### 1.6 Connectivity patterns (Railway ⇄ on-site router)

The NEXORA control plane is cloud-hosted; your router is on-site. Pick one:

- **Pattern A — outbound tunnel (recommended):** the router joins a
  WireGuard/IPsec tunnel to a concentrator the workers can reach. No inbound
  port-forward on the customer's line.
- **Pattern B — port-forward + allowlist:** forward `8729` (API-SSL) to the
  router and restrict `/ip service` `address=` to the NEXORA egress IPs.

Prefer Pattern A. Never expose plain API (`8728`) to the public internet.

---

## 2. Tenda

Tenda SOHO routers expose a smaller surface. NEXORA's Tenda adapter supports
authorise/deauthorise and basic rate control where the firmware allows it.

1. Log into the Tenda admin (default `192.168.0.1`), set a strong admin
   password, and store it in `ROUTER_02_PASSWORD`.
2. Enable remote management restricted to your NEXORA management network.
3. Register the router in NEXORA with vendor `TENDA`, host/IP, and the
   password variable name.

> Tenda capability varies by model. NEXORA reads the router's advertised
> capabilities and will only attempt operations the device supports; anything
> unsupported is surfaced as a capability gap rather than a silent failure.

---

## 3. Verify the link

After registering a router, NEXORA's health poller marks it `ONLINE`,
`DEGRADED`, or `OFFLINE` within a minute. Check **Admin → Overview** (or
`GET /api/v1/admin/network-operations`) and watch a test AUTHORIZE reach
`SUCCESS` with a verified read-back. If it stays `RETRYING`, re-check the API
user policy, the service port, and the tunnel/allowlist.
