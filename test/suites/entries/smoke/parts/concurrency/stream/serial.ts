/**
 * concurrency: 账号并发上限
 *
 * 单账号可同时转发 N 条 SSE 流, 满了换号; 上限=1 时即换号.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { AccountRuntimes } from '../../../../../../../src/app-context.ts'
import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import { startServer } from '../../../../../../../src/server.ts'
import { state } from '../../../../../smoke/state.ts'
import { jsonRes } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- 账号并发上限=1(慢流场景):单账号同时 1 条流,满员即换号 ---
{
  const scDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-serial-'))
  saveAccountUser(scDir, { id: 'sca', email: 'sca@example.com', authToken: 'token-sca' })
  saveAccountUser(scDir, { id: 'scb', email: 'scb@example.com', authToken: 'token-scb' })
  const scConfig = loadConfig()
  scConfig.server.host = '127.0.0.1'
  scConfig.server.port = 0
  scConfig.server.apiKeys = ['sk-test']
  scConfig.upstream.credentialsDir = scDir
  scConfig.session.pollIntervalSec = 3600
  scConfig.limits.maxConcurrentRequests = 12

  const scRuntimes = new AccountRuntimes(scConfig, {
    getAccountConcurrency: () => 1,
  })
  const scServer = await startServer({
    config: scConfig,
    runtimes: scRuntimes,
    ...(() => {
      const rt = scRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const scPort = scServer.address().port

  // 慢流 mock:每次 chunk 延迟 ~100ms,总时长 ~800ms;记录并发峰值
  let streamActive = 0
  let streamActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        streamActive++
        if (streamActive > streamActiveMax) streamActiveMax = streamActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            const chunks = [
              'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"h"}}]}\n\n',
              'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"delta":{"content":"i"}}]}\n\n',
              'data: {"id":"c3","object":"chat.completion.chunk","choices":[{"delta":{"content":"!"}}]}\n\n',
              'data: [DONE]\n\n',
            ]
            async function emit(i) {
              if (i >= chunks.length || closed) {
                streamActive = Math.max(0, streamActive - 1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(chunks[i]))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            streamActive = Math.max(0, streamActive - 1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      // 非 stream 模式立刻完成
      return jsonRes({
        id: 'c1', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      })
    }
    return origFetch(url, init)
  }

  state.mockMode = 'ok'
  streamActive = 0
  streamActiveMax = 0
  state.sessionPosts = 0
  state.completionAttempts = 0

  // 6 个并发 stream 请求
  const scReq = Array.from({ length: 6 }, () =>
    fetch(`http://127.0.0.1:${scPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const scResponses = await Promise.all(scReq)
  const scAccounts = []
  for (const r of scResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    const accountHeader = r.headers.get('x-freebuff-proxy-account')
    scAccounts.push(accountHeader)
  }
  // 粘性优先:单账号并发上限 1 → 6 条流全部排在 sca 上(不启用第二个账号)
  assert.equal(new Set(scAccounts).size, 1, `expected one sticky account, got ${JSON.stringify(scAccounts)}`)
  assert.equal(state.sessionPosts, 1, `expected one admission, got ${state.sessionPosts}`)
  assert.equal(streamActiveMax, 1, `expected max 1 concurrent stream, got ${streamActiveMax}`)

  globalThis.fetch = origFetch
  await scRuntimes.shutdown()
  scServer.close()
  fs.rmSync(scDir, { recursive: true, force: true })
}

// --- 账号并发上限:一个账号可同时转发 N 条 SSE 流;满了换到下一个账号 ---
{
  const ccDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-cc-'))
  saveAccountUser(ccDir, { id: 'cca', email: 'cca@example.com', authToken: 'token-cca' })
  saveAccountUser(ccDir, { id: 'ccb', email: 'ccb@example.com', authToken: 'token-ccb' })
  const ccConfig = loadConfig()
  ccConfig.server.host = '127.0.0.1'
  ccConfig.server.port = 0
  ccConfig.server.apiKeys = ['sk-test']
  ccConfig.upstream.credentialsDir = ccDir
  ccConfig.session.pollIntervalSec = 3600
  ccConfig.limits.maxConcurrentRequests = 12
  // 模拟控制台把每账号并发上限调到 2
  const ccRuntimes = new AccountRuntimes(ccConfig, {
    getAccountConcurrency: () => 2,
  })
  const ccServer = await startServer({
    config: ccConfig,
    runtimes: ccRuntimes,
    ...(() => {
      const rt = ccRuntimes.getAny()
      return {
        authToken: rt.authToken,
        authSource: rt.source,
        authEmail: rt.email,
        upstream: rt.upstream,
        sessions: rt.sessions,
      }
    })(),
  })
  const ccPort = ccServer.address().port

  let streamActive = 0
  let streamActiveMax = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('127.0.0.1') || u.includes('localhost')) return origFetch(url, init)
    if (u.includes('/api/v1/chat/completions')) {
      const body = JSON.parse(init.body)
      if (body.stream) {
        let closed = false
        streamActive++
        if (streamActive > streamActiveMax) streamActiveMax = streamActive
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            const chunks = ['h', 'i', '!', '\n']
            async function emit(i) {
              if (i >= chunks.length || closed) {
                streamActive = Math.max(0, streamActive - 1)
                if (!closed) controller.close()
                return
              }
              controller.enqueue(enc.encode(`data: {"x":"${chunks[i]}"}\n\n`))
              await new Promise((r) => setTimeout(r, 100))
              emit(i + 1)
            }
            emit(0)
          },
          cancel() {
            closed = true
            streamActive = Math.max(0, streamActive - 1)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return jsonRes({
        id: 'c1', object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      })
    }
    return origFetch(url, init)
  }

  state.mockMode = 'ok'
  state.sessionPosts = 0
  state.completionAttempts = 0
  const ccReqs = Array.from({ length: 6 }, () =>
    fetch(`http://127.0.0.1:${ccPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v4-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }),
  )
  const ccResponses = await Promise.all(ccReqs)
  const ccAccounts = []
  for (const r of ccResponses) {
    assert.equal(r.status, 200, await r.clone().text())
    ccAccounts.push(r.headers.get('x-freebuff-proxy-account'))
  }
  // 粘性优先:每账号并发上限 2 → 6 条流全部挤在 cca 上(2 条并行,其余排队),
  // 不主动启用第二个账号(只有排队超时才溢出)
  assert.equal(new Set(ccAccounts).size, 1, `expected one sticky account, got ${JSON.stringify(ccAccounts)}`)
  assert.equal(state.sessionPosts, 1, `expected one admission, got ${state.sessionPosts}`)
  assert.equal(streamActiveMax, 2, `expected max 2 concurrent streams, got ${streamActiveMax}`)
  // 监控字段:账号行带 在途/上限
  const ccRow = ccRuntimes.list().find((x) => x.email === 'cca@example.com')
  assert.equal(ccRow.concurrency, 2)
  assert.ok(Number.isInteger(ccRow.inFlight) && ccRow.inFlight <= 2)

  globalThis.fetch = origFetch
  await ccRuntimes.shutdown()
  ccServer.close()
  fs.rmSync(ccDir, { recursive: true, force: true })
}
