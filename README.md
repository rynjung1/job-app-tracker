# Job Application Tracker

A Chrome extension that logs the jobs you apply to in a Google Sheet,
automatically. No copying and pasting: when you apply, the company, job
title, location, date and a link to the posting are added as a new row,
with a hidden ID the extension uses only to avoid saving the same
application twice.

## Supported sites

- **LinkedIn Easy Apply**, with LinkedIn set to English. Jobs that send
  you to the company's own website aren't logged.
- **Greenhouse job boards** on `job-boards.greenhouse.io`. Career sites
  that show Greenhouse jobs on the company's own domain aren't covered.

## How it works

1. Open Settings and connect Google Sheets. The extension creates a new,
   formatted "Job Applications" sheet in your Google Drive.
2. Apply as usual. On LinkedIn the row is logged when you click Easy
   Apply; on Greenhouse, once the site confirms your application was
   submitted.
3. A "Logged" notification appears, with Undo and Edit for a quick fix.
4. The extension's popup lists your 20 most recent applications. From
   there you can change an application's status (Applied, Interview,
   Offer, Rejected, Cancelled) or resume version, or open the job
   posting. Changes are written to your sheet.

If your Google sign-in lapses, the extension tells you and keeps your
applications waiting until you reconnect.

## Privacy

The extension talks only to Google's Sheets API, and can only access
files it created. There's no other server and no analytics. Its use of
information received from Google APIs adheres to the Google API Services
User Data Policy, and will adhere to the Chrome Web Store User Data
Policy, including the Limited Use requirements. Full policy:
https://rynjung1.github.io/job-app-tracker/privacy.html

## Permissions

- `storage`: on your device only: your connected sheet; applications
  waiting to be saved; briefly, a Greenhouse job's details between your
  Submit click and Greenhouse's confirmation (session storage, cleared
  when the browser closes, unused after 30 minutes); your 20 most recent
  applications; the last resume version you used for each type of role;
  while Google sign-in is needed, when that happened and the error message
  from Chrome or Google; and, while Settings is open, its window's number
  (session storage). No sign-in credential: Chrome keeps the Google token.
- `identity`: signs you in to Google, with access limited to files the
  extension creates.
- `alarms`: retries saving applications after a network or sign-in
  problem.
- `notifications`: the "Logged", "Not connected", "Sign-in needed" and
  "Undo didn't go through" notices.
- `https://sheets.googleapis.com/*`: reads and writes your sheet through
  the Google Sheets API.
- It runs on LinkedIn and on Greenhouse job boards. LinkedIn moves between
  pages without reloading them, so its code is loaded on every LinkedIn
  page, but it acts only on job pages, reading the job details when you
  click Easy Apply or Submit.

## Build from source

Requires Node.js 18 or later.

```sh
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, click Load
unpacked and choose the `dist/` folder. `npm run package` builds a
checked zip for the Chrome Web Store in `release/`.

Google sign-in only works for the extension ID that the OAuth client in
`manifest.config.ts` is registered to. To sign in from your own build,
create a "Chrome Extension" OAuth client in Google Cloud for your
extension's ID and put its client ID in `manifest.config.ts`.

## Issues

https://github.com/rynjung1/job-app-tracker/issues
