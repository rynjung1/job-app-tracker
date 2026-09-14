// The real lib/fetchWithTimeout.ts against Node's real fetch and a local
// HTTP server. The deadline timer (FETCH_TIMEOUT_MS) is held here instead
// of scheduled, so each case fires it itself rather than waiting 20s; every
// other timer runs normally.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { FETCH_TIMEOUT_MS, fetchWithTimeout } from '../src/lib/fetchWithTimeout'

type Held = { ms: number; fire: () => void; cleared: boolean }
const held: Held[] = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
;(globalThis as any).setTimeout = (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
  if (ms !== FETCH_TIMEOUT_MS) return realSetTimeout(fn, ms, ...args)
  const timer: Held = { ms, fire: () => fn(...args), cleared: false }
  held.push(timer)
  return timer
}
;(globalThis as any).clearTimeout = (timer: any) => {
  if (held.includes(timer)) timer.cleared = true
  else realClearTimeout(timer)
}

// /no-headers never answers; /stalled-body sends headers and part of a body,
// then nothing; /ok answers in full.
const server = http.createServer((req, res) => {
  if (req.url === '/no-headers') return
  if (req.url === '/stalled-body') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"partial":')
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"ok":1}')
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => realSetTimeout(r, 5))
}

test('fetchWithTimeout', async (t) => {
  await t.test('the deadline is 20s, under the 30s after which Chrome stops a worker waiting on a fetch response', () => {
    assert.equal(FETCH_TIMEOUT_MS, 20_000)
  })

  await t.test('no response headers: the deadline aborts the request (AbortError)', async () => {
    held.length = 0
    const pending = fetchWithTimeout(`${base}/no-headers`)
    await until(() => held.length === 1)
    assert.equal(held[0]?.ms, 20_000)
    held[0].fire()
    await assert.rejects(pending, { name: 'AbortError' })
  })

  await t.test('headers then a stalled body: the same deadline still runs after headers and aborts the body read', async () => {
    held.length = 0
    const res = await fetchWithTimeout(`${base}/stalled-body`)
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.equal(held.length, 1)
    assert.equal(held[0].cleared, false, 'the timer must not be cleared when headers arrive')
    const body = res.text()
    held[0].fire()
    await assert.rejects(body, { name: 'AbortError' })
    assert.equal(held[0].cleared, true, 'cleared once the body read settles')
  })

  await t.test('a normal response: the body is read and the timer cleared', async () => {
    held.length = 0
    const res = await fetchWithTimeout(`${base}/ok`)
    assert.deepEqual(await res.json(), { ok: 1 })
    assert.equal(held.length, 1)
    assert.equal(held[0].cleared, true)
  })

  server.closeAllConnections()
  server.close()
})
