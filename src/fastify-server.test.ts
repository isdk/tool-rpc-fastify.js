import type { FastifyInstance } from 'fastify';
import {
  ClientTools,
  HttpClientToolTransport,
  RpcTransportManager,
  ServerTools,
} from '@isdk/tool-rpc';

import { findPort } from '@isdk/util';
import fastify from 'fastify';

import { FastifyServerToolTransport } from './fastify-server';

describe('serverTools/ClientTools Test', () => {
  let serverInstance: FastifyInstance;
  let serverTransport: FastifyServerToolTransport;
  let client: typeof ClientTools;
  let apiRoot: string;

  beforeAll(async () => {
    ServerTools.items = {};
    ClientTools.items = {};
    // 1. Register a tool on the server side
    ServerTools.register({
      name: 'calculator',
      isApi: true,
      func: ({ a, b }: { a: number; b: number }) => {
        return a + b;
      },
    });

    // Register a tool that throws an error
    ServerTools.register({
        name: 'divider',
        isApi: true,
        func: () => { throw new Error('test error from server') },
    });

    // 2. Setup the server transport
    const port = await findPort(3000);
    apiRoot = `http://localhost:${port}/api`;

    serverInstance = fastify();
    serverTransport = new FastifyServerToolTransport(serverInstance);
    serverTransport.addRpcHandler(apiRoot);
    serverTransport.addDiscoveryHandler(apiRoot, () => ServerTools.toJSON());
    await serverTransport.start({ port, host: 'localhost' });

    // V2 client wiring: bind the scheme once and connect a scoped client.
    // ClientTools.setTransport is deprecated — the transport is now resolved
    // per apiUrl by RpcTransportManager (see RpcClientTransportManager.getClient).
    RpcTransportManager.bindScheme(['http', 'https'], HttpClientToolTransport);
    client = ClientTools.connect(apiRoot);
  });

  afterAll(async () => {
    await serverTransport.stop();
    RpcTransportManager.clearSchemes();
  });

  it('should correctly call a remote tool from the client', async () => {
    // 1. Load tool definitions from the server (discovery)
    await client.loadFrom();

    // 2. Get the dynamically created client-side tool stub
    const calculatorTool = client.get('calculator');
    expect(calculatorTool).toBeInstanceOf(ClientTools);

    // 3. Run the tool. This will trigger the client transport to make an HTTP call.
    const result = await calculatorTool!.run({ a: 40, b: 2 });

    // 4. Assert the result returned from the server
    expect(result).toBe(42);
  });

  it('should handle remote errors correctly', async () => {
    // the transport is resolved by apiUrl through the manager's instance cache
    const dividerTool = client.get('divider');

    // Expect the run command to reject with an error from the server
    await expect(dividerTool!.run({})).rejects.toThrow('test error from server');
  });
});

describe('fastifyServerToolTransport extras', () => {
  let serverTransport: FastifyServerToolTransport;
  let apiRoot: string;

  beforeAll(async () => {
    ServerTools.items = {};
    ClientTools.items = {};

    ServerTools.register({
      name: 'boom',
      isApi: true,
      func: () => {
        const err: any = new Error('bad input');
        err.code = 400;
        throw err;
      },
    });

    ServerTools.register({
      name: 'streamer',
      isApi: true,
      stream: true,
      func: () => {
        const enc = new TextEncoder();
        return new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('chunk-a'));
            controller.enqueue(enc.encode('chunk-b'));
            controller.close();
          },
        });
      },
    } as any);

    const port = await findPort(3100);
    apiRoot = `http://localhost:${port}/api`;

    // mount() is the shorthand for addRpcHandler + addDiscoveryHandler
    serverTransport = new FastifyServerToolTransport(fastify());
    serverTransport.mount(ServerTools, apiRoot);
    await serverTransport.start({ port, host: 'localhost' });
  });

  afterAll(async () => {
    await serverTransport.stop();
  });

  it('should stream a ReadableStream payload through the fastify reply', async () => {
    const clientTransport = new HttpClientToolTransport(apiRoot);
    const res = (await clientTransport._fetch('streamer', { stream: true }, 'run')) as Response;
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('chunk-achunk-b');
  });

  it('should map business error codes onto the http status', async () => {
    const clientTransport = new HttpClientToolTransport(apiRoot);
    await expect(clientTransport._fetch('boom', {}, 'run')).rejects.toThrow(/bad input/);
  });

  it('should 404 for unknown tools', async () => {
    const res = await fetch(`${apiRoot}/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'rpc-fn': 'nope' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
