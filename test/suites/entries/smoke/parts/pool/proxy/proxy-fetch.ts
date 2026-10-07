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
      `单代理池应走代理 (代理收到请求), 实际响应: ${text}`, // 直连会给 DIRECT
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
      `上游调用单代理池也应走代理, 实际响应: ${t2}`, // 直连会是 DIRECT
    )
  } finally {
    proxyServer.close()
    targetServer.close()
  }
}

// --- 回归: 官方 chat 那一跳(经 RPC cfg 下传)也必须带出口 ---
// 漏掉时的表现最难发现: session/catalog 走代理而 chat 直连宿主 IP,
// 同一进程里两个出口, 上游看到的出口是后者(issue #5 的形态).
{
  const { loadConfig } = await import('../../../../../../../src/config.ts')
  const { createUpstreamClient } = await import('../../../../../../../src/upstream/client.ts')
  const { buildRpcCfg } = await import('../../../../../../../src/upstream/rpc/official-rpc.ts')

  // A. 配了全局池 -> chat 的 cfg 必须带该出口
  const withPool = loadConfig()
  withPool.upstream.proxies = ['http://127.0.0.1:19999']
  withPool.upstream.proxy = null
  const cliA = createUpstreamClient(withPool, 'tok', { accountId: 'a@example.com' })
  const cfgA = await buildRpcCfg(cliA, withPool)
  assert.equal(
    cfgA?.proxy,
    'http://127.0.0.1:19999',
    '官方 chat 支路的 cfg 必须带代理池出口 (否则 chat 在 bun 里直连宿主 IP)',
  )

  // B. 单代理配置同样要带
  const withSingle = loadConfig()
  withSingle.upstream.proxies = []
  withSingle.upstream.proxy = 'http://127.0.0.1:18888'
  const cliB = createUpstreamClient(withSingle, 'tok', { accountId: 'b@example.com' })
  const cfgB = await buildRpcCfg(cliB, withSingle)
  assert.equal(cfgB?.proxy, 'http://127.0.0.1:18888', 'upstream.proxy 也必须下传到 chat 的 cfg')

  // C. 都没配 -> null (让 bun 自己读 env, 保留 NO_PROXY 语义; 不是显式直连)
  const none = loadConfig()
  none.upstream.proxies = []
  none.upstream.proxy = null
  const cliC = createUpstreamClient(none, 'tok', { accountId: 'c@example.com' })
  const cfgC = await buildRpcCfg(cliC, none)
  assert.equal(cfgC?.proxy, null, '未配代理时应为 null (交给 bun 按 env 判定)')
}
