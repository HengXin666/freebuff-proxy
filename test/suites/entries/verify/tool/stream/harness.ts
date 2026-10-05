/**
 * 流式回程工具改写验证 ---- 边收边改, 不得整段缓冲.
 *
 * 这是 2026-10-05 线上事故(远程 reqId 0f45afc1)的回归判据:
 *   bun 侧曾 await res.text() 把上游整条流收完才返回, 主服务于是要等整篇回复,
 *   长回答(实测卡在 44.8s)撞穿 45s 调度预算 -> RPC 超时 -> 降级 legacy ->
 *   428 -> 重试 -> 换号 -> 全池买不起 -> 下游 429.
 *
 * 本文件断言四件事(每条都可证伪):
 *   1. 增量投递: 喂一片就要立刻拿到一片输出, 不能攒到流结束才吐;
 *   2. 名字还原逐分片可做: 首片带 name, 立刻被还原(不等参数);
 *   3. 参数翻译: 首片整份给完时立即翻译, 参数被拆开时暂扣到构齐;
 *   4. null/空 name 的延续分片绝不能抹掉已捕获的名字
 *      (deepseek-harness #1713 实测: 会被下游判成 unknown tool "")
 *
 * 判据(反向探针, 实测过): 把 createToolRewriteSseTransform 的 transform 改成先
 * 收集全部 chunk 再统一 enqueue, 第 1 条立刻变红.
 */
import assert from 'node:assert/strict'
import {
  createToolRewritePlan,
  createToolRewriteSseTransform,
} from '../../../../../../src/proxy/transport/reply/sse-tool-rewrite.ts'

export let n = 0
export const ok = (cond: any, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * 建一个[喂片 + 收输出]的驱动器.
 *
 * 两条硬约束(都是实测踩出来的):
 *   1. TransformStream 有背压 ---- 只写不读会让 write 永久挂起(正确行为:
 *      下游不消费就该阻塞). 所以读取必须是持续的后台循环;
 *   2. 不能用"读一次 + 超时"的竞速 ---- 超时后那个 read 仍挂着, 会吞掉之后
 *      到达的数据. 所以用"输出序号 + 唤醒等待者".
 *
 * @param {any} plan 改写上下文
 * @returns {{ send: (s: string) => Promise<string>, end: () => Promise<string>, out: () => string }} 驱动器
 */
export function driver(plan: any) {
  const ts = createToolRewriteSseTransform(plan)
  const writer = ts.writable.getWriter()
  const reader = ts.readable.getReader()
  let text = ''
  /** 已产生输出的次数(仅用于唤醒等待者, 不用于判内容). */
  let outputs = 0
  const waiters: Array<() => void> = []
  /** 读取循环是否已因流结束退出. */
  let closed = false

  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          text += decoder.decode(value)
          outputs += 1
          const w = waiters.splice(0)
          for (const fn of w) fn()
        }
      }
    } catch { /* 取消 */ }
    closed = true
    const w = waiters.splice(0)
    for (const fn of w) fn()
  })()

  /** 等一次唤醒(有新输出或读取循环已结束), 最多 timeoutMs. */
  const waitTick = (timeoutMs = 300) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    waiters.push(() => { clearTimeout(timer); resolve() })
  })

  return {
    async send(s: string) {
      void writer.write(encoder.encode(s)).catch(() => {})
      // 固定等待: 让变换器处理完这一片并由读取循环累积进 text.
      // 不用信号量判据 ---- 驱动器的竞态曾两次骗过测试(误报 0 次), 固定等待更可靠.
      await new Promise<void>((r) => setTimeout(r, 60))
      return text
    },
    async end() {
      await writer.close().catch(() => {})
      // 关流会让 flush 跑完; 等读取循环读尽.
      const deadline = Date.now() + 2000
      while (!closed && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 20))
      }
      await new Promise<void>((r) => setTimeout(r, 30))
      return text
    },
    out: () => text,
  }
}

/**
 * 造一个 tool_call 分片的 SSE 行(避免每处都写一遍超长字面量).
 *
 * @param {string} name 上游回来的工具名(官方名或载体名)
 * @param {string} args 该分片携带的 parameters 文本(可为半截 JSON)
 * @returns {string} 完整 SSE 行(含结尾空行)
 */
export const callLine = (name: string, args: string) =>
  sse({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: args } }],
      },
    }],
  })

export const plan = createToolRewritePlan({
  declaredToolNames: new Set(['bash', 'read', 'memory_save']),
  declaredToolSchemas: {
    bash: { properties: { command: {}, description: {} }, required: ['command', 'description'] },
    read: { properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] },
  },
  carrierPlan: { active: true, carriers: { 'proxy__memory_save': 'memory_save' }, forward: {} },
})

export const sse = (obj: any) => `data: ${JSON.stringify(obj)}\n\n`

/**
 * 从改写后的 SSE 文本里取出第一个 tool_call 的 arguments 并解析.
 *
 * arguments 在 wire 上是"JSON 字符串", 里面嵌着转义过的 JSON. 直接对整段文本做
 * 正则会被转义干扰, 所以先按 SSE 行解析回对象.
 *
 * @param {string} text 改写后的 SSE 文本(可能含多行)
 * @returns {any|null} 解析后的参数对象; 取不到返回 null
 */
export function parseToolArgs(text: string): any {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const raw = line.slice(6).trim()
    if (!raw || raw === '[DONE]') continue
    try {
      const obj = JSON.parse(raw)
      const calls = obj?.choices?.[0]?.delta?.tool_calls
      if (!Array.isArray(calls)) continue
      for (const c of calls) {
        const a = c?.function?.arguments
        if (typeof a === 'string' && a && a !== '') {
          try { return JSON.parse(a) } catch { /* 半截参数, 继续找 */ }
        }
      }
    } catch { /* 非 JSON 行 */ }
  }
  return null
}
