// @vitest-environment node

import {
  RPC_APIS_TOOL_ID,
  RpcBearerPolicy,
  RpcSessionIdentityPolicy,
  RpcTransportManager,
  ServerTools,
} from '@isdk/tool-rpc';

import { findPort } from '@isdk/util';
import fastify from 'fastify';

import { FastifyServerToolTransport } from './fastify-server';

class Reg extends ServerTools {}

function resetRegistry() {
  Reg.items = {};
  // NOTE: registered tool funcs stay self-contained — ToolFunc serializes them via
  // toString() so they can migrate to a remote runtime.
  Reg.register({ name: 'whoA', isApi: true, func: () => 'A' });
  Reg.register({
    name: 'whoami',
    isApi: true,
    func(this: any) {return this.ctx?.identity?.id ?? null;},
  } as any);
}

const post = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
};

/** Always drains the body: an unread body stalls undici's keep-alive pool. */
async function http(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text), headers: res.headers };
}

describe('fastify transport: discovery runs through the pipeline (core issue #4)', () => {
  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistry();
    const port = await findPort(4100);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify(), {
      identity: new RpcBearerPolicy({
        verify: (token: string) => (token === 'good' ? { id: 'user-1' } : undefined),
        allowAnonymous: false,
      }),
    });
    transport.mount(Reg, '/api');
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('refuses anonymous discovery instead of answering with the manifest', async () => {
    // A hand-written `server.get(prefix)` used to reply here with the listing, so
    // business APIs required a credential while the tool list stayed anonymous.
    for (const path of ['/api', '/api/']) {
      const res = await http(`${base}${path}`);
      expect(res.status).toBe(401);
      expect(res.text).not.toContain('whoA');
    }
    // the reserved id the HTTP client uses for loadApis() is refused the same way
    const reserved = await http(`${base}/api/${RPC_APIS_TOOL_ID}`, {
      headers: { 'rpc-act': 'get' },
    });
    expect(reserved.status).toBe(401);

    expect((await http(`${base}/api/whoA`, post)).status).toBe(401);
  });

  it('serves the manifest once the credential checks out', async () => {
    const res = await http(`${base}/api/`, { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['whoA', 'whoami']);

    const reserved = await http(`${base}/api/${RPC_APIS_TOOL_ID}`, {
      headers: { authorization: 'Bearer good', 'rpc-act': 'get' },
    });
    expect(reserved.status).toBe(200);
    expect(Object.keys(reserved.json()).sort()).toEqual(['whoA', 'whoami']);
  });

  it('never publishes the tool body in the listing', async () => {
    const res = await http(`${base}/api/`, { headers: { authorization: 'Bearer good' } });
    expect(JSON.stringify(res.json())).not.toContain('function');
  });
});

describe('fastify transport: per-API authentication is a policy predicate', () => {
  let transport: FastifyServerToolTransport;
  let base: string;
  const seen: Array<{ toolId?: string, prefix?: string, tool: any }> = [];

  beforeAll(async () => {
    resetRegistry();
    const port = await findPort(4110);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify(), {
      identity: new RpcBearerPolicy({
        verify: (token: string) => (token === 'good' ? { id: 'user-1' } : undefined),
        // discovery is an ordinary toolId, so the predicate needs no special case
        allowAnonymous: (ctx: any) => {
          seen.push({ toolId: ctx.toolId, prefix: ctx.prefix, tool: ctx.tool });
          return ctx.toolId === RPC_APIS_TOOL_ID;
        },
      }),
    });
    transport.mount(Reg, '/api');
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('lets the listing through anonymously but requires a credential for tools', async () => {
    expect((await http(`${base}/api/`)).status).toBe(200);
    expect((await http(`${base}/api/whoA`, post)).status).toBe(401);
    expect((await http(`${base}/api/whoA`, { ...post, headers: { ...post.headers, authorization: 'Bearer good' } })).json()).toBe('A');
  });

  it('hands the policy the matched prefix and the registry tool instance', async () => {
    seen.length = 0;
    // the predicate is consulted when there is no usable credential, so an
    // authenticated listing would never reach it — ask for the listing anonymously
    await http(`${base}/api/`);
    await http(`${base}/api/whoA`, { ...post, headers: { ...post.headers, authorization: 'Bearer bad' } });

    const listing = seen.find(entry => entry.toolId === RPC_APIS_TOOL_ID);
    expect(listing?.prefix).toBe('/api');
    // the built-in endpoint is resolved through the same layered registry
    expect(listing?.tool).toBeTruthy();

    const business = seen.find(entry => entry.toolId === 'whoA');
    expect(business?.prefix).toBe('/api');
    expect(business?.tool).toBeTruthy();
  });
});

describe('fastify transport: session credential delivery (ctx.res)', () => {
  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistry();
    const port = await findPort(4120);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify(), {
      identity: new RpcSessionIdentityPolicy({ deliver: 'header:rpc-session' }),
      // the built-in reader only knows `authorization`, so the loop needs a reader
      credentialReader: (req: any) => req?.headers?.['rpc-session'],
    });
    transport.mount(Reg, '/api');
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('delivers the credential on the Fastify response and reuses the identity', async () => {
    const first = await http(`${base}/api/whoA`, post);
    expect(first.status).toBe(200);
    // FastifyReply has no setHeader(); the transport hands the policy reply.raw, so
    // `deliver: 'header:<name>'` still reaches the client.
    const credential = first.headers.get('rpc-session');
    expect(credential).toBeTruthy();

    const anonymous = (await http(`${base}/api/whoami`, post)).json();
    expect(anonymous).toBeTruthy();

    const resumed = (await http(`${base}/api/whoami`, {
      ...post,
      headers: { ...post.headers, 'rpc-session': credential! },
    })).json();
    expect(resumed).toBeTruthy();
    expect(resumed).not.toBe(anonymous);
  });
});

describe('fastify transport: rejected requests reach the manager hook', () => {
  const rejected: Array<{ toolId?: string, requestId?: string, message?: string }> = [];

  class AuditManager extends RpcTransportManager {
    public onRequestRejected(request: any, err: any): void {
      rejected.push({ toolId: request?.toolId, requestId: request?.requestId, message: err?.message });
    }
  }

  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistry();
    const port = await findPort(4130);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify(), {
      manager: new AuditManager(),
      identity: new RpcBearerPolicy({ verify: () => undefined, allowAnonymous: false }),
    });
    transport.mount(Reg, '/api');
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('records the 401 attempt and echoes the client req-id back', async () => {
    rejected.length = 0;
    const res = await http(`${base}/api/`, { headers: { 'req-id': 'abc123' } });
    expect(res.status).toBe(401);
    // the calls a client cannot correlate with its own request id are the failed ones
    expect(res.headers.get('req-id')).toBe('abc123');
    expect(rejected).toEqual([
      { toolId: RPC_APIS_TOOL_ID, requestId: 'abc123', message: 'Unauthenticated' },
    ]);
  });
});

describe('fastify transport: route table rows are ordinary routes', () => {
  it('a third-party addRoute() row replaces the built-in listing', async () => {
    resetRegistry();
    Reg.register({ name: 'myListing', isApi: true, func: () => ({ custom: { name: 'custom' } }) });

    const port = await findPort(4140);
    const base = `http://127.0.0.1:${port}`;
    const transport = new FastifyServerToolTransport(fastify());
    transport.addRpcHandler('/api', { registry: Reg });
    transport.addRoute('/api', { path: '/', when: { method: 'GET' }, toolId: 'myListing' });
    await transport.start({ port, host: '127.0.0.1' });
    try {
      const res = await http(`${base}/api/`);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ custom: { name: 'custom' } });
    } finally {
      await transport.stop();
    }
  });

  it('a deprecated addDiscoveryHandler overrides the listing but not the pipeline', async () => {
    resetRegistry();
    const port = await findPort(4150);
    const base = `http://127.0.0.1:${port}`;
    const transport = new FastifyServerToolTransport(fastify(), {
      identity: new RpcBearerPolicy({ verify: () => undefined, allowAnonymous: false }),
    });
    transport.addRpcHandler('/api', { registry: Reg });
    transport.addDiscoveryHandler('/api', () => ({ legacy: { name: 'legacy' } }));
    await transport.start({ port, host: '127.0.0.1' });
    try {
      expect((await http(`${base}/api/`)).status).toBe(401);
    } finally {
      await transport.stop();
    }

    // without a policy the custom listing is what the prefix answers
    const open = new FastifyServerToolTransport(fastify());
    open.addRpcHandler('/api', { registry: Reg });
    open.addDiscoveryHandler('/api', () => ({ legacy: { name: 'legacy' } }));
    const openPort = await findPort(4151);
    await open.start({ port: openPort, host: '127.0.0.1' });
    try {
      const res = await http(`http://127.0.0.1:${openPort}/api/`);
      expect(res.json()).toEqual({ legacy: { name: 'legacy' } });
    } finally {
      await open.stop();
    }
  });

  it('claims discovery first and rpc second without losing either', async () => {
    // the other order: declare the listing, then mount the business registry on the same
    // prefix. Both physical routes must exist, and the custom listing must survive the
    // second claim (which only replaces the registry).
    resetRegistry();
    const port = await findPort(4152);
    const transport = new FastifyServerToolTransport(fastify());
    transport.addDiscoveryHandler('/api', () => ({ legacy: { name: 'legacy' } }));
    transport.addRpcHandler('/api', { registry: Reg });
    await transport.start({ port, host: '127.0.0.1' });
    try {
      const listing = await http(`http://127.0.0.1:${port}/api/`);
      expect(listing.status).toBe(200);
      expect(listing.json()).toEqual({ legacy: { name: 'legacy' } });

      const call = await http(`http://127.0.0.1:${port}/api/whoA`, post);
      expect(call.status).toBe(200);
      expect(call.json()).toBe('A');
    } finally {
      await transport.stop();
    }
  });

  it('says what to call next when no prefix was claimed', async () => {
    const transport = new FastifyServerToolTransport(fastify());
    // `raw.url` is what a FastifyRequest always carries; addressing reads that, not
    // find-my-way's params. A request with no path segments and no claim is the one
    // case where nothing can be addressed at all.
    const fakeRequest = { method: 'POST', headers: {}, params: {}, body: {}, raw: { url: '/' } };
    await expect((transport as any).toRpcRequest(fakeRequest))
      .rejects.toThrow(/addRpcHandler\(apiUrl\) or addRoute/);
  });

  it('normalizes the client-controlled Host before it becomes apiUrl', async () => {
    // apiUrl feeds the manager's SSRF / allow-list matching, so `Host: LocalHost.`
    // must not survive as a spelling that dodges a rule written against `localhost`
    const transport = new FastifyServerToolTransport(fastify());
    transport.addRpcHandler('/api', { registry: Reg });
    (transport as any).apiUrl = undefined;

    const rpc = await (transport as any).toRpcRequest({
      method: 'POST',
      headers: { host: 'LocalHost.' },
      params: { toolId: 'whoA' },
      body: {},
      raw: { url: '/api/whoA' },
    });
    expect(rpc.apiUrl).toBe('http://localhost/api/');
  });
});
