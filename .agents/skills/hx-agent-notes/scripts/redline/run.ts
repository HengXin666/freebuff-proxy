import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function runGate(args: string[]): never {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const result = spawnSync('uv', ['run', '--with-requirements', here + 'requirements.txt',
    'python', here + 'verify.py', ...args], { stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 2)
}
