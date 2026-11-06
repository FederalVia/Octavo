import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import type { RequestListener } from 'node:http';
import { issueIpCertificate, LETS_ENCRYPT, type IssuedCertificate } from './acme.js';
import { classifyAddress } from './netcheck.js';
import { findRouter, type Router } from './router.js';

export type RemoteProblem =
  | 'no-router' // no UPnP router answered (or UPnP is switched off)
  | 'cgnat' // ISP shares one address between many homes: direct connections impossible
  | 'double-nat' // this router is behind another router
  | 'port-80' // router refused to forward port 80 (needed for the certificate)
  | 'port-https' // router refused every HTTPS port we tried
  | 'certificate' // Let's Encrypt couldn't reach this computer or refused the request
  | 'unknown';

export interface RemoteStatus {
  state: 'starting' | 'ready' | 'error' | 'stopped';
  /** What's happening right now, in plain words. */
  step: string;
  /** https address to open from anywhere (when ready). */
  url?: string;
  ip?: string;
  certificateExpires?: number;
  problem?: RemoteProblem;
  /** Plain-language explanation and what to do. */
  advice?: string;
}

export interface RemoteOptions {
  /** The Octavo app (Express) to serve over HTTPS. */
  app: RequestListener;
  /** Where the certificate and ACME account are kept between runs (outside the vault). */
  stateDir: string;
  /** Port on this computer for HTTPS (forwarded from the internet). */
  httpsPort?: number;
  /** Port on this computer for Let's Encrypt's check (forwarded from internet port 80). */
  challengePort?: number;
  /** Internet-side HTTPS ports to try, in order. */
  externalHttpsPorts?: number[];
  /** Skip UPnP: the user forwarded ports by hand and tells us the public IP. */
  publicIp?: string;
  /** ACME directory (defaults to Let's Encrypt production). */
  directoryUrl?: string;
  /** Override router discovery (tests). */
  findRouter?: () => Promise<Router | null>;
  /** Safety check run before exposing anything: must resolve true (e.g. "the app requires an access key"). */
  requireToken?: () => boolean | Promise<boolean>;
  /** How often to check whether the home address changed. */
  ipCheckMs?: number;
  /** Give up getting a certificate after this long. */
  certificateTimeoutMs?: number;
  /** Retries for network errors talking to Let's Encrypt. */
  networkRetries?: number;
  log?: (msg: string) => void;
}

interface SavedState {
  accountKey?: string;
  accountUrl?: string;
  ip?: string;
  certPem?: string;
  keyPem?: string;
  notAfter?: number;
  externalHttpsPort?: number;
}

const ADVICE: Record<RemoteProblem, string> = {
  'no-router':
    'Octavo couldn’t find your router. Turn on “UPnP” in your router’s settings (it’s usually on by default) and try again. Or forward two ports by hand in the router: internet port 80 → this computer’s port {challenge}, and internet port 443 → port {https}. See “Forwarding ports by hand” in docs/SELF_HOSTING.md.',
  cgnat:
    'Your internet provider shares one public address between many homes (called CGNAT), so nothing on the internet can connect to your home directly, whatever app you use. Ask your provider for a “public IPv4 address” (often free or cheap), or use a relay service such as Tailscale.',
  'double-nat':
    'Your router is connected behind another router (for example your provider’s modem/router plus your own Wi-Fi router). Put the provider’s box in “bridge mode”, or enable UPnP / port forwarding on the outer router too.',
  'port-80':
    'Your router refused to forward internet port 80, which Let’s Encrypt needs to confirm this address is yours. Check the router’s UPnP settings, or forward port 80 → this computer’s port {challenge} by hand.',
  'port-https':
    'Your router refused to forward a port for HTTPS. Check its UPnP settings, or forward port 443 → this computer’s port {https} by hand.',
  certificate:
    'Let’s Encrypt couldn’t reach this computer from the internet to issue the HTTPS certificate. Your provider may block incoming connections on port 80, or a firewall on this computer may be blocking Octavo. Allow Octavo through the firewall and try again.',
  unknown: 'Something unexpected went wrong setting up access from anywhere.',
};

/**
 * "Access from anywhere": opens ports on the home router (UPnP), gets a real
 * HTTPS certificate for the home's public IP (Let's Encrypt), serves Octavo
 * over HTTPS, renews the certificate every few days and follows IP changes.
 */
export class RemoteAccess extends EventEmitter {
  private opts: Required<
    Pick<RemoteOptions, 'httpsPort' | 'challengePort' | 'externalHttpsPorts' | 'directoryUrl' | 'ipCheckMs' | 'certificateTimeoutMs'>
  > &
    RemoteOptions;
  private router: Router | null = null;
  private httpsServer: https.Server | null = null;
  private challengeServer: http.Server | null = null;
  private challenges = new Map<string, string>();
  private saved: SavedState = {};
  private timers: NodeJS.Timeout[] = [];
  private status: RemoteStatus = { state: 'stopped', step: 'Not started' };
  private busy = false;

  constructor(options: RemoteOptions) {
    super();
    this.opts = {
      httpsPort: 4443,
      challengePort: 4380,
      externalHttpsPorts: [443, 8443, 47321],
      directoryUrl: LETS_ENCRYPT,
      ipCheckMs: 5 * 60 * 1000,
      certificateTimeoutMs: 3 * 60 * 1000,
      ...options,
    };
  }

  get current(): RemoteStatus {
    return this.status;
  }

  private log(msg: string) {
    this.opts.log?.(msg);
  }

  private setStatus(s: RemoteStatus) {
    this.status = s;
    this.emit('status', s);
  }

  private fail(problem: RemoteProblem, detail?: string): RemoteStatus {
    const advice = ADVICE[problem].replace('{challenge}', String(this.opts.challengePort)).replace('{https}', String(this.opts.httpsPort));
    const s: RemoteStatus = { state: 'error', step: 'Couldn’t set up access from anywhere', problem, advice: detail ? `${advice}\n\nDetails: ${detail}` : advice };
    this.setStatus(s);
    return s;
  }

  private statePath() {
    return path.join(this.opts.stateDir, 'remote.json');
  }

  private async loadState() {
    try {
      this.saved = JSON.parse(await fs.readFile(this.statePath(), 'utf8'));
    } catch {
      this.saved = {};
    }
  }

  private async saveState() {
    await fs.mkdir(this.opts.stateDir, { recursive: true });
    await fs.writeFile(this.statePath(), JSON.stringify(this.saved, null, 2), { mode: 0o600 });
  }

  private listen(server: net.Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }

  private async startChallengeServer() {
    if (this.challengeServer) return;
    this.challengeServer = http.createServer((req, res) => {
      const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '');
      const answer = m ? this.challenges.get(m[1]) : undefined;
      if (answer) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(answer);
        return;
      }
      // Anyone visiting http:// gets sent to the secure address.
      if (this.status.url) {
        res.writeHead(301, { Location: this.status.url });
        res.end();
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Octavo');
    });
    await this.listen(this.challengeServer, this.opts.challengePort);
  }

  private async currentIp(): Promise<string> {
    if (this.opts.publicIp) return this.opts.publicIp;
    if (!this.router) throw new Error('No router');
    return this.router.externalIp();
  }

  private certUsable(ip: string): boolean {
    return !!(this.saved.certPem && this.saved.keyPem && this.saved.ip === ip && (this.saved.notAfter ?? 0) - Date.now() > 2 * 24 * 3600 * 1000);
  }

  private async obtainCertificate(ip: string): Promise<IssuedCertificate> {
    // While renewing, keep serving: only the first certificate puts us in "starting".
    const state = this.status.state === 'ready' ? 'ready' : 'starting';
    this.setStatus({ ...this.status, state, step: 'Getting a free HTTPS certificate from Let’s Encrypt…' });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Let’s Encrypt didn’t respond within ${Math.round(this.opts.certificateTimeoutMs / 1000)} seconds`)),
        this.opts.certificateTimeoutMs,
      );
    });
    const cert = await Promise.race([
      issueIpCertificate({
        ip,
        directoryUrl: this.opts.directoryUrl,
        accountKey: this.saved.accountKey,
        accountUrl: this.saved.accountUrl,
        networkRetries: this.opts.networkRetries,
        setChallenge: (token, value) => (value ? this.challenges.set(token, value) : this.challenges.delete(token)),
        log: (m) => this.log(m),
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    this.saved = { ...this.saved, accountKey: cert.accountKey, accountUrl: cert.accountUrl, ip, certPem: cert.certPem, keyPem: cert.keyPem, notAfter: cert.notAfter };
    await this.saveState();
    return cert;
  }

  private urlFor(ip: string, port: number) {
    const host = net.isIPv6(ip) ? `[${ip}]` : ip;
    return `https://${host}${port === 443 ? '' : `:${port}`}`;
  }

  /** Set everything up. Resolves with the final status (ready or error); never throws. */
  async start(): Promise<RemoteStatus> {
    if (this.busy) return this.status;
    if (this.opts.requireToken && !(await this.opts.requireToken())) {
      return this.fail('unknown', 'Refusing to open Octavo to the internet without an access key.');
    }
    this.busy = true;
    try {
      await this.loadState();

      // 1. Router and public address.
      let ip: string;
      if (this.opts.publicIp) {
        ip = this.opts.publicIp;
      } else {
        this.setStatus({ state: 'starting', step: 'Looking for your router…' });
        this.router = await (this.opts.findRouter ?? findRouter)();
        if (!this.router) return this.fail('no-router');
        try {
          ip = await this.router.externalIp();
        } catch (err) {
          return this.fail('no-router', String((err as Error).message ?? err));
        }
      }
      const kind = classifyAddress(ip);
      if (kind === 'cgnat') return this.fail('cgnat', `Your router’s internet address is ${ip}.`);
      if (kind === 'private') return this.fail('double-nat', `Your router’s internet address is ${ip}.`);
      if (kind === 'invalid') return this.fail('unknown', `Your router reported an unusable internet address (${ip}).`);
      this.log(`Public address: ${ip}`);

      // 2. Local listeners, then router port forwarding.
      this.setStatus({ state: 'starting', step: 'Opening a door in your router…', ip });
      await this.startChallengeServer();
      let externalHttps = this.saved.externalHttpsPort ?? this.opts.externalHttpsPorts[0];
      if (this.router) {
        try {
          const got = await this.router.map(this.opts.challengePort, 80, 'Octavo (certificate check)');
          if (got !== 80) return this.fail('port-80', `The router offered port ${got} instead of 80.`);
        } catch (err) {
          return this.fail('port-80', String((err as Error).message ?? err));
        }
        let mapped = 0;
        const candidates = [...new Set([externalHttps, ...this.opts.externalHttpsPorts])];
        let lastErr = '';
        for (const port of candidates) {
          try {
            mapped = await this.router.map(this.opts.httpsPort, port, 'Octavo');
            if (mapped) break;
          } catch (err) {
            lastErr = String((err as Error).message ?? err);
          }
        }
        if (!mapped) return this.fail('port-https', lastErr);
        externalHttps = mapped;
      }
      this.saved.externalHttpsPort = externalHttps;

      // 3. Certificate (reuse a cached one if it's still good for this address).
      if (!this.certUsable(ip)) {
        try {
          await this.obtainCertificate(ip);
        } catch (err) {
          return this.fail('certificate', String((err as Error).message ?? err));
        }
      } else {
        await this.saveState();
      }

      // 4. HTTPS server.
      if (!this.httpsServer) {
        this.httpsServer = https.createServer({ key: this.saved.keyPem, cert: this.saved.certPem }, this.opts.app);
        await this.listen(this.httpsServer, this.opts.httpsPort);
      } else {
        this.httpsServer.setSecureContext({ key: this.saved.keyPem!, cert: this.saved.certPem! });
      }

      const status: RemoteStatus = {
        state: 'ready',
        step: 'Ready',
        ip,
        url: this.urlFor(ip, externalHttps),
        certificateExpires: this.saved.notAfter,
      };
      this.setStatus(status);
      this.scheduleChecks();
      return status;
    } catch (err) {
      return this.fail('unknown', String((err as Error).message ?? err));
    } finally {
      this.busy = false;
    }
  }

  private scheduleChecks() {
    this.timers.forEach(clearInterval);
    this.timers = [
      // Follow changes of the home's public address.
      setInterval(() => this.checkIp().catch((e) => this.log(`Address check failed: ${e}`)), this.opts.ipCheckMs),
      // Renew the (6-day) certificate when it has less than 3 days left.
      setInterval(() => this.checkRenewal().catch((e) => this.log(`Renewal failed: ${e}`)), 3 * 3600 * 1000),
    ];
    for (const t of this.timers) t.unref?.();
  }

  /** Re-check the public address; if it changed, get a new certificate and announce the new URL. */
  async checkIp(): Promise<boolean> {
    if (this.status.state !== 'ready' || this.busy) return false;
    const ip = await this.currentIp();
    if (ip === this.status.ip) return false;
    this.log(`Public address changed: ${this.status.ip} → ${ip}`);
    this.busy = true;
    try {
      if (classifyAddress(ip) !== 'public') {
        this.fail(classifyAddress(ip) === 'cgnat' ? 'cgnat' : 'double-nat', `Your router’s internet address is now ${ip}.`);
        return true;
      }
      await this.obtainCertificate(ip);
      this.httpsServer?.setSecureContext({ key: this.saved.keyPem!, cert: this.saved.certPem! });
      const status: RemoteStatus = {
        state: 'ready',
        step: 'Ready',
        ip,
        url: this.urlFor(ip, this.saved.externalHttpsPort ?? 443),
        certificateExpires: this.saved.notAfter,
      };
      this.setStatus(status);
      this.emit('address-changed', status);
      return true;
    } catch (err) {
      this.fail('certificate', String((err as Error).message ?? err));
      return true;
    } finally {
      this.busy = false;
    }
  }

  async checkRenewal(force = false): Promise<boolean> {
    if (this.status.state !== 'ready' || this.busy || !this.status.ip) return false;
    if (!force && (this.saved.notAfter ?? 0) - Date.now() > 3 * 24 * 3600 * 1000) return false;
    this.busy = true;
    try {
      await this.obtainCertificate(this.status.ip);
      this.httpsServer?.setSecureContext({ key: this.saved.keyPem!, cert: this.saved.certPem! });
      this.setStatus({ ...this.status, state: 'ready', step: 'Ready', certificateExpires: this.saved.notAfter });
      this.log('Certificate renewed');
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Close the ports on the router and stop serving. */
  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.router) {
      await this.router.unmap(this.opts.httpsPort);
      await this.router.unmap(this.opts.challengePort);
      await this.router.stop();
      this.router = null;
    }
    await Promise.all(
      [this.httpsServer, this.challengeServer].map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s) return resolve();
            s.closeAllConnections?.();
            s.close(() => resolve());
          }),
      ),
    );
    this.httpsServer = null;
    this.challengeServer = null;
    this.setStatus({ state: 'stopped', step: 'Stopped' });
  }
}

/** Quick diagnosis for `octavo check-remote`: can this network accept direct connections? */
export async function diagnose(opts: { findRouter?: () => Promise<Router | null> } = {}): Promise<{
  ok: boolean;
  lines: string[];
  problem?: RemoteProblem;
}> {
  const lines: string[] = [];
  const router = await (opts.findRouter ?? findRouter)();
  if (!router) {
    lines.push('✗ No router answered on UPnP.');
    return { ok: false, lines, problem: 'no-router' };
  }
  lines.push(`✓ Found your router (${router.label}).`);
  try {
    const ip = await router.externalIp();
    const kind = classifyAddress(ip);
    if (kind === 'cgnat') {
      lines.push(`✗ Its internet address is ${ip}, which is shared with other homes by your provider (CGNAT).`);
      return { ok: false, lines, problem: 'cgnat' };
    }
    if (kind !== 'public') {
      lines.push(`✗ Its internet address is ${ip}: this router is behind another router (double NAT).`);
      return { ok: false, lines, problem: 'double-nat' };
    }
    lines.push(`✓ Your home has a public internet address: ${ip}`);
    const test = 47_999;
    try {
      await router.map(test, test, 'Octavo connection test');
      await router.unmap(test);
      lines.push('✓ Your router lets Octavo open ports automatically.');
    } catch (err) {
      lines.push(`✗ Your router refused to open a port automatically (${(err as Error).message ?? err}).`);
      return { ok: false, lines, problem: 'port-https' };
    }
    return { ok: true, lines };
  } finally {
    await router.stop();
  }
}

export { ADVICE as REMOTE_ADVICE };
