/**
 * 思考强度覆盖 -- 解析真源 + 运行设置往返 + 出站体落点.
 *
 * 判据(可证伪): 把 resolveForcedEffort 的 enabled 判断去掉, 或把
 * buildForwardBody 里那段 applyForcedEffort 删掉, 本文件即红.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  REASONING_EFFORTS, isReasoningOverrideShape, normalizeReasoningOverride,
  resolveForcedEffort, applyForcedEffort,
} from '../../../../../src/proxy/reasoning-effort.ts'

let n = 0
const ok = (cond: unknown, msg: string) => {
  assert.ok(cond, msg)
  n += 1
}

/** 造一个只认三条模型行的假目录. */
function fakeCatalog() {
  const rows: Record<string, any> = {
    'm-aaa': { key: 'm-aaa', displayName: 'MiMo 2.6 Flash', efforts: ['low', 'high', 'max'] },
    'm-bbb': { key: 'm-bbb', displayName: 'Solar Pro 4' },
    'm-ccc': { key: 'm-ccc', displayName: 'Gemini 3.8 Flash', efforts: ['high'] },
  }
  const byName: Record<string, string> = {
    'MiMo 2.6 Flash': 'm-aaa', 'Solar Pro 4': 'm-bbb', 'Gemini 3.8 Flash': 'm-ccc',
    'm-aaa': 'm-aaa', 'm-bbb': 'm-bbb', 'm-ccc': 'm-ccc',
  }
  return {
    keyForName: (name: string) => byName[name] ?? null,
    row: (key: string) => rows[key] ?? null,
  }
}

// -- (1) 默认关闭: 任何配置都不覆盖 -------------------------------------
const offCfg = { reasoningOverride: { enabled: false, models: [{ model: 'm-aaa', effort: 'max' }] } }
ok(resolveForcedEffort(offCfg, fakeCatalog(), ['m-aaa']) === null, '开关关闭时必须不覆盖')
ok(resolveForcedEffort({}, fakeCatalog(), ['m-aaa']) === null,
  '未配置时必须不覆盖')

// -- (2) 逐模型区分: 每个模型用各自的档位, 不是一个统一值 ----------------
{
  const settings = {
    reasoningOverride: {
      enabled: true,
      models: [
        { model: 'm-aaa', effort: 'max' },
        { model: 'm-ccc', effort: 'high' },
      ],
    },
  }
  const cat = fakeCatalog()
  const a = resolveForcedEffort(settings, cat, ['m-aaa'])
  const c = resolveForcedEffort(settings, cat, ['Gemini 3.8 Flash'])
  ok(a?.effort === 'max', `m-aaa 必须用 max, got ${JSON.stringify(a)}`)
  ok(c?.effort === 'high', `Gemini 必须用 high, got ${JSON.stringify(c)}`)
  ok(a?.effort !== c?.effort, '不同模型必须能用不同档位')
}

// -- (3) 可读名与目录 key 两种写法都能命中 ------------------------------
{
  const settings = { reasoningOverride: { enabled: true, models: [{ model: 'MiMo 2.6 Flash', effort: 'low' }] } }
  ok(resolveForcedEffort(settings, fakeCatalog(), ['m-aaa'])?.effort === 'low',
    '按可读名配置, 请求侧传目录 key 时也要命中')
  ok(resolveForcedEffort(settings, fakeCatalog(), ['MiMo 2.6 Flash'])?.effort === 'low',
    '请求侧传可读名时也要命中')
}

// -- (4) 模型声明了 efforts 且不含该档位: 跳过(不覆盖) -------------------
{
  const settings = { reasoningOverride: { enabled: true, models: [{ model: 'm-ccc', effort: 'max' }] } }
  ok(resolveForcedEffort(settings, fakeCatalog(), ['m-ccc']) === null,
    'Gemini 只声明 high, 配 max 必须跳过')
  const undelcared = { reasoningOverride: { enabled: true, models: [{ model: 'm-bbb', effort: 'max' }] } }
  ok(resolveForcedEffort(undelcared, fakeCatalog(), ['m-bbb'])?.effort === 'max',
    '未声明 efforts 的模型照配置发')
}

// -- (5) 未配置的模型保持不动 -------------------------------------------
{
  const settings = { reasoningOverride: { enabled: true, models: [{ model: 'm-aaa', effort: 'max' }] } }
  ok(resolveForcedEffort(settings, fakeCatalog(), ['m-bbb']) === null,
    '未列入的模型必须不覆盖')
}

// -- (6) 形态校验与归一 ---------------------------------------------------
ok(isReasoningOverrideShape({ enabled: true, models: [] }), '空表合法')
ok(!isReasoningOverrideShape({ enabled: true, models: [{ model: 'x', effort: 'bogus' }] }), '非法档位必须拒绝')
ok(!isReasoningOverrideShape({ enabled: 1, models: [] }), 'enabled 非布尔必须拒绝')
ok(REASONING_EFFORTS.includes('ultra'), '档位枚举必须含官方全集')
{
  const norm = normalizeReasoningOverride({
    enabled: true,
    models: [
      { model: ' a ', effort: 'high' }, { model: 'a', effort: 'low' },
      { model: '', effort: 'low' }, { model: 'b', effort: 'nope' },
    ],
  })
  ok(norm.models.length === 1 && norm.models[0].model === 'a' && norm.models[0].effort === 'high',
    `归一必须去重去空去非法, got ${JSON.stringify(norm.models)}`)
}

// -- (7) applyForcedEffort: 只留一个 reasoning.effort --------------------
{
  const out = applyForcedEffort({ model: 'x', reasoning_effort: 'low', reasoning: { effort: 'low', extra: 1 } }, 'max')
  ok(out.reasoning_effort === undefined && out.reasoning.effort === 'max',
    `必须清掉顶层并覆盖嵌套, got ${JSON.stringify(out)}`)
}

// -- (8) 运行设置往返: 存盘 -> 读回 --------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-effort-'))
  const file = path.join(dir, 'settings.json')
  const { SettingsStore } = await import('../../../../../src/web/store/config/settings-store.ts')
  const store: any = new SettingsStore(file)
  ok(store.get().reasoningOverride?.enabled === false, '默认必须是关闭')
  store.save({ reasoningOverride: { enabled: true, models: [{ model: 'm-aaa', effort: 'max' }] } })
  const reloaded: any = new SettingsStore(file)
  ok(reloaded.get().reasoningOverride?.enabled === true,
    '重启读回后必须仍是开启')
  ok(reloaded.get().reasoningOverride?.models?.[0]?.effort === 'max',
    '重启读回后逐模型档位必须保留')
  let threw = false
  const badCfg = { reasoningOverride: { enabled: true, models: [{ model: 'x', effort: 'nope' }] } }
  try { store.save(badCfg as any) } catch { threw = true }
  ok(threw, '非法档位必须被 save 拒绝')
  fs.rmSync(dir, { recursive: true, force: true })
}

// -- (9) 出站体落点: buildForwardBody 命中覆盖时改 legacy 体 --------------
{
  const { buildForwardBody } = await import('../../../../../src/proxy/transport/forward-body.ts')
  const settings = { reasoningOverride: { enabled: true, models: [{ model: 'm-aaa', effort: 'max' }] } }
  const ctx = { settingsStore: { get: () => settings }, config: { upstream: { channel: 'official' } } }
  const built = buildForwardBody(
    ctx,
    { model: 'MiMo 2.6 Flash', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
    'm-aaa', 'inst-1', 'run-1', 'agent-1', 'client-1', null, 'm-aaa', fakeCatalog(), 'worker', null, true,
  )
  ok(built.body.reasoning?.effort === 'max',
    `下游传 low 时必须被覆盖成 max, got ${JSON.stringify(built.body.reasoning)}`)
  ok(built.body.reasoning_effort === undefined, '不得同时留两个思考字段')
  const off = buildForwardBody(
    {
      settingsStore: { get: () => offCfg },
      config: { upstream: { channel: 'official' } },
    },
    { model: 'MiMo 2.6 Flash', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
    'm-aaa', 'inst-1', 'run-1', 'agent-1', 'client-1', null, 'm-aaa', fakeCatalog(), 'worker', null, true,
  )
  ok(off.body.reasoning?.effort === 'low',
    `开关关闭时下游档位必须原样保留, got ${JSON.stringify(off.body.reasoning)}`)
}

console.log(`思考强度覆盖验证通过(断言 ${n} 条)`)
