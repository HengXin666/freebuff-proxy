#!/usr/bin/env node
/**
 * 注入版本号 / 仓库地址到前端（生成 dashboard/version.json）。
 *
 * 用法：
 *   node scripts/inject-version.mjs                 # 从 package.json version 读
 *   node scripts/inject-version.mjs --version 1.10.0
 *   node scripts/inject-version.mjs --repo https://github.com/xxx/yyy
 *
 * 发版流水线（.github/workflows/docker-image.yml）在 docker build 前调用本脚本，
 * 把 docker/metadata-action 从 git tag 解析出的版本号**硬编码**进镜像内的
 * version.json——镜像里显示什么版本完全由流水线决定，不依赖本地状态。
 *
 * 本地开发没有 version.json 时，前端 fallback 显示 "dev"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const OUT = path.join(ROOT, 'dashboard', 'version.json')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

// 优先 --version；缺省读 package.json（本地手动生成用）。
// tag 形如 v1.10.0 → 1.10.0；metadata-action 输出形如 1.10.0。
const rawVersion = flag('--version', PKG.version || 'dev')
const version = String(rawVersion).replace(/^v/, '')

// 默认仓库：项目固定地址；CI 会显式传 --repo https://github.com/${{ github.repository }}
const DEFAULT_REPO = 'https://github.com/HengXin666/freebuff-proxy'
const repo = flag('--repo', (PKG.repository?.url || '').replace(/\.git$/, '')) || DEFAULT_REPO

const payload = { version, repo }
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log(`[inject-version] wrote ${OUT}`)
console.log(`[inject-version] version=${version} repo=${repo || '(empty)'}`)
