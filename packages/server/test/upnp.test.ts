import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { discover } from '../src/remote/upnp.js';
import { upnpRouter } from '../src/remote/router.js';

/** A fake ISP gateway: answers only to IGD version 1 searches and only accepts permanent leases. */
async function fakeGateway() {
  const mappings = new Map<number, { internal: number; client: string; desc: string }>();
  const searches: string[] = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/rootDesc.xml') {
        res.setHeader('Content-Type', 'text/xml');
        res.end(`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
  <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
  <friendlyName>XB8 &amp; friends</friendlyName>
  <serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service></serviceList>
  <deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
    <deviceList><device><deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
      <serviceList><service>
        <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
        <controlURL>/ctl/IPConn</controlURL>
      </service></serviceList>
    </device></deviceList>
  </device></deviceList>
</device></root>`);
        return;
      }
      if (req.url !== '/ctl/IPConn') return void res.writeHead(404).end();
      const action = String(req.headers.soapaction).split('#')[1].replace('"', '');
      const v = (k: string) => body.match(new RegExp(`<${k}>(.*?)</${k}>`))?.[1] ?? '';
      const ok = (inner = '') =>
        res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${inner}</u:${action}Response></s:Body></s:Envelope>`);
      const fault = (code: number, desc: string) =>
        res
          .writeHead(500)
          .end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
      if (action === 'GetExternalIPAddress') return ok('<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>');
      if (action === 'AddPortMapping') {
        if (v('NewLeaseDuration') !== '0') return fault(725, 'OnlyPermanentLeasesSupported');
        mappings.set(Number(v('NewExternalPort')), { internal: Number(v('NewInternalPort')), client: v('NewInternalClient'), desc: v('NewPortMappingDescription') });
        return ok();
      }
      if (action === 'DeletePortMapping') {
        if (!mappings.delete(Number(v('NewExternalPort')))) return fault(714, 'NoSuchEntryInArray');
        return ok();
      }
      fault(401, 'Invalid Action');
    });
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  const webPort = (web.address() as AddressInfo).port;

  const ssdp = dgram.createSocket('udp4');
  ssdp.on('message', (buf, rinfo) => {
    const st = buf.toString().match(/^ST:\s*(.*)$/im)?.[1].trim() ?? '';
    searches.push(st);
    if (st !== 'urn:schemas-upnp-org:device:InternetGatewayDevice:1') return;
    ssdp.send(
      `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nST: ${st}\r\nUSN: uuid:fake::${st}\r\nLOCATION: http://127.0.0.1:${webPort}/rootDesc.xml\r\n\r\n`,
      rinfo.port,
      rinfo.address,
    );
  });
  await new Promise<void>((r) => ssdp.bind(0, '127.0.0.1', r));
  const ssdpPort = ssdp.address().port;
  return {
    target: `127.0.0.1:${ssdpPort}`,
    mappings,
    searches,
    close: async () => {
      ssdp.close();
      await new Promise((r) => web.close(r));
    },
  };
}

test('finds an IGD version 1 router and forwards ports through it', async () => {
  const gw = await fakeGateway();
  try {
    const d = await discover({ timeoutMs: 3000, interfaces: ['127.0.0.1'], targets: [gw.target] });
    assert.ok(gw.searches.includes('urn:schemas-upnp-org:device:InternetGatewayDevice:1'));
    assert.ok(d.gateway, `no gateway found; seen: ${d.seen.join(', ')}`);
    assert.equal(d.gateway.name, 'XB8 & friends');
    assert.equal(d.gateway.serviceType, 'urn:schemas-upnp-org:service:WANIPConnection:1');
    assert.match(d.gateway.controlUrl, /\/ctl\/IPConn$/);

    const router = upnpRouter(d.gateway);
    assert.match(router.label, /UPnP router at 127\.0\.0\.1/);
    assert.equal(await router.externalIp(), '203.0.113.7');
    assert.equal(await router.map(4380, 80, 'Octavo (certificate check)'), 80);
    assert.deepEqual(gw.mappings.get(80), { internal: 4380, client: '127.0.0.1', desc: 'Octavo (certificate check)' });
    await router.unmap(4380);
    assert.equal(gw.mappings.has(80), false);
    await router.stop();
  } finally {
    await gw.close();
  }
});

test('reports nothing found when no router answers', async () => {
  const silent = dgram.createSocket('udp4');
  await new Promise<void>((r) => silent.bind(0, '127.0.0.1', r));
  try {
    const d = await discover({ timeoutMs: 800, interfaces: ['127.0.0.1'], targets: [`127.0.0.1:${silent.address().port}`] });
    assert.equal(d.gateway, null);
    assert.deepEqual(d.seen, []);
    assert.deepEqual(d.searchedFrom, ['127.0.0.1']);
  } finally {
    silent.close();
  }
});
