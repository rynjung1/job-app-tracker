// Dark mode (2026-09-15): src/ui/tokens.css defines every colour twice, on
// :root (light) and under prefers-color-scheme: dark. This reads the file
// and checks, in both themes, every text/background pair the popup and
// Settings use (4.5:1 or better) and every focus ring and the Waiting chip's
// border against what they sit on (3:1 or better); that both themes define
// the same tokens; and that popup.css and options.css take every colour from
// a token, so nothing stays light in the dark theme.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// npm test runs from the repo root (tests/run.mjs).
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const tokensCss = read('src/ui/tokens.css')
const DARK = '@media (prefers-color-scheme: dark)'

function block(css: string, from: number): string {
  const open = css.indexOf(':root {', from)
  return css.slice(open, css.indexOf('}', open))
}
function vars(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}
const light = vars(block(tokensCss, 0))
const dark = vars(block(tokensCss, tokensCss.indexOf(DARK)))

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

const TEXT = 4.5
const UI = 3
// [what, foreground token, background token, minimum]
const PAIRS: Array<[string, string, string, number]> = [
  ['body text', 'text', 'bg', TEXT],
  ['title and location', 'text-2', 'bg', TEXT],
  ['meta, dates', 'muted', 'bg', TEXT],
  ['Settings section heading', 'heading', 'bg', TEXT],
  ['menu item', 'text', 'surface', TEXT],
  ['menu footnote', 'muted', 'surface', TEXT],
  ['info banner, app card', 'text-2', 'subtle', TEXT],
  ['muted on subtle (footer, app card meta)', 'muted', 'subtle', TEXT],
  ['company on the app card', 'text', 'subtle', TEXT],
  ['links, Open sheet', 'brand-text', 'bg', TEXT],
  ['link on a surface', 'brand-text', 'surface', TEXT],
  ['Open sheet hovered', 'brand-text', 'active-bg', TEXT],
  ['primary button', 'on-brand', 'brand', TEXT],
  ['primary button hovered', 'on-brand', 'brand-hover', TEXT],
  ['secondary button', 'btn-text', 'surface', TEXT],
  ['secondary button hovered', 'btn-text', 'hover', TEXT],
  ['icons', 'icon', 'bg', TEXT],
  ['menu icons', 'icon', 'surface', TEXT],
  ['inline error', 'danger', 'bg', TEXT],
  ['saved notice, ticks', 'ok', 'bg', TEXT],
  ['sign-in banner', 'warn-text', 'warn-bg', TEXT],
  ['amber card text', 'text-2', 'warn-bg', TEXT],
  ['amber card title', 'text', 'warn-bg', TEXT],
  ['error alert', 'alert-text', 'alert-bg', TEXT],
  ['active menu item', 'active-text', 'active-bg', TEXT],
  ['active menu item icon', 'active-icon', 'active-bg', TEXT],
  ['chip Applied', 'chip-applied', 'chip-applied-bg', TEXT],
  ['chip Interview', 'chip-interview', 'chip-interview-bg', TEXT],
  ['chip Offer', 'chip-offer', 'chip-offer-bg', TEXT],
  ['chip Rejected', 'chip-rejected', 'chip-rejected-bg', TEXT],
  ['chip Cancelled', 'chip-cancelled', 'chip-cancelled-bg', TEXT],
  ['chip, any other value', 'chip-neutral', 'chip-neutral-bg', TEXT],
  ['chip Waiting', 'wait-text', 'bg', TEXT],
  ['focus ring on the page', 'focus', 'bg', UI],
  ['focus ring on a menu', 'focus', 'surface', UI],
  ['focus ring on subtle', 'focus', 'subtle', UI],
  ['focus ring on the amber banner', 'focus', 'warn-bg', UI],
  ['focus ring on an active item', 'focus', 'active-bg', UI],
  ['Waiting chip border', 'wait-border', 'bg', UI],
]

test('colour tokens, both themes', async (t) => {
  await t.test('light and dark define the same tokens', () => {
    assert.ok(Object.keys(light).length > 40, `light tokens: ${Object.keys(light).length}`)
    assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort())
  })
  for (const [what, fg, bg, min] of PAIRS) {
    await t.test(`${what}: ${fg} on ${bg} >= ${min}:1 in both themes`, () => {
      for (const [theme, tokens] of [['light', light], ['dark', dark]] as const) {
        assert.match(tokens[fg] ?? '', /^#[0-9a-f]{6}$/, `${theme} --${fg}`)
        assert.match(tokens[bg] ?? '', /^#[0-9a-f]{6}$/, `${theme} --${bg}`)
        const r = ratio(tokens[fg], tokens[bg])
        assert.ok(r >= min, `${theme}: ${r.toFixed(2)}:1 (${tokens[fg]} on ${tokens[bg]})`)
      }
    })
  }
  await t.test('popup.css, options.css and tokens.css rules take every colour from a token, and every token they use exists', () => {
    const rules = {
      'src/popup/popup.css': read('src/popup/popup.css'),
      'src/options/options.css': read('src/options/options.css'),
      'src/ui/tokens.css (rules)': tokensCss.slice(tokensCss.indexOf('}', tokensCss.indexOf(':root {', tokensCss.indexOf(DARK))) + 1),
    }
    for (const [file, css] of Object.entries(rules)) {
      const literal = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)
      assert.equal(literal, null, `${file} has colour literals: ${literal}`)
      for (const [, name] of css.matchAll(/var\(--([a-z0-9-]+)\)/g)) assert.ok(name in light, `${file} uses undefined --${name}`)
    }
  })
})
