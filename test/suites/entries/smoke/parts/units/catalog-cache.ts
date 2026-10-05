/**
 * unit: catalog 缓存落 dataDir
 *
 * issue #9: 写死 /app/data 会 EACCES.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import {
  CATALOG_CACHE_FILENAME,
  DEFAULT_CATALOG_CACHE_PATH,
  applyCatalogCache,
  catalogCachePath,
  mergeCatalogWithBuiltin,
} from '../../../../../../src/model.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- unit: catalog 缓存必须落在 dataDir(issue #9:写死 /app/data → EACCES)---
{
  const { writeCatalogCache, readCatalogCache, startCatalogSync } = await import(
    '../../../../../../src/catalog/runtime-sync.ts'
  )
  // 路径由 dataDir 决定, 不取源码目录旁的 data
  assert.equal(catalogCachePath('/data'), path.join('/data', CATALOG_CACHE_FILENAME))
  assert.equal(catalogCachePath('/srv/x'), path.join('/srv/x', 'catalog-cache.json'))
  assert.ok(DEFAULT_CATALOG_CACHE_PATH.endsWith(path.join('data', CATALOG_CACHE_FILENAME)))

  // 切到 dataDir 后能读回同一份缓存(读路径 = 写路径)
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-proxy-catalog-'))
  const before = applyCatalogCache(cacheDir)
  assert.equal(before.path, catalogCachePath(cacheDir))
  assert.ok(before.models.length > 0, '切换到 dataDir 后应能读回合并后的 catalog')
  assert.ok(
    before.models.some((m) => m.id === 'deepseek/deepseek-v4-flash'),
    '切入 dataDir 后应能读到真实 catalog（含 flash）',
  )
  // 内置 catalog 兜底写一份(server 启动时的 seed 行为)
  assert.deepEqual(
    writeCatalogCache(before.path, {
      version: 1,
      models: before.models,
      source: 'builtin',
    }),
    { ok: true },
  )
  assert.equal(readCatalogCache(before.path)?.models.length, before.models.length)

  // 目录不可写(旧版 Docker 的 /app/data)→ 只报错不抛,同步循环继续跑
  const badDir = path.join(cacheDir, 'file-not-a-dir')
  fs.writeFileSync(badDir, 'x')
  const fail = writeCatalogCache(path.join(badDir, 'catalog-cache.json'), { models: [] })
  assert.equal(fail.ok, false)
  assert.match(fail.error, /ENOTDIR|EEXIST|EACCES|EPERM|ENOENT/)

  // 拉取成功但落盘失败 → 日志必须区别于"拉取失败"(issue #9 的误导来源)
  const logs = []
  const sync = startCatalogSync(path.join(badDir, 'catalog-cache.json'), {
    log: (m) => logs.push(m),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => 'export const X_MODEL_ID = \'a/b\'\nexport const Y_MODEL_ID = \'c/d\'\n'.repeat(5),
    }),
  })
  await sync.done
  assert.ok(
    logs.some((m) => m.includes('catalog cache not writable')),
    '落盘失败必须报 cache not writable，而不是 refresh failed',
  )
  assert.ok(!logs.some((m) => m.includes('refresh failed')), '不得把权限问题报成拉取失败')
  sync.stop()
  fs.rmSync(cacheDir, { recursive: true, force: true })

  // 合并规则:内置元信息优先,agent 映射跟随缓存
  const merged = mergeCatalogWithBuiltin(
    [{ id: 'm', displayName: '内置名', pool: 'premium', agentId: 'base2-x' }],
    [
      { id: 'm', displayName: '缓存名', pool: 'daily', agentId: 'base2-new' },
      { id: 'new', displayName: '新模型' },
    ],
  )
  assert.equal(merged[0].displayName, '内置名')
  assert.equal(merged[0].pool, 'premium')
  assert.equal(merged[0].agentId, 'base2-new')
  assert.equal(merged[1].id, 'new')
  assert.deepEqual(mergeCatalogWithBuiltin([{ id: 'm' }], null), [{ id: 'm' }])
}
