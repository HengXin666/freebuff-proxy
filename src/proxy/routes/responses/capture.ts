/**
 * 合成 req/res ---- 让 Responses 面复用既有 chat 链路.
 *
 * 为什么不另写一条: 会话调度 / 账号锁 / 换号重试 / 上游形态 / 工具承载全在
 * chat 那条链上, 复制第二份必然漂移. 所以这里把 Responses 请求翻成 chat 请求体,
 * 用合成对象驱动同一个 chatHandler, 再把它写出的响应捕获回来翻译.
 *
 * 合成对象只实现 chat 链路真正触碰到的那部分 API:
 *   req   headers / method / url / socket / 可异步迭代的体 / destroyed
 *   res   setHeader / getHeader / removeHeader / writeHead / write / end /
 *         on / once / removeListener / headersSent / destroyed / destroy
 * 其余 API 不是漏实现, 而是该链路从不调用.
 */
import { Readable } from 'node:stream'

/** 捕获到的下游响应快照. */
export interface CapturedReply {
  status: number
  headers: Record<string, any>
  body: string
}

/**
 * 造一个只喂给 chatHandler 的合成请求.
 *
 * socket 复用真实请求的: 客户端断开感知 clientGoneSignal 与管道阶段的
 * socket close 监听都挂在它上面, 换成一个空对象会让断开检测整体失效.
 *
 * @param {string} bodyJson 已翻译好的 chat 请求体(JSON 文本)
 * @param {any} realReq 真实的下游请求(取 socket 与原请求头)
 * @param {string} [url] 供日志与路由用的路径
 * @returns {any} 合成的请求对象(可异步迭代)
 */
export function syntheticChatRequest(
  bodyJson: string,
  realReq: any,
  url = '/v1/chat/completions',
): any {
  const buf = Buffer.from(bodyJson, 'utf8')
  const stream: any = Readable.from([buf])
  stream.headers = {
    ...(realReq?.headers || {}),
    'content-type': 'application/json',
    'content-length': String(buf.length),
  }
  stream.method = 'POST'
  stream.url = url
  stream.socket = realReq?.socket ?? null
  stream.destroyed = false
  return stream
}

/**
 * 造一个捕获型的响应对象, 并给出取回结果的函数.
 *
 * write 恒返回 true: 上游体在这里是有限文本(官方链路经 RPC 已整体读回),
 * 没有真实背压; 返回 false 会让管道去等一个永不到来的 drain 事件.
 *
 * @returns {{ res: any, captured: () => CapturedReply }} 响应对象与结果读取器
 */
export function createCaptureResponse(): { res: any, captured: () => CapturedReply } {
  const chunks: Buffer[] = []
  let status = 200
  let headersSent = false
  const headers: Record<string, any> = {}
  const res: any = {
    statusCode: 200,
    destroyed: false,
    get headersSent() {
      return headersSent
    },
    setHeader(name: string, value: any) {
      headers[String(name).toLowerCase()] = value
    },
    getHeader(name: string) {
      return headers[String(name).toLowerCase()]
    },
    removeHeader(name: string) {
      delete headers[String(name).toLowerCase()]
    },
    writeHead(code: number, extra?: any) {
      status = code
      if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra)) headers[String(k).toLowerCase()] = v
      }
      headersSent = true
      return res
    },
    write(chunk?: any) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk?: any) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk))
      headersSent = true
      return res
    },
    destroy() {
      res.destroyed = true
      return res
    },
    on() {
      return res
    },
    once() {
      return res
    },
    removeListener() {
      return res
    },
    emit() {
      return true
    },
  }
  const captured = (): CapturedReply => ({
    status,
    headers: { ...headers },
    body: Buffer.concat(chunks).toString('utf8'),
  })
  return { res, captured }
}
