import { addPortMapping, deletePortMapping, discover, getExternalIp, type DiscoveryResult, type Gateway } from './upnp.js';

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

const LEASE_SECONDS = 7200;

export function upnpRouter(gw: Gateway): Router {
  // internalPort -> { externalPort, refresh timer }
  const mappings = new Map<number, { externalPort: number; timer: NodeJS.Timeout }>();
  return {
    label: `UPnP router at ${gw.host}${gw.name ? ` (${gw.name})` : ''}`,
    externalIp: () => getExternalIp(gw),
    async map(internalPort, externalPort, description) {
      const add = () => addPortMapping(gw, { externalPort, internalPort, description, leaseSeconds: LEASE_SECONDS });
      await add();
      clearInterval(mappings.get(internalPort)?.timer);
      // Renew well before the lease runs out.
      // Renew often: a router that restarts (power cut) forgets its forwards, and this puts them back.
      const timer = setInterval(() => add().catch(() => {}), 10 * 60 * 1000);
      timer.unref?.();
      mappings.set(internalPort, { externalPort, timer });
      return externalPort;
    },
    async unmap(internalPort) {
      const m = mappings.get(internalPort);
      if (!m) return;
      clearInterval(m.timer);
      mappings.delete(internalPort);
      await deletePortMapping(gw, m.externalPort).catch(() => {});
    },
    async stop() {
      for (const m of mappings.values()) clearInterval(m.timer);
      mappings.clear();
    },
  };
}

/** The most recent search, so diagnostics can say what (if anything) answered. */
export let lastDiscovery: DiscoveryResult | null = null;

/** Find the home router via UPnP. Resolves to null if none answers within the timeout. */
export async function findRouter(timeoutMs = 8000): Promise<Router | null> {
  try {
    lastDiscovery = await discover({ timeoutMs });
  } catch {
    lastDiscovery = null;
    return null;
  }
  return lastDiscovery.gateway ? upnpRouter(lastDiscovery.gateway) : null;
}
