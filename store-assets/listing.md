# Chrome Web Store listing

Approved 2026-09-11. This is the text to paste into the Developer
Dashboard's Store listing tab. Kept out of `public/` (Vite copies that
into `dist/`, so it would ship inside the extension) and `docs/`
(published on GitHub Pages).

## Short description (126 of 132 characters)

```text
Automatically logs job applications to Google Sheets or Excel when you apply on LinkedIn or Greenhouse — no manual data entry.
```

## Detailed description

The dashboard shows this as plain text, so it has no Markdown.

```text
Job Application Tracker eliminates the copy-paste step of a job search. When you submit an application on LinkedIn (Easy Apply) or a Greenhouse-hosted job posting, it automatically logs the company, title, location, date, and a link to the job posting to a spreadsheet you control — Google Sheets or Microsoft Excel/OneDrive, your choice.

Easy Apply detection is fully supported with LinkedIn set to English.

No setup beyond connecting your account: the extension creates a new, formatted spreadsheet on first use, with a Status column, dropdown, and color-coded conditional formatting (Sheets) so you can track Applied / Interview / Offer / Rejected at a glance.

Every log gets a brief undo window and an editable resume-version field, so you can correct a mismatched resume choice or cancel an accidental log without ever touching the spreadsheet by hand.

Privacy: the extension only reads job-posting pages on the specific sites it supports — it never has access to other tabs or browsing activity. It only ever talks to Google's or Microsoft's own APIs to write your spreadsheet; there is no other server, no analytics, and no third-party data sharing. OAuth access is scoped to files the extension itself creates (Google drive.file) or its own app folder (Microsoft Files.ReadWrite.AppFolder) — it cannot see your other files. Full privacy policy: https://rynjung1.github.io/job-app-tracker/privacy.html
```

## Screenshots (1280×800, 24-bit PNG, no alpha)

All data shown is placeholder: fake companies and `jobs.example.com`
URLs.

1. `screenshots/1-popup.png`: the popup's recent-applications list with
   Edit/Undo.
2. `screenshots/2-options.png`: the options page, connected, with the
   supported-sites line.
3. `screenshots/3-spreadsheet.png`: the auto-created sheet, with the
   formatted header, real dates, and the Status dropdown and colours.

## Privacy practices tab

Drafted 2026-09-11 from the published privacy policy and the code (see
the notes under each part). Paste each block into the matching field.

### Single purpose

```text
Automatically logs the job applications you submit on supported job sites (LinkedIn Easy Apply and Greenhouse-hosted job postings) as rows in a spreadsheet you own, in Google Sheets or Microsoft Excel on OneDrive.
```

### Permission justifications

`storage`:

```text
Stores, only on this device: which spreadsheet you connected and whether it is Google or Microsoft; a queue of applications waiting to be written if the network or sign-in fails, so none are lost; your 20 most recent logged applications, shown in the popup for Edit and Undo; the last resume version you used for each type of role; and, for the Excel option only, your Microsoft sign-in tokens.
```

`identity`:

```text
Signs you in to the spreadsheet service you choose: chrome.identity.getAuthToken for Google Sheets (scope drive.file, which only covers files this extension creates) and chrome.identity.launchWebAuthFlow for Microsoft (scope Files.ReadWrite.AppFolder, which only covers this extension's own OneDrive folder). No profile, email or other account data is requested.
```

`alarms`:

```text
Retries writing queued applications every 5 minutes after a network or sign-in failure, so none are lost, and clears the "Logged" notification when its short Undo/Edit window ends. Alarms keep working while the background service worker is suspended.
```

`notifications`:

```text
Shows a "Logged" notification after each automatic log, with Undo and Edit buttons to correct it, and a notice if you applied while no spreadsheet was connected, with a button that opens Settings.
```

Host permission `https://sheets.googleapis.com/*`:

```text
Writes each logged application as a row in the Google Sheet this extension created, and updates one cell when you use Undo or Edit, through the Google Sheets API.
```

Host permission `https://login.microsoftonline.com/*`:

```text
Microsoft sign-in for the Excel option: exchanges the sign-in code for tokens and refreshes them (OAuth 2.0 with PKCE; no client secret).
```

Host permission `https://graph.microsoft.com/*`:

```text
Creates the Excel workbook in this extension's own OneDrive app folder and writes each logged application to it, through Microsoft Graph.
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
- **Authentication information: check.** For the Excel option, the
  Microsoft sign-in tokens stored in local extension storage. (Google
  tokens are cached by Chrome itself, not by this extension.)
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
  your name, email or profile, and the Microsoft scopes don't include
  `openid`/`profile`), health, financial and payment, personal
  communications, and location (the job's location isn't yours).

### Data usage: certifications (check all three)

Match these to the dashboard's exact wording:

- Doesn't sell or transfer user data to third parties outside the
  approved use cases. Data only goes to Google's or Microsoft's API to
  write your own spreadsheet, which is the single purpose.
- Doesn't use or transfer user data for purposes unrelated to the
  single purpose.
- Doesn't use or transfer user data to determine creditworthiness or
  for lending.

Privacy policy URL: https://rynjung1.github.io/job-app-tracker/privacy.html
