// Real gap this closes: no fetch() call anywhere in googleSheets.ts,
// excel.ts, or msAuth.ts had a timeout — confirmed via grep before this
// file existed. A stalled request (dead proxy, hung connection accepted
// but never answered) blocks the calling await forever, which is exactly
// what let a second chrome.alarms-triggered drainOfflineQueue() start
// concurrently and double-append queued rows (real repro, see CLAUDE.md's
// offline-queue notes).
//
// 30s: comfortably above any real Sheets/Graph/token-endpoint call this
// project has actually observed (Phase 3/6/8 testing — normal calls
// complete in low single digits of seconds, including createSheet's
// multi-step Excel formatting sequence), and comfortably below both
// ceilings that matter for the drain re-entrancy bug specifically —
// chrome.alarms' 5-minute RETRY_ALARM_NAME period (so a stuck request
// always fails and unblocks a drain well before a second alarm could ever
// fire concurrently) and Chrome's own documented 5-minute single-request
// service-worker kill threshold. A deliberate safety margin under both,
// not a number picked to exactly match either.
export const FETCH_TIMEOUT_MS = 30_000

// Real, reviewer-caught gap in an earlier version of this file: a plain
// `finally { clearTimeout(timer) }` right after `await fetch(...)` only
// bounds the connect/header phase — fetch()'s own promise settles the
// moment response headers arrive, before any of this file's callers
// (apiFetch/graphFetch/requestToken) have read the body via their own,
// separate `await res.text()`/`res.json()` call. A server that sends
// headers immediately and then stalls the body (slow drip, half-open
// proxy) cleared the timer before that stall even started, leaving it
// exactly as unbounded as having no timeout at all — the same failure
// mode this file exists to close, just moved one layer deeper. Confirmed
// for real against Node's actual fetch/undici and a real local HTTP
// server that sends headers then never calls res.end(): the naive
// version's res.text() was still unresolved 6x past its timeout; this
// fixed version's res.text() rejected with a real AbortError right at the
// timeout boundary.
//
// Fixed by keeping the same timer (and the same AbortController/signal
// already attached to the in-flight request) alive past the initial
// fetch() call, and only clearing it once the body is actually consumed —
// via a Proxy over the returned Response that intercepts exactly
// `text()`/`json()` (the only two body-reading methods any caller in this
// codebase uses) and clears the timer in their own `finally`, once they
// settle. Every other Response property/method (`ok`, `status`, `headers`,
// ...) passes through unchanged via Reflect.get. Aborting mid-body-read
// correctly rejects a pending text()/json() call with a real AbortError —
// confirmed against Node's real fetch, not assumed from the spec — so the
// same single 30s deadline now covers the full request lifecycle,
// connection through body, not just until headers arrive.
//
// Real, reviewer-caught bug in an earlier version of this trap: the
// passthrough branch called `Reflect.get(target, prop, receiver)` with
// `receiver` (the Proxy itself) as the third argument — the `this` a
// branded getter runs against. `Response.ok`/`.status`/`.headers` are
// WebIDL-branded accessors that check their `this` is a genuine Response
// with real internal slots and throw "Illegal invocation" otherwise; a
// Proxy is not that, so every property read except the two explicitly
// special-cased ones (`text`/`json`, which bind to `target` directly and
// were never affected) threw in real Chrome. Node's fetch (undici) is
// receiver-agnostic here and never enforces this brand check, which is
// exactly why three earlier Node-only verification passes (a local Node
// HTTP server, Node's own fetch, this same file bundled and run under
// Node) all passed clean while this was still broken — confirmed missed
// for that specific reason, not fixed blind. Fixed by reading off `target`
// instead of `receiver`; verified in a real Chrome tab, not Node (below).
function wrapResponseBody(res: Response, timer: ReturnType<typeof setTimeout>): Response {
  return new Proxy(res, {
    get(target, prop) {
      if (prop === 'text' || prop === 'json') {
        const original = (target[prop] as () => Promise<unknown>).bind(target)
        return async (...args: unknown[]) => {
          try {
            return await (original as (...a: unknown[]) => Promise<unknown>)(...args)
          } finally {
            clearTimeout(timer)
          }
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// No current caller passes its own `signal` — if one ever needs to
// (e.g. a future cancellable operation), this will need to combine
// signals rather than silently overriding one; not needed today.
export async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const res = await fetch(url, { ...init, signal: controller.signal })
  return wrapResponseBody(res, timer)
}
