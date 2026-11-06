import * as acme from 'acme-client';

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';

export interface IssuedCertificate {
  certPem: string;
  keyPem: string;
  accountKey: string;
  accountUrl: string;
  notAfter: number;
}

export interface IssueOptions {
  ip: string;
  directoryUrl: string;
  /** Reuse the ACME account between renewals. */
  accountKey?: string;
  accountUrl?: string;
  /** Publish the http-01 challenge response at /.well-known/acme-challenge/<token>. */
  setChallenge: (token: string, keyAuthorization: string | null) => void;
  log?: (msg: string) => void;
  /** Retries for network/server errors talking to the CA (acme-client default: 5). */
  networkRetries?: number;
}

/**
 * Get a certificate for a bare IP address from Let's Encrypt (generally
 * available since January 2026). IP certificates must use the "shortlived"
 * profile (about 6 days), so they're renewed automatically every few days.
 */
export async function issueIpCertificate(opts: IssueOptions): Promise<IssuedCertificate> {
  const log = opts.log ?? (() => {});
  if (opts.networkRetries != null) {
    (acme.axios.defaults as unknown as { acmeSettings: { retryMaxAttempts: number } }).acmeSettings.retryMaxAttempts = opts.networkRetries;
  }
  const accountKey = opts.accountKey ?? (await acme.crypto.createPrivateKey()).toString();
  const reuse = !!(opts.accountKey && opts.accountUrl);
  const client = new acme.Client({
    directoryUrl: opts.directoryUrl,
    accountKey,
    ...(reuse ? { accountUrl: opts.accountUrl } : {}),
    backoffAttempts: 12,
    backoffMin: 1000,
    backoffMax: 8000,
  });
  // Register once; renewals reuse the saved account instead of re-registering.
  if (!reuse) await client.createAccount({ termsOfServiceAgreed: true });
  log(`Requesting a certificate for ${opts.ip}`);
  const order = await client.createOrder({
    identifiers: [{ type: 'ip', value: opts.ip }],
    profile: 'shortlived',
  } as unknown as Parameters<typeof client.createOrder>[0]);

  for (const authz of await client.getAuthorizations(order)) {
    if (authz.status === 'valid') continue;
    const challenge = authz.challenges.find((c) => c.type === 'http-01');
    if (!challenge) throw new Error('The certificate authority offered no http-01 challenge for this address');
    const keyAuth = await client.getChallengeKeyAuthorization(challenge);
    opts.setChallenge(challenge.token, keyAuth);
    try {
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge);
    } finally {
      opts.setChallenge(challenge.token, null);
    }
  }

  const [key, csr] = await acme.crypto.createCsr({ altNames: [opts.ip] });
  const finalized = await client.finalizeOrder(order, csr);
  const certPem = await client.getCertificate(finalized);
  const info = acme.crypto.readCertificateInfo(certPem);
  log(`Certificate issued, valid until ${info.notAfter.toISOString()}`);
  return { certPem, keyPem: key.toString(), accountKey, accountUrl: client.getAccountUrl(), notAfter: info.notAfter.getTime() };
}
