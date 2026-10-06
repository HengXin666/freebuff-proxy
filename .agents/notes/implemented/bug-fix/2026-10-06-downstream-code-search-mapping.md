# Agent Note: 官方 code_search 落到下游同名工具 dsh code_search, 参数按同名异形翻译

Status: implemented

## Problem

官方工具集里的 code_search 在下游可能落成一个**同名但异形**的工具. 这不是假设,
是本机 dsh 会话记录里的真实现场(2026-10-06, session-2dbfca91, agentPreset=minimal):

```
injectableOfficialTools(极简模式 27 工具) = [run_terminal_command, code_search]
回程还原: back.code_search = 'code_search'   (与官方同名)

真实调用 1: {"pattern":"TODO","maxResults":3}
  -> Error: invalid arguments: missing required property "search_term";
     missing required property "search_folder_absolute_uri"

真实调用 2: {"search_term":"TODO","search_folder_absolute_uri":"<会话 cwd>"}
  -> 成功, 返回真实搜索结果
```

三个事实叠在一起才构成这个故障:

1. 那个同名工具由第三方插件 dsh-devin-search 注册, 参数是 search_term 与
   search_folder_absolute_uri(两者都必填, 后者必须是会话工作目录下的绝对路径),
   且**拒绝任何其它字段**(execute 里显式判 Object.keys 白名单).
2. 官方 code_search 的参数是 pattern / cwd / flags / maxResults, additionalProperties: false.
3. 名字表里 code_search -> code_search 是[同名], 回程还原不改写它;
   而参数翻译规则表当时只有键 `grep`. 于是名字对上了, 参数一个都没翻.

后果是调用必然失败: 上游下发的官方形态参数原样交给下游, 下游按自己的 required
校验当场拒掉. 同一台机器上 [dsh 原生 55 工具] 形态完全不受影响 ---- 那种形态声明的是
grep, 走 grep 规则; 只有极简模式(以及任何装了同名 code_search 的客户端)会踩到.

## Decision

**在下游同名工具上就地翻译, 不另造名字, 也不改注入集.** 三处改动:

1. **参数规则按下游名登记**: `PARAM_RULES.code_search` 把 pattern 改名成 search_term.
   引擎原有的[按下游 schema 裁剪]会把 flags / maxResults 丢掉, 不需要额外写丢弃逻辑.
2. **搜索目录由控制台配置提供**: 它是**下游客户端的本地事实**, 上游请求里根本没有,
   也不可能从上游回执推导(官方 cwd 是[相对项目根], 形态与语义都不是绝对路径).
   新增可调项 `downstream.searchFolder`(绝对路径), 经 `paramContextOf(config)` 进
   翻译引擎新增的 ParamContext.
3. **流式路径也缓冲它**: 名字还原不改写同名工具, 而 `worthBuffering` 原先只缓冲
   [声明集里为下游名]的工具, 同名工具在流式路径上会被漏掉. 加一张极小的显式表
   `SAME_NAME_SHAPE_DIFFERS`(目前只 code_search 一项)覆盖这一类.

未配置 searchFolder 时**不产出该字段**, 而不是产出空串: 空串会让下游报[路径非法],
指向错误; 缺字段让下游直接报必填缺失, 指向[本代理没配]. 前端在[官方工具注入]卡上
写明了这一点.

## Alternatives considered

**什么都不做, 靠前端说明告诉用户[极简模式下 code_search 不可用].** 否决: 用户的原话是
[你要想办法映射一下它] ---- 官方只注入 run_terminal_command 与 code_search 两个工具时,
其中一个必然失败等于砍掉一半可用面; 而失败现场(下游报 missing required property)
看不出是本代理没翻译.

**复用现有 grep 规则, 让官方 code_search 也走 grep.** 否决: 下游这次**没有声明 grep**
(极简模式夹具里 grep 不存在), 凭空把它改成下游不认识的别名只会得到 unknown tool.
还原目标必须是[下游真的声明过的名字], 这条不变量在 signals/AGENTS.md 里写着.

**从上游请求里推导搜索目录.** 否决: 请求体里只有 messages / tools / metadata, 没有工作目录;
官方 system 模板里的 repository_stats 是仓库统计, 官方 cwd 参数是相对根路径.
下游要求的是[绝对路径且在会话 cwd 内], 只能由使用者提供 ---- 任何猜测都会让下游报
[Search folder must be inside the local session workspace].

**把 searchFolder 做成实时字段(保存即生效).** 否决: 同族的 config 可调项一律是[保存后重启],
为一个字段单独开一条实时通道会形成两个入口两种生效时机. 按既有契约放在[高级]区即可,
页面已经写明[保存后重启生效].

**把下游 code_search 也拉进 OFFICIAL_NATIVE_TO_CLIENT 之类的反向表.** 否决: 那张表的键是
官方原生名, 用来表达[两个官方工具落到同一个下游工具]. 这里是一个官方工具落一个同名下游
工具, 方向与用途都不匹配; 真正缺的是参数规则, 不是名字映射.

**把 search_folder_absolute_uri 塞进官方下发时的参数里(下行方向)让模型自己填.** 否决:
模型看到的是官方 schema, 官方 schema 里没有这个字段; 强行加进去等于伪造官方形态,
而[工具集与参数形态像不像官方 CLI]本身就是上游的第三方客户端判据.

## Consequences

- 极简模式(以及任何声明同名 code_search 的客户端)下, 官方 code_search 一次就能派发成功.
- 搜索目录留空时该调用仍会失败, 但错误指向[必填缺失]而不是[路径非法], 且前端页面写明了配置位置.
- 参数翻译引擎多了一个可选入参 ParamContext; 既有调用点不受影响(缺省 undefined).
- `SAME_NAME_SHAPE_DIFFERS` 是一张显式白名单: 新增[同名异形]工具时必须往里加一项,
  否则流式路径会漏翻译. 这是已知的维护点, 由
  test/suites/entries/verify/tool/param/dispatch-minimal.ts 的注入集断言兜住一部分.
- 新增测试夹具 test/fixtures/dsh-minimal-tools.json 是抓包真值(27 工具), 不是手写清单;
  上游或插件改工具集后必须回来重抓.
