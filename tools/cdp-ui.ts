/**
 - cdp.mjs -- 只操作官方客户端 UI 的工具(不发任何上游协议请求).
 *
 - 约束:本文件只做 CDP 驱动(读 DOM / 点击 / 输入),
 - 绝不直接向 codebuff.com 发请求.所有"侦查"通过观察客户端自身行为完成.
 *
 - 用法:
 - node cdp.mjs eval  '<JS 表达式>'
 - node cdp.mjs click '<CSS 选择器>'
 - node cdp.mjs type  '<CSS 选择器>' '<文本>'
 - node cdp.mjs send  '<CSS 选择器>' '<文本>'   # 输入后按 Enter
 - node cdp.mjs shot  <输出路径>                 # 截图
 - node cdp.mjs text  [尾部字符数]
 */
const [mode, a1, a2] = process.argv.slice(2);

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));

function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
  return r.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === 'eval') {
  console.log(await ev(a1));
} else if (mode === 'click') {
  console.log(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(a1)}); if(!e) return 'not found'; e.click(); return 'clicked';})()`));
} else if (mode === 'type') {
  console.log(await ev(`(()=>{
    const el=document.querySelector(${JSON.stringify(a1)});
    if(!el) return 'not found';
    el.focus();
    const s=window.getSelection(); const r=document.createRange();
    r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, ${JSON.stringify(a2)});
    return 'typed: ' + el.innerText.slice(0,120);
  })()`));
} else if (mode === 'send') {
  await ev(`(()=>{
    const el=document.querySelector(${JSON.stringify(a1)});
    if(!el) return 'not found';
    el.focus();
    const s=window.getSelection(); const r=document.createRange();
    r.selectNodeContents(el); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertText', false, ${JSON.stringify(a2)});
    return 'ok';
  })()`);
  await sleep(300);
  for (const type of ['keyDown', 'char', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: type === 'char' ? '\r' : undefined,
    });
  }
  console.log('sent');
} else if (mode === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(a1 || '/tmp/ui.png', Buffer.from(r.result.data, 'base64'));
  console.log('saved', a1 || '/tmp/ui.png');
} else if (mode === 'text') {
  const n = Number(a1) || 1500;
  console.log(await ev(`document.body.innerText.slice(-${n})`));
} else {
  console.log('unknown mode:', mode);
}
ws.close();
