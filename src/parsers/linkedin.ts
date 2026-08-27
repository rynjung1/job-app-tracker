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

// LinkedIn embeds schema.org/JobPosting JSON-LD on job pages for SEO — verified
// live against a real posting (see CLAUDE.md Phase 2 notes for the raw fetch).
// This is far more stable than LinkedIn's CSS class names, so it's the primary
// source for title/company/location; DOM text is only a fallback.
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

// Two known templates: the authenticated in-app SPA view (class names below
// are unverified — no logged-in session was available to check them), and
// the logged-out "guest" view (.topcard__* classes — verified against real
// fetched pages, see CLAUDE.md Phase 2 verification notes). Both are listed
// since either can be what's live in the DOM depending on session state.
function extractFromDom(): { title?: string; company?: string; location?: string | null } {
  const title = document.querySelector('h1')?.textContent?.trim()
  const company = document
    .querySelector(
      '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, .topcard__org-name-link',
    )
    ?.textContent?.trim()
  const location = document
    .querySelector(
      '.job-details-jobs-unified-top-card__bullet, .jobs-unified-top-card__bullet, .topcard__flavor-row .topcard__flavor--bullet',
    )
    ?.textContent?.trim()
  return { title, company, location: location || null }
}

export const linkedinParser: JobPageParser = {
  siteId: 'linkedin',

  // No container-class check — this page's classes are hashed/atomic CSS
  // with no stable or semantic names (confirmed via real DOM inspection,
  // not assumed). The only call site (content/linkedin.ts, gating the
  // apply-button bind attempt) already fails safe when no Apply anchor is
  // found, so a coarser URL-only check here doesn't create a correctness
  // risk — it just means the bind attempt is tried on more /jobs/ pages,
  // which is cheap and self-limiting.
  detect() {
    return JOB_PAGE_PATH.test(window.location.pathname)
  },

  extract() {
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
      url: window.location.href.split('?')[0],
    }
    return data
  },

  getApplyButtonSelector() {
    // Confirmed via real DOM inspection across 4 live authenticated
    // postings (3 Easy Apply, 1 off-site): it's an <a>, not a <button>,
    // aria-label="LinkedIn Apply to this job" and href into
    // /jobs/view/{id}/apply/ — consistent across all 3 Easy Apply cases,
    // hence the prefix match rather than requiring an exact string.
    //
    // This also turned out to self-scope to Easy-Apply-only with zero
    // extra logic: the one off-site posting checked has a completely
    // different label ("Apply on company website") and its href routes
    // through LinkedIn's own /safety/go/?url=... redirect wrapper rather
    // than pointing at /jobs/view/.../apply/ directly — so no separate
    // href check is needed to enforce the Easy-Apply-only scope boundary
    // documented in CLAUDE.md.
    return 'a[aria-label^="LinkedIn Apply"]'
  },
}
