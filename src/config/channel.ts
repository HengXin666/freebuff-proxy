/**
 * 上游通道解析:把"用户/配置里写的通道"收敛成唯一有效值.
 *
 * 从 src/config.js 拆出(原 446 行单文件).
 */

/**
 * 解析上游通道.legacy 已废弃:命中时强制回落 official 并告警.
 *
 * 为什么要硬回落而不是照旧执行:旧链路与官方抓包逐字段不符
 * (system / 工具集 / agent 世代三处),且实测 admission 反复失败
 * (purchase_claim_released).继续让它被调用只会制造"看起来在跑,
 * 实际全被拒"的假象.
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
