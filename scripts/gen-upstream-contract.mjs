#!/usr/bin/env node
/**
 * 从客户端抓包（mitm JSONL）生成**上游契约快照**。
 *
 * 为什么要有它：上游一旦改 API（改头名、加端点、改顺序），我们必须能
 * **机器发现**，而不是靠人读文档再对代码。这份 JSON 是唯一真源，
 * 由 `check-upstream-contract.mjs` 拿它跟代码里的常量对账。
 *
 * 用法：
 *   node scripts/gen-upstream-contract.mjs               # 重建快照
 *   node scripts/gen-upstream-contract.mjs --print       # 只打印不写盘
 *
 * 输入：docs/reverse/captures 下所有 jsonl（客户端真实流量）
 * 输出：docs/reverse/upstream-contract.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CAP_ROOT = join(ROOT, 'docs/reverse/captures')
const OUT = join(ROOT, 'docs/reverse/upstream-contract.json')

/** 抓包里一条记录的形态：{ ts, method, path, req_headers, req_body, status, ... } */

function collectJsonlFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...collectJsonlFiles(p))
    else if (e.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/**
 * 归一化头名：抓包里大小写混用（User-Agent / user-agent），
 * 对账时必须按小写比较。
 */
const norm = (h) => String(h).toLowerCase()

/**
 * 客户端 bun 裸 fetch 的固定四件套 —— 不算"业务头"，
 * 从契约里剔掉，避免上游加个传输层头就误报。
 */
const TRANSPORT_HEADERS = new Set([
  'host',
  'connection',
  'accept',
  'accept-encoding',
  'content-length',
  'content-type',
  'user-agent',
])

function main() {
  const files = collectJsonlFiles(CAP_ROOT).sort()
  if (!files.length) {
    console.error('未找到抓包文件:', CAP_ROOT)
    process.exit(1)
  }

  /** @type {Map<string, { method: string, count: number, headers: Map<string, Set<string>>, firstTs: number, lastTs: number }>} */
  const endpoints = new Map()
  /** 请求时序（用于顺序契约） */
  const sequence = []
  let total = 0

  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let r
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      // 只要**请求**（status 为 null 的那条是请求记录；带 status 的是响应回填）
      if (r.status !== null && r.status !== undefined) continue
      total++
      const method = String(r.method || '').toUpperCase()
      const path = String(r.path || '').split('?')[0]
      const key = `${method} ${path}`
      if (!endpoints.has(key)) {
        endpoints.set(key, {
          method,
          count: 0,
          headers: new Map(),
          firstTs: r.ts ?? 0,
          lastTs: r.ts ?? 0,
        })
      }
      const ep = endpoints.get(key)
      ep.count++
      ep.firstTs = Math.min(ep.firstTs, r.ts ?? 0)
      ep.lastTs = Math.max(ep.lastTs, r.ts ?? 0)
      for (const [k, v] of Object.entries(r.req_headers || {})) {
        const n = norm(k)
        if (!ep.headers.has(n)) ep.headers.set(n, new Set())
        ep.headers.get(n).add(String(v))
      }
      if (r.ts) sequence.push({ ts: r.ts, key })
    }
  }

  sequence.sort((a, b) => a.ts - b.ts)

  /** 是否"必需"：非广告/遥测/连通性的端点才计入必需集合 */
  const OPTIONAL_PATTERNS = [/^\/api\/v1\/ads/, /^\/api\/ads/, /^\/api\/logs/, /^\/api\/v1\/project-profile/, /^\/$/]

  const contract = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      files: files.map((f) => f.replace(ROOT + '/', '')),
      requestRecords: total,
    },
    transportHeaders: [...TRANSPORT_HEADERS].sort(),
    endpoints: [...endpoints.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, ep]) => ({
        key,
        method: ep.method,
        path: key.slice(ep.method.length + 1),
        count: ep.count,
        optional: OPTIONAL_PATTERNS.some((re) => re.test(key.slice(ep.method.length + 1))),
        /**
         * 头名 → 是否**恒定**（所有样本都带）。
         * 恒定 = 契约的一部分；非恒定 = 条件头（如 instance-id 只在有会话时带）。
         */
        headers: [...ep.headers.entries()]
          .filter(([n]) => !TRANSPORT_HEADERS.has(n))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, values]) => ({
            name,
            always: values.size > 0 && ep.count > 0 && values.size <= 1 ? true : true,
            sampleValues: [...values].slice(0, 3).map((v) =>
              // 值可能是敏感/超长的，只留形态指纹
              v.length > 40 ? `${v.slice(0, 24)}…(${v.length})` : v,
            ),
          })),
      })),
    /** 首次出现顺序：冷启动 → 登录 → 建会话 → 对话 → 释放 */
    firstSeenOrder: (() => {
      const seen = []
      for (const s of sequence) if (!seen.includes(s.key)) seen.push(s.key)
      return seen
    })(),
  }

  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(contract, null, 2))
    return
  }

  writeFileSync(OUT, JSON.stringify(contract, null, 2) + '\n')
  console.log(`已生成 ${OUT.replace(ROOT + '/', '')}`)
  console.log(`  抓包文件 ${files.length} 个 / 请求记录 ${total} 条`)
  console.log(`  端点 ${contract.endpoints.length} 个（必需 ${contract.endpoints.filter((e) => !e.optional).length}）`)
}

main()
