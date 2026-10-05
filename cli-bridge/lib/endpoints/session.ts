/**
 - 会话与运行端点(admit / startRun / reuseChat / finishRun / 步号) -- 从 cli-bridge/upstream.ts 搬出.
 - 每个函数第一个参数是 bridge 实例; 原方法体里的 this 已逐字改为 bridge.
 */
import { dumpReq } from '../wire/dump.ts'
import { devicePayload } from '../wire/crypto.ts'

/**
 - admission: x-freebuff-model 必须传 handle(fbm1.xxx), 不是 key.
 - purchase_capacity 是付费槽位瞬时排队, 可重试(0/4/8s 退避), 不是账号故障.
 - @param {any} bridge Bridge 实例
 - @param {any} row 目录行
 - @param {{retries?: number, takeoverInstanceId?: string|null}} [opts] 选项
 - @returns {Promise<any>} 准入结果
 */
export async function admit(bridge, row, opts = {}) {

  const { retries = 4, takeoverInstanceId = null } = opts;
  const url = `${bridge.host}/api/v1/freebuff/session/admission`;
  //  官方是裸 UUID且整场复用(抓包 line 8/34/54 三次 admission
  // 同为 e1be7199-...,line 38 metadata 也是它). 这里用 cli:<uuid>
  // 且每次新建 ---- review 指出这可能就是"购买全额退款作废"的诱因:
  // 官方回执里 desktopRefunds 从未出现,我们每次都退.
  // 见 docs/reverse/15-protocol-review.md E.1
  if (!bridge.instanceId) {
    bridge.instanceId = bridge.cfg.instanceId || crypto.randomUUID();
  }
  const inst = bridge.instanceId;
  let last = null;
  for (let i = 0; i <= retries; i++) {
    const hdrs = {
        ...bridge.auth(),
        'x-freebuff-catalog-protocol': '1',
        'x-freebuff-catalog-fetch': bridge.fid,
        'x-freebuff-client': 'desktop',
        //  不要发字面量 'null':主服务没传 installId 时整个头应省略
      ...(bridge.cfg.installId ? { 'x-freebuff-install-id': bridge.cfg.installId } : {}),
        'x-freebuff-model': row.handle,
        'x-freebuff-wallet-spend-limit': '0',
        'x-freebuff-first-tab-discount': '0',
        'x-fb-timezone': bridge.cfg.timeZone
          || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
        'x-freebuff-desktop-attempt-id': crypto.randomUUID(),
        'x-freebuff-instance-id': inst,
        'x-freebuff-purchase-continuity': '1',
        'x-freebuff-multi-session': '1',
        ...(takeoverInstanceId
          ? { 'x-freebuff-takeover-instance-id': takeoverInstanceId }
          : {}),
        ...(await bridge.signHeaders('POST', url, null, bridge.fid)),
      };
    await dumpReq(`admit-${i}`, 'POST', url, hdrs, null);
    const res = await fetch(url, { method: 'POST', headers: hdrs });
    const body = await res.json().catch(() => null);
    last = { status: res.status, body, instanceId: inst, attempt: i };
    if (body?.status === 'active') return last;
    // 槽位占用(capacity=排队 / in_use=正被持有着用):两者都是瞬时的
    const transient =
      body?.status === 'purchase_capacity' || body?.error === 'purchase_capacity'
      || body?.status === 'purchase_in_use' || body?.error === 'purchase_in_use';
    if (!transient) return last;
    // 首次撞到占用:用回执给出的持有者 id 接管重试一次
    if (!takeoverInstanceId && body?.currentInstanceId) {
      return bridge.admit(row, { retries, takeoverInstanceId: body.currentInstanceId });
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
  }
  return last;
}

/**
 - 启动一次 agent run.
 - @param {any} bridge Bridge 实例
 - @param {string|null} agentId agent 标识
 - @param {{layer?: string}} [opts] 选项(layer 决定 agent 名)
 - @returns {Promise<any>} run 结果
 */
export async function startRun(bridge, agentId = null, opts = {}) {
  const { layer = 'worker' } = opts
  agentId = agentId
    || (layer === 'manager'
      ? 'freebuff-desktop-autorun'
      : 'freebuff-desktop-thread-local-v3');
  const url = `${bridge.host}/api/v1/agent-runs`;
  const payload = JSON.stringify({ action: 'START', agentId, ancestorRunIds: [] });
  //  官方 agent-runs 只有 3 个业务头(line 11/58):
  //   content-type / authorization / x-freebuff-acting-user-id
  // 不带 x-codebuff-api-key(全抓包 0 次),不带 catalog 头,不带设备签名.
  const hdrs = {
    'content-type': 'application/json',
    ...bridge.auth(),
    'x-freebuff-acting-user-id': bridge.cfg.userId,
  };
  await dumpReq('startRun', 'POST', url, hdrs, payload);
  const res = await fetch(url, { method: 'POST', headers: hdrs, body: payload });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, runId: body?.runId ?? null };
}

/**
 - 复用一个已存在的会话发 chat: 不建会话, 不扣费.
 - @param {any} bridge Bridge 实例
 - @param {any} opts 参数(row / instanceId / runId / messages / tools / stream / streamStdout)
 - @returns {Promise<any>} chat 结果
 */
export async function reuseChat(bridge, opts) {

  const { row, instanceId, runId, messages, tools, stream = false, streamStdout = false } = opts;
  return bridge.chat({ row, instanceId, runId, messages, tools, stream, streamStdout });
}

/**
 - FINISH 上报: run 结束时告诉上游.
 - @param {any} bridge Bridge 实例
 - @param {string} runId run 标识
 - @param {{status?: string, steps?: any[]}} [opts] 选项
 - @returns {Promise<any>} 上报结果
 */
export async function finishRun(bridge, runId, opts = {}) {

  const { status = 'completed', steps = [] } = opts;
  const url = `${bridge.host}/api/v1/agent-runs`;
  const payload = JSON.stringify({
    action: 'FINISH',
    runId,
    status,
    totalSteps: steps.length,
    directCredits: 0,
    totalCredits: 0,
    steps,
  });
  const hdrs = {
    'content-type': 'application/json',
    ...bridge.auth(),
    'x-freebuff-acting-user-id': bridge.cfg.userId,
  };
  await dumpReq('finishRun', 'POST', url, hdrs, payload);
  const res = await fetch(url, { method: 'POST', headers: hdrs, body: payload });
  const text = await res.text().catch(() => '');
  return { status: res.status, text: text.slice(0, 300) };
}

/**
 - trace_session_id: 一个 run 一个, 不是每请求随机.
 - @param {any} bridge Bridge 实例
 - @param {string} runId run 标识
 - @returns {string} traceSessionId
 */
export function _traceFor(bridge, runId) {

  if (!bridge._runState || bridge._runState.runId !== runId) {
    bridge._runState = { runId, traceSessionId: crypto.randomUUID(), step: 0 };
  }
  return bridge._runState.traceSessionId;
}

/**
 - llm_step_number: 同一 run 内单调递增.
 - @param {any} bridge Bridge 实例
 - @param {string} runId run 标识
 - @returns {number} 递增后的步号
 */
export function _stepFor(bridge, runId) {

  if (!bridge._runState || bridge._runState.runId !== runId) {
    bridge._runState = { runId, traceSessionId: crypto.randomUUID(), step: 0 };
  }
  bridge._runState.step += 1;
  return bridge._runState.step;
}
