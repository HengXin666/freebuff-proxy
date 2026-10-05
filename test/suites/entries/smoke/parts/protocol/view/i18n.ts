/**
 * protocol: 前端 i18n 词条一致性
 *
 * 所有语种的键集合必须一致.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'

// ===========================================================================
// 多语言(zh-CN / en):字典完整性与 t() 行为.
//
// 红线由 scripts/check-i18n.ts 在 CI 独立 job 里跑(它检查 app.js 硬编码
// 中文 + 各语种 key 一致 + 代码引用的 key 存在).这里只守住字典与 t()
// 本身的契约:语种切换,占位符替换,缺 key 回落.
// 见 .agents/notes/implemented/feature/2026-10-02-dashboard-i18n.md
{
  const i18n = await import('../../../../../../../dashboard/locale/index.ts')
  const { t, setLocale, getLocale, initLocale, dictKeys, localeKeys, LOCALES, DEFAULT_LOCALE } = i18n

  assert.ok(LOCALES.includes(DEFAULT_LOCALE), '默认语种必须在语种列表里')
  assert.ok(LOCALES.includes('en'), '必须支持英文')

  // 每个语种都覆盖基准语种的全部 key(CI 红线也查这条,这里是本地快检)
  const baseKeys = localeKeys(DEFAULT_LOCALE).sort()
  assert.ok(baseKeys.length > 50, `字典条目太少（${baseKeys.length}），疑似没写全`)
  for (const loc of LOCALES) {
    if (loc === DEFAULT_LOCALE) continue
    const keys = localeKeys(loc).sort()
    assert.deepEqual(
      keys,
      baseKeys,
      `[${loc}] 词条必须与基准 ${DEFAULT_LOCALE} 完全一致`,
    )
  }

  /**
   * 占位符替换.
   *
   * 本段断言的 key 是 model.syncReportAligned(同步结果弹窗用的词条).
   */
  setLocale('zh-CN')
  assert.equal(getLocale(), 'zh-CN')
  const zhSync = t('model.syncReportAligned', { n: 3 })
  setLocale('en')
  assert.equal(getLocale(), 'en')
  const enSync = t('model.syncReportAligned', { n: 3 })
  assert.notEqual(zhSync, enSync, '中英文案必须不同')
  assert.ok(!zhSync.includes('{n}'), `占位符未替换: ${zhSync}`)
  assert.ok(!enSync.includes('{n}'), `占位符未替换: ${enSync}`)
  assert.ok(enSync.includes('3'), '占位符应被替换为实际值')

  // 语种归一化:zh-TW / en-US 等带地区的写法要能落到对应语种
  assert.equal(setLocale('zh-TW'), 'zh-CN')
  assert.equal(setLocale('en-US'), 'en')
  assert.equal(setLocale('ja-JP'), DEFAULT_LOCALE, '不支持的语种回落到默认')

  // 缺 key 返回 key 本身(界面露出可读 key)
  assert.equal(t('nope.missing.key'), 'nope.missing.key')

  // 各语种文案都不该是空串
  for (const loc of LOCALES) {
    setLocale(loc)
    for (const k of dictKeys()) {
      const v = t(k)
      assert.ok(typeof v === 'string' && v.length > 0, `[${loc}] ${k} 文案为空`)
    }
  }
  setLocale(DEFAULT_LOCALE)
}
