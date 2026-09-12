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
Job Application Tracker eliminates the copy-paste step of a job search. When you submit an application on LinkedIn (Easy Apply) or a Greenhouse-hosted job posting, it automatically logs the company, title, location, and date to a spreadsheet you control — Google Sheets or Microsoft Excel/OneDrive, your choice.

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

Not drafted yet. It's step 9 of the submission sequence in
`.claude/skills/web-store-deploy/SKILL.md`.
