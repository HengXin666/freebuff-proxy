/**
 * upstream.ts -- 在 bun 里执行的上游请求层(入口).
 *
 *
 * 协议件全部逐字对齐官方 orchestrator.js:
 *   设备签名 Ed25519 / catalog 协议 / base3-free-catalog /
 *   system 开场白 / 官方签名工具 / codebuff_metadata.run_id
 *
 * 实现已按职责拆进 lib/upstream/(bridge = 凭据与签名; actions = action 分发)
 * 与 lib/endpoints,lib/wire,lib/tool-map.ts 等. 本文件只保留:
 *   读入参 -> 建 Bridge -> 交给 runAction -> 输出一行 JSON.
 * 除法与调用方式完全不变: bun upstream.ts '<json>' (stdin 也可以传).
 */
import { createBridge } from './lib/upstream/bridge.ts'
import { runAction } from './lib/upstream/actions.ts'

const rawArgs = process.argv[2];
const input = rawArgs
  ? JSON.parse(rawArgs)
  : JSON.parse(await Bun.stdin.text());

/**
 * 流式 stdout 协议(见 ../bridge.ts 的 callBunStream):
 *   - chat action 在 stream 模式下把上游字节按行原样写到 stdout(无前缀);
 *   - 所有其它情况(含非流式 chat)只在末行输出一个 '>'-前缀的 JSON 汇总,
 *     供 Promise 版 callBun / 流式版 onSummary 解析.
 *
 * 用 '>' 做汇总前缀而不是给正文加前缀: 正文必须逐字节原样(下游的 SSE 改写
 * 依赖原始行形态), 而汇总行是"额外追加"的一行, 只在结束处出现一次.
 */
const out = await runAction(createBridge(input.cfg), input);

process.stdout.write('>' + JSON.stringify(out) + '\n');
