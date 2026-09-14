// Workday observation snippet (read-only). Not part of the extension build.
//
// Purpose: capture what Workday's Apply control, final Submit control and
// post-submit confirmation look like, so the Workday parser's Submit
// selector (a placeholder until then, parsers/workday.ts) can be pinned from
// evidence (CLAUDE.md, Site parsers, Workday). Used once, during one of
// Ryan's real applications. Any build of the extension can be loaded, or
// none: nothing here depends on it.
//
// How to use:
// 1. On the job's posting page, BEFORE clicking Apply, open DevTools on that
//    Workday tab (Console) and paste PART 0. Chrome may ask you to type
//    "allow pasting" the first time.
// 2. Click Apply yourself and go through the application as usual.
// 3. On the final Review page, BEFORE clicking Submit, paste PART A.
// 4. Click Submit yourself. None of the parts ever clicks anything.
// 5. Once Workday shows its confirmation, paste PART B in the same Console.
// 6. Each part prints JSON and copies it to the clipboard. Skim it for your
//    name or email before sharing it; a Review-page heading or a
//    confirmation line can include them.
// 7. Never commit the output. Any test fixture derived from it must be
//    scrubbed first.
//
// Would the extension's in-memory capture survive to Submit? Its content
// script keeps the posting (read at the Apply click) in memory, which lasts
// as long as the document does. So compare documentLoadedAt: the same value
// in PART 0 and PART A means no full page load between Apply and the Review
// page, and the capture would still be there at Submit. A different value
// means a reload (a sign-in, say); the extension then falls back to reading
// the job's JSON, which needs PART A's path to still contain /job/. PART B's
// value against PART A's says whether Submit itself reloaded the page.
//
// All parts are strictly read-only: no clicks, dispatched events, network
// requests, storage or DOM changes, and no form field values are read. Each
// also records the page language and every iframe's host and path (never
// its content).

// ===== Workday observation, PART 0 =====
// Run in the DevTools Console on the posting page, BEFORE clicking Apply.
(() => {
  const short = (s, n = 60) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const attrs = (el) =>
    Object.fromEntries(
      [...el.attributes]
        .filter((a) => !['class', 'style', 'value'].includes(a.name) && !a.name.startsWith('on'))
        .map((a) => [a.name, a.value.slice(0, 80)]),
    )
  const frameOf = (f) => {
    try {
      const u = new URL(f.src, location.href)
      return u.host + u.pathname
    } catch {
      return '(no src)'
    }
  }
  const out = {
    phase: '0: posting page, before Apply',
    path: location.pathname,
    documentLoadedAt: new Date(performance.timeOrigin).toISOString(),
    lang: document.documentElement.lang,
    iframes: [...document.querySelectorAll('iframe')].map(frameOf),
    // The Apply control(s): the parser expects [data-automation-id="adventureButton"].
    applyControls: [...document.querySelectorAll('[data-automation-id="adventureButton"], a[role="button"], button')]
      .filter((el) => /apply/i.test(el.textContent || '') || el.getAttribute('data-automation-id') === 'adventureButton')
      .map((el) => ({ tag: el.tagName, text: short(el.innerText), attrs: attrs(el) })),
  }
  const json = JSON.stringify(out, null, 2)
  console.log(json)
  if (typeof copy === 'function') copy(json)
  console.log('PART 0 copied to the clipboard. Now click Apply yourself; run PART A on the Review page.')
})()

// ===== Workday observation, PART A =====
// Run in the DevTools Console on the final Review page, BEFORE clicking Submit.
// Strictly read-only: it only reads attributes, short button/heading labels and
// data-automation-id values. No clicks, no network requests, no storage, no DOM
// changes, and it never reads what's typed into form fields.
(() => {
  const short = (s, n = 60) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const attrs = (el) =>
    Object.fromEntries(
      [...el.attributes]
        .filter((a) => !['class', 'style', 'value'].includes(a.name) && !a.name.startsWith('on'))
        .map((a) => [a.name, a.value.slice(0, 80)]),
    )
  const frameOf = (f) => {
    try {
      const u = new URL(f.src, location.href)
      return u.host + u.pathname
    } catch {
      return '(no src)'
    }
  }
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight)
  const out = {
    phase: 'A: Review page, before Submit',
    // Still containing /job/{location}/{slug}_{reqId} means the job JSON
    // fallback can find the job.
    path: location.pathname,
    // Same value as PART 0 means no full page load since the posting page:
    // the in-memory capture would survive to Submit.
    documentLoadedAt: new Date(performance.timeOrigin).toISOString(),
    lang: document.documentElement.lang,
    iframes: [...document.querySelectorAll('iframe')].map(frameOf),
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3')].map((h) => short(h.innerText)).filter(Boolean).slice(0, 12),
    // Every visible control: tag, label and attributes (data-automation-id, type, aria-*).
    controls: [...document.querySelectorAll('button, [role="button"], input[type="submit"], a[data-automation-id]')]
      .filter(visible)
      .map((el) => ({ tag: el.tagName, text: short(el.innerText), attrs: attrs(el) })),
    // Step / progress indicator, however Workday marks it.
    steps: [...document.querySelectorAll('[data-automation-id*="progress" i], [data-automation-id*="step" i], [aria-current="step"], [aria-current="page"]')]
      .map((el) => ({ automationId: el.getAttribute('data-automation-id'), ariaCurrent: el.getAttribute('aria-current'), text: short(el.innerText, 160) }))
      .slice(0, 12),
    automationIds: [...new Set([...document.querySelectorAll('[data-automation-id]')].map((e) => e.getAttribute('data-automation-id')))],
  }
  const json = JSON.stringify(out, null, 2)
  console.log(json)
  if (typeof copy === 'function') copy(json)
  console.log('PART A copied to the clipboard. Now click Submit yourself, wait for the confirmation, then run PART B.')
})()

// ===== Workday observation, PART B =====
// Run in the same tab AFTER Submit, once Workday shows its confirmation.
// Same read-only rules as PART A. Keeps only short texts that look like a
// success message, never the page's full text.
(() => {
  const short = (s, n = 120) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const success = /submitted|thank|received|success|applied|complete/i
  const automationIdOf = (el) => (el.closest('[data-automation-id]') || { getAttribute: () => null }).getAttribute('data-automation-id')
  const frameOf = (f) => {
    try {
      const u = new URL(f.src, location.href)
      return u.host + u.pathname
    } catch {
      return '(no src)'
    }
  }
  const out = {
    phase: 'B: after Submit',
    path: location.pathname,
    queryParamNames: [...new URLSearchParams(location.search).keys()],
    // Same value as PART A means Workday stayed in one page (no full reload).
    documentLoadedAt: new Date(performance.timeOrigin).toISOString(),
    lang: document.documentElement.lang,
    iframes: [...document.querySelectorAll('iframe')].map(frameOf),
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3')].map((h) => short(h.innerText, 80)).filter(Boolean).slice(0, 12),
    successTexts: [...document.querySelectorAll('h1, h2, h3, h4, p, span, div, li')]
      .filter((el) => el.children.length === 0 && success.test(el.textContent))
      .map((el) => ({ tag: el.tagName, automationId: automationIdOf(el), text: short(el.textContent) }))
      .slice(0, 15),
    liveRegions: [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')]
      .map((el) => ({ role: el.getAttribute('role'), ariaLive: el.getAttribute('aria-live'), automationId: el.getAttribute('data-automation-id'), text: short(el.textContent) }))
      .slice(0, 10),
    automationIds: [...new Set([...document.querySelectorAll('[data-automation-id]')].map((e) => e.getAttribute('data-automation-id')))],
  }
  const json = JSON.stringify(out, null, 2)
  console.log(json)
  if (typeof copy === 'function') copy(json)
  console.log('PART B copied to the clipboard. Paste all three parts back.')
})()
