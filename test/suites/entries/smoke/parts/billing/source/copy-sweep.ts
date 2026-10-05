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

// (REFUND-COPY) 计费结论(2026-09-14 一手实测后重钉)不得被写回旧说法
//
// 上游 一次 admit = 买断一小时:POST 当场扣满整小时单价(实测 Freebucks
// 5 -> 0,回执带 expiresAt).早退 DELETE 的实际结果两本账不对称:
//   - session_units:当场按比例退(实测 1.1 -> 0.2)
//   - Freebucks:只回 freebucksRefundPending,实测 3 次重放 DELETE,2 分钟
//     内未到账;而 24 个[账号 × 模型]组合里 22 个是 Freebucks 先见底
// 所以"早退会退还 Freebucks / 挂着空闲会话才花钱"是已被证伪的说法,必须
// 钉死:用户会照着它去调 idle_release_sec,方向正好是反的.
// 详见 docs/design/freebucks-strategy.html 与 docs/design/account-scheduling-and-refund.md §3.
{
  const dashSrc = readDashboardSource()
  // DEFAULTS 已随 config.js 拆分搬进 config/defaults.ts(config.js 只剩薄门面
  // re-export),且实现已转 TS.断言必须指向真正持有默认值的那一层.
  const cfgSrc = fs.readFileSync(
    new URL('../../../../../../../src/config/defaults.ts', import.meta.url),
    'utf8',
  )
  const yamlSrc = fs.readFileSync(
    new URL('../../../../../../../config.example.yaml', import.meta.url),
    'utf8',
  )
  // 控制台样式已按加载阶段拆成 dashboard/css/*.css(见
  // .agents/notes/implemented/architecture/2026-10-05-dashboard-split-locale-and-css.md).
  // 这里读整个目录并拼接, 而不是钉死单文件: 断言要检查的是"某条样式规则
  // 存在", 与它落在哪个文件无关; 钉死路径会让下一次拆分再次把这条断言打红.
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
  // 覆盖整个仓库:一开始只扫了 3 个文件,结果 README / bin/pricing.ts /
  // docs/guide/deployment.md / proxy.js 等 10+ 处漏网--其中 README 与 CLI 输出
  // 直接给用户看,错了最误导.改为遍历全仓(排除第三方与运行时数据).
  // 2026-09-13 的说法已被 09-14 一手实测推翻:早退 DELETE 不退 Freebucks
  // (只回 freebuffRefundPending;文档 §3.7)
  // 现在钉死的是"不退"这一类已被证伪的说法,防止它再被写回来.
  // 钉死的是已被证伪的那一类说法:早退能拿回 Freebucks / 挂着空闲才花钱 /
  // 越早释放越省.它们和实测(买断一小时,早退拿不回)正好相反.
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
    // 按本文件自己的路径自我豁免, 而不是写死一个字符串:
    // 写死时搬走文件(本轮 test/smoke.mjs -> test/suites/entries/smoke/smoke.ts)
    // 会让豁免失效, 守卫开始扫自己注释里"钉死了哪些说法"的说明 -> 自我命中.
    if (abs === fileURLToPath(import.meta.url)) continue
    // Agent Notes 记录的是历史决策与它的错在哪(本次反转正需要引用旧说法),豁免.
    if (rel.startsWith('.agents/notes/')) continue
    // docs/quality/docs-audit.md 是审计产物,它的写法就是"把错误说法原样引出来
    // 再说明它错在哪"(实测:docs-audit.md 写 错误方向是"早退能省钱").
    // 与 check-docs.ts 不扫该目录同源理由:参与判据会自噬.
    if (rel.startsWith('docs/quality/docs-audit')) continue
    // AGENTS.md 是最高优先级约定,必须一起扫:它一旦写着旧口径,后来的人会直接照着做.
    // CLAUDE.md 只是指向它的符号链接,跳过以免同一内容报两次.
    if (rel === 'CLAUDE.md') continue
    const src = fs.readFileSync(abs, 'utf8')
    // 归一后再匹配:这条守卫此前能被行内格式整体绕过 -- 实测
    // src/session-handles.ts 写的 退还未用部分 因  把词切开而匹配不上,
    // 而它本来就是被证伪的口径;同一 commit 引入的守卫因此空转了 20 天.
    // 去掉强调标记与反引号,让"词被格式化切开"不再是一种绕过手段.
    const normalized = src.replace(/\*\*/g, '').replace(/`/g, '')
    const hit = normalized.match(STALE_COPY)
    assert.ok(
      !hit,
      `${rel} 出现了已被证伪的说法「${hit && hit[0]}」` +
        `(早退 DELETE **会**按实际占用退还 Freebucks；pending = 结算未完成，` +
        `见 docs/design/account-scheduling-and-refund.md §3)`,
    )
  }
  // idleReleaseSec 现在是付费时段结束之后的空闲释放时长(付费时段内一律不释放,
  // 见 session-manager._armIdleRelease).保持 60s:过期后尽快腾槽位给别的模型.
  assert.ok(
    /idleReleaseSec:\s*60/.test(cfgSrc),
    'config.js 的 idleReleaseSec 默认应为 60s(付费时段结束后的空闲释放)',
  )
  assert.ok(
    /idle_release_sec:\s*60/.test(yamlSrc),
    'config.example.yaml 的 idle_release_sec 默认应为 60s',
  )
  // 退款追问仍是常驻行为:pending 期间要靠重放 DELETE 取回执.实测确认
  // pending 在本小时内不落地(所以不能把它当成"钱会回来"来决策释放时机),
  // 但句柄不能丢--丢了连追问的机会都没有.
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
   * 扫描面是整棵 bin/ 而不是 bin/serve.ts: 该判据经历过一次搬家 --
   * 入口按职责拆进 bin/serve/boot/ 之后, 钉死单文件的断言会读不到那段代码,
   * 正则不匹配 -> 它只在被破坏时才红, 平时是假绿(控制台那条判据踩过同样的坑,
   * 见 ./dashboard-source.ts 的说明). 扫目录 + 校验被扫文件数下限既保住判据强度,
   * 又不会因为下一次搬家再次失效.
   */
  const binSrc = readBinSource()
  assert.ok(
    /sweepPendingRefunds/.test(binSrc) && /setInterval/.test(binSrc),
    'bin/ 必须周期性调用 sweepPendingRefunds--只扫一次等于放弃那笔预扣',
  )
  // 控制台必须给出"推荐值"(按账号池实时算),而不是让用户猜
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
    // 付费时段依据 expiresAt 必须真的传到前端,否则上面的判定永远不成立
    // expiresAt 的装配已随 app-context 拆分搬进 src/context/ops/account-list.ts
    // (app-context.js 只剩门面)-- 断言必须指向真正持有快照字段的那一层.
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
