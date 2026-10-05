/**
 * pool: 档位与免费会话状态
 *
 * limited 档位在清单里的呈现, 以及免费会话 none 状态的建模.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { buildModelsListResponse } from '../../../../../../../src/model.ts'
import { SessionManager } from '../../../../../../../src/session-manager.ts'
import assert from 'node:assert/strict'

/**
 * 回归:accessTier='limited' 不得把整个目录标成 unavailable.
 *
 * 真实故障(用户反馈[测试对话只有一个模型]):内置 catalog 15 条都没有
 * accessTiers 字段 → 一律回落 ['full'] → 上游回一次 accessTier:'limited',整张
 * 列表就被染成 available:false,前端过滤后只剩 extraIds 里那一个模型.
 * 目录准入 ≠ 实时配额:真正拦人的是 freebucks/units 闸门,不是这个静态标记.
 */
{
  const limited = buildModelsListResponse({ accessTier: 'limited', includeAllCatalog: true })
  const unavailable = limited.data.filter((m) => m.available === false)
  assert.equal(
    unavailable.length,
    0,
    `accessTier=limited 时不应有任何模型被标成不可用（实际 ${unavailable.length} 个：${unavailable.map((m) => m.id).join(',')}）`,
  )
  // 基线 = 内置 catalog 的全量条目数(用同一入口取,避免硬编码数字)
  const baseline = buildModelsListResponse({ includeAllCatalog: true }).data.length
  assert.ok(
    limited.data.length >= baseline,
    `accessTier=limited 时列表长度不得缩水（${limited.data.length} < ${baseline}）`,
  )
  // 前端[测试对话]的过滤条件(available !== false)必须留下全部模型----
  // 这正是以前只剩一个的那一行.
  const visible = limited.data.filter((m) => m.available !== false)
  assert.equal(visible.length, limited.data.length, '测试对话下拉必须能看到全部模型')
  // 上游真实清单只作为标注透出(upstreamModelIds),不是过滤依据.
  const withIds = buildModelsListResponse({
    accessTier: 'limited',
    extraIds: ['deepseek/deepseek-v4-flash'],
  })
  assert.ok(
    withIds.data.find((m) => m.id === 'deepseek/deepseek-v4-flash').available !== false,
    '上游给过额度的模型当然可用',
  )
  assert.ok(
    withIds.data.find((m) => m.id === 'mimo/mimo-v2.5') !== undefined,
    '未出现在 extraIds 里的目录模型也必须保留在列表中',
  )
}

/**
 * 回归:账号级错误回执不得抹掉活着的 session 句柄.
 *
 * 上游对 banned / country_blocked 的 GET 回执是 200 + {status:'banned'}.以前
 * SessionManager.refresh() 无条件 _apply(body),于是控制台点一次[刷新]就会:
 * 1) 把 session 覆盖成无 instanceId 的空壳 ---- 已付费一小时的会话从此无法寻址,
 * DELETE 不掉(腾不出上游槽位)也追不回钱(退款的唯一凭据就是 instanceId);
 * 用户要求[刷新和警告都不会导致丢失已购买的会话]正是这条.
 * 2) 记成 lastProbe.ok = true ---- 探测失败却显示成功.
 */
{
  const up = {
    freebuffSession: async (method) => {
      if (method === 'GET') return { status: 'banned', message: 'account banned' }
      throw new Error('不应触达 ' + method)
    },
  }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true }, limits: {} },
    accountKey: 'probe-k',
  })
  // 先造一条活着的会话(买断了整小时)
  sm.session = {
    status: 'active',
    instanceId: 'inst-live',
    model: 'deepseek/deepseek-v4-flash',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    remainingMs: 3600_000,
  }
  await assert.rejects(
    () => sm.refresh(),
    (err) => err.code === 'banned',
    '账号级回执必须抛出（调用方据此区分 ban 与正常）',
  )
  assert.equal(sm.session?.instanceId, 'inst-live', '刷新不得抹掉活会话的句柄')
  assert.equal(sm.session?.status, 'active', '刷新不得篡改活会话状态')
  assert.equal(sm.lastProbe?.ok, false, '探测失败必须如实记为失败')
  assert.equal(sm.lastProbe?.code, 'banned')
  assert.ok(sm.hasLiveSlot(), '账号级故障不等于会话没了')
}

{
  const up = {
    freebuffSession: async () => ({ status: 'none', accessTier: 'full' }),
  }
  const sm = new SessionManager({
    upstream: up,
    config: { session: { reAdmitOnExpire: true }, limits: {} },
    accountKey: 'probe-ok',
  })
  await sm.refresh()
  assert.equal(sm.lastProbe?.ok, true, '正常回执仍记为成功')
  assert.equal(sm.lastProbe?.code, null)
}
