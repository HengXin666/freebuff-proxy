/**
 * 流式回程工具改写验证 ---- 边收边改, 不得整段缓冲.
 *
 * 这是 2026-10-05 线上事故(远程 reqId 0f45afc1)的回归判据:
 *   bun 侧曾 await res.text() 把上游整条流收完才返回, 主服务于是要等整篇回复,
 *   长回答(实测卡在 44.8s)撞穿 45s 调度预算 -> RPC 超时 -> 降级 legacy ->
 *   428 -> 重试 -> 换号 -> 全池买不起 -> 下游 429.
 *
 * 驱动器与夹具在 ./stream/harness.ts; 本文件只放断言.
 */
import { ok, driver, callLine, plan, sse, parseToolArgs, n } from './stream/harness.ts'

// ── ① 增量投递: 一片进, 一片出(不得攒到结束) ────────────────────
{
  const d = driver(plan)
  const first = sse({
    choices: [{ index: 0, delta: { content: 'hello' } }],
  })
  const afterFirst = await d.send(first)
  ok(
    afterFirst.includes('hello'),
    '第一片内容必须在写入后立刻可读(增量投递, 不得攒到流结束)',
  )
  await d.end()
}

// ── ② 名字还原: 首片带 name 立即还原(不等参数) ──────────────────
{
  const d = driver(plan)
  // 上游按官方名发: bash -> run_terminal_command
  const afterName = await d.send(callLine('run_terminal_command',''))
  ok(
    afterName.includes('"name":"bash"'),
    '首片带官方名时必须立刻还原成下游名(bash), 不等参数',
  )
  ok(
    !afterName.includes('run_terminal_command'),
    '还原后不得残留官方名',
  )
  await d.end()
}

// ── ③ 参数整份给完: 立即翻译, 零额外延迟 ────────────────────────
{
  const d = driver(plan)
  const out = await d.send(callLine('run_terminal_command','{"command":"uname -a"}'))
  ok(out.includes('"name":"bash"'), '整份参数: 名字已还原')
  ok(out.includes('uname -a'), '整份参数: 参数内容已下发')
  // 注意: arguments 是 JSON 字符串, 序列化后内部的键是转义的(\"description\").
  // 所以要解析出来判, 不能直接对原文做 /"description"/.
  const args = parseToolArgs(out)
  ok(args && args.description != null, `整份参数: 下游必填的 description 已合成; 实际 ${JSON.stringify(args)}`)
  ok(args && args.file_path === undefined, '整份参数: 不得留下官方字段名')
  await d.end()
}

// ── ④ 参数被拆开: 暂扣到构齐, 且顺序不乱 ────────────────────────
{
  const d = driver(plan)
  // 第一片: name 有, 参数是半个 JSON
  const a = await d.send(callLine('run_terminal_command','{"command":"ls '))
  // 首片的名字必须已下发(名字不需要等参数)
  ok(a.includes('"name":"bash"'), '参数未构齐时: 名字仍应立即下发')
  // 第二片: 补完 JSON
  await d.send(sse({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '-la"}' } }] } }],
  }))
  const text = await d.end()
  const args = parseToolArgs(text)
  ok(args && String(args.command).includes('ls -la'), `参数构齐后必须补发完整参数; 实际 ${JSON.stringify(args)}`)
  await d.end()
}

// ── ⑤ null name 的延续分片不得抹掉已捕获的名字 ──────────────────
{
  const d = driver(plan)
  await d.send(callLine('run_terminal_command','{"command":"x"}'))
  const cont = await d.send(sse({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '' } }] } }],
  }))
  // 延续分片里的 null name 若被原样透传, 下游累积器会把名字抹成空 -> unknown tool ""
  ok(
    !/"name":null/.test(cont),
    '延续分片带 null name 时必须剔除该键(否则下游累积器抹掉工具名 -> unknown tool "")',
  )
  await d.end()
}

// ── ⑥ 载体工具名拆包(memory_save) ──────────────────────────────
{
  const d = driver(plan)
  const out = await d.send(callLine('proxy__memory_save','{"content":"hi"}'))
  ok(out.includes('"name":"memory_save"'), '载体名 proxy__memory_save 必须拆回 memory_save')
  await d.end()
}

// ── ⑦ 非 data 行 / [DONE] / 畸形 JSON 一律原样透传 ───────────────
{
  const d = driver(plan)
  const out = await d.send(': keepalive\n')
  ok(out.includes(': keepalive'), '非 data 行必须原样透传')
  const done = await d.send('data: [DONE]\n\n')
  ok(done.includes('[DONE]'), '[DONE] 必须原样透传')
  const bad = await d.send('data: {not json\n\n')
  ok(bad.includes('{not json'), '畸形 JSON 必须原样放行(改写是增强不是必经环节)')
  await d.end()
}

// ── ⑧ 参数不得被拼装两次(补发分片与就地替换重复) ────────────────
// 实测踩到的形态: 构齐那一行已就地换成翻译结果, 若再补发一次, 下游按 index
// 累积就得到 {..}{..} 而不是 {..} ---- JSON.parse 直接抛错.
// 注意参数在 wire 上是"JSON 字符串", 所以判据必须解析出来比, 不能对原文找字段名.
{
  const d = driver(plan)
  // 分两片给参数, 再把流关掉(关流会触发 flush 的兜底补发路径).
  await d.send(callLine('run_terminal_command', '{"command":"ls '))
  await d.send(callLine('run_terminal_command', '-la"}'))
  const text = await d.end()
  // 数出所有非空 arguments 分片: 只能有一个承载完整参数的片.
  const argFragments = toolArgFragments(text)
  ok(
    argFragments.length === 1,
    `承载参数的片只能有一个, 不得被补发机制重复下发; 实际 ${argFragments.length} 个: ${JSON.stringify(argFragments)}`,
  )
  const args = parseToolArgs(text)
  ok(args && args.command === 'ls -la', `关流后参数仍完整; 实际 ${JSON.stringify(args)}`)
}

// ── ⑨ 流在参数未构齐时结束: 兜底补出已累积的文本 ─────────────────
{
  const d = driver(plan)
  // 只给半个 JSON 就关流: 不能把参数丢掉.
  await d.send(callLine('run_terminal_command', '{"command":"trunca'))
  const text = await d.end()
  ok(
    text.includes('trunca'),
    '流结束时仍未构齐的参数必须原样补出(截断的响应也比丢响应好)',
  )
}

/**
 * 取出所有非空 arguments 分片(按到达顺序).
 *
 * 用途: 判"承载完整参数的片只能有一个"; 参数在 wire 上是 JSON 字符串, 所以
 * 这里按 SSE 行解析回对象再取 arguments, 不对原文做字符串匹配.
 *
 * @param {string} text 改写后的 SSE 文本(可含多行)
 * @returns {string[]} 非空 arguments 文本列表
 */
/**
 * 取出所有非空 arguments 分片(按到达顺序).
 *
 * 用途: 判"承载完整参数的片只能有一个"; 参数在 wire 上是 JSON 字符串, 所以这里
 * 按 SSE 行解析回对象再取 arguments, 不对原文做字符串匹配.
 *
 * @param {string} text 改写后的 SSE 文本
 * @returns {string[]} 非空 arguments 文本列表
 */
function toolArgFragments(text: string): string[] {
  const out: string[] = []
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
        if (typeof a === 'string' && a !== '') out.push(a)
      }
    } catch { /* 非 JSON 行 */ }
  }
  return out
}

console.log(`ok tool-stream-rewrite (${n} 断言)`)
