// Stand-in chrome API for the built popup and Settings pages, injected by
// tests/dom/popup.test.mjs into a copy of dist/ (never shipped). It supplies
// placeholder data, runs scripted keyboard actions (?do=... for renders,
// ?kbtest=1 for the keyboard and scroll test) and leaves results on <body
// data-...> for Chrome --dump-dom: data-kb (the steps), data-fit
// (scrollHeight/innerHeight) and data-content (the page content height).
(function () {
  var p = new URLSearchParams(location.search), sc = p.get('scenario') || 'ok', act = p.get('do')
  var w = p.get('w'); if (w) document.documentElement.style.width = w + 'px'
  if (p.get('bg') === 'm') document.documentElement.style.background = '#ff00ff'
  if (p.get('showfocus')) {
    // Headless Chrome doesn't treat scripted focus as keyboard focus, so
    // :focus-visible never matches; this draws the app's own focus ring.
    var st = document.createElement('style')
    st.textContent = 'a:focus,button:focus{outline:2px solid #2563eb;outline-offset:2px}.dd-item:focus{outline-offset:-2px}'
    document.head.appendChild(st)
  }
  var never = new Promise(function () {})
  function later(v, ms) { return new Promise(function (r) { setTimeout(function () { r(v) }, ms || 40) }) }
  function app(id, company, title, location, rv, day, status) {
    return { id: id, company: company, title: title, location: location, url: 'https://jobs.example.com/' + company.toLowerCase().replace(/[^a-z0-9]+/g, '-'), date: new Date('2026-09-' + day + 'T10:00:00-04:00').toISOString(), resumeVersion: rv, status: status, sheetName: 'Sheet1', rowNumber: 2 }
  }
  var apps = [
    app('a1', 'Northwind Robotics', 'Software Engineer Intern', 'Austin, TX', 'SWE v3', '12', 'Applied'),
    app('a2', 'Juniper & Co', 'Product Engineer Intern, Growth and Monetization', 'San Francisco, CA', 'SWE v1', '11', 'Applied'),
    app('a3', 'Harborview Health', 'Full Stack Developer', 'Boston, MA', 'SWE v3', '10', 'Cancelled'),
    app('a4', 'Cedar Grove Analytics', 'Data Engineering Intern', 'Remote', 'DE v2', '08', 'Applied'),
    app('a5', 'Bluefin Labs', 'Machine Learning Engineer Intern', 'Greater Toronto Area, Canada', 'SWE v2', '03', 'Applied')
  ]
  var live = { a1: 'Applied', a2: 'Interview', a4: 'Interview', a5: 'Applied' }
  var signedOut = sc === 'signedout'
  // The connected sheet in Drive's trash, or deleted (2026-09-14).
  var sheetGone = sc === 'trashed' || sc === 'missing'
  var closed = false
  window.close = function () { closed = true; document.body.dataset.closed = '1' }
  window.chrome = {
    storage: {
      local: { get: function (key) {
        if (key === 'sheetRef') return later({ sheetRef: { spreadsheetId: 'placeholder', sheetName: 'Sheet1', sheetId: 0 } })
        if (key === 'authStatus') return later(signedOut ? { authStatus: { since: '2026-09-13T15:00:00Z', reason: 'placeholder' } } : {})
        if (key === 'sheetStatus') return later(sheetGone ? { sheetStatus: { state: sc, since: '2026-09-14T15:00:00Z', reason: 'placeholder' } } : {})
        if (key === 'offlineQueue') return later(signedOut || sheetGone ? { offlineQueue: [{}, {}] } : {})
        if (key === 'lastResumeVersionByRoleType') return later({ lastResumeVersionByRoleType: { SWE: 'SWE v3', DE: 'DE v2' } })
        return later({ recentApplications: apps })
      } },
      onChanged: { addListener: function () {}, removeListener: function () {} }
    },
    tabs: { create: function () { return later({}) } },
    runtime: {
      getManifest: function () { return { version: '1.0.0' } },
      getURL: function (s) { return s },
      openOptionsPage: function () {},
      sendMessage: function (m) {
        var entry = m.payload && apps.find(function (a) { return a.id === m.payload.entryId })
        if (m.type === 'GET_LIVE_STATUSES') return later(signedOut ? { ok: false, error: 'Google sign-in needed', code: 'AUTH_REQUIRED' } : { ok: true, data: live }, 120)
        if (m.type === 'SET_STATUS') {
          if (sc === 'busy') return never
          if (sc === 'stale') return later({ ok: false, error: 'mismatch', code: 'STALE_ROW' }, 120)
          return later({ ok: true, data: Object.assign({}, entry, { status: m.payload.status }) }, 120)
        }
        if (m.type === 'SAVE_RESUME_VERSION') {
          if (sc === 'editerr') return later({ ok: false, error: 'mismatch', code: 'STALE_ROW' }, 120)
          return later({ ok: true, data: Object.assign({}, entry, { resumeVersion: m.payload.resumeVersion }) }, 120)
        }
        if (m.type === 'RECONNECT_PROVIDER') return later({ ok: true, data: { saved: 0, waiting: 0 } })
        return later({ ok: true, data: undefined })
      }
    }
  }

  function key(el, k) { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function q(s) { return document.querySelector(s) }
  function chip(i) { return document.querySelectorAll('.chip-btn')[i] }
  function more(id) { return document.getElementById('more-' + id) }
  function name(el) { return el ? (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 70) : null }
  async function ready() {
    for (var i = 0; i < 60; i++) { if (q('.chip-btn') || q('form.editor') || q('.window-note')) return; await wait(50) }
  }

  async function keyboardTest() {
    var out = []
    function rec(step, ok, detail) { out.push({ step: step, ok: !!ok, focus: detail }) }
    var m = more('a1'); m.focus(); key(m, 'ArrowDown'); await wait(80)
    rec('ArrowDown on ⋯ opens the menu, focus on its first item', q('[role=menu]') && document.activeElement.textContent.includes('Change resume version'), name(document.activeElement))
    key(document.activeElement, 'ArrowDown'); await wait(40)
    rec('ArrowDown moves to Open job posting', document.activeElement.textContent.includes('Open job posting'), name(document.activeElement))
    key(document.activeElement, 'ArrowDown'); await wait(40)
    rec('ArrowDown wraps to the first item', document.activeElement.textContent.includes('Change resume version'), name(document.activeElement))
    key(document.activeElement, 'End'); await wait(40)
    rec('End jumps to the last item', document.activeElement.textContent.includes('Open job posting'), name(document.activeElement))
    key(document.activeElement, 'Home'); await wait(40)
    rec('Home jumps to the first item', document.activeElement.textContent.includes('Change resume version'), name(document.activeElement))
    key(document.activeElement, 'Escape'); await wait(60)
    rec('Esc closes the menu and returns focus to ⋯', !q('[role=menu]') && document.activeElement === m, name(document.activeElement))
    var c = chip(0); c.focus(); key(c, 'ArrowDown'); await wait(80)
    rec('ArrowDown on the status chip opens the list on the current status', q('[role=listbox]') && document.activeElement.getAttribute('aria-selected') === 'true' && document.activeElement.textContent.includes('Applied'), name(document.activeElement))
    key(document.activeElement, 'ArrowDown'); await wait(40)
    rec('ArrowDown moves to Interview', document.activeElement.textContent.includes('Interview'), name(document.activeElement))
    key(document.activeElement, 'Enter'); await wait(300)
    rec('Enter picks Interview: list closed, focus back on the chip, which now reads Interview', !q('[role=listbox]') && document.activeElement === chip(0) && chip(0).textContent.includes('Interview'), name(document.activeElement))
    var c2 = chip(1); c2.focus(); key(c2, 'ArrowDown'); await wait(80); key(document.activeElement, 'ArrowDown'); await wait(40); key(document.activeElement, 'Escape'); await wait(60)
    rec('Esc closes the status list without changing the status', !q('[role=listbox]') && document.activeElement === c2 && c2.textContent.includes('Interview'), name(document.activeElement))
    m = more('a1'); m.focus(); key(m, 'ArrowDown'); await wait(80); key(document.activeElement, 'Enter'); await wait(150)
    rec('Enter on Change resume version opens the editor, focus in the input', q('form.editor') && document.activeElement.id === 'resume-version' && document.activeElement.value === 'SWE v3', name(document.activeElement))
    key(document.activeElement, 'Escape'); await wait(150)
    rec('Esc in the editor returns to the list, focus on that row\'s ⋯', !q('form.editor') && document.activeElement === more('a1'), name(document.activeElement))
    // The menus are fixed: scrolling the list must close them. The five
    // rows don't overflow the list, so cap its height here (test only) to
    // make it really scroll.
    // Headless --dump-dom renders no frames, and Chrome delivers scroll
    // events while rendering a frame, so after the real scrollTop change the
    // test also dispatches the scroll event itself. It records whether a
    // native one arrived first.
    var list = q('.list'); list.style.maxHeight = '240px'; await wait(60)
    var nativeScrolls = 0; list.addEventListener('scroll', function (e) { if (e.isTrusted) nativeScrolls++ })
    m = more('a1'); m.focus(); key(m, 'ArrowDown'); await wait(80)
    var menuOpened = !!q('[role=menu]')
    list.scrollTop = 80; await wait(150); var nativeAfterScroll = nativeScrolls; var scrolledTo = list.scrollTop
    list.dispatchEvent(new Event('scroll')); await wait(80)
    rec('Scrolling the list closes an open ⋯ menu, focus back on ⋯, scrollTop unchanged', menuOpened && !q("[role=menu]") && scrolledTo > 0 && list.scrollTop === scrolledTo && document.activeElement === m, name(document.activeElement) + ' | opened ' + menuOpened + ', open now ' + !!q('[role=menu]') + ', scrollTop ' + list.scrollTop + ', scrollHeight ' + list.scrollHeight + ', clientHeight ' + list.clientHeight + ', native scroll events ' + nativeAfterScroll)
    list.scrollTop = 0; await wait(150)
    c = chip(0); c.focus(); key(c, 'ArrowDown'); await wait(80)
    var listOpened = !!q('[role=listbox]')
    list.scrollTop = 80; await wait(150); var scrolledTo2 = list.scrollTop
    list.dispatchEvent(new Event("scroll")); await wait(80)
    rec('Scrolling the list closes an open status list, focus back on the chip, scrollTop unchanged', listOpened && !q("[role=listbox]") && scrolledTo2 > 0 && list.scrollTop === scrolledTo2 && document.activeElement === c, name(document.activeElement) + ' | opened ' + listOpened + ', open now ' + !!q('[role=listbox]') + ', scrollTop ' + list.scrollTop)
    document.body.dataset.kb = JSON.stringify(out)
  }

  window.addEventListener('load', async function () {
    await ready(); await wait(300)
    if (act === 'focus') more('a1').focus()
    if (act === 'menu') { more('a2').focus(); key(more('a2'), 'ArrowDown') }
    if (act === 'status') { chip(0).focus(); key(chip(0), 'ArrowDown'); await wait(80); key(document.activeElement, 'ArrowDown') }
    if (act === 'choose') {
      var i = Number(p.get('row') || 0)
      chip(i).focus(); key(chip(i), 'ArrowDown'); await wait(80); key(document.activeElement, 'ArrowDown'); await wait(40); key(document.activeElement, 'Enter')
    }
    if (act === 'editor') { more('a1').focus(); key(more('a1'), 'ArrowDown'); await wait(80); key(document.activeElement, 'Enter') }
    if (act === 'save') { await wait(100); q('form.editor').requestSubmit() }
    if (p.get('kbtest')) await keyboardTest()
    await wait(400)
    document.body.dataset.fit = document.documentElement.scrollHeight + '/' + window.innerHeight + (closed ? '/closed' : '')
    document.body.dataset.content = String(Math.ceil(document.body.getBoundingClientRect().height))
    // The popup's banner text, and the status chips: all of them and the
    // disabled ones (disabled or aria-disabled).
    var banner = q('.banner')
    document.body.dataset.banner = banner ? banner.textContent.replace(/\s+/g, ' ').trim() : ''
    var chips = document.querySelectorAll('.chip-btn')
    var disabledChips = document.querySelectorAll('.chip-btn:disabled, .chip-btn[aria-disabled="true"]')
    document.body.dataset.chips = disabledChips.length + '/' + chips.length
  })
})()
