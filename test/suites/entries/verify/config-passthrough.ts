/**
 * 出站配置透传契约 -- 防[主服务配了却在 bun 侧被静默丢弃].
 *
 * 背景(2026-10-06 实测缺陷, 用户报"前端工具注入改了不生效"):
 * 控制台的[官方工具注入]勾选改了以后, 出站 tools 一个都没少. 根因不是
 * 前端也不是状态存储, 而是 bun 侧两层"逐项挑字段"转发:
 *
 *   cli-bridge/lib/upstream/actions.ts 的 actReuse  只挑 6 个字段
 *   cli-bridge/lib/endpoints/session.ts 的 reuseChat 只挑 7 个字段
 *
 * 主服务在 Node 侧算好的 officialToolNames / systemPrompt / layer /
 * reasoningEffort 走到这里全被吃掉, 于是下游行为与配置完全无关.
 *
 * 既有防线全漏的原因与 chat-payload-contract 同源: cli-bridge/ 不在
 * tsconfig 的 include 里, tsc 看不见"少传一个可选参数"; 而没有任何测试
 * 真执行过 reuse 这条路径.
 *
 * 判据(可证伪): 给 reuseChat 传入的四项配置必须出现在最终 chat 的入参里.
 * 把 reuseChat 的展开透传改回逐项挑字段, 本文件即红.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..')

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n += 1
}

const { reuseChat } = await import('../../../../cli-bridge/lib/endpoints/session.ts')

/**
 * 造一个只记录调用的假 bridge.
 *
 * 为什么不用真 bridge: 本判据要验的是[参数有没有走到 chat], 一旦真发请求,
 * 失败原因会混进网络/凭据, 判据本身就不再单纯.
 *
 * @returns {{bridge: any, seen: any[]}} 假 bridge 与其收到的 chat 入参
 */
function makeBridge() {
  const seen: any[] = []
  return {
    seen,
    bridge: {
      async chat(opts) {
        seen.push(opts)
        return { status: 200, text: '', messageId: null }
      },
    },
  }
}

// -- (1) reuseChat 必须透传全部上游能力字段 ----------------------------
// 这四项是控制台/主服务真的会设, 而 bun 侧必须消费的配置.
{
  const { bridge, seen } = makeBridge()
  const tools = [{ type: 'function', function: { name: 'glob' } }]
  await reuseChat(bridge, {
    row: { handle: 'h1' },
    instanceId: 'inst-1',
    runId: 'run-1',
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    stream: true,
    layer: 'manager',
    reasoningEffort: 'high',
    officialToolNames: ['glob'],
    systemPrompt: { mode: 'none' },
  })
  ok(seen.length === 1, 'reuseChat 必须恰好调一次 chat')
  const got = seen[0]
  ok(got.layer === 'manager', `layer 必须透传, got ${JSON.stringify(got.layer)}`)
  ok(got.reasoningEffort === 'high', `reasoningEffort 必须透传, got ${JSON.stringify(got.reasoningEffort)}`)
  ok(
    JSON.stringify(got.officialToolNames) === JSON.stringify(['glob']),
    `officialToolNames 必须透传(控制台[官方工具注入]靠它), got ${JSON.stringify(got.officialToolNames)}`,
  )
  ok(
    got.systemPrompt?.mode === 'none',
    `systemPrompt 必须透传(控制台[官方 system]靠它), got ${JSON.stringify(got.systemPrompt)}`,
  )
  ok(JSON.stringify(got.tools) === JSON.stringify(tools), 'tools 必须原样透传')
  ok(got.stream === true, 'stream 必须透传')
}

// -- (2) 默认值不得被透传逻辑改坏 --------------------------------------
// 空数组是[一个都不注入]的合法值, 不能因为"空数组是假值"被丢掉.
{
  const { bridge, seen } = makeBridge()
  await reuseChat(bridge, {
    row: { handle: 'h1' }, instanceId: 'i', runId: 'r',
    messages: [], tools: [], officialToolNames: [],
  })
  ok(
    Array.isArray(seen[0].officialToolNames) && seen[0].officialToolNames.length === 0,
    '空数组必须原样透传(它表示[一个都不注入], 与 undefined 语义不同)',
  )
  ok(seen[0].stream === false, 'stream 未给时必须回落 false')
  ok(seen[0].streamStdout === false, 'streamStdout 未给时必须回落 false')
}

// -- (3) actReuse 分发层也必须带上这四项 -------------------------------
// 上面验的是 reuseChat; 这里是它的上一层. 两层各丢一次, 只修一层不算修好.
{
  const { runAction } = await import('../../../../cli-bridge/lib/upstream/actions.ts')
  const seen: any[] = []
  const bridge = {
    catalog: { rows: [{ key: 'm-1', handle: 'h-1', displayName: 'M1' }] },
    async fetchCatalog() { return { rows: [{ key: 'm-1', handle: 'h-1', displayName: 'M1' }] } },
    async startRun() { return { status: 200, runId: 'run-9' } },
    async reuseChat(opts) {
      seen.push(opts)
      return { status: 200 }
    },
  }
  // runAction 是[返回结果]形态, 且会先自己抓一次 catalog.
  const out = await runAction(bridge, {
    action: 'reuse',
    modelKey: 'm-1',
    instanceId: 'inst-9',
    messages: [{ role: 'user', content: 'x' }],
    tools: [],
    stream: true,
    layer: 'worker',
    reasoningEffort: 'low',
    officialToolNames: ['read_files'],
    systemPrompt: { mode: 'custom', text: 'X' },
  })
  ok(out.ok === true, `actReuse 必须成功, got ${JSON.stringify(out.error || out)}`)
  ok(seen.length === 1, 'actReuse 必须调一次 reuseChat')
  ok(
    JSON.stringify(seen[0].officialToolNames) === JSON.stringify(['read_files']),
    `actReuse 必须把 officialToolNames 交给 reuseChat, got ${JSON.stringify(seen[0].officialToolNames)}`,
  )
  ok(
    seen[0].systemPrompt?.mode === 'custom' && seen[0].systemPrompt?.text === 'X',
    `actReuse 必须把 systemPrompt 交给 reuseChat, got ${JSON.stringify(seen[0].systemPrompt)}`,
  )
  ok(seen[0].reasoningEffort === 'low', 'actReuse 必须透传 reasoningEffort')
}

// -- (4) 配置真的会改变出站体(buildTools / buildSystemMessages)--------
// 端到端判据: 同一份输入, 只改 officialToolNames, 出站 tools 必须不同.
{
  const { buildTools, buildSystemMessages } = await import('../../../../cli-bridge/lib/endpoints/chat-payload.ts')
  const official = [
    { type: 'function', function: { name: 'glob' } },
    { type: 'function', function: { name: 'list_directory' } },
    { type: 'function', function: { name: 'suggest_prompts' } },
  ]
  const all = buildTools('worker', [], official, null, undefined)
  ok(all.length === 3, `undefined 表示不裁剪, got ${all.length}`)
  const subset = buildTools('worker', [], official, null, ['glob'])
  const subsetNames = subset.map((t) => t.function.name)
  ok(
    subset.length === 1 && subset[0].function.name === 'glob',
    `按名单裁剪必须生效, got ${JSON.stringify(subsetNames)}`,
  )
  const none = buildTools('worker', [], official, null, [])
  ok(none.length === 0, `空数组 = 一个都不注入, got ${none.length}`)

  // system 三态
  const tpl = { worker: 'OFFICIAL {{X}}', manager: 'MGR' }
  const msgs = [{ role: 'system', content: 'client-sys' }, { role: 'user', content: 'u' }]
  const def = buildSystemMessages(msgs, 'worker', tpl, undefined)
  ok(def[0].role === 'system' && def[0].content.startsWith('OFFICIAL'), '未配置时必须用官方模板')
  const custom = buildSystemMessages(msgs, 'worker', tpl, { mode: 'custom', text: 'MY OWN' })
  ok(custom[0].content === 'MY OWN', `custom 必须用自定义正文, got ${custom[0].content}`)
  const noneSys = buildSystemMessages(msgs, 'worker', tpl, { mode: 'none' })
  ok(
    noneSys.some((m) => m.role === 'system' && m.content === 'client-sys'),
    'none 不得清掉客户端自己的 system(语义是[不加官方 system])',
  )
  ok(
    !noneSys.some((m) => m.content.startsWith('OFFICIAL')),
    'none 不得再注入官方 system',
  )
  ok(
    noneSys.filter((m) => m.role === 'system').length === 1,
    `none 时 system 消息只应剩客户端那一条, got ${noneSys.filter((m) => m.role === 'system').length}`,
  )
}

console.log(`出站配置透传契约验证通过(断言 ${n} 条)`)
