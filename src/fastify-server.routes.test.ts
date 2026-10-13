import type { FastifyInstance } from 'fastify';
import { unlinkSync } from 'node:fs';
import nodeHttp from 'node:http';
import { HttpServerToolTransport, RpcTransportManager, ServerTools } from '@isdk/tool-rpc';

import { findPort } from '@isdk/util';
import fastify from 'fastify';

import { FastifyServerToolTransport } from './fastify-server';

/** Two independent registries, to prove a mount stays bound to its own tools. */
class RegA extends ServerTools {}
class RegB extends ServerTools {}

function resetRegistries() {
  RegA.items = {};
  RegB.items = {};
  RegA.register({ name: 'whoA', isApi: true, func: () => 'A' });
  RegB.register({ name: 'whoB', isApi: true, func: () => 'B' });
}

const post = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
};

/** Always drains the response body: an unread body stalls undici's keep-alive pool. */
async function http(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  return {
    status: res.status,
    text,
    headers: res.headers,
    json: () => JSON.parse(text),
  };
}

describe('fastifyServerToolTransport: root mount', () => {
  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistries();
    const port = await findPort(3950);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify());
    // used to throw 'The path could not be empty' from find-my-way
    transport.mount(RegA, '/');
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('registers discovery and RPC routes at the root prefix', async () => {
    const discovery = await http(`${base}/`);
    expect(discovery.status).toBe(200);
    expect(discovery.json()).toHaveProperty('whoA');

    const res = await http(`${base}/whoA`, post);
    expect(res.status).toBe(200);
    expect(res.json()).toBe('A');
  });

  it('normalizes an empty apiUrl to the root instead of an empty route path', () => {
    const t = new FastifyServerToolTransport(fastify());
    expect(() => t.mount(RegA, '')).not.toThrow();
    expect((t as any).rpcPrefix).toBe('/');
    expect(t.server.printRoutes()).toContain(':toolId');
  });

  it('never builds a double-slash apiUrl for a root mount', async () => {
    const t = new FastifyServerToolTransport(fastify());
    t.mount(RegA, '/');
    const fakeRequest = {
      method: 'POST',
      headers: { host: 'example.test' },
      params: { toolId: 'whoA' },
      body: {},
      // addressing comes from the raw URL (what Fastify hands over), not from params
      raw: { url: '/whoA' },
    };
    const rpc = await (t as any).toRpcRequest(fakeRequest);
    expect(rpc.apiUrl).toBe('/');
    // the host-based fallback must not produce 'http://host//'
    (t as any).apiUrl = undefined;
    const fallback = await (t as any).toRpcRequest(fakeRequest);
    expect(fallback.apiUrl).toBe('http://example.test/');
  });
});

describe('fastifyServerToolTransport: addRpcHandler options', () => {
  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistries();
    const port = await findPort(3960);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify());
    transport.mount(RegA, '/api', {
      // async on purpose: a Fastify hook must return a promise or call done(),
      // a plain sync hook stalls the request lifecycle
      preHandler: async (request, reply) => {
        if (request.headers['x-deny']) {
          reply.code(401).send({ error: 'denied by preHandler' });
        }
      },
      bodyLimit: 32,
    });
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('runs a preHandler passed through mount options', async () => {
    const res = await http(`${base}/api/whoA`, {
      ...post,
      headers: { ...post.headers, 'x-deny': '1' },
    });
    expect(res.status).toBe(401);
    expect(res.json().error).toBe('denied by preHandler');
  });

  it('enforces bodyLimit passed through mount options', async () => {
    const res = await http(`${base}/api/whoA`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ big: 'x'.repeat(500) }),
    });
    expect(res.status).toBe(413);
  });

  it('still serves plain calls when options are given', async () => {
    const res = await http(`${base}/api/whoA`, post);
    expect(res.status).toBe(200);
    expect(res.json()).toBe('A');
  });
});

describe('fastifyServerToolTransport: listen failures', () => {
  it('rejects on EADDRINUSE instead of exiting the process', async () => {
    resetRegistries();
    const port = await findPort(3970);
    const first = new FastifyServerToolTransport(fastify());
    first.mount(RegA, '/api');
    await first.start({ port, host: '127.0.0.1' });

    const clash = new FastifyServerToolTransport(fastify());
    clash.mount(RegA, '/api');
    await expect(clash.start({ port, host: '127.0.0.1' })).rejects.toMatchObject({ code: 'EADDRINUSE' });

    // If _start() still called process.exit(1), none of this would run.
    const survivor = new FastifyServerToolTransport(fastify());
    survivor.mount(RegB, '/api');
    const addr = await survivor.start({ port: port + 1, host: '127.0.0.1' });
    expect(addr).toBe(`http://127.0.0.1:${port + 1}`);
    const res = await http(`http://127.0.0.1:${port + 1}/api/whoB`, post);
    expect(res.json()).toBe('B');

    await first.stop();
    await survivor.stop();
  });
});

describe('fastifyServerToolTransport: several mounts on one transport', () => {
  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistries();
    const port = await findPort(3980);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify());
    transport.mount(RegA, '/a');
    transport.mount(RegB, '/b');
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('dispatches each prefix through its own registry', async () => {
    expect((await http(`${base}/a/whoA`, post)).json()).toBe('A');
    expect((await http(`${base}/b/whoB`, post)).json()).toBe('B');
    // the first mount must not see the second registry (it used to)
    expect((await http(`${base}/a/whoB`, post)).status).toBe(404);
    expect((await http(`${base}/b/whoA`, post)).status).toBe(404);
  });

  it('serves each prefix discovery document separately', async () => {
    const a = (await http(`${base}/a/`)).json();
    const b = (await http(`${base}/b/`)).json();
    expect(Object.keys(a)).toEqual(['whoA']);
    expect(Object.keys(b)).toEqual(['whoB']);
  });
});

describe('fastifyServerToolTransport: re-mounting the same prefix', () => {
  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistries();
    const port = await findPort(3990);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify());
    transport.mount(RegA, '/dup');
    // used to throw FST_ERR_DUPLICATED_ROUTE
    expect(() => transport.mount(RegB, '/dup')).not.toThrow();
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('replaces the registry and the discovery handler instead of duplicating routes', async () => {
    expect((await http(`${base}/dup/whoA`, post)).status).toBe(404);
    expect((await http(`${base}/dup/whoB`, post)).json()).toBe('B');
    const discovery = (await http(`${base}/dup/`)).json();
    expect(Object.keys(discovery)).toEqual(['whoB']);
  });
});

describe('fastifyServerToolTransport: remount option', () => {
  it("raises FST_ERR_DUPLICATED_ROUTE with remount: 'throw' and keeps the first mount", async () => {
    resetRegistries();
    const port = await findPort(4000);
    const base = `http://127.0.0.1:${port}`;
    const transport = new FastifyServerToolTransport(fastify());
    transport.mount(RegA, '/strict');

    let err: any;
    try {
      transport.mount(RegB, '/strict', { remount: 'throw' });
    } catch (e) {err = e;}
    expect(err?.code).toBe('FST_ERR_DUPLICATED_ROUTE');
    // the rejected mount must not have re-pointed the prefix at RegB: the registry is
    // bound to the route claim, and `transport.registry` stays the transport-wide
    // default (unset here), so a mount never leaks into the other prefixes
    expect((transport as any).routeClaims.get('/strict').registry).toBe(RegA);
    expect(transport.registry).toBeUndefined();

    await transport.start({ port, host: '127.0.0.1' });
    expect((await http(`${base}/strict/whoA`, post)).json()).toBe('A');
    expect((await http(`${base}/strict/whoB`, post)).status).toBe(404);
    expect(Object.keys((await http(`${base}/strict/`)).json())).toEqual(['whoA']);
    await transport.stop();
  });

  it("throws for a duplicated discovery route too, with remount: 'throw'", () => {
    resetRegistries();
    const transport = new FastifyServerToolTransport(fastify());
    transport.addDiscoveryHandler('/disc', () => RegA.toJSON());
    expect(() => transport.addDiscoveryHandler('/disc', () => RegB.toJSON())).not.toThrow();
    let err: any;
    try {
      transport.addDiscoveryHandler('/disc', () => RegA.toJSON(), { remount: 'throw' });
    } catch (e) {err = e;}
    expect(err?.code).toBe('FST_ERR_DUPLICATED_ROUTE');
  });

  it("replaces handlers when remount: 'replace' is passed explicitly", async () => {
    resetRegistries();
    const port = await findPort(4010);
    const base = `http://127.0.0.1:${port}`;
    const transport = new FastifyServerToolTransport(fastify());
    transport.mount(RegA, '/swap');
    expect(() => transport.mount(RegB, '/swap', { remount: 'replace' })).not.toThrow();
    await transport.start({ port, host: '127.0.0.1' });
    expect((await http(`${base}/swap/whoB`, post)).json()).toBe('B');
    expect(Object.keys((await http(`${base}/swap/`)).json())).toEqual(['whoB']);
    await transport.stop();
  });

  it('mounts different prefixes with remount: \'throw\' without conflict', () => {
    resetRegistries();
    const transport = new FastifyServerToolTransport(fastify());
    expect(() => {
      transport.mount(RegA, '/one', { remount: 'throw' });
      transport.mount(RegB, '/two', { remount: 'throw' });
    }).not.toThrow();
    expect(transport.getRoutes().sort()).toEqual(['/one', '/two']);
  });
});

describe('fastifyServerToolTransport: physical address and route audit', () => {
  let transport: FastifyServerToolTransport;

  afterAll(async () => {
    const mgr: any = RpcTransportManager.instance;
    mgr.routeAudit?.clear?.();
    mgr.servers?.clear?.();
    mgr.transports?.clear?.();
    if (transport) {await transport.stop();}
  });

  it('reports one logical route per mount prefix', () => {
    resetRegistries();
    transport = new FastifyServerToolTransport(fastify());
    transport.mount(RegA, 'http://localhost:3985/api');
    expect(transport.getListenAddr()).toBe('http://localhost:3985');
    // the physical find-my-way patterns ('/api/', '/api/:toolId/:id?') are an
    // implementation detail; the audit keys on the logical prefix
    expect(transport.getRoutes()).toEqual(['/api']);
    transport.mount(RegB, 'http://localhost:3985/v2');
    expect(transport.getRoutes().sort()).toEqual(['/api', '/v2']);
  });

  it('lets the transport manager detect a real routing conflict on one address', () => {
    const mgr = RpcTransportManager.instance;
    const t1 = new FastifyServerToolTransport(fastify());
    t1.mount(RegA, 'http://localhost:3986/api1');
    const t2 = new FastifyServerToolTransport(fastify());
    t2.mount(RegB, 'http://localhost:3986/api2');
    mgr.registerServer(t1);
    expect(() => mgr.registerServer(t2)).not.toThrow();

    const t3 = new FastifyServerToolTransport(fastify());
    t3.mount(RegA, 'http://localhost:3986/api1');
    expect(() => mgr.registerServer(t3)).toThrow(/Routing Conflict/);
  });

  it('releases its audit entries on stop so the same route can be claimed again', async () => {
    // 以前 stop() 不释放审计条目：同一个前缀再上服务就永久报 Routing Conflict
    // （HttpServerToolTransport 一直是对的，两边行为此处必须一致）。
    const mgr = new RpcTransportManager();
    const port = await findPort(3993);

    const t1 = new FastifyServerToolTransport(fastify());
    t1.mount(RegA, `http://localhost:${port}/api`);
    mgr.registerServer(t1);
    await t1.start({ port, host: '127.0.0.1' });
    await t1.stop();

    const t2 = new FastifyServerToolTransport(fastify());
    t2.mount(RegB, `http://localhost:${port}/api`);
    expect(() => mgr.registerServer(t2)).not.toThrow();
    await t2.stop();
  });

  it('detects a conflict between a Fastify transport and an HTTP transport on one base', () => {
    // 跳 transport 类的审计以前完全失效：Fastify 返回 origin URL，HTTP 返回 host:port。
    // 现在两边都是 canonical URI，连 host 写法不同（127.0.0.1 vs localhost）也能对上。
    const mgr = RpcTransportManager.instance;

    const fastifyT = new FastifyServerToolTransport(fastify());
    fastifyT.mount(RegA, 'http://127.0.0.1:3988/api');
    mgr.registerServer(fastifyT);

    const httpT = new HttpServerToolTransport({ apiUrl: 'http://localhost:3988/api' });
    httpT.addRpcHandler('http://localhost:3988/api');

    // 审计在 bind 之前发生：不必真去监听就能拦下同一底座上的重复路由
    expect(() => mgr.registerServer(httpT)).toThrow(/Routing Conflict/);
  });

  it('groups transports that share one Fastify instance', () => {
    const shared: FastifyInstance = fastify();
    const t1 = new FastifyServerToolTransport(shared);
    t1.addRpcHandler('/same');
    const t2 = new FastifyServerToolTransport(shared);
    t2.addRpcHandler('/other');
    expect(t1.getListenAddr()).toBe(t2.getListenAddr());
  });

  it('keeps one address across the start boundary (loopback spellings fold)', async () => {
    const port = await findPort(3987);
    const t = new FastifyServerToolTransport(fastify());
    t.mount(RegA, `http://localhost:${port}/api`);

    const declared = t.getListenAddr();
    await t.start({ port, host: '127.0.0.1' });

    // 只有一个地址概念：监听后它跟着真实底座，而 `127.0.0.1` 与 `localhost`
    // 是同一个 socket 的两种写法，所以审计 key 不漂
    expect(declared).toBe(`http://localhost:${port}`);
    expect(t.getListenAddr()).toBe(declared);

    await t.stop();
  });

  it('moves the declared identity to the port declared at start()', async () => {
    const stale = await findPort(3989);
    const used = await findPort(3990);
    const t = new FastifyServerToolTransport(fastify());
    t.mount(RegA, `http://localhost:${stale}/api`);
    expect(t.getListenAddr()).toBe(`http://localhost:${stale}`);

    await t.start({ port: used, host: '127.0.0.1' });

    // apiUrl 里的端口已经过时：start 的参数才是真正声明的底座，
    // 而监听后地址就是那个真实底座
    expect(t.getListenAddr()).toBe(`http://localhost:${used}`);

    await t.stop();
  });

  it('turns a bare path prefix into a real base once a bind is declared', async () => {
    const mgr = RpcTransportManager.instance;
    const port = await findPort(3991);
    const t = new FastifyServerToolTransport(fastify());
    t.mount(RegA, '/api');
    // 未监听时没有任何底座可声明，只能用实例占位
    expect(t.getListenAddr()).toMatch(/^fastify:\/\/instance-\d+$/);

    await t.start({ port, host: '127.0.0.1' });
    expect(t.getListenAddr()).toBe(`http://localhost:${port}`);

    // 现在它能和 HTTP transport 对上同一个底座（以前永远对不上）
    const httpT = new HttpServerToolTransport({ apiUrl: `http://localhost:${port}/api` });
    httpT.addRpcHandler(`http://localhost:${port}/api`);
    mgr.registerServer(t);
    expect(() => mgr.registerServer(httpT)).toThrow(/Routing Conflict/);

    await t.stop();
  });

  it('declares the unix socket it listens on as its base, and serves over it', async () => {
    const mgr = RpcTransportManager.instance;
    const socket = `/tmp/tool-rpc-fastify-${process.pid}-${Date.now()}.sock`;
    const t = new FastifyServerToolTransport(fastify());
    t.mount(RegA, '/api');
    try {
      await t.start({ path: socket });

      expect(t.getListenAddr()).toBe(`unix:${socket}`);

      // 真的能过那个 socket 服务：发现路由返回注册表 JSON
      const body = await new Promise<string>((resolve, reject) => {
        nodeHttp.get({ socketPath: socket, path: '/api/' }, res => {
          res.setEncoding('utf8');
          let data = '';
          res.on('data', chunk => {data += chunk;});
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      expect(Object.keys(JSON.parse(body))).toEqual(['whoA']);

      // 同一个 socket 上的另一个 transport 必须被审计拦住
      const other = new HttpServerToolTransport({ apiUrl: `unix:${socket}` });
      other.addRpcHandler('/api');
      mgr.registerServer(t);
      expect(() => mgr.registerServer(other)).toThrow(/Routing Conflict/);

      await t.stop();
    } finally {
      try {unlinkSync(socket);} catch { /* Fastify 关闭时已清理 */ }
    }
  });
});

describe('fastifyServerToolTransport: path addressing is core\'s, not find-my-way\'s', () => {
  let transport: FastifyServerToolTransport;
  let base: string;

  beforeAll(async () => {
    resetRegistries();
    const port = await findPort(3996);
    base = `http://127.0.0.1:${port}`;
    transport = new FastifyServerToolTransport(fastify());
    transport.mount(RegA, '/api');
    // a two-segment row: reachable as `/a/b`, never as `/a%2Fb`
    transport.addRoute('/api', { path: '/a/b', toolId: 'whoA' });
    await transport.start({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await transport.stop();
  });

  it('folds empty segments instead of losing the tool id', async () => {
    // find-my-way hands `/api//whoA` over as params { toolId: '', id: 'whoA' }, which
    // addressed nothing (400). The HTTP transport folds the empty segment; so must this.
    const res = await http(`${base}/api//whoA`, post);
    expect(res.status).toBe(200);
    expect(res.json()).toBe('A');
  });

  it('keeps an encoded slash inside one segment', async () => {
    const row = await http(`${base}/api/a/b`, post);
    expect(row.status).toBe(200);
    expect(row.json()).toBe('A');

    // find-my-way decodes `%2F` into a separator, which would address the `/a/b` row
    // from a URL the HTTP transport reports as missing.
    const encoded = await http(`${base}/api/a%2Fb`, post);
    expect(encoded.status).toBe(404);
  });

  it('treats a trailing slash as the same path', async () => {
    const res = await http(`${base}/api/whoA/`, post);
    expect(res.status).toBe(200);
    expect(res.json()).toBe('A');
  });

  it('answers a non-GET at the prefix root through the pipeline', async () => {
    // The prefix root is claimed for every method, so an unaddressed method reaches the
    // pipeline and gets 400 (what the HTTP transport answers) instead of a framework 404.
    // Consequence worth knowing: a CORS preflight on the prefix needs its own route
    // registered before the mount, otherwise it lands here.
    const res = await http(`${base}/api/`, { method: 'OPTIONS' });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Missing routing information/);
  });
});

describe('fastifyServerToolTransport: re-mounting a prefix', () => {
  it('replaces the registry but keeps the first registration route options', async () => {
    resetRegistries();
    const port = await findPort(3997);
    const t = new FastifyServerToolTransport(fastify());
    t.mount(RegA, '/api', {
      // async on purpose: Fastify's hook contract treats a two-argument hook as
      // promise-style, so a sync one here would hang the request instead of erroring.
      preHandler: async (_req, reply) => {
        reply.header('x-mount', 'first');
      },
    });
    // `remount: 'replace'` (default): the registry swaps, while the physical route — and
    // with it its hooks / schema / bodyLimit — stays the one registered first.
    t.mount(RegB, '/api');
    await t.start({ port, host: '127.0.0.1' });
    try {
      const res = await http(`http://127.0.0.1:${port}/api/whoB`, post);
      expect(res.status).toBe(200);
      expect(res.json()).toBe('B');
      expect(res.headers.get('x-mount')).toBe('first');
    } finally {
      await t.stop();
    }
  });
});
