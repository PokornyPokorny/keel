# Photo a day — design

Date: 2026-11-14. Status: approved by Ethan 2026-11-14.

## Intent

Keel is Ethan's private page for tracking and improving his life. Its first
feature is a photo a day. He gets **one attempt** each day, and he **can't see
a month's photos until that month is over**. On the 1st, the month just ended
opens as a one-by-one reveal, then stays as a calendar grid.

He hasn't said what the photos are of. The design doesn't assume a subject, so
both cameras are offered.

Tone matters: Ethan doesn't want Keel to feel cringe or corny. No
congratulations, confetti, streaks or motivational copy anywhere.

## Goals

1. One shutter tap per local calendar day. The photo is saved immediately,
   with no preview and no retake.
2. Photos from the current month are never shown in the app, not even today's.
3. From the 1st of the next month, that month opens once as a tap-through
   reveal (oldest first), then as a calendar grid. Tapping a day shows it
   full size.
4. Photos live in the private repo `PokornyPokorny/keel-data`. Losing the
   phone doesn't lose the photos.

## Non-goals (not in this version)

- Captions, notes, moods or tags on photos
- Daily reminders or notifications
- Exporting a month as a video or sharing photos
- Deleting or replacing a photo from the app
- Importing photos from the camera roll
- Scrambling or encrypting photos so they can't be seen on github.com.
  Ethan chose "don't bother": peeking via GitHub is accepted.

## Anti-goals (would be a failure even if it works)

- Any way inside the app to see the current month's photos
- Any way inside the app to retake or replace a day's photo
- Streak counters, "you missed a day!" guilt, celebratory copy or animation
- A camera-roll picker that lets an old photo stand in for today

## Constraints

- **Existing app.** `index.html` is one static page on GitHub Pages
  (https://pokornypokorny.github.io/keel/). It has no build step, no
  framework and no dependencies. It's installed as a home screen web app on
  Ethan's iPhone.
- **Existing gate.** Flow today: paste the GitHub code (a fine-grained token
  with Contents read/write on `keel-data` only), kept in `localStorage`
  `keel-token`, then a Face ID passkey lock. The photo feature lives inside
  `<main id="app">`, which only shows after unlock. Leaving the app re-locks
  it. See `README.md`.
- **Same model as Yarvo Box Stock**
  (`G:\My Drive\Yarvo\Experiments\box-stock`): plain JS, GitHub Contents
  API, token per phone. Reuse its patterns where they fit.
- **iOS's own camera picker** (`<input capture>`) always offers Retake, so
  it breaks the one-attempt rule. The camera must run in the page
  (`getUserMedia`).
- **Signal can be patchy.** A shot taken offline must not be lost and must
  still count as that day.
- **The repo is public,** so nothing secret goes in `index.html` or the repo.

## Approaches considered

1. **Single page plus the GitHub Contents API, like Box Stock** (chosen).
   - In-page camera, one commit per photo to `keel-data`.
   - Reveal and grid as plain DOM.
   - No new tooling, matches the existing app, photos are backed up.
2. **Photos only on the phone** (IndexedDB). Simpler, no network. Rejected:
   losing or wiping the phone loses every month, and it ignores the GitHub
   code setup Ethan just did.
3. **A framework and build step** (React plus Vite). Rejected: tooling and a
   deploy step for one screen, a camera and a grid. Box Stock shows plain
   code is enough.

## Decided

### Day and month

- A day is the phone's local calendar date at the moment of the shutter tap.
- A month unlocks when the phone's local date reaches the 1st of the next
  month.

### Home (inside `#app`)

- **Today, not taken yet:** a large shutter entry button.
- **Today, taken:** "Today's done", until local midnight.
- **Current month:** a line like "November · 14 days". This is a count of
  photos only; no thumbnails are shown or downloaded.
- **Unlocked months:** a list, newest first, like "October · 27 of 31 days".
  - Not yet revealed on this phone: tapping starts the reveal.
  - Already revealed: tapping opens the grid.

### Camera, and what uses up the day (Ethan's answer: opening the camera)

- **Opening the camera is the attempt.** There is no close or cancel
  button. Once the camera is open, today is used: shoot, or lose the day.
- The attempt counts from the moment the live camera picture first appears.
  The app records that today was used **before** that picture is shown, so
  leaving the app or killing it with the camera open still counts.
  *(Claude's call: counting from when the picture appears, not from the
  button tap, means a denied permission prompt or a broken camera doesn't
  cost a day.)*
- Leaving the app while the camera is open loses the day. Home then shows
  "No photo today". No retry.
- The shutter-entry button says plainly that opening it uses today, for
  example "Open camera · one shot". This is so it's never a surprise.
- Opens full screen in the page, starting on the back camera. A flip button
  switches between front and back. Flipping is free.
- One shutter tap captures one frame. The camera then closes and the photo
  saves. There is no preview.
- If camera permission is denied, or no camera is available, show a plain
  message. No attempt is used up in that case.
- *(Claude's call)* If saving fails after the shutter tap, the captured
  frame is kept in memory and the save is retried, with a plain error if it
  keeps failing. The day is still used, but a captured shot isn't thrown
  away because of a technical fault.

### Photo file

- Draw the frame to a canvas, scale so the long side is at most 1500px, and
  encode as JPEG (about 300KB). Going through a canvas also drops EXIF and
  GPS data.
- Stored at `photos/YYYY/MM/YYYY-MM-DD.jpg` in `keel-data`, one commit per
  photo.

### One per day, enforced twice

1. **In the app:** the home screen won't offer the camera once today is
   used, taken or queued.
   - "Used" means the camera was opened: a record on this phone, written
     before the camera picture shows.
   - *(Claude's call)* The home screen also checks GitHub for today's file
     when online, so a second phone can't take another one.
2. **On GitHub:** the upload is a Contents API create without a `sha`. If the
   file already exists, GitHub refuses (422). The app treats that as "already
   taken", not as an error to retry.

### Offline

- The captured photo goes into an IndexedDB queue (with its date) before the
  upload is tried.
- The queue is retried on next open and when the phone comes back online.
- A queued photo counts as taken for its day.
- *(Claude's call)* If a queued upload is refused because another phone
  already saved that day, the queued shot is dropped and home says so once.
  The first photo saved wins.
- *(Claude's call)* A 401 that clears the stored code keeps the queue. It
  uploads once a new code is pasted.
- *(Claude's call)* A queued photo appears in its month's reveal and grid
  once that month unlocks, even if it hasn't uploaded yet.

### Reveal (Ethan's answer: starts by itself, resumes)

- The first time Keel is unlocked on or after the 1st, the reveal of the
  month just ended starts by itself, straight after Face ID.
- If he leaves partway, it resumes at the same photo next time. The place is
  stored per month on the phone.
- *(Claude's call)* If more than one month is waiting (Keel wasn't opened
  for a while), they play oldest first, one after the other.
- A month with no photos skips the reveal and goes straight to the grid.
- Full-screen photos, oldest first.
- Tap to go to the next photo. Swipe back is allowed.
- Small date and position in the corner, like "3 Oct · 3/27".
- After the last photo, go to the grid. Mark the month as revealed on this
  phone (`localStorage`).

### Grid

- A Monday-first calendar for that month: photos in day cells, missed days
  shown as empty cells.
- Tapping a day shows it full size.

### Caching

- Past-month photos are downloaded once and kept on the phone
  (Cache Storage or IndexedDB), so revisiting a month is instant and offline.

### Token errors

- A 401 from GitHub clears the stored code and returns to the paste screen,
  with "GitHub rejected the saved code".

### Copy

- Plain and short. Month names written in full.
- No exclamation marks.

## Left to the builder

- Exact styling, within the existing look: black background, white text,
  system font, the current button styles.
- Whether the front camera's live view is mirrored. The saved file is not
  mirrored, matching the iPhone camera.
- JPEG quality, and whether to use IndexedDB or Cache Storage for caching
  and the queue.
- How month listings are fetched. Contents API directory listing is the
  default; the Git trees API is fine if listing gets slow.
- The test approach. It extends `tests/app-test.mjs` (headless Edge, CDP):
  - fake camera via Edge's fake media flags
  - in-memory fake GitHub Contents API
  - a controllable clock, for the month unlock and the day rollover

  Avoid test-only hooks in `index.html` where CDP can do the job instead.
