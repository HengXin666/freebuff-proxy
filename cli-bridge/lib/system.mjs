/**
 - 官方 system 模板的渲染 -- 从 cli-bridge/upstream.mjs 逐字搬出.
 - 模板里的动态区块必须按当前请求填充, 否则等于每次都告诉上游"我要建那个文件".
 */
/**
 * manager 层 system 的 mission 段是动态的:抓包提取的模板里嵌着
 * 当时那条用户消息(USER_TURN_MARKER: create file /tmp/user-turn-proof.txt...).
 * 原样发出等于每次都告诉上游"我要建这个文件" ---- 必须按当前请求替换.
 *
 * 模板尾部形态(抓包 line 14):
 *   ...固定前缀...

{mission}

Call the decide tool exactly once. ...
 *
 * @param {string} tpl manager 模板
 * @param {string} mission 当前用户消息
 */
/**
 - 把 manager 模板里的 mission 段替换成当前用户消息.
 - @param {string} tpl 模板
 - @param {string} mission 当前用户消息
 - @returns {string} 渲染后的 system
 */
export function renderManagerSystem(tpl, mission) {
  let out = String(tpl || '');
  // 替换 "Call the decide tool" 之前,最后一个空行之后的整段为当前 mission
  const anchor = '\n\nCall the `decide` tool';
  const ai = out.lastIndexOf(anchor);
  if (ai > 0) {
    // 找 anchor 之前最后一个空行,作为 mission 起点
    const head = out.slice(0, ai);
    const cut = head.lastIndexOf('\n\n');
    if (cut > 0) {
      out = head.slice(0, cut) + '\n\n' + String(mission || '') + out.slice(ai);
    }
  }
  return out;
}

/**
 * 生成 worker 层 system(官方模板 + 动态区块填充).
 *
 * 官方模板含两个动态区块 <repository_stats> / <changed_file_paths>,
 * 以及一句 "Current date: ...".直接发模板而不填会成为新的不一致,
 * 所以这里做最小填充(无 git 信息时给空/unknown,与官方 unknown 语义一致).
 */
/**
 - 填充 worker 模板的动态区块(repository_stats / changed_file_paths / 日期).
 - @param {string} tpl 模板
 - @param {{date?: string, repositoryStats?: string, changedFilePaths?: string}} [opts] 动态值
 - @returns {string} 渲染后的 system
 */
export function renderWorkerSystem(tpl, opts = {}) {
  const date = opts.date
    || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  let out = String(tpl || '');
  out = out.replace(/Current date: [^\n]*/, `Current date: ${date}.`);
  const stats = opts.repositoryStats
    || JSON.stringify({
      gitAvailable: false,
      repositoryVisibility: 'unknown',
      fileCount: 0,
      fileCountIsLowerBound: false,
      testFileCount: 0,
      changedFileCount: 0,
      changedFileScanTruncated: false,
    });
  out = out.replace('<repository_stats>', stats);
  out = out.replace('<changed_file_paths>', opts.changedFilePaths || '');
  return out;
}
