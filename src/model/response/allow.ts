/**
 * 代理"可调度"白名单判据.
 *
 * 它是 /v1/chat/completions 的准入闸门(任何不在白名单的模型 id 一律 400 拒绝).
 * 依赖方向: ../catalog-store + ../flags 单向.
 */
import { catalogModels } from '../catalog-store.ts'
import { isPremiumModel } from '../flags.ts'

/**
 * 模型是否在代理"可调度"白名单内(未隐藏 + 已知模型/自定义/上游会话出现过).
 *
 * 用于 /v1/chat/completions 的 model 字段校验:任何不在白名单的模型 id
 * 一律 400 拒绝,绝不盲发上游 -- 避免把"APP 里没有的模型"探测请求打到
 * Freebuff(上游会把这些当异常行为标记账号,这正是免费反代被封号的主要诱因).
 *
 * 白名单 = 内置 catalog(未隐藏) + 自定义模型(未隐藏) + 上游会话实际出现过的
 * id + 顶层 model 字段(session 当前模型) + 目录行(模型清单的权威).
 *
 * @param {string} modelId 模型 id
 * @param {{
 * customModels?: { id: string }[],
 * hiddenModels?: string[],
 * sessionModelIds?: string[],
 * sessionModel?: string | null,
 * blockPremium?: boolean,
 * catalogKeys?: string[],
 * }} [opts] 判定选项
 * @returns {boolean} true 表示允许调度
 */
export function isModelAllowed(modelId: string, opts: Record<string, any> = {}): boolean {
  if (!modelId || typeof modelId !== 'string') return false
  const hidden = new Set(opts.hiddenModels || [])
  if (hidden.has(modelId)) return false
  // 一键屏蔽收费模型:premium 模型直接拒用(不盲发上游,避免风控).
  if (opts.blockPremium && isPremiumModel(modelId)) return false

  // 1) 内置 catalog(未隐藏) -- 含 WITHDRAWN 标记的退役模型也放行:
  //    退役标记只是提示,直接拒绝会误伤仍在用旧对话/存量 session 的用户;
  //    上游会话探测若确认没有,会走第 3 层兜底拒绝.
  if ((catalogModels() as any[]).some((m: any) => m.id === modelId)) return true
  // 2) 前端自定义(未隐藏)
  if ((opts.customModels || []).some((m: any) => m && m.id === modelId)) return true
  // 3) 上游会话实际出现过(rateLimitsByModel / limitedModelOffers / 当前 model)
  const seen = new Set(opts.sessionModelIds || [])
  if (opts.sessionModel) seen.add(opts.sessionModel)
  if (seen.has(modelId)) return true
  /**
   * 4) 目录行(模型清单的权威).
   *
   * 顺序必须在这里:目录有 13 行,而 rateLimits(第 3 层)只有 6 个键.
   * 少了这一层,目录里的模型(尤其当日额度为 0 或没被授予额度的)会被
   * model_not_allowed 拒掉 -- 正是"远程请求模型返回没有任何可用模型".
   *
   * 匹配两个口径:key(m-096e75164d,resolveModelAlias 归一后的形态)与
   * displayName(可读名,前端同步后写进自定义的那种).
   */
  const keys = opts.catalogKeys
  if (keys) {
    for (const k of keys) {
      if (k === modelId) return true
    }
  }
  return false
}
