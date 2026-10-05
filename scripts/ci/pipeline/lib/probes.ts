/**
 * 容器内探测 -- 从 scripts/ci/pipeline-image-test.ts 按职责切出.
 *
 * 为什么必须在容器里做登录:宿主侧端口映射下 cookie 的 Secure/Domain 判定
 * 与浏览器不同,映射后取不到 cookie 会误报"登录坏了".容器内 127.0.0.1
 * 就是应用本身,等价于用户在本机浏览器打开控制台.
 *
 * 口径: 纯搬移, 不改行为. 两处 CI 实测踩坑的注释原样保留.
 */
import { httpGet, sleep } from './io.ts'
import { containerState } from './container.ts'
import { BOOT_TIMEOUT_MS } from './paths.ts'

/**
 * 在容器内用 admin 账号打一次真实登录, 返回 Set-Cookie.
 *
 * 为什么必须单行脚本(2026-10-04 CI 实测两次踩坑):
 * 坑一:基镜像从 alpine 换成 slim 后容器里没有 wget,旧实现直接失败,
 * 表现为[容器内 admin 登录失败(拿不到会话 cookie)] -- 而被测应用其实完全正常.
 * 坑二:改成 node -e "多行脚本" 后,JSON.stringify 会把换行转义成字面
 * 反斜杠 n,而外层 sh -c 不解释它 -> node 收到含字面换行的单行 -> SyntaxError.
 * 所以这里用分号分隔的单行脚本(不经 shell 转义新行),稳.
 * @param {string} name 容器名
 * @param {(cmd: string, args: string[], opts?: object) => {status: number|null,
 *   stdout?: string, stderr?: string}} run 子进程执行器
 * @returns {string|null} 会话 cookie;拿不到返回 null
 */
export function loginInsideContainer(name, run) {
  const parts = [
    "const http=require('http')",
    "const body=JSON.stringify({username:'admin',password:'pipeline-admin-pw'})",
    "const req=http.request({host:'127.0.0.1',"
      + "port:process.env.FREEBUFF_PROXY_PORT||8787,path:'/api/auth/login',method:'POST',"
      + "headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},"
      + "res=>{console.log('STATUS '+res.statusCode)",
    "console.log(JSON.stringify(res.headers))",
    "res.resume()})",
    "req.on('error',e=>console.log('ERR '+e.message))",
    "req.write(body)",
    "req.end()",
  ]
  const script = parts.join(';')
  const cmd = 'node -e ' + JSON.stringify(script)
  const r = run('docker', ['exec', name, 'sh', '-c', cmd])
  const out = String(r.stdout || '') + String(r.stderr || '')
  /**
   - 提取 cookie:直接从整段输出里抓 fb_session=.
   *
   - 不要试图先 JSON.parse 那行 headers -- 输出里换行位置由 console.log
   - 决定,JSON 对象可能跨行,按"单行大括号"匹配会漏(实测踩到:
   - 登录明明返回 200 且带 set-cookie,却判定"拿不到会话 cookie").
   - 直接抓值最稳,且不依赖任何打印格式.
   */
  const m = out.match(/fb_session=[^;\r\n"]+/i)
  return m ? m[0] : null
}

/**
 * 在容器内请求一个需要登录的接口, 返回 HTTP 状态码(0 = 连不上/没输出).
 *
 * 这条断言是必须的:数据文件自检接口曾因 path 变量遮蔽 node:path 而直接
 * 500(真实用户故障),只测 /healthz 完全看不出来.
 *
 * options 与 callback 之间必须是逗号,不能靠 join(';') 拼 --
 * http.request({...}; res=>{...}) 是语法错误(分号把调用切断了),
 * 脚本静默失败 -> 输出为空 -> 断言判成"接口无响应"(实测踩到).
 * 所以把这一段合成单个字符串,内部用逗号.
 * @param {string} name 容器名
 * @param {string} cookie 会话 cookie
 * @param {string} endpoint 目标路径
 * @param {(cmd: string, args: string[], opts?: object) => {status: number|null,
 *   stdout?: string, stderr?: string}} run 子进程执行器
 * @returns {number} HTTP 状态码;无输出返回 0
 */
export function probeAuthedEndpoint(name, cookie, endpoint, run) {
  const optionsAndCb =
    "{host:'127.0.0.1',port:process.env.FREEBUFF_PROXY_PORT||8787,path:" +
    JSON.stringify(endpoint) +
    ",method:'GET',headers:{cookie:" +
    JSON.stringify(cookie) +
    "}},res=>{console.log('STATUS '+res.statusCode);res.resume()}"
  const parts = [
    "const http=require('http')",
    "const req=http.request(" + optionsAndCb + ")",
    "req.on('error',e=>console.log('ERR '+e.message))",
    "req.end()",
  ]
  const script = parts.join(';')
  const cmd = 'node -e ' + JSON.stringify(script)
  const r = run('docker', ['exec', name, 'sh', '-c', cmd])
  const out = String(r.stdout || '') + String(r.stderr || '')
  const m = out.match(/STATUS\s+(\d{3})/)
  return m ? Number(m[1]) : 0
}

/**
 * 等容器稳定:要么监听成功(healthz 200),要么进程退出/崩溃.
 * @param {string} name 容器名
 * @param {number} port 宿主机端口
 * @param {(cmd: string, args: string[], opts?: object) => object} run 子进程执行器
 * @param {number} [timeoutMs] 预算毫秒
 * @returns {Promise<{up: boolean, state: object, probe: object, timeout?: boolean}>} 启动结论
 */
export async function waitForBoot(name, port, run, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last = { status: 0 }
  while (Date.now() < deadline) {
    const st = containerState(name, run)
    if (st.status === 'missing' || st.status === 'exited' || st.status === 'dead') {
      return { up: false, state: st, probe: last }
    }
    last = await httpGet(`http://127.0.0.1:${port}/healthz`)
    if (last.status === 200) return { up: true, state: st, probe: last }
    await sleep(700)
  }
  return { up: false, state: containerState(name, run), probe: last, timeout: true }
}

/**
 * 等 Docker HEALTHCHECK 变 healthy(Dockerfile 的 start-period + interval 至少要等一轮).
 * @param {string} name 容器名
 * @param {number} timeoutMs 预算毫秒
 * @param {(cmd: string, args: string[], opts?: object) => object} run 子进程执行器
 * @returns {Promise<boolean>} 是否通过
 */
export async function waitForHealthcheck(name, timeoutMs, run) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = containerState(name, run)
    if (st.health === 'healthy') return true
    if (st.status !== 'running') return false
    await sleep(2000)
  }
  return false
}
