/**
 * upstream.ts — 在 bun 里执行的上游请求层(入口).
 *
 * 为什么必须跑在 bun 里:TLS 指纹.
 * 官方客户端的 orchestrator 就是 bun 跑的(resources/bun/bun 1.4.2),
 * 用同一个运行时发请求,Client Hello 与官方同源 -- 这是对齐而不是伪装.
 * (实测 Node 52 ciphers / bun 17 ciphers,JA3 可区分,见
 *   ../freebuff-proxy/docs/reverse/11-tls-fingerprint.md)
 *
 * 协议件全部逐字对齐官方 orchestrator.js:
 *   设备签名 Ed25519 / catalog 协议 / base3-free-catalog /
 *   system 开场白 / 官方签名工具 / codebuff_metadata.run_id
 *
 * 实现已按职责拆进 lib/upstream/(bridge = 凭据与签名; actions = action 分发)
 * 与 lib/endpoints、lib/wire、lib/tool-map.ts 等. 本文件只保留:
 *   读入参 -> 建 Bridge -> 交给 runAction -> 输出一行 JSON.
 * 除法与调用方式完全不变: bun upstream.ts '<json>' (stdin 也可以传).
 */
import { createBridge } from './lib/upstream/bridge.ts'
import { runAction } from './lib/upstream/actions.ts'

const rawArgs = process.argv[2];
const input = rawArgs
  ? JSON.parse(rawArgs)
  : JSON.parse(await Bun.stdin.text());

const out = await runAction(createBridge(input.cfg), input);

process.stdout.write(JSON.stringify(out) + '\n');
