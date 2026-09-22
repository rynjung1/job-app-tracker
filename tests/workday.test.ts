// The Workday parser's pure parts (src/parsers/workday.ts) and the
// background's origin check (src/lib/trustedOrigins.ts), on real public
// URLs. externalUrl values are the job JSON's own, fetched 2026-09-14; the
// fixtures are in tests/fixtures/workday (scrubbed, public postings only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  captureFromJobJson,
  isFinalReviewStep,
  parseWorkdayJobUrl,
  reviewPageJobTitle,
  WORKDAY_SUBMIT_CONTROL_SELECTOR,
  workdayParser,
} from '../src/parsers/workday'
import { isTrustedJobSiteOrigin } from '../src/lib/trustedOrigins'

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/workday', name), 'utf8'))

// Each job JSON's externalUrl, and the tenant the Company column gets.
const JOBS: Array<{ tenant: string; externalUrl: string; source: string }> = [
  { tenant: 'nvidia', source: 'job JSON', externalUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--Agentic-Kernel-Development_JR2025621' },
  { tenant: 'salesforce', source: 'job JSON', externalUrl: 'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/United-Kingdom---England---Remote/Qualified-Success-Architect---Sr-Success-Architect--UK-I-_JR352243' },
  { tenant: 'bmo', source: 'job JSON', externalUrl: 'https://bmo.wd3.myworkdayjobs.com/External/job/Toronto-ON-CAN/Sr-Application-Developer----Java---AWS---Payment-Systems---Leadership-_R260009659' },
  { tenant: 'mastercard', source: 'job JSON', externalUrl: 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers/job/OFallon-Missouri/Senior-Software-Engineer_R-290078' },
  { tenant: 'capitalone', source: 'job JSON', externalUrl: 'https://capitalone.wd12.myworkdayjobs.com/Capital_One/job/McLean-VA/Senior-Manager--Software-Engineering--Full-Stack_R249443-1' },
  { tenant: 'adobe', source: 'job JSON', externalUrl: 'https://adobe.wd5.myworkdayjobs.com/external_experienced/job/Lehi/Sr-Cloud-Security-Engineer_R171604' },
  { tenant: 'wf', source: 'job JSON', externalUrl: 'https://wd1.myworkdaysite.com/recruiting/wf/WellsFargoJobs/job/SACRAMENTO-CA/Sacramento-Capital-District---Relationship-Banker_R-575483' },
  // From the search listings' externalPath: a reqId with an underscore (TD)
  // and a numeric one (CIBC).
  { tenant: 'td', source: 'search listing', externalUrl: 'https://td.wd3.myworkdayjobs.com/TD_Bank_Careers/job/7250-Mile-End-Montreal-Quebec/Bilingual-Contact-Center-Representative--Canadian-Banking--Easyline_R_1468577-1' },
  { tenant: 'cibc', source: 'search listing', externalUrl: 'https://cibc.wd3.myworkdayjobs.com/search/job/Calgary-AB/Client-Service-Representative--Hourly-_2618627' },
]

// Every address a user can be on for that job: the posting with and without
// a locale, with a query or hash, and each application route.
function variantsOf(externalUrl: string): string[] {
  const { origin, pathname } = new URL(externalUrl)
  return [
    externalUrl,
    `${origin}/en-US${pathname}`,
    `${origin}/fr-FR${pathname}`,
    `${externalUrl}?source=linkedin`,
    `${externalUrl}#top`,
    ...['/apply', '/apply/applyManually', '/apply/autofillWithResume', '/apply/useMyLastApplication'].map((route) => `${origin}/en-US${pathname}${route}`),
  ]
}

test('Workday job URLs', async (t) => {
  for (const job of JOBS) {
    await t.test(`${job.tenant} (${job.source}): 9 address variants normalize to externalUrl; Company is the tenant id`, () => {
      for (const href of variantsOf(job.externalUrl)) {
        const parsed = parseWorkdayJobUrl(href)
        assert.equal(parsed?.normalizedUrl, job.externalUrl, href)
        assert.equal(parsed?.tenant, job.tenant, href)
      }
    })
  }

  await t.test('the job JSON URL is the same-origin cxs address that answered for nvidia and Wells Fargo', () => {
    assert.equal(
      parseWorkdayJobUrl(`${JOBS[0].externalUrl}/apply/applyManually`)?.jobJsonUrl,
      'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-System-Software-Engineer--Agentic-Kernel-Development_JR2025621',
    )
    assert.equal(
      parseWorkdayJobUrl('https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/job/SACRAMENTO-CA/Sacramento-Capital-District---Relationship-Banker_R-575483/apply')?.jobJsonUrl,
      'https://wd1.myworkdaysite.com/wday/cxs/wf/WellsFargoJobs/job/SACRAMENTO-CA/Sacramento-Capital-District---Relationship-Banker_R-575483',
    )
  })

  await t.test('not a job address: search pages, the employee app, http, lookalike hosts, myworkdaysite without /recruiting/, no job segment', () => {
    for (const href of [
      'https://bmo.wd3.myworkdayjobs.com/en-US/External',
      'https://bmo.wd3.myworkdayjobs.com/en-US/External/userHome',
      'https://nvidia.wd5.myworkday.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/X_JR1',
      'http://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/X_JR1',
      'https://evil-myworkdayjobs.com/External/job/Loc/X_R1',
      'https://myworkdayjobs.com.evil.example/External/job/Loc/X_R1',
      'https://wd1.myworkdaysite.com/en-US/WellsFargoJobs/job/X_R-1',
      'https://bmo.wd3.myworkdayjobs.com/External/job/Toronto-ON-CAN',
      'not a url',
    ]) {
      assert.equal(parseWorkdayJobUrl(href), null, href)
    }
  })

  // Pinned 2026-09-21: the Review page's Submit carries the same
  // data-automation-id as every step's Next button, so the control alone
  // can't be the trigger (CLAUDE.md, Site parsers, Workday).
  await t.test('the Submit selector is the footer control the observation showed', () => {
    assert.equal(WORKDAY_SUBMIT_CONTROL_SELECTOR, '[data-automation-id="pageFooterNextButton"]')
    assert.equal(workdayParser.getApplyButtonSelector(), WORKDAY_SUBMIT_CONTROL_SELECTOR)
  })

  // A stand-in document: querySelector answers the three review selectors.
  const reviewDoc = (opts: { reviewPage?: boolean; activeStep?: string; ariaLabel?: string; jobTitle?: string }) =>
    ({
      querySelector: (selector: string) => {
        if (selector === '[data-automation-id="applyFlowReviewPage"]') return opts.reviewPage ? {} : null
        if (selector === '[data-automation-id="progressBarActiveStep"]') {
          if (!opts.activeStep && !opts.ariaLabel) return null
          return {
            textContent: opts.activeStep ?? '',
            getAttribute: (name: string) => (name === 'aria-label' ? (opts.ariaLabel ?? null) : null),
          }
        }
        if (selector === '[data-automation-id="jobTitleHeading"]') {
          return opts.jobTitle ? { textContent: opts.jobTitle } : null
        }
        return null
      },
    }) as unknown as ParentNode

  await t.test('isFinalReviewStep: the review container alone is enough', () => {
    assert.equal(isFinalReviewStep(reviewDoc({ reviewPage: true })), true)
    assert.equal(isFinalReviewStep(reviewDoc({ reviewPage: true, activeStep: 'current step 3 of 8' })), true)
  })

  await t.test('isFinalReviewStep: without it, the progress bar deciding on digits, not words', () => {
    assert.equal(isFinalReviewStep(reviewDoc({ activeStep: 'current step 8 of 8' })), true)
    assert.equal(isFinalReviewStep(reviewDoc({ ariaLabel: 'étape 8 sur 8' })), true)
    assert.equal(isFinalReviewStep(reviewDoc({ activeStep: '第 8 步，共 8 步' })), true)
    assert.equal(isFinalReviewStep(reviewDoc({ activeStep: 'current step 3 of 8' })), false)
    assert.equal(isFinalReviewStep(reviewDoc({ activeStep: 'step 8' })), false)
    assert.equal(isFinalReviewStep(reviewDoc({ activeStep: 'Review' })), false)
  })

  await t.test('isFinalReviewStep: neither mark, nothing is a final step', () => {
    assert.equal(isFinalReviewStep(reviewDoc({})), false)
  })

  await t.test('reviewPageJobTitle: the heading, collapsed; empty when it is absent', () => {
    assert.equal(reviewPageJobTitle(reviewDoc({ jobTitle: '  Senior   Engineer ' })), 'Senior Engineer')
    assert.equal(reviewPageJobTitle(reviewDoc({})), '')
  })
})

test('Workday job JSON fallback (fixtures)', async (t) => {
  for (const [name, tenant] of [['nvidia-job.json', 'nvidia'], ['bmo-job.json', 'bmo'], ['wf-job.json', 'wf']]) {
    await t.test(`${name}: title and location from the JSON, Company the tenant, URL equal to externalUrl`, () => {
      const json = fixture(name)
      const info = json.jobPostingInfo
      const capture = captureFromJobJson(json, `${info.externalUrl}/apply/applyManually`)
      assert.deepEqual(capture, { posting: { title: info.title, company: tenant, location: info.location, url: info.externalUrl }, reqId: info.jobReqId })
    })
  }
  await t.test('a JSON without jobPostingInfo or title, or a non-job address, gives nothing', () => {
    const href = `${JOBS[0].externalUrl}/apply`
    assert.equal(captureFromJobJson({}, href), null)
    assert.equal(captureFromJobJson({ jobPostingInfo: { title: '  ' } }, href), null)
    assert.equal(captureFromJobJson(null, href), null)
    assert.equal(captureFromJobJson(fixture('nvidia-job.json'), 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite'), null)
  })
})

test('background origin check: Workday tenants accepted, lookalikes refused', () => {
  for (const origin of ['https://www.linkedin.com', 'https://job-boards.greenhouse.io', 'https://nvidia.wd5.myworkdayjobs.com', 'https://salesforce.wd12.myworkdayjobs.com', 'https://wd1.myworkdaysite.com']) {
    assert.equal(isTrustedJobSiteOrigin(origin), true, origin)
  }
  for (const origin of [
    'https://evil-myworkdayjobs.com',
    'https://myworkdayjobs.com.evil.example',
    'https://nvidia.wd5.myworkdayjobs.com.evil.example',
    'http://nvidia.wd5.myworkdayjobs.com',
    'https://nvidia.wd5.myworkday.com',
    'https://nvidia.wd5.myworkdayjobs.com:8443',
    'https://myworkdayjobs.com',
    'https://linkedin.com',
    'https://boards.greenhouse.io',
    '',
    undefined,
  ]) {
    assert.equal(isTrustedJobSiteOrigin(origin), false, String(origin))
  }
})
