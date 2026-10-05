/**
 * teardown: 主 server 下线
 *
 * 后面的用例各自起 server, 必须先关掉这一份(端口与凭证目录不串味).
 *
 * 由 test/suites/entries/smoke/smoke.ts 按职责机械切出. 口径: 纯搬移.
 */

import { runtimes, server } from '../../harness/runtime.ts'

await runtimes.shutdown()
server.close()
