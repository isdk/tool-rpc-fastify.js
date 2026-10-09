# Contributing — @isdk/tool-rpc-fastify

本包只放 Fastify transport 自己的约定。传输层的通用规则（声明身份 vs 绑定观测、canonical URI 归一、unix socket 身份的编码约定、路由声明内核）见 [`../tool-rpc/CONTRIBUTING.md`](../tool-rpc/CONTRIBUTING.md)。

## 本地检查

```shell
./node_modules/.bin/tsc --noEmit   # 类型检查
npx eslint .                       # flat config：eslint.config.mjs
npx vitest run                     # 3 files / 36 tests
```

- **别用 `npx tsc`**：会命中 npm 上的占位包 `tsc`（“This is not the tsc command you are looking for”），与代码无关。
- 本包依赖的是 `@isdk/tool-rpc` 的 **dist**。改了 `../tool-rpc/src/**` 后必须先在那边 `npx tsup --dts --dts-resolve`，否则这里跑的是旧 bundle，测试会「莫名通过/失败」。

## listen 参数映射（`_start`）

Fastify 的 `listen()` 与 Node 的 `server.listen()` 在 socket 参数上不同名、也不同优先级，这里是本包最容易踩错的地方：

- **只认 `path`**：`socketPath` / `socket` 会被静默忽略。声明身份三个名字都认（`path` / `socketPath` / `socket`），监听时也必须改名成 `path` 并删掉另两个，否则「声明的底座」与「真实监听」会分叉。
- **声明了 socket 就删掉 `port` / `host`**：`port` 存在时 Fastify（与 Node 一致）会丢掉 `path`，改听 TCP。所以 socket 声明优先，不给它补默认端口。
- **不要无条件补 `port: 3000`**：实测那样会让 `start({ path })` 变成监听 TCP 3000，声明身份与真实监听错开、审计失效。默认端口只在没有 socket 时补（且必须 `Number(...)`——`options.port` 可能是环境变量那种字符串）。
- `defaultBindOptions()` 必须与 `_start()` 的回落完全一致：apiUrl 是裸 path 前缀时，bind 参数加这些默认值是**唯一**关于物理底座的声明。
- `_start()` 失败要 `throw`，不能 `process.exit(1)`：库不该杀宿主进程，测试也依赖 `EADDRINUSE` 可捕获。

## socket 文件生命周期

Fastify 关闭时会删除 socket 文件，Node 的 `http.Server` 不会。跨 transport 混用同一 socket 时不要假设两边行为一致；测试里用唯一临时路径 + `finally` unlink，别复用固定路径。

## 重复路由

路由声明的簿记（`routeClaims` / `claimRoute()` / `remount: 'replace' | 'throw'`）在 `@isdk/tool-rpc` 的 `ServerToolTransport` 基类，本包**不要**另建路由表。只覆写 `onDuplicateRoute()`：重新注册一次路由，让 find-my-way 抛它原生的 `FST_ERR_DUPLICATED_ROUTE`，错误形式与框架一致。

## 跨包一致性测试

`src/fastify-server.routes.test.ts` 会拿 `HttpServerToolTransport` 交叉验证：同一端口 / 同一 socket 上两个 transport 挂同一前缀必须被 `RpcTransportManager` 报 `Routing Conflict`。改动声明身份的形式（canonical URI 归一、unix 路径的 percent-encode）时，要同时回归 `../tool-rpc/src/transports/physical-identity.test.ts`，两边共用同一套归一化实现，任何一边单独改都会让审计 key 对不上。

## 文档

`README.md` 与 `README.cn.md` 的 API 表格需同步（列数保持一致，别破坏 markdown 结构）；跨包的设计决策与已知问题记在 `dev.md`。
