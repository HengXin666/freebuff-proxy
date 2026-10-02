# Agent Note: 上游请求形态做成前端可切换通道（legacy / official）

Status: implemented

## Problem

主服务的请求体是**自己拼**的：`ensureFreebuffSystemMessages()` +
`ensureFreebuffToolSignature()` + CLI 世代 agent。来源是早期第三方项目
加多年补丁，**已无法与官方逐字段核对**。

2026-10-03 抓到官方客户端真实流量后，对比出三处硬差异：

| | legacy（自拼） | official（抓包真值） |
|---|---|---|
| system | 2 句 CLI 开场白 | 官方模板（worker 7918 / manager 13443 字符） |
| tools | 客户端工具 + `lookup_agent_info`/`decide` | 官方 37 个真实工具 |
| agent | `base3-free-catalog`（CLI 世代） | `freebuff-desktop-thread-local-v3`（desktop 世代） |

其中 `lookup_agent_info` **在 desktop 37 工具里根本不存在**——我们从 CLI 侧抄来的。

但直接把默认值改成 official 会让大量 legacy 行为与测试失效。
逐个改测试去迁就实现，是**没有依据的乱搞**，被明确制止。

## Decision

**做成运行时可切换的通道，前端「设置」页下拉选择，默认 `legacy`（零回归）。**

- `settingsStore.upstreamChannel`：`'legacy'`（默认）/ `'official'`
- 优先级：`settingsStore`（前端可调）> `config.upstream.channel`（兜底）
- official 通道下：
  - system 用官方模板（manager 层会替换掉抓包时那条死 mission）
  - tools = **官方 37 个 + 客户端工具按名去重合并**（不是替换，
    否则不在官方集里的自定义工具会静默消失）
  - 客户端**没声明**工具时不发工具集（没要工具就别背 37 个的 token）
  - agentId 用 desktop 世代；provider 分层（manager `allow_fallbacks` /
    worker `data_collection: deny`）；`tool_choice: 'auto'`
- `stripToolsOnSchemaRejection` 退路**仅 legacy 生效**：official 发的是
  官方工具集，本就不触发 tool-schema 拒绝，剥离反而会丢掉官方工具集。

官方资产随代码发布在 `src/upstream/official-assets/`（不依赖 docs 目录，
避免被裁剪），由 `src/upstream/official-shape.js` 加载。

## Alternatives considered

- **直接把 official 设为默认** —— 方向正确但会造成大面积回归，
  且 official 尚未在主服务（Node 侧）实机验证过（cli-bridge 验证过，
  主服务被配额挡住）。默认切过去等于把未验证路径强加给所有用户。**否决。**
- **改测试去适配 official** —— 这是没有依据地迁就实现，
  会把 legacy 的既有契约（工具集、开场白）悄悄改掉。**明确禁止，已回退。**
- **只保留 official、删除 legacy** —— 无法回退；official 一旦有问题
  没有退路。**否决**，保留 legacy 作为可回退通道正是本设计的价值。
- **双实现长期并存各自维护** —— 本设计把官方形态**移植进主服务**
  （`official-shape.js`），不 spawn bun 子进程，因此只有一个代码库，
  不引入 79MB 依赖。

## Consequences

- 默认行为**完全不变**（legacy），现有测试全部通过（`smoke ok`）。
- 前端「设置」页新增「上游请求链路」下拉，admin 可切，立即生效、持久化。
- API `GET/POST /api/settings` 支持 `upstreamChannel`，非法值 400。
- 待配额重置后在主服务验证 official，再决定是否切默认。

## Evidence

- `docs/reverse/captures/2026-10-03-official-client.jsonl`（抓包真值）
- `docs/reverse/15-protocol-review.md` P0-2 / P0-3 / P0-4
- `docs/reverse/17-current-status-and-gaps.md`
- cli-bridge 实测：official 形态 200 + write_file 工具调用
  （`docs/reverse/16-success-200-with-toolcall.md`）
- 端到端验证：GET 读回 official → POST 切 legacy → 读回 legacy；
  非法值 `bogus` 返回 400；`data/settings.json` 持久化正确。
