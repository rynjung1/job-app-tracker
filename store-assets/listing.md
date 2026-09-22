# Chrome Web Store listing

**Submitted 2026-09-22: v1.0.0 is Pending review** (item
`mhldoocgadblnnelahaplfdnaoiehafj`, Public, from `main` at `0df8884`).
What the store holds now is this file's text with two changes forced by
the Developer Dashboard's own boxes, which this file hadn't anticipated:

- **One host box for all host permissions, 1000 characters.** Not one box
  per host, which is how the justifications further down are still
  written. Ryan merged the Sheets and Workday texts into a single
  justification to fit (953 characters); it's recorded verbatim below,
  under "Host permissions, as submitted".
- **Test instructions: 500 characters.** The five numbered steps further
  down are longer than that, so they were condensed for the box; that
  text is recorded verbatim below (with a note about its length).
- The storage justification used the **short form** below, not the long
  one, which is over the limit. Single purpose, `identity`, `alarms` and
  `notifications` took this file's text unchanged.

Approved 2026-09-11. This is the text to paste into the Developer
Dashboard's Store listing tab. Kept out of `public/` (Vite copies that
into `dist/`, so it would ship inside the extension) and `docs/`
(published on GitHub Pages).

Updated 2026-09-13 (draft, awaiting review): Google Sheets only (Excel/
OneDrive support removed), the popup's live statuses, the "Sign-in
needed" warning, and the new locally stored items.

Updated 2026-09-14 (pre-submission audit, awaiting review): LinkedIn logs
when you click Easy Apply; the privacy sentence no longer says "never has
access to ... browsing activity" (it contradicted the Web history
disclosure); the content-script, Sheets, storage and notifications texts
match the code; a no-submit Greenhouse path for the reviewer; the
screenshots described as they are.

Updated 2026-09-21 (Workday, ready to submit): Ryan's observation pinned the
Submit control and one real application logged a row live, so Workday is in
this listing for real — the summary (built from the manifest's site list, so
it can't name a site the build doesn't support), the description, the single
purpose, the content-script text (rewritten: the extension no longer keeps
the posting in the tab, it reads the job in the background after Submit), the
new Workday host-permission justification, the storage text and test
instruction 5, which says plainly that Workday can't be tested without
applying.

Updated 2026-09-14 (a sheet in Drive's trash or deleted; awaiting review):
the description's privacy sentence, the identity, storage (both) and
notifications justifications, the certification note and the
Authentication information note now cover the Drive trash check and its
flag.

Updated 2026-09-17 (branch `new-sheet`; awaiting review): the description,
the storage justification (both) and the Sheets host justification now
cover Settings naming the connected sheet, "Start a new sheet" and the
remembered previous sheet.

Updated 2026-09-16 (branch `summary-tab`; awaiting review): the description
and the Sheets host justification mention the Summary tab new sheets get.

Updated 2026-09-15 (branch `ui-polish`; awaiting review): the description,
test instruction 3, the storage justification (both) and the Sheets host
justification now cover the popup's note editor and the recent entries'
random ID.

## Short description (126 of 132 characters)

The store's summary comes from the manifest's `description`
(`manifest.config.ts`), not from a dashboard field: the dashboard's
listing fields have no separate summary, and Chrome's manifest docs
limit `description` to 132 characters of plain text meant for both
chrome://extensions and the Web Store. Since 2026-09-17 the manifest
builds it from the same `SITES` list that defines the content scripts,
so it can't name a site the build doesn't support
(`scripts/package.mjs` fails the zip if it does). With three sites it
takes the "— no manual data entry." form; the text below is what that
produces today, so paste nothing by hand.

```text
Automatically logs job applications to Google Sheets when you apply on LinkedIn, Greenhouse or Workday — no manual data entry.
```

## Detailed description

The dashboard shows this as plain text, so it has no Markdown.

```text
Job Application Tracker eliminates the copy-paste step of a job search. When you click Easy Apply on LinkedIn, submit an application on a Workday career site, or once a Greenhouse-hosted job posting confirms your application, it automatically logs the company, title, location, date, and a link to the job posting to a Google Sheet you control. On Workday, the company is the career site's name from its address (for example "nvidia"), which you can change in your sheet.

Easy Apply detection is fully supported with LinkedIn set to English.

No setup beyond connecting your Google account: the extension creates a new, formatted Google Sheet on first use, with a Status column, dropdown, and color-coded statuses so you can track Applied / Interview / Offer / Rejected / Cancelled at a glance (every logged row starts as Applied), plus a Summary tab that counts your applications by status and by week.

From the extension's popup you can see each of your 20 most recent applications with its current status from your sheet, change its status or note at any time, and open its job posting, without touching the spreadsheet by hand. Settings names the sheet you're connected to, and can start a new one for a new search — the old sheet stays in your Drive, and you can switch back to it. The notification after each log also offers a quick Undo. If your Google sign-in ever lapses, the extension tells you, keeps your applications waiting, and saves them as soon as you reconnect.

Privacy: the extension reads only the job page you apply on and its URL; it has no access to your other tabs or browsing history. It only talks to Google's own APIs: Sheets, to read and write your spreadsheet, and Drive, only to check whether that spreadsheet is in the trash; there is no other server, no analytics, and no third-party data sharing. OAuth access is scoped to files the extension itself creates (Google drive.file) — it cannot see your other files. Full privacy policy: https://rynjung1.github.io/job-app-tracker/privacy.html
```

## Other dashboard fields

Store listing tab:

- **Category:** Productivity > Workflow & Planning. Checked 2026-09-13:
  the developer docs don't publish the category list, but the live store
  has this subcategory
  (`chromewebstore.google.com/category/extensions/productivity/workflow`,
  headed "Workflow & Planning", under Extensions > Productivity).
- **Language:** English.
- **Homepage URL:** https://github.com/rynjung1/job-app-tracker
- **Support URL:** https://github.com/rynjung1/job-app-tracker/issues
- **Mature content:** no.

Distribution tab:

- **Visibility:** Public (decided by Ryan, 2026-09-14). The draft item is
  `mhldoocgadblnnelahaplfdnaoiehafj`.

Test instructions tab (optional: the docs say it's "only useful if the
item requires restricted credentials or a paid account"; this needs only
any Google account, but it points a reviewer at the flow):

```text
1. Settings opens on install (or use the gear in the extension's popup). Click Connect Google Sheets and sign in with any Google account; a formatted "Job Applications" sheet is created in that account's Drive.
2. With LinkedIn's interface in English, open a job posting that has Easy Apply and click Easy Apply. Closing the dialog without applying is fine. A row is logged to the sheet and a "Logged" notification with an Undo button appears.
3. Open the extension's popup: the application is listed. Its status chip changes the Status in the sheet, and its ⋯ menu edits the row's note (the Notes cell) or opens the job posting.
4. Greenhouse, without submitting anything: open a job posting on job-boards.greenhouse.io and click Submit application with the form left blank. Greenhouse shows its "is required" messages and sends nothing. Within 30 minutes, open the same address with /confirmation added to the end (https://job-boards.greenhouse.io/<board>/jobs/<id>/confirmation): one row is logged to the sheet. Opening it again logs nothing more.
5. Workday is logged only at the final Submit of a real application, so it can't be tested without applying.
```

## Screenshots (1280×800, 24-bit PNG, no alpha)

Each screenshot is 1280x800 of real rendered product: two of the
extension's own surfaces side by side, each at its own scale, butted
together edge to edge so the frame is full bleed — no card, border,
shadow, margin or backdrop, and nothing scaled so far up that a single
fragment fills the frame. The two-panel layout is a full-bleed
composition of two real rendered pages, not a page shown as a card on a
background: the panels meet at a 1px line and both run to the edges of
the frame. Chrome asks for both: full bleed with no
padding, and screenshots that demonstrate the actual user experience.
All data shown is placeholder: fake companies and `jobs.example.com`
URLs. Rebuilt 2026-09-18 from `main` plus the `drop-resume-version`
branch, whose popup rows no longer carry a resume version; the
2026-09-14 pair showed each page as a card on a plain background (that's
the padding the requirement rules out), and the first rebuild filled the
frame with a 3.5x blow-up of the popup's top (full bleed, but a fragment
rather than the product). Upload in this order:

1. `screenshots/1-popup-and-settings.png`: the popup's list on the left —
   the "N this week · M interviews" summary line, the banner for
   applications still waiting, two waiting rows among the saved ones,
   status chips and each row's ⋯ menu — and Settings on the right,
   connected and naming the sheet, with Open sheet, the quiet Reconnect
   link, "Start a new sheet", the supported sites and what's read from
   them.
2. `screenshots/2-popup-actions.png`: what you can do from the popup —
   the status dropdown open on a row, with all five statuses and their
   colours, and the note editor with that row's Notes cell.

How both were made: every panel is the real built page (the popup and
the options page) from the production build (`npm run build`) of commit
`f7ead5b` plus the `drop-resume-version` branch's changes — rendered in
headless Chrome with a
stand-in for the extension's storage and background messages that
supplies the placeholder data. The code and styles are the shipped ones;
only the data source is substituted. Each panel is rendered at the page's
own width — 368 CSS px for the popup, 500 for Settings (headless Chrome
won't open a window narrower than 500, so Settings renders at 500 rather
than its 440px window width) — with the device scale chosen so the panel
comes out at the width it occupies and, where the page is short enough,
its whole height: 1.50x and 1.456x for the first screenshot (552 + 728 =
1280), 1.674x and 1.804x for the second (616 + 664 = 1280). Nothing is
scaled non-uniformly, retouched or added, and no text or browser chrome
was drawn on: the only pixels that aren't page renders are the 1px
divider between the two panels, in the app's own border colour
(`#E5E7EB`). Saved as 24-bit RGB PNG with no alpha. The popup's chips
show the placeholder applications' statuses as its live statuses would.

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
Automatically logs the job applications you submit on supported job sites (LinkedIn Easy Apply, Greenhouse-hosted job postings and Workday career sites) as rows in a Google Sheet you own, and lets you review and update those logged applications and manage the sheet they're logged to.
```

### Permission justifications

`storage`:

```text
Stores, only on this device: which Google Sheet you connected and its name, so Settings can show it; whenever a new sheet replaces it — through "Start a new sheet", or when the old one is in the trash or deleted — the identifier and name of the one it replaced, so Settings can offer to switch back to it; a queue of applications waiting to be written if the network or sign-in fails, so none are lost, each kept until it's saved; briefly, for a Greenhouse application, the job's title, company, location and URL from the Submit click, in session storage until Greenhouse confirms the submission (deleted when it's logged or when the browser closes; after 30 minutes it's no longer used, and it's removed at the next Greenhouse Submit click or confirmation page); your 20 most recent logged applications (each with its row's random ID), shown in the popup so you can change their status or note; if Google sign-in lapses, when that happened and the error message from Chrome or Google, until you reconnect; if your sheet is moved to Google Drive's trash or deleted, which of the two and when, until it's restored or replaced; and, while the Settings window is open, its window id in session storage. No sign-in credential is stored: Chrome caches the Google token itself.
```

Shorter fallback, use if the dashboard rejects the long one (no
documented limit was found for these fields):

```text
Stores on this device only: the connected Google Sheet and its name; the identifier and name of any sheet it replaced, to switch back to; a queue of applications waiting to be written if the network or sign-in fails; briefly, a Greenhouse job's title, company, location and URL from the Submit click, in session storage until Greenhouse confirms (unused after 30 minutes); the 20 most recent applications, for status and note changes; a sign-in-needed flag with the error from Chrome or Google; a sheet-in-trash-or-deleted flag; and the open Settings window's id (session).
```

`identity`:

```text
Signs you in to Google Sheets with chrome.identity.getAuthToken (scope drive.file, which only covers files this extension creates). The same token asks Google Drive whether the extension's own sheet is in the trash (that file's trash status only). Chrome caches the token; the extension stores no credential itself. No profile, email or other account data is requested.
```

`alarms`:

```text
Retries writing queued applications every 5 minutes after a network or sign-in failure, so none are lost, and clears the "Logged" notification when its short Undo/Edit window ends. Alarms keep working while the background service worker is suspended.
```

`notifications`:

```text
Shows a "Logged" notification after each automatic log, with an Undo button in case you didn't mean to apply; a notice if you applied while no spreadsheet was connected, with a button that opens Settings; a "Sign-in needed" notice when Google access to your sheet has lapsed, with a Reconnect button, so applications waiting to be saved don't go unnoticed; a notice if your sheet is moved to Google Drive's trash or deleted, with a button that opens Settings; and an "Undo didn't go through" notice if the Logged notification's Undo fails, saying the application is still logged.
```

### Host permissions, as submitted (one box, 1000 characters max)

Verbatim, as Ryan pasted it on 2026-09-22: 953 characters, two paragraphs
with a blank line between them. This is what the store holds.

```text
Google Sheets API (https://sheets.googleapis.com/*): creates and formats the sheet when you connect, including a Summary tab whose cells are formulas over your own rows; writes each logged application as a row; updates one cell (Status or Notes) when you change it in the popup or use Undo; and reads the sheet's header row, your recent rows' Company, Title, Status and hidden ID for the popup, a row before a change to check it still matches, the hidden ID column when retrying a save, and the sheet's name and tab names.

Workday career sites (https://*.myworkdayjobs.com/*, https://*.myworkdaysite.com/*): one read. When you click an application's final Submit, the extension reads that one job's public title and location from the same site to write the row. No other Workday page is read, nothing is written, no account data is touched, and no Workday cookies are sent; the read runs in the background because submitting navigates away immediately.
```

### Test instructions, as submitted (500 characters max)

Verbatim, as Ryan pasted it on 2026-09-22: **466 characters**, comfortably
under the 500 limit. Username and Password were left empty — the extension
needs no credentials of its own, only a Google account the reviewer already
has. As with every box here, what the dashboard holds is the authority; this
file is the copy.

```text
No credentials needed; any Google account works. Open Settings from the popup, click Connect Google Sheets, sign in: a formatted sheet is created in that account's Drive. On LinkedIn (English UI), click Easy Apply on any job and close the dialog: one row is logged and a "Logged" notification appears; the popup lists it, where the status chip and ⋯ menu edit the sheet. Workday logs only at a real application's final Submit, so it can't be tested without applying.
```

### Which boxes took this file's text unchanged

Single purpose, `identity`, `alarms` and `notifications`: exactly the text
below, pasted as it stands. `storage` used the **short** form below, not
the long one — the long one is over the 1000-character limit. Only the two
boxes above needed text this file didn't already have.

The per-host texts below are the long forms this file has always kept.
They're still what the merged box was written from, and they're still
the right starting point if the dashboard ever splits the boxes again.

Host permission `https://sheets.googleapis.com/*`:

```text
Through the Google Sheets API: creates and formats the sheet when you connect, including a Summary tab whose cells are formulas over your own rows (written once, at creation); writes each logged application as a row (with a random ID, used only to avoid duplicates) in the Google Sheet this extension created; updates one cell (Status or Notes) when you change an application's status or note in the popup, or use the Logged notification's Undo; reads the sheet's header row to find its columns, your recent rows' Company, Title, Status and hidden ID for the popup, a row before a popup change to check it still matches (and its Notes cell when you open its note), the hidden ID column when retrying a save, the spreadsheet's name so Settings can show which sheet you're connected to, and the spreadsheet's tab names if you renamed the sheet's tab; and creates a new sheet if you start one from Settings (or if your sheet is in the trash or deleted).
```

Host permissions `https://*.myworkdayjobs.com/*` and
`https://*.myworkdaysite.com/*` (added 2026-09-21):

```text
Workday's career sites, for one read: when you click the final Submit of a Workday application, the extension reads that one job's public details (title and location) from the same career site, to write the row. It is the same public page data anyone can see on the posting, and it is read in the extension's background rather than in the page because submitting navigates away immediately and a read started in the page would be cut off. Nothing is written to Workday, no other Workday page is read, no Workday account data is touched, and the read is made without your Workday session's cookies. The extension's content script already runs on these two domains; this permission only lets that one read happen.
```

If the dashboard also asks about the content-script sites (they're
declared under `content_scripts`, not `host_permissions`):

```text
Content scripts run on https://www.linkedin.com/*, https://job-boards.greenhouse.io/*/jobs/*, https://*.myworkdayjobs.com/* and https://*.myworkdaysite.com/* (Workday career sites; never Workday's employee app). LinkedIn and Workday move between pages without reloading them, so their scripts are loaded on every page of those sites, but they act only on job pages: on LinkedIn and Greenhouse they read the job title, company, location and page URL when you click Easy Apply or Submit application; on Workday they read nothing as you browse, and when you click an application's final Submit they send that page's address, and the job title the page shows, to the extension, which reads that one job's public details from the same career site. Nothing else.
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
  Sheets API, and for the Drive check of whether that spreadsheet is in
  the trash. Chrome caches the token and the extension stores no
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
  write your own spreadsheet, and asks Google Drive whether that
  spreadsheet is in the trash, which is the single purpose.
- Doesn't use or transfer user data for purposes unrelated to the
  single purpose.
- Doesn't use or transfer user data to determine creditworthiness or
  for lending.

Privacy policy URL: https://rynjung1.github.io/job-app-tracker/privacy.html
