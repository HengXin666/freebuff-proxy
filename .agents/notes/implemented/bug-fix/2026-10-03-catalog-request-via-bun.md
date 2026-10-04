# Agent Note: catalog 请求必须跑在 bun 上才与客户端一致(Node 会多两个头)

Status: implemented

## Problem

用户一直在问:[请求上游模型是不是跟客户端那个一致的?]——这个问题
之前一直没被正面回答,因为**只看代码看不出来**:代码里写的头集与客户端
一致,但**实际发出的**多两个.

用本地镜像服务器(把 `api_base` 指向 `127.0.0.1:9544`)抓我方真实发出的
原始头,与客户端抓包逐项比对:

| 头 | 客户端(bun) | 我方(Node 26) |
|---|---|---|
| `connection` | keep-alive | keep-alive |
| `authorization` | Bearer ... | Bearer ... |
| `x-freebuff-catalog-protocol` | 1 | 1 |
| `x-freebuff-client` | desktop | desktop |
| `user-agent` | Bun/1.4.2 | Bun/1.4.2 |
| `accept` | `*/*` | `*/*` |
| `accept-encoding` | gzip, deflate, br, zstd | gzip, deflate |
| **`accept-language`** | **无** | **`*`**  |
| **`sec-fetch-mode`** | **无** | **`cors`**  |

后两个是 **Node 26 内置 fetch 自动加的**,不是我们的代码.用裸
`fetch()` 对照即可复现:

```
Node 26   → accept-language: * / sec-fetch-mode: cors（自动）
Bun 1.4.2 → 只有 5 个业务头（与客户端逐项一致）
```

`sec-fetch-mode` 是 **forbidden header**,显式设空串也设不掉
(实测设 `''` 后它仍是 `cors`).`accept-language` 可以设空消除.

## Decision

**catalog 这一跳在 bun 里发**(与官方客户端同一个运行时).

- `CatalogHolder` 新增 `bunFetch` 通道(由 `client.js` 注入).
- 解析逻辑抽成 `_apply(body)`,bun 路径与 Node 路径**共用一份解析**,
  避免两套逻辑漂移.
- bun 不可用(未随镜像分发 / 执行失败)时静默退回 Node 路径:
  功能不降级,只是头集差两项.
- `cli-bridge/upstream.mjs` 的 `fetchCatalog()` 同步对齐:
  补 `x-freebuff-client: desktop`,**去掉设备签名**(带了会拿到 53 行,
  见 `2026-10-03-catalog-fetch-unsigned.md`).
- Node 路径仍保留,并把能改的都改掉:`accept-language: ''`,
  `accept-encoding: gzip, deflate, br, zstd`.

## Consequences

- catalog 请求头与客户端**逐字节一致**(bun 路径).
- 目录行数稳定为 **13**(该账号口径),与客户端 UI 菜单逐项一致.
- 多一个进程外依赖:bun 二进制(79MB).它本来就在仓库里
  (`cli-bridge/bun`),且 chat 链路已经在用,不是新增成本.
- Node 路径作为 fallback 保留,可通过日志区分走了哪条
  (`catalog fetched via bun` vs `catalog fetched`).

## Alternatives considered

- **只改 Node 的头,不引 bun**:做不到.`sec-fetch-mode` 是 forbidden
  header,Node 强制发送,无法覆盖.
- **用 undici 低层 API 绕开**:undici 的 `request()` 仍会走同一套
  header 规范化;且项目铁律是"仅 2 个运行时依赖",不该为此加复杂度.
- **保留 Node 路径,接受差两个头**:与用户"必须与客户端一致"的要求
  直接冲突;且 `sec-fetch-mode: cors` 是浏览器语义,服务端一眼能看出
  这不是官方客户端.
- **全部请求都搬进 bun**:范围过大.本次只搬 catalog(用户问的这一跳),
  device-keys / session 仍是 Node(已知差异,下一步处理).

## Verification

1. 本地镜像抓真实头:Node 多 `accept-language` / `sec-fetch-mode`;
   bun 只发 5 个业务头.
2. 改后日志出现 `catalog fetched via bun (client-identical headers)`,
   `rows: 13`.
3. 真实上游下点[同步上游模型]→ 13 条,单价正确,
   version `v0.g1.e82918.limited.5`.
4. 全程零 admission,零 chat.

## 方法沉淀

**代码写的头 ≠ 实际发出的头.** 以后凡是"是否与客户端一致"的判断,
必须用本地镜像抓真实报文,不能只读代码.配置文件默认读
`./config.yaml`(仓库根),不是 `data/config.yaml` —— 改错过一次.
