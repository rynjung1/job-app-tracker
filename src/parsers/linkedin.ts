import type { JobPageParser, JobPostingData } from './types'

// Deliberately broad rather than enumerating known path segments (view,
// search-results, collections, ...) — a prior version enumerated
// "search" and missed the real "/jobs/search-results/" split-pane path,
// so detect() silently never fired there.
const JOB_PAGE_PATH = /^\/jobs\//

interface JobPostingJsonLd {
  '@type'?: string
  title?: string
  hiringOrganization?: { name?: string }
  jobLocation?: {
    address?: {
      addressLocality?: string | null
      addressRegion?: string | null
      addressCountry?: string | null
    }
  }
}

// LinkedIn embeds schema.org/JobPosting JSON-LD for SEO on the LOGGED-OUT
// guest template only — confirmed absent (0 script tags) on the real
// authenticated SPA page, which is the only page this content script ever
// runs on. This path is effectively dead in practice; kept as free
// insurance in case a future LinkedIn build reintroduces it, not because
// it's expected to fire. extractFromDom() below is the real primary path.
function readJobPostingJsonLd(doc: Document): JobPostingJsonLd | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]')
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? '') as JobPostingJsonLd
      if (data && data['@type'] === 'JobPosting') return data
    } catch {
      // Not valid JSON, or not the JobPosting block (LinkedIn also emits an
      // ItemList block on some pages) — try the next script tag.
    }
  }
  return null
}

function formatLocation(jsonLd: JobPostingJsonLd): string | null {
  const address = jsonLd.jobLocation?.address
  if (!address) return null
  const parts = [address.addressLocality, address.addressRegion, address.addressCountry].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  )
  return parts.length > 0 ? parts.join(', ') : null
}

// document.title carries title/company on /jobs/view/ pages, and since
// LinkedIn's /jobs/search-results/ layout (checked live 2026-09-14) on the
// search page too, for the selected job. The older split pane left it as
// the search page's title ("(20) software engineer intern Jobs | LinkedIn"),
// so on any ?currentJobId= page it's only a fallback, used when it names the
// same title as the job's own link (see extractSelectedJob).
// Format confirmed on one real posting: "{Title} | {Company} | LinkedIn".
// Anchored from the END rather than a naive 3-way split, since a job title
// can itself contain " | " (e.g. "Engineer | Backend Team"), which would
// corrupt a left-to-right split — the trailing "LinkedIn" literal and the
// company segment right before it are far less likely to contain a pipe.
// Only confirmed against one real posting so far — needs 2-3 more before
// this pattern counts as settled, per the working agreement.
function parseDocumentTitle(doc: Document): { title?: string; company?: string } {
  const parts = doc.title.split(' | ')
  if (parts.length < 3 || parts[parts.length - 1] !== 'LinkedIn') return {}
  const company = parts[parts.length - 2]?.trim()
  const title = parts
    .slice(0, parts.length - 2)
    .join(' | ')
    .trim()
  return { title: title || undefined, company: company || undefined }
}

const AGO_PATTERN = /\bago$/i
const APPLICANTS_PATTERN = /applicant/i

// The authenticated page has NO stable attribute for location — no class,
// id, aria-*, data-*, or title attribute distinguishes it from its two
// siblings (date-posted, applicant-count), which all share the exact same
// two hashed classes (confirmed via direct DOM inspection on a real
// posting). This is the most fragile piece of this parser: it depends on
// DOM structure and text shape in a purely decorative metadata row with no
// accessibility or SEO reason to stay stable. Most likely thing to
// silently break on a future LinkedIn redesign — if location extraction
// stops working, look here first.
//
// Anchored on the company-profile link (a[href*="/company/"]) rather than
// a fixed number of parentElement hops, since exact nesting depth isn't
// guaranteed to stay fixed either — searches outward from it, level by
// level, for the first ancestor containing a "X ago" text node, which is
// what actually identifies the metadata row.
function findLocationSiblingSpans(companyLink: Element): Element[] | null {
  let ancestor: Element | null = companyLink.parentElement
  for (let i = 0; i < 6 && ancestor; i++, ancestor = ancestor.parentElement) {
    const agoSpan = Array.from(ancestor.querySelectorAll('span')).find((span) =>
      AGO_PATTERN.test(span.textContent?.trim() ?? ''),
    )
    if (agoSpan?.parentElement) {
      return Array.from(agoSpan.parentElement.children).filter((el) => el.tagName === 'SPAN')
    }
  }
  return null
}

// Content-shape validation, not pure position: rejects candidates that
// look like the two known non-location siblings, rather than blindly
// trusting "first span" — degrades to null (not a wrong guess) if the
// order ever changes or location is absent (e.g. some remote postings).
function extractLocationFromDom(companyLink: Element | null): string | null {
  if (!companyLink) return null
  const spans = findLocationSiblingSpans(companyLink)
  if (!spans) return null
  const location = spans
    .map((el) => el.textContent?.trim() ?? '')
    .find((text) => text.length > 0 && !AGO_PATTERN.test(text) && !APPLICANTS_PATTERN.test(text))
  return location || null
}

// No stable class/id/aria/data attribute exists anywhere on the
// authenticated SPA (confirmed via direct DOM inspection) — h1 count is 0,
// every class is hashed/atomic CSS, JSON-LD doesn't exist here at all (see
// readJobPostingJsonLd comment above). Every field below comes from a
// signal that isn't DOM styling: document.title for title, with the
// company-profile link preferred over document.title's company segment
// when both are available (a single clean string beats depending on the
// pipe-split heuristic holding), and structural/content-shape inference
// for location (see findLocationSiblingSpans — the most fragile piece of
// this parser).
function extractFromDom(doc: Document): { title?: string; company?: string; location?: string | null } {
  const { title, company: titleCompany } = parseDocumentTitle(doc)
  const companyLink = doc.querySelector('a[href*="/company/"]')
  const company = companyLink?.textContent?.trim() || titleCompany
  const location = extractLocationFromDom(companyLink)
  return { title, company, location }
}

// Split-pane search results carry the job ID only in ?currentJobId=, not
// the path — naively stripping query params (as this used to do
// unconditionally) collapsed every split-pane application to the same
// generic /jobs/search-results/ URL, a real confirmed bug, not
// hypothetical. Reconstruct the canonical per-job URL from the ID in that
// case; direct /jobs/view/{id}/ pages already carry the ID in the path
// and are untouched by this branch.
function resolveCanonicalJobUrl(url: URL): string {
  const currentJobId = url.searchParams.get('currentJobId')
  if (currentJobId) {
    return `https://www.linkedin.com/jobs/view/${currentJobId}/`
  }
  return url.href.split('?')[0]
}

// Any search layout that keeps the selected job in ?currentJobId= (the old
// split pane at /jobs/search/, /jobs/collections/, ..., and the
// /jobs/search-results/ layout LinkedIn's main job search serves since
// 2026-09). /jobs/view/ pages are excluded explicitly so their proven
// extraction path is never touched. Digits only, since the id goes into a
// CSS selector below.
function selectedJobId(url: URL): string | null {
  if (url.pathname.startsWith('/jobs/view/')) return null
  const id = url.searchParams.get('currentJobId')
  return id && /^\d+$/.test(id) ? id : null
}

const RESULTS_CARD = '[data-occludable-job-id]'
const EASY_APPLY_SELECTOR = 'a[href*="/jobs/view/"][href*="/apply/"], [aria-label^="Easy Apply to"]'
const COMPANY_LINK = 'a[href*="/company/"]'

function collapsedText(el: Element | null | undefined): string {
  return el?.textContent?.trim().replace(/\s+/g, ' ') ?? ''
}

// The job id in a /jobs/view/{id}/... link, or null.
function jobIdOf(href: string | null): string | null {
  return href?.match(/\/jobs\/view\/(\d+)(?:[/?#]|$)/)?.[1] ?? null
}

// Rendered with a box: false for display:none, hidden, and detached copies.
// A document without layout (none here in practice) reports every element
// hidden, and then every candidate counts.
function isRendered(el: Element): boolean {
  return el.getClientRects().length > 0
}

// The selected job's title link and the pane around it. Rewritten
// 2026-09-14 for LinkedIn's /jobs/search-results/ layout, which has no <h1>
// at all (checked live, read-only, on posting 4464201438): the title is
// <p><a href="/jobs/view/{id}/">Title</a></p> in the detail pane. So the
// title is the rendered link to /jobs/view/{id}/ that isn't the /apply/ link
// and isn't inside a results card, and its pane is the nearest ancestor that
// also holds the Easy Apply control. A results-list link for the same job
// can match too (the new layout's cards have no data-occludable-job-id), but
// its nearest ancestor holding an Easy Apply control is much higher up, so
// the link with the innermost pane wins. The old split pane's <h1> title
// link is found the same way.
function findSelectedJob(doc: Document, jobId: string): { titleLink: Element; pane: Element } | null {
  const links = Array.from(doc.querySelectorAll(`a[href*="/jobs/view/${jobId}"]`)).filter((a) => {
    const href = a.getAttribute('href')
    return jobIdOf(href) === jobId && !href?.includes('/apply/') && !a.closest(RESULTS_CARD) && collapsedText(a) !== ''
  })
  const rendered = links.filter(isRendered)
  let best: { titleLink: Element; pane: Element } | null = null
  for (const titleLink of rendered.length > 0 ? rendered : links) {
    let pane: Element | null = titleLink.parentElement
    while (pane && !pane.querySelector(EASY_APPLY_SELECTOR)) pane = pane.parentElement
    if (pane && (!best || best.pane.contains(pane))) best = { titleLink, pane }
  }
  return best
}

// The "{location} · {n} days ago · {n} applicants" row, in both layouts:
// the new one is one <p> of text, the old split pane separate <span>s
// ("Markham, ON", "·", "1 week ago", "·", "65 applicants"). The shortest
// element whose text has a " · " and an "ago" is that row; its first part
// that isn't the age or the applicant count is the location. Null if there's
// no such row or no location-shaped part (e.g. a non-English UI, where
// "ago" differs).
function extractMetaRowLocation(scope: Element): string | null {
  const rows = Array.from(scope.querySelectorAll('p, span, div, li'))
    .map((el) => collapsedText(el))
    .filter((text) => text.includes('·') && /\bago\b/i.test(text) && text.length <= 200)
    .sort((a, b) => a.length - b.length)
  for (const text of rows) {
    const location = text
      .split('·')
      .map((part) => part.trim())
      .find((part) => part.length > 0 && !AGO_PATTERN.test(part) && !APPLICANTS_PATTERN.test(part))
    if (location) return location
  }
  return null
}

// A ?currentJobId= page (both search layouts). Fails safe, as before: if the
// detail pane hasn't loaded, or shows a different job than ?currentJobId=,
// this returns null (no row) rather than logging the wrong job.
// - title: the selected job's own link (findSelectedJob).
// - company and location: from inside its pane only, the nearest ancestor of
//   the title link (up to the pane) that holds a company link with text.
// - fallback: document.title's "Title | Company | LinkedIn" when the pane has
//   no company link, but only when that title part is exactly the link's
//   text, so a stale search-page title can't produce a wrong row.
function extractSelectedJob(doc: Document, jobId: string, url: URL): JobPostingData | null {
  const found = findSelectedJob(doc, jobId)
  if (!found) return null
  const { titleLink, pane } = found
  // A pane holding results cards is the list, not a detail pane; an Easy
  // Apply link for another job means the pane shows a different job.
  if (pane.querySelector(RESULTS_CARD)) return null
  const applyHrefs = Array.from(pane.querySelectorAll(EASY_APPLY_SELECTOR))
    .map((el) => el.getAttribute('href'))
    .filter((href): href is string => href !== null)
  if (applyHrefs.some((href) => jobIdOf(href) !== jobId)) return null

  const title = collapsedText(titleLink)
  let scope: Element | null = null
  for (let el = titleLink.parentElement; el; el = el === pane ? null : el.parentElement) {
    if (Array.from(el.querySelectorAll(COMPANY_LINK)).some((a) => collapsedText(a))) {
      scope = el
      break
    }
  }
  let company = scope ? collapsedText(Array.from(scope.querySelectorAll(COMPANY_LINK)).find((a) => collapsedText(a))) : ''
  if (!company) {
    const fromTitle = parseDocumentTitle(doc)
    if (fromTitle.title === title && fromTitle.company) company = fromTitle.company
  }
  if (!title || !company) return null

  const location = extractMetaRowLocation(scope ?? pane)
  return { title, company, location, url: resolveCanonicalJobUrl(url) }
}

// The whole extraction for a page, given its document and address. The
// content script calls it (through linkedinParser.extract) at click time;
// tests call it on fixture documents at any LinkedIn address.
export function extractLinkedInJob(doc: Document, href: string): JobPostingData | null {
  const url = new URL(href)
  const jobId = selectedJobId(url)
  if (jobId) return extractSelectedJob(doc, jobId, url)

  const jsonLd = readJobPostingJsonLd(doc)

  let title = typeof jsonLd?.title === 'string' ? jsonLd.title.trim() : undefined
  let company =
    typeof jsonLd?.hiringOrganization?.name === 'string'
      ? jsonLd.hiringOrganization.name.trim()
      : undefined
  let location = jsonLd ? formatLocation(jsonLd) : null

  if (!title || !company || !location) {
    const domFallback = extractFromDom(doc)
    title = title ?? domFallback.title
    company = company ?? domFallback.company
    location = location ?? domFallback.location ?? null
  }

  if (!title || !company) return null

  return { title, company, location, url: resolveCanonicalJobUrl(url) }
}

export const linkedinParser: JobPageParser = {
  siteId: 'linkedin',

  // No container-class check — this page's classes are hashed/atomic CSS
  // with no stable or semantic names (confirmed via real DOM inspection,
  // not assumed). The only call site (content/linkedin.ts's click listener)
  // runs this at click time, after the click has already matched the Apply
  // selector, so a coarser URL-only check here doesn't create a correctness
  // risk.
  detect() {
    return JOB_PAGE_PATH.test(window.location.pathname)
  },

  extract() {
    return extractLinkedInJob(document, window.location.href)
  },

  getApplyButtonSelector() {
    // Re-checked 2026-09-11 (read-only, 5 live Easy Apply pages + 1 off-site):
    // LinkedIn changed the label from "LinkedIn Apply to this job" to
    // "Easy Apply to ...", so the old a[aria-label^="LinkedIn Apply"] matched
    // nothing. Three markups seen:
    // - /jobs/view/ (3 of 4): <a aria-label="Easy Apply to this job"> with
    //   href /jobs/view/{id}/apply/; the href half matches it in any UI
    //   language.
    // - /jobs/view/ (1 of 4): <button aria-label="Easy Apply to this job">,
    //   no href, only hashed classes; only the English label identifies it.
    // - split-pane search: <button id="jobs-apply-button-id"
    //   aria-label="Easy Apply to {title} at {company}">; English label only.
    //   The id can't be used: the split pane's off-site Apply button shares
    //   it ("Apply to {title} on company website", checked live 2026-09-11).
    // Easy-Apply-only scope still holds: "Apply on company website" goes
    // through /safety/go/ with a percent-encoded target, and its label
    // doesn't start with "Easy Apply to", so it matches neither half.
    // The /jobs/search-results/ layout (2026-09-14) uses the link variant,
    // <a aria-label="Easy Apply to this job" href="/jobs/view/{id}/apply/">.
    return EASY_APPLY_SELECTOR
  },
}
