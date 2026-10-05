/**
 * billing: 已被证伪的说法清扫
 *
 * 早退 DELETE 会按实际占用退还 Freebucks, 旧说法必须从文档里清掉.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { readBinSource, readDashboardSource } from '../../../harness/helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// (REFUND-COPY) 计费口径清扫: 全仓不得再出现"早退会退还 Freebucks"这一类说法.
//
// 上游一次 admit = 买断一小时: POST 当场扣满整小时单价(Freebucks 5 -> 0, 回执带 expiresAt).
// 早退 DELETE 的实际结果两本账不对称:
//   - session_units: 当场按比例退(1.1 -> 0.2)
//   - Freebucks: 只回 freebucksRefundPending, 3 次重放 DELETE 后 2 分钟内未到账;
//     而 24 个[账号 × 模型]组合里 22 个是 Freebucks 先见底
// 故"早退会退还 Freebucks / 挂着空闲会话才花钱"属于已被证伪的说法.
// 详见 docs/design/freebucks-strategy.html 与 docs/design/account-scheduling-and-refund.md §3.
{
  const dashSrc = readDashboardSource()
  // DEFAULTS 已随 config.js 拆分搬进 config/defaults.ts(config.js 只剩薄门面
  // re-export),且实现已转 TS.断言必须指向真正持有默认值的那一层.
  const cfgSrc = fs.readFileSync(
    new URL('../../../../../../../src/config/defaults.ts', import.meta.url),
    'utf8',
  )
  // 控制台样式已按加载阶段拆成 dashboard/css/*.css(见
  // .agents/notes/implemented/architecture/2026-10-05-dashboard-split-locale-and-css.md).
  // 读整个 dashboard/css/ 目录并拼接: 断言只关心"某条样式规则存在",
  // 与它落在哪个文件无关.
  const cssDir = new URL('../../../../../../../dashboard/css/', import.meta.url)
  const cssSrc = fs
    .readdirSync(cssDir)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => fs.readFileSync(new URL(f, cssDir), 'utf8'))
    .join('\n')
  const settingsSrc = fs.readFileSync(
    new URL('../../../../../../../src/web/store/config/settings-store.ts', import.meta.url),
    'utf8',
  )
  // 扫描面 = 整个仓库(排除第三方与运行时数据), 包括 README / CLI 输出等直接给用户看的文本.
  // 钉死的是"早退能拿回 Freebucks / 挂着空闲才花钱 / 越早释放越省"这一类说法
  // (早退 DELETE 只回 freebuffRefundPending, 见文档 §3.7).
  const STALE_COPY =
    /按实际占用退还\s*Freebucks|退还未用时长|退还未用部分|停止为空转时长付费|挂着的空闲会话(在按小时计价|才是花钱)|越早释放越省|早退.{0,12}省钱/
  const SKIP_DIR = new Set(['node_modules', '.git', 'data', 'data-test'])
  const walk = (dir, out = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!SKIP_DIR.has(ent.name)) walk(path.join(dir, ent.name), out)
      } else if (/\.(js|mjs|cjs|md|ya?ml|json)$/.test(ent.name)) {
        out.push(path.join(dir, ent.name))
      }
    }
    return out
  }
  // 仓库根: 本入口在 test/suites/entries/smoke/, 所以要上跳 4 层.
  // (下界断言 scanned.length > 20 会抓住这种"扫描面塌缩" -- 上一版这里
  // 写成 '..' 时只扫到 6 个文件, 断言立刻红了, 没有静默全绿.)
  const root = new URL('../../../../../../..', import.meta.url).pathname
  const scanned = walk(root).filter((p) => !p.includes('/test/repro-'))
  assert.ok(scanned.length > 20, `全仓扫描应覆盖足够多文件，实际 ${scanned.length}`)
  for (const abs of scanned) {
    const rel = path.relative(root, abs)
    // 本文档(§3/§7)需要引用这些旧说法来解释纠错过程,豁免;
    // smoke 自身含正则字面量,也豁免(它就是这个守卫).
    if (rel === 'docs/design/account-scheduling-and-refund.md') continue
    // 按本文件自己的路径自我豁免(不写死字符串): 本文件注释里要说明"钉死了哪些说法".
    if (abs === fileURLToPath(import.meta.url)) continue
    // Agent Notes 需要引用这些说法来说明纠错过程, 豁免.
    if (rel.startsWith('.agents/notes/')) continue
    // docs/quality/docs-audit.md 是审计产物, 其写法就是"把错误说法原样引出来再说明它错在哪".
    // 与 check-docs.ts 不扫该目录同源: 参与判据会自噬.
    if (rel.startsWith('docs/quality/docs-audit')) continue
    // AGENTS.md 是最高优先级约定, 必须一起扫.
    // CLAUDE.md 是指向它的符号链接, 跳过(同一内容不报两次).
    if (rel === 'CLAUDE.md') continue
    const src = fs.readFileSync(abs, 'utf8')
    // 归一后再匹配: 去掉强调标记与反引号, 使"词被行内格式切开"不构成绕过.
    const normalized = src.replace(/\*\*/g, '').replace(/`/g, '')
    const hit = normalized.match(STALE_COPY)
    assert.ok(
      !hit,
      `${rel} 出现了已被证伪的说法「${hit && hit[0]}」` +
        `(早退 DELETE **会**按实际占用退还 Freebucks；pending = 结算未完成，` +
        `见 docs/design/account-scheduling-and-refund.md §3)`,
    )
  }
  /**
   * idleReleaseSec 的默认值必须是 60s(付费时段结束后的空闲释放).
   *
   * 真源 = src/config/defaults.ts 的 DEFAULTS(config.yaml 只留 server.host/port).
   * 这里读 DEFAULTS 的实际值: 默认值被改成别的数字时本断言立刻变红.
   */
  const { DEFAULTS } = await import('../../../../../../../src/config/defaults.ts')
  assert.equal(
    DEFAULTS.session.idleReleaseSec,
    60,
    'DEFAULTS.session.idleReleaseSec 默认应为 60s(付费时段结束后的空闲释放)',
  )
  /**
   * 并且它必须前端可调(满足"除 host/port 外全部前端可调"这条约定).
   *
   * 它走的是实时通道: 保存在 settings.json 的裸名键 idleReleaseSec 上, 由
   * /api/settings 的实时字段直接读写, 保存即生效. 因此判据查的是"实时字段
   * 或可调项表里有任一个管它".
   */
  const { TUNABLES } = await import('../../../../../../../src/config/tunable/specs.ts')
  const { LIVE_FIELDS } = await import(
    '../../../../../../../src/web/store/config/settings-fields.ts'
  )
  const covered =
    TUNABLES.some((t: any) => t.path === 'session.idleReleaseSec') ||
    Object.prototype.hasOwnProperty.call(LIVE_FIELDS, 'idleReleaseSec')
  assert.ok(covered, 'session.idleReleaseSec 必须前端可调(实时字段或可调项二者其一)')
  // 退款追问是常驻行为: pending 期间靠重放 DELETE 取回执, 但句柄不能丢.
  // (pending 在本小时内不落地, 不能据此判断释放时机.)
  const handlesSrc = fs.readFileSync(
    new URL('../../../../../../../src/session-handles.ts', import.meta.url),
    'utf8',
  )
  assert.ok(
    /async sweepPendingRefunds/.test(handlesSrc),
    '会话句柄库必须提供 sweepPendingRefunds(周期性追问待结算退款)',
  )
  /**
   * 判据: 入口必须周期性调用 sweepPendingRefunds(只扫一次 = 放弃那笔预扣).
   *
   * 扫描面是整棵 bin/: 钉死单文件的断言在入口按职责拆分后读不到那段代码,
   * 正则不匹配会静默通过. 扫目录 + 校验被扫文件数下限(见 ./dashboard-source.ts 同款判据).
   */
  const binSrc = readBinSource()
  assert.ok(
    /sweepPendingRefunds/.test(binSrc) && /setInterval/.test(binSrc),
    'bin/ 必须周期性调用 sweepPendingRefunds--只扫一次等于放弃那笔预扣',
  )
  // 控制台必须给出推荐值(按账号池实时算)
  assert.ok(
    /function idleReleaseAdvice/.test(dashSrc),
    '控制台必须提供 idleReleaseAdvice(按账号池实时算推荐值)',
  )
  // (REUSE-UI) [我们在省钱]必须能一眼看到:全局复用率 + 每账号 admit/reuse 计数.
  // 复用发生在已买断的一小时内 -> 边际成本 0,所以复用率就是省掉的重买比例.
  {
    const src = readDashboardSource()
    assert.ok(
      /会话复用率/.test(src),
      '总览必须有「会话复用率」卡片(让用户直观看到在省钱)',
    )
    assert.ok(
      /a\.admitCount/.test(src) && /a\.reuseCount/.test(src),
      '账号行必须显示 admitCount / reuseCount(买过几条 · 复用几次)',
    )
    // ensureSession 的热路径已随拆分搬进 src/session/admit/ensure.ts
    // (同上: 薄门面里没有这段代码, 必须指向真正的实现层).
    const mgrSrc = fs.readFileSync(
      new URL('../../../../../../../src/session/admit/ensure.ts', import.meta.url),
      'utf8',
    )
    assert.ok(
      /this\.reuseCount \+= 1/.test(mgrSrc),
      'ensureSession 的热路径必须累加 reuseCount',
    )
  }

  // (PAID-HOUR-UI) 付费时段内 rem=0 是"已付款"的正常状态,绝不能标成[额度不足].
  // 少了这条,"买断一小时"上线后每个正在被正常使用的账号都会显示成耗尽.
  {
    const src = readDashboardSource()
    assert.ok(
      /inPaidWindow/.test(src),
      'classifyAccount 必须用付费时段(inPaidWindow)把 rem=0 的已付款账号判为可用',
    )
    assert.ok(
      /if \(fb && !inPaidWindow\)/.test(src),
      'Freebucks 耗尽判定必须在付费时段之外才生效',
    )
    // 付费时段依据 expiresAt 必须真的传到前端, 该字段是判定成立的前提.
    // 装配点在 src/context/ops/account-list.ts(app-context 只剩门面).
    const ctxSrc = fs.readFileSync(
      new URL('../../../../../../../src/context/ops/account-list.ts', import.meta.url),
      'utf8',
    )
    assert.ok(
      /expiresAt: snap\.expiresAt/.test(ctxSrc),
      '账号快照必须把 session.expiresAt 暴露给控制台(付费时段判定的依据)',
    )
  }
  assert.ok(
    /idle-release-advice/.test(dashSrc),
    '控制台必须渲染推荐值区块',
  )

  // (LOW-BALANCE-GROUP) 用户自定义[低额度]分组:余额低于阈值就归类过去,
  // 但仍然参与调度--它是预警不是故障.默认 15 FB(≈ deepseek-v4-flash 单价).
  assert.ok(
    /id: 'lowbalance'/.test(dashSrc),
    "控制台必须有 'lowbalance' 分组",
  )
  assert.ok(
    /function lowBalanceHit/.test(dashSrc),
    '低额度分组必须有 lowBalanceHit 判定',
  )
  // 归到[低额度]之后仍照常参与选号:该判定绝不能出现在后端调度路径里
  /**
   * 判据: 这三处不得出现 lowBalanceThreshold(低额度只是前端分组, 不参与调度).
   *
   * 路径必须解析到真实的 src/: 旧写法 new URL('../../../../' + rel) 是从
   * 本文件所在层级上跳, 而本文件搬进 parts/billing/source/ 之后该相对路径落到了
   * 不存在的 test/suites/entries/src/... ---- 于是 readFileSync 抛错被 catch 吞掉,
   * 三条断言静默失效(读不到文件 = 永远不红, 平时假绿). 这是本仓出现过多次的
   * 失效形态, 所以这里改成: 读不到就 assert.fail, 不许静默跳过.
   */
  for (const rel of ['src/proxy.ts', 'src/app-context.ts', 'src/session-manager.ts']) {
    const abs = new URL('../../../../../../../' + rel, import.meta.url)
    let src = ''
    try {
      src = fs.readFileSync(abs, 'utf8')
    } catch (err) {
      assert.fail(`${rel} 读不到(路径解析错了, 判据会静默失效): ${abs.pathname}`)
    }
    assert.ok(
      !/lowBalanceThreshold|lowbalance/.test(src),
      rel + ' 不得读取 lowBalanceThreshold：低额度只是前端分组，不能影响调度',
    )
  }
  assert.ok(
    /lowBalanceThreshold: 15/.test(settingsSrc),
    'settings-store 的 lowBalanceThreshold 默认应为 15',
  )
  // (WIDE-LAYOUT) 账号表 10 列,容器过窄会把[时间轴]挤成竖排单字
  assert.ok(
    /max-width: 1560px/.test(cssSrc),
    '#app 容器应放宽到 1560px(账号表列多)',
  )
  assert.ok(
    /\.acct-time/.test(cssSrc),
    '时间轴单元格需要 .acct-time 样式(禁止被压成竖排单字)',
  )
  assert.ok(
    /acct-time/.test(dashSrc),
    'accountTimeCell 必须使用 .acct-time 类',
  )
  // 推荐值是[按账号池实时算]的,所以设置页必须真的把账号拉进来.
  // /api/proxy 只回代理信息,不含 session.model -- 曾因此让推荐值恒等于默认值
  // (永远显示"还没有账号"),点进去看到的建议是假的.这里钉死这个数据依赖.
  assert.ok(
    /async function renderProxySettings[\s\S]{0,900}api\('\/api\/overview'\)/.test(dashSrc),
    'renderProxySettings 必须额外拉 /api/overview 填充 state.accounts(推荐值依赖它)',
  )
}
