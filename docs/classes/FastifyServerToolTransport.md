[**@isdk/tool-rpc-fastify**](../README.md)

***

[@isdk/tool-rpc-fastify](../globals.md) / FastifyServerToolTransport

# Class: FastifyServerToolTransport

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:61](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L61)

A concrete server transport implementation for Fastify.

Based on the tool-rpc V2 transport architecture: physical Fastify routes
are normalized into ToolRpcRequest and processed through the shared
dispatcher pipeline (processIncomingCall), then written back via sendRpcResponse.

Per-prefix bookkeeping (apiUrl / registry / discovery handler, and what a
repeated claim means) is inherited from `ServerToolTransport`, so several
prefixes on one transport never clobber each other.

## Extends

- `ServerToolTransport`

## Constructors

### Constructor

> **new FastifyServerToolTransport**(`server?`, `options?`): `FastifyServerToolTransport`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:73](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L73)

#### Parameters

##### server?

`FastifyInstance`\<`RawServerDefault`, `IncomingMessage`, `ServerResponse`\<`IncomingMessage`\>, `FastifyBaseLogger`, `FastifyTypeProviderDefault`\> \| `FastifyServerOptions`

##### options?

`any`

#### Returns

`FastifyServerToolTransport`

#### Overrides

`ServerToolTransport.constructor`

## Properties

### apiUrl

> **apiUrl**: `string`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:857

#### Inherited from

`ServerToolTransport.apiUrl`

***

### bindBaseUrl?

> `protected` `optional` **bindBaseUrl?**: `string`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:888

显式 bind 参数改写后的声明身份；未显式指定时 undefined（沿用 apiUrl 派生值）。
每次 start() 都重新计算，不累加：上一轮的 bind 参数不应泄漏到下一轮。

#### Inherited from

`ServerToolTransport.bindBaseUrl`

***

### canStream

> **canStream**: `boolean`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:860

是否支持原生的流式传输 (如 HTTP 支持, Mailbox 通常不支持)

#### Inherited from

`ServerToolTransport.canStream`

***

### dispatcher

> **dispatcher**: `RpcServerDispatcher`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:859

#### Inherited from

`ServerToolTransport.dispatcher`

***

### listenAddr?

> `protected` `optional` **listenAddr?**: `string`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:68](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L68)

Physical listen address, recorded once `_start()` has resolved.

***

### manager

> **manager**: `RpcClientTransportManager`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:205

所属管理器引用

#### Inherited from

`ServerToolTransport.manager`

***

### options?

> `optional` **options?**: `ServerToolTransportOptions`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:858

#### Inherited from

`ServerToolTransport.options`

***

### registry

> **registry**: `any`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:64](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L64)

The tool registry used for dispatching RPC calls on this transport.

***

### routeClaims

> `protected` **routeClaims**: `Map`\<`string`, `RouteClaim`\>

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:924

prefix -> 逻辑路由声明。多前缀 / 多注册表共用同一份簿记。

#### Inherited from

`ServerToolTransport.routeClaims`

***

### rpcPrefix

> `protected` **rpcPrefix**: `string` = `''`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:66](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L66)

Path prefix (without trailing slash, '/' for root) of the last RPC route claimed.

***

### server

> **server**: `FastifyInstance`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:62](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L62)

## Methods

### \_start()

> **\_start**(`options?`): `Promise`\<`any`\>

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:167](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L167)

#### Parameters

##### options?

`BindOptions` = `{}`

#### Returns

`Promise`\<`any`\>

#### Overrides

`ServerToolTransport._start`

***

### addDiscoveryHandler()

> **addDiscoveryHandler**(`apiUrl`, `handler`, `options?`): `void`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:107](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L107)

#### Parameters

##### apiUrl

`string`

##### handler

() => `any`

##### options?

[`FastifyRpcHandlerOptions`](../interfaces/FastifyRpcHandlerOptions.md) = `{}`

#### Returns

`void`

#### Overrides

`ServerToolTransport.addDiscoveryHandler`

***

### addRpcHandler()

> **addRpcHandler**(`apiUrl`, `options?`): `void`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:130](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L130)

#### Parameters

##### apiUrl

`string`

##### options?

[`FastifyRpcHandlerOptions`](../interfaces/FastifyRpcHandlerOptions.md) = `{}`

#### Returns

`void`

#### Overrides

`ServerToolTransport.addRpcHandler`

***

### apiUrlIdentity()

> `protected` **apiUrlIdentity**(): `string`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:209](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L209)

Declared identity from `apiUrl`: the physical base this transport serves, as
a canonical URI (scheme + authority, no path). Transports sharing one Fastify
instance (or one URL origin) share a base, which is what RpcTransportManager's
route-conflict audit keys on. The base class returns `apiUrl`, which carries
the path and therefore hides real conflicts.

Available before start(). It only changes when the caller *declares* a bind
through start() options (see applyBindOptions); an OS-assigned port (0) never
moves it, so the audit key stays queryable across the start boundary.
When apiUrl has no URL form (a bare path prefix), a synthetic key stands in.

#### Returns

`string`

#### Overrides

`ServerToolTransport.apiUrlIdentity`

***

### applyBindOptions()

> `protected` **applyBindOptions**(`options?`): `void`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:895

把 `start({ host, port, path })` 这类**声明式**的 bind 参数并入声明身份。
必须在 _start 之前调用：审计与底座复用池的 key 都得在 bind 之前定下来。
只认调用方给的参数（start 入参 + options 预置）与 defaultBindOptions() 里
声明的确定默认值；其余实现细节不算声明。

#### Parameters

##### options?

`BindOptions`

#### Returns

`void`

#### Inherited from

`ServerToolTransport.applyBindOptions`

***

### claimRoute()

> `protected` **claimRoute**(`apiUrl`, `kind`, `options?`): `RouteClaim` \| `null`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:941

声明一条逻辑路由，并合并 registry / discoveryHandler。

返回 claim 表示子类需要注册对应的物理路由；返回 null 表示该
(prefix, kind) 已声明过——逻辑信息已更新，物理路由无需（也不应）重复注册。

#### Parameters

##### apiUrl

`string`

##### kind

`"rpc"` \| `"discovery"`

##### options?

`RouteClaimOptions`

#### Returns

`RouteClaim` \| `null`

#### Inherited from

`ServerToolTransport.claimRoute`

***

### defaultBindOptions()

> `protected` **defaultBindOptions**(): `BindOptions`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:228](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L228)

What `_start()` falls back to when the caller declares nothing. These have
to match it exactly: a bare path prefix carries no authority at all, so the
bind (options plus these defaults) is the only statement about the physical
base there is. Without it such a transport stays keyed on the instance
placeholder and can never be compared against an HTTP transport on the same
port — or share that port's socket.

#### Returns

`BindOptions`

#### Overrides

`ServerToolTransport.defaultBindOptions`

***

### getBaseUrl()

> **getBaseUrl**(): `string` \| `string`[]

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:872

声明身份：物理底座的 canonical URI（见 physical-uri.ts）。
= apiUrl 派生的身份，被 `start()` 传入的显式 bind 参数改写后的结果。
只有调用方声明的 bind 会改写它，内核观测（port 0）不会，所以 key 跨 start
边界仍然稳定。无 URL 表示的 transport（unix socket、进程内总线）请覆写 apiUrlIdentity()。

#### Returns

`string` \| `string`[]

#### Inherited from

`ServerToolTransport.getBaseUrl`

***

### getBoundAddress()

> **getBoundAddress**(): `string` \| `undefined`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:237](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L237)

Observed bind: the address reported by `listen()`, only available after
start(). Use it for logs and to complete the declared identity when the port
was assigned by the OS. Never an audit or pool key.

#### Returns

`string` \| `undefined`

#### Overrides

`ServerToolTransport.getBoundAddress`

***

### ~~getListenAddr()~~

> **getListenAddr**(): `string` \| `string`[]

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:910

#### Returns

`string` \| `string`[]

#### Deprecated

改用 getBaseUrl()。本名语义含糊（容易被读成“监听之后拿到的地址”），
它实际返回的是声明身份；绑定观测请用 getBoundAddress()。

#### Inherited from

`ServerToolTransport.getListenAddr`

***

### getRaw()

> **getRaw**(): `any`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:273](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L273)

#### Returns

`any`

#### Overrides

`ServerToolTransport.getRaw`

***

### getRoutes()

> **getRoutes**(): `string`[]

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:916

该实例声明负责的逻辑路由：每个前缀一条（归一化，无尾斜杠）。
尚未声明任何路由时返回 ['/']，即接管该物理地址下的全量路径。
需要前缀匹配形式（补尾斜杠）的后端请用 toMatchPrefix()。

#### Returns

`string`[]

#### Inherited from

`ServerToolTransport.getRoutes`

***

### mount()

> **mount**(`serverTools`, `apiPrefix`, `options?`): `void`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:98](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L98)

Convenience: mount the RPC + discovery routes for a tools registry
under the given API prefix.

Several mounts can share one transport, each with its own prefix and
registry; `options.remount` decides what a second mount on an already
mounted prefix does ('replace' by default, 'throw' for Fastify's error).

#### Parameters

##### serverTools

*typeof* `ServerTools`

##### apiPrefix

`string`

##### options?

[`FastifyRpcHandlerOptions`](../interfaces/FastifyRpcHandlerOptions.md)

#### Returns

`void`

***

### onDuplicateRoute()

> `protected` **onDuplicateRoute**(`prefix`, `kind`): `never`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:158](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L158)

`remount: 'throw'` hook: re-register the route so find-my-way raises its own
`FST_ERR_DUPLICATED_ROUTE` rather than a parallel error type. If the router
tolerated the duplicate (e.g. `ignoreDuplicateRoutes`), fall back to the
base class error.

#### Parameters

##### prefix

`string`

##### kind

`"rpc"` \| `"discovery"`

#### Returns

`never`

#### Overrides

`ServerToolTransport.onDuplicateRoute`

***

### processIncomingCall()

> `protected` **processIncomingCall**(`rawReq`, `rawRes`, `registry?`): `Promise`\<`void`\>

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:922

Template Method：处理物理请求流水线。
下层具体协议收到请求后，将其转化为内部结构，送入 Dispatcher 并写回。

#### Parameters

##### rawReq

`any`

##### rawRes

`any`

##### registry?

`any`

#### Returns

`Promise`\<`void`\>

#### Inherited from

`ServerToolTransport.processIncomingCall`

***

### resolvedBaseUrl()

> `protected` **resolvedBaseUrl**(): `string`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:878

声明身份的实际计算：apiUrl 派生值 + 显式 bind 改写。
覆写 getBaseUrl() 的子类（如 HTTP，需要收窄成 string）请复用它，
免得漏掉 bind 改写。

#### Returns

`string`

#### Inherited from

`ServerToolTransport.resolvedBaseUrl`

***

### routeApiUrl()

> `protected` **routeApiUrl**(`prefix`): `string` \| `undefined`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:953

该前缀声明时使用的 apiUrl（用于重建 ToolRpcRequest.apiUrl）。

#### Parameters

##### prefix

`string`

#### Returns

`string` \| `undefined`

#### Inherited from

`ServerToolTransport.routeApiUrl`

***

### routeDiscoveryHandler()

> `protected` **routeDiscoveryHandler**(`prefix`): (() => `any`) \| `undefined`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:951

请求期解析：该前缀的发现处理器。

#### Parameters

##### prefix

`string`

#### Returns

(() => `any`) \| `undefined`

#### Inherited from

`ServerToolTransport.routeDiscoveryHandler`

***

### routeRegistry()

> `protected` **routeRegistry**(`prefix`): `any`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:949

请求期解析：该前缀由哪个注册表服务。

#### Parameters

##### prefix

`string`

#### Returns

`any`

#### Inherited from

`ServerToolTransport.routeRegistry`

***

### sendRpcResponse()

> `protected` **sendRpcResponse**(`rpcRes`, `reply`): `Promise`\<`void`\>

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:343](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L343)

Write the normalized ToolRpcResponse back through the Fastify reply.

#### Parameters

##### rpcRes

`ToolRpcResponse`

##### reply

`FastifyReply`

#### Returns

`Promise`\<`void`\>

#### Overrides

`ServerToolTransport.sendRpcResponse`

***

### setApiUrl()

> **setApiUrl**(`apiUrl`): `void`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:207

#### Parameters

##### apiUrl

`string`

#### Returns

`void`

#### Inherited from

`ServerToolTransport.setApiUrl`

***

### start()

> **start**(`options?`): `Promise`\<`any`\>

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:917

启动物理监听

#### Parameters

##### options?

`any`

#### Returns

`Promise`\<`any`\>

#### Inherited from

`ServerToolTransport.start`

***

### stop()

> **stop**(`force?`): `Promise`\<`void`\>

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:267](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L267)

#### Parameters

##### force?

`boolean`

#### Returns

`Promise`\<`void`\>

#### Overrides

`ServerToolTransport.stop`

***

### toListenAddr()

> `protected` **toListenAddr**(`listenResult`): `string` \| `undefined`

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:255](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L255)

Observed bind, as a URI. Fastify resolves a TCP listen with a URL and a
unix-socket listen with the bare socket path (实测), so the string branch has
to tell them apart rather than assume a URL.

#### Parameters

##### listenResult

`any`

#### Returns

`string` \| `undefined`

***

### toMatchPrefix()

> `protected` **toMatchPrefix**(`prefix`): `string`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:934

前缀匹配用的 key：补尾斜杠，避免 '/api' 误匹配 '/apix'。
仅用于匹配与物理路由表，逻辑路由（getRoutes / 审计）用归一化前缀。

#### Parameters

##### prefix

`string`

#### Returns

`string`

#### Inherited from

`ServerToolTransport.toMatchPrefix`

***

### toPathname()

> `protected` **toPathname**(`apiUrl`): `string`

Defined in: packages/tool-rpc/dist/server-manager-D7aYswzj.d.ts:929

apiUrl（完整 URL）或路径前缀 -> 归一化前缀（无尾斜杠，根为 '/'）。
空路径归一为 '/'，因为多数路由表拒绝空 path。

#### Parameters

##### apiUrl

`string`

#### Returns

`string`

#### Inherited from

`ServerToolTransport.toPathname`

***

### toRpcRequest()

> `protected` **toRpcRequest**(`request`, `reply?`): `Promise`\<`ToolRpcRequest`\>

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:280](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L280)

Normalize a Fastify request into the standard ToolRpcRequest envelope.

#### Parameters

##### request

`FastifyRequest`

##### reply?

`FastifyReply`\<`RouteGenericInterface`, `RawServerDefault`, `IncomingMessage`, `ServerResponse`\<`IncomingMessage`\>, `unknown`, `FastifySchema`, `FastifyTypeProviderDefault`, `unknown`\>

#### Returns

`Promise`\<`ToolRpcRequest`\>

#### Overrides

`ServerToolTransport.toRpcRequest`

***

### waitForReply()

> `protected` **waitForReply**(`reply`): `Promise`\<`void`\>

Defined in: [packages/ai-tool-fastify/src/fastify-server.ts:389](https://github.com/isdk/tool-rpc-fastify.js/blob/f3f6a237be2caa58083212f4432489837b466b11/src/fastify-server.ts#L389)

#### Parameters

##### reply

`FastifyReply`

#### Returns

`Promise`\<`void`\>
