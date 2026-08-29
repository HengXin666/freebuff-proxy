/**
 * 运行时 catalog 自动同步 — 对齐 trefeon/freebuff-proxy 的 Registry.Refresh。
 *
 * 行为（与 trefeon internal/registry/registry.go 对齐）：
 *   - 从上游源码拉取三份常量文件（free-agents.ts / freebuff-models.ts /
 *     freebuff-model-ids.ts），raw 优先、jsDelivr CDN 镜像兜底；
 *   - 解析出 model → agent（base2 + base3 fallback）后**原子写**
 *     <dataDir>/catalog-cache.json；启动时 model.js 优先读它（存在则用之）；
 *   - 任何拉取/解析失败**保留旧缓存**（缓存不存在则回落内置 catalog），
 *     并把错误透给调用方记录日志——绝不因同步失败影响代理可用性；
 *   - 周期：启动立即一次 + 默认每 6h（trefeon REGISTRY_REFRESH 默认值）。
 *
 * 零新运行时依赖：用项目已有的 undici fetch。
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildCatalogFromSources } from './parser.mjs'

/** 上游源码常量文件（与 scripts/sync-catalog.mjs 同源）。 */
const SOURCE_FILES = [
  'free-agents.ts',
  'freebuff-models.ts',
  'freebuff-model-ids.ts',
]

/** raw.githubusercontent 优先；jsDelivr 镜像兜底（raw 被限流/墙时）。 */
const RAW_BASE = 'https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/'
const JSDELIVR_BASE = 'https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/'

/** 单个文件拉取超时（trefeon fetchTimeout = 30s）。 */
const FETCH_TIMEOUT_MS = 30_000

/**
 * 拉取一个常量文件：先 raw，失败再 jsDelivr。返回文本；两者都失败抛错。
 * @param {string} file
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<string>}
 */
export async function fetchSourceFile(file, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('no fetch implementation available (undici not loaded)')
  }
  let lastErr = null
  for (const base of [RAW_BASE, JSDELIVR_BASE]) {
    const url = base + file
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetchImpl(url, {
        signal: ac.signal,
        headers: { 'user-agent': 'freebuff-proxy/1.x (catalog sync)' },
      })
      if (!res.ok) {
        lastErr = new Error(`GET ${url} -> HTTP ${res.status}`)
        continue
      }
      const text = await res.text()
      if (!text || text.length < 100) {
        lastErr = new Error(`GET ${url} -> empty body (${text.length} bytes)`)
        continue
      }
      return text
    } catch (err) {
      lastErr =
        err && err.name === 'AbortError'
          ? new Error(`GET ${url} timed out after ${FETCH_TIMEOUT_MS}ms`)
          : err instanceof Error
            ? err
            : new Error(String(err))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr || new Error(`failed to fetch ${file}`)
}

/**
 * 拉取三份源码并构建 catalog。
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{version: number, syncedAt: string, source: string, models: unknown[]}>}
 */
export async function fetchCatalogFromUpstream(opts = {}) {
  const [agentsTs, modelsTs, modelIdsTs] = await Promise.all(
    SOURCE_FILES.map((f) => fetchSourceFile(f, opts)),
  )
  return buildCatalogFromSources(modelIdsTs, modelsTs, agentsTs)
}

/**
 * 原子写 catalog 缓存（先写临时文件再 rename，避免半截文件被读到）。
 * @param {string} filePath
 * @param {object} catalog
 */
export function writeCatalogCache(filePath, catalog) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2))
  fs.renameSync(tmp, filePath)
}

/**
 * 读 catalog 缓存；不存在/损坏返回 null（调用方回落内置 catalog）。
 * @param {string} filePath
 * @returns {object | null}
 */
export function readCatalogCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.models)) return null
    return raw
  } catch {
    return null
  }
}

/**
 * 启动后台同步循环（对齐 trefeon refreshLoop）：
 * 启动立即尝试一次，然后每 intervalMs 一次；失败仅记录日志、保留旧缓存。
 *
 * @param {string} cachePath  <dataDir>/catalog-cache.json
 * @param {{
 *   intervalMs?: number,
 *   log?: (msg: string, ...args: unknown[]) => void,
 *   fetchImpl?: typeof fetch,
 *   runOnce?: boolean,
 * }} [opts]
 * @returns {{ stop: () => void, refresh: () => Promise<{ ok: boolean, error?: string, models?: number }> }}
 */
export function startCatalogSync(cachePath, opts = {}) {
  const intervalMs =
    opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : 6 * 60 * 60 * 1000
  const log = opts.log || ((msg) => console.log(`[catalog-sync] ${msg}`))
  let stopped = false
  let inFlight = null

  async function refresh() {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const catalog = await fetchCatalogFromUpstream(opts)
        writeCatalogCache(cachePath, catalog)
        log(`refreshed: ${catalog.models.length} models -> ${cachePath}`)
        return { ok: true, models: catalog.models.length }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`refresh failed; keeping previous state: ${msg}`)
        return { ok: false, error: msg }
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  // 启动立即一次；不阻塞调用方。
  const first = refresh().catch(() => {})
  if (opts.runOnce) {
    return { stop: () => {}, refresh, done: first }
  }

  const timer = setInterval(() => {
    refresh().catch(() => {})
  }, intervalMs)
  timer.unref?.()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
    refresh,
    done: first,
  }
}
