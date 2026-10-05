/**
 * 进程与网络小工具 -- 从 scripts/ci/pipeline-image-test.ts 按职责切出.
 *
 * 口径: 纯搬移, 不改行为. 原有的坑注释原样保留(它们记着为什么必须这么写).
 */
import os from 'node:os'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** 跑一个子进程, 返回 spawnSync 结果(统一编码与 buffer 上限). */
export const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })

/** 原样打印. */
export const log = (...parts) => console.log(...parts)
/** 灰色(次要信息). */
export const dim = (s) => `\x1b[2m${s}\x1b[0m`
/** 绿色(通过). */
export const green = (s) => `\x1b[32m${s}\x1b[0m`
/** 红色(失败). */
export const red = (s) => `\x1b[31m${s}\x1b[0m`
/** 黄色(告警). */
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`

/** 找一个空闲端口(避免与宿主机上正在跑的服务撞车). */
/**
 - 找一个空闲端口(避免与宿主机上正在跑的服务撞车).
 - @returns {Promise<number>} 空闲端口号
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * GET 一个小接口, 返回 {status, body}; 连接失败返回 status 0.
 * @param {string} url 目标地址
 * @param {number} [timeoutMs] 超时毫秒
 * @returns {Promise<{status: number, body: string}>} 响应
 */
export function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }) })
    req.on('error', () => resolve({ status: 0, body: '' }))
  })
}

/** 睡一会儿. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 建一个临时目录(前缀固定, 便于泄漏时人工清理). */
export const makeTempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
