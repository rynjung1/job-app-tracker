# Chrome Web Store listing

Approved 2026-09-11. This is the text to paste into the Developer
Dashboard's Store listing tab. Kept out of `public/` (Vite copies that
into `dist/`, so it would ship inside the extension) and `docs/`
(published on GitHub Pages).

Updated 2026-09-13 (draft, awaiting review): Google Sheets only (Excel/
OneDrive support removed), the popup's live statuses, the "Sign-in
needed" warning, and the new locally stored items.

## Short description (117 of 132 characters)

```text
Automatically logs job applications to Google Sheets when you apply on LinkedIn or Greenhouse — no manual data entry.
```

## Detailed description

The dashboard shows this as plain text, so it has no Markdown.

```text
Job Application Tracker eliminates the copy-paste step of a job search. When you submit an application on LinkedIn (Easy Apply) or a Greenhouse-hosted job posting, it automatically logs the company, title, location, date, and a link to the job posting to a Google Sheet you control.

Easy Apply detection is fully supported with LinkedIn set to English.

No setup beyond connecting your Google account: the extension creates a new, formatted Google Sheet on first use, with a Status column, dropdown, and color-coded statuses so you can track Applied / Interview / Offer / Rejected at a glance.

From the extension's popup you can see each of your 20 most recent applications with its current status from your sheet, and edit its resume version or undo it at any time, so you can correct a mismatched resume choice or cancel an accidental log without touching the spreadsheet by hand. If your Google sign-in ever lapses, the extension tells you, keeps your applications waiting, and saves them as soon as you reconnect.

Privacy: the extension only reads job-posting pages on the specific sites it supports — it never has access to other tabs or browsing activity. It only ever talks to Google's own API to read and write your spreadsheet; there is no other server, no analytics, and no third-party data sharing. OAuth access is scoped to files the extension itself creates (Google drive.file) — it cannot see your other files. Full privacy policy: https://rynjung1.github.io/job-app-tracker/privacy.html
```

## Screenshots (1280×800, 24-bit PNG, no alpha, full bleed)

Chrome requires full-bleed screenshots (square corners, no padding). All
data shown is placeholder: fake companies and `jobs.example.com` URLs.
Rebuilt 2026-09-13 for the new popup and the Settings window; the older
popup-over-sheet and sheet screenshots were removed (old UI, old sheet
formatting). Upload in this order:

1. `screenshots/1-popup.png`: the popup's recent-applications list, with
   its status chips and Edit/Undo.
2. `screenshots/2-settings.png`: the Settings window's page, connected to
   Google Sheets and listing the supported sites.

How both were made: each is the real built page (the popup and the
options page) from the `npm run package` build of commit `11f95ef`,
rendered in headless Chrome at 2x with a stand-in for the extension's
storage and background messages that supplies the placeholder data. The
code and styles are the shipped ones; only the data source is
substituted. Each render was cropped to the page, scaled down from the
2x render to 1.5× its true size (480×759 and 660×687; the store shows
screenshots at about half size, so true-size text would be too small to
read) and centred on a plain `#F5F7FB` 1280×800 background with a 1px
border and a soft shadow. No browser chrome or
text was added, and nothing was retouched. The popup's chips show the
placeholder applications' statuses as its live statuses would.

Optional, to add later: a screenshot of the auto-created sheet.
`scripts/screenshot-sheet.ts` builds one on a throwaway sheet through the
real `createSheet`, `appendRow` and `updateCell` (8 placeholder rows over
two weeks, all five statuses, the same rows the popup screenshot shows);
its header says how to bundle it and run it in the extension's service
worker.

## Privacy practices tab

Drafted 2026-09-11 from the published privacy policy and the code (see
the notes under each part), updated 2026-09-13. Paste each block into
the matching field.

### Single purpose

```text
Automatically logs the job applications you submit on supported job sites (LinkedIn Easy Apply and Greenhouse-hosted job postings) as rows in a Google Sheet you own.
```

### Permission justifications

`storage`:

```text
Stores, only on this device: which Google Sheet you connected; a queue of applications waiting to be written if the network or sign-in fails, so none are lost; briefly, for a Greenhouse application, the job's title, company, location and URL from the Submit click, in session storage until Greenhouse confirms the submission (deleted when it's logged, after 30 minutes, or when the browser closes); your 20 most recent logged applications, shown in the popup for Edit and Undo; the last resume version you used for each type of role; if Google sign-in lapses, when that happened and Chrome's error message, until you reconnect; and, while the Settings window is open, its window id in session storage. No sign-in credential is stored: Chrome caches the Google token itself.
```

Shorter fallback, use if the dashboard rejects the long one (no
documented limit was found for these fields):

```text
Stores on this device only: the connected Google Sheet; a queue of applications waiting to be written if the network or sign-in fails; briefly, a Greenhouse job's title, company, location and URL from the Submit click, in session storage until Greenhouse confirms (at most 30 minutes); the 20 most recent applications, for Edit and Undo; the last resume version per role type; a sign-in-needed flag with Chrome's error; and the open Settings window's id (session).
```

`identity`:

```text
Signs you in to Google Sheets with chrome.identity.getAuthToken (scope drive.file, which only covers files this extension creates). Chrome caches the token; the extension stores no credential itself. No profile, email or other account data is requested.
```

`alarms`:

```text
Retries writing queued applications every 5 minutes after a network or sign-in failure, so none are lost, and clears the "Logged" notification when its short Undo/Edit window ends. Alarms keep working while the background service worker is suspended.
```

`notifications`:

```text
Shows a "Logged" notification after each automatic log, with Undo and Edit buttons to correct it; a notice if you applied while no spreadsheet was connected, with a button that opens Settings; and a "Sign-in needed" notice when Google access to your sheet has lapsed, with a Reconnect button, so applications waiting to be saved don't go unnoticed.
```

Host permission `https://sheets.googleapis.com/*`:

```text
Through the Google Sheets API: writes each logged application as a row in the Google Sheet this extension created and updates one cell for Undo or Edit; reads your recent rows' Company, Title and Status for the popup, and a row before a popup Edit or Undo to check it still matches.
```

If the dashboard also asks about the content-script sites (they're
declared under `content_scripts`, not `host_permissions`):

```text
Content scripts run only on www.linkedin.com/jobs/* and job-boards.greenhouse.io/*/jobs/*, to read the job title, company, location and page URL when you click Easy Apply or Submit application.
```

### Remote code

No. All code is bundled in the package (Manifest V3, no `eval`, no
remotely hosted scripts).

### Data usage: categories

The Web Store counts data as "handled" even when it's only stored or
processed on the device, so local storage is disclosed too.

- **Website content: check.** The job title, company, location and page
  URL, read from the job page when you apply.
- **Authentication information: check.** The extension uses a Google
  OAuth access token, from `chrome.identity.getAuthToken`, to call the
  Sheets API. Chrome caches the token and the extension stores no
  credential itself, but it does handle the token for each request, so
  this errs on the side of disclosing.
- **Web history: check.** Every logged row stores the job posting's URL
  and the date you applied. The Web Store's User Data FAQ defines web
  browsing activity as "any information about the websites or other web
  resources a user requests or interacts with, including the domains or
  URLs the browser interacts with", so this counts, even though it's only
  the page you applied on, never general browsing. Limited Use requires
  browsing-activity collection to be described prominently on the store
  page, which is why the detailed description names the job posting's
  link.
- **User activity: check.** The FAQ doesn't define it separately, and
  the extension reacts to a click on the Apply/Submit button, so this
  errs on the side of disclosing. It doesn't track other clicks,
  keystrokes, scrolling or mouse movement.
- **Don't check:** personally identifiable information (it never reads
  your name, email or profile, and its only Google scope is
  `drive.file`), health, financial and payment, personal communications,
  and location (the job's location isn't yours).

### Data usage: certifications (check all three)

Match these to the dashboard's exact wording:

- Doesn't sell or transfer user data to third parties outside the
  approved use cases. Data only goes to Google's Sheets API to read and
  write your own spreadsheet, which is the single purpose.
- Doesn't use or transfer user data for purposes unrelated to the
  single purpose.
- Doesn't use or transfer user data to determine creditworthiness or
  for lending.

Privacy policy URL: https://rynjung1.github.io/job-app-tracker/privacy.html
