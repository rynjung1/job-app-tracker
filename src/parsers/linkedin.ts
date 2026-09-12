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
function readJobPostingJsonLd(): JobPostingJsonLd | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]')
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

// document.title carries title/company on /jobs/view/ pages. It does NOT on
// the split-pane search view: there it stays the search page's title
// ("(20) software engineer intern Jobs | LinkedIn") even with a job's detail
// pane loaded (checked live 2026-09-11), so the split pane reads the pane's
// <h1> instead (see extractSplitPane).
// Format confirmed on one real posting: "{Title} | {Company} | LinkedIn".
// Anchored from the END rather than a naive 3-way split, since a job title
// can itself contain " | " (e.g. "Engineer | Backend Team"), which would
// corrupt a left-to-right split — the trailing "LinkedIn" literal and the
// company segment right before it are far less likely to contain a pipe.
// Only confirmed against one real posting so far — needs 2-3 more before
// this pattern counts as settled, per the working agreement.
function parseDocumentTitle(): { title?: string; company?: string } {
  const parts = document.title.split(' | ')
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
function extractFromDom(): { title?: string; company?: string; location?: string | null } {
  const { title, company: titleCompany } = parseDocumentTitle()
  const companyLink = document.querySelector('a[href*="/company/"]')
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
function resolveCanonicalJobUrl(): string {
  const currentJobId = new URLSearchParams(window.location.search).get('currentJobId')
  if (currentJobId) {
    return `https://www.linkedin.com/jobs/view/${currentJobId}/`
  }
  return window.location.href.split('?')[0]
}

// The split-pane search view (/jobs/search/, /jobs/collections/, ...) keeps
// the selected job in ?currentJobId=. /jobs/view/ pages are excluded
// explicitly so their proven extraction path is never touched. Digits only,
// since the id goes into a CSS selector below.
function splitPaneJobId(): string | null {
  if (window.location.pathname.startsWith('/jobs/view/')) return null
  const id = new URLSearchParams(window.location.search).get('currentJobId')
  return id && /^\d+$/.test(id) ? id : null
}

const RESULTS_CARD = '[data-occludable-job-id]'

function collapsedText(el: Element | null | undefined): string {
  return el?.textContent?.trim().replace(/\s+/g, ' ') ?? ''
}

// Split-pane extraction, checked live on 3 jobs (2026-09-11). No hashed
// classes; structure and links only, like extractFromDom:
// - title: the detail pane's <h1>, the one linking to /jobs/view/{jobId}/.
//   Results cards also link there, but not in an <h1>, and are excluded
//   explicitly anyway.
// - company: the nearest ancestor of that <h1> (3 levels up in every sample)
//   holding a company link with text, stopping before any ancestor that
//   contains results cards, so the company can't come from the list.
// - location: see extractSplitPaneLocation.
// Fails safe: if the pane isn't loaded yet, or shows a different job than
// ?currentJobId=, the <h1> lookup finds nothing and this returns null (no
// row) rather than logging the wrong job. Both copies of the Easy Apply
// button sit in this one pane, so it doesn't matter which was clicked.
function extractSplitPane(jobId: string): JobPostingData | null {
  const heading = Array.from(document.querySelectorAll('h1')).find(
    (h) => h.querySelector(`a[href*="/jobs/view/${jobId}"]`) && !h.closest(RESULTS_CARD),
  )
  if (!heading) return null
  const title = collapsedText(heading)

  let topCard: Element | null = null
  let ancestor: Element | null = heading.parentElement
  for (let i = 0; i < 6 && ancestor; i++, ancestor = ancestor.parentElement) {
    if (ancestor.querySelector(RESULTS_CARD)) break
    const hasCompany = Array.from(ancestor.querySelectorAll('a[href*="/company/"]')).some((a) =>
      collapsedText(a),
    )
    if (hasCompany) {
      topCard = ancestor
      break
    }
  }
  if (!topCard) return null
  const company = collapsedText(
    Array.from(topCard.querySelectorAll('a[href*="/company/"]')).find((a) => collapsedText(a)),
  )
  if (!title || !company) return null

  return { title, company, location: extractSplitPaneLocation(topCard), url: resolveCanonicalJobUrl() }
}

// The "X ago" metadata row, read with the same content-shape filter as
// extractLocationFromDom. Here "ago" sits in its own wrapper span, so the
// row ("Markham, ON", "·", "1 week ago", "·", "65 applicants") is one level
// higher than on /jobs/view/; walks up to 3 levels. Null if there's no row
// or no location-shaped entry (e.g. a non-English UI, where "ago" differs).
function extractSplitPaneLocation(topCard: Element): string | null {
  const agoSpan = Array.from(topCard.querySelectorAll('span')).find(
    (span) => span.children.length === 0 && AGO_PATTERN.test(collapsedText(span)),
  )
  let row: Element | null = agoSpan?.parentElement ?? null
  for (let i = 0; i < 3 && row; i++, row = row.parentElement) {
    const location = Array.from(row.children)
      .filter((el) => el.tagName === 'SPAN')
      .map((el) => collapsedText(el))
      .find(
        (value) =>
          value.length > 0 &&
          value !== '·' &&
          !AGO_PATTERN.test(value) &&
          !APPLICANTS_PATTERN.test(value),
      )
    if (location) return location
  }
  return null
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
    const splitPaneId = splitPaneJobId()
    if (splitPaneId) return extractSplitPane(splitPaneId)

    const jsonLd = readJobPostingJsonLd()

    let title = typeof jsonLd?.title === 'string' ? jsonLd.title.trim() : undefined
    let company =
      typeof jsonLd?.hiringOrganization?.name === 'string'
        ? jsonLd.hiringOrganization.name.trim()
        : undefined
    let location = jsonLd ? formatLocation(jsonLd) : null

    if (!title || !company || !location) {
      const domFallback = extractFromDom()
      title = title ?? domFallback.title
      company = company ?? domFallback.company
      location = location ?? domFallback.location ?? null
    }

    if (!title || !company) return null

    const data: JobPostingData = {
      title,
      company,
      location,
      url: resolveCanonicalJobUrl(),
    }
    return data
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
    return 'a[href*="/jobs/view/"][href*="/apply/"], [aria-label^="Easy Apply to"]'
  },
}
