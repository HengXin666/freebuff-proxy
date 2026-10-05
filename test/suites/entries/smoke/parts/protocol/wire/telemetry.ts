/**
 * protocol: CLI 遥测上报
 *
 * 格式必须与抓包样本逐字段一致, 格式错了就是自证伪造.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

// 官方 CLI 遥测上报:格式必须与抓包样本逐字段一致(records 数组 + level/event/
// message/client_session_id/data).格式错了就是自证伪造,所以逐项锁死.
// 判据见 .agents/notes/proposed/architecture/2026-09-30-cli-telemetry-reports.md
{
  const {
    TELEMETRY_ENDPOINT,
    CLI_EVENTS,
    telemetrySessionId,
    resetTelemetrySession,
    trackCliEvent,
    flushTelemetry,
    reportCliLaunch,
  } = await import('../../../../../../../src/upstream/telemetry/cli-telemetry.ts')

  assert.equal(TELEMETRY_ENDPOINT, 'https://www.codebuff.com/api/logs')
  assert.equal(CLI_EVENTS.APP_LAUNCHED, 'cli.app_launched')
  assert.equal(CLI_EVENTS.FINGERPRINT_GENERATED, 'cli.fingerprint_generated')
  assert.equal(CLI_EVENTS.LOGIN_STARTED, 'cli.login_started')

  resetTelemetrySession()
  const sid = telemetrySessionId()
  assert.ok(/^anon_[0-9a-f-]{36}$/.test(sid), 'client_session_id 必须是 anon_<uuid>:' + sid)
  assert.equal(telemetrySessionId(), sid, '同一进程内必须复用同一个 session id')

  // 抓一个 mock fetch 看实际发出的报文
  const sent = []
  const mockFetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return new Response('{}', { status: 200 })
  }

  await reportCliLaunch({ fingerprintSuccess: true, fetchImpl: mockFetch })
  assert.equal(sent.length, 1, 'launch 应发一批')
  assert.equal(sent[0].url, TELEMETRY_ENDPOINT)
  const recs = sent[0].body.records
  assert.ok(Array.isArray(recs), 'body.records 必须是数组')
  assert.equal(recs.length, 2, 'launch 是 app_launched + fingerprint_generated 两条')
  assert.equal(recs[0].event, 'cli.app_launched')
  assert.equal(recs[1].event, 'cli.fingerprint_generated')
  // 逐字段对齐抓包样本
  for (const r of recs) {
    assert.equal(r.level, 'info')
    assert.equal(r.message, r.event, 'message 与 event 同名（官方样本如此）')
    assert.equal(r.client_session_id, sid, '所有事件共用同一个 client_session_id')
    assert.ok(r.data && typeof r.data === 'object')
  }
  assert.deepEqual(recs[1].data, {
    fingerprintType: 'enhanced_cli',
    success: true,
  }, 'fingerprint_generated 的 data 必须与抓包一致')

  // 上报失败必须静默,绝不影响可用性
  trackCliEvent(CLI_EVENTS.LOGIN_STARTED, { via: 'plain_command' })
  const n = await flushTelemetry(async () => { throw new Error('boom') })
  assert.equal(n, 0, '上报失败返回 0 且不抛')

  // 无待发记录时不发
  const before = sent.length
  const n2 = await flushTelemetry(mockFetch)
  assert.equal(n2, 0)
  assert.equal(sent.length, before)
}

// TLS 层对齐官方 CLI:ALPN 只 offer http/1.1.
// 真机抓包官方 Bun CLI:TLSv1.3 / alpn=http/1.1 / cipher=TLS_AES_256_GCM_SHA384.
// undici 默认会同时 offer h2,与官方不同 ---- 是可检测的 TLS 层差异.
// 注:Node 与 Bun 同为系统 OpenSSL 栈,cipher 本就一致;"Node 无法对齐"只成立于
// 浏览器目标(GREASE 是保留数值,OpenSSL 名字字符串表达不了).
{
  // ALPN 的实现已随 client.js 拆分搬进 client/transport.js(client.js 只剩
  // 薄门面 re-export).断言必须指向真正构造 dispatcher 的那一层.
  const src = fs.readFileSync(
    new URL('../../../../../../../src/upstream/client/transport.ts', import.meta.url),
    'utf8',
  )
  assert.ok(
    src.includes('ALPNProtocols'),
    '必须显式设置 ALPNProtocols（否则 undici 默认会 offer h2，与官方 CLI 不同）',
  )
  assert.ok(
    /ALPNProtocols:\s*\[\s*['"]http\/1\.1['"]\s*\]/.test(src),
    'ALPN 必须只 offer http/1.1（对齐官方 Bun CLI 抓包值）',
  )
}
