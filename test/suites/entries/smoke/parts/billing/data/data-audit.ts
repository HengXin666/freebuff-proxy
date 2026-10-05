/**
 * billing: 数据文件审计
 *
 * 脏数据文件检测 / 隔离 / 修复.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { CATALOG_CACHE_FILENAME } from '../../../../../../../src/model.ts'
import {
  dataFileAudit,
  dirtyDataFiles,
  invalidDataFiles,
  quarantineFile,
} from '../../../../../../../src/util/json-store.ts'
import { ModelStore } from '../../../../../../../src/web/store/config/model-store.ts'
import { ProxyStore } from '../../../../../../../src/web/store/config/proxy-store.ts'
import { WebSessionStore } from '../../../../../../../src/web/store/session/session-store.ts'
import { SettingsStore } from '../../../../../../../src/web/store/config/settings-store.ts'
import { UserStore } from '../../../../../../../src/web/store/session/user-store.ts'
import { tmpDir } from '../../../harness/runtime.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ===========================================================================
// (DATA-FILES) 数据目录 JSON 的统一读取口径
//
// 真实事故:镜像升级后容器起不来,用户删掉几个 /data/*.json 才恢复,而日志里
// 只有一行容易被忽略的 warn.根因是每个 store 各自 try/catch,坏了就当空数据
// 继续跑 ---- 于是"配置悄悄回落默认值""账号履历全丢"都没人告诉你.
// 这里锁死三件事:
//   ① 损坏文件必须被显式记账(启动横幅 / 控制台自检读的就是这份账);
//   ② users.json 损坏绝不静默重建管理员(loadStatus 必须是 invalid);
//   ③ 派生缓存(catalog-cache.json)损坏时不能安静地当"从没同步过",要留证.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-datastore-'))
  const write = (name, content) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    return p
  }
  const broken = '{"broken": tru' // 截断 + 非法字面量,最接近写盘被中断的真实形态

  // ① 六个控制面 store:正常文件 → ok;损坏文件 → invalid(都登记进审计)
  const usersPath = write('users.json', JSON.stringify({ version: 1, users: [] }))
  const settingsPath = write('settings.json', JSON.stringify({ version: 1, accountMaxConcurrency: 3 }))
  const proxiesPath = write('proxies.json', broken)
  const modelsPath = write('custom-models.json', JSON.stringify({ version: 1, models: [], hidden: [] }))
  const webSessPath = write('web-sessions.json', JSON.stringify({ version: 1, sessions: [] }))

  const userStore = new UserStore(usersPath)
  assert.equal(userStore.loadStatus, 'ok', 'users.json 正常时必须报 ok')
  const settingsStore = new SettingsStore(settingsPath)
  assert.equal(settingsStore.get().accountMaxConcurrency, 3, 'settings.json 必须能读回设置')

  // 布尔开关的往返回归:save() 能写盘,load() 就必须读回.
  // 漏读的表现是"控制台打开开关,重启后自己关了",症状与"开关没用"无法区分.
  {
    const rtPath = path.join(tmpDir, 'settings-roundtrip.json')
    const w = new SettingsStore(rtPath)
    w.save({ cliTelemetryEnabled: true })
    const r = new SettingsStore(rtPath).get()
    assert.equal(r.cliTelemetryEnabled, true, 'cliTelemetryEnabled 写盘后必须能读回')
    const fresh = new SettingsStore(path.join(tmpDir, 'settings-fresh.json')).get()
    assert.equal(fresh.cliTelemetryEnabled, false, '未配置时 cliTelemetryEnabled 默认关闭')
  }
  // 网页通道开关(webChannelEnabled)必须已彻底移除:用户明确要求永远只走
  // CLI 通道(真正的 agent 接口)---- 网页通道的请求体没有 tools 字段,工具调用
  // 在它上面根本无法工作.留着开关会让人误以为还有第二条路.
  {
    const fresh = new SettingsStore(path.join(tmpDir, 'settings-noweb.json')).get()
    assert.ok(
      !('webChannelEnabled' in fresh),
      'webChannelEnabled 必须从设置里移除（只走 CLI 通道）',
    )
    // 旧 settings.json 里残留该键也不得让它复活
    const legacyPath = path.join(tmpDir, 'settings-legacy.json')
    fs.writeFileSync(legacyPath, JSON.stringify({ webChannelEnabled: true }))
    const legacy = new SettingsStore(legacyPath).get()
    assert.ok(
      !('webChannelEnabled' in legacy),
      '旧配置残留 webChannelEnabled 也不得被读回',
    )
  }
  const proxyStore = new ProxyStore(proxiesPath)
  assert.equal(proxyStore.loadStatus, 'invalid', '损坏的 proxies.json 必须报 invalid')
  assert.deepEqual(proxyStore.list(), [], '损坏的代理池按空处理（不抛）')

  // 代理池里的脏值(null / 数字 / 畸形 URL)必须被丢弃:原样传下去会在
  // 构造出网 agent 时抛 ERR_INVALID_URL ---- 那是启动后的第一次出网就崩.
  {
    const dirtyProxies = write('proxies-dirty.json', JSON.stringify({
      version: 1,
      proxies: [null, 123, {}, 'not a url', 'http://127.0.0.1:7890', '  socks5://127.0.0.1:1080  '],
    }))
    const store = new ProxyStore(dirtyProxies)
    assert.doesNotThrow(() => store.list())
    assert.deepEqual(
      store.list(),
      ['http://127.0.0.1:7890', 'socks5://127.0.0.1:1080'],
      '只保留合法代理 URL（去空白），脏值全部丢弃',
    )
    assert.ok(
      dirtyDataFiles().some((e) => e.file === path.resolve(dirtyProxies)),
      '丢弃脏代理必须记账（否则用户以为代理设置被静默重置）',
    )
    const { sanitizeProxyList: san } = await import('../../../../../../../src/util/json-store.ts')
    assert.deepEqual(san([{ url: 'http://a:1' }]), { urls: [], dropped: 1 }, '对象形态的代理条目按非法处理')
    assert.deepEqual(san('http://a:1'), { urls: [], dropped: 0 }, '非数组输入不抛异常')
  }
  const modelStore2 = new ModelStore(modelsPath)
  assert.equal(modelStore2.loadStatus, 'ok', 'custom-models.json 正常时必须报 ok')
  const webSessions = new WebSessionStore(webSessPath, 3600_000)
  assert.equal(webSessions.loadStatus, 'ok', 'web-sessions.json 正常时必须报 ok')

  // 缺文件 = missing(首次启动),不是 invalid ---- 否则全新部署会被误报成损坏
  const missingStore = new ProxyStore(path.join(dir, 'nope.json'))
  assert.equal(missingStore.loadStatus, 'missing', '文件不存在必须报 missing 而不是 invalid')

  // 审计按绝对路径记账(同一进程里可能有多个同名文件,如测试各自的临时目录)
  const byPath = new Map(dataFileAudit().map((e) => [e.file, e]))
  const rec = byPath.get(path.resolve(proxiesPath))
  assert.equal(rec?.status, 'invalid', '损坏文件必须出现在装载审计里')
  assert.ok(rec?.reason, '损坏必须带上原因（否则用户无从下手）')
  assert.ok(
    invalidDataFiles().some((e) => e.file === path.resolve(proxiesPath)),
    '损坏文件必须出现在 invalidDataFiles()（启动横幅/控制台自检都读它）',
  )

  // ② users.json 损坏:状态必须是 invalid,且不能被当成"没有账号"
  //    ---- 否则 bin/serve.ts 的拒绝启动分支永远走不到,又会静默重建管理员.
  const brokenUsers = write('users-broken.json', broken)
  const brokenUserStore = new UserStore(brokenUsers)
  assert.equal(
    brokenUserStore.loadStatus,
    'invalid',
    '损坏的 users.json 必须报 invalid（bin/serve.ts 据此拒绝启动）',
  )
  assert.equal(brokenUserStore.users.length, 0, '损坏时不得凭空造出用户')

  // ③ 派生缓存损坏:必须登记为 invalid,且把损坏文件挪到一边留证(不静默覆盖)
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-catalogleak-'))
  const cachePath = path.join(cacheDir, CATALOG_CACHE_FILENAME)
  fs.writeFileSync(cachePath, broken)
  const quarantined = quarantineFile(cachePath)
  assert.ok(quarantined && fs.existsSync(quarantined), '损坏的派生缓存必须被挪走留证')
  assert.ok(!fs.existsSync(cachePath), '挪走后原路径应为空，交给同步重新生成')
  assert.ok(
    quarantined.includes('.corrupt-'),
    '备份文件名必须带 .corrupt- 前缀，便于用户识别与清理',
  )

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(cacheDir, { recursive: true, force: true })
}
