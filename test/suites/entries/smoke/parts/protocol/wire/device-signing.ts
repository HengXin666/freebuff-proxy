/**
 * protocol: 设备签名
 *
 * device-key / timestamp / signature 三件的真实形态.
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import assert from 'node:assert/strict'

// 设备签名(x-freebuff-device-{key,ts,sig}):上游判定[是不是注册过的真客户端]
// 的核心判据.真机抓包确认官方每个 catalog/session/completions 请求都带这三头,
// 而我们此前一个都没有.算法逐字对齐官方公开源码,并用抓到的真机样本做过
// 逐字节重现验证(MATCH: true).见
// .agents/notes/implemented/bug-fix/2026-10-01-device-signing.md
{
  const {
    deviceSignaturePayload,
    bodySha256,
    generateDeviceKey,
    parseDeviceKeyRecord,
    importDevicePrivateKey,
    signDeviceRequest,
    registrationScope,
    FREEBUFF_DEVICE_KEYS_PATH,
    HEADER_DEVICE_KEY,
    HEADER_DEVICE_TIMESTAMP,
    HEADER_DEVICE_SIGNATURE,
    DEVICE_SIGNATURE_VERSION,
  } = await import('../../../../../../../src/upstream/device/device-signing.ts')

  assert.equal(FREEBUFF_DEVICE_KEYS_PATH, '/api/v1/freebuff/device-keys')
  assert.equal(HEADER_DEVICE_KEY, 'x-freebuff-device-key')
  assert.equal(HEADER_DEVICE_TIMESTAMP, 'x-freebuff-device-ts')
  assert.equal(HEADER_DEVICE_SIGNATURE, 'x-freebuff-device-sig')
  assert.equal(DEVICE_SIGNATURE_VERSION, 'freebuff-device-v1')

  // 载荷:换行拼接,METHOD 大写,fetchId 缺失用空串占位(不是省略该行)
  const p = deviceSignaturePayload({
    method: 'post',
    path: '/api/v1/x',
    timestampMs: 123,
    bodySha256: 'ab',
    fetchId: null,
  })
  assert.equal(p, 'freebuff-device-v1\nPOST\n/api/v1/x\n123\nab\n')
  assert.equal(p.split('\n').length, 6, '载荷必须恰好 6 行')
  assert.ok(p.startsWith('freebuff-device-v1\nPOST\n'), '第一行是版本、第二行是大写方法')

  // 空 body 的哈希是 e3b0c442...(SHA-256 of empty),官方同款
  assert.equal(
    bodySha256(null),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  assert.equal(bodySha256('x'), bodySha256('x'))
  assert.notEqual(bodySha256('x'), bodySha256('y'))
  assert.equal(bodySha256('x').length, 64, '小写 hex SHA-256')

  // 生成的密钥形状
  const k = generateDeviceKey()
  assert.equal(k.version, 1)
  assert.equal(k.publicKey.length, 43, 'raw Ed25519 公钥 base64url 是 43 字符')
  assert.deepEqual(k.registrations, {})
  assert.ok(parseDeviceKeyRecord(k), '自己生成的记录必须能被 parse')
  assert.equal(parseDeviceKeyRecord({ version: 2 }), null, '版本不对必须拒绝')
  assert.equal(parseDeviceKeyRecord(null), null)

  // 签名可复算且稳定(同输入同输出)
  const priv = importDevicePrivateKey(k)
  assert.ok(priv, '必须能导入私钥')
  const args = {
    privateKey: priv,
    keyId: 'kid-1',
    method: 'GET',
    url: 'https://www.codebuff.com/api/v1/freebuff/session',
    body: null,
    fetchId: null,
    timestampMs: 1790839381213,
  }
  const s1 = signDeviceRequest(args)
  const s2 = signDeviceRequest(args)
  assert.equal(s1[HEADER_DEVICE_KEY], 'kid-1')
  assert.equal(s1[HEADER_DEVICE_TIMESTAMP], '1790839381213')
  assert.equal(s1[HEADER_DEVICE_SIGNATURE], s2[HEADER_DEVICE_SIGNATURE], '同输入必须同签名')
  assert.ok(s1[HEADER_DEVICE_SIGNATURE].length > 60, '签名是 base64url')
  assert.ok(!s1[HEADER_DEVICE_SIGNATURE].includes('='), 'base64url 不带 padding')

  // 不同 path / body / fetchId 必须得出不同签名(否则签名形同虚设)
  const s3 = signDeviceRequest({ ...args, url: 'https://www.codebuff.com/other' })
  assert.notEqual(s1[HEADER_DEVICE_SIGNATURE], s3[HEADER_DEVICE_SIGNATURE], 'path 变了签名必须变')
  const s4 = signDeviceRequest({ ...args, body: '{}' })
  assert.notEqual(s1[HEADER_DEVICE_SIGNATURE], s4[HEADER_DEVICE_SIGNATURE], 'body 变了签名必须变')
  const s5 = signDeviceRequest({ ...args, fetchId: 'fbf1.x' })
  assert.notEqual(s1[HEADER_DEVICE_SIGNATURE], s5[HEADER_DEVICE_SIGNATURE], 'fetchId 变了签名必须变')

  // 注册作用域字符串(官方同款形状)
  assert.equal(
    registrationScope('https://www.codebuff.com', 'u1'),
    'https://www.codebuff.com user:u1',
  )
}
