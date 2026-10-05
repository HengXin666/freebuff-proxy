/**
 * 可调项的持久化: 读/写 settings.json 里点分路径形态的键.
 *
 *
 * settings.json 里同时住着两套东西, 生命周期与生效方式都不同:
 *
 *   - 实时字段(11 个, 裸名如 accountMaxConcurrency): 有默认值, 保存即生效,
 *     经 getter 被调度/会话层实时读取. 实现在 ./settings-store.ts.
 *   - 可调项(24 个, 点分路径如 limits.slotWaitMs): 没有默认值(没保存过
 *     就不该覆盖 config.yaml 的兜底), 生效方式是"保存后重启时合并进 config".
 *
 * 把它们混在一个类里, 最容易出的错是"用同一套默认值逻辑处理两者" ---- 那会让
 * 没保存过的可调项被写成默认值, 于是 config.yaml 的兜底语义失效. 分开之后,
 * "哪一套有哪些键"在类型与文件边界上就是清楚的.
 *
 * 键的合法性由 /api/settings 按 src/config/tunables.ts 的声明校验; 本文件只
 * 负责"原样读写", 不做夹取 ---- 夹取会掩盖越界值, 让用户以为设进去了.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFileState } from '../../../util/json-store.ts'

/**
 * 读盘上保存的可调项(点分路径 -> 值).
 * @param {string} file settings.json 路径
 * @returns {Record<string, any>} 已保存的可调项; 文件缺失/损坏时为空对象
 */
export function readTunables(file: string): Record<string, any> {
  const st = readJsonFileState(file)
  if (st.status !== 'ok' || !st.data || typeof st.data !== 'object') return {}
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(st.data)) {
    // version 是元字段, 实时字段是裸名; 带点的键才是可调项路径.
    if (!k.includes('.')) continue
    out[k] = v
  }
  return out
}

/**
 * 把可调项补丁写进 settings.json(与实时字段共存于同一文件).
 *
 * 必须先读后写合并: 直接覆盖会把同一文件里的 11 个实时字段抹掉 ----
 * 直接把实时字段抹掉会丢失额度保护设置.
 * @param {string} file settings.json 路径
 * @param {Record<string, any>} patch 点分路径 -> 值
 * @returns {Record<string, any>} 写盘后的可调项全量
 */
export function writeTunables(file: string, patch: Record<string, any>): Record<string, any> {
  const st = readJsonFileState(file)
  const base = st.status === 'ok' && st.data && typeof st.data === 'object' ? st.data : {}
  const next = { ...base, ...patch }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return readTunables(file)
}
