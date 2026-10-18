import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const script = fileURLToPath(new URL('../setup/new_note.py', import.meta.url))
const result = spawnSync('uv', ['run', script, ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 2)
