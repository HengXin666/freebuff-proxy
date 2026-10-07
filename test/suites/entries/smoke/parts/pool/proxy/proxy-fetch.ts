/**
 * pool: 单代理池也必须走代理
 *
 * issue #5 根因: 只有 1 个代理时直连绕过.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'
import http from 'node:http'

// --- 回归:单代理池也必须走代理(issue #5 根因:1 个代理时直连绕过) ---
{
  const { createEgress } = await import('../../../../../../../src/upstream/client.ts')
  // 最小 HTTP 代理:收到绝对形式请求直接回带标记的响应(不转发)
  let proxyHits = 0
  const proxyServer = http.createServer((req, res) => {
    proxyHits++
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('VIA_PROXY ' + req.url)
  })
  const targetServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('DIRECT ' + req.url)
  })
  await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r))
  await new Promise((r) => targetServer.listen(0, '127.0.0.1', r))
  const proxyPort = proxyServer.address().port
  const targetPort = targetServer.address().port
  try {
    const cfg = loadConfig()
    cfg.upstream.proxies = [`http://127.0.0.1:${proxyPort}`] // 单代理池
    // 出网一律经统一出口(createEgress),不再有单独的 createProxyFetch.
    const { fetch: proxyFetch } = createEgress({ config: cfg })
    const res = await proxyFetch(`http://127.0.0.1:${targetPort}/hello`, {
      headers: { 'x-test': '1' },
    })
    const text = await res.text()
    assert.ok(
      text.startsWith('VIA_PROXY'),
      `单代理池应走代理（代理收到请求），实际响应: ${text}`, // 直连会给 DIRECT
    )
    assert.equal(proxyHits, 1, '请求应恰好经过代理一次')
    // 上游 apiFetch 同样走单代理池(apiBase 指向 target,代理不转发 → 收到的是代理的响应)
    const upstreamCfg = loadConfig()
    upstreamCfg.upstream.apiBase = `http://127.0.0.1:${targetPort}`
    upstreamCfg.upstream.proxies = [`http://127.0.0.1:${proxyPort}`]
    const { createUpstreamClient } = await import('../../../../../../../src/upstream/client.ts')
    const cli = createUpstreamClient(upstreamCfg, 'tok', { accountId: 'a@example.com' })
    const r2 = await cli.raw('/api/v1/me', { method: 'GET' })
    const t2 = await r2.text()
    assert.ok(
      t2.startsWith('VIA_PROXY'),
      `上游调用单代理池也应走代理，实际响应: ${t2}`, // 直连会是 DIRECT
    )
  } finally {
    proxyServer.close()
    targetServer.close()
  }
}
