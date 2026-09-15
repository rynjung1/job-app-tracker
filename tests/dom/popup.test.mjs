// The built popup in headless Chrome, with the stand-in chrome API from
// stub.js: the keyboard and scroll steps (menu, status list, resume editor)
// and the Edit window's fit. Skipped with a message when Chrome isn't
// found; set CHROME_PATH to point at a Chrome or Chromium binary.
//
// Runs with --dump-dom: headless Chrome loads each page, the stub runs its
// script and leaves results on <body data-...>, and this file parses them.
// That mode renders no frames, so the stub dispatches scroll events itself
// after really scrolling the list (see stub.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
// background/index.ts opens the Edit window 404px tall; the macOS title bar
// takes about 28px of that.
const EDIT_WINDOW_INNER_HEIGHT = 376

function which(cmd) {
  const found = spawnSync('which', [cmd], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which),
].find((p) => p && fs.existsSync(p))

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' }

function serve(dir) {
  const server = http.createServer((req, res) => {
    const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
      res.end(buf)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// Loads a page in headless Chrome and returns the stub's <body data-...>.
function dumpBody(url, windowSize, profile) {
  return new Promise((resolve) => {
    let html = ''
    const args = ['--headless=new', `--user-data-dir=${profile}`, `--window-size=${windowSize}`, '--virtual-time-budget=8000', '--dump-dom', url]
    if (process.platform === 'linux') args.unshift('--no-sandbox')
    const chrome = spawn(CHROME, args)
    // Headless Chrome can sit idle after printing the DOM, so stop it as
    // soon as the whole page has arrived; the timer is only a backstop.
    chrome.stdout.on('data', (chunk) => {
      html += chunk
      if (html.includes('</html>')) chrome.kill('SIGKILL')
    })
    // The backstop is reported, not hidden: a page that "left no result"
    // because Chrome was stopped here says so in the assertion message.
    let stoppedByBackstop = false
    const timer = setTimeout(() => {
      stoppedByBackstop = true
      chrome.kill('SIGKILL')
    }, 30_000)
    chrome.on('exit', () => {
      clearTimeout(timer)
      const attr = (name) => {
        const m = html.match(new RegExp(`<body[^>]*data-${name}="([^"]*)"`))
        return m ? m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null
      }
      const why = stoppedByBackstop ? ' (headless Chrome was stopped by the 30s backstop before printing the page)' : ''
      resolve({ kb: attr('kb'), fit: attr('fit'), content: attr('content'), banner: attr('banner'), chips: attr('chips'), why })
    })
  })
}

test('popup in headless Chrome', { skip: CHROME ? false : 'headless Chrome not found (set CHROME_PATH to run the DOM test)' }, async (t) => {
  const build = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--logLevel', 'error'], { cwd: ROOT, stdio: 'inherit' })
  assert.equal(build.status, 0, 'vite build failed')

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'job-app-tracker-dom-'))
  const site = path.join(work, 'site')
  fs.cpSync(path.join(ROOT, 'dist'), site, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'tests', 'dom', 'stub.js'), path.join(site, 'stub.js'))
  for (const page of ['popup', 'options']) {
    const file = path.join(site, 'src', page, 'index.html')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<head>', '<head><script src="/stub.js"></script>'))
  }
  const server = await serve(site)
  const base = `http://127.0.0.1:${server.address().port}/src/popup/index.html`
  try {
    const keyboard = await dumpBody(`${base}?w=368&kbtest=1`, '500,700', path.join(work, 'profile-kb'))
    assert.ok(keyboard.kb, `the keyboard test left no results on the page${keyboard.why}`)
    const steps = JSON.parse(keyboard.kb)
    assert.equal(steps.length, 14, 'expected 14 keyboard and scroll steps')
    for (const step of steps) await t.test(step.step, () => assert.ok(step.ok, `focus: ${step.focus}`))

    const fits = [
      ['Edit window fits its inner height, no scrolling', 'edit=a1&w=380'],
      ['Edit window with the longest error still fits', 'edit=a1&w=380&scenario=editerr&do=save'],
    ]
    for (const [name, query] of fits) {
      const page = await dumpBody(`${base}?${query}`, '500,900', path.join(work, `profile-${fits.indexOf(name)}`))
      const content = Number(page.content)
      await t.test(name, () =>
        assert.ok(content > 0 && content <= EDIT_WINDOW_INNER_HEIGHT, `content ${content}px, window inner height ${EDIT_WINDOW_INNER_HEIGHT}px${page.why}`),
      )
    }

    // A sheet in Drive's trash, or deleted (2026-09-14): the banner per state,
    // and no status chip can write.
    for (const [scenario, title] of [
      ['trashed', "Your sheet is in Google Drive's trash"],
      ['missing', 'Your sheet was deleted'],
    ]) {
      const page = await dumpBody(`${base}?w=368&scenario=${scenario}`, '500,700', path.join(work, `profile-${scenario}`))
      await t.test(`sheet ${scenario}: the banner says "${title}", 2 waiting and Open Settings; every status chip is disabled`, () => {
        assert.ok(page.banner?.includes(title) && page.banner.includes('2 applications are waiting') && page.banner.includes('Open Settings'), `banner: ${page.banner}`)
        const [disabled, total] = (page.chips ?? '0/0').split('/').map(Number)
        assert.ok(total > 0 && disabled === total, `disabled chips ${page.chips}`)
      })
    }
  } finally {
    server.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})
