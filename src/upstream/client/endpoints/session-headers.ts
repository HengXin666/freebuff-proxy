/**
 * /session 请求的头部装配(Node 路径).
 *
 *  admission 的 x-freebuff-model 必须是目录句柄(fbm1.xxx),不是模型名.
 * 真机抓包(从零建会话)确认官方 POST /session/admission 带
 * x-freebuff-model: fbm1.AAEAAUPe2Us...(句柄).句柄只能从目录拿(服务端签名),
 * 所以 POST 前必须先抓一次目录.
 */
import { logger } from '../../../util/log.ts'
import { freebuffAuthHeaders } from '../../../auth-store.ts'
import { FREEBUFF_AVAILABLE_MODELS } from '../../../model.ts'
import { isModelHandle } from '../../catalog-protocol.ts'
import { officialSessionHeaders } from '../../fingerprint/official-fingerprint.ts'

/**
 * 把请求的模型解析成上线形态(目录句柄).
 *
 * @param {string} requested 调用方给的模型(id 或句柄)
 * @param {string | null} displayName 调用方给的显示名(可选)
 * @param {{ fetch: () => Promise<boolean>, handleForModel: Function, handles: Map<string, any> }} catalog 目录持有者
 * @returns {Promise<string>} 上线用的模型标识
 */
async function resolveModelForWire(requested: any, displayName: any, catalog: any): Promise<any> {
  if (!requested || isModelHandle(requested)) return requested
  await catalog.fetch().catch(() => false)
  // 带 displayName 兜底:静态快照的 id 与实时目录会漂移(见
  // catalog-protocol.js handleForModel 的说明).displayName 由调用方给
  // (session-manager 没有模型表的上下文),这里从内置静态表按 id 查;
  // 查不到就只走 legacyDigests 精确匹配.
  // 见 .agents/notes/implemented/bug-fix/2026-10-03-session-header-and-model-mapping.md
  const name =
    displayName ||
    (FREEBUFF_AVAILABLE_MODELS.find((m) => m?.id === requested)?.displayName ?? null)
  const resolved = catalog.handleForModel(requested, name)
  // 不用 recommendedKey 兜底: 它会把 deepseek/deepseek-v4-flash 静默映射到
  // 服务端"推荐"的 m-00032eaeec(MiMo 2.6 Flash), 于是会话绑 MiMo 而 agent
  // 是 deepseek, chat 必然 503. 映射只走 legacyDigests(FNV-1a), 已在
  // catalog.handleFor 里实现. 请求的模型不在本次目录里时就保持原值, 让上游
  // 返回它自己的判据. 摘要算法与实测命中表见
  // .agents/notes/implemented/bug-fix/2026-10-01-legacy-model-digest-mapping.md
  if (resolved === requested) {
    logger.warn('requested model not present in this catalog', {
      requested,
      catalogRows: catalog.handles.size,
    })
  }
  return resolved
}

/**
 * 装配 /session 的请求头.
 *
 * 头集合逐字对齐官方 jg():Authorization + x-fb-timezone +
 * x-freebuff-first-tab-discount,POST 另带 model / wallet-spend-limit.
 * 见 officialSessionHeaders 与
 * .agents/notes/implemented/bug-fix/2026-09-18-official-cli-fingerprint.md.
 *
 * 注意:官方 jg() 不含 x-codebuff-api-key.但本项目 token 由网页登录签发,
 * 既有实现记录[只带 Bearer 会 401],故这里额外保留该头(唯一的已知残留
 * 差异,理由与待验证项见同一篇 note).
 *
 * @param {object} ctx 出站依赖(含 token / catalog)
 * @param {'GET'|'POST'|'DELETE'} method 方法
 * @param {object} opts 会话参数
 * @returns {Promise<object>} 头部对象
 */
export async function sessionHeaders(ctx: any, method: string, opts: any): Promise<Record<string, any>> {
  const { catalog, token } = ctx
  const modelForWire = await resolveModelForWire(
    opts.model,
    opts.displayName ?? null,
    catalog,
  )
  const headers = {
    ...(officialSessionHeaders as any)(method, token, {
      model: modelForWire,
      instanceId: opts.instanceId,
      compact: opts.compact,
      walletSpendLimit: opts.walletSpendLimit,
      /**
       * 槽位被占时显式接管(官方 x-freebuff-takeover-instance-id).
       * 见 session-manager 里"槽位被占 → takeover 重试"的说明.
       */
      takeoverInstanceId: opts.takeoverInstanceId || null,
    }),
    ...freebuffAuthHeaders(token),
  }
  // 调试:FB_DEBUG_SESSION_HEADERS=1 时打印完整的 admission/session 头部.
  // 只引用确定存在的变量, 且开关默认关闭.
  if (process.env.FB_DEBUG_SESSION_HEADERS === '1') {
    logger.info('session request headers', {
      method,
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [
          k,
          /authorization|api-key/i.test(k) ? 'Bearer ***' : String(v).slice(0, 60),
        ]),
      ),
    })
  }
  return headers
}
