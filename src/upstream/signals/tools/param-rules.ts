/**
 * 官方工具参数形态 -> 下游工具参数形态的翻译规则表.
 *
 * 从 param-map.ts 按职责切出(原文件触及 300 行上限): 本文件只放规则数据
 * (接口 + PARAM_RULES 表), param-map.ts 只放翻译引擎(按规则改参数并裁剪).
 * 两者一起改的场景很少, 拆开后加规则不必再读引擎代码.
 *
 * 真值与判据来源见 param-map.ts 的文件头.
 */

export interface FieldRule {
  /** 官方字段名 -> 下游字段名. 省略表示同名. */
  to?: string
  /** 自定义取值(返回值 undefined 表示不产出该字段). */
  get?: (value: any, src: any) => any
  /** 取到的值是对象时是否摊平成顶层键(edit 的 replacements[0] 用). */
  flatten?: boolean
}

/** 单条工具的参数翻译规则. */
export interface ParamRule {
  /** 官方字段名 -> 规则. 未列出的官方字段一律丢弃. */
  fields: Record<string, FieldRule>
  /** 下游必填但官方 schema 里没有的字段: 名字 -> 由整份官方参数合成. */
  synth?: Record<string, (src: any) => any>
}

export const PARAM_RULES: Record<string, ParamRule> = {
  /** read_files(paths: (string | {path,offset,limit})[]) -> read(file_path, offset?, limit?). */
  read: {
    fields: {
      // paths 是数组, 下游是单文件: 取第一条. 元素是对象时整条摊平(带 offset/limit).
      paths: {
        to: 'file_path',
        flatten: true,
        get: (paths: any) => (Array.isArray(paths) ? paths[0] : paths),
      },
    },
  },
  /** str_replace(path, replacements[]) -> edit(file_path, old_string, new_string, replace_all?). */
  edit: {
    fields: {
      path: { to: 'file_path' },
      replacements: {
        flatten: true,
        get: (reps: any) => (Array.isArray(reps) ? reps[0] : reps),
      },
    },
  },
  /** write_file(path, instructions, content) -> write(file_path, content). */
  write: {
    fields: { path: { to: 'file_path' }, content: { to: 'content' } },
  },
  /**
   * write_todos(todos: [{task, completed}]) -> todo_write(todos: [{content, status}]).
   *
   * 同名不同形:两边都是 todos 数组, 但元素字段完全不同. 旧实现没有这条规则,
   * 于是官方形态原样回给下游 -> dsh 报
   * missing required property "todos[0].content"(2026-10-05 本地会话实测两次).
   *
   * completed 是布尔, 下游 status 是三态枚举: true 只能落 completed,
   * false 落 pending(不猜测是否 in_progress ---- 下游会自己覆盖).
   */
  todo_write: {
    fields: {
      todos: {
        get: (todos: any) =>
          Array.isArray(todos)
            ? todos.map((item: any) => {
                if (!item || typeof item !== 'object') return item
                const out: Record<string, any> = {}
                // 已是下游形态时原样放行(幂等).
                if (typeof item.content === 'string') out.content = item.content
                else if (typeof item.task === 'string') out.content = item.task
                if (typeof item.status === 'string') out.status = item.status
                else out.status = item.completed === true ? 'completed' : 'pending'
                return out
              })
            : todos,
      },
    },
  },
  /**
   * run_terminal_command(command, cwd?, timeout_seconds?) -> bash(command, description, workdir?, timeoutMs?).
   *
   * description 是下游的必填项而官方没有对应字段(官方把意图放在工具调用外层),
   * 用 command 原文合成一句, 保证下游 required 校验能过.
   */
  bash: {
    fields: {
      command: { to: 'command' },
      cwd: { to: 'workdir' },
      timeout_seconds: {
        to: 'timeoutMs',
        get: (v: any) => (typeof v === 'number' ? v * 1000 : undefined),
      },
    },
    synth: {
      description: (src: any) =>
        typeof src?.command === 'string' && src.command
          ? `run: ${src.command}`
          : 'run command',
    },
  },
  /** code_search(pattern, cwd?) -> grep(pattern, path?). */
  grep: {
    fields: { pattern: { to: 'pattern' }, cwd: { to: 'path' } },
  },
  /** list_directory(path) -> ls(path). */
  ls: { fields: { path: { to: 'path' } } },
  /**
   * read_url(url, max_chars?) -> web_fetch(url).
   *
   * 官方多一个 max_chars(正文字符上限), 下游没有对应字段 ---- 只能丢弃,
   * 不能凭空塞进下游 schema(下游 additionalProperties: false 会整条拒掉).
   * 丢它不影响调用成立: 下游按自己的默认上限截断.
   * 这里显式列出来, 是为了说明[为什么这个字段不在表里]而不是漏了它.
   */
  web_fetch: { fields: { url: { to: 'url' } } },
  /**
   * 同名工具的形态差异: 官方 glob(pattern, cwd?, max_results?) ->
   * 下游 glob(pattern, path?). 名字相同但参数名不同, 同样必须翻译.
   */
  glob: {
    fields: { pattern: { to: 'pattern' }, cwd: { to: 'path' } },
  },
  /** web_search(query, depth?) -> web_search(queries: string[]). */
  web_search: {
    fields: {
      query: { to: 'queries', get: (q: any) => (q == null ? undefined : [String(q)]) },
    },
  },
}
