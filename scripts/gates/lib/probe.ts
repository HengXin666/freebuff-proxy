/**
 * 探针夹具工具 ---- 造临时仓库,跑门禁,取真实输出.
 *
 * 夹具一律建在 mkdtempSync(tmpdir()) 里,由调用方 finally/收尾删除,
 * 绝不写真实仓库.门禁靠 git ls-files 取受控集合,所以夹具要 git init
 * 才有意义;没有 git 时门禁会退化为目录遍历,探针仍然有效.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ROOT } from '../rules.ts'

/** 仓库根(真实仓库,用于取脚本路径与指纹输入). */
export { ROOT }

/**
 * 跑一条门禁脚本:夹具目录作 cwd,CHECK_ROOT 指向它.
 *
 * 为什么必须覆盖 CHECK_ROOT:否则门禁扫的是真实仓库,探针就变成"在别人家里
 * 放垃圾",既不隔离也测不出门禁对违规输入的反应.
 */
export function runGate(script, cwd, extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, script)], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, CHECK_ROOT: cwd, ...extraEnv },
    })
    return { status: 0, out }
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** 造一个夹具仓库:写文件 + git add. */
export function fixture(files, { git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-gates-probe-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  if (git) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['add', '-A'], { cwd: dir })
    } catch {
      // 无 git 时退化为目录遍历，探针仍有效
    }
  }
  return dir
}

/** 把真实仓库的指纹输入复制进夹具,供接线探针用. */
export function copyFingerprintInputs(dir, { tamperRun = null } = {}) {
  fs.mkdirSync(path.join(dir, 'scripts/gates'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.gates'), { recursive: true })
  for (const rel of ['run.ts', 'rules.ts', 'lanes.ts']) {
    const text = fs.readFileSync(path.join(ROOT, 'scripts/gates', rel), 'utf8')
    fs.writeFileSync(path.join(dir, 'scripts/gates', rel), tamperRun && rel === 'run.ts' ? tamperRun(text) : text)
  }
  for (const rel of fs.readdirSync(path.join(ROOT, '.gates'))) {
    fs.copyFileSync(path.join(ROOT, '.gates', rel), path.join(dir, '.gates', rel))
  }
  // hook 接线也在指纹里("还跑不跑"的一半).夹具没有 .git/hooks,不复制的
  // 话控制组会因"夹具里没有 hook"而假红 ---- 探针自己变成噪音源.
  for (const rel of ['pre-commit', 'pre-push']) {
    const src = path.join(ROOT, '.git/hooks', rel)
    const dst = path.join(dir, '.git/hooks', rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '')
  }
  return dir
}

/** 生成 N 行代码. */
export const lines = (n, prefix = 'const x') => `${Array.from({ length: n }, (_, i) => `${prefix}${i} = ${i}`).join('\n')}\n`
