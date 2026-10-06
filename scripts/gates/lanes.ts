/**
 - lane 表 ---- 按"这一轮改了哪些路径"决定跑哪组门禁.
 *
 - 前缀是目录前缀而不是 glob:判据要能在人脑里一眼算出来,也要能在 git
 - 失败时安全退化.这张表同时被 check-lanes.mjs 用来做覆盖校验(每个顶层
 - 条目都必须被某条 lane 或 NO_GATE_PREFIXES 认领),因此只有一份.
 *
 - 兜底一律偏向"照常跑":算不出变更集就跑全部 lane;路径没被认领就不跳过,
 - 照常跑并提示登记.
 */

/** 每条 lane 的路径前缀与说明. */
export const LANES = {
  backend: {
    title: '后端',
    prefixes: ['src/', 'bin/', 'cli-bridge/', 'test/', 'scripts/'],
    fixHint: '修完再提交：node scripts/gates/run.ts backend',
  },
  frontend: {
    title: '前端',
    prefixes: ['dashboard/'],
    fixHint: '修完再提交：node scripts/gates/run.ts frontend',
  },
  notes: {
    title: '文档与决策记录',
    prefixes: [
      // README_EN.md 是英文版 README: 顶层条目必须被某条 lane 认领.
      // 双语取舍见 .agents/notes/implemented/feature/2026-10-07-bilingual-readme.md
      '.agents/', 'docs/', 'README.md', 'README_EN.md',
      'REVERSE_ENGINEERING_SUMMARY.md', 'AGENTS.md', 'CLAUDE.md',
    ],
    fixHint: '修完再提交：node scripts/gates/run.ts notes',
  },
  guard: {
    title: '门禁脚本与工程配置',
    prefixes: [
      '.gates/',
      '.github/',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.checkjs.json',
      'tsconfig.dashboard.json',
      'Dockerfile',
      'docker-compose.yml',
      'docker-entrypoint.sh',
      '.dockerignore',
      '.gitignore',
      '.env.example',
      'config.yaml',
      'config.example.yaml',
    ],
    fixHint: '门禁本身改了必须重跑负向探针：node scripts/gates/probe-gates.ts',
  },
}

/**
 - 明确"这些改了也不需要跑门禁"----名单要小,且每条都要有理由.
 */
export const NO_GATE_PREFIXES = [
  'LICENSE', // 许可证文本，无执行语义
  'credentials/', // 运行时凭据目录（不进仓库内容判据）
  'data/', // 运行时数据目录
  'data-test/', // 测试残留数据
  'tools/', // 一次性外部工具（Python 脚手架），不属于产品代码
  'node_modules/',
]

/**
 - 给定变更路径集合,返回应跑的 lane 名并集.
 *
 - @param {string[]} paths 仓库相对路径
 - @returns {string[]} lane 名(按 LANES 定义顺序)
 */
export function lanesFor(paths) {
  if (paths.length === 0) return Object.keys(LANES)
  const hit = new Set()
  for (const p of paths) {
    for (const [name, lane] of Object.entries(LANES)) {
      if (lane.prefixes.some((prefix) => p === prefix || p.startsWith(prefix))) hit.add(name)
    }
  }
  // 一条都没命中 → 不跳过,跑全部(宁可慢不可漏);由 check-lanes 兜底提示登记.
  return hit.size === 0 ? Object.keys(LANES) : Object.keys(LANES).filter((n) => hit.has(n))
}
