// Stand-in chrome API for the built popup and Settings pages, injected by
// tests/dom/popup.test.mjs into a copy of dist/ (never shipped). It supplies
// placeholder data, runs scripted keyboard actions (?do=... for renders,
// ?kbtest=1 for the keyboard and scroll test) and leaves results on <body
// data-...> for Chrome --dump-dom: data-kb (the steps), data-fit
// (scrollHeight/innerHeight), data-content (the page content height), and
// since 2026-09-15 the list, summary line, note editor, theme colours and
// horizontal overflow (see the end of this file).
(function () {
  var p = new URLSearchParams(location.search), sc = p.get('scenario') || 'ok', act = p.get('do')
  var w = p.get('w'); if (w) document.documentElement.style.width = w + 'px'
  if (p.get('bg') === 'm') document.documentElement.style.background = '#ff00ff'
  if (p.get('showfocus')) {
    // Headless Chrome doesn't treat scripted focus as keyboard focus, so
    // :focus-visible never matches; this draws the app's own focus ring.
    var st = document.createElement('style')
    st.textContent = 'a:focus,button:focus{outline:2px solid var(--focus);outline-offset:2px}.dd-item:focus{outline-offset:-2px}'
    document.head.appendChild(st)
  }
  var never = new Promise(function () {})
  // Answers still in flight, so the capture at the end waits for the page to
  // be quiet instead of for a number of milliseconds (2026-09-16).
  var pending = 0
  function later(v, ms) {
    pending++
    return new Promise(function (r) { setTimeout(function () { pending--; r(v) }, ms || 40) })
  }
  // Dates relative to today, so the summary line ("this week") has something
  // to count on any day: n days ago, at that hour.
  function daysAgo(n, hour) { var d = new Date(); d.setDate(d.getDate() - n); d.setHours(hour, 0, 0, 0); return d.toISOString() }
  function slug(company) { return company.toLowerCase().replace(/[^a-z0-9]+/g, '-') }
  function app(id, company, title, location, rv, ago, status) {
    return { id: id, company: company, title: title, location: location, url: 'https://jobs.example.com/' + slug(company), date: daysAgo(ago, 10), resumeVersion: rv, status: status, sheetName: 'Sheet1', rowNumber: 2 }
  }
  var apps = [
    app('a1', 'Northwind Robotics', 'Software Engineer Intern', 'Austin, TX', 'SWE v3', 0, 'Applied'),
    app('a2', 'Juniper & Co', 'Product Engineer Intern, Growth and Monetization', 'San Francisco, CA', 'SWE v1', 1, 'Applied'),
    app('a3', 'Harborview Health', 'Full Stack Developer', 'Boston, MA', 'SWE v3', 2, 'Cancelled'),
    app('a4', 'Cedar Grove Analytics', 'Data Engineering Intern', 'Remote', 'DE v2', 4, 'Applied'),
    app('a5', 'Bluefin Labs', 'Machine Learning Engineer Intern', 'Greater Toronto Area, Canada', 'SWE v2', 9, 'Applied')
  ]
  var live = { a1: 'Applied', a2: 'Interview', a4: 'Interview', a5: 'Applied' }
  // Two applications waiting in the offline queue (signed out, the sheet in
  // the trash or deleted, or offline): rows with the sheet's column names.
  function queued(company, title, location, rv, ago, hour, logId) {
    return { Date: daysAgo(ago, hour), Company: company, Title: title, Location: location, URL: 'https://jobs.example.com/' + slug(company), 'Resume Version': rv, Status: '', Notes: '', 'Log ID': logId }
  }
  var queue = [
    queued('Silverline Systems', 'Backend Engineer Intern', 'Chicago, IL', 'SWE v3', 0, 11, 'q1'),
    queued('Orchard Street Games', 'Gameplay Programmer Intern', 'Montreal, QC', 'SWE v1', 1, 18, 'q2')
  ]
  var NOTE = 'Met their recruiter at the career fair. Follow up next week if no reply.'
  var signedOut = sc === 'signedout'
  // The connected sheet in Drive's trash, or deleted (2026-09-14).
  var sheetGone = sc === 'trashed' || sc === 'missing'
  var offline = sc === 'offline'
  var closed = false
  window.close = function () { closed = true; document.body.dataset.closed = '1' }
  window.chrome = {
    storage: {
      local: { get: function (key) {
        if (key === 'sheetRef') return later({ sheetRef: { spreadsheetId: 'placeholder', sheetName: 'Sheet1', sheetId: 0 } })
        if (key === 'authStatus') return later(signedOut ? { authStatus: { since: '2026-09-13T15:00:00Z', reason: 'placeholder' } } : {})
        if (key === 'sheetStatus') return later(sheetGone ? { sheetStatus: { state: sc, since: '2026-09-14T15:00:00Z', reason: 'placeholder' } } : {})
        if (key === 'offlineQueue') return later(signedOut || sheetGone || offline ? { offlineQueue: queue } : {})
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
        // The note editor (2026-09-15): the row's Notes cell, and the save,
        // refused as NOTE_CHANGED in the notechanged scenario.
        if (m.type === 'GET_NOTE') return later({ ok: true, data: { note: NOTE } }, 80)
        if (m.type === 'SAVE_NOTE') {
          if (sc === 'notechanged') return later({ ok: false, error: 'changed', code: 'NOTE_CHANGED' }, 120)
          return later({ ok: true, data: { note: m.payload.note } }, 120)
        }
        if (m.type === 'RECONNECT_PROVIDER') return later({ ok: true, data: { saved: 0, waiting: 0 } })
        return later({ ok: true, data: undefined })
      }
    }
  }

  function key(el, k) { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  // Every step waits for the condition it actually needs — the menu open,
  // focus moved, the editor gone — never for a fixed number of milliseconds
  // (2026-09-16; the background tests dropped their fixed waits in f4e6bd6
  // for the same reason). A condition that never comes true fails the step
  // with what it was waiting for, instead of racing the machine.
  var DEADLINE_MS = 4000
  function until(label, test) {
    return new Promise(function (resolve, reject) {
      var started = Date.now()
      ;(function poll() {
        var value = false
        try { value = test() } catch (err) { value = false }
        if (value) return resolve(value)
        if (Date.now() - started >= DEADLINE_MS) {
          return reject(new Error('timed out after ' + DEADLINE_MS + 'ms waiting for ' + label))
        }
        setTimeout(poll, 10)
      })()
    })
  }
  // For a recorded step: the outcome plus, on a timeout, what it waited for.
  async function reached(label, test) {
    try {
      await until(label, test)
      return { ok: true, detail: name(document.activeElement) }
    } catch (err) {
      return { ok: false, detail: err.message + ' | focus: ' + name(document.activeElement) }
    }
  }
  // The page is quiet: the stub has answered every message it was given and
  // React has rendered the result. Never fails — the 'busy' scenario leaves
  // an answer outstanding on purpose.
  async function quiet() {
    try { await until('the stub to answer every message', function () { return pending === 0 }) } catch (err) { /* busy scenario */ }
    await wait(0)
    await wait(0)
  }
  function q(s) { return document.querySelector(s) }
  function chip(i) { return document.querySelectorAll('.chip-btn')[i] }
  function more(id) { return document.getElementById('more-' + id) }
  function name(el) { return el ? (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 70) : null }
  async function ready() {
    try {
      await until('the page to render', function () { return q('.chip-btn') || q('form.editor') || q('.window-note') || q('.card') || q('.empty') })
    } catch (err) {
      console.warn('[stub] ' + err.message)
    }
  }
  // Opens a1's ⋯ menu and picks "Add note", its second item.
  async function openNote() {
    more('a1').focus()
    key(more('a1'), 'ArrowDown')
    await until('the ⋯ menu to open', function () { return q('[role=menu]') })
    key(document.activeElement, 'ArrowDown')
    await until('Add note to take focus', function () { return document.activeElement.textContent.indexOf('Add note') !== -1 })
    key(document.activeElement, 'Enter')
    await until('the note editor to open', function () { return q('form.editor') })
  }

  async function keyboardTest() {
    var out = []
    var res
    function rec(step, outcome) { out.push({ step: step, ok: !!outcome.ok, focus: outcome.detail }) }
    var active = function () { return document.activeElement }
    var activeIs = function (text) { return function () { return active().textContent.indexOf(text) !== -1 } }

    var m = more('a1'); m.focus(); key(m, 'ArrowDown')
    res = await reached('the ⋯ menu to open on Change resume version', function () { return q('[role=menu]') && active().textContent.indexOf('Change resume version') !== -1 })
    rec('ArrowDown on ⋯ opens the menu, focus on its first item', res)

    key(active(), 'ArrowDown')
    res = await reached('Add note to take focus', activeIs('Add note'))
    rec('ArrowDown moves to Add note', res)

    key(active(), 'ArrowDown')
    await reached('Open job posting to take focus', activeIs('Open job posting'))
    key(active(), 'ArrowDown')
    res = await reached('focus to wrap to the first item', activeIs('Change resume version'))
    rec('ArrowDown past Open job posting wraps to the first item', res)

    key(active(), 'End')
    res = await reached('End to move focus to the last item', activeIs('Open job posting'))
    rec('End jumps to the last item', res)

    key(active(), 'Home')
    res = await reached('Home to move focus to the first item', activeIs('Change resume version'))
    rec('Home jumps to the first item', res)

    key(active(), 'Escape')
    res = await reached('the menu to close with focus back on ⋯', function () { return !q('[role=menu]') && active() === m })
    rec('Esc closes the menu and returns focus to ⋯', res)

    var c = chip(0); c.focus(); key(c, 'ArrowDown')
    res = await reached('the status list to open on the current status', function () {
      return q('[role=listbox]') && active().getAttribute('aria-selected') === 'true' && active().textContent.indexOf('Applied') !== -1
    })
    rec('ArrowDown on the status chip opens the list on the current status', res)

    key(active(), 'ArrowDown')
    res = await reached('Interview to take focus', activeIs('Interview'))
    rec('ArrowDown moves to Interview', res)

    key(active(), 'Enter')
    res = await reached('the status to be saved, the list closed and the chip to read Interview', function () {
      return !q('[role=listbox]') && active() === chip(0) && chip(0).textContent.indexOf('Interview') !== -1
    })
    rec('Enter picks Interview: list closed, focus back on the chip, which now reads Interview', res)

    var c2 = chip(1); c2.focus(); key(c2, 'ArrowDown')
    await reached('the second row\'s status list to open', function () { return q('[role=listbox]') })
    key(active(), 'ArrowDown')
    key(active(), 'Escape')
    res = await reached('the list to close with the status unchanged', function () {
      return !q('[role=listbox]') && active() === c2 && c2.textContent.indexOf('Interview') !== -1
    })
    rec('Esc closes the status list without changing the status', res)

    m = more('a1'); m.focus(); key(m, 'ArrowDown')
    await reached('the ⋯ menu to open', function () { return q('[role=menu]') })
    key(active(), 'Enter')
    res = await reached('the resume editor to open with focus in its input', function () {
      return q('form.editor') && active().id === 'resume-version' && active().value === 'SWE v3'
    })
    rec('Enter on Change resume version opens the editor, focus in the input', res)

    key(active(), 'Escape')
    res = await reached('the list to come back with focus on that row\'s ⋯', function () { return !q('form.editor') && active() === more('a1') })
    rec('Esc in the editor returns to the list, focus on that row\'s ⋯', res)

    // The menus are fixed: scrolling the list must close them. The five rows
    // don't overflow the list, so cap its height here (test only) to make it
    // really scroll.
    // Headless --dump-dom renders no frames, and Chrome delivers scroll
    // events while rendering a frame, so after the real scrollTop change the
    // test also dispatches the scroll event itself. It records whether a
    // native one arrived first.
    var list = q('.list'); list.style.maxHeight = '240px'
    await reached('the capped list to overflow', function () { return list.scrollHeight > list.clientHeight })
    var nativeScrolls = 0
    list.addEventListener('scroll', function (e) { if (e.isTrusted) nativeScrolls++ })

    m = more('a1'); m.focus(); key(m, 'ArrowDown')
    await reached('the ⋯ menu to open before scrolling', function () { return q('[role=menu]') })
    list.scrollTop = 80
    list.dispatchEvent(new Event('scroll'))
    res = await reached('the scroll to close the ⋯ menu, with focus back on ⋯ and the list still scrolled', function () {
      return !q('[role=menu]') && list.scrollTop === 80 && active() === m
    })
    res.detail += ' | scrollHeight ' + list.scrollHeight + ', clientHeight ' + list.clientHeight + ', native scroll events ' + nativeScrolls
    rec('Scrolling the list closes an open ⋯ menu, focus back on ⋯, scrollTop unchanged', res)

    list.scrollTop = 0
    c = chip(0); c.focus(); key(c, 'ArrowDown')
    await reached('the status list to open before scrolling', function () { return q('[role=listbox]') })
    list.scrollTop = 80
    list.dispatchEvent(new Event('scroll'))
    res = await reached('the scroll to close the status list, with focus back on the chip and the list still scrolled', function () {
      return !q('[role=listbox]') && list.scrollTop === 80 && active() === c
    })
    rec('Scrolling the list closes an open status list, focus back on the chip, scrollTop unchanged', res)

    document.body.dataset.kb = JSON.stringify(out)
  }

  window.addEventListener('load', async function () {
    await ready()
    await quiet()
    if (act === 'focus') more('a1').focus()
    if (act === 'menu') {
      more('a2').focus()
      key(more('a2'), 'ArrowDown')
      await until('the ⋯ menu to open', function () { return q('[role=menu]') })
    }
    if (act === 'status' || act === 'choose') {
      var i = act === 'choose' ? Number(p.get('row') || 0) : 0
      chip(i).focus()
      key(chip(i), 'ArrowDown')
      await until('the status list to open', function () { return q('[role=listbox]') })
      key(document.activeElement, 'ArrowDown')
      await until('Interview to take focus', function () { return document.activeElement.textContent.indexOf('Interview') !== -1 })
      if (act === 'choose') {
        key(document.activeElement, 'Enter')
        await until('the status list to close', function () { return !q('[role=listbox]') })
      }
    }
    if (act === 'editor') {
      more('a1').focus()
      key(more('a1'), 'ArrowDown')
      await until('the ⋯ menu to open', function () { return q('[role=menu]') })
      key(document.activeElement, 'Enter')
      await until('the resume editor to open', function () { return q('form.editor') })
    }
    if (act === 'save') {
      await until('the resume editor to open', function () { return q('form.editor') })
      q('form.editor').requestSubmit()
    }
    if (act === 'note') await openNote()
    if (act === 'notesave') {
      await openNote()
      await until('the note to load into the editor', function () { var t = q('#note'); return t && !t.readOnly })
      q('form.editor').requestSubmit()
    }
    if (p.get('kbtest')) await keyboardTest()
    await quiet()
    var data = document.body.dataset
    data.fit = document.documentElement.scrollHeight + '/' + window.innerHeight + (closed ? '/closed' : '')
    data.content = String(Math.ceil(document.body.getBoundingClientRect().height))
    // The popup's banner text, and the status chips: all of them and the
    // disabled ones (disabled or aria-disabled).
    var banner = q('.banner')
    data.banner = banner ? banner.textContent.replace(/\s+/g, ' ').trim() : ''
    var chips = document.querySelectorAll('.chip-btn')
    var disabledChips = document.querySelectorAll('.chip-btn:disabled, .chip-btn[aria-disabled="true"]')
    data.chips = disabledChips.length + '/' + chips.length
    // Since 2026-09-15: waiting rows (all / those with a status menu or ⋯),
    // the list's order (W: marks a waiting row), the summary line, the note
    // editor, the page background and the first Applied chip's colours, and
    // the page's horizontal overflow (scrollWidth/clientWidth).
    var waitingRows = document.querySelectorAll('.row.waiting')
    data.waiting = waitingRows.length + '/' + [].filter.call(waitingRows, function (r) { return r.querySelector('.more, .chip-btn') }).length
    data.order = [].map.call(document.querySelectorAll('.list > li'), function (li) {
      var co = li.querySelector('.co'); return (li.classList.contains('waiting') ? 'W:' : '') + (co ? co.childNodes[0].textContent : '')
    }).slice(0, 4).join('|')
    var sum = q('.sum'); data.sum = sum ? sum.textContent.replace(/\s+/g, ' ').trim() : ''
    var note = q('#note'); data.note = note ? note.value : ''
    var err = q('.err'); data.err = err ? err.textContent.trim() : ''
    data.editor = q('form.editor') ? '1' : '0'
    data.bg = getComputedStyle(document.body).backgroundColor
    var applied = q('.chip-applied'); data.chip = applied ? getComputedStyle(applied).backgroundColor + ' ' + getComputedStyle(applied).color : ''
    data.sw = document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth
  })
})()
