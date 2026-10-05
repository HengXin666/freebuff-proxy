/**
 * chat 请求的解析与校验 -- 见 parseChatRequest 的 JSDoc.
 */

import { requireModelId, isModelAllowed } from '../../model.js'
import { readRequestBody, sendJson } from '../../util/http.js'
import { catalogModelKeys, customModels, hiddenModels, blockPremiumModels } from './catalog.js'
import { bodyReadTimeoutMs } from '../config/limits.js'
import { logger } from '../../util/log.js'

/**
 * chat 请求的前置解析与校验 -- 从 src/proxy.js 搬出.
 *
 * 读体 -> 解析 JSON -> 取模型 -> 归一到上游模型 -> 白名单判定. 任何一步失败都
 * 已写出响应并返回 null, 调用方据此直接收场. 这一段 141 行, 与后面的重试状态机
 * 只通过返回值交互, 因此可以整体搬出.
 *
 * @param {object} ctx 依赖集合(config / runtimes / settingsStore / modelStore)
 * @param {import('node:http').IncomingMessage} req 下游请求
 * @param {import('node:http').ServerResponse} res 下游响应

 */
export async function parseChatRequest(ctx, req, res) {
  let rawBuf
  try {
    rawBuf = await readRequestBody(req, undefined, bodyReadTimeoutMs(ctx))
  } catch (err) {
    if (err && err.statusCode === 413) {
      sendJson(res, 413, {
        error: {
          message: 'Request body too large',
          type: 'invalid_request_error',
          code: 'body_too_large',
        },
      })
      return
    }
    // 客户端在读 body 途中断开:连接已经没了,安静收场即可.
    if (err && err.code === 'client_aborted') return
    // 408 body_read_timeout:客户端声明了体积却没发完.绝不能让它继续
    // 占着全局槽位----明确拒绝并归还名额.
    if (err && err.statusCode === 408) {
      sendJson(res, 408, {
        error: {
          message: 'Timed out reading request body',
          type: 'invalid_request_error',
          code: 'body_read_timeout',
        },
      })
      return
    }
    throw err
  }
  let body
  try {
    body = JSON.parse(rawBuf.toString('utf8') || '{}')
  } catch {
    sendJson(res, 400, {
      error: {
        message: 'Invalid JSON body',
        type: 'invalid_request_error',
        code: 'invalid_json',
      },
    })
    return
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, {
      error: {
        message: 'Body must be a JSON object',
        type: 'invalid_request_error',
      },
    })
    return
  }

  const requestedModel = requireModelId(body.model)
  if (!requestedModel) {
    sendJson(res, 400, {
      error: {
        message:
          'model is required. This proxy does not select a default model; ' +
          'pass the Freebuff model id chosen by your Agent.',
        type: 'invalid_request_error',
        code: 'model_required',
      },
    })
    return
  }
  /**
   - 先确保目录已加载,再做名称→key 归一化(2026-10-04 真实事故修正).
   *
   - resolveModelAlias() 把可读名("MiMo 2.6 Flash")落回目录 key(m-xxx)
   - 靠的是已抓到的目录(CatalogHolder.keyForName).而目录是懒加载的
   - (零自动探测,要等真正用到才抓)---- 于是冷启动后的第一个请求在归一化
   - 时目录还是空的 → 归一化失败,原样返回可读名 → 一路传到 admission 的
   - x-freebuff-model → 上游回
   - 400 {"error":"invalid_request","message":"Unknown model."}
   *
   - 实测(2026-10-04 12:15):三个账号全部 400 invalid_request,
   - 日志里 x-freebuff-model: "MiMo 2.6 Flash" ---- 本应是句柄 fbm1.xxx.
   *
   - 所以把"目录为空则先加载一次"提到归一化之前.这不算多余探测:
   - 该请求本来就必须抓目录(admission 要目录句柄),docs/reverse/20 §20.3
   - 禁的是启动/导入/首访模型表时空跑,不是请求驱动的必要前置.
   */
  if (!catalogModelKeys(ctx).length) {
    try {
      await ctx.runtimes.refreshCatalogs?.({ force: false })
    } catch {
      // 抓不到就照旧：归一化会原样返回，白名单随后拒绝（不猜模型）
    }
  }
  /**
   - /v1/models 对外给的是可读口径(catalogId,内置目录没有对应条目时是
   - displayName),所以下游照着模型表填的名字必须能落地:
   - 'Solar Pro 4' 这类显示名要落回目录 key 再走句柄映射,否则白名单会拒,
   - 会话也会绑错模型.可读 id / key / 句柄则原样通过(见 resolveModelAlias).
   */
  const upstreamModel = ctx.runtimes.resolveModelAlias(requestedModel)

  // 模型白名单校验:未隐藏 + catalog/自定义/上游会话出现过才放行.
  // 避免把"APP 里没有的模型"探测请求盲发上游(上游会标记异常行为,是免费
  // 反代被封号的主要诱因).未知模型不拦截免费用户(保守:catalog 更新有
  // 滞后,硬拒绝会误伤合法新模型),只对上游明确说"没有"的模型硬拒绝.
  //
  // 顺序很重要(性能):先用本地三张表(catalog / 前端自定义 / 隐藏)
  // 这一层纯本地:目录行 / 前端自定义 / 内置 catalog / 隐藏表.
  // 不探测,不缓存,不发上游请求(零自动探测,docs/reverse/20 §20.3).
  /**
   - 白名单必须认目录行:目录是模型清单的权威(13 行),而会话回执的
   - rateLimitsByModel 只有 6 个键.少了这一层,目录里有,但当日额度为 0
   - (或没被授予额度)的模型会被 model_not_allowed 拒掉 ---- 用户看到的就是
   - [账号额度满的,却没有任何可用模型].
   - 两个口径都收:key(m-xxx,resolveModelAlias 归一后的形态)与 displayName.
   */
  const catalogKeys = catalogModelKeys(ctx)
  let allowed = isModelAllowed(upstreamModel, {
    customModels: customModels(ctx),
    hiddenModels: hiddenModels(ctx),
    blockPremium: blockPremiumModels(ctx),
    catalogKeys,
  })
  /**
   - 目录在本函数更上方已确保加载("先加载再归一化"),所以这里的
   - catalogKeys 已经包含了目录行.若仍为空(上游抓取失败),
   - 下面的判定照旧拒绝 ---- 不猜模型.
   */
  if (!allowed) {
    logger.warn('model not allowed; rejecting before upstream', {
      model: upstreamModel,
    })
    sendJson(res, 400, {
      error: {
        message: `Model '${upstreamModel}' is not in this proxy's model list. ` +
          'Check the model id against GET /v1/models (or the web console「模型管理」). ' +
          'Unknown/retired ids are rejected to protect the account from upstream anomaly flags.',
        type: 'invalid_request_error',
        code: 'model_not_allowed',
        model: upstreamModel,
      },
    })
    return
  }
  return { body, requestedModel, upstreamModel, catalogKeys }
}
