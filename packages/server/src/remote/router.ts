import { upnpNat, type Gateway } from '@achingbrain/nat-port-mapper';
import { lanAddresses } from '../phone.js';

/** The parts of a home router Octavo needs: its internet address and port forwarding. */
export interface Router {
  /** Name for messages, e.g. "UPnP router at 192.168.1.1". */
  readonly label: string;
  externalIp(): Promise<string>;
  /** Forward externalPort on the internet side to internalPort on this computer. Returns the external port actually used. */
  map(internalPort: number, externalPort: number, description: string): Promise<number>;
  unmap(internalPort: number): Promise<void>;
  stop(): Promise<void>;
}

/** Pick this computer's LAN address that's on the same network as the router. */
function localAddressFor(gatewayHost: string): string | undefined {
  const prefix = gatewayHost.split('.').slice(0, 3).join('.') + '.';
  const addrs = lanAddresses();
  return addrs.find((a) => a.startsWith(prefix)) ?? addrs[0];
}

function wrap(gw: Gateway): Router {
  const localIp = localAddressFor(gw.host);
  return {
    label: `UPnP router at ${gw.host}`,
    externalIp: () => gw.externalIp({ signal: AbortSignal.timeout(10_000) }),
    async map(internalPort, externalPort, description) {
      if (!localIp) throw new Error('This computer has no network address on the router’s network');
      const m = await gw.map(internalPort, localIp, {
        externalPort,
        protocol: 'TCP',
        description,
        ttl: 7200,
        autoRefresh: true,
        signal: AbortSignal.timeout(10_000),
      });
      return m.externalPort;
    },
    unmap: (internalPort) => gw.unmap(internalPort, { signal: AbortSignal.timeout(10_000) }).catch(() => {}),
    stop: () => gw.stop().catch(() => {}),
  };
}

/** Find the home router via UPnP. Resolves to null if none answers within the timeout. */
export async function findRouter(timeoutMs = 8000): Promise<Router | null> {
  const client = upnpNat({ autoRefresh: true });
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for await (const gw of client.findGateways({ signal })) {
      if (gw.family === 'IPv4') return wrap(gw);
    }
  } catch {
    /* timed out or no multicast: no UPnP router */
  }
  return null;
}
