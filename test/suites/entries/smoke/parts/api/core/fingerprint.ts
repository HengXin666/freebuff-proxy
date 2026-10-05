/**
 * api: 请求指纹稳定性
 *
 * 同一请求头的指纹必须稳定, 否则上游会当成新客户端.
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

// 指纹对齐:chat 请求必须与官方 CLI 的形态一致.
// 依据(全部静态提取自官方 freebuff@0.0.178 二进制,见
// src/upstream/official-fingerprint.ts):
//   chat UA = ai-sdk/openai-compatible/<真版本>/codebuff(旧实现硬编码 1.0.0);
//   POST 准入走 .../session/admission,不是 .../session.
// 用独立全新账号目录起服务:热 session 复用不会发 POST,断言不到准入形状.
{
  const fpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-fp-'))
  saveAccountUser(fpDir, { id: 'fp', email: 'fp@example.com', authToken: 'token-fp' })
  const fpConfig = loadConfig()
  fpConfig.server.host = '127.0.0.1'
  fpConfig.server.port = 0
  fpConfig.server.apiKeys = ['sk-test']
  fpConfig.upstream.credentialsDir = fpDir
  fpConfig.session.pollIntervalSec = 3600
  const fpRuntimes = new AccountRuntimes(fpConfig)
  const fpServer = await startServer({
    config: fpConfig,
    runtimes: fpRuntimes,
    ...(() => {
      const rt = fpRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const fpPort = fpServer.address().port
  state.calls = []
  state.sessionPosts = 0
  state.completionAttempts = 0
  state.mockMode = 'ok'
  const res = await fetch('http://127.0.0.1:' + fpPort + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  const chatCall = state.calls.find((c) => c.url.includes('/chat/completions'))
  assert.ok(chatCall, '应发出 chat 请求')
  const ua = chatCall.headers['user-agent'] || chatCall.headers['User-Agent']
  assert.ok(ua, 'chat 必须带 user-agent')
  // chat UA 是两段式,逐字对齐真机抓包.
  // 版本段是 0.0.0-test 而不是包版本号 ---- 官方发布构建里 __PACKAGE_VERSION__
  // 未注入,回退到该字面量(二进制原文:
  //   Qo=typeof __PACKAGE_VERSION__<"u"?__PACKAGE_VERSION__:"0.0.0-test"
  // ).第二段我们此前整段漏了.见
  // .agents/notes/implemented/bug-fix/2026-10-01-chat-ua-two-part.md
  //
  //  第三段随客户端路线而异,两条都是真机实测值:
  //   CLI     0.2.6 → runtime/browser
  //   desktop 0.0.156 → runtime/bun/1.4.2(orchestrator 是 bun 跑的)
  // 本仓库走 desktop 路线,故断言取 bun 形态.
  // 见 docs/reverse/14-captured-diff.md
  assert.equal(
    ua,
    'ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2',
    'chat UA 必须与官方逐字一致, got ' + ua,
  )
  assert.ok(!ua.includes('/1.0.0/'), 'UA 不得再是硬编码的 1.0.0（与真 CLI 版本不符）')
  /**
   * - x-codebuff-api-key 已删除,断言不再带.
   *
   * 旧注释说"删它有打死全部认证的风险(只带 Bearer 会 401)"---- 那是
   * - 未做单变量对照的结论:当时同时换了 token 来源与出口,401 的真实
   * 原因从未被证实是这个头.客户端 165 条抓包里它出现 0 次
   * (docs/reverse/20 §20.4),故按官方形态只发 Bearer.
   */
  assert.ok(
    !chatCall.headers['x-codebuff-api-key'],
    'chat 不得再带 x-codebuff-api-key（客户端 0 次）',
  )
  assert.ok(
    String(chatCall.headers.Authorization || chatCall.headers.authorization || '').startsWith('Bearer '),
    'chat 必须带 Bearer Authorization',
  )
  const admitCall = state.calls.find((c) => c.url.includes('/api/v1/freebuff/session') && c.method === 'POST')
  assert.ok(admitCall, '应发出准入请求')
  assert.ok(
    admitCall.url.endsWith('/api/v1/freebuff/session/admission'),
    'POST 准入端点应为 .../session/admission, got ' + admitCall.url,
  )
  assert.equal(admitCall.headers['x-freebuff-model'], 'deepseek/deepseek-v4-flash')
  assert.equal(admitCall.headers['x-freebuff-wallet-spend-limit'], '0')
  assert.equal(admitCall.headers['x-freebuff-first-tab-discount'], '0')
  assert.ok(admitCall.headers['x-fb-timezone'], '准入请求应带本机时区')
  /**
   * - x-freebuff-env 头不再发送:desktop 客户端 165 条抓包 0 次
   * - (docs/reverse/20 §20.2 / 21 §21.3).它来自官方 CLI 源码,
   * 我们走 desktop 路线,带它等于自报 CLI 身份.
   *
   * - 但同一份描述符仍要放进 chat 的 codebuff_metadata
   * (客户端在那里确实放)---- 下面从 metadata 取,不再从头上取.
   */
  assert.ok(
    !admitCall.headers['x-freebuff-env'],
    '准入请求不得再带 x-freebuff-env 头（desktop 客户端 0 次）',
  )
  const envDesc = JSON.parse(chatCall.body).codebuff_metadata?.freebuff_client_env
  assert.ok(envDesc, 'chat 的 codebuff_metadata 仍要带 freebuff_client_env')
  assert.match(
    envDesc,
    /^v1;(in|out|tp|term|ct|sz|ci|ssh|l|p|g|osc)=/,
    '描述符必须是 v1;key=value 形状, got ' + envDesc,
  )
  const envKeys = envDesc.split(';').slice(1).map((p) => p.split('=')[0])
  assert.deepEqual(
    envKeys,
    [
      'in', 'out', 'tp', 'term', 'ct', 'sz', 'ci', 'ssh', 'l', 'p', 'g', 'osc',
      // 后 4 个字段:真机抓包 2026-10-01 确认官方已扩展
      // (cli/src/utils/client-environment.ts:377-380)
      'tzo', 'px', 'tls', 'ca',
    ],
    '描述符字段与顺序必须与官方一致, got ' + JSON.stringify(envKeys),
  )
  //  instanceId 形态随路线而异,两条都是真机实测值:
  //   CLI     抓包 → cli:<uuid>(官方 newFreebuffCliInstanceId,
  //                   服务端据此认出 CLI 而非 Desktop 标签)
  //   desktop 抓包 → 裸 UUID 且整场复用
  //                  (line 8/34/54 三次 admission 同为 e1be7199-...,
  //                   line 38 的 metadata 也是它)
  //
  // 本仓库走 desktop 路线,故用裸 UUID.且必须复用同一个值:
  // 每次 admission 新建会让每次购买被全额退款作废
  // (官方回执里 desktopRefunds 从未出现,而我们此前每次都退).
  // 见 docs/reverse/15-protocol-review.md P0-2 与 E.1.
  const admitInstance = admitCall.headers['x-freebuff-instance-id']
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admitInstance || ''),
    'admission 的 instanceId 必须是裸 UUID（desktop 形态）, got ' + admitInstance,
  )
  assert.ok(
    !String(admitInstance || '').startsWith('cli:'),
    'desktop 路线不得带 cli: 前缀（那是 CLI 形态）, got ' + admitInstance,
  )
  assert.equal(admitCall.headers['x-freebuff-multi-session'], '1', 'cli claim 必须带 multi-session 头')
  assert.equal(admitCall.headers['x-freebuff-purchase-continuity'], '1', 'cli claim 必须带 purchase-continuity 头')
  // chat 的 codebuff_metadata 里也要有同一份描述符(官方两处都放)
  const chatMetaRaw = chatCall.body && JSON.parse(chatCall.body).codebuff_metadata
  assert.equal(
    chatMetaRaw?.freebuff_client_env,
    envDesc,
    'chat 的 codebuff_metadata.freebuff_client_env 必须与 x-freebuff-env 同一份',
  )
  await fpRuntimes.shutdown()
  fpServer.close()
  fs.rmSync(fpDir, { recursive: true, force: true })
  state.mockMode = 'ok'
}
