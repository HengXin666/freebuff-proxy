/**
 * pool: 同一 runtime 的并发接管探测共享刷新, 各模型独立读取持有者.
 * 使用 runtime/session 替身与 deferred barrier, 只验证调度语义, 不访问网络.
 * 判据(可证伪): 绕过 flight 共享使刷新次数超过 1; 共享模型结果使模型 B 错误命中.
 */
import assert from 'node:assert/strict'
import { makePaidUpstreamChecker } from '../../../../../../../../src/context/sched/account-gates.ts'
import { PAID_UPSTREAM_PROBE_RETRY_MS } from '../../../../../../../../src/context/state/codes.ts'
import { configureLogger } from '../../../../../../../../src/util/log.ts'

configureLogger({ level: 'error' })

const modelA = 'model-a'
const modelB = 'model-b'
const emailByKey = new Map([['shared', 'shared@example.com']])

/**
 * 创建可手动释放的刷新屏障.
 * @returns {any} Promise 与释放函数
 */
function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/**
 * 创建刷新行为可控的 runtime 替身.
 * @param {string} mode 成功, 失败或跳过
 * @returns {any} runtime, 屏障与刷新计数
 */
function fixture(mode: 'success' | 'failure' | 'skipped') {
  let barrier = deferred()
  const counts = { attempts: 0, actual: 0, marks: 0 }
  let holder = false
  let skipping = mode === 'skipped'
  const rt = {
    paidProbeRetryAt: 0,
    paidProbeInFlight: null as Promise<boolean> | null,
    markPaidProbeDone: () => {
      counts.marks += 1
      rt.paidProbeRetryAt = Date.now() + PAID_UPSTREAM_PROBE_RETRY_MS
    },
    sessions: {
      lastProbeSkipped: false,
      holderFor: (model: string) => holder && model === modelA ? 'holder-a' : null,
      refresh: async () => {
        counts.attempts += 1
        await barrier.promise
        rt.sessions.lastProbeSkipped = skipping
        if (skipping) return
        counts.actual += 1
        if (mode === 'failure') throw new Error('fixture refresh failure')
        holder = mode === 'success'
      },
    },
  }
  return {
    rt, counts,
    get barrier() { return barrier },
    stopSkipping: () => { skipping = false; barrier = deferred() },
  }
}

/**
 * 启动十个独立 checker 并确认刷新完成前等待共享 flight.
 * @param {any} f runtime 替身
 * @returns {Promise<any>} 各请求模型与待完成的结果
 */
async function burst(f: ReturnType<typeof fixture>) {
  const models = Array.from({ length: 10 }, (_, i) => i % 2 === 0 ? modelA : modelB)
  let settled = 0
  const pending = models.map((model) => makePaidUpstreamChecker(f.rt, 'shared', model, emailByKey)()
    .then((result) => { settled += 1; return result }))
  await Promise.resolve()
  assert.equal(f.counts.attempts, 1, `阻塞时十个 checker 只应刷新一次, expected 1, got ${f.counts.attempts}`)
  assert.equal(settled, 0, `屏障释放前不得完成 checker, expected 0, got ${settled}`)
  assert.equal(f.rt.paidProbeRetryAt, 0, `刷新完成前不得开窗, expected 0, got ${f.rt.paidProbeRetryAt}`)
  assert.equal(f.counts.marks, 0, `刷新完成前不更新窗口, expected 0, got ${f.counts.marks}`)
  assert.ok(f.rt.paidProbeInFlight, `阻塞时应保留共享 Promise, got ${f.rt.paidProbeInFlight}`)
  return { models, pending }
}

/**
 * 验证真实刷新后的退避与 flight 清理.
 * @param {any} f runtime 替身
 * @returns {void} 无返回值
 */
function completed(f: ReturnType<typeof fixture>) {
  const now = Date.now()
  assert.equal(f.counts.attempts, 1, `共享刷新完成后次数应为 1, got ${f.counts.attempts}`)
  assert.equal(f.counts.actual, 1, `实际刷新次数应为 1, got ${f.counts.actual}`)
  assert.equal(f.counts.marks, 1, `实际刷新只更新一次窗口, expected 1, got ${f.counts.marks}`)
  assert.ok(f.rt.paidProbeRetryAt > now, `完成后应开未来窗口, retryAt=${f.rt.paidProbeRetryAt}, now=${now}`)
  assert.equal(f.rt.paidProbeInFlight, null, `完成后 flight 应为 null, got ${f.rt.paidProbeInFlight}`)
}

// --- (1) 成功刷新共享, 模型持有者结果独立 ---
{
  const f = fixture('success')
  const { models, pending } = await burst(f)
  f.barrier.release()
  const results = await Promise.all(pending)
  const expected = models.map((model) => model === modelA)
  assert.deepEqual(results, expected, `模型 A 应命中而 B 不命中, expected ${expected}, got ${results}`)
  completed(f)
  const known = await makePaidUpstreamChecker(f.rt, 'shared', modelA, emailByKey)()
  assert.equal(known, true, `窗口内已知 A 持有者仍应命中, expected true, got ${known}`)
  const absent = await makePaidUpstreamChecker(f.rt, 'shared', modelB, emailByKey)()
  assert.equal(absent, false, `窗口内无 B 持有者应为 false, got ${absent}`)
  assert.equal(f.counts.attempts, 1, `窗口内不得重新刷新, expected 1, got ${f.counts.attempts}`)
}

// --- (2) 失败共享, 完成后开窗且立即调用仍退避 ---
{
  const f = fixture('failure')
  const { pending } = await burst(f)
  f.barrier.release()
  const results = await Promise.all(pending)
  assert.deepEqual(results, Array(10).fill(false), `失败结果应全为 false, expected 10 false, got ${results}`)
  completed(f)
  const next = await makePaidUpstreamChecker(f.rt, 'shared', modelA, emailByKey)()
  assert.equal(next, false, `失败窗口内应返回 false, got ${next}`)
  assert.equal(f.counts.attempts, 1, `失败窗口内不得重新刷新, expected 1, got ${f.counts.attempts}`)
}

// --- (3) 跳过的共享刷新不代表实际上游访问, 清理后可立即重试 ---
{
  const f = fixture('skipped')
  const { pending } = await burst(f)
  f.barrier.release()
  const results = await Promise.all(pending)
  assert.deepEqual(results, Array(10).fill(false), `跳过且无持有者应全为 false, expected 10 false, got ${results}`)
  assert.equal(f.counts.attempts, 1, `跳过的共享刷新尝试应为 1, got ${f.counts.attempts}`)
  assert.equal(f.counts.actual, 0, `跳过不得实际刷新, expected 0, got ${f.counts.actual}`)
  assert.equal(f.counts.marks, 0, `跳过不得更新窗口, expected 0, got ${f.counts.marks}`)
  assert.equal(f.rt.paidProbeRetryAt, 0, `跳过不得开窗, expected 0, got ${f.rt.paidProbeRetryAt}`)
  assert.equal(f.rt.paidProbeInFlight, null, `跳过完成后 flight 应为 null, got ${f.rt.paidProbeInFlight}`)
  f.stopSkipping()
  const nextBurst = Array.from({ length: 10 }, () => makePaidUpstreamChecker(f.rt, 'shared', modelA, emailByKey)())
  assert.equal(f.counts.attempts, 2, `跳过结束后十个请求立即共享一次新尝试, expected 2, got ${f.counts.attempts}`)
  assert.equal(f.counts.marks, 0, `第二波刷新完成前仍不写窗口, expected 0, got ${f.counts.marks}`)
  f.barrier.release()
  const next = await Promise.all(nextBurst)
  assert.deepEqual(next, Array(10).fill(false), `实际刷新后仍无持有者应全为 false, got ${next}`)
  assert.equal(f.counts.attempts, 2, `第二波完成后总尝试次数为 2, got ${f.counts.attempts}`)
  assert.equal(f.counts.actual, 1, `跳过结束后实际刷新应为 1, got ${f.counts.actual}`)
  assert.equal(f.counts.marks, 1, `实际刷新只更新一次窗口, expected 1, got ${f.counts.marks}`)
  const now = Date.now()
  assert.ok(f.rt.paidProbeRetryAt > now, `实际刷新完成后应开未来窗口, retryAt=${f.rt.paidProbeRetryAt}, now=${now}`)
  assert.equal(f.rt.paidProbeInFlight, null, `实际刷新完成后 flight 应为 null, got ${f.rt.paidProbeInFlight}`)
  await makePaidUpstreamChecker(f.rt, 'shared', modelA, emailByKey)()
  assert.equal(f.counts.attempts, 2, `开窗后不得再刷新, expected 2, got ${f.counts.attempts}`)
}

console.log('并发接管探测共享刷新验证通过(成功, 失败, 跳过与逐模型结果)')
