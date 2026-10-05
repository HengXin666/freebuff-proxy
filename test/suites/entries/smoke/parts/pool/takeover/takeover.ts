/**
 * pool: 槽位被占时接管复用
 *
 * 余额 0 不等于不可用: 上游清单里有同模型未过期的已付费会话就接管.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 官方建会话路径:GET /freebuff/session + cli: claim(不是 POST /admission).
// 真机抓包:官方 CLI 0.2.6 全程 18 次 GET + 1 次 DELETE /attempt,
// 从不打 /admission.契约见
// .agents/notes/implemented/bug-fix/2026-10-01-cli-get-session-path.md
{
  const gsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-getclaim-'))
  saveAccountUser(gsDir, { id: 'a', email: 'a@example.com', authToken: 'token-a' })
  const gsConfig = loadConfig()
  gsConfig.server.host = '127.0.0.1'
  gsConfig.server.port = 0
  gsConfig.server.apiKeys = ['sk-test']
  gsConfig.upstream.credentialsDir = gsDir
  gsConfig.session.pollIntervalSec = 3600
  const gsRuntimes = new AccountRuntimes(gsConfig)
  const gsServer = await startServer({
    config: gsConfig,
    runtimes: gsRuntimes,
    ...(() => {
      const rt = gsRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const gsPort = gsServer.address().port
  state.mockMode = 'get_claim_admit'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  const res = await fetch(`http://127.0.0.1:${gsPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  const sessCalls = state.calls.filter((c) => c.url.includes('/freebuff/session'))
  // 找带 claim 的那个 GET ---- 启动探测时的 GET 还不带 claim,不能拿来断言
  const getAdmit = sessCalls.find(
    (c) =>
      c.method === 'GET' &&
      !c.url.includes('/admission') &&
      (c.headers['x-freebuff-multi-session'] ||
        c.headers['X-Freebuff-Multi-Session']),
  )
  assert.ok(
    getAdmit,
    '必须走官方 GET /freebuff/session 建会话' +
      '（注：官方 CLI 从不打 /admission；但 desktop 走 POST /admission，' +
      '两者都是官方形态，只是路线不同）: ' +
      JSON.stringify(sessCalls.map((c) => c.method + ' ' + c.url.split('/api')[1])),
  )
  // undici 会把头名规范化成首字母大写,断言两种写法都认
  const instHdr =
    getAdmit.headers['x-freebuff-instance-id'] ||
    getAdmit.headers['X-Freebuff-Instance-Id'] ||
    ''
  // desktop 路线:裸 UUID(CLI 路线才是 cli: 前缀).见 P0-2.
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instHdr),
    'GET 建会话的 instanceId 必须是裸 UUID（desktop 形态）, got ' +
      JSON.stringify(instHdr),
  )
  assert.equal(
    getAdmit.headers['x-freebuff-multi-session'],
    '1',
    'cli claim 必须带 multi-session 头',
  )
  assert.equal(
    getAdmit.headers['x-freebuff-model'],
    undefined,
    'GET 建会话不带 x-freebuff-model（模型由服务端回执给出）',
  )
  assert.equal(
    state.sessionPosts,
    0,
    'GET 路径成功时不得再打 POST admission; sessionPosts=' + state.sessionPosts,
  )
  // 会话模型绑定:chat 的 model 必须用会话回执里服务端指派的值
  // (mock 给的是 m-00032eaeec),而不是客户端请求的模型名 ----
  // 用错会得到 session_model_mismatch.见
  // .agents/notes/implemented/bug-fix/2026-10-01-session-model-binding.md
  const chatCall = state.calls.find((c) => c.url.includes('/chat/completions'))
  assert.ok(chatCall, '应发出 chat 请求')
  const sentModel = JSON.parse(chatCall.body).model
  assert.equal(
    sentModel,
    'm-00032eaeec',
    'chat 必须用服务端指派的 model（会话回执里的 m-xxx），got ' + sentModel,
  )
  assert.notEqual(
    sentModel,
    'deepseek/deepseek-v4-flash',
    '不能把客户端请求的模型名直接转给上游（会 session_model_mismatch）',
  )
  await gsRuntimes.shutdown()
  gsServer.close()
  fs.rmSync(gsDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}

/* ================================================================
   余额 0 + 上游存在同模型的已付费会话 → 必须 takeover 复用,不得被额度闸门挡住
   ================================================================ */
{
  /**
   * - 用户明确要求的能力(2026-10-04 铁律):余额为 0 不等于账号不可用.
   * - [一次 admit = 买断一小时],这一小时内继续发请求边际成本为 0;
   * - balance: 0 只说明"再买一条买不起",不代表已付过钱的那一小时不能用.
   *
   * - 真实故障:面板显示 DeepSeek V4.1 Flash . 49 分钟 的已付费会话
   * - (上游 desktopPurchases 里 deepseek/deepseek-v4-flash 带
   * - holderInstanceId,别的部署建的),而调度因余额闸门跳过该账号 →
   * 用户看到[有会话却一直 429],那一小时的钱白扔.
   *
   * - 本用例走完整下游链路(POST /v1/chat/completions → 选号 → 闸门 →
   * 只读探测 → takeover → chat),并让 mock 遵守上游真实槽位语义:
   * - 不带占用者 id 的 POST admission 一律回 purchase_capacity ----
   * 所以"最后 200"无法由"照常新开一条会话"伪造出来(那次 POST 会被拒).
   *
   * - 两处刻意用上游 id 形式(deepseek/deepseek-v4-flash),而不是
   * - 目录 key:清单侧与请求侧都走 keyForName/legacy 摘要归一,映射不生效时
   * 本用例直接变红.
   *
   * - 反向探针(已实测):把 src/app-context.ts 里 quotaLooksBlocked &&
   * - (await checkPaidUpstream()) 短路掉 → 本用例红在
   * - res.status === 429(freebucks_exhausted);把 holderFor 的
   * - resolveModelAlias 归一退回严格相等 → 同样红(两侧标识不同).
   */
  const UPTAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-paid-ups-'))
  saveAccountUser(UPTAKE_DIR, {
    id: 'paid',
    email: 'paid@example.com',
    authToken: 'token-paid',
  })
  const upConfig = loadConfig()
  upConfig.server.host = '127.0.0.1'
  upConfig.server.port = 0
  upConfig.server.apiKeys = ['sk-test']
  upConfig.upstream.credentialsDir = UPTAKE_DIR
  upConfig.session.pollIntervalSec = 3600
  const upRuntimes = new AccountRuntimes(upConfig)
  const upServer = await startServer({
    config: upConfig,
    runtimes: upRuntimes,
    ...(() => {
      const rt = upRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const upPort = upServer.address().port

  const HOLDER = 'other-deploy-inst'
  /** 请求侧与清单侧都用上游 legacy id(不是目录 key m-xxx). */
  const MODEL_ID = 'deepseek/deepseek-v4-flash'
  state.mockPaidTakeover = {
    holderInstanceId: HOLDER,
    model: MODEL_ID,
    listed: true,
    freebucks: { balance: 0, daily: { limit: 25, remaining: 0 }, prices: { [MODEL_ID]: 15 } },
  }
  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.calls = []
  /**
   * - 必须先对一次账(等价于控制台点过[刷新],或本进程此前建过会话).
   *
   * - 否则本账号在调度眼里是"余额未知"(freebucksFor().known === false),
   * 额度闸门恒放行 ---- 用例就变成"无闸门时能不能建会话",测不到本用例的主旨,
   * - 而且不可证伪(短路掉 paidUpstream 逻辑后仍然全绿,实测踩到过).
   *
   * - 对账后:balance 0 / 每日池 0/25 已知 → 闸门即将拒绝 →
   * 只有"清单里那条能接管的已付费会话"能救它.
   */
  await upRuntimes.get('paid').sessions.refresh()
  assert.equal(
    upRuntimes.get('paid').sessions.freebucksFor(MODEL_ID).affordable,
    false,
    '对照前提：对账后必须已知"买不起"（否则本用例测不到额度闸门）',
  )

  const upRes = await fetch(`http://127.0.0.1:${upPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  const upText = await upRes.clone().text()

  // ① 成功(不是 429,尤其不是 freebucks_exhausted)
  assert.equal(upRes.status, 200, upText)
  assert.ok(
    !upText.includes('freebucks_exhausted'),
    '余额 0 但存在已付费会话时，不得被 Freebucks 闸门挡住：' + upText.slice(0, 300),
  )
  // ② 确实发了带[别的部署占用者]的 takeover
  const admissionPosts = state.calls.filter(
    (c) => c.url.includes('/session/admission') && c.method === 'POST',
  )
  const tookOver = admissionPosts.find(
    (c) =>
      (c.headers['x-freebuff-takeover-instance-id'] ||
        c.headers['X-Freebuff-Takeover-Instance-Id']) === HOLDER,
  )
  assert.ok(
    tookOver,
    `必须带 x-freebuff-takeover-instance-id=${HOLDER} 接管别的部署的会话；` +
      `实际 admission POST 的 takeover 头：` +
      JSON.stringify(
        admissionPosts.map(
          (c) =>
            c.headers['x-freebuff-takeover-instance-id'] ||
            c.headers['X-Freebuff-Takeover-Instance-Id'] ||
            null,
        ),
      ),
  )
  // ③ 反向对照:mock 对不带 takeover 的 POST 一律回 purchase_capacity ----
  //    若实现只是"照常新开一条",这里必然出现一次不带 takeover 的 admission.
  const noTakeover = admissionPosts.filter(
    (c) =>
      !(
        c.headers['x-freebuff-takeover-instance-id'] ||
        c.headers['X-Freebuff-Takeover-Instance-Id']
      ),
  )
  assert.equal(
    noTakeover.length,
    0,
    '不得先撞一次"槽位被占"再补 takeover（官方 knownHolder 是发请求前就知道）',
  )
  // ④ 真的把 chat 发上了上游(链路闭环,不是空转拿到 200)
  assert.ok(state.completionAttempts >= 1, '必须真的发出 chat 请求')
  // ⑤ 映射生效的旁证:会话回执给的是上游 id 形式,chat 必须回用它
  const chatCall = state.calls.find((c) => c.url.includes('/chat/completions'))
  assert.ok(chatCall, '应发出 chat 请求')
  assert.ok(
    JSON.parse(chatCall.body).model === MODEL_ID,
    'chat 必须回用会话回执里服务端指派的模型标识',
  )

  await upRuntimes.shutdown()
  upServer.close()
  fs.rmSync(UPTAKE_DIR, { recursive: true, force: true })
  state.mockPaidTakeover = null
  state.mockMode = 'ok'
}
