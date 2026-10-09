import fastify from 'fastify';
import {
  RPC_HEADERS,
  RpcError,
  ServerToolTransport,
  type ServerTools,
  type ToolRpcRequest,
  type ToolRpcResponse,
} from '@isdk/tool-rpc';
import { defaultsDeep } from 'lodash-es';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';

/**
 * A concrete server transport implementation for Fastify.
 *
 * Based on the tool-rpc V2 transport architecture: physical Fastify routes
 * are normalized into ToolRpcRequest and processed through the shared
 * dispatcher pipeline (processIncomingCall), then written back via sendRpcResponse.
 */
export class FastifyServerToolTransport extends ServerToolTransport {
  public server: FastifyInstance;
  /** The tool registry used for dispatching RPC calls on this transport. */
  public registry: any;
  /** Path prefix (without trailing slash) that handles RPC calls. */
  protected rpcPrefix: string = '';
  /** Path prefix (without trailing slash) that handles tool discovery. */
  protected discoveryPrefix: string = '';

  constructor(server?: FastifyInstance | FastifyServerOptions, options?: any) {
    // Allow passing either a Fastify instance or plain Fastify server options
    super(FastifyServerToolTransport.normalizeOptions(server, options));
    this.server = (server && typeof (server as FastifyInstance).route === 'function')
      ? server as FastifyInstance
      : fastify(server as FastifyServerOptions);
    this.canStream = true;
  }

  private static normalizeOptions(server?: FastifyInstance | FastifyServerOptions, options?: any): any {
    if (server && typeof (server as FastifyInstance).route !== 'function' && !options) {
      // server is actually Fastify server options; surface transport options from it (e.g. apiUrl)
      return server;
    }
    return options;
  }

  /**
   * Convenience: mount the RPC + discovery routes for a tools registry
   * under the given API prefix.
   */
  public mount(serverTools: typeof ServerTools, apiPrefix: string, options?: any): void {
    this.registry = serverTools;
    this.addRpcHandler(apiPrefix, options);
    this.addDiscoveryHandler(apiPrefix, () => (serverTools as any).toJSON());
  }

  public addDiscoveryHandler(apiUrl: string, handler: () => any): void {
    if (!this.apiUrl) {this.apiUrl = apiUrl;}
    this.discoveryPrefix = this.toPathname(apiUrl);
    const discoveryRoute = async (request: FastifyRequest, reply: FastifyReply) => {
      const result = handler();
      reply.send(result);
    };
    // The HTTP client normalizes the discovery URL to `<prefix>/`, so register
    // both the exact prefix and its trailing-slash form (static routes win
    // over the parameterized RPC route in find-my-way).
    this.server.get(this.discoveryPrefix, discoveryRoute);
    if (this.discoveryPrefix !== '/') {
      this.server.get(`${this.discoveryPrefix}/`, discoveryRoute);
    }
    console.log(`[FastifyServerTransport] Mapped GET ${this.discoveryPrefix} for discovery`);
  }

  public addRpcHandler(apiUrl: string, options?: any): void {
    if (!this.apiUrl) {this.apiUrl = apiUrl;}
    this.rpcPrefix = this.toPathname(apiUrl);
    // /prefix/:toolId/:id? — toolId & optional resource id, mirroring the
    // URL layout produced by the HTTP client transport (rpc-fn header also works)
    this.server.all(`${this.rpcPrefix}/:toolId/:id?`, async (request, reply) => {
      // The pipeline replies on its own; sendRpcResponse keeps this handler
      // pending until the response has been flushed to the socket.
      await this.processIncomingCall(request, reply, this.registry);
    });
  }

  public async _start(options: { port?: number; host?: string } = {}): Promise<any> {
    options = defaultsDeep({}, options, this.options, { port: 3000, host: '0.0.0.0' });
    try {
      const result = await this.server.listen(options);
      console.log(`[FastifyServerTransport] Server listening on ${result}`);
      return result;
    } catch (err) {
      this.server.log.error(err);
      process.exit(1);
    }
  }

  public async stop(force?: boolean): Promise<void> {
    // Mirror HttpServerToolTransport: force drops lingering keep-alive sockets
    if (force) {this.server.server?.closeAllConnections?.();}
    return this.server.close();
  }

  public getRaw(): any {
    return this.server;
  }

  /**
   * Extract the route path from an apiUrl (full URL) or plain path prefix,
   * normalized without a trailing slash, like HttpServerToolTransport does.
   */
  protected toPathname(apiUrl: string): string {
    let pathname = apiUrl;
    if (/^https?:\/\//i.test(apiUrl)) {
      pathname = new URL(apiUrl).pathname;
    }
    if (!pathname.startsWith('/')) {pathname = `/${pathname}`;}
    return pathname.replace(/\/+$/, '');
  }

  /**
   * Normalize a Fastify request into the standard ToolRpcRequest envelope.
   */
  protected async toRpcRequest(request: FastifyRequest, reply?: FastifyReply): Promise<ToolRpcRequest> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (Array.isArray(v)) {
        headers[k] = v.join(',');
      } else if (v !== undefined) {
        headers[k] = v;
      }
    }

    const { toolId: pathToolId, id: pathId } = request.params as any;
    const toolId = headers[RPC_HEADERS.TOOL_ID] || pathToolId;
    const resId = headers[RPC_HEADERS.RES_ID] ?? pathId;

    const method = request.method;
    let params: any = {};
    if (method === 'GET' || method === 'DELETE') {
      const p = (request.query as any)?.p;
      try {
        params = p ? JSON.parse(p) : {};
      } catch (e: any) {
        throw new RpcError(`Malformed JSON params: ${e.message}`, 400);
      }
      headers['x-http-method'] = method;
    } else {
      params = request.body;
      if (typeof params === 'string') {
        try {
          params = JSON.parse(params);
        } catch (e: any) {
          throw new RpcError(`Malformed JSON body: ${e.message}`, 400);
        }
      }
      headers['x-http-method'] = method;
    }

    if (!toolId) {
      throw new RpcError('Missing routing information: rpc-fn header or :toolId path param', 400);
    }

    return {
      apiUrl: this.apiUrl || `http://${headers.host || 'localhost'}${this.rpcPrefix}/`,
      toolId,
      act: headers[RPC_HEADERS.ACT],
      resId,
      clientId: headers[RPC_HEADERS.CLIENT_ID],
      traceId: headers[RPC_HEADERS.TRACE_ID],
      requestId: headers[RPC_HEADERS.REQUEST_ID] || Date.now().toString(36) + Math.random().toString(36).substring(2),
      params: params || {},
      headers,
      raw: { _req: request.raw, _res: reply?.raw || null },
    };
  }

  /**
   * Write the normalized ToolRpcResponse back through the Fastify reply.
   */
  protected async sendRpcResponse(rpcRes: ToolRpcResponse, reply: FastifyReply): Promise<void> {
    const rawRes = reply.raw;
    if (rawRes.headersSent) {return;}

    if (rpcRes.headers) {
      for (const [k, v] of Object.entries(rpcRes.headers)) {
        reply.header(k, String(v));
      }
    }

    // [202 Accepted → 102 Processing]
    // HTTP clients cannot observe 102, so answer 202 with a status:102 body,
    // matching HttpServerToolTransport's contract.
    if (rpcRes.status === 102) {
      reply.status(202).header('content-type', 'application/json')
        .send(JSON.stringify(rpcRes.data || { status: 102, message: 'Task moved to background' }));
      return this.waitForReply(reply);
    }

    reply.status(rpcRes.status).header('content-type', 'application/json');

    if (rpcRes.error) {
      reply.send(JSON.stringify({ error: rpcRes.error }));
      return this.waitForReply(reply);
    }

    const result = rpcRes.data;
    if (result && typeof result.pipe === 'function') {
      // Node stream: hand it to Fastify, which pipes it to the raw response
      reply.send(result);
    } else if (result && typeof result.getReader === 'function') {
      // Web ReadableStream: Fastify pipes it natively
      reply.send(result);
    } else {
      // Serialize explicitly: Fastify writes string payloads verbatim, which
      // would emit invalid JSON for tools returning a plain string.
      reply.send(JSON.stringify(result === undefined ? null : result));
    }

    // Fastify's async-handler wrapper calls reply.send(undefined) when the
    // handler settles while the reply is still in flight, which would clobber
    // a streamed body with an empty one. Keep the handler pending until the
    // response is actually flushed.
    await this.waitForReply(reply);
  }

  protected waitForReply(reply: FastifyReply): Promise<void> {
    const raw = reply.raw;
    // 'close' may already have fired when the client aborted the request, and
    // a listener registered afterwards would never resolve.
    if (raw.writableEnded || raw.finished || raw.destroyed) {return Promise.resolve();}
    return new Promise(resolve => {
      raw.once('finish', resolve);
      raw.once('close', resolve);
    });
  }
}
