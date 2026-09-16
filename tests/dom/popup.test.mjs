// The built popup in headless Chrome, with the stand-in chrome API from
// stub.js: the keyboard and scroll steps (menu, status list, resume editor)
// and the Edit window's fit; since 2026-09-15 also both themes, waiting
// applications, the summary line, the note editor, and Settings at its real
// 440px width. Skipped with a message when Chrome isn't found; set
// CHROME_PATH to point at a Chrome or Chromium binary.
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
// background/settingsWindow.ts's window width.
const SETTINGS_WIDTH = 440

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

// Loads a page in headless Chrome and returns the stub's <body data-...>
// values. The theme is set explicitly (light unless asked): with no setting,
// headless Chrome follows the machine's own appearance.
function dumpBody(url, windowSize, profile, theme = 'light') {
  return new Promise((resolve) => {
    let html = ''
    const args = [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--window-size=${windowSize}`,
      `--blink-settings=preferredColorScheme=${theme === 'dark' ? 0 : 1}`,
      '--virtual-time-budget=8000',
      '--dump-dom',
      url,
    ]
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
      const body = html.match(/<body([^>]*)>/)?.[1] ?? ''
      const data = {}
      for (const [, name, value] of body.matchAll(/data-([a-z]+)="([^"]*)"/g)) {
        data[name] = value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      }
      resolve({ ...data, why: stoppedByBackstop ? ' (headless Chrome was stopped by the 30s backstop before printing the page)' : '' })
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
  // Settings at exactly its window's width: headless windows can't be
  // narrower than 500px, so the page runs in a 440px iframe, a real 440px
  // viewport, and this page copies the stub's result from it.
  fs.writeFileSync(
    path.join(site, 'frame.html'),
    `<!doctype html><html><head><style>html,body{margin:0}iframe{display:block;border:0;width:${SETTINGS_WIDTH}px;height:900px}</style></head><body><iframe id="f"></iframe><script>
var f = document.getElementById('f'); f.src = new URLSearchParams(location.search).get('src')
var t = setInterval(function () { try { var b = f.contentDocument && f.contentDocument.body; if (b && b.dataset.sw) { clearInterval(t); document.body.dataset.sw = b.dataset.sw } } catch (e) {} }, 50)
</script></body></html>`,
  )
  const server = await serve(site)
  const origin = `http://127.0.0.1:${server.address().port}`
  const base = `${origin}/src/popup/index.html`
  const profile = (name) => path.join(work, `profile-${name}`)
  try {
    const keyboard = await dumpBody(`${base}?w=368&kbtest=1`, '500,700', profile('kb'))
    assert.ok(keyboard.kb, `the keyboard test left no results on the page${keyboard.why}`)
    const steps = JSON.parse(keyboard.kb)
    assert.equal(steps.length, 14, 'expected 14 keyboard and scroll steps')
    for (const step of steps) await t.test(step.step, () => assert.ok(step.ok, `focus: ${step.focus}`))

    const fits = [
      ['Edit window fits its inner height, no scrolling', 'edit=a1&w=380'],
      ['Edit window with the longest error still fits', 'edit=a1&w=380&scenario=editerr&do=save'],
    ]
    for (const [name, query] of fits) {
      const page = await dumpBody(`${base}?${query}`, '500,900', profile(`fit-${fits.indexOf(name)}`))
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
      const page = await dumpBody(`${base}?w=368&scenario=${scenario}`, '500,700', profile(scenario))
      await t.test(`sheet ${scenario}: the banner says "${title}", 2 waiting and Open Settings; every status chip is disabled`, () => {
        assert.ok(page.banner?.includes(title) && page.banner.includes('2 applications are waiting') && page.banner.includes('Open Settings'), `banner: ${page.banner}`)
        const [disabled, total] = (page.chips ?? '0/0').split('/').map(Number)
        assert.ok(total > 0 && disabled === total, `disabled chips ${page.chips}`)
      })
    }

    // Dark mode (2026-09-15): the tokens follow prefers-color-scheme.
    for (const [theme, bg, chip] of [
      ['light', 'rgb(255, 255, 255)', 'rgb(254, 249, 195) rgb(133, 77, 14)'],
      ['dark', 'rgb(17, 19, 24)', 'rgb(58, 48, 16) rgb(253, 230, 138)'],
    ]) {
      const page = await dumpBody(`${base}?w=368`, '500,700', profile(`theme-${theme}`), theme)
      await t.test(`${theme} theme: page background ${bg}; Applied chip background and text ${chip}`, () => {
        assert.equal(page.bg, bg)
        assert.equal(page.chip, chip)
      })
    }

    // Waiting applications and the summary line (2026-09-15).
    const waiting = await dumpBody(`${base}?w=368&scenario=offline`, '500,700', profile('waiting'))
    await t.test('offline with 2 queued: 2 Waiting rows with no status menu or ⋯, at their dates among the saved rows; the banner stays', () => {
      assert.equal(waiting.waiting, '2/0')
      assert.equal(waiting.order, 'W:Silverline Systems|Northwind Robotics|W:Orchard Street Games|Juniper & Co')
      assert.ok(waiting.banner.includes('2 applications waiting to be saved'), `banner: ${waiting.banner}`)
    })
    await t.test('summary line: "N this week · 2 interviews" (the two live Interview statuses)', () => {
      assert.match(waiting.sum, /^\d+\+? this week · 2 interviews$/)
    })

    // The note editor (2026-09-15).
    const note = await dumpBody(`${base}?w=368&do=note`, '500,700', profile('note'))
    await t.test('⋯ > Add note opens the note editor prefilled with the row\'s Notes cell (GET_NOTE)', () => {
      assert.equal(note.editor, '1')
      assert.equal(note.note, 'Met their recruiter at the career fair. Follow up next week if no reply.')
    })
    const changed = await dumpBody(`${base}?w=368&do=notesave&scenario=notechanged`, '500,700', profile('notechanged'))
    await t.test('Save note after the cell changed in the sheet: "This note changed in your sheet; reopen to see it.", editor stays open', () => {
      assert.equal(changed.err, 'This note changed in your sheet; reopen to see it.')
      assert.equal(changed.editor, '1')
    })
    const saved = await dumpBody(`${base}?w=368&do=notesave`, '500,700', profile('notesaved'))
    await t.test('Save note: the editor closes, back to the list', () => assert.equal(saved.editor, '0'))

    // Settings at its 440px window, every card state, both themes: no
    // horizontal scroll (scrollWidth <= clientWidth).
    for (const scenario of ['ok', 'signedout', 'trashed']) {
      for (const theme of ['light', 'dark']) {
        const src = encodeURIComponent(`${origin}/src/options/index.html?scenario=${scenario}`)
        const page = await dumpBody(`${origin}/frame.html?src=${src}`, '500,900', profile(`settings-${scenario}-${theme}`), theme)
        await t.test(`Settings at ${SETTINGS_WIDTH}px, ${scenario}, ${theme}: no horizontal scroll`, () => {
          const [scroll, client] = (page.sw ?? '').split('/').map(Number)
          assert.equal(client, SETTINGS_WIDTH, `clientWidth ${client}`)
          assert.ok(scroll <= client, `scrollWidth ${scroll} > clientWidth ${client}`)
        })
      }
    }
  } finally {
    server.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})
