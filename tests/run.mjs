// npm test: bundles each tests/*.test.ts with esbuild (it comes with Vite)
// and runs them with node:test, then the popup DOM test in headless Chrome
// (tests/dom/popup.test.mjs), which skips itself when Chrome isn't found.
//   npm test             Node tests and the DOM test
//   npm run test:node    Node tests only (CI)
// No dependencies beyond the repo's own.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TESTS = path.join(ROOT, 'tests')
const OUT = path.join(ROOT, 'node_modules', '.tmp', 'tests')
const nodeOnly = process.argv.includes('--node-only')

fs.rmSync(OUT, { recursive: true, force: true })
const entries = fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(TESTS, f))
await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
})

const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.mjs')).map((f) => path.join(OUT, f))
if (!nodeOnly) files.push(path.join(TESTS, 'dom', 'popup.test.mjs'))
const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: ROOT, stdio: 'inherit' })
process.exit(run.status ?? 1)
