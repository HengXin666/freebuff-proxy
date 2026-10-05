/**
 * 上游通道解析:把"用户/配置里写的通道"收敛成唯一有效值.
 */

/**
 * 解析上游通道 -- 恒返回 'official'; 传入 'legacy' 时告警一次.
 * 见 .agents/notes/implemented/architecture/2026-10-03-legacy-channel-deprecated.md
 *
 * @param {object} settings settingsStore.get() 的结果(可为 null)
 * @param {object} config 已加载的 config
 * @param {(msg: string, fields?: object) => void} [warn] 告警回调
 * @returns {'official'} 唯一有效通道
 */
export function resolveUpstreamChannel(
  settings: any,
  config: any,
  warn: (msg: string, fields?: Record<string, any>) => void = () => {},
): 'official' {
  const picked =
    settings?.upstreamChannel || config?.upstream?.channel || 'official'
  if (picked === 'legacy') {
    warn('upstream channel "legacy" is deprecated; using "official" instead', {
      requested: picked,
      forced: 'official',
    })
  }
  return 'official'
}
