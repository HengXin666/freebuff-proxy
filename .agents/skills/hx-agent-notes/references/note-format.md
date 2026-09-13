# 文件格式

写或审一篇 note 的时候,加载这份.

## 头部块

前三行是精确的:

\`\`\`markdown
# Agent Note: <标题>

Status: <状态>
\`\`\`

\`Status:\` 的取值与所在生命周期目录一致,门禁会交叉核对:

- \`proposed/\` → \`Status: proposed\`
- \`implemented/\` → \`Status: implemented\`
- \`rejected/\` → \`Status: rejected — <一行说明为什么输了>\`

状态里不带日期、不带括号说明:文件名已经承载了首次提出的日期,其余都在 git 里. **拒绝理由是唯一带内容的状态**,因为读者点开一篇 rejected note,要的就是那句判决.

## 正文骨架

note 以 \`## Problem\` 开头,而且必须**脱离方案也能独立成立**. 复现的章节用下面这些精确名字;真正定制的章节(拓扑、线上契约、schema)夹在必需章节之间.

**小标题用英文,正文随你.** 这些标题是被机器校验的词元,正文不是. 本仓库已有的 note(HX-Memory 那 13 篇)就是「英文小标题 + 中文正文」—— 正文写中文完全不影响门禁;门禁另外也认几个中文别名(\`## 问题\` / \`## 决策\` / \`## 备选方案\` / \`## 后果\`),但**别混用**:一篇里要么全英文标题、要么全中文标题,混用会让章节配对和译文骨架检查变得不可读.

**\`proposed/\`**

\`\`\`markdown
## Problem
## Proposal
…定制章节…
## Alternatives considered
## Acceptance criteria
## Risks
\`\`\`

\`Proposal\` 可以用将来时. \`Acceptance criteria\` 要说明**什么可观察的条件**才算完成. \`Risks\` 既涵盖可能出什么问题,**也**涵盖这次改动明知放弃了什么.

**\`implemented/\`**

\`\`\`markdown
## Problem
## Decision
…定制章节…
## Alternatives considered
## Consequences
\`\`\`

\`Decision\` 用现在时描述已上线的现实. 提案期的标题会被门禁拒绝:\`## Proposal\`、\`## Plan\`、\`## Migration plan\`、\`## Acceptance criteria\` 都不许出现在 implemented note 里 —— 因为一份还在为自己辩护的文档,读起来就是还没落地. \`## Testing\`、\`## Verification\`、\`## Deferred\`、\`## Related\` 是可以的,只要它们陈述的是现在时的事实.

**\`rejected/\`**

rejected note 就是那份被冻结的提案. 它保留提案期原有的章节,判决留在 \`Status:\` 行. 它**同样要带 \`## Alternatives considered\`** —— 门禁要求每一篇 active note 都有这一节 —— 而且 \`Status:\` 行必须写明理由,因为没有理由的否决,是没人能据以行动的判决.

## Alternatives considered

每一篇 active note 都必填:每个真实的备选方案以及它为什么输,一个对手一段;有争议的可以用 \`### Why not <X>?\` 子章节. 这一节为什么最重要,见 [机制说明](mechanism.md#alternatives-才是重点).

## 事实保持现行,决策不行

当一个已落地决策的**实现方式**变了 —— 路径移了、包改名了、默认值改了 —— 就地改写事实. 不要追加 \`### 2026-09-02 更新:把 X 改名成 Y\`;站在 HEAD 上的读者应该看到**一份前后一致的现在时状态**.

当**决策本身**被推翻时,那是一次新决策,要写新 note. 两边互相链接,旧的那篇只要还在解释新 note 所移动的那条边界,就留着;只有按[生命周期规则](lifecycle.md)才归档它.

## 中文对照

\`.zh.md\` 对照件逐节镜像它的英文原件. 头部词元(\`# Agent Note: \` 和 \`Status:\` 行)**保持英文原样** —— 它们是被机器校验的. 格式门禁读的是英文那侧,并跳过对照件;骨架配对检查则比对双方的章节数.

## 模板

从 [../templates/proposed.md](../templates/proposed.md)、[../templates/implemented.md](../templates/implemented.md)、[../templates/rejected.md](../templates/rejected.md) 起手,或者用 \`notes:new\` 生成文件 —— 它会替你定好路径、日期和状态.
