import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const MIME: any = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/**
 - Serve the dashboard from disk. Path traversal safe.
 - @param {import('node:http').IncomingMessage} req
 - @param {import('node:http').ServerResponse} res
 - @param {URL} url
 - @param {string} root
 */
export function serveStatic(req: any, res: any, url: any, root: any) {
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel === '') rel = '/index.html'
  const file = path.resolve(root, `.${rel}`)
  if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) {
    send404(res)
    return
  }
  if (rel === '/index.html' && req.method !== 'GET' && req.method !== 'HEAD') {
    send404(res)
    return
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      send404(res)
      return
    }
    const ext = path.extname(file).toLowerCase()
    if (ext === '.ts') { sendStripped(res, file, req); return }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      // 控制台是 3 个小文件(index.html/app.js/style.css),全部 no-cache:
      // 前端更新后用户普通刷新即生效,不存在"改了前端但页面还是旧的"缓存问题.
      'cache-control': 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = fs.createReadStream(file)
    stream.on('error', () => {
      try {
        res.destroy()
      } catch {
        // ignore
      }
    })
    stream.pipe(res)
  })
}

/**
 - 浏览器不认 TS 语法, 而控制台现在是 .ts 源(全仓统一后缀).
 - 剥离只删类型标注, 不改变运行时语义; 失败时回 500 并带原因, 不静默回空体.
 - @param {import('node:http').ServerResponse} res 响应
 - @param {string} file 磁盘绝对路径
 - @param {import('node:http').IncomingMessage} req 请求
 - @returns {void}
 */
function sendStripped(res: any, file: any, req: any) {
  let body
  try {
    body = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip', sourceUrl: file })
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`type strip failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const buf = Buffer.from(body, 'utf8')
  res.writeHead(200, {
    'content-type': MIME['.ts'],
    'content-length': buf.length,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') { res.end(); return }
  res.end(buf)
}

function send404(res: any) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not Found')
}
