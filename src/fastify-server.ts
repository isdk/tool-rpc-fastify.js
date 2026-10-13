import type {
  BindOptions, RouteRemountMode, ServerTools,
  ServerToolTransportOptions, ToolRpcRequest, ToolRpcResponse,
} from '@isdk/tool-rpc';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
  RouteShorthandOptions,
} from 'fastify';

import {
  normalizeHostAndPort, normalizeListenBind,
  RPC_HEADERS, RpcError, ServerToolTransport, socketAddressFromBind,
  socketAddressFromListen,
} from '@isdk/tool-rpc';

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
  /** 监听后的真实地址（`port: 0` 时只有内核知道端口），`getListenAddr()` 之后就用它。 */
  protected listenAddr?: string;
  /** 本轮 `start()` 的 bind 参数；地址由它 + apiUrl 算出，所以得存下来。 */
  protected bindOptions?: BindOptions;
  /** Stable identity per Fastify instance, used as the physical listen address. */
  private static readonly instanceKeys = new WeakMap<object, string>();
  private static instanceSeq = 0;

  /**
   * @param server a Fastify instance, or plain Fastify server options (they are
   *   also read as transport options when no `options` argument is given, so
   *   `{ apiUrl, identity, credentialReader, dispatcher, manager }` can be passed
   *   in either argument — see `normalizeOptions`).
   */
  constructor(server?: FastifyInstance | FastifyServerOptions, options?: ServerToolTransportOptions) {
    // Allow passing either a Fastify instance or plain Fastify server options
    const transportOptions = FastifyServerToolTransport.normalizeOptions(server, options);
    super(transportOptions);
    this.server = (server && typeof (server as FastifyInstance).route === 'function')
      ? server as FastifyInstance
      : fastify(server as FastifyServerOptions);
    // The transport-wide default registry. `mount()` deliberately does **not** write
    // it: a registry belongs to the prefix it was mounted at, and this one is the
    // fallback for prefixes that declared none (see `requestRegistry` in core).
    this.registry = (transportOptions as any)?.registry;
    this.canStream = true;
  }

  private static normalizeOptions(server?: FastifyInstance | FastifyServerOptions, options?: ServerToolTransportOptions): ServerToolTransportOptions | undefined {
    if (server && typeof (server as FastifyInstance).route !== 'function' && !options) {
      // server is actually Fastify server options; surface transport options from it (e.g. apiUrl)
      return server as ServerToolTransportOptions;
    }
    return options;
  }

  /**
   * Convenience: mount the RPC routes (and with them the built-in discovery
   * endpoint) for a tools registry under the given API prefix.
   *
   * Several mounts can share one transport, each with its own prefix and
   * registry; `options.remount` decides what a second mount on an already
   * mounted prefix does ('replace' by default, 'throw' for Fastify's error).
   */
  public mount(serverTools: typeof ServerTools, apiPrefix: string, options?: FastifyRpcHandlerOptions): void {
    // The registry is bound to the prefix (the route claim), never to the transport:
    // a second mount() cannot re-point the first prefix at the new registry, and the
    // built-in discovery tool lists the registry bound to the *matched* prefix.
    // A mount rejected by `remount: 'throw'` therefore keeps dispatching the old one.
    this.addRpcHandler(apiPrefix, { ...options, registry: options?.registry ?? serverTools });
  }

  /**
   * @deprecated Discovery is served by the built-in `rpcApis` tool through the
   * route table, so `addRpcHandler()` is enough. Keep this only to override what
   * the listing contains for this prefix — the handler becomes that prefix's
   * `rpcApis` implementation (core's `requestRegistry` maps the reserved id to it),
   * so it still goes through identity, validation and timeout.
   */
  public addDiscoveryHandler(apiUrl: string, handler: () => any, options: FastifyRpcHandlerOptions = {}): void {
    this.warnDiscoveryDeprecated();
    if (!this.apiUrl) {this.apiUrl = apiUrl;}
    const { registry, remount, ...routeOptions } = options;
    // Claiming is what decides replace/throw; a null claim means the prefix is
    // already claimed and only the handler was swapped.
    const claim = this.claimRoute(apiUrl, 'discovery', { discoveryHandler: handler, registry, remount });
    const prefix = claim?.prefix ?? this.toPathname(apiUrl);
    // No hand-written manifest route: the prefix root goes through the pipeline like
    // every other call, and the route table resolves it to `rpcApis`. A route that
    // answered the manifest directly would bypass identity and validation — business
    // APIs requiring a credential while the tool list stays anonymous (core issue #4).
    this.ensureRootRoutes(prefix, routeOptions);
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
    this.ensureRootRoutes(prefix, routeOptions);
    this.ensureParamRoute(prefix, routeOptions);
    console.log(`[FastifyServerTransport] Mapped ${prefix} (rpc + built-in discovery)`);
  }

  /** Physical routes this transport has already registered, per claimed prefix. */
  private physicalRoutes = new Set<string>();

  /**
   * The prefix root: `GET <prefix>` / `GET <prefix>/` is how the HTTP client asks
   * for the tool manifest, and the route table turns it into a call of the built-in
   * `rpcApis` tool. Both spellings are bound (static routes win over the
   * parameterized RPC route in find-my-way).
   */
  private ensureRootRoutes(prefix: string, routeOptions: RouteShorthandOptions): void {
    if (this.physicalRoutes.has(`root:${prefix}`)) {return;}
    this.physicalRoutes.add(`root:${prefix}`);
    for (const path of this.rootRoutePaths(prefix)) {
      this.server.all(path, routeOptions, this.routeHandler(prefix));
    }
  }

  private ensureParamRoute(prefix: string, routeOptions: RouteShorthandOptions): void {
    if (this.physicalRoutes.has(`param:${prefix}`)) {return;}
    this.physicalRoutes.add(`param:${prefix}`);
    // /prefix/:toolId/:id? — toolId & optional resource id, mirroring the
    // URL layout produced by the HTTP client transport (rpc-fn header also works)
    this.server.all(`${prefix === '/' ? '' : prefix}/:toolId/:id?`, routeOptions, this.routeHandler(prefix));
  }

  private rootRoutePaths(prefix: string): string[] {
    return prefix === '/' ? ['/'] : [prefix, `${prefix}/`];
  }

  private routeHandler(prefix: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      (request as any)[RPC_ROUTE_CTX] = prefix;
      // No explicit registry: core resolves it per prefix (claim -> transport ->
      // dispatcher -> system reserved), which is what makes the built-in discovery
      // tool list the matched prefix's tools, and what lets a custom
      // `addDiscoveryHandler` override that prefix's listing.
      // The pipeline replies on its own; sendRpcResponse keeps this handler
      // pending until the response has been flushed to the socket.
      await this.processIncomingCall(request, reply);
    };
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
      for (const path of this.rootRoutePaths(prefix)) {
        this.server.all(path, {}, () => {});
      }
    }
    return super.onDuplicateRoute(prefix, kind);
  }

  /**
   * The prefix this request was matched by, taken from the tag the route handler
   * put on it — the same value the physical dispatch already settled on, so the
   * registry layers, the route table and the identity context never re-derive it
   * (and never disagree with the route that actually answered).
   */
  protected matchedPrefix(rpcReq: ToolRpcRequest): string | undefined {
    const claimed = (rpcReq as any)[RPC_ROUTE_CTX] ?? (rpcReq.raw?._req as any)?.[RPC_ROUTE_CTX];
    if (claimed) {return claimed;}
    return super.matchedPrefix(rpcReq);
  }

  /**
   * Identity ctx preparation: the policy's delivery channel (`deliver: 'header:x'`)
   * speaks the Node `ServerResponse` shape (`res.setHeader`), which a FastifyReply
   * does not have — its setter is `header()`. Hand it `reply.raw` instead, so a
   * session credential really reaches the client over Fastify. Headers set here are
   * still flushed: Fastify writes its own with `writeHead`, which keeps prior
   * `setHeader` values unless it overrides the same name.
   */
  protected async resolveRequestIdentity(rpcReq: ToolRpcRequest, rawReq?: any, rawRes?: any): Promise<void> {
    const res = (rawRes && typeof rawRes.header === 'function' && rawRes.raw) ? rawRes.raw : rawRes;
    return super.resolveRequestIdentity(rpcReq, rawReq, res);
  }

  public async _start(options: BindOptions = {}): Promise<any> {
    // 地址由 apiUrl + 本轮 bind 参数算出，所以先存下参数（getListenAddr 要用）
    this.bindOptions = options;

    // 同一个 socket 路径在不同 transport / Node 版本里叫法不同（path / socketPath /
    // socket）：声明身份三个都认，监听时也必须一样——别名与「socket 优先于
    // host/port」这条规则在 core 的 normalizeListenBind 里，与 HTTP transport 同一份。
    // 声明了 socket 就不补默认端口：port 与 path 同时给出时 Node 会丢掉 path，
    // 声明身份与真实监听就会错开。
    const declared: BindOptions = defaultsDeep({}, options, this.options);
    const listenOptions: Record<string, any> = { ...declared };
    const bind = normalizeListenBind(declared);
    if (bind.socket) {
      listenOptions.path = bind.socket;
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
      // 地址定下来了（`port: 0` 可能换了端口），审计条目跟着迁移
      this.registerRoutes();
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
   * 本服务可被访问的地址：监听前是声明值（apiUrl + `start({ host, port, path })`），
   * 监听后是 `listen()` 报的真实地址 —— 也就是别人真能访问到的那个。
   *
   * 框架把它当不透明字符串（审计 key、日志），地址语义归本 transport：
   * 监听前走 `socketAddressFromBind`、监听后走 `socketAddressFromListen`，两个都是
   * core 里与 `HttpServerToolTransport` **同一份**实现（里面叠了 `normalizeSocketAddress`
   * 的写法规范化：回环别名 127.0.0.1 / [::1] / localhost、默认端口、尾斜杠全部归一），
   * 所以两边才能对上 key。
   */
  public getListenAddr(): string {
    return this.listenAddr ?? this.declaredAddress();
  }

  /**
   * 由 apiUrl 与本轮 bind 参数算出的地址（尚未监听时）。规则在 core 的
   * `socketAddressFromBind`，与 `HttpServerToolTransport` 同一份：同一个端口上两边要
   * 报同一个 key，审计才能对上。
   *
   * 不传 `bindDefaults`：apiUrl 是裸 path 前缀且本轮没声明 bind 时，**不**补默认端口——
   * 共享实例可能已经由别人监听，未监听的 transport 不该假装自己占着某个端口。
   */
  private declaredAddress(): string {
    const identity = socketAddressFromBind({ apiUrl: this.apiUrl, bind: this.bindOptions });
    if (identity) {return identity;}
    // 既没监听也没声明底座（只共享一个 in-process 实例）：造一个 URI 代替，
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
    // 观测值 → 地址的规则在 core 的 socketAddressFromListen，与 HttpServerToolTransport
    // 同一份：TCP 给 URL 字符串、unix 给裸路径，两边都过同一个规范化（否则
    // `127.0.0.1` 观测与 `localhost` 声明对不上 key）。
    return socketAddressFromListen(listenResult);
  }

  public async stop(force?: boolean): Promise<void> {
    // 释放本实例占的审计条目（与 HttpServerToolTransport 一致）。
    // 不调就会把路由永久锁在审计表上：stop 后同一前缀再上服务必报 Routing Conflict。
    this.unregisterRoutes();
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

    const { toolId: pathToolId, id: pathId } = (request.params ?? {}) as any;
    let toolId = headers[RPC_HEADERS.TOOL_ID];
    let act = headers[RPC_HEADERS.ACT];
    let resId = headers[RPC_HEADERS.RES_ID];

    // Route table first, exactly like the HTTP transport: the built-in discovery row
    // (`GET <prefix root>` -> `rpcApis`) and any third-party `addRoute()` row are
    // resolved here, so discovery is an ordinary call — identity, validation and
    // timeout included. An `rpc-fn` header is explicit addressing and outranks path.
    if (!toolId) {
      const relPath = pathToolId ? `/${pathId ? `${pathToolId}/${pathId}` : pathToolId}` : '/';
      const entry = route
        ? this.matchRouteEntry(route.prefix, { path: relPath, method: request.method, act })
        : undefined;
      if (entry) {
        toolId = entry.toolId;
        if (entry.act) {act = entry.act;}
        if (entry.resId !== undefined && resId === undefined) {resId = entry.resId;}
      } else if (pathToolId) {
        toolId = pathToolId;
        if (resId === undefined) {resId = pathId;}
      }
    }

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
      // An empty route table means this transport claimed no prefix at all — the
      // built-in discovery endpoint is part of a prefix, so say that rather than
      // sending the reader off to fix their URL.
      throw new RpcError(`Missing routing information: rpc-fn header or :toolId path param${this.emptyRouteTableHint()}`, 400);
    }

    const rpcPrefix = route?.prefix ?? this.rpcPrefix;
    const rpcReq: ToolRpcRequest = {
      // The Host header is client-controlled and this value feeds the manager's
      // SSRF / allow-list matching, so it has to be normalized first: `Host:
      // LocalHost` must not dodge a rule written against `localhost`.
      apiUrl: route?.apiUrl
        || this.apiUrl
        || `http://${normalizeHostAndPort(headers.host || '') || 'localhost'}${rpcPrefix === '/' ? '' : rpcPrefix}/`,
      toolId,
      act,
      resId,
      clientId: headers[RPC_HEADERS.CLIENT_ID],
      traceId: headers[RPC_HEADERS.TRACE_ID],
      requestId: headers[RPC_HEADERS.REQUEST_ID] || Date.now().toString(36) + Math.random().toString(36).substring(2),
      params: params || {},
      headers,
      raw: { _req: request.raw, _res: reply?.raw || null },
    };
    // Carry the matched prefix on the request: `matchedPrefix()` (registry layers,
    // route table, identity ctx) reads it instead of re-deriving it from apiUrl.
    if (route) {(rpcReq as any)[RPC_ROUTE_CTX] = route.prefix;}
    return rpcReq;
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
