/**
 * chat 出站请求体契约验证 -- 防"构造函数忘了 return".
 *
 * 背景(2026-10-05 真实故障, 远程 400 实测): cli-bridge/lib/endpoints/
 * chat-payload.ts 的 buildBody 在按职责拆分时丢了 return body.
 * 于是 chat 那一跳以 body=undefined 调 fetch, 平台上变成空体 POST,
 * 上游回 400 {"message":"Invalid JSON in request body"} ---- 而从主服务
 * 看只是"账号侧 400", 与模型/额度/出口都无关, 极易误诊.
 *
 * 既有三道防线全漏的原因:
 *   1. tsconfig.json 的 include 只有 src 与 bin 两棵子树, cli-bridge/ 不在
 *      类型检查范围内, 所以 npm run typecheck 看不见这个错;
 *   2. syntax 门禁用 tsc --noCheck, 只解析语法不做类型检查, 漏;
 *   3. 没有任何测试真执行过 buildBody.
 *
 * 判据(可证伪): buildBody 必须返回"非空且可 JSON.parse 的字符串", 且
 * 经真实 fetch 出站时请求体非空. 把 return 删掉这条即红.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = path.join(import.meta.dirname, '..', '..', '..', '..')
const BUN = path.join(ROOT, 'cli-bridge', 'bun')

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n += 1
}

/**
 * 异步跑一次 bun 探针(不阻塞事件循环).
 *
 * 必须异步: 探针要回连本进程的 mock 上游, 用 spawnSync 会把事件循环
 * 卡死, 双方互等到超时(实测 SIGTERM / ETIMEDOUT).
 *
 * @param {string} scriptPath 探针脚本路径
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>} 子进程结果
 */
function runBun(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(BUN, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}` })
    })
  })
}

const payload = await import('../../../../cli-bridge/lib/endpoints/chat-payload.ts')

/**
 * 造一份最小可用入参(字段与 chat() 的真实调用一致).
 * @param {object} [overrides] 覆盖字段
 * @returns {object} buildBody 入参
 */
function makeOpts(overrides = {}) {
  return {
    row: { handle: 'fbm1.AAEAAUPuTEST' },
    metadata: { run_id: 'r1', cost_mode: 'free' },
    outMessages: payload.buildSystemMessages(
      [{ role: 'user', content: 'hi' }],
      'worker',
      null,
    ),
    outTools: [],
    layer: 'worker',
    stream: true,
    ...overrides,
  }
}

// -- (1) 纯函数层: 返回值必须是字符串 ----------------------------------
const body = payload.buildBody(makeOpts())
ok(
  typeof body === 'string' && body.length > 0,
  `buildBody 必须返回值(got ${typeof body}) ---- 空体 POST 会被上游判成非法 JSON`,
)

// -- (2) 可解析且字段齐全 --------------------------------------------
const parsed = JSON.parse(body)
const TOP_KEYS = ['model', 'codebuff_metadata', 'provider', 'messages', 'tools', 'tool_choice', 'stream']
for (const k of TOP_KEYS) {
  ok(k in parsed, `出站体必须含顶层键 ${k}`)
}
ok(parsed.model === 'fbm1.AAEAAUPuTEST', 'model 取目录句柄, 不是可读名')
ok(parsed.tool_choice === 'auto', 'tool_choice 契约固定 auto')

// -- (3) 同文件其它导出: 同类"忘了 return"一并通过 --------------------
ok(typeof payload.buildTools('worker', [], [], null) === 'object', 'buildTools 必须返回值')
ok(Array.isArray(payload.buildSystemMessages([], 'worker', null)), 'buildSystemMessages 必须返回值')
ok(typeof payload.buildHeaders === 'function', 'buildHeaders 必须存在')
ok(
  payload.extractMessageId('data: {"id":"chatcmpl-x"}\n') === 'chatcmpl-x',
  'extractMessageId 必须从 SSE 里取到 id',
)

// -- (4) 端到端: 真出站, 请求体非空 ----------------------------------
// 无 bun 时不能静默跳过("少跑一条"与"这条通过"在退出码上完全一样).
if (!fs.existsSync(BUN)) {
  console.log(`SKIP 端到端: 未找到 ${BUN}(tools/fetch-bun.sh 获取后重跑)`)
} else {
  // mock 上游在本进程里监听, 而 bun 子进程要回头连它 ---- 因此这里必须用
  // 异步 spawn. 用 spawnSync 会阻塞本进程的事件循环, mock server 永远
  // 无法 accept bun 的连接, 双方互等直到超时.
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      let valid = false
      try {
        JSON.parse(raw)
        valid = true
      } catch {
        valid = false
      }
      res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' })
      res.end(valid ? '{"ok":true}' : '{"message":"Invalid JSON in request body"}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const probe = `
const { buildBody, buildSystemMessages } = await import(${JSON.stringify(
    path.join(ROOT, 'cli-bridge/lib/endpoints/chat-payload.ts'),
  )})
const body = buildBody({
  row: { handle: 'fbm1.AAEAAUPuTEST' },
  metadata: { run_id: 'r1' },
  outMessages: buildSystemMessages([{ role: 'user', content: 'hi' }], 'worker', null),
  outTools: [], layer: 'worker', stream: true,
})
const res = await fetch('http://127.0.0.1:${port}/api/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body,
})
console.log(JSON.stringify({ typeofBody: typeof body, status: res.status }))
`
  const probePath = path.join(ROOT, 'test', '.tmp-chat-payload-probe.mjs')
  fs.writeFileSync(probePath, probe)
  const run = await runBun(probePath)
  fs.rmSync(probePath, { force: true })
  server.close()

  const lines = (run.stdout || '').trim().split('\n')
  const line = lines[lines.length - 1] || ''
  let out = null
  try {
    out = JSON.parse(line)
  } catch {
    out = null
  }
  ok(
    out !== null,
    `bun 探针输出必须是 JSON(got: ${line.slice(0, 200)} / stderr: ${(run.stderr || '').slice(0, 200)})`,
  )
  ok(out.typeofBody === 'string', `端到端: buildBody 必须返回字符串(got ${out.typeofBody})`)
  ok(out.status === 200, `端到端: 上游必须收到合法 JSON 体(got HTTP ${out.status})`)
}

console.log(`chat 出站请求体契约验证通过(断言 ${n} 条)`)
