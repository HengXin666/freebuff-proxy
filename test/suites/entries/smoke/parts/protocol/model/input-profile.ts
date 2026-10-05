/**
 * protocol: 输入画像与代理描述
 *
 * encodeInputProfile 的字段与代理描述的真实形态.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'

// chat metadata 对齐:freebuff_input_profile / repo_snapshot / llm_step_number.
// 官方 chat 带这三个字段,我们此前一个都没有.格式逐字对齐官方
// cli/src/utils/input-profile.ts encodeInputProfile().
// 见 .agents/notes/implemented/feature/2026-10-01-chat-metadata-parity.md
{
  const {
    encodeInputProfile,
    describeProxyInput,
    describeProxyRepo,
    withChatMetadataParity,
    INPUT_PROFILE_KEY,
    REPO_SNAPSHOT_KEY,
    LLM_STEP_NUMBER_KEY,
  } = await import('../../../../../../../src/upstream/metadata/chat-metadata-parity.ts')

  assert.equal(INPUT_PROFILE_KEY, 'freebuff_input_profile')
  assert.equal(REPO_SNAPSHOT_KEY, 'repo_snapshot')
  assert.equal(LLM_STEP_NUMBER_KEY, 'llm_step_number')

  // 逐字对照真机抓到的官方样本
  assert.equal(
    encodeInputProfile({
      typedChars: 6,
      keypressEvents: 6,
      multiCharKeypressEvents: 0,
      pastedChars: 0,
      pasteEvents: 0,
      composeMs: 1001,
      maxTypedCharsPerSecond: 6,
    }),
    'v1;tc=6;ke=6;mc=0;pc=0;pe=0;ms=1001;cps=6',
    '必须与官方样本逐字一致',
  )

  // null 的项整项省略(对齐官方 flatMap 过滤 null)
  const noMs = encodeInputProfile({
    typedChars: 3,
    keypressEvents: 3,
    multiCharKeypressEvents: 0,
    pastedChars: 0,
    pasteEvents: 0,
    composeMs: null,
    maxTypedCharsPerSecond: 3,
  })
  assert.ok(!noMs.includes('ms='), 'composeMs=null 时不得出现 ms 项: ' + noMs)
  assert.equal(noMs, 'v1;tc=3;ke=3;mc=0;pc=0;pe=0;cps=3')

  // 服务端视角的画像:字段齐全,顺序正确,不伪造粘贴
  const prof = describeProxyInput({
    messages: [{ role: 'user', content: 'say OK' }],
    arrivedAtMs: 1000,
    nowMs: 1030,
  })
  assert.match(prof, /^v1;tc=6;ke=1;mc=1;pc=0;pe=0;ms=30;cps=6$/, prof)

  // repo_snapshot 是 JSON 字符串,字段与官方同形
  const repo = JSON.parse(describeProxyRepo())
  assert.equal(repo.gitAvailable, false)
  assert.equal(repo.repositoryVisibility, 'unknown')
  assert.equal(typeof repo.fileCount, 'number')
  assert.ok('changedFileScanTruncated' in repo)

  // 合并:只补缺失项,不覆盖调用方已有值
  const merged = withChatMetadataParity(
    { run_id: 'r1', [LLM_STEP_NUMBER_KEY]: '7' },
    { messages: [{ role: 'user', content: 'hi' }], stepNumber: 2 },
  )
  assert.equal(merged.run_id, 'r1')
  assert.equal(merged[LLM_STEP_NUMBER_KEY], '7', '已有值不得被覆盖')
  assert.ok(merged[INPUT_PROFILE_KEY], '缺失项应被补上')
  assert.ok(merged[REPO_SNAPSHOT_KEY])
}
