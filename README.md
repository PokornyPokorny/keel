# Keel

https://pokornypokorny.github.io/keel/

This page is public. Anything Keel tracks will live in the private repo
`PokornyPokorny/keel-data`, and the page reaches it with a GitHub code: a
fine-grained token that can only read and write that one repo. Each phone
pastes the code once and keeps it. Face ID then locks the app on that phone.
This is the same setup as Yarvo's Box Stock.

## Make the GitHub code (once)

1. Open the prefilled form:
   https://github.com/settings/personal-access-tokens/new?name=Keel+phone&description=Keel+app:+keel-data+only&target_name=PokornyPokorny&expires_in=366&contents=write
2. Repository access: **Only select repositories** > `keel-data`.
   The link can't preselect this.
3. Check that Permissions shows **Contents: Read and write**, then
   **Generate token** and copy it (`github_pat_...`).

Never commit the token. GitHub emails you before it expires.

## Set up a phone

1. In Safari open the link above > Share > **Add to Home Screen**.
2. Open Keel from the home screen and paste the code. Do this in the home
   screen app, not Safari: iOS gives each its own storage.
3. Tap **Turn on** for Face ID. If Face ID fails, iOS falls back to the
   phone's passcode.

Keel locks whenever you leave it and asks for Face ID when you come back.

## Photo a day

- **One attempt a day.** Opening the camera uses today, so shoot or lose
  the day. Leaving Keel with the camera open loses it too. There is no
  preview and no retake.
- **Hidden until the month is over.** On the 1st, last month plays once, one
  photo at a time, oldest first. If you're interrupted, it picks up where you
  stopped. After that the month is a calendar grid.
- **Where photos live:** `photos/YYYY/MM/YYYY-MM-DD.jpg` in `keel-data`, one
  commit per photo, at most 1500px and with no location data.
  - GitHub refuses a second file for the same day.
  - A shot taken offline waits on the phone and uploads later.
- **You can peek on github.com** if you want to. The app just won't show the
  photos early.

## Money (Keel's home)

Keel opens on Money: Up Bank data for you and, optionally, a partner, read
straight from Up on the phone.

- **Set up:** Money settings (the gear icon). Enter both people's names, then
  paste each Up personal access token (from api.up.com.au/getting_started).
  Keel checks a token with Up before keeping it.
- **What stays where:** tokens, names and the downloaded bank data stay on the
  phone only (local storage and IndexedDB `keel-money`, behind Face ID). None
  of it is ever sent to GitHub, and Keel never writes to Up.
- **Updating:** each open fetches the 14 days before the newest stored
  transaction. Everything is re-pulled every 7 days, or on demand with
  "Refresh everything".
- **The money rules** (owners, transfers between your own accounts and between
  the two of you, the 2Up split, round-ups, month-end balances) mirror the
  owner's desktop dashboard. A local-only script checks them against it.

## The daily photo prompt

Until today's photo is taken, or today's single attempt is used, opening Keel
shows "Today's photo" over Money.

- **Before 6pm** an × dismisses it for that open only.
- **From 6pm** there is no ×: take the photo to get in.
- If the camera is blocked or missing, the prompt says why and lets you
  through, and the day isn't used.

Photo a day's own screens (this month, past months, the reveals) sit behind
**Photos** on Money's top bar.

## Lost phone or leaked code

Delete the token at https://github.com/settings/personal-access-tokens and
make a new one. The old phone can no longer reach `keel-data`.

## Test

All tests run in headless Edge, with a virtual Face ID authenticator, a fake
camera, a fake GitHub API and a controllable clock (`tests/harness.mjs`).
Add `local` to test the working tree; leave it off to test the live site.

- `node tests/days-test.mjs`: date logic, run in Node.
- `node tests/app-test.mjs local`: the GitHub code and Face ID gate.
- `node tests/money-rules-test.mjs`: the money rules, run in Node against
  made-up people.
- `node tests/money-test.mjs local`: Up sync and the Money screens, against
  a fake Up.
- `node tests/photo-test.mjs local`: storage, camera rules, reveal, grid
  and the daily prompt.
  `ONLY=camera` (or `storage`, `cameraErrors`, `revealAndGrid`,
  `revealOffline`) runs one section.
