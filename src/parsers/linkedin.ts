import type { JobPageParser, JobPostingData } from './types'

const JOB_PAGE_PATH = /^\/jobs\/(view|search|collections)\//

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

  detect() {
    if (!JOB_PAGE_PATH.test(window.location.pathname)) return false
    return (
      document.querySelector('.jobs-details, .job-view-layout, .jobs-unified-top-card') !== null
    )
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
    // UNVERIFIED against a real authenticated posting — no browser automation
    // was available to check the logged-in DOM. Confirm/correct this against
    // the console.log output in content/linkedin.ts before trusting it.
    return 'button[aria-label*="Easy Apply"], button.jobs-apply-button'
  },
}
