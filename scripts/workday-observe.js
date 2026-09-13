// Workday observation snippet (read-only). Not part of the extension build.
//
// Purpose: capture what Workday's final Submit control and its post-submit
// confirmation look like, so Workday support can be built from evidence
// (see CLAUDE.md and the Workday design notes). Used once, during one of
// Ryan's real applications.
//
// How to use:
// 1. On the application's final Review page, BEFORE clicking Submit, open
//    DevTools on that Workday tab (Console) and paste PART A. Chrome may ask
//    you to type "allow pasting" the first time.
// 2. Click Submit yourself. Neither part ever clicks anything.
// 3. Once Workday shows its confirmation, paste PART B in the same Console.
// 4. Each part prints JSON and copies it to the clipboard. Skim it for your
//    name or email before sharing it; a Review-page heading or a
//    confirmation line can include them.
// 5. Never commit the output. Any test fixture derived from it must be
//    scrubbed first.
//
// Both parts are strictly read-only: no clicks, dispatched events, network
// requests, storage or DOM changes, and no form field values are read.

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
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight)
  const out = {
    phase: 'A: Review page, before Submit',
    path: location.pathname,
    documentLoadedAt: new Date(performance.timeOrigin).toISOString(),
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
  const out = {
    phase: 'B: after Submit',
    path: location.pathname,
    queryParamNames: [...new URLSearchParams(location.search).keys()],
    // Same value as PART A means Workday stayed in one page (no full reload).
    documentLoadedAt: new Date(performance.timeOrigin).toISOString(),
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
  console.log('PART B copied to the clipboard. Paste both parts back.')
})()
