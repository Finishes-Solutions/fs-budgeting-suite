# In-App Feedback — how it works, and the Azure setup email needs

The bug button in the bottom-left corner of every page takes a bug report or a
feature request, along with the diagnostics the app already knows about itself.
How that report leaves the app depends on whether the server can send mail yet.

## Two modes, and what switches between them

The server tells the app whether it can send mail — `features.feedbackMail`,
answered on the `/api/user-settings` call the app already makes at start-up —
and the button behaves accordingly. **Finishing the Azure setup below switches
it over on its own: no code change, no deploy.**

**Mail mode — the default, and what is running today.** Pick *Something is
broken* or *Something is missing* and the machine's own mail client opens with
the subject written, the recipient set, and every diagnostic already in the
body. The user describes it in their own words and presses send. Nothing is
stored, because nothing reached us — the email is the report. A *Copy Details*
button covers the locked-down desktops where `mailto:` does nothing at all.

**App mode — once the five settings below exist.** The report is typed in the
dialog, stored in `dbo.Feedback`, and emailed from the automation mailbox.

In app mode: **the database is the record, the email is a notification.** The
row is written first; only then is the email attempted. If Graph is down or the
client secret expires, the report is still safe, still on the Admin board, and
the row says what went wrong in `EmailStatus` / `EmailError`. The person who
filed it is told the truth either way ("sent to Matthew" vs "saved — email
delivery is not switched on yet"). If the API itself cannot be reached, the
dialog falls back to the same `mailto:` draft, keeping the words they already
typed.

There is no path where a user types a report and has nowhere to put it.

## What the auto-filled email contains

Subject, written for you and still editable:

```
[FS Suite · Bug] Project Budgets — Matthew Sturm
```

Body: a prompt to describe it, then a marked block of details — type, page
(named and as a route), environment, host, pricing and engine versions,
pricing source, screen size, signed-in account, roles, browser, and the time.
Deliberately not the whole Version table: several mail clients truncate a long
`mailto:`, and a draft that arrives cut in half is worse than one that never
had the last four lines. The whole URL stays under ~1,000 characters.

## What ships without any Azure work

- The button, the kind picker, and the auto-filled email.
- Storage in `dbo.Feedback` (after the migration below).
- The **Feedback** tab on the Admin page: open/closed/all views, one-click
  triage (New → Triaged → In Progress → Done / Declined), and an expandable
  detail panel with everything a report carries.
- Honest delivery state on every row.

Email *from the app itself* is the only part that needs Azure configuration.

## Step 1 — run the migration (required)

In the Azure Portal Query Editor, against the same database the app uses:

```
sql/migrate_feedback.sql
```

It is additive and idempotent — it creates `dbo.Feedback`, two indexes and
three check constraints, and touches nothing else. Section 1 tells you what it
is about to do, section 3 verifies what it did. Until it has run, the feedback
endpoint answers 503 with a plain explanation and the Admin board says which
script to run; the rest of the app is unaffected.

## Step 2 — the app registration (only needed for email)

Sending as `automation@finishessolutions.com` uses Microsoft Graph with an
application permission. No new Azure resource, no DNS records, no mail
provider — the tenant already has Entra ID and the mailbox.

1. **Entra ID → App registrations → New registration.**
   Name it something like `FS Budgeting Suite — Mail`. Single tenant. No
   redirect URI (this never signs a user in).
2. Copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets → New client secret.** Copy the *Value* (not the
   Secret ID) immediately — it is shown once. Note the expiry; the send starts
   failing on that date, and the board will say so rather than going quiet.
4. **API permissions → Add a permission → Microsoft Graph → Application
   permissions → `Mail.Send`.** Then **Grant admin consent**. Without the
   consent step the token is issued but the send is refused with 403.
5. Optional but recommended — **restrict which mailbox it can send as.** As
   granted above, the app can send as any mailbox in the tenant. An
   application access policy narrows it to one:

   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> `
     -PolicyScopeGroupId automation@finishessolutions.com `
     -AccessRight RestrictAccess `
     -Description "FS Budgeting Suite feedback mailer"
   ```

   (Exchange Online PowerShell. It can take up to an hour to take effect.)

## Step 3 — the application settings

Static Web App → **Configuration → Application settings**. Add five, then
save (the Functions host restarts on its own):

| Setting | Value |
|---|---|
| `GRAPH_TENANT_ID` | Directory (tenant) ID from step 2 |
| `GRAPH_CLIENT_ID` | Application (client) ID from step 2 |
| `GRAPH_CLIENT_SECRET` | The secret **value** from step 2 |
| `FEEDBACK_FROM` | `automation@finishessolutions.com` |
| `FEEDBACK_TO` | `matthews@finishessolutions.com` |

Secrets live here, never in the repository — the same rule the SQL connection
string already follows. `FEEDBACK_TO` accepts a comma-separated list if more
than one person should get them.

## Checking it

Once the settings are saved, reload the app: the bug button stops opening your
mail client and starts taking the report in-app. File a test report, then open
**Admin → Feedback**. The row shows its delivery state:

- **(no badge)** — emailed. It is in the inbox.
- **Email off** — `isConfigured()` is false: one of the five settings is
  missing or empty.
- **Email failed** — hover the badge for the reason Graph gave. `403` almost
  always means admin consent was not granted, or the application access policy
  excludes the mailbox. `AADSTS7000215` means the client secret is wrong or
  expired.
- **Not sent** — the row was written but the send never reported back. Rare;
  worth looking at the function logs.

The email arrives from `automation@finishessolutions.com` with the reporter as
**Reply-To**, so replying reaches the person who filed it rather than the
automation mailbox.

## What is in a report

In app mode, everything on the Version page — environment, host, export
renderer, investment engine, input schema, pricing library version and source,
auth provider, API runtime, database, signed-in account and roles, user agent —
plus the route, the viewport, and what the reporter typed. In mail mode, the
shorter block listed above, for the URL-length reason. Both are collected
automatically and shown to the user before anything leaves the page. No budget
or analysis data is included, and the dialog says so.

## Limits

- 12 reports per account per hour. Past that the endpoint answers 429 and
  suggests emailing directly.
- Title 200 characters, description 8,000, 40 diagnostic rows.
- The board reads the most recent 400 reports.

## Where the code is

| Piece | File |
|---|---|
| Button, dialog, mail draft, Admin board | `app/feedback.js`, `app/feedback.css` |
| Markup and wiring | `app/index.html` (`#fbFab`, `#fbModal`, `#page-admin`) |
| Endpoint and the capability flags | `api/user-settings/index.js` (`?scope=feedback`; `features` on GET) |
| Validation and email wording | `api/shared/feedback.js` (shared with the mock) |
| Graph transport | `api/shared/mailer.js` |
| Table | `sql/migrate_feedback.sql` |
| Tests | `test/feedback.test.js`, `test/user-settings-api.test.js`, `test/suite-19.js` |

The endpoint hangs off `api/user-settings` rather than living in
`api/feedback/` because a dedicated new function folder did not register on
this host once before — it answered 404 while every established endpoint kept
working. Hanging new scopes off an endpoint that is known to deploy is what
actually reaches users; `isSuperAdmin` inside the handler is the real gate on
the admin operations, since an SWA route rule cannot match a query parameter.
