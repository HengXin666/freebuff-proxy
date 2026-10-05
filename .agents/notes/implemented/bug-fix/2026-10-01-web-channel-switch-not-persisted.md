# Agent Note: webChannelEnabled 写盘后读不回 —— 网页通道开关从来没生效过

Status: implemented

## Problem

`SettingsStore` 的 `load()` 只白名单读了 8 个字段,**漏了 `webChannelEnabled`
与 `cliTelemetryEnabled`**.两者都能经 `save()` 写进 `/data/settings.json`
(`src/web/settings-store.ts:184-195` 有校验并写盘),但重启后一律回落到
`DEFAULT_SETTINGS` 的 `false`.

症状是**静默**的:控制台显示开关已开,`settings.json` 里也是 `true`,
而运行时是 `false`.所以请求照旧走 CLI 通道.

它掩盖了一个已经写好,且本该生效的能力:
[2026-09-30-web-chat-stream-transport.md](../../archived/feature/2026-09-30-web-chat-stream-transport.md)
记录"同一账号同一出口,CLI 通道 503,网页通道正常".但因为开关读不回,
这条结论在端到端实测里**从未兑现过** —— 本次排查就因此把 503 一路误判成
模型映射,工具指纹,凭据来源,连续三轮跑偏.

## Decision

**`load()` 补齐这两个布尔字段的读回**,并在原地注释说明为什么不能漏.
同时补一条往返回归(save → 新实例 load → 断言读回),锁住这类"能写不能读"的
不对称.

只补读,不改默认值:`webChannelEnabled` 默认仍为 `false`(保持既有行为,
切换通道是显式选择).

## Alternatives considered

- **什么都不做** —— 最强理由是:默认关闭本来就是既定行为,漏读只是让它"更稳定
  地关闭".但它让一个已实现的通道永久不可达,且失败方式完全静默(开关显示开,
  实际关),排查成本是三轮全跑偏的实测.
- **把默认值改成 true** —— 能让网页通道立刻生效,但那是**改行为**不是**修 bug**;
  limited 档位之外(allowlist 国家/非 VPN)CLI 通道本来正常,无差别切通道会把
  不需要切的场景也切走,且绕过了"由控制台显式决定"的既有约定.
- **改成全量读取(不再白名单)** —— 一劳永逸.但白名单的意义正是"未知/脏字段
  不得覆盖默认值"(同文件其它字段都靠它挡住类型污染),全量放开等于拆掉那道
  防线;本次只需补两个已知字段.
- **让前端在启动时回写一次设置** —— 能绕过,但把"持久化"的责任推给 UI,
  服务端重启后未访问控制台就仍是默认值,是不可靠的.

## Consequences

- 控制台打开网页通道后重启**保持**开启,网页通道首次真正可达.
- `cliTelemetryEnabled` 同样不再静默丢失(目前仍默认关闭).
- 两个开关的行为与 `settings.json` 的字面值一致,不再出现"写着 true,跑着 false".

## Evidence

- 修前实测(官方客户端授权的真凭据,同一出口):`settings.json` 为
  `webChannelEnabled: true`,但 chat 仍走 CLI 通道并 503 —— 日志里没有任何
  web channel 记录,只有 `upstream chat non-ok status=503`.
- 修后同一请求:`HTTP 200`,日志 `web channel completion done, model=mimo-v2.5,
  chars=507`,模型正常作答(但**未返回 tool_calls**,见下).
- 上游判据(同一次会话回执):`countryCode: JP`,`reason: anonymous_network`,
  `ipPrivacySignals: [vpn, res_proxy, hosting, anonymous]`,`accessTier: limited`.
- `npm test` 通过(含新增往返回归),`npm run typecheck` 干净.

 **实测边界**:网页通道**不传 tools**.本次响应是纯文本作答
("I don't have a get_weather tool available"),没有 `tool_calls`.
`src/upstream/web-chat.js` 与 `web-chat-openai.js` 里没有任何 tools 相关代码,
官方网页端点也不接该参数.所以**网页通道解决的是"能不能回",不是"能不能调工具"**
—— 拿到真正的 tool_calls 需要在网页通道层补 tools 映射,属另一项工作.

## Testing

- `test/smoke.mjs` 新增:save 两个开关 → 新实例 load 断言读回 true;
  未配置时断言默认 false(防止反向漏读成 true).
- 端到端 n=1:修后单次带工具请求 HTTP 200.

## Related

- [2026-09-30-web-chat-stream-transport.md](../../archived/feature/2026-09-30-web-chat-stream-transport.md):
  网页通道本身与其协议形态(本次才首次真正生效).
- [2026-10-01-chat-503-not-model-mapping.md](2026-10-01-chat-503-not-model-mapping.md):
  503 不是模型映射的判据;本次把根因定位到通道 + 出口判定.
- [2026-10-01-settings-optional-chain.md](2026-10-01-settings-optional-chain.md):
  同一轮排查中修掉的另一处设置读取缺陷.
