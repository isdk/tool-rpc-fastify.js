# @isdk/tool-rpc-fastify

**中文文档：** [README.cn.md](README.cn.md) · **English:** README.md

> ✨ **Fastify HTTP server transport for the `ToolFunc` framework**
> Expose your tools over HTTP with Fastify, and call them from any `@isdk/tool-rpc` client as if they were local functions.

[![npm version](https://img.shields.io/npm/v/@isdk/tool-rpc-fastify.svg?style=flat-square)](https://www.npmjs.com/package/@isdk/tool-rpc-fastify)
[![Vitest Tests](https://img.shields.io/badge/tests-vitest-green?style=flat-square)](https://vitest.dev/)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-blue?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-purple?style=flat-square)](./LICENSE-MIT)

```bash
npm install @isdk/tool-rpc-fastify fastify
```

`fastify` is a peer dependency (`*`, tested against Fastify 5). `@isdk/tool-rpc` ships as a runtime dependency of this package.

Built on [`@isdk/tool-rpc`](https://github.com/isdk/tool-rpc) — client-server RPC and RESTful communication tools based on [`@isdk/tool-func`](https://github.com/isdk/ai-tool). This package only supplies the **physical HTTP layer**: routes are normalized into `ToolRpcRequest` and executed by the shared `RpcServerDispatcher` pipeline.

## 🌟 Features

- ✅ **Fastify native** — bring your own `FastifyInstance` (hooks, plugins, content type parsers stay yours) or let the transport create one.
- ✅ **Automatic tool discovery** — a `GET` route publishes the registered tool metadata; clients generate stubs from it.
- ✅ **RPC over plain HTTP** — works with `fetch`, browsers, curl, and any HTTP client; no custom socket protocol.
- ✅ **Streaming responses** — both Node streams and Web `ReadableStream` results are flushed to the reply (`canStream = true`).
- ✅ **Timeout & background tasks** — soft timeouts answer `202` + `status: 102`, and the client polls `rpcTask` until the task settles.
- ✅ **Type-safe** — tool definitions and calls are typed end to end.

## 🚀 Quick Start

### 1. Create the server

`server.ts`:

```typescript
import { ServerTools } from '@isdk/tool-rpc'
import { FastifyServerToolTransport } from '@isdk/tool-rpc-fastify'

// 1. Register tools on the server side
ServerTools.register({
  name: 'calculator',
  isApi: true,
  func: ({ a, b }: { a: number; b: number }) => a + b,
})

// 2. Mount the RPC + discovery routes for the registry under /api
const serverTransport = new FastifyServerToolTransport()
serverTransport.mount(ServerTools, '/api')

// 3. Start listening
serverTransport.start({ port: 3000, host: '0.0.0.0' }).then(() => {
  console.log('Server is running on http://localhost:3000')
})
```

> Tool functions are serialized with `toString()` so they can migrate to a remote runtime. Keep them **self-contained**, or declare the shared names in the tool's `scope` field — see **Function serialization & `scope`** below.

### 2. Create the client

`client.ts`:

```typescript
import {
  ClientTools,
  HttpClientToolTransport,
  RpcTransportManager,
} from '@isdk/tool-rpc'

const apiUrl = 'http://localhost:3000/api'

async function main() {
  // 1. Bind the url scheme to a client transport implementation.
  //    ClientTools.setTransport is deprecated: transports are resolved
  //    per apiUrl by the transport manager now.
  RpcTransportManager.bindScheme(['http', 'https'], HttpClientToolTransport)

  // 2. Connect and load the tool definitions (discovery)
  const client = ClientTools.connect(apiUrl)
  await client.loadFrom()

  // 3. Get the generated client-side stub and call it
  const calculator = client.get('calculator')
  const result = await calculator!.run({ a: 40, b: 2 })

  console.log('The result is:', result) // The result is: 42
}

main()
```

`ClientTools.connect(apiUrl)` returns a **scoped subclass** with its own `apiUrl` and `items`, so discovered stubs live on the returned class — use `client.get(...)`, not `ClientTools.get(...)`. This keeps multiple servers isolated.

### 3. Run it

```bash
# In one terminal
npx tsx server.ts

# In another terminal
npx tsx client.ts
```

## 🔌 Embedding into an existing Fastify app

Pass your own instance; the transport only adds routes to it.

```typescript
import fastify from 'fastify'
import { ServerTools } from '@isdk/tool-rpc'
import { FastifyServerToolTransport } from '@isdk/tool-rpc-fastify'

const app = fastify({ logger: true })

app.addHook('onRequest', async (req) => {
  // your auth / cors / rate limit hooks still run for RPC routes
})

const transport = new FastifyServerToolTransport(app, {
  apiUrl: 'http://localhost:3000/tools',
})
transport.mount(ServerTools, 'http://localhost:3000/tools')

// your own routes coexist with the RPC routes
app.get('/health', async () => ({ ok: true }))

app.listen({ port: 3000, host: '0.0.0.0' })
```

`transport.getRaw()` returns the underlying `FastifyInstance`.

## 🧵 Function serialization & `scope`

Tool definitions are portable. When a tool is exported (`allowExportFunc: true`), persisted, or migrated to another runtime, its `func` is serialized with `toString()` — **only the source text travels**, so anything captured from the surrounding module scope is gone on the other side:

```typescript
import { slugify } from './utils'

// ❌ works locally, breaks as soon as the source is re-created elsewhere
ServerTools.register({
  name: 'slug',
  isApi: true,
  func: ({ t }) => slugify(t),
})
```

Either keep the function self-contained, or declare the names that the server and the client have **agreed on** in the tool's `scope` field. `scope` keys become closure variables of the compiled function, and a `this` key becomes its `this`:

```typescript
ServerTools.register({
  name: 'slug',
  isApi: true,
  allowExportFunc: true,
  scope: { slugify }, // the contract: every runtime provides `slugify`
  func: ({ t }) => slugify(t), // compiled against the scope, so the name resolves
})

// scope.this becomes the function's this
ServerTools.register({
  name: 'scale',
  isApi: true,
  scope: { this: { factor: 10 } },
  func: function ({ a }) {
    return a * this.factor
  },
})
```

Rules that matter in practice (defined by `@isdk/tool-func`):

- `scope` is **never serialized** — it holds runtime references, not metadata. Each side supplies its own implementation under the same name; that shared naming _is_ the contract.
- Declaring a **non-empty** `scope` recompiles the function from its own source so the bindings apply, which **drops its original lexical closure**. Declare a scope only when you want those bindings.
- With no (or empty) `scope`, the function is assigned as-is and its closure keeps working locally — but it is still lost across the wire.
- A `func` given as a **string** is always compiled against `scope`.
- Sources that have no standalone function-expression source (method shorthand, class methods, native code) are kept as-is; their scope keys simply do not bind.
- Discovery (`GET <pathname>`) omits `func` by default; `allowExportFunc: true` exports it as source text.

## 🧭 Routing & headers

`mount()` (or `addRpcHandler()`) registers one catch-all route under the API path
(a root mount — `'/'` or `''` — is supported and registers the route at the server root):

```
ALL  <pathname>/:toolId/:id?
```

so both of these address the same tool:

```bash
curl -X POST http://localhost:3000/api/calculator \
  -H 'content-type: application/json' \
  -d '{"a":40,"b":2}'

curl -X POST http://localhost:3000/api/ \
  -H 'content-type: application/json' \
  -H 'rpc-fn: calculator' \
  -d '{"a":40,"b":2}'
```

Discovery is registered on `<pathname>` **and** `<pathname>/` (the HTTP client normalizes the discovery URL to the trailing-slash form):

```bash
curl http://localhost:3000/api/
```

Mounting more than once on one transport is supported: every prefix keeps its own registry and discovery handler. Re-mounting the same prefix **replaces** them by default; pass `options.remount = 'throw'` to get Fastify's `FST_ERR_DUPLICATED_ROUTE` instead.

This is not a Fastify-only rule: the claim bookkeeping and the `remount` option (`RouteRemountMode`) live in `@isdk/tool-rpc`'s `ServerToolTransport`, so `HttpServerToolTransport` and `MailboxServerTransport` honor the same semantics. A transport only decides *how* a conflict surfaces, by overriding `onDuplicateRoute()` — this one re-registers the route so find-my-way raises its native error.

```ts
transport.mount(ToolsA, '/a');
transport.mount(ToolsB, '/b'); // each prefix dispatches its own registry
transport.mount(ToolsC, '/a'); // replaces the /a registry (a warning is logged)
transport.mount(ToolsD, '/a', { remount: 'throw' }); // throws FST_ERR_DUPLICATED_ROUTE
```

### RPC headers

| Header            | Meaning                                                   |
| ----------------- | --------------------------------------------------------- |
| `rpc-fn`          | Tool id (falls back to the `:toolId` path param)          |
| `rpc-act`         | Action / sub-method, e.g. `get`, `list`, `run`            |
| `rpc-res-id`      | Resource id (falls back to the `:id?` path param)         |
| `rpc-timeout`     | Business timeout in ms, negotiated as `min(client, tool)` |
| `req-id`          | Request id, echoed back in the response                   |
| `rpc-retry-after` | Suggested polling interval (ms) for background tasks      |
| `rpc-client-id`   | Client id, used for session identification                |
| `trace-id`        | Trace id for distributed tracing                          |

`GET` / `DELETE` requests take their params from `?p=<json>`; other methods read the JSON body.

## 🌊 Streaming

A tool that returns a stream is flushed as the response body:

```typescript
ServerTools.register({
  name: 'streamer',
  isApi: true,
  stream: true,
  func: () => {
    const enc = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('chunk-a'))
        controller.enqueue(enc.encode('chunk-b'))
        controller.close()
      },
    })
  },
} as any)
```

```typescript
const res = (await client.fetch(
  'streamer',
  { stream: true },
  'run'
)) as Response
console.log(await res.text()) // chunk-achunk-b
```

Node streams (`pipe`-able) are supported too. Non-stream payloads are always JSON-serialized explicitly, so a tool returning a plain string still produces valid JSON.

## ⏱ Timeout & background tasks (102)

Tools declare a timeout either as a number or as an object:

```typescript
// hard timeout: the call is aborted and answered 504
ServerTools.register({
  name: 'slow',
  isApi: true,
  timeout: 500,
  func: async () => {
    /* ... */
  },
})

// soft timeout with keep-alive: the task moves to the background
ServerTools.register({
  name: 'slow-poll',
  isApi: true,
  timeout: { value: 100, keepAliveOnTimeout: true },
  func: async ({ delay }: { delay: number }) => {
    await new Promise((resolve) => setTimeout(resolve, delay))
    return `done-${delay}`
  },
} as any)
```

Negotiation is `min(client timeout, tool timeout)`; the effective value travels in `rpc-timeout`.

- **Hard timeout** → HTTP `504` with an error envelope.
- **Soft timeout (`keepAliveOnTimeout`)** → HTTP `202` with a `status: 102` body, plus `req-id` and `rpc-retry-after` headers. HTTP clients cannot observe a real `102 Processing`, so the transport maps it to `202` + `{"status":102}` — the same contract as `HttpServerToolTransport`.

```bash
curl -i -X POST http://localhost:3000/api/slow-poll \
  -H 'content-type: application/json' -H 'rpc-timeout: 100' -d '{"delay":400}'

# HTTP/1.1 202 Accepted
# req-id: <id>
# rpc-retry-after: 1000
# {"status":102,"message":"Task moved to background"}
```

The client then polls the system `rpcTask` resource until the task settles:

```bash
curl -H 'rpc-fn: rpcTask' -H 'rpc-act: get' -H 'rpc-res-id: <req-id>' \
  http://localhost:3000/api/rpcTask/<req-id>
```

`ClientToolTransport.fetch()` drives this loop automatically, honouring `rpc-retry-after` and an `AbortSignal` (aborting also sends a `$cancel` to the server).

> **Known client-side limitation:** a discovered `ClientTools` stub arms its own local timer at the negotiated timeout, which races the `102` response over HTTP and usually aborts first. For background tasks, drive the raw transport (`new HttpClientToolTransport(apiUrl).fetch(...)`) — this is the same approach used by the `tool-rpc` HTTP test suite.

## ❗ Errors

Thrown errors carry an optional numeric `code`/`status` that becomes the HTTP status; the body is always an error envelope:

```typescript
ServerTools.register({
  name: 'boom',
  isApi: true,
  func: () => {
    const err: any = new Error('bad input')
    err.code = 400
    throw err
  },
})
```

```json
{ "error": { "code": 400, "status": "bad_request", "message": "bad input" } }
```

Unknown tools answer `404`. Malformed JSON params/body answer `400`.

## 🔗 Boundary with `@isdk/tool-rpc`

This package is a **separate repository and a separate npm package**; it is not one of the transports built into `@isdk/tool-rpc`. That library ships only `HttpServerToolTransport` and `MailboxServerTransport` (the most basic ones, and the reference implementations for transport developers); `FastifyServerToolTransport` lives here and depends only on the public API of `@isdk/tool-rpc`.

**Reused from core (never re-implemented here):**

| core export | used here for |
|---|---|
| `BindOptions` | the `_start(options)` signature and transport options |
| `normalizeListenBind()` | resolving this round's listen arguments (the three socket aliases, socket wins over host/port) — same precedence as the HTTP transport |
| `socketAddressFromBind()` | the declared address (route-ownership key) **before** `listen()` |
| `socketAddressFromListen()` | turning `listen()`'s observation into the same address **after** listening |

Both sides share one implementation, so they agree on the key: on the same port (or the same socket file), a route clash between an instance of this transport and an `HttpServerToolTransport` is reported rather than silently shadowed. **Do not re-implement address normalization in this package** — that is how the two sides drifted apart in the past.

**Owned by this package** (not part of core, and not documented in core's docs):

- Observation shape: Fastify's TCP `listen()` returns a URL string while a unix `listen()` returns a bare socket path (verified), unlike Node's `server.address()`; `socketAddressFromListen()` tells them apart.
- `defaultBindOptions()` returns `{ port: 3000, host: '0.0.0.0' }`, but `bindDefaults` is deliberately **not** passed to `socketAddressFromBind()`: when apiUrl is a bare path prefix and nothing was declared this round, no default port is invented — a shared instance may already be listening, and a transport that is not listening should not claim a port.
- Sharing granularity is "the same fastify instance"; routing is delegated to find-my-way rather than to a base pool plus longest-prefix table owned by this transport.
- Not yet listening and apiUrl has no URL form: the address is a synthetic `fastify://instance-N` placeholder (not comparable across transports).
- Fastify's `close()` **does** delete the unix socket file (Node's does not), so restarting on the same path behaves differently than with the HTTP transport.

## 🧰 API

| Member                                              | Description                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new FastifyServerToolTransport(server?, options?)` | `server` is a `FastifyInstance` **or** Fastify server options (then an instance is created for you). `options` are transport options (`apiUrl`, `dispatcher`, `manager`, …). |
| `mount(serverTools, apiUrl, options?)`              | Convenience: sets the registry and registers the RPC + discovery routes (`registerRoutes()` keeps the physical route table and the manager's ownership table in sync; it is re-entrant — re-mounting unregisters first). `options` apply to both routes; a rejected `remount: 'throw'` mount does not re-point the transport's registry. |
| `options.remount`                                   | `'replace'` (default) or `'throw'`: what a second mount on an already-mounted prefix does — swap its registry / discovery handler, or raise Fastify's `FST_ERR_DUPLICATED_ROUTE`. Same option as in `@isdk/tool-rpc` (`RouteRemountMode`), shared by all server transports. |
| `addRpcHandler(apiUrl, options?)`                   | Registers `ALL <pathname>/:toolId/:id?` for RPC calls. `options` are Fastify route options (`preHandler`, `bodyLimit`, `schema`, `logLevel`, `config`, …) plus `options.registry` to bind a specific registry to this route. |
| `addDiscoveryHandler(apiUrl, handler, options?)`    | Registers `GET <pathname>` (and `<pathname>/`) returning the tool metadata. Re-mounting a prefix replaces the handler (or throws, with `options.remount: 'throw'`) instead of duplicating the route. |
| `start(options?)` / `_start(options?)`              | Listens; defaults `{ port: 3000, host: '0.0.0.0' }`, merged with constructor options. `path` (also `socketPath` / `socket`) listens on a unix socket and wins over `port`/`host`. Returns the listen address; **rejects** if listening fails (e.g. `EADDRINUSE`).         |
| `getListenAddr()`                                   | The address others can reach this service at, as a canonical URI (`http://localhost:3000`, `http://*:3000` for a wildcard listen, `unix:/run/ai.sock` for a socket; socket paths are percent-encoded per segment, so a file named `ai sock` is `unix:/run/ai%20sock` and one literally named `ai%20sock` is `unix:/run/ai%2520sock`) — normalized by the same core helpers the HTTP transport uses (`normalizeSocketAddress`, `socketAddressFromBind`, `normalizeListenBind`, exported from `@isdk/tool-rpc`) — one set of rules for the socket aliases and for `socket` winning over `port`/`host`, so both transports report the same key for the same base. Before listening it is the declared value (apiUrl plus the bind *declared* in `start()`); after listening it is the address `listen()` reports (only the kernel knows the port when `port: 0`). A shared in-process instance that has not been bound and whose apiUrl carries no URL stands in with a synthetic `fastify://instance-N` URI. This is what the transport manager's route ownership registration keys on, and because the form is shared, a route conflict against an `HttpServerToolTransport` on the same port or socket is caught too. |
| `getRoutes()`                                       | The logical routes this transport claims (its mount prefixes), instead of the base class's `['/']`.                                                                          |
| `stop(force?)`                                      | Closes the Fastify server **and releases this transport's route-ownership entries** (`unregisterRoutes()`), so the same prefix can be served again afterwards (otherwise the manager keeps reporting `Routing Conflict`). `force` also drops keep-alive sockets (`closeAllConnections`). Unlike `HttpServerToolTransport`, closing also removes the unix socket file — that is Fastify's own cleanup. |
| `getRaw()`                                          | The underlying `FastifyInstance`.                                                                                                                                            |
| `canStream`                                         | `true` — Node and Web streams are supported.                                                                                                                                 |
| `registry`                                          | The tools registry used for dispatching (set by `mount`).                                                                                                                    |
| `dispatcher`                                        | Shared `RpcServerDispatcher` instance, or your own via `options.dispatcher`.                                                                                                 |

## 🧪 Development

```bash
pnpm install
pnpm test              # vitest run (src/*.test.ts)
pnpm exec vitest       # watch mode
pnpm exec tsc --noEmit # type check
pnpm run build         # tsup (cjs + esm + dts) and typedoc markdown into docs/
```

The suite covers discovery + RPC calls, error status mapping, `404`, streaming, `mount()`, timeouts (hard/soft/client override), `AbortSignal` propagation, and `102` background polling.

## 📚 Related docs

- [`@isdk/tool-rpc`](https://github.com/isdk/tool-rpc) — transport architecture, dispatcher, timeout & task tracking
- [`@isdk/tool-func`](https://github.com/isdk/ai-tool) — the tool model (`ToolFunc`, `ServerTools`, `ClientTools`)
- Generated API reference: `pnpm run doc:md` → `docs/`

## 🤝 Contributing

1. Fork → `git clone`
2. Create branch → `git checkout -b feat/your-feature`
3. Commit → `git commit -m 'feat: add XYZ'`
4. Push → `git push origin feat/your-feature`
5. Open PR 🎉

Please make sure `pnpm test` and `pnpm exec tsc --noEmit` pass.

## 📜 License

MIT © [ISDK](https://github.com/isdk) — see the [LICENSE-MIT](./LICENSE-MIT) file for details.
