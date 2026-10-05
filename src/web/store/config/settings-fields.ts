/**
 * 运行设置(实时字段)的字段声明与校验.
 *
 * ## 为什么单独成文件
 *
 * SettingsStore.save() 原先是一段 ~100 行的 if 链: 每个字段都写三遍
 * (判 undefined / 判类型 / 赋值). 新增一个字段要改三处, 而**漏掉"判 undefined"
 * 那一遍**的后果最隐蔽 ---- 它会变成"没传这个字段也被当成要清零", 于是
 * 保存任一设置都会把其它设置抹掉.
 *
 * 收成"声明表 + 一次遍历"之后: 新增字段只加一行声明, 三处判据都从声明派生,
 * 结构上不可能只改两处.
 *
 * 与 src/config/tunables.ts 的分工:
 *   - 本文件 = 实时字段(裸名, 保存即生效, 有默认值);
 *   - tunables.ts = 可调项(点分路径, 保存后重启生效, 无默认值).
 * 两套东西分开的理由见 ../tunables-store.ts 的文档注释.
 */

/** 字段规格: key -> 取值器(返回 null 表示合法). */
export interface LiveFieldSpec {
  /** 归一化/校验; 合法则返回归一后的值, 非法则返回错误文案. */
  normalize: (v: unknown) => { ok: true; value: any } | { ok: false; message: string }
}

const ok = (value: any) => ({ ok: true as const, value })
const err = (message: string) => ({ ok: false as const, message })

  /**
   * 并发上限:1..16,防止误配造成上游顶号.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampConcurrency(n: number): number {
  return Math.min(16, Math.max(1, n))
}

  /**
   * 溢出前排队上限: 0(不等待)或 1s..10min.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampOverflowWait(n: number): number {
  if (n <= 0) return 0
  return Math.min(600_000, Math.max(1_000, n))
}

  /**
   * 低额度分组阈值: 0(关闭)或 1..10000 FB.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampLowBalance(n: number): number {
  if (n <= 0) return 0
  return Math.min(10_000, Math.max(1, n))
}

  /**
   * 空闲释放: 0(关闭)或 5s..24h.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampIdleReleaseSec(n: number): number {
  if (n <= 0) return 0
  return Math.min(86_400, Math.max(5, n))
}

  /**
   * 单请求新会话预算: 0(不限制)或 1..16.
   * @param {number} n 原始值
   * @returns {number} 夹取后的值
   */
export function clampNewSessions(n: number): number {
  if (n <= 0) return 0
  return Math.min(16, Math.max(1, n))
}

/** 布尔字段的规格. */
const bool = (): LiveFieldSpec => ({
  normalize: (v) => (typeof v === 'boolean' ? ok(v) : err('必须是布尔值')),
})

/** 整数 + 夹取字段的规格. */
const intClamped = (clamp: (n: number) => number, min: number): LiveFieldSpec => ({
  normalize: (v) =>
    Number.isInteger(v) && (v as number) >= min ? ok(clamp(v as number)) : err(`必须是 >= ${min} 的整数`),
})

/** 枚举字段的规格. */
const oneOf = (values: string[]): LiveFieldSpec => ({
  normalize: (v) => (values.includes(v as string) ? ok(v) : err(`必须是 ${values.join(' / ')} 之一`)),
})

/**
 * 实时字段表(与 Settings 接口一一对应).
 *
 * 校验失败时抛 TypeError(保持与旧实现一致: 调用方按异常处理), 文案逐字沿用
 * 旧实现, 因此既有测试与前端提示不受影响.
 */
export const LIVE_FIELDS: Record<string, LiveFieldSpec> = {
  freeToolSignatureEnabled: bool(),
  stripToolsOnSchemaRejection: bool(),
  cliTelemetryEnabled: bool(),
  blockPremiumModels: bool(),
  accountMaxConcurrency: intClamped(clampConcurrency, 1),
  accountOverflowWaitMs: intClamped(clampOverflowWait, 0),
  lowBalanceThreshold: intClamped(clampLowBalance, 0),
  idleReleaseSec: intClamped(clampIdleReleaseSec, 0),
  maxNewSessionsPerRequest: intClamped(clampNewSessions, 0),
  upstreamChannel: oneOf(['official', 'legacy']),
  accountSchedulingMode: oneOf(['sticky', 'spread']),
}
