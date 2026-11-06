import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';

/** IPv4 addresses on the local network, most likely home/office Wi-Fi first. */
export function lanAddresses(): string[] {
  const out: { addr: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const a = i.address;
      let rank = 3;
      if (a.startsWith('192.168.')) rank = 0;
      else if (a.startsWith('10.')) rank = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) rank = 2;
      else if (a.startsWith('100.')) rank = 1; // Tailscale / CGNAT
      if (/docker|veth|br-|vmnet|virbr/i.test(name)) rank += 10;
      out.push({ addr: a, rank });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map((x) => x.addr);
}

/**
 * A long random access key, saved so the phone's bookmark keeps working across
 * restarts. Stored outside the vault so it never ends up in git or sync.
 */
export function loadOrCreateToken(file = path.join(os.homedir(), '.ultron-mind', 'phone-token')): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

/** The URL a phone opens: carries the access key once; the app then stores it and removes it from the address bar. */
export function phoneUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
}

export async function qrTerminal(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
}

export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'M', color: { dark: '#111014', light: '#f2efe8' } });
}
