/**
 - 门禁输出与退出码的唯一约定,被所有 check-*.mjs 共用.
 *
 - 三种退出码承载三种不同事实,混用会让"跑错了"看起来像"通过":
 - 0 = PASS  1 = FAIL(发现违规)  2 = 用法错(参数/环境不合法)
 *
 - 状态行刻意逐行对齐,让人扫一眼就能看出哪一条红了.
 */
import fs from 'node:fs'

/** 退出码常量. */
export const EXIT = { pass: 0, fail: 1, usage: 2 }

/** 单次运行最多打印的明细行数(防日志被一个巨型仓库淹没). */
export const MAX_PRINTED = 40

/** 带宽度对齐的状态行前缀. */

/**
 - 见上方模块说明.
 *
 - @param {string} status 状态名
 - @returns {string} 对齐后的标签
 */
export function tag(status) {
  const map = { ok: 'ok  ', over: 'OVER', bad: 'BAD ', miss: 'MISS' }
  return map[status] || status
}

/**
 - 违规收集器:把"发现的问题"与"怎么打印"分开,便于探针只断言数据不看排版.
 */
export class Report {
  /** @param {string} name 门禁名(与总线注册表同源) */
  constructor(name) {
    this.name = name
    /** @type {Array<{file: string, line?: number, msg: string, fix?: string}>} */
    this.violations = []
    /** @type {string[]} */
    this.notes = []
  }

  /** 记一条违规;fix 是可操作的修复动作,不是复述规则. */
  /**
   - 见本类说明.
   *
   - @param {string} file 文件(或来源标记)
   - @param {number} line 行号(0 表示文件级)
   - @param {string} msg 违规说明
   - @param {string} [fix] 可操作的修复动作
   - @returns {void} 无返回
   */
  add(file, line, msg, fix) {
    this.violations.push({ file, line, msg, fix })
  }

  /** 记一条非违规的信息(如豁免条数,跳过原因). */
  /**
   - 见本类说明.
   *
   - @param {string} text 信息文本
   - @returns {void} 无返回
   */
  note(text) {
    this.notes.push(text)
  }

  /** 打印明细并按是否有违规返回退出码. */
  /**
   - 见本类说明.
   *
   - @returns {number} 退出码(0 = PASS / 1 = FAIL)
   */
  finish() {
    for (const n of this.notes) console.log(`  · ${n}`)
    const shown = this.violations.slice(0, MAX_PRINTED)
    for (const v of shown) {
      const loc = v.line ? `${v.file}:${v.line}` : v.file
      console.log(`  FAIL ${loc}\n       ${v.msg}${v.fix ? `\n       修复: ${v.fix}` : ''}`)
    }
    const rest = this.violations.length - shown.length
    if (rest > 0) console.log(`  ... 另有 ${rest} 条同类违规未打印`)
    if (this.violations.length === 0) {
      console.log(`ok  ${this.name}`)
      return EXIT.pass
    }
    console.log(`${tag('over')} ${this.name}: ${this.violations.length} 条违规`)
    return EXIT.fail
  }
}

/**
 - 校验环境变量给出的路径存在,否则以 usage 退出.
 *
 - 为什么必须显式报错:扫描根写错时,"零违规"和"真的没有违规"输出完全一样
 - —— 这是门禁最危险的失败形态.
 */

/**
 - 见上方模块说明.
 *
 - @param {string} dir 待校验目录
 - @returns {void} 不存在时以 usage 退出
 */
export function requireRoot(dir) {
  if (!dir || !fs.existsSync(dir)) {
    console.error(`usage: 扫描根不存在: ${dir}`)
    process.exit(EXIT.usage)
  }
}
