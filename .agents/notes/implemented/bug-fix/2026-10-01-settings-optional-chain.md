# Agent Note: 工具开关读取用 `?.get()?.`,别让可选链只保护到一半

Status: implemented

## Problem

`src/proxy.ts` 取[是否补齐官方真签名工具]的开关时写的是
`settingsStore?.get().freeToolSignatureEnabled`.可选链只覆盖到 `get` 之前:
`settingsStore` 存在而 `get` 不是函数,或 `get()` 返回 undefined 时,
`.freeToolSignatureEnabled` 这一跳抛 `TypeError`.

它所在的位置是**带工具的转发链路**上(`buildForwardBody` 里注入签名工具之前),
抛错等于带 tools 的请求整体失败 —— 而且表现为"带工具就挂,不带工具正常",
从症状反推极易误判成上游的第三方客户端判据(本次会话就是这样误判的:
先怀疑工具指纹,实际查下来工具 wire 形态 `["get_weather","lookup_agent_info","decide"]`
经本地判据 `detectForeignClient` 计算 `signal === null`,是干净的).

同一个文件里 `blockPremiumModels` 的读法写的是 `settingsStore?.get()?.x`
(`src/proxy.ts:276`)——两处写法不一致,新写法照抄错的那处就会重犯.

## Decision

**读设置一律 `?.get()?.`**,并在原地留一行注释说明为什么不能写成 `?.get().`.

本次只改了 `src/proxy.ts` 这一处(工具链路上的那个).`src/web/api.ts` 里另有
10 处同样的 `?.get().`,但那是控制台接口层:`SettingsStore#get()` 的实现恒返回
`{ ...this.settings }`(`src/web/settings-store.ts:131`),返回 undefined 不成立,
剩余风险只有"get 非函数"这种注入形态,属防御性收益 —— 批量改会让 diff 盖过本次
真正的语义,留到有实测触发时再统一收口.

## Alternatives considered

- **什么都不做** —— 最强理由是:`SettingsStore#get()` 恒返回对象,`get()` 返回
  undefined 这条路径目前走不到,改了也不会改变任何现有行为.但它掩盖了真实风险:
  可选链写成一半是一个**会传染的写法**,同文件已有一处正确写法作对照,复制时
  极易选中错的那个;而它炸掉的位置恰好会把故障伪装成"上游判第三方客户端",
  代价是一次完全跑偏的排查.
- **把 10 处一起改成 `?.get()?.`** —— 一致性最好.但那些位置不在带工具链路上,
  `get()` 契约已保证非空, 改动纯属防御性; 一次 11 处的机械 diff 会让 review 重点
  从"工具链路为什么炸"漂移到格式统一, 与本次定位的事实不符.
- **改 `SettingsStore#get()` 让它绝不返回 undefined** —— 治本, 但 `get()` 本来就
  恒返回对象, 加保护等于给不存在的分支写代码; 而且它挡不住"get 非函数".

## Consequences

- 带工具的请求在 store 异常时不再因读开关而抛错;最坏退化为不注入签名工具
  (`!== false` 在 undefined 下为 true,仍会注入),行为收敛而不是崩链路.
- 同一文件内两种写法归一,留了注释说明成因,后续照抄不会重犯.

## Testing

- `npm test`(smoke)通过,`npm run typecheck` 干净.
- 离线核对 wire 形态:客户端 `get_weather` + 注入的两个签名工具,
  `detectForeignClient` 得 `signal: null`,`hollowToolNames`/`foreignToolNames` 均为空.

## Related

- [2026-09-19-genuine-tool-signature.md](2026-09-19-genuine-tool-signature.md):
  签名工具的判据与注入形态(本次未改判据,只修了读开关的写法).
- [2026-10-01-catalog-agent.md](2026-10-01-catalog-agent.md):目录模式下 agent 与
  系统开场白的世代一致性(本次离线核对:catalog agent 是 base3,与 base3 开场同代).
