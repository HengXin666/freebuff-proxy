/**
 - 上游主机必须硬编码:配置模板里不得再出现 api_base.
 *
 - 为什么(2026-10-04 Docker 部署事故):
 - 全新容器把 config.example.yaml 复制成 /data/config.yaml.example 里写的是
 - https://codebuff.com(少 www),而代码真值是 https://www.codebuff.com.
 *
 - 后果链:所有上游请求打到不带 www 的主机
 - → 401 {"error":"unauthorized","message":"Missing or invalid Authorization header"}
 - → 设备密钥注册失败(拿不到 keyId)→ session GET 无签名
 - → 控制台显示[凭证失效],而 token 完全有效
 - (同一份凭证在 api_base 正确的实例上探测 ok=true,在全新容器上 401).
 *
 - 它能潜伏到用户头上的原因:两个值都是"看起来合理的 URL",少一个 www 肉眼看
 - 不出来;本地开发读仓库根那份 config.yaml(写对了),只有全新部署
 - (Docker 空卷走 example)才踩中.
 *
 - 处置(用户裁决"硬编码吧,不可能有人会去改"):
 - - 真源 = src/config.js 的 UPSTREAM_API_BASE,loadConfig 无条件以它为准;
 - - 配置模板不再暴露 api_base —— 不给写错的机会;
 - - 本脚本钉住"配置模板里不得再有 api_base",防止它悄悄回来.
 *
 - 用法:node scripts/check-config-consistency.mjs
 */
import { readFileSync } from 'node:fs'
import { UPSTREAM_API_BASE } from '../src/config.js'

const HERE = new URL('..', import.meta.url).pathname
const problems = []

// 1) 模板里不得再出现 api_base(含注释里被重新写回的可配形式)
for (const f of ['config.example.yaml']) {
  const text = readFileSync(`${HERE}${f}`, 'utf8')
  if (/^\s*api_base\s*:/m.test(text)) {
    problems.push(`${f} 仍暴露 api_base —— 上游主机应硬编码，不给写错的机会`)
  }
}

// 2) 硬编码真源本身必须是带 www 的官方主机
if (UPSTREAM_API_BASE !== 'https://www.codebuff.com') {
  problems.push(
    `src/config.js 的 UPSTREAM_API_BASE 异常: ${UPSTREAM_API_BASE}` +
      `（应为 https://www.codebuff.com；不带 www 会让上游一律 401）`,
  )
}

if (problems.length) {
  console.error(' 上游主机配置检查未通过：')
  for (const p of problems) console.error(`   - ${p}`)
  process.exit(1)
}

console.log(`上游主机已硬编码：${UPSTREAM_API_BASE}（配置不可覆盖）`)
