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

## Lost phone or leaked code

Delete the token at https://github.com/settings/personal-access-tokens and
make a new one. The old phone can no longer reach `keel-data`.

## Test

`node tests/app-test.mjs local` runs `index.html` in headless Edge with a
virtual Face ID authenticator and a fake GitHub API. Without `local` it
tests the live site.
