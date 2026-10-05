/**
 * smoke 的公共辅助
 *
 * 轮询等待 / 释放挂起流 / 造 JSON 回执 / 取上游 token / 读控制台源码. 被几十个用例块共用, 与某个具体用例无关.
 *
 * 口径: 函数体逐字保留, 只补 export.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { state } from '../../../smoke/state.ts'
import { configureLogger } from '../../../../../src/util/log.ts'

configureLogger({ level: 'error' })



/** 放行所有被挂起的流式响应(写入 [DONE] 并关闭). */
export function releaseHoldStreams() {
  const enc = new TextEncoder()
  for (const controller of state.holdStreamControllers.splice(0)) {
    try {
      controller.enqueue(enc.encode('data: [DONE]\n\n'))
      controller.close()
    } catch {
      // ignore
    }
  }
}



/**
 * @param {string} desc 等待条件的描述(超时报错文案用)
 * @param {() => boolean} fn 判定函数
 * @param {number} [timeoutMs] 超时毫秒, 默认 2000
 * @param {number} [stepMs] 轮询间隔毫秒, 默认 20
 * @returns {Promise<void>} 条件成立即返回, 超时抛错
 */
export async function waitFor(desc, fn, timeoutMs = 2_000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  assert.fail(`waitFor 超时: ${desc}`)
}



/**
 * @param {Record<string,string>} [headers] 上游请求头
 * @returns {string} 上游认证 token(缺失时为空串)
 */
export function compAuthOf(headers = {}) {
  return (
    headers.Authorization ||
    headers.authorization ||
    headers['x-codebuff-api-key'] ||
    ''
  )
}



/**
 * @param {unknown} obj 回执体
 * @param {number} [status] HTTP 状态码
 * @param {Record<string,string>} [extraHeaders] 附加响应头
 * @returns {Response} JSON 响应
 */
export function jsonRes(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}




/**
 * 读整棵 dashboard/ 的源码文本(所有 .js 拼接).
 *
 * 扫描面是整棵 dashboard/: 写死某一个路径的断言会在
 * "读到的文件里没有那段代码"时正则不匹配, 从而静默通过.
 *
 * 同时校验文件数下限: 目录读不到时不能退化成"零违规".
 * @returns {string} 全部 dashboard 下的 .js 内容
 */
export function readDashboardSource() {
  const dashDir = new URL('../../../../../dashboard/', import.meta.url)
  const files = []
  const walkDash = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
      if (e.isDirectory()) walkDash(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walkDash(dashDir)
  assert.ok(files.length >= 10, `控制台源码扫描下限：只扫到 ${files.length} 个 .ts`)
  return files.map((p) => fs.readFileSync(p, 'utf8')).join('\n')
}

/**
 * 读整棵 bin/ 的源码文本(入口按职责拆进 bin/serve/boot/ 之后, 钉死单文件会静默失效).
 *
 * 与 readDashboardSource 同源理由: 入口被拆成多个文件后, 只读 bin/serve.ts
 * 会读不到已搬走的代码, 正则不匹配 -> 断言平时假绿, 只在被破坏时才红.
 * 同时校验文件数下限: 目录读不到时不能退化成"零违规".
 * @returns {string} 全部 bin 下的 .ts 内容
 */
export function readBinSource() {
  const binDir = new URL('../../../../../bin/', import.meta.url)
  const files = []
  const walkBin = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const p = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
      if (e.isDirectory()) walkBin(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walkBin(binDir)
  assert.ok(files.length >= 5, `入口源码扫描下限：只扫到 ${files.length} 个 .ts`)
  return files.map((p) => fs.readFileSync(p, 'utf8')).join('\n')
}
