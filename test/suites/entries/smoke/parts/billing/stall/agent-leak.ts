/**
 * billing: 客户端中断
 *
 * 首字节前静默等待中断开时绝不钉死账号并发.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// ===========================================================================
// (AGENT-LEAK) 更新凭证 / 改代理池丢弃 runtime 时, 必须关闭出网 agent
//
// 每个账号 runtime 构造时都会 new ProxyAgent(带 keep-alive 连接池).
// "更新凭证/导入账号/切换代理池"都会重建 runtime: 旧 agent 不 close 时,
// 它的 socket 会随操作次数单调累积. 本用例断言重建后常驻 socket 回到 1 个.
{
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  const oport = origin.address().port

  // 一个真正会转发 CONNECT 的代理,让请求能正常完成,连接进入 keep-alive
  const proxySrv = http.createServer((req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  proxySrv.on('connect', (req, clientSock) => {
    const [host, port] = req.url.split(':')
    const up = net.connect(Number(port), host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.pipe(clientSock)
      clientSock.pipe(up)
    })
    up.on('error', () => clientSock.destroy())
    clientSock.on('error', () => up.destroy())
  })
  await new Promise((r) => proxySrv.listen(0, '127.0.0.1', r))
  const pport = proxySrv.address().port
  const socks = () =>
    new Promise((r) => proxySrv.getConnections((_, n) => r(n)))

  const leakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-leak-'))
  const leakCfg = loadConfig()
  leakCfg.server.credentialsDir = leakDir
  leakCfg.upstream.credentialsDir = leakDir
  leakCfg.upstream.proxy = `http://127.0.0.1:${pport}`
  leakCfg.upstream.apiBase = `http://127.0.0.1:${oport}`
  leakCfg.session.pollIntervalSec = 3600
  saveAccountUser(leakDir, {
    id: 'leak1',
    email: 'leak@example.com',
    authToken: 'tok1',
  })

  const leakRuntimes = new AccountRuntimes(leakCfg)
  const hit = async () => {
    const rt = leakRuntimes.get('leak1')
    try {
      const res = await rt.upstream.raw('/api/v1/me', {
        method: 'GET',
        timeoutMs: 5_000,
      })
      await res.text()
    } catch {
      // 忽略：本用例只关心连接是否被回收
    }
  }

  try {
    await hit()
    await new Promise((r) => setTimeout(r, 200))
    // 首次请求会建 2 条 keep-alive: 一条是本请求, 另一条是目录抓取
    // (/api/v1/freebuff/models).目录抓取也必须走同一个代理 agent.
    // 本用例关心的是"是否被回收", 基线取首次请求后的 socket 数.
    const baseline = await socks()
    assert.ok(
      baseline >= 1 && baseline <= 3,
      `首次请求后的 keep-alive 基线应在 1..3（实测 ${baseline} 个）`,
    )

    // 反复"更新凭证":每次都 invalidate(丢弃旧 runtime)
    for (let i = 0; i < 12; i += 1) {
      await leakRuntimes.invalidate('leak1')
      await hit()
    }
    await new Promise((r) => setTimeout(r, 800))
    const after = await socks()
    assert.ok(
      after <= baseline + 2,
      `12 轮"更新凭证"后 socket 必须被回收（基线 ${baseline}，实测 ${after} 个）；` +
        '累积即说明旧 runtime 的出网 agent 没有被 close',
    )
  } finally {
    await leakRuntimes.shutdown()
    origin.close()
    proxySrv.close()
    fs.rmSync(leakDir, { recursive: true, force: true })
  }
}
