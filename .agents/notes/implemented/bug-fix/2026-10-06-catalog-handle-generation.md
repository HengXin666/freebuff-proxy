# Agent Note: 目录句柄是按代次签发的, 过期即重抓且跨进程只传目录 key

Status: implemented

## Problem

服务端每次抓目录都全量轮换模型句柄 `fbm1.*`(key / displayName / legacyDigests 稳定,
handle 不稳定 ---- docs/reverse/19 第 19.3 节已实测), 目录回执因此自带 `refreshAt`
(issuedAt 加 1800000ms). 本仓把 `refreshAt` 解析进字段后**没有任何消费方** ----
目录一旦抓到手就永不按它过期, 直到别的入口(控制台[同步上游模型])强制刷新.

后果在 2026-10-05 的远程 2.3.0 上完整暴露(远程 `/api/logs`, 17:19 到 19:04):

    catalog fetched version=v0.g1.e82926.limited.5     <- 17:19 启动时那一代
    chat forward model resolved outgoing=fbm1.AAEAAUPv...   <- e82926 的句柄
    official channel: rpc result ok=false
      error="model not found in catalog: fbm1.AAEAAUPv..."  <- 29/29 全失败
    upstream chat non-ok status=428 waiting_room_required

同一时刻上游已经是 `e82927`. 主服务持 `e82926` 的句柄, 而副仓库(cli-bridge)的
`reuse` 路径每次请求都 spawn 一个新 bun 进程, **自己重抓**一份 `e82927`, 于是
`pickRow(modelKey)` 拿着上一代句柄在它那份表里查不到任何一行. 两侧目录都健康,
差异只来自抓取时刻.

429 那批(`paid_window_model_mismatch`)是同一根因的另一面: 会话被绑在 deepseek 上,
请求却发向 MiMo, 换号也换不掉"每个账号都持着同一条付过费的一小时".

## Decision

目录代次的判据与跨代次该传什么标识, 集中在 `src/upstream/catalog/freshness.ts`:

- `catalogExpired(holder)` ---- 唯一判据是服务端明文 `refreshAt`; 回执缺它时永不过期.
  不引入本地 TTL: 那个数字只能来自服务端.
- `refreshIfExpired(holder)` ---- 过期才重抓一次, best-effort. 在
  `src/proxy/chat/run/turn.ts` 的一次上游调用前调用, 覆盖 official 与 legacy 两条路.
- `handleInCatalog(holder, handle)` / `keyForHandle(holder, handle)` ---- 只认目录行
  原文(同一行同时带 key 与 handle), 不另建反向表.
- `resolveWireModel(holder, assigned, fallback, { prefer })` ----
  `prefer='key'` 用于跨进程边界(副仓库自己重抓, 只有稳定身份不会错位);
  `prefer='handle'` 用于本进程直发(chat 的 `model` 必须是句柄), 且只认本目录这一代的
  句柄 ---- 上一代句柄按 `fallback` 重解析, 解析不出就退回该行的目录 key.

接线改动三处:

- `src/proxy/chat/run/turn.ts`: 一次上游调用前 `refreshIfExpired`.
- `src/proxy/transport/official/index.ts`: `modelKey` 由 `resolveWireModel(..., {prefer:'key'})`
  产出(原来是 `forwardBody.model`, 即主服务解析出的句柄).
- `src/proxy/transport/forward-body.ts`: `model` 由 `resolveWireModel(..., {prefer:'handle'})`
  产出.

同一处顺手修掉一条常驻假警告: official 通道下不再执行
`logForeignClientVerdict`. 那一跳的 tools 由副仓库按官方模板重建, 本函数的产物只是
过渡形态 ---- 拿它套判据必然报 `foreign_toolset`, 而实测同一个请求可以同时是
200(19:16 带 `run_code` 的请求: 警告与 `rpc result ok=true` 并存). 一条只在它
能反映真实形态时才有价值的警告, 常年为真等于噪声.

## Alternatives considered

- **给目录加一个本地 TTL(比如 10 分钟)** ---- 最省事, 且 cli-bridge 的 serve 层
  已有同样形状的 `CATALOG_TTL_MS = 10 分钟`. 但本地 TTL 与上游推进代次的节奏无关:
  TTL 内上游照样可能换一代(实测 17:19 到 18:57 之间就换了一次), TTL 外也可能一代没动.
  服务端已经在回执里给了 `refreshAt`, 用它才是判据, 猜一个数字则是把可判定的事实
  换成经验值.
- **在每次 chat 前无条件强制重抓** ---- 能根治错配, 但把"目录过期"变成"每请求一次
  额外上游调用", 对一个以省额度为立身之本的免费链路是反向优化, 且抓取本身也会被
  上游计入行为特征. 只在 `refreshAt` 之后抓, 正常路径零额外请求.
- **让副仓库不再自己抓, 由主服务把句柄下传** ---- 说的是同一件事的另一半, 也确实
  能消除错配. 但它把"bun 侧自己重抓"这个既有事实当成可变项 ---- reuse 路径上
  `runAction` 先 `fetchCatalog()` 是它自洽的一部分(非 reuse 的 action 同样依赖它).
  改边界比改标识贵: 传 key 之后, 谁抓谁解析, 两边都不需要相信对方的票据.
- **把上一代句柄直接当 key 用(不换)** ---- 省一次解析, 但句柄与 key 不是同一空间,
  上游拿到一个它没签发的句柄只会拒, 与改前等价.

## Consequences

- 目录的"新鲜度"从一个从未被读的字段变成有消费方的判据; `refreshAt` 缺失时行为与
  改前一致(不重抓), 因此老上游 / 夹具不受影响.
- 上游推进代次后, 第一个请求会多一次目录抓取; 之后 30 分钟内不再有额外抓取.
- 两个进程现在只交换稳定身份. 代价是 chat 的 model 多一次归一(索引查表),
  收益是"两侧抓取时刻不同"这一整类错配消失.
- official 通道的日志里不再出现 `upstream may treat request as a foreign client`.
  真实的外来工具名 / system 标记信号(`foreign_tool_names` / `foreign_system_prompt`)
  本来也不在 official 通道的这条路径上, 判据没有丢失, 丢失的是那条恒真的假阳性.

## Testing

`npm test` 的 `catalog-freshness` 套件(26 条断言)钉住五件事: 过期判据只认
`refreshAt`, 缺字段永不过期, `prefer=key` 三种输入都归一到目录 key, 
`prefer=handle` 不接受上一代句柄, 未就绪时不编造判据.

可证伪: 在 `resolveWireModel` 的 `prefer=handle` 分支开头插入
`if (isModelHandle(name)) return { model: name, reason: 'x' }`(即恢复旧行为),
该套件立即 exit 1; 移除后恢复绿.
