# AST 定位与失败边界

依赖在 `scripts/redline/requirements.txt` 固定版本. `scripts/redline/anchors.py` 使用 Tree-sitter 解析整份源码, 通过语法节点判断多行注释是否绑定到函数. 正则只提取路径词元, 不决定锚点位置

| 扩展名 | Parser | 函数与注释 |
|---|---|---|
| cpp, cc, cxx, h, hpp | tree-sitter-cpp | function_definition, template 包装, 多行块注释 |
| ts | tree-sitter-typescript | function, method, arrow, export 与变量包装 |
| tsx | tree-sitter-typescript 的 tsx grammar | 同 TS, 支持 JSX |
| js, mjs | tree-sitter-javascript | function, generator, method, arrow |
| go | tree-sitter-go | function_declaration, method_declaration, func_literal |
| py | tree-sitter-python | function_definition, decorated_definition, 多行 docstring 或连续 # 注释 |
| rs | tree-sitter-rust | function_item, closure_expression, attribute 与 let 包装 |

块注释必须紧邻函数头, 不能跨越其他声明或空白行, 必须实际跨越两行以上. 一个声明包裹多个并列函数时, 不自动把注释归给其中一个. Python docstring 必须是函数体第一个语句且是非插值字符串, 模块 docstring 和中途字符串不合格

源码里所有完整 `.agents/notes/...md` 决策词元都参加检查, 包括普通字符串里的伪引用. AGENTS.md 与 README.md 为管理文档, 不算决策锚点. 编写门禁测试时用动态组合的 fixture 路径, 不把测试数据误写成真实决策引用. 函数声明上方合法的第一段注释可以位于文件最开头, 判断依据是 AST 归属, 不是行号阈值

缺 parser, AST ERROR, missing node, 无法读取文件, 非 UTF-8, 源码 symlink, 非法 Git ref 都失败. 不回落到关键词猜测. 这会要求带语法扩展或不完整宏片段的项目先提供可解析的源码边界, 不能静默放宽到文本匹配

Tree-sitter 只证明位置和结构, 不证明理由的真实性. ID 别名导致的语义重复, 空洞的两边各加一行, 以及注释是否真正约束该函数仍由 review 判断

## 纯声明源码

TS 和 JS 的导出, 变量, 类型与接口声明也可以绑定紧邻的多行注释. Python 模块配置可在赋值前放连续至少两行注释. 声明包含真实函数时仍按函数绑定规则处理, 不把类头或任意文件头当成锚点. 不为迁移增加占位函数
