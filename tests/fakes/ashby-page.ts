// A minimal Ashby application page for tests/ashbyContent.test.ts: a document
// whose click listeners the test can fire, the fields the parser reads, and
// chrome.runtime.sendMessage recorded. Ashby is a single-page app, so the
// test can move between its routes without a new content-script instance.
// Imported before src/content/ashby.ts, which registers on import.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const sent: unknown[] = []
export const clickListeners: Array<(event: any) => void> = []

export const POSTING_ID = '11111111-2222-4333-8444-555555555555'
const url = new URL(`https://jobs.ashbyhq.com/northwind/${POSTING_ID}/application`)
export function goTo(href: string) {
  url.href = new URL(href, url).href
}

export class FakeElement {
  constructor(private readonly isSubmitButton: boolean) {}
  closest(selector: string) {
    return this.isSubmitButton && selector === '.ashby-application-form-submit-button' ? this : null
  }
}
;(globalThis as any).Element = FakeElement

export const page = {
  title: ' Staff Security Engineer @ Northwind Robotics',
  heading: ' Staff Security Engineer',
  company: 'Northwind Robotics',
  location: 'New York, NY (HQ); Remote (US)',
}

;(globalThis as any).window = {
  location: {
    get href() {
      return url.href
    },
    get pathname() {
      return url.pathname
    },
    get hostname() {
      return url.hostname
    },
  },
}

;(globalThis as any).document = {
  get title() {
    return page.title
  },
  addEventListener: (type: string, listener: (event: any) => void, options: { capture?: boolean }) => {
    if (type === 'click' && options?.capture) clickListeners.push(listener)
  },
  querySelector: (selector: string) => {
    if (selector === 'h1.ashby-job-posting-heading') return page.heading ? { textContent: page.heading } : null
    if (selector === '.ashby-job-posting-header img[alt]') {
      return page.company ? { getAttribute: () => page.company } : null
    }
    if (selector === 'meta[property="og:url"]') {
      return { getAttribute: () => `https://jobs.ashbyhq.com/northwind/${POSTING_ID}` }
    }
    return null
  },
  querySelectorAll: (selector: string) =>
    selector === 'h2'
      ? [
          { textContent: 'Location', nextElementSibling: { textContent: page.location } },
          { textContent: 'Employment Type', nextElementSibling: { textContent: 'Full time' } },
        ]
      : [],
}

;(globalThis as any).chrome = {
  runtime: {
    id: 'testid',
    sendMessage: (message: unknown) => {
      sent.push(message)
    },
  },
}
