/**
 * protocol: 账号视图与邮箱遮蔽
 *
 * 账号列表对外字段 / maskEmail / 是否泄露 token.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { saveAccountUser } from '../../../../../../../src/auth-store.ts'
import { loadConfig } from '../../../../../../../src/config.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 账号池列表必须带 session.modelDisplayName(目录 key → 可读名).
// 回执里的 session.model 是目录 key(m-00032eaeec),控制台总览/账号池
// 直接显示它就是 m-00032eaeec ---- 用户看不出是哪个模型.
// 同时必须保留 session.model 原值:请求/寻址要用 key 本身,不能被展示名覆盖.
// 见 .agents/notes/implemented/bug-fix/2026-10-02-catalog-key-display-name-bridge.md
{
  const { AccountRuntimes } = await import('../../../../../../../src/app-context.ts')
  const { CatalogHolder } = await import('../../../../../../../src/upstream/catalog-protocol.ts')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-modelname-'))
  saveAccountUser(dir, { id: 'mn', email: 'mn@example.com', authToken: 'tok-mn' })
  const cfg = loadConfig()
  cfg.server.credentialsDir = dir
  cfg.upstream.credentialsDir = dir
  cfg.upstream.apiBase = 'http://127.0.0.1:1' // 不可达:只测字段装配,不真连上游
  cfg.session.pollIntervalSec = 3600

  const rts = new AccountRuntimes(cfg)
  const rt = rts.get('mn')
  // 注入一个已抓好目录的 catalog(真实目录行形态)
  const cat = new CatalogHolder({
    apiHost: 'https://x',
    token: 't',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          fetchId: 'fid',
          rows: [
            { key: 'm-00032eaeec', handle: 'fbm1.AAAA', displayName: 'MiMo 2.6 Flash' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })
  await cat.fetch()
  rt.upstream.catalog = cat

  // 直接验证解析函数:这是 list() 里 modelDisplayName 的来源
  assert.equal(
    rts._modelDisplayName('m-00032eaeec'),
    'MiMo 2.6 Flash',
    '目录 key 必须能解析出可读名',
  )
  assert.equal(rts._modelDisplayName('m-unknown'), null, '未知 key 返回 null（调用方回落原值）')
  assert.equal(rts._modelDisplayName(null), null, '空输入返回 null')

  await rts.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
}

// 对外错误响应绝不能带账号标识(key / email / 逐条原始 message).
// 429 响应会被下游 Agent 客户端原样转发,落进别人的日志与报错堆栈;
// 带上 email 等于把整个账号池的邮箱清单发给调用方(PII 泄露).
// 管理员要看明细请用控制台(登录后)或服务端日志.
// 判据与取舍见 .agents/notes/implemented/bug-fix/2026-10-02-no-account-pii-in-errors.md
{
  const { maskEmail } = await import('../../../../../../../src/app-context.ts')
  // 脱敏:保留域名,掩码本地部分
  assert.equal(maskEmail('alice@gmail.com'), 'a***e@gmail.com')
  assert.equal(maskEmail('ab@gmail.com'), 'a*@gmail.com')
  assert.equal(maskEmail('a@gmail.com'), '*@gmail.com')
  assert.equal(maskEmail('loli@woa.qzz.io'), 'l***i@woa.qzz.io')
  assert.equal(maskEmail(''), '')
  assert.equal(maskEmail(null), '')
  assert.equal(maskEmail('not-an-email'), '')
  // 脱敏结果不得包含完整本地部分
  const masked = maskEmail('alexrennie293@gmail.com')
  assert.ok(!masked.includes('alexrennie293'), `脱敏后仍含完整本地部分: ${masked}`)
  assert.ok(masked.includes('@gmail.com'), '域名应保留（排障要能区分账号）')
}

// 被封禁(banned)的账号不得再参与调度:不进候选,不 admit,不产生扣费.
// banned 是账号生命周期终点(账本 bannedAt 或冷却 code=banned),只能换号/等解封;
// 让它继续进候选 = 每次都白试一轮,且一次 admit 实付一整小时.
// 用户反馈的 14 账号全挂场景里,banned 账号出现在 failures 中属于已跳过记录,
// 不是"被调度过" ---- 这里钉死的是它根本不进候选,不产生任何上游扣费动作.
{
  const { AccountRuntimes } = await import('../../../../../../../src/app-context.ts')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-banned-'))
  saveAccountUser(dir, { id: 'bk1', email: 'banned1@example.com', authToken: 't1' })
  saveAccountUser(dir, { id: 'ok1', email: 'ok1@example.com', authToken: 't2' })
  const cfg = loadConfig()
  cfg.server.credentialsDir = dir
  cfg.upstream.credentialsDir = dir
  cfg.upstream.apiBase = 'http://127.0.0.1:1'
  cfg.session.pollIntervalSec = 3600

  const rts = new AccountRuntimes(cfg)
  // 把 bk1 判为封禁
  rts.markCooldown('bk1', { code: 'banned' }, 'deepseek/deepseek-v4-flash')

  const order = rts.candidateKeys('deepseek/deepseek-v4-flash')
  assert.ok(
    !order.includes('bk1'),
    `banned 账号不得进入候选列表，got ${JSON.stringify(order)}`,
  )
  assert.ok(order.includes('ok1'), '未封禁的账号应正常进候选')

  // 控制台列表里仍要区分 banned(用户要能看出"这个号废了")
  const row = rts.list().find((x) => x.key === 'bk1')
  assert.equal(row.banned, true, '列表应标记 banned')
  assert.equal(row.status, 'banned')

  await rts.shutdown()
  fs.rmSync(dir, { recursive: true, force: true })
}
