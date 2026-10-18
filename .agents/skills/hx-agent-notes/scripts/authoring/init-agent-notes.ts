import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
/**
 * Delegate installation to the strict project setup
 * .agents/notes/implemented/process/2026-10-07-agent-notes-ast-redline.md
 */
function main(): void {
  const script = fileURLToPath(new URL('../setup/install.py', import.meta.url))
  const result = spawnSync('uv', ['run', script, ...process.argv.slice(2)], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 2)

}

main()
