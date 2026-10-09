// @vitest-environment node

import {
  ClientTools,
  HttpClientToolTransport,
  RpcTransportManager,
  ServerTools,
} from '@isdk/tool-rpc';

import { findPort } from '@isdk/util';
import fastify from 'fastify';

import { FastifyServerToolTransport } from './fastify-server';

describe('fastify transport: timeout & 102 background polling', () => {
  let serverTransport: FastifyServerToolTransport;
  let client: typeof ClientTools;
  let apiRoot: string;

  beforeAll(async () => {
    ServerTools.items = {};
    ClientTools.items = {};

    // NOTE: registered tool funcs must stay self-contained — ToolFunc serializes
    // them via toString() so they can migrate to a remote runtime, so any closed
    // over module scope helper would be lost.

    // Hard timeout: metadata timeout wins over a larger client timeout
    ServerTools.register({
      name: 'slow-tool',
      isApi: true,
      timeout: 500,
      async func (this: any, { delay = 1000 }: { delay?: number }) {
        const signal = this.ctx?.signal;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay, 'done');
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('Aborted by signal'));
            }, { once: true });
          }
        });
      },
    } as any);

    // Soft timeout: the task is moved to the background and answers 102
    ServerTools.register({
      name: 'slow-poll-tool',
      isApi: true,
      timeout: { value: 100, keepAliveOnTimeout: true },
      func: async ({ delay = 300 }: { delay?: number }) => {
        await new Promise(resolve => setTimeout(resolve, delay));
        return `poll-done-${delay}`;
      },
    } as any);

    // Soft timeout + stream: the stream is delivered through the poll response
    ServerTools.register({
      name: 'slow-stream-tool',
      isApi: true,
      stream: true,
      timeout: { value: 100, keepAliveOnTimeout: true },
      func: async ({ delay = 300 }: { delay?: number }) => {
        await new Promise(resolve => setTimeout(resolve, delay));
        const enc = new TextEncoder();
        return new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('start'));
            controller.enqueue(enc.encode('end'));
            controller.close();
          },
        });
      },
    } as any);

    const port = await findPort(3300);
    apiRoot = `http://localhost:${port}/api`;

    serverTransport = new FastifyServerToolTransport(fastify());
    serverTransport.mount(ServerTools, apiRoot);
    await serverTransport.start({ port, host: 'localhost' });

    // V2: the transport is resolved per apiUrl by the transport manager,
    // instead of the deprecated ClientTools.setTransport
    RpcTransportManager.bindScheme(['http', 'https'], HttpClientToolTransport);
    client = ClientTools.connect(apiRoot);
    await client.loadFrom();
  });

  afterAll(async () => {
    await serverTransport.stop(true);
    RpcTransportManager.clearSchemes();
    ServerTools.items = {};
    ClientTools.items = {};
  });

  it('should expose timeout metadata through discovery', () => {
    const slowTool = client.get('slow-tool');
    expect(slowTool.timeout).toBe(500);
  });

  it('should answer 504 when the server-side tool timeout wins', async () => {
    const slowTool = client.get('slow-tool');
    try {
      // Client asks for 2000ms but the tool declares 500ms -> server times out at 500ms
      await slowTool.run({ delay: 1000 }, { timeout: 2000 });
      throw new Error('Should have thrown 504');
    } catch (err: any) {
      expect(err.code).toBe(504);
      expect(err.message).toMatch(/Timeout/i);
    }
  });

  it('should honour a shorter client-side timeout override', async () => {
    const slowTool = client.get('slow-tool');
    const started = Date.now();
    try {
      await slowTool.run({ delay: 1000 }, { timeout: 100 });
      throw new Error('Should have thrown 504');
    } catch (err: any) {
      expect(err.code).toBe(504);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('should propagate an AbortSignal from the client', async () => {
    const slowTool = client.get('slow-tool');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    try {
      await slowTool.run({ delay: 1000 }, { signal: controller.signal });
      throw new Error('Should have aborted');
    } catch (err: any) {
      expect(err.name).toBe('AbortError');
    }
  });

  it('should answer 202 with a status:102 envelope for background tasks', async () => {
    const res = await fetch(`${apiRoot}/slow-poll-tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'rpc-fn': 'slow-poll-tool',
        'rpc-timeout': '100',
      },
      body: JSON.stringify({ delay: 400 }),
    });

    expect(res.status).toBe(202);
    expect(res.headers.get('rpc-retry-after')).toBeTruthy();
    expect(res.headers.get('req-id')).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: 102 });
  });

  it('should complete a background task through rpcTask polling', async () => {
    // 100ms soft timeout vs 300ms work -> 102, then the client polls rpcTask
    // until the task settles. Driven through the raw transport because a
    // discovered ClientTools stub also arms a client-side timer at the
    // negotiated timeout, which races the 102 response over HTTP.
    const rawClient = new HttpClientToolTransport(apiRoot);
    expect(await rawClient.fetch('slow-poll-tool', { delay: 300 })).toBe('poll-done-300');
  });

  it('should poll a background task that runs several times longer than its soft timeout', async () => {
    const rawClient = new HttpClientToolTransport(apiRoot);
    expect(await rawClient.fetch('slow-poll-tool', { delay: 600 })).toBe('poll-done-600');
  });

  it('should stream a slow-start tool via 102 polling', async () => {
    const rawClient = new HttpClientToolTransport(apiRoot);
    const res = (await rawClient.fetch('slow-stream-tool', { delay: 300, stream: true }, 'run')) as Response;

    expect(res.status).toBe(200);
    expect(typeof res.body?.getReader).toBe('function');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {break;}
      body += decoder.decode(value, { stream: true });
    }
    expect(body).toBe('startend');
  });

  it('should keep hard timeouts and background polling independent when concurrent', async () => {
    const slowTool = client.get('slow-tool');
    const rawClient = new HttpClientToolTransport(apiRoot);

    const results = await Promise.allSettled([
      slowTool.run({ delay: 500 }, { timeout: 200 }),
      rawClient.fetch('slow-poll-tool', { delay: 300 }),
    ]);

    expect(results[0].status).toBe('rejected');
    expect((results[0] as any).reason.code).toBe(504);
    expect(results[1].status).toBe('fulfilled');
    expect((results[1] as any).value).toBe('poll-done-300');
  });
});
