import net from 'node:net';

export type AddressKind = 'public' | 'cgnat' | 'private' | 'invalid';

/**
 * What kind of address the router reports as its internet address.
 * - cgnat: 100.64.0.0/10. The ISP shares one public address between many homes,
 *   so nothing on the internet can connect in directly.
 * - private: the router is itself behind another router (double NAT).
 */
export function classifyAddress(ip: string): AddressKind {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (a === 127 || a === 0 || a === 169 || a >= 224) return 'invalid';
    return 'public';
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
    return 'public';
  }
  return 'invalid';
}
