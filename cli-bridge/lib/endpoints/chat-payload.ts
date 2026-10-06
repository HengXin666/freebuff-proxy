/**
 - chat 请求体的各段构造 -- 从 cli-bridge/upstream.ts 的 Bridge.chat 按职责切出.
 - 纯函数(不碰 this), 除 buildMetadata 需要 bridge 取 run 状态与项目目录.
 */
import { collectRepoSnapshot } from '../snapshot.ts'
import { applyPlaceholders, renderManagerSystem, renderWorkerSystem } from '../system.ts'
import { MAP_TOOLS, mergeOfficialTools } from '../tool-map.ts'

/**
 - 按层选官方工具集并合并客户端工具(下行映射见 tool-map).
 - @param {string} layer worker / manager
 - @param {any[]} tools 客户端工具
 - @param {any[]} officialTools 官方工具集
 - @param {any[]|null} officialDecide manager 层 decide
 - @param {string[]|undefined} injectNames 只注入这些官方工具名; undefined = 不裁剪
 - @returns {any[]} 出站工具数组
 */
export function buildTools(layer, tools, officialTools, officialDecide, injectNames) {
  let outTools = tools || [];
  // 控制台配置过名单时只注入名单内的官方工具.
  //
  // 过滤放在合并之前: 被剔掉的官方工具不该参与去重, 否则下游声明的同名工具
  // 会因为它占着 seen 而被丢掉(名字在, 工具却从两边一起消失).
  const picked = Array.isArray(injectNames)
    ? (Array.isArray(officialTools) ? officialTools : []).filter(
        (t) => injectNames.includes(t?.function?.name),
      )
    : officialTools;
  if (layer === 'manager' && officialDecide?.length) {
    outTools = mergeOfficialTools(officialDecide, tools);
  } else if (layer === 'worker' && picked.length > 0) {
    outTools = mergeOfficialTools(picked, tools);
  }
/**
 * 观测:把"哪些客户端工具被改名,哪些保持原名"记一条.
 *
 */
{
  const renamed = [];
  const kept = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    const n = t?.function?.name;
    if (!n) continue;
    if (MAP_TOOLS[n]) renamed.push(`${n}→${MAP_TOOLS[n]}`)
    else kept.push(n)
  }
  if (renamed.length || kept.length) {
    console.error(
      `[tool-map] renamed ${renamed.length}: ${renamed.join(', ')}`
        + ` | kept-as-is ${kept.length}: ${kept.slice(0, 12).join(', ')}`
        + `${kept.length > 12 ? ' …' : ''}`,
    )
  }
}
  return outTools;
}

/**
 - 渲染官方 system 模板并置于消息首位(客户端 system 不再覆盖它).
 - @param {any[]} messages 客户端消息
 - @param {string} layer worker / manager
 - @param {any} officialSys 官方 system 模板集
 - @param {any} [systemPrompt] 控制台配置的官方 system 处置(undefined=照抄官方)
 - @returns {any[]} 出站消息数组
 */
export function buildSystemMessages(messages, layer, officialSys, systemPrompt) {
  const sysTpl = officialSys?.[layer] || officialSys?.worker;

// system:官方模板渲染后置于首位(客户端消息里的 system 不再覆盖它)
const rest = (messages || []).filter((m) => m && m.role !== 'system');
const userText = (rest.find((m) => m.role === 'user')?.content) ?? '';
/**
 * 三态由控制台配置决定(见 Node 侧 settings-store 的 officialSystemPromptMode):
 *   - undefined : 照抄官方抓包模板(默认, 零回归);
 *   - 'custom'  : 整段用自定义正文, 不做动态区块填充 ---- 用户贴的文本里
 *                 不会有 <repository_stats> 这类占位符, 替换只会是空操作;
 *   - 'none'    : 不带官方 system. 下游自己的 system 已在 rest 里被过滤掉了?
 *                 没有 ---- rest 的定义就是[非 system 消息], 所以 none 等于
 *                 本轮一个 system 都没有.
 *
 * 'none' 与[空字符串]必须分开: 前者是[不要这条消息], 后者是[要一条空消息],
 * 所以这里对空串也要真的发出去(官方模板不会是空串, 只可能来自 custom).
 */
let sysText = null;
if (systemPrompt?.mode === 'none') {
  sysText = null;
} else if (systemPrompt?.mode === 'custom') {
  /**
   * 自定义正文也要过占位符替换 ----
   * 用户正文里可以写 {CODEBUFF_CURRENT_DATE} 这类占位符(语法与官方一致,
   * 见 orchestrator 的 PLACEHOLDER), 由这里在运行时填成真值.
   * 不做这一步等于自定义模式用不了任何动态值.
   */
  const body = typeof systemPrompt.text === 'string' ? systemPrompt.text : '';
  sysText = applyPlaceholders(body, { userInput: typeof userText === 'string' ? userText : '' })
} else if (sysTpl) {
  const mission = typeof userText === 'string' ? userText : JSON.stringify(userText)
  sysText = layer === 'manager'
    ? renderManagerSystem(sysTpl, mission)
    : renderWorkerSystem(sysTpl, { userInput: mission });
}
// 无官方 system 时原样返回 messages(不是 rest): 客户端自己的 system 消息
// 必须保留 ---- 'none' 的语义是[不加官方 system], 不是[清掉所有 system].
const outMessages = sysText
  ? [{ role: 'system', content: sysText }, ...rest]
  : messages;
  return outMessages;
}

/**
 - 组 codebuff_metadata(官方字段逐个对齐, 含 run 内递增的 step).
 - @param {{bridge: any, layer: string, runId: string, instanceId: string, reasoningEffort: string|null}} opts 上下文
 - @returns {Promise<any>} metadata
 */
export async function buildMetadata(opts) {
  const { bridge, layer, runId, instanceId, reasoningEffort } = opts
const metadata = {
  run_id: runId,
  // 官方固定 11 位 base36(line 14 0mrb3znwuim / 38 92jgxqouweo / 60 2qgozlgk45r)
  client_id: (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 11),
  cost_mode: 'free',
  freebuff_instance_id: instanceId,
  freebuff_multi_session: '1',
  trace_session_id: bridge._traceFor(runId),
  // 分层取值:manager 全 0;worker 用真实项目统计(P1-9)
  repo_snapshot: JSON.stringify(
    layer === 'manager'
      ? {
          gitAvailable: false,
          repositoryVisibility: 'unknown',
          fileCount: 0,
          fileCountIsLowerBound: false,
          testFileCount: 0,
          changedFileCount: 0,
          changedFileScanTruncated: false,
        }
      : await collectRepoSnapshot(bridge.cfg.projectDir || process.cwd()),
  ),
  // 官方同 run 内递增(line 38=1 → 42=2 → 45=3 → 56=4),字符串形态
  llm_step_number: String(bridge._stepFor(runId)),
};
if (reasoningEffort) metadata.freebuff_reasoning_effort = reasoningEffort;
  return metadata;
}

/**
 - 组 chat 请求体(官方顶层键序: model / codebuff_metadata / provider / ...).
 - @param {{row: any, metadata: any, outMessages: any[], outTools: any[], layer: string, stream: boolean}} opts 字段
 - @returns {string} 序列化后的请求体
 */
export function buildBody(opts) {
  const { row, metadata, outMessages, outTools, layer, stream } = opts
const body = JSON.stringify({
  model: row.handle,
  codebuff_metadata: metadata,
  // worker 层 = data_collection:deny;manager 层 = allow_fallbacks:true
  provider: layer === 'manager'
    ? { allow_fallbacks: true }
    : { data_collection: 'deny' },
  messages: outMessages,
  tools: outTools,
  tool_choice: 'auto',
  stream,
});
  return body;
}

/**
 - 组 chat 业务头(官方只有这 7 个)并附设备签名.
 - @param {any} bridge Bridge 实例
 - @param {string} url 目标地址
 - @param {string} body 请求体
 - @returns {Promise<any>} 出站头
 */
export async function buildHeaders(bridge, url, body) {
  return {
    'content-type': 'application/json',
    accept: '*/*',
    ...bridge.auth(),
    'user-agent':
      'ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/bun/1.4.2',
    'x-freebuff-acting-user-id': bridge.cfg.userId,
    'x-freebuff-catalog-fetch': bridge.fid,
    ...(await bridge.signHeaders('POST', url, body, bridge.fid)),
  };
}

/**
 - 从流式响应里取 chatcmpl-* id(FINISH 上报需要).
 - @param {string} text 响应原文
 - @returns {string|null} messageId
 */
export function extractMessageId(text) {
let messageId = null;
for (const line of String(text).split('\n')) {
  if (!line.startsWith('data: ')) continue;
  const d = line.slice(6).trim();
  if (!d || d === '[DONE]') continue;
  const m = d.match(/"id"\s*:\s*"(chatcmpl-[^"]+)"/);
  if (m) { messageId = m[1]; break; }
}
  return messageId;
}
