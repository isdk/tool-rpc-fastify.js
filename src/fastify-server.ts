import type { BindOptions, RouteRemountMode, ServerTools, ToolRpcRequest, ToolRpcResponse } from '@isdk/tool-rpc';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
  RouteShorthandOptions,
} from 'fastify';

import { canonicalPhysicalUri, RPC_HEADERS, RpcError, ServerToolTransport, unixSocketUri } from '@isdk/tool-rpc';

import fastify from 'fastify';
import { defaultsDeep } from 'lodash-es';

/**
 * What to do when a route is claimed again on a prefix this transport already
 * serves. The option itself lives in `@isdk/tool-rpc` (`RouteRemountMode`) so
 * every server transport shares one semantics; it is re-exported here.
 *
 * - `'replace'` (default): the new registry / discovery handler takes over the
 *   existing route, and a warning is logged.
 * - `'throw'`: `onDuplicateRoute()` fires, and this transport's override lets
 *   find-my-way raise its own `FST_ERR_DUPLICATED_ROUTE`.
 */
export type RemountMode = RouteRemountMode;

/**
 * Options accepted by `addRpcHandler()` / `addDiscoveryHandler()` / `mount()`.
 * Everything except `registry` and `remount` is passed straight through to
 * Fastify as route options (`preHandler`, `bodyLimit`, `schema`, `logLevel`,
 * `config`, ...).
 */
export interface FastifyRpcHandlerOptions extends RouteShorthandOptions {
  /**
   * Registry used to dispatch the calls matched by this route. Defaults to the
   * registry passed to `mount()`. Set it explicitly when mounting several
   * registries on one transport.
   */
  registry?: any;
  /**
   * How to handle a route that is already mounted at the same path. Defaults to
   * `'replace'`; pass `'throw'` to get Fastify's duplicate-route error instead.
   */
  remount?: RemountMode;
}

/** Key under which a route handler tags its request with its own route prefix. */
const RPC_ROUTE_CTX = Symbol('tool-rpc-fastify.rpcRoute');

/**
 * A concrete server transport implementation for Fastify.
 *
 * Based on the tool-rpc V2 transport architecture: physical Fastify routes
 * are normalized into ToolRpcRequest and processed through the shared
 * dispatcher pipeline (processIncomingCall), then written back via sendRpcResponse.
 *
 * Per-prefix bookkeeping (apiUrl / registry / discovery handler, and what a
 * repeated claim means) is inherited from `ServerToolTransport`, so several
 * prefixes on one transport never clobber each other.
 */
export class FastifyServerToolTransport extends ServerToolTransport {
  public server: FastifyInstance;
  /** The tool registry used for dispatching RPC calls on this transport. */
  public registry: any;
  /** Path prefix (without trailing slash, '/' for root) of the last RPC route claimed. */
  protected rpcPrefix: string = '';
  /** Physical listen address, recorded once `_start()` has resolved. */
  protected listenAddr?: string;
  /** Stable identity per Fastify instance, used as the physical listen address. */
  private static readonly instanceKeys = new WeakMap<object, string>();
  private static instanceSeq = 0;

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
   *
   * Several mounts can share one transport, each with its own prefix and
   * registry; `options.remount` decides what a second mount on an already
   * mounted prefix does ('replace' by default, 'throw' for Fastify's error).
   */
  public mount(serverTools: typeof ServerTools, apiPrefix: string, options?: FastifyRpcHandlerOptions): void {
    // The registry is bound per route so a second mount() cannot re-point the
    // first prefix at the new registry. this.registry is assigned last so a
    // mount rejected by `remount: 'throw'` keeps dispatching the old one.
    this.addRpcHandler(apiPrefix, { ...options, registry: options?.registry ?? serverTools });
    this.addDiscoveryHandler(apiPrefix, () => (serverTools as any).toJSON(), options);
    this.registry = serverTools;
  }

  public addDiscoveryHandler(apiUrl: string, handler: () => any, options: FastifyRpcHandlerOptions = {}): void {
    if (!this.apiUrl) {this.apiUrl = apiUrl;}
    const { registry: _registry, remount, ...routeOptions } = options;
    // Claiming is what decides replace/throw; a null claim means the physical
    // routes already exist and only the handler was swapped.
    const claim = this.claimRoute(apiUrl, 'discovery', { discoveryHandler: handler, remount });
    if (!claim) {return;}
    const prefix = claim.prefix;
    // The HTTP client normalizes the discovery URL to `<prefix>/`, so register
    // both the exact prefix and its trailing-slash form (static routes win
    // over the parameterized RPC route in find-my-way).
    const paths = prefix === '/' ? ['/'] : [prefix, `${prefix}/`];
    for (const path of paths) {
      this.server.get(path, routeOptions, async (_request: FastifyRequest, reply: FastifyReply) => {
        // Resolved at request time: re-mounting the same prefix swaps the handler
        // instead of re-registering the route (no FST_ERR_DUPLICATED_ROUTE).
        const latest = this.routeDiscoveryHandler(prefix);
        reply.send(latest ? latest() : null);
      });
    }
    console.log(`[FastifyServerTransport] Mapped GET ${prefix} for discovery`);
  }

  public addRpcHandler(apiUrl: string, options: FastifyRpcHandlerOptions = {}): void {
    if (!this.apiUrl) {this.apiUrl = apiUrl;}
    const { registry, remount, ...routeOptions } = options;
    const claim = this.claimRoute(apiUrl, 'rpc', { registry, remount });
    if (!claim) {
      // Re-mounting the same prefix replaces the registry (last one wins) rather
      // than throwing FST_ERR_DUPLICATED_ROUTE. Route options of the first
      // registration stay in effect.
      return;
    }
    const prefix = this.rpcPrefix = claim.prefix;
    // /prefix/:toolId/:id? — toolId & optional resource id, mirroring the
    // URL layout produced by the HTTP client transport (rpc-fn header also works)
    const routePath = `${prefix === '/' ? '' : prefix}/:toolId/:id?`;
    this.server.all(routePath, routeOptions, async (request, reply) => {
      (request as any)[RPC_ROUTE_CTX] = prefix;
      // The pipeline replies on its own; sendRpcResponse keeps this handler
      // pending until the response has been flushed to the socket.
      await this.processIncomingCall(request, reply, this.routeRegistry(prefix) ?? this.registry);
    });
  }

  /**
   * `remount: 'throw'` hook: re-register the route so find-my-way raises its own
   * `FST_ERR_DUPLICATED_ROUTE` rather than a parallel error type. If the router
   * tolerated the duplicate (e.g. `ignoreDuplicateRoutes`), fall back to the
   * base class error.
   */
  protected onDuplicateRoute(prefix: string, kind: 'rpc' | 'discovery'): never {
    if (kind === 'rpc') {
      this.server.all(`${prefix === '/' ? '' : prefix}/:toolId/:id?`, {}, () => {});
    } else {
      this.server.get(prefix, {}, () => {});
    }
    return super.onDuplicateRoute(prefix, kind);
  }

  public async _start(options: BindOptions = {}): Promise<any> {
    // 同一个 socket 路径在不同 transport / Node 版本里叫法不同（path / socketPath /
    // socket）：声明身份三个都认，监听时也必须一样。声明了 socket 就不补默认
    // 端口：port 与 path 同时给出时 Node 会丢掉 path，声明身份与真实监听就会错开。
    const declared: BindOptions = defaultsDeep({}, options, this.options);
    const listenOptions: Record<string, any> = { ...declared };
    const socket = listenOptions.path ?? listenOptions.socketPath ?? listenOptions.socket;
    if (socket) {
      listenOptions.path = String(socket);
      delete listenOptions.port;
      delete listenOptions.host;
    } else {
      // Fastify 只认 path，port 必须是数（options 里可能是环境变量那种字符串）
      listenOptions.port = Number(listenOptions.port ?? this.defaultBindOptions().port);
    }
    delete listenOptions.socketPath;
    delete listenOptions.socket;
    try {
      const result = await this.server.listen(listenOptions);
      this.listenAddr = this.toListenAddr(result);
      console.log(`[FastifyServerTransport] Server listening on ${result}`);
      return result;
    } catch (err) {
      // A library must not kill the host process: EADDRINUSE and friends have to
      // stay catchable by the caller (and by tests).
      this.server.log.error(err);
      throw err;
    }
  }

  /**
   * Declared identity from `apiUrl`: the physical base this transport serves, as
   * a canonical URI (scheme + authority, no path). Transports sharing one Fastify
   * instance (or one URL origin) share a base, which is what RpcTransportManager's
   * route-conflict audit keys on. The base class returns `apiUrl`, which carries
   * the path and therefore hides real conflicts.
   *
   * Available before start(). It only changes when the caller *declares* a bind
   * through start() options (see applyBindOptions); an OS-assigned port (0) never
   * moves it, so the audit key stays queryable across the start boundary.
   * When apiUrl has no URL form (a bare path prefix), a synthetic key stands in.
   */
  protected apiUrlIdentity(): string {
    if (/^https?:\/\//i.test(this.apiUrl || '')) {
      // 与 HttpServerToolTransport 用同一个归一化实现，两边才能对上 key：
      // 回环别名（127.0.0.1 / [::1] / localhost）、默认端口、尾斜杠全部归一。
      return canonicalPhysicalUri(this.apiUrl as string);
    }
    // 没有 URL 表示（只共享一个 in-process 实例）：造一个 URI 代替，
    // scheme 就是它的命名空间。
    return FastifyServerToolTransport.instanceKey(this.server);
  }

  /**
   * What `_start()` falls back to when the caller declares nothing. These have
   * to match it exactly: a bare path prefix carries no authority at all, so the
   * bind (options plus these defaults) is the only statement about the physical
   * base there is. Without it such a transport stays keyed on the instance
   * placeholder and can never be compared against an HTTP transport on the same
   * port — or share that port's socket.
   */
  protected defaultBindOptions(): BindOptions {
    return { port: 3000, host: '0.0.0.0' };
  }

  /**
   * Observed bind: the address reported by `listen()`, only available after
   * start(). Use it for logs and to complete the declared identity when the port
   * was assigned by the OS. Never an audit or pool key.
   */
  public getBoundAddress(): string | undefined {
    return this.listenAddr;
  }

  private static instanceKey(instance: object): string {
    let key = FastifyServerToolTransport.instanceKeys.get(instance);
    if (!key) {
      key = `fastify://instance-${++FastifyServerToolTransport.instanceSeq}`;
      FastifyServerToolTransport.instanceKeys.set(instance, key);
    }
    return key;
  }

  /**
   * Observed bind, as a URI. Fastify resolves a TCP listen with a URL and a
   * unix-socket listen with the bare socket path (实测), so the string branch has
   * to tell them apart rather than assume a URL.
   */
  protected toListenAddr(listenResult: any): string | undefined {
    if (typeof listenResult === 'string') {
      return /^https?:\/\//i.test(listenResult) ? listenResult : unixSocketUri(listenResult);
    }
    if (listenResult && typeof listenResult === 'object') {
      const { address, port, socketPath } = listenResult as any;
      if (socketPath) {return unixSocketUri(socketPath);}
      if (address && port) {return `http://${address}:${port}`;}
    }
    return undefined;
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
   * Normalize a Fastify request into the standard ToolRpcRequest envelope.
   */
  protected async toRpcRequest(request: FastifyRequest, reply?: FastifyReply): Promise<ToolRpcRequest> {
    // The route handler tags the request with its own prefix, so a request is
    // always attributed to the mount that matched it, not to the last one.
    const route = this.routeClaims.get((request as any)[RPC_ROUTE_CTX] as string);
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

    const rpcPrefix = route?.prefix ?? this.rpcPrefix;
    return {
      apiUrl: route?.apiUrl
        || this.apiUrl
        || `http://${headers.host || 'localhost'}${rpcPrefix === '/' ? '' : rpcPrefix}/`,
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
