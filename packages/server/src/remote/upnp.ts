/**
 * Minimal UPnP Internet Gateway Device client: SSDP discovery plus the three
 * SOAP actions Octavo needs (external address, add and delete a port mapping).
 *
 * Written in-house because common libraries only search for IGD version 2,
 * while most ISP gateways (Comcast/Rogers XB, Technicolor, Sagemcom, …) only
 * answer as version 1, and because they listen on UDP port 1900, which Windows'
 * own SSDP service already owns.
 */
import dgram from 'node:dgram';
import os from 'node:os';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
  'upnp:rootdevice',
];
const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export interface Gateway {
  /** Address the router answered from. */
  host: string;
  /** This computer's address on the router's network. */
  localIp: string;
  /** Friendly name from the device description, if any. */
  name: string;
  controlUrl: string;
  serviceType: string;
}

export interface DiscoveryResult {
  gateway: Gateway | null;
  /** Everything that answered, e.g. "10.0.0.1 (no port forwarding service)", for diagnostics. */
  seen: string[];
  /** Local addresses searched from. */
  searchedFrom: string[];
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Local IPv4 addresses to search from (default: every non-internal one). */
  interfaces?: string[];
  /** Extra unicast targets, "host:port" (default: likely router addresses on each network). */
  targets?: string[];
}

function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
    }
  }
  return out;
}

/** Guess the router's address on a /24 network (x.y.z.1 and x.y.z.254 cover nearly all home gateways). */
function routerGuesses(addr: string): string[] {
  const p = addr.split('.').slice(0, 3).join('.');
  return [`${p}.1`, `${p}.254`].filter((a) => a !== addr);
}

function header(msg: string, name: string): string | undefined {
  const m = msg.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'));
  return m?.[1].trim();
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i'));
  return m?.[1].trim();
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchText(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: await res.text() };
}

/** Read a device description and find its WAN connection service. */
export async function describe(location: string): Promise<{ name: string; controlUrl: string; serviceType: string } | null> {
  const { text } = await fetchText(location);
  const base = tag(text, 'URLBase') || location;
  const name = unescapeXml(tag(text, 'friendlyName') ?? tag(text, 'modelName') ?? '');
  const services = text.match(/<(?:\w+:)?service>[\s\S]*?<\/(?:\w+:)?service>/gi) ?? [];
  for (const wanted of WAN_SERVICES) {
    for (const s of services) {
      const type = tag(s, 'serviceType');
      const control = tag(s, 'controlURL');
      if (type === wanted && control) return { name, controlUrl: new URL(unescapeXml(control), base).toString(), serviceType: type };
    }
  }
  return null;
}

/** Find the home router via SSDP (multicast from every network, plus unicast to likely router addresses). */
export async function discover(opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const from = opts.interfaces ?? localAddresses();
  const seen = new Map<string, string>();
  const checked = new Set<string>();
  let found: Gateway | null = null;
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => (finish = r));
  const sockets: dgram.Socket[] = [];
  const pending: Promise<void>[] = [];

  const onReply = (localIp: string, msg: string, rinfo: dgram.RemoteInfo) => {
    if (found) return;
    const location = header(msg, 'LOCATION');
    if (!seen.has(rinfo.address)) seen.set(rinfo.address, `${rinfo.address} (answered, not a router with port forwarding)`);
    if (!location || checked.has(location)) return;
    checked.add(location);
    pending.push(
      describe(location)
        .then((d) => {
          if (!d) return;
          seen.set(rinfo.address, `${rinfo.address}${d.name ? ` “${d.name}”` : ''} (UPnP router)`);
          if (!found) {
            found = { host: new URL(location).hostname, localIp, ...d };
            finish();
          }
        })
        .catch(() => {}),
    );
  };

  const search = (sock: dgram.Socket, host: string, port: number) => {
    for (const st of SEARCH_TARGETS) {
      const msg = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
      );
      sock.send(msg, port, host, () => {});
    }
  };

  await Promise.all(
    from.map(
      (addr) =>
        new Promise<void>((resolve) => {
          const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          sock.on('error', () => resolve());
          sock.on('message', (buf, rinfo) => onReply(addr, buf.toString('utf8'), rinfo));
          // Port 0 (any free port): 1900 is often taken by the operating system's own SSDP service.
          sock.bind(0, addr, () => {
            try {
              sock.setMulticastInterface(addr);
              sock.setMulticastTTL(4);
            } catch {
              /* still try unicast */
            }
            sockets.push(sock);
            resolve();
          });
        }),
    ),
  );

  const targets = (sock: dgram.Socket): [string, number][] => {
    const addr = sock.address().address;
    const extra = (opts.targets ?? routerGuesses(addr).map((h) => `${h}:${SSDP_PORT}`)).map((t) => {
      const [h, p] = t.split(':');
      return [h, Number(p) || SSDP_PORT] as [string, number];
    });
    return opts.targets ? extra : [[SSDP_ADDR, SSDP_PORT], ...extra];
  };
  const round = () => sockets.forEach((s) => targets(s).forEach(([h, p]) => search(s, h, p)));
  round();
  const resend = setInterval(round, 1500);
  const timer = setTimeout(finish, timeoutMs);
  await done;
  clearInterval(resend);
  clearTimeout(timer);
  // Give in-flight description fetches a moment if nothing was found yet.
  if (!found) await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 1000))]);
  for (const s of sockets) s.close();
  return { gateway: found, seen: [...seen.values()], searchedFrom: from };
}

export class UpnpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Call a SOAP action on the router's WAN service and return the response body. */
export async function soap(gw: Gateway, action: string, args: Record<string, string | number>): Promise<string> {
  const body =
    `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${gw.serviceType}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const { status, text } = await fetchText(
    gw.controlUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
      body,
    },
    10_000,
  );
  if (status >= 400 || /<(?:\w+:)?Fault>/i.test(text)) {
    const code = Number(tag(text, 'errorCode')) || undefined;
    const desc = tag(text, 'errorDescription') ?? `HTTP ${status}`;
    throw new UpnpError(`Router refused ${action}: ${desc}${code ? ` (error ${code})` : ''}`, code);
  }
  return text;
}

export async function getExternalIp(gw: Gateway): Promise<string> {
  const text = await soap(gw, 'GetExternalIPAddress', {});
  const ip = tag(text, 'NewExternalIPAddress');
  if (!ip) throw new UpnpError('Router did not report its internet address');
  return ip;
}

export async function addPortMapping(
  gw: Gateway,
  m: { externalPort: number; internalPort: number; description: string; leaseSeconds: number },
): Promise<void> {
  const args = (lease: number) => ({
    NewRemoteHost: '',
    NewExternalPort: m.externalPort,
    NewProtocol: 'TCP',
    NewInternalPort: m.internalPort,
    NewInternalClient: gw.localIp,
    NewEnabled: 1,
    NewPortMappingDescription: m.description,
    NewLeaseDuration: lease,
  });
  try {
    await soap(gw, 'AddPortMapping', args(m.leaseSeconds));
  } catch (err) {
    // 725 OnlyPermanentLeasesSupported: some routers only accept lease 0.
    if (err instanceof UpnpError && err.code === 725) await soap(gw, 'AddPortMapping', args(0));
    else throw err;
  }
}

export async function deletePortMapping(gw: Gateway, externalPort: number): Promise<void> {
  await soap(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: externalPort, NewProtocol: 'TCP' });
}
