/**
 * billing: JSON store 边界
 *
 * 混入 null 曾让服务在监听端口前就崩; BOM 与非法字段.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { invalidCredentialFiles, listAccounts } from '../../../../../../../src/auth-store.ts'
import { SessionHandleStore } from '../../../../../../../src/session-handles.ts'
import {
  dataFileAudit,
  dirtyDataFiles,
  ensureObjectEntries,
  invalidDataFiles,
} from '../../../../../../../src/util/json-store.ts'
import { LoginFlowManager } from '../../../../../../../src/web/store/session/login-flows.ts'
import { WebSessionStore } from '../../../../../../../src/web/store/session/session-store.ts'
import { UserStore } from '../../../../../../../src/web/store/session/user-store.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ===========================================================================
// (DATA-ENTRIES) 数据文件里的非法条目绝不能把启动带崩
//
// 真实故障(v1.13.0 定位并修复):某些历史版本/手工编辑会在数组里留下 null 或
// 非对象条目,而各 store 原先直接信任整个数组,于构造期就抛 TypeError:
//   - web-sessions.json 的 [null] → _prune() 读 s.expiresAt → 进程退出
//     (还没开始监听端口 → docker 里就是"更新镜像后起不来");
//   - login-flows.json 的 [null]  → load() 读 f.id → 同上;
//   - users.json 混入 null/非对象 → all() 读 u.username → 同上.
// 这些都是合法 JSON,语法级自检一律报 ok,所以"自检说正常,进程起不来".
// 现在口径:逐条丢弃坏条目 + 留证 + 审计区分"文件损坏"与"脏条目",绝不因此拒绝启动.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-dataentries-'))
  const write = (name, body) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    return p
  }

  // ① 纯函数:坏条目被丢弃,好条目保留,无数组时为空
  {
    const mixed = ensureObjectEntries(
      { items: [null, 1, 'x', { id: 'ok' }] },
      'items',
      (i) => Boolean(i) && typeof i === 'object' && !Array.isArray(i),
    )
    assert.equal(mixed.items.length, 1, '非法条目必须被丢弃，合法条目必须保留')
    assert.equal(mixed.dropped, 3, '丢弃数量必须如实上报')
    assert.ok(mixed.reason && /非法条目/.test(mixed.reason), '丢弃必须给出原因摘要')
    const none = ensureObjectEntries({}, 'items', () => true)
    assert.deepEqual(none.items, [], '没有该字段时按空数组处理')
    assert.equal(none.dropped, 0, '没有字段时不算丢弃')
  }

  // ② web-sessions.json:混入 null 曾让服务在监听端口之前就崩
  {
    const p = write('ws-dirty.json', {
      version: 1,
      sessions: [
        null,
        {
          token: 't1',
          username: 'a',
          createdAt: 'x',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
    })
    let store
    assert.doesNotThrow(() => { store = new WebSessionStore(p, 3600_000) }, '含 null 的 web-sessions.json 绝不能在构造期抛')
    assert.equal(store.sessions.length, 1, '合法会话必须保留（用户不该被莫名登出）')
    assert.equal(store.droppedEntries, 1, '丢弃条数必须记账')
    assert.ok(store.droppedBackup && fs.existsSync(store.droppedBackup), '被丢弃的原文必须留证（丢数据不能丢证据）')
    assert.equal(store.loadStatus, 'ok', '文件本身合法 → 状态仍是 ok，不是"损坏"')
    const rec = dataFileAudit().find((e) => e.file === path.resolve(p))
    assert.equal(rec?.droppedEntries, 1, '审计里必须能看到"脏条目"')
    assert.ok(
      dirtyDataFiles().some((e) => e.file === path.resolve(p)),
      '脏条目文件必须出现在 dirtyDataFiles()（控制台与启动日志据此区分处置办法）',
    )
    assert.ok(
      !invalidDataFiles().some((e) => e.file === path.resolve(p)),
      '"脏条目"不能报成"文件损坏"——处置办法完全不同（前者无需人工干预）',
    )
  }

  // ③ login-flows.json:混入 null 曾在 load() 里抛(同样是启动期崩溃)
  {
    const p = write('lf-dirty.json', { version: 1, flows: [null, { id: 'f1', status: 'pending', createdAt: 'x' }] })
    let mgr
    assert.doesNotThrow(() => {
      mgr = new LoginFlowManager({
        file: p,
        credentialsDir: path.join(dir, 'cred'),
        config: {},
        onCredentialSaved: null,
      })
    }, '含 null 的 login-flows.json 绝不能在构造期抛')
    mgr.shutdown()
    assert.equal(mgr.flows.size, 1, '合法登录流程必须保留')
    assert.equal(mgr.droppedEntries, 1, '丢弃条数必须记账')
    assert.doesNotThrow(() => mgr.list(), 'list() 不能在脏数据后仍抛')
  }

  // ④ users.json:混入 null 曾让 all() 在启动期抛;好用户必须留下
  {
    const p = write('users-dirty.json', {
      version: 1,
      users: [null, 'x', { username: 'admin', salt: 's', passwordHash: '00', role: 'admin', apiKey: 'k' }],
    })
    let store
    assert.doesNotThrow(() => { store = new UserStore(p) }, '含 null 的 users.json 绝不能在构造期抛')
    assert.equal(store.users.length, 1, '合法用户必须保留（否则等于账号被删）')
    assert.equal(store.loadStatus, 'ok', '还有可用用户时按 ok 处理')
    assert.equal(store.all().length, 1, 'all() 必须能在脏数据之后正常返回')
    assert.ok(store.getByUsername('admin'), '合法管理员必须可登录')
  }

  // ⑤ users 数组全部非法 = 拿不到任何登录凭据 → 必须按损坏拒绝启动,
  //    绝不能当成"还没有账号"而静默重建 admin(那会让人以为账号全丢了)
  {
    const p = write('users-allbad.json', { version: 1, users: [null, 1, 'x'] })
    const store = new UserStore(p)
    assert.equal(store.loadStatus, 'invalid', 'users 数组全非法必须报 invalid（bin/serve.ts 据此拒绝启动）')
    assert.equal(store.users.length, 0, '不得凭空造出用户')
  }

  // ④b UTF-8 BOM:Windows 记事本 / 导出工具写出的文件开头带 U+FEFF.
  //     它是无害的,但 JSON.parse 直接报 "Unexpected token '\uFEFF'" →
  //     users.json 被判"损坏" → 拒绝启动(真实用户场景).必须剥掉.
  {
    const p = path.join(dir, 'users-bom.json')
    fs.writeFileSync(
      p,
      '\uFEFF' +
        JSON.stringify({
          version: 1,
          users: [
            { username: 'admin', salt: 's', passwordHash: '00', role: 'admin', apiKey: 'k' },
          ],
        }),
    )
    const store = new UserStore(p)
    assert.equal(store.loadStatus, 'ok', '带 BOM 的 users.json 必须能正常读取（BOM 要剥掉，别当成损坏）')
    assert.equal(store.users.length, 1, '带 BOM 时用户数据必须完整')
    const sess = path.join(dir, 'ws-bom.json')
    fs.writeFileSync(sess, '\uFEFF' + JSON.stringify({ version: 1, sessions: [] }))
    assert.doesNotThrow(() => new WebSessionStore(sess, 3600_000), '带 BOM 的 web-sessions.json 不能抛')
  }

  // ⑤b 脏凭据文件必须被点名,不能静默消失(用户会以为账号丢了)
  {
    const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-creds-'))
    fs.writeFileSync(path.join(credDir, 'good.json'), JSON.stringify({
      id: 'id-1', email: 'a@b.com', authToken: 't',
    }))
    fs.writeFileSync(path.join(credDir, 'broken.json'), '{"broken": tru')
    fs.writeFileSync(path.join(credDir, 'notoken.json'), JSON.stringify({ id: 'id-2', email: 'c@d.com' }))
    // id 是 '.' → safeAccountStem 会抛;以前这个异常直接冒到启动流程把服务带崩
    fs.writeFileSync(path.join(credDir, 'badkey.json'), JSON.stringify({ id: '.', email: 'x@y.com', authToken: 't' }))
    let accounts
    assert.doesNotThrow(() => { accounts = listAccounts(credDir) }, '无法当文件名的账号 key 不能让 listAccounts 抛异常')
    assert.equal(accounts.length, 1, '只有合法凭据能进账号列表')
    assert.equal(
      invalidCredentialFiles.length,
      3,
      '脏凭据文件（含 key 非法的）必须被记账（否则控制台里账号凭空消失、无从排查）',
    )
    assert.ok(
      invalidCredentialFiles.some((p) => p.endsWith('badkey.json')),
      'key 非法的凭据也必须被点名，而不是让服务崩溃',
    )
    assert.ok(
      invalidCredentialFiles.some((p) => p.endsWith('broken.json')) &&
        invalidCredentialFiles.some((p) => p.endsWith('notoken.json')),
      '必须点名到具体文件',
    )
    fs.rmSync(credDir, { recursive: true, force: true })
  }

  // ⑥ sessions.json / account-state.json 的脏条目只能降级,不能抛
  {
    const p = write('sh-dirty.json', { version: 1, sessions: [null], orphans: [null, { key: 'a', instanceId: 'i' }] })
    let sh
    assert.doesNotThrow(() => { sh = new SessionHandleStore(p) }, '含 null 的会话句柄索引绝不能抛')
    // [控制台说一切正常,进程却起不来]的教训:脏条目必须记账(否则删 sessions.json
    // 就成了唯一出路).合法句柄要留下,坏条目要留证,文件本身仍算 ok.
    assert.equal(sh.loadStatus, 'ok', '含脏条目的 sessions.json 仍应算 ok（不是损坏）')
    assert.equal(sh.listOrphans().length, 1, '合法句柄必须保留（否则那些槽位再也回收不了）')
    assert.equal(sh.listOrphans()[0].instanceId, 'i', '保留的必须是有 key+instanceId 的那条')
    const shRec = dataFileAudit().find((e) => e.file === path.resolve(p))
    assert.equal(shRec?.droppedEntries, 2, '丢弃条数必须记账（控制台据此显示「脏条目」）')
    assert.ok(shRec?.droppedBackup && fs.existsSync(shRec.droppedBackup), '被丢弃的原文必须留证')
    assert.equal(shRec?.openHandles, 1, '待结算句柄数必须登记（控制台「系统」页据此提示）')
    assert.ok(
      !invalidDataFiles().some((e) => e.file === path.resolve(p)),
      '脏条目不能报成文件损坏（处置办法不同：前者无需人工干预）',
    )
    // 结构完全不对(sessions 不是数组)同样只是降级,不得抛
    const bad = write('sh-shape.json', { version: 1, sessions: 'oops', orphans: [] })
    assert.doesNotThrow(() => new SessionHandleStore(bad), 'sessions 字段结构不对绝不能抛')
    const ast = write('as-dirty.json', { version: 1, accounts: { a: null, b: 'x', c: { requests: 1 } } })
    const { AccountStateStore } = await import('../../../../../../../src/account-state-store.ts')
    assert.doesNotThrow(() => new AccountStateStore(ast), '含脏记录的账号账本绝不能抛')
  }

  fs.rmSync(dir, { recursive: true, force: true })
}
