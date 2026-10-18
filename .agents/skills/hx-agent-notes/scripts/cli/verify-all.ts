import { runGate } from '../redline/run.ts'

/**
 * Run the same strict gate for the legacy command
 * .agents/notes/implemented/process/2026-10-07-agent-notes-ast-redline.md
 */
function main(): never {
  runGate(process.argv.slice(2))
}

main()
