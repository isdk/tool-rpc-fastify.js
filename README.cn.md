# @isdk/ai-tool-fastify

**中文文档：** README.cn.md · **English:** [README.md](README.md)

> ✨ **面向 `ToolFunc` 框架的 Fastify HTTP 服务端传输层**
> 用 Fastify 把工具暴露为 HTTP 服务，`@isdk/tool-rpc` 客户端可以像调用本地函数一样调用它们。

[![npm version](https://img.shields.io/npm/v/@isdk/ai-tool-fastify.svg?style=flat-square)](https://www.npmjs.com/package/@isdk/ai-tool-fastify)
[![Vitest Tests](https://img.shields.io/badge/tests-vitest-green?style=flat-square)](https://vitest.dev/)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-blue?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-purple?style=flat-square)](./LICENSE-MIT)

```bash
npm install @isdk/ai-tool-fastify fastify
```

`fastify` 是 peer 依赖（`*`，已针对 Fastify 5 验证）。`@isdk/tool-rpc` 作为本包的运行时依赖自动安装。

本包基于 [`@isdk/tool-rpc`](https://github.com/isdk/tool-rpc)（构建于 [`@isdk/tool-func`](https://github.com/isdk/ai-tool) 之上的客户端/服务端 RPC 与 RESTful 通信库）。它只负责**物理 HTTP 层**：把 Fastify 路由归一化为 `ToolRpcRequest`，再交给共享的 `RpcServerDispatcher` 流水线执行。

## 🌟 特性

- ✅ **原生 Fastify** — 可传入你自己的 `FastifyInstance`（hooks、插件、content type parser 仍归你管），也可让传输层自建实例。
- ✅ **自动工具发现** — 一个 `GET` 路由发布已注册工具的元数据，客户端据此生成 stub。
- ✅ **纯 HTTP 的 RPC** — 兼容 `fetch`、浏览器、curl 及任意 HTTP 客户端，无需自定义 socket 协议。
- ✅ **流式响应** — Node 流与 Web `ReadableStream` 均可直接写入响应（`canStream = true`）。
- ✅ **超时与后台任务** — 软超时返回 `202` + `status: 102`，客户端轮询 `rpcTask` 直至任务完成。
- ✅ **类型安全** — 工具定义与调用端到端保持类型约束。

## 🚀 快速开始

### 1. 创建服务端

`server.ts`：

```typescript
import { ServerTools } from '@isdk/tool-rpc'
import { FastifyServerToolTransport } from '@isdk/ai-tool-fastify'

// 1. 在服务端注册工具
ServerTools.register({
  name: 'calculator',
  isApi: true,
  func: ({ a, b }: { a: number; b: number }) => a + b,
})

// 2. 把该注册表的 RPC + 发现路由挂载到 /api
const serverTransport = new FastifyServerToolTransport()
serverTransport.mount(ServerTools, '/api')

// 3. 启动监听
serverTransport.start({ port: 3000, host: '0.0.0.0' }).then(() => {
  console.log('服务已启动：http://localhost:3000')
})
```

> 工具函数会被 `toString()` 序列化，以便迁移到远端运行时。因此函数要么保持**自包含**，要么把共享的名字声明在工具的 `scope` 字段中——见下文「函数序列化与 `scope`」。

### 2. 创建客户端

`client.ts`：

```typescript
import {
  ClientTools,
  HttpClientToolTransport,
  RpcTransportManager,
} from '@isdk/tool-rpc'

const apiUrl = 'http://localhost:3000/api'

async function main() {
  // 1. 把 url scheme 绑定到客户端传输实现。
  //    ClientTools.setTransport 已废弃：现在由传输管理器按 apiUrl 解析传输实例。
  RpcTransportManager.bindScheme(['http', 'https'], HttpClientToolTransport)

  // 2. 连接并加载工具定义（服务发现）
  const client = ClientTools.connect(apiUrl)
  await client.loadFrom()

  // 3. 取到自动生成的客户端 stub 并调用
  const calculator = client.get('calculator')
  const result = await calculator!.run({ a: 40, b: 2 })

  console.log('结果是：', result) // 结果是： 42
}

main()
```

`ClientTools.connect(apiUrl)` 返回一个拥有独立 `apiUrl` 与 `items` 的**作用域子类**，因此发现到的 stub 挂在返回的类上——要用 `client.get(...)`，而不是 `ClientTools.get(...)`。这样多个服务端之间互不干扰。

### 3. 运行

```bash
# 一个终端
npx tsx server.ts

# 另一个终端
npx tsx client.ts
```

## 🔌 嵌入已有的 Fastify 应用

传入你自己的实例，传输层只会向其中追加路由。

```typescript
import fastify from 'fastify'
import { ServerTools } from '@isdk/tool-rpc'
import { FastifyServerToolTransport } from '@isdk/ai-tool-fastify'

const app = fastify({ logger: true })

app.addHook('onRequest', async (req) => {
  // 你的鉴权 / cors / 限流等 hooks 对 RPC 路由同样生效
})

const transport = new FastifyServerToolTransport(app, {
  apiUrl: 'http://localhost:3000/tools',
})
transport.mount(ServerTools, 'http://localhost:3000/tools')

// 你自己的路由与 RPC 路由并存
app.get('/health', async () => ({ ok: true }))

app.listen({ port: 3000, host: '0.0.0.0' })
```

`transport.getRaw()` 返回底层的 `FastifyInstance`。

## 🧵 函数序列化与 `scope`

工具定义是可移植的。当工具被导出（`allowExportFunc: true`）、持久化或迁移到其他运行时时，其 `func` 会被 `toString()` 序列化——**只有源码文本会随行**，因此从外层模块作用域捕获的任何变量在对端都会丢失：

```typescript
import { slugify } from './utils'

// ❌ 本地可用，但源码在对端重建后就失效了
ServerTools.register({
  name: 'slug',
  isApi: true,
  func: ({ t }) => slugify(t),
})
```

要么让函数自包含，要么把服务端与客户端**约定好**的名字声明到工具的 `scope` 字段里。`scope` 的键会成为编译后函数的闭包变量，而 `this` 键则作为函数的 `this`：

```typescript
ServerTools.register({
  name: 'slug',
  isApi: true,
  allowExportFunc: true,
  scope: { slugify }, // 约定：每个运行时都提供 `slugify`
  func: ({ t }) => slugify(t), // 按 scope 编译，因此该名字能解析
})

// scope 中的 this 会作为函数的 this
ServerTools.register({
  name: 'scale',
  isApi: true,
  scope: { this: { factor: 10 } },
  func: function ({ a }) {
    return a * this.factor
  },
})
```

实践中需要注意的规则（由 `@isdk/tool-func` 定义）：

- `scope` **不会被序列化**——它存放的是运行时引用，不是元数据。每一端按同名提供自己的实现；这套同名约定本身就是契约。
- 声明**非空** `scope` 会按函数自身源码重新编译以完成绑定，这会**丢弃原有的词法闭包**。只在确实需要这些绑定时才声明 scope。
- 没有（或为空）`scope` 时，函数直接赋值，其闭包在本地仍然有效——但跨网络依旧会丢失。
- `func` 为**字符串**时，总是按 `scope` 编译。
- 没有独立函数表达式源码的形式（方法简写、类方法、原生代码）会原样保留，其 scope 键不会绑定。
- 发现路由（`GET <pathname>`）默认不输出 `func`；`allowExportFunc: true` 会将其作为源码文本导出。

## 🧭 路由与 Header

`mount()`（或 `addRpcHandler()`）会在 API 路径下注册一条兜底路由（根挂载 `'/'` 或 `''` 也受支持，路由会注册在服务根路径）：

```
ALL  <pathname>/:toolId/:id?
```

因此以下两种寻址方式等价：

```bash
curl -X POST http://localhost:3000/api/calculator \
  -H 'content-type: application/json' \
  -d '{"a":40,"b":2}'

curl -X POST http://localhost:3000/api/ \
  -H 'content-type: application/json' \
  -H 'rpc-fn: calculator' \
  -d '{"a":40,"b":2}'
```

发现路由同时注册在 `<pathname>` **和** `<pathname>/`（HTTP 客户端会把发现 URL 规范化为带尾斜杠的形式）：

```bash
curl http://localhost:3000/api/
```

同一个 transport 支持多次挂载：每个前缀各自绑定自己的注册表与发现处理器。重复挂载同一前缀时，默认会**替换**它们；传入 `options.remount = 'throw'` 则改为抛出 Fastify 的 `FST_ERR_DUPLICATED_ROUTE`。

这不只是 Fastify 的规则：路由声明的簿记与 `remount` 选项（`RouteRemountMode`）位于 `@isdk/tool-rpc` 的 `ServerToolTransport` 基类，`HttpServerToolTransport` 与 `MailboxServerTransport` 遵守同一语义。各 transport 只决定冲突**如何**上报——覆写 `onDuplicateRoute()`，本 transport 选择重新注册路由，从而由 find-my-way 抛原生错误。

```ts
transport.mount(ToolsA, '/a');
transport.mount(ToolsB, '/b'); // 每个前缀用自己的注册表
transport.mount(ToolsC, '/a'); // 替换 /a 的注册表（会打印 warning）
transport.mount(ToolsD, '/a', { remount: 'throw' }); // 抛 FST_ERR_DUPLICATED_ROUTE
```

### RPC Header

| Header            | 含义                                        |
| ----------------- | ------------------------------------------- |
| `rpc-fn`          | 工具 id（缺省时回退到路径参数 `:toolId`）   |
| `rpc-act`         | 动作/子方法，如 `get`、`list`、`run`        |
| `rpc-res-id`      | 资源 id（缺省时回退到路径参数 `:id?`）      |
| `rpc-timeout`     | 业务超时（ms），按 `min(客户端, 工具)` 协商 |
| `req-id`          | 请求 id，会在响应中原样回显                 |
| `rpc-retry-after` | 后台任务的建议轮询间隔（ms）                |
| `rpc-client-id`   | 客户端 id，用于 session 识别                |
| `trace-id`        | 分布式链路追踪 id                           |

`GET` / `DELETE` 从 `?p=<json>` 取参数；其余方法读取 JSON body。

## 🌊 流式输出

返回流的工具，其内容会直接作为响应体输出：

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

Node 流（可 `pipe`）同样支持。非流式 payload 一律显式 `JSON.stringify`，因此返回纯字符串的工具也会产出合法 JSON。

## ⏱ 超时与后台任务（102）

工具的超时可以用数字或对象声明：

```typescript
// 硬超时：调用被中断并返回 504
ServerTools.register({
  name: 'slow',
  isApi: true,
  timeout: 500,
  func: async () => {
    /* ... */
  },
})

// 软超时 + keepAliveOnTimeout：任务转入后台执行
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

超时协商规则为 `min(客户端超时, 工具超时)`，最终值通过 `rpc-timeout` 传递。

- **硬超时** → HTTP `504`，返回错误信封。
- **软超时（`keepAliveOnTimeout`）** → HTTP `202` + `status: 102` 的 body，并带上 `req-id` 与 `rpc-retry-after` 响应头。HTTP 客户端无法感知真正的 `102 Processing`，因此传输层将其映射为 `202` + `{"status":102}`——与 `HttpServerToolTransport` 的契约一致。

```bash
curl -i -X POST http://localhost:3000/api/slow-poll \
  -H 'content-type: application/json' -H 'rpc-timeout: 100' -d '{"delay":400}'

# HTTP/1.1 202 Accepted
# req-id: <id>
# rpc-retry-after: 1000
# {"status":102,"message":"Task moved to background"}
```

随后客户端轮询系统的 `rpcTask` 资源，直到任务结束：

```bash
curl -H 'rpc-fn: rpcTask' -H 'rpc-act: get' -H 'rpc-res-id: <req-id>' \
  http://localhost:3000/api/rpcTask/<req-id>
```

`ClientToolTransport.fetch()` 会自动驱动这个轮询循环，遵循 `rpc-retry-after` 并支持 `AbortSignal`（中断时还会向服务端发送 `$cancel`）。

> **客户端侧的已知限制**：通过发现生成的 `ClientTools` stub 会在协商出的超时时刻启动本地定时器，与 `102` 响应几乎同时竞态，HTTP 下通常先被本地超时打断。因此后台任务建议直接使用裸传输层（`new HttpClientToolTransport(apiUrl).fetch(...)`）——`tool-rpc` 自身的 HTTP 测试套件也是这种做法。

## ❗ 错误处理

抛出的错误可携带数字型 `code`/`status`，它将作为 HTTP 状态码；响应体始终是错误信封：

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

未知工具返回 `404`；参数/ body 的 JSON 非法返回 `400`。

## 🧰 API

| 成员                                                | 说明                                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new FastifyServerToolTransport(server?, options?)` | `server` 可以是 `FastifyInstance`，**或** Fastify 服务端配置对象（此时会自动创建实例）。`options` 为传输层选项（`apiUrl`、`dispatcher`、`manager` 等）。 |
| `mount(serverTools, apiUrl, options?)`              | 便捷方法：设置工具注册表，并注册 RPC + 发现路由。`options` 同时作用于两条路由；`remount: 'throw'` 被拒时不会改动 transport 的注册表。  |
| `options.remount`                                   | `'replace'`（默认）或 `'throw'`：对已挂载前缀再次挂载时的行为——替换其注册表/发现处理器，或抛出 Fastify 的 `FST_ERR_DUPLICATED_ROUTE`。与 `@isdk/tool-rpc` 的 `RouteRemountMode` 是同一选项，所有 server transport 共用。 |
| `addRpcHandler(apiUrl, options?)`                   | 注册 `ALL <pathname>/:toolId/:id?` 用于 RPC 调用。`options` 会作为 Fastify 路由选项透传（`preHandler`、`bodyLimit`、`schema`、`logLevel`、`config` 等），另有 `options.registry` 为该路由单独绑定注册表。 |
| `addDiscoveryHandler(apiUrl, handler, options?)`    | 注册 `GET <pathname>`（以及 `<pathname>/`），返回工具元数据。重复注册同一前缀时替换处理器（`options.remount: 'throw'` 则抛错），不会重复注册路由。            |
| `start(options?)` / `_start(options?)`              | 启动监听；默认 `{ port: 3000, host: '0.0.0.0' }`，与构造参数合并。`path`（也认 `socketPath` / `socket`）监听 unix socket，且优先于 `port`/`host`。返回监听地址；监听失败（如 `EADDRINUSE`）时 **reject**。                                  |
| `getBaseUrl()`                                      | 声明身份：该 transport 的物理底座（canonical URI，如 `http://localhost:3000`，通配监听 `http://*:3000`，unix socket 为 `unix:/run/ai.sock`；socket 路径按段 percent-encode，所以名为 `ai sock` 的文件是 `unix:/run/ai%20sock`，而字面叫 `ai%20sock` 的文件是 `unix:/run/ai%2520sock`）——与 HTTP transport 共用同一个 `canonicalPhysicalUri` 做归一化，尚未监听的共享 in-process 实例用合成的 `fastify://instance-N` URI。start 前即可得；只有调用方在 `start()` 里**声明**的 bind 会改写它（系统分配的端口不会），所以裸 `/api` 前缀一旦监听在 3987 就变成 `http://localhost:3987`。传输管理器的路由冲突审计就以此为 key；因为形式已统一，与同一端口或同一 socket 上的 `HttpServerToolTransport` 撞路由也能报出来。 |
| `getBoundAddress()`                                 | 实际绑定观测：`listen()` 返回的地址，仅 start 后可得。用于日志与系统分配端口的场景；不作为审计 key。（`getListenAddr()` 保留为 `getBaseUrl()` 的废弃别名。） |
| `getRoutes()`                                       | 该 transport 声明负责的逻辑路由（各挂载前缀），而非基类默认的 `['/']`。                                                                                     |
| `stop(force?)`                                      | 关闭 Fastify 服务；`force` 会额外断开 keep-alive 连接（`closeAllConnections`）。                                                                         |
| `getRaw()`                                          | 返回底层 `FastifyInstance`。                                                                                                                             |
| `canStream`                                         | 为 `true`——支持 Node 流与 Web 流。                                                                                                                       |
| `registry`                                          | 用于分发的工具注册表（由 `mount` 设置）。                                                                                                                |
| `dispatcher`                                        | 默认的共享 `RpcServerDispatcher` 实例，也可通过 `options.dispatcher` 自定义。                                                                            |

## 🧪 开发

```bash
pnpm install
pnpm test              # vitest run（src/*.test.ts）
pnpm exec vitest       # watch 模式
pnpm exec tsc --noEmit # 类型检查
pnpm run build         # tsup（cjs + esm + dts），并生成 docs/ 的 markdown API 文档
```

测试覆盖：服务发现与 RPC 调用、错误状态码映射、`404`、流式输出、`mount()`、超时（硬/软/客户端覆盖）、`AbortSignal` 传播，以及 `102` 后台任务轮询。

## 📚 相关文档

- [`@isdk/tool-rpc`](https://github.com/isdk/tool-rpc) — 传输层架构、dispatcher、超时与任务跟踪
- [`@isdk/tool-func`](https://github.com/isdk/ai-tool) — 工具模型（`ToolFunc`、`ServerTools`、`ClientTools`）
- 生成的 API 文档：`pnpm run doc:md` → `docs/`

## 🤝 贡献

1. Fork → `git clone`
2. 新建分支 → `git checkout -b feat/your-feature`
3. 提交 → `git commit -m 'feat: add XYZ'`
4. 推送 → `git push origin feat/your-feature`
5. 提 PR 🎉

请确保 `pnpm test` 与 `pnpm exec tsc --noEmit` 通过。

## 📜 许可证

MIT © [ISDK](https://github.com/isdk) — 详见 [LICENSE-MIT](./LICENSE-MIT) 文件。
