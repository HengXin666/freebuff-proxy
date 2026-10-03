#!/usr/bin/env node
/**
 * 上游契约对账门禁（**确定性检查**，不是文字规范）。
 *
 * 判据（任一条不满足即退出 1）：
 *
 *   1. 契约完整性：抓包里每个**必需端点**，在真源文件里都有常量。
 *      → 上游加端点而我们没登记 → 红。
 *   2. 头名真源：契约里每个**业务头**，在真源文件里都有常量。
 *      → 上游改头名 → 红。
 *   3. 禁止裸字符串：src/ 与 cli-bridge/ 不得出现**未登记**的 x-freebuff-* 字面量。
 *      → 绕过真源另写一份 → 红（这是"牵一发而动全身"的根治）。
 *   4. 禁止废弃头：RETIRED_HEADERS 里的头不得在任何源码中出现。
 *      → 有人把 x-codebuff-api-key 加回来 → 红。
 *
 * 为什么是这四条：上游变更有四种形状（加端点 / 改头名 / 加头 / 我们写歪），
 * 四条各挡一种，且都是**可机器判定**的，不依赖人读文档。
 *
 * 用法：
 *   node scripts/check-upstream-contract.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CONTRACT = join(ROOT, 'docs/reverse/upstream-contract.json')
const TRUTH = join(ROOT, 'src/upstream/upstream-contract.js')

/** 扫描根：主服务与官方形态实现，两端都必须服从真源。 */
const SCAN_ROOTS = ['src', 'cli-bridge', 'bin']
/** 真源文件自身允许出现这些字面量（它就是定义处）。 */
const TRUTH_REL = 'src/upstream/upstream-contract.js'

function walk(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e.startsWith('.')) continue
      out.push(...walk(p))
    } else if (/\.(js|mjs|ts)$/.test(e)) {
      out.push(p)
    }
  }
  return out
}

const rel = (p) => p.replace(ROOT + '/', '')

function main() {
  const errors = []
  const warnings = []

  if (!existsSync(CONTRACT)) {
    console.error('缺少契约快照:', rel(CONTRACT))
    console.error('先运行: node scripts/gen-upstream-contract.mjs')
    process.exit(1)
  }
  if (!existsSync(TRUTH)) {
    console.error('缺少真源文件:', rel(TRUTH))
    process.exit(1)
  }

  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
  const truthSrc = readFileSync(TRUTH, 'utf8')

  // 真源文件里登记了哪些端点路径与头名（按字面量取值）
  const truthEndpoints = new Set(
    [...truthSrc.matchAll(/export const EP_[A-Z_]+\s*=\s*'([^']+)'/g)].map((m) => m[1]),
  )
  const truthHeaders = new Set(
    [...truthSrc.matchAll(/export const H_[A-Z_]+\s*=\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
  )
  const retired = new Set(
    [...truthSrc.matchAll(/RETIRED_HEADERS\s*=\s*\[([\s\S]*?)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1])),
  )

  // ── 判据 1：必需端点必须在真源里 ────────────────────────────────────
  const required = contract.endpoints.filter((e) => !e.optional)
  for (const e of required) {
    if (!truthEndpoints.has(e.path)) {
      errors.push(
        `契约端点未登记到真源: ${e.key}（抓包 ${e.count} 次）→ 在 ${rel(TRUTH)} 补 EP_* 常量`,
      )
    }
  }

  // ── 判据 2：契约里的业务头必须在真源里 ──────────────────────────────
  const contractHeaders = new Set()
  for (const e of required) for (const h of e.headers) contractHeaders.add(h.name)
  for (const name of [...contractHeaders].sort()) {
    if (!truthHeaders.has(name)) {
      errors.push(`契约头未登记到真源: ${name} → 在 ${rel(TRUTH)} 补 H_* 常量`)
    }
  }

  // ── 判据 3：源码不得出现未登记的 x-freebuff-* / x-fb-* 字面量 ────────
  const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)))
  const bareRe = /['"`](x-freebuff-[a-z0-9-]+|x-fb-[a-z0-9-]+)['"`]/g
  /**
   * 本代理**自己的**响应头前缀（`x-freebuff-proxy-*`）—— 那是给下游看的，
   * 不是上游契约的一部分，不能当成"未登记的上游头"误报。
   */
  const SELF_HEADER_PREFIX = 'x-freebuff-proxy-'
  for (const f of files) {
    if (rel(f) === TRUTH_REL) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(bareRe)) {
      const name = m[1]
      if (name.startsWith(SELF_HEADER_PREFIX)) continue
      if (truthHeaders.has(name)) continue
      if (retired.has(name)) continue
      errors.push(
        `裸头字面量（未登记）: ${rel(f)} 中的 '${name}' → 改用 ${rel(TRUTH)} 的 H_* 常量`,
      )
    }
  }

  // ── 判据 4：废弃头不得出现 ──────────────────────────────────────────
  for (const f of files) {
    if (rel(f) === TRUTH_REL) continue
    const src = readFileSync(f, 'utf8')
    for (const name of retired) {
      /**
       * 只扫**代码**，注释里提到不算违规 ——
       * 那些注释正是在解释"为什么废弃"，把它们当违规会逼人删掉说明。
       * 这里先整体剥离块注释（含 JSDoc 的 `*` 行）再逐行找字符串字面量。
       */
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释 / JSDoc
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '')) // 行注释
        .join('\n')
      if (code.includes(`'${name}'`) || code.includes(`"${name}"`)) {
        errors.push(
          `废弃头回潮: ${rel(f)} 仍在发送 '${name}'（客户端 0 次，见 docs/reverse/20）`,
        )
      }
    }
  }

  if (warnings.length) for (const w of warnings) console.warn('WARN', w)

  if (errors.length) {
    console.error(`\n上游契约对账失败（${errors.length} 项）：`)
    for (const e of [...new Set(errors)]) console.error('  ✗', e)
    console.error('\n上游变更后：重抓包 → node scripts/gen-upstream-contract.mjs → 改真源文件')
    process.exit(1)
  }

  console.log('上游契约对账通过')
  console.log(`  必需端点 ${required.length} 个，全部登记在真源`)
  console.log(`  业务头 ${contractHeaders.size} 个，全部登记在真源`)
  console.log(`  扫描 ${files.length} 个源文件，无裸字面量、无废弃头回潮`)
}

main()
