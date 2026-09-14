// A minimal Workday page for tests/workdayContent.test.ts: window.location
// the test moves the way the single-page app does (same content script
// instance), a document whose posting elements come and go with the route,
// <html> attributes, chrome.runtime.sendMessage and fetch recorded. The
// real selectors against real markup are checked in headless Chrome
// (tests/dom/workday.test.mjs); here querySelector answers the parser's
// three posting selectors from `page.posting`.
// Imported before src/content/workday.ts, which registers on import.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const sent: unknown[] = []
export const fetches: string[] = []
export const clickListeners: Array<(event: any) => void> = []
export const htmlAttributes: Record<string, string> = {}
export const page = {
  // The posting page's title, first location and requisition id; null off it.
  posting: null as null | { title: string; location: string; reqId: string },
  // The next fetch's answer; null makes it fail like a network error.
  fetchAnswer: null as null | { status: number; body: unknown },
}

const url = new URL('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite')
// Stands in for the app's pushState: same page, same content script, new URL.
export function navigateInApp(href: string) {
  url.href = new URL(href, url).href
}

// closest() understands [data-automation-id="…"] selectors (optionally with a
// tag and in a comma list); anything else, ':not(*)' included, matches nothing.
export class FakeElement {
  constructor(
    readonly automationId: string | null,
    readonly textContent = '',
  ) {}
  closest(selector: string) {
    const matches = selector.split(',').some((part) => {
      const m = part.trim().match(/^[a-z]*\[data-automation-id="([^"]+)"\]$/)
      return m !== null && m[1] === this.automationId
    })
    return matches ? this : null
  }
}
;(globalThis as any).Element = FakeElement

;(globalThis as any).window = {
  location: {
    get href() {
      return url.href
    },
  },
}

;(globalThis as any).document = {
  documentElement: {
    setAttribute: (name: string, value: string) => {
      htmlAttributes[name] = value
    },
    getAttribute: (name: string) => htmlAttributes[name] ?? null,
  },
  addEventListener: (type: string, listener: (event: any) => void, options: { capture?: boolean }) => {
    if (type === 'click' && options?.capture) clickListeners.push(listener)
  },
  querySelector: (selector: string) => {
    const p = page.posting
    if (!p) return null
    if (selector === '[data-automation-id="jobPostingHeader"]') return new FakeElement('jobPostingHeader', p.title)
    if (selector === '[data-automation-id="locations"] dd') return new FakeElement(null, p.location)
    if (selector === '[data-automation-id="requisitionId"] dd') return new FakeElement(null, p.reqId)
    return null
  },
}

;(globalThis as any).chrome = {
  runtime: {
    id: 'testid',
    sendMessage: (message: unknown) => {
      sent.push(message)
    },
  },
}

;(globalThis as any).fetch = async (input: string) => {
  fetches.push(input)
  const answer = page.fetchAnswer
  if (!answer) throw new TypeError('Failed to fetch')
  return new Response(JSON.stringify(answer.body), { status: answer.status })
}
