/**
 * SSE 里跨分片拼装的 tool_call 的合并与参数翻译.
 *
 * 为什么单独一层: 官方链路恒为流式, 一个 tool_call 的 arguments 会被拆成多个
 * data 分片投递(线上实测: {"paths":["
 * / src/index.ts / "]} 三片). 逐行翻译时每片都不是完整 JSON, 参数翻译必然落空.
 *
 * official 通道拿到的 rpc.text 是整份响应文本(已收完), 因此可以:
 * 1. 先把同一 (choice, tool_call) 的 name 与 arguments 合并回完整调用;
 * 2. 按下游形态翻译名字与参数;
 * 3. 把结果放回首次出现该调用的那个分片, 其余分片的 arguments 清空 ----
 * 结构不变, 下游按增量拼装得到的仍是完整的, 形态正确的调用.
 *
 * 任何解析失败都原样返回整段文本: 还原是增强, 不该把成功响应变成错误.
 */
import { unmapToolCallsInBody } from '../../../upstream/foreign-client-signals.ts'

/** 一个合并后的工具调用. */
interface MergedCall {
 name: string | null
 args: string
}

/**
 * 把整份 SSE 文本里的 tool_call 合并, 翻译, 再放回首个携带它的分片.
 *
 * @param {string} text SSE 原文
 * @param {Iterable<string>|any[]} [declaredNames] 本次下游声明的工具名
 * @param {Record<string, any>} [declaredSchemas] 本次下游声明的工具 schema(名字 -> parameters)
 * @returns {string} 改写后的文本;无需改写或解析失败时返回原文
 */
export function mergeAndTranslateSseToolCalls(
 text: any,
 declaredNames?: any,
 declaredSchemas?: any,
): string {
 if (typeof text !== 'string' || !text || !text.includes('data: ')) return text
 const lines = text.split('\n')
 /** key: choiceIndex:toolCallIndex */
 const merged = new Map<string, MergedCall>()
 const parsed: (any | null)[] = []
 for (const line of lines) {
 if (!line.startsWith('data: ')) {
 parsed.push(null)
 continue
 }
 const payload = line.slice(6).trim()
 if (!payload || payload === '[DONE]') {
 parsed.push(null)
 continue
 }
 let obj: any
 try {
 obj = JSON.parse(payload)
 } catch {
 parsed.push(null)
 continue
 }
 parsed.push(obj)
 collectCalls(obj, merged)
 }
 if (merged.size === 0) return text
 // 合并后的完整调用先按下游形态翻译(复用 unmapToolCallsInBody 的名字与参数规则).
 const translated = new Map<string, MergedCall>()
 for (const [key, call] of merged) {
 translated.set(key, translateOne(call, declaredNames, declaredSchemas))
 }
 if (![...translated.values()].some((c) => c.name)) return text
 /** 已经输出过完整参数的分片 key(后续分片的 arguments 清空). */
 const emitted = new Set<string>()
 const out = lines.map((line, i) => {
 const obj = parsed[i]
 if (!obj) return line
 let changed = false
 for (const holder of [obj?.choices]) {
 if (!Array.isArray(holder)) continue
 for (let ci = 0; ci < holder.length; ci++) {
 for (const slot of ['message', 'delta']) {
 const calls = holder[ci]?.[slot]?.tool_calls
 if (!Array.isArray(calls)) continue
 for (let ti = 0; ti < calls.length; ti++) {
 const fn = calls[ti]?.function
 if (!fn) continue
 const key = `${ci}:${calls[ti]?.index ?? ti}`
 const final = translated.get(key)
 if (!final) continue
 if (fn.name) {
 fn.name = final.name ?? fn.name
 if (!emitted.has(key)) {
 fn.arguments = final.args
 emitted.add(key)
 }
 changed = true
 } else if (typeof fn.arguments === 'string' && emitted.has(key)) {
 fn.arguments = ''
 changed = true
 }
 }
 }
 }
 }
 if (!changed) return line
 return 'data: ' + JSON.stringify(obj)
 })
 return out.join('\n')
}

/**
 * 收集一个分片里的 tool_call(name 与 arguments 分片累积).
 *
 * @param {any} obj 解析后的分片
 * @param {Map<string, MergedCall>} merged 累积表
 * @returns {void} 无返回值
 */
function collectCalls(obj: any, merged: Map<string, MergedCall>): void {
 const choices = Array.isArray(obj?.choices) ? obj.choices : []
 for (let ci = 0; ci < choices.length; ci++) {
 for (const slot of ['message', 'delta']) {
 const calls = choices[ci]?.[slot]?.tool_calls
 if (!Array.isArray(calls)) continue
 for (let ti = 0; ti < calls.length; ti++) {
 const fn = calls[ti]?.function
 if (!fn) continue
 const key = `${ci}:${calls[ti]?.index ?? ti}`
 const cur = merged.get(key) || { name: null, args: '' }
 if (typeof fn.name === 'string' && fn.name) cur.name = fn.name
 if (typeof fn.arguments === 'string') cur.args += fn.arguments
 merged.set(key, cur)
 }
 }
 }
}

/**
 * 翻译单个合并后的调用(名字 + 参数).
 *
 * 复用 unmapToolCallsInBody: 它已实现[本次声明]过滤与参数形态翻译.
 *
 * @param {MergedCall} call 合并后的调用
 * @param {any} declaredNames 本次下游声明的工具名
 * @param {any} declaredSchemas 本次下游声明的工具 schema
 * @returns {MergedCall} 翻译后的调用
 */
function translateOne(call: MergedCall, declaredNames: any, declaredSchemas: any): MergedCall {
 if (!call.name) return call
 const probe = {
 choices: [
 { message: { tool_calls: [{ function: { name: call.name, arguments: call.args } }] } },
 ],
 }
 try {
 unmapToolCallsInBody(probe, declaredNames, declaredSchemas)
 const fn = probe.choices[0].message.tool_calls[0].function
 return { name: fn.name, args: fn.arguments }
 } catch {
 return call
 }
}
