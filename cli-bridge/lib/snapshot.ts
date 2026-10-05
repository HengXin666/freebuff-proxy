/**
 - repo_snapshot 采集 -- 从 cli-bridge/upstream.ts 逐字搬出.
 - 官方分层取值: manager 层全 0; worker 层用真实项目统计, 失败回落全 0.
 */
/**
 * 采集 repo_snapshot(worker 层用真实项目统计,manager 层全 0).
 *
 * 官方分层取值:line 14(manager)fileCount 0;
 * line 38(worker)fileCount 69,testFileCount 5.
 * 我们此前统一硬编码 0 ---- worker 层会成为不一致点.
 *
 * 只做轻量统计:受 .gitignore 影响的文件不逐个读内容,
 * 仅统计数量并识别测试文件,超时/失败即回落到全 0.
 */
/**
 - 数一个目录下的文件数与测试文件数(只统计, 不读内容).
 - @param {string} dir 项目目录
 - @returns {Promise<any>} repo_snapshot 对象
 */
export async function collectRepoSnapshot(dir) {
  const zero = {
    gitAvailable: false,
    repositoryVisibility: 'unknown',
    fileCount: 0,
    fileCountIsLowerBound: false,
    testFileCount: 0,
    changedFileCount: 0,
    changedFileScanTruncated: false,
  };
  if (!dir) return zero;
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const { join, extname, basename } = await import('node:path');
    const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next',
      '.cache', 'coverage', '.venv', '__pycache__', '.mypy_cache']);
    const TEST_RE = /(^|[._-])(test|spec|tests|specs)([._-]|$)|\.(test|spec)\./i;
    let fileCount = 0, testFileCount = 0, truncated = false;
    const queue = [dir];
    let visited = 0;
    while (queue.length && visited < 20000) {
      const cur = queue.pop();
      let entries = [];
      try { entries = await readdir(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') {
          if (SKIP.has(e.name)) continue;
        }
        const p = join(cur, e.name);
        if (e.isDirectory()) {
          if (SKIP.has(e.name)) continue;
          if (queue.length < 4000) queue.push(p); else truncated = true;
          continue;
        }
        if (!e.isFile()) continue;
        visited++;
        fileCount++;
        if (TEST_RE.test(e.name)) testFileCount++;
        if (visited >= 20000) { truncated = true; break; }
      }
    }
    let gitAvailable = false;
    try { await stat(join(dir, '.git')); gitAvailable = true; } catch {}
    return {
      gitAvailable,
      repositoryVisibility: 'unknown',
      fileCount,
      fileCountIsLowerBound: truncated,
      testFileCount,
      changedFileCount: 0,
      changedFileScanTruncated: false,
    };
  } catch {
    return zero;
  }
}
