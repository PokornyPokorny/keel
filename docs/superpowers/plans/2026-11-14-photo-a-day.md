# Photo a Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** One camera opening a day, saved to the private `keel-data` repo.
Each month's photos stay hidden until the 1st of the next month. That month
then plays as a reveal that resumes if interrupted, and after that it lives
as a calendar grid.

**Architecture:**
- Plain ES modules beside `index.html`, with no build step.
  - `days.js`: pure date logic, tested in Node.
  - `github.js`: the GitHub Contents API.
  - `local.js`: IndexedDB and `localStorage` on the phone.
  - `photos.js`: all photo UI.
- `index.html` keeps the GitHub code and Face ID gate, and hands `#app` to
  `photos.js`.
- Browser behaviour is tested in headless Edge over CDP, with:
  - a fake camera
  - an in-memory fake GitHub Contents API
  - a clock the test controls

**Tech Stack:**
- Vanilla JS (ES2022 modules), `getUserMedia`, canvas, IndexedDB
- GitHub REST Contents API
- Node 24 (built-in `fetch` and `WebSocket`) driving headless Edge over CDP

**Spec:** `docs/superpowers/specs/2026-11-14-photo-a-day-design.md`. Read it
before starting.

## Global Constraints

- **No dependencies, no build step, no framework.** Files are served as they
  are by GitHub Pages at https://pokornypokorny.github.io/keel/.
- **Data repo:** `PokornyPokorny/keel-data`.
  - Photo path: `photos/YYYY/MM/YYYY-MM-DD.jpg`.
  - One commit per photo, message `photo YYYY-MM-DD`.
- **Photo file:** JPEG, quality 0.85, long side at most 1500px. It's drawn
  through a canvas, so there's no EXIF or GPS. The front camera is saved
  unmirrored, though its live view is mirrored.
- **Day:** the phone's local date. The photo's day is the day the camera
  was opened (the attempt). This refines the spec's "moment of shutter
  tap", which was written before Ethan chose "opening the camera is the
  attempt". It keeps the attempt and the photo on the same day.
- **Month unlock:** a month unlocks when the local date reaches the 1st of
  the next month.
- **No test-only hooks in app code.** Tests control the clock, camera,
  network and GitHub through CDP only.
- **iOS video:** `<video playsinline muted autoplay>`. Otherwise iOS
  home-screen apps open the video full screen in their own player.
- **Copy is fixed.** Use these exact strings, with no exclamation marks:
  - Home, no attempt yet: `Open camera · one shot`
  - Home, photo saved or queued: `Today's done`
  - Home, camera opened but no photo: `No photo today`
  - Current month line: `{Month} · {n} days`, or `{Month} · 1 day`
  - Unlocked month row: `{Month} · {n} of {total} days`
  - Camera blocked: `Camera blocked. Allow camera access for Keel, then try again. Today isn't used.`
  - No camera: `No camera found. Today isn't used.`
  - Save failed after 3 tries: `Couldn't save today's photo: {message}`
  - Conflict: `Another phone already saved {d Mon}. The photo from this phone was dropped.`
  - Token rejected (token screen): `GitHub rejected the saved code.`
  - Reveal or grid photo not cached and offline: `Waiting for signal`
- **Month labels:** the full English month name, with the year added only
  when it isn't the current year. Short dates are written as `3 Oct`.

## Review Focus

1. **Signal drops after GitHub saved the photo but before the reply
   arrives.** The retry gets a 422. The app must see that the file on GitHub
   is its own photo (same git blob SHA), dequeue it quietly, and show no
   conflict message. Test C8 in Task 4.
2. **The app is left or killed while the camera is open.** The day stays
   used, the camera light goes off (tracks stopped), and home says
   `No photo today` even after a reload. Test C6 in Task 4.
3. **Midnight passes with Keel open.** Home rendered before midnight must
   offer the camera again after midnight, without a reload. A camera opened
   at 23:59:59 and fired after midnight saves under the earlier day. Test C12
   in Task 4.
4. **The 1st arrives while the phone is offline with nothing cached.** The
   reveal shows `Waiting for signal` for that photo, doesn't move past it or
   save progress past it, and continues when the signal is back. Test R7 in
   Task 5.
5. **The shutter is tapped before the first camera frame.** The shutter is
   disabled until the video is playing, so a black frame is never saved.
   Test C3 in Task 4.

---

### Task 1: Date logic (`days.js`)

**Files:**
- Create: `days.js`, `package.json`
- Test: `tests/days-test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (all named exports of `days.js`; a day is `'YYYY-MM-DD'`, a month
  is `'YYYY-MM'`):
  - `dayKey(d: Date) -> string`: local date
  - `monthOf(day: string) -> string`
  - `photoPath(day: string) -> string`: `photos/2026/10/2026-10-03.jpg`
  - `daysInMonth(month: string) -> number`
  - `isUnlocked(month: string, now: Date) -> boolean`
  - `monthGrid(month: string) -> (string|null)[][]`: weeks, Monday first,
    padded with `null`
  - `monthLabel(month: string, now: Date) -> string`
  - `shortDate(day: string) -> string`
  - `pendingReveals(months: {month: string, days: string[]}[], revealed: (month) => boolean, now: Date) -> string[]`:
    unlocked, not yet revealed, with at least one photo, oldest first

- [ ] **Step 1:** Create `package.json` containing `{ "type": "module", "private": true }`,
  so Node loads `days.js` as an ES module.
- [ ] **Step 2: Write the failing test** `tests/days-test.mjs`, using
  `node:assert/strict` and printing `days-test: N/N passed`. Assertions:

```js
dayKey(new Date(2026, 10, 14, 23, 59)) === '2026-11-14'
monthOf('2026-11-14') === '2026-11'
photoPath('2026-10-03') === 'photos/2026/10/2026-10-03.jpg'
daysInMonth('2026-10') === 31; daysInMonth('2028-02') === 29; daysInMonth('2026-02') === 28
isUnlocked('2026-10', new Date(2026, 9, 31, 23, 59, 59)) === false
isUnlocked('2026-10', new Date(2026, 10, 1, 0, 0, 0)) === true
isUnlocked('2026-12', new Date(2027, 0, 1)) === true
isUnlocked('2026-11', new Date(2026, 10, 30)) === false
monthGrid('2026-10')[0] deepEquals [null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
monthGrid('2026-10').flat().filter(Boolean).length === 31
monthGrid('2026-10').every(w => w.length === 7)
monthLabel('2026-10', new Date(2026, 10, 1)) === 'October'
monthLabel('2025-10', new Date(2026, 10, 1)) === 'October 2025'
shortDate('2026-10-03') === '3 Oct'
pendingReveals([{month:'2026-10',days:['2026-10-01']},{month:'2026-09',days:['2026-09-02']},
                {month:'2026-08',days:[]},{month:'2026-11',days:['2026-11-01']}],
               () => false, new Date(2026, 10, 14))
  deepEquals ['2026-09', '2026-10']        // August is empty, November is still locked
pendingReveals(same, m => m === '2026-09', new Date(2026, 10, 14)) deepEquals ['2026-10']
```

- [ ] **Step 3:** Run `node tests/days-test.mjs`. Expected: it fails with
  `Cannot find module` for `days.js`.
- [ ] **Step 4:** Implement `days.js`. Use `Date` local getters only, never
  UTC getters. Short month names are
  `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`.
- [ ] **Step 5:** Run `node tests/days-test.mjs`. Expected:
  `days-test: 13/13 passed`.
- [ ] **Step 6:** Commit:
  `git add package.json days.js tests/days-test.mjs && git commit -m "Photo a day: date logic"`.

### Task 2: Browser test harness

**Files:**
- Create: `tests/harness.mjs`, `tests/fixtures/` (for small JPEGs the test
  generates on the fly; nothing is committed in this folder)
- Modify: `tests/app-test.mjs`, to use the harness. Its printed output must
  not change, because gate G11 matches it.

**Interfaces:**
- Produces (`tests/harness.mjs`):
  - `launch({ local: boolean, camera: 'granted'|'denied'|'none' }) -> Promise<H>`
    - `--headless=new`, `--use-fake-device-for-media-stream`,
      `--use-fake-ui-for-media-stream`, a temporary profile and a free
      debugging port.
    - `camera: 'denied'` uses CDP `Browser.setPermission` for
      `videoCapture` = `denied`.
    - `camera: 'none'` omits the fake device flag and stubs nothing.
      Headless Edge without a camera rejects with `NotFoundError`.
  - `H.send(method, params)`, `H.eval(expr) -> value` (with `userGesture: true`),
    `H.wait(ms)`, `H.close()`
  - `H.open(path = '')`: navigates to `https://pokornypokorny.github.io/keel/` + path.
    With `local`, the page and its `.js` files are served from the working
    tree through `Fetch.fulfillRequest`, as the current `app-test.mjs` does
    for `index.html`.
  - `H.setClock(isoLocal: string)`: from the next navigation on, `Date`
    starts at that local time and keeps ticking. Done with
    `Page.addScriptToEvaluateOnNewDocument`, replacing any earlier clock
    script.
  - `H.advanceClock(ms)`: moves the running page's clock forward without
    reloading.
  - `H.setOffline(bool)`: `Network.emulateNetworkConditions`. The fake
    GitHub API also refuses requests while offline, because Fetch
    interception bypasses network emulation.
  - `H.github`, the fake Contents API for `PokornyPokorny/keel-data`:
    - `files: Map<path, {bytes: Buffer, sha: string}>`, where `sha` is the
      git blob SHA-1: `sha1('blob ' + len + '\0' + bytes)`
    - `commits: {path, message}[]`
    - `token = 'github_pat_good'`
    - `failNextPut: number|null`: the status to answer on the next PUT
      after storing the file anyway (simulates a lost response)
    - `seed(path, bytes)`
    - Handles `GET contents/{dir}` (directory listing JSON `[{name, path,
      sha, type}]`, or 404), `GET contents/{file}` (JSON with `sha` and
      base64 `content`, or raw bytes when the `Accept` header contains
      `raw`), and `PUT contents/{file}` (201 new, 422 if it exists, 401 for
      a wrong token). Also `GET repos/PokornyPokorny/keel-data` (200 or 401)
      and `OPTIONS` preflight.
  - `H.addFaceId()`: a virtual authenticator, as in the current
    `app-test.mjs`.
  - `H.signIn()`: pastes the good code, taps `Not now` on Face ID, and
    waits for `#app`.
  - `jpegInfo(bytes: Buffer) -> {width, height, hasExif}`: reads the SOF0
    or SOF2 marker for the size; `hasExif` means an APP1 `Exif` segment
    exists.
  - `makeJpeg(H, label) -> Promise<Buffer>`: draws the label on a canvas in
    the page and returns a JPEG, used to seed months.

- [ ] **Step 1:** Write `tests/harness.mjs` with the interface above.
  Move the Edge launch, CDP plumbing and fake API out of
  `tests/app-test.mjs`.
- [ ] **Step 2:** Rewrite `tests/app-test.mjs` on top of the harness.
- [ ] **Step 3:** Run `node tests/app-test.mjs local`. Expected: the same 8
  lines as before, with `api calls: 2 all to keel-data` last.
- [ ] **Step 4:** Commit:
  `git add tests && git commit -m "Test harness: fake camera, clock, GitHub contents API"`.

### Task 3: Storage (`github.js`, `local.js`)

**Files:**
- Create: `github.js`, `local.js`
- Test: `tests/photo-test.mjs`. Created here, and extended in Tasks 4 and 5.

**Interfaces:**
- Consumes: `photoPath` and `monthOf` from `days.js`.
- Produces from `github.js`:
  - `class GitHubError extends Error { code: 'unauthorized'|'offline'|'http'; status?: number }`
  - `listMonths(token) -> Promise<string[]>`: `'YYYY-MM'` values found
    under `photos/`
  - `listDays(token, month) -> Promise<string[]>`: days with a file, sorted
  - `getPhoto(token, day) -> Promise<Blob>`: uses `Accept: application/vnd.github.raw`
  - `remoteSha(token, day) -> Promise<string|null>`
  - `putPhoto(token, day, blob) -> Promise<'saved'|'exists'>`: no `sha` in
    the body, so GitHub refuses (422) if the file exists
  - `blobSha(blob) -> Promise<string>`: the git blob SHA-1, via `crypto.subtle`

  Every request uses `cache: 'no-store'`. A 401 throws `unauthorized`. A
  `fetch` rejection throws `offline`. A 404 on a directory returns `[]`.
- Produces from `local.js` (IndexedDB database `keel`, stores `used`,
  `queue` and `photos`, all keyed by day):
  - `markUsed(day)`, `isUsed(day) -> bool`
  - `enqueue(day, blob)`, `queuedDays() -> string[]`, `queuedBlob(day) -> Blob`,
    `dequeue(day)`
  - `cachePut(day, blob)`, `cacheGet(day) -> Blob|undefined`
  - `revealPos(month) -> number|'done'|null`, `setRevealPos(month, v)`.
    These use `localStorage` key `keel-reveal-YYYY-MM`.
  - `takeNotice() -> string|null`, `setNotice(text)`. These use
    `localStorage` `keel-notice`, read once and then cleared, and carry the
    conflict message.

- [ ] **Step 1: Write the failing tests** in `tests/photo-test.mjs`. The
  harness is `local` with `camera: 'granted'`, after `signIn()`. The tests
  call the modules through `H.eval("import('./github.js').then(...)")`.
  Each prints `PASS`/`FAIL <id>`, and the file ends with
  `photo-test: N/N passed`.
  - **S1:** `putPhoto(good, '2026-11-14', jpeg)` returns `'saved'`. Then
    `H.github.files` has `photos/2026/11/2026-11-14.jpg` with the same
    bytes, and the last commit message is `photo 2026-11-14`.
  - **S2:** the same call again returns `'exists'`, and the file count is
    unchanged.
  - **S3:** `listMonths` returns `['2026-11']`, `listDays(…, '2026-11')`
    returns `['2026-11-14']`, and `listDays(…, '2026-07')` returns `[]`.
  - **S4:** `putPhoto('github_pat_bad', …)` rejects with `code === 'unauthorized'`.
  - **S5:** `blobSha(jpeg)` equals `H.github.files.get(path).sha`.
  - **S6:** `markUsed('2026-11-14')`, `enqueue('2026-11-15', blob)` and
    `setRevealPos('2026-10', 4)`, then reload. Expected: `isUsed` is true,
    `queuedDays` is `['2026-11-15']`, `revealPos('2026-10')` is `4`, and
    `isUsed('2026-11-13')` is false.
- [ ] **Step 2:** Run `node tests/photo-test.mjs local`. Expected: S1–S6 FAIL,
  because the modules are missing.
- [ ] **Step 3:** Implement `github.js` and `local.js` to the interfaces
  above. Wrap each IndexedDB request in a promise. Don't add a wrapper
  library.
- [ ] **Step 4:** Run `node tests/photo-test.mjs local`. Expected:
  `photo-test: 6/6 passed`.
- [ ] **Step 5:** Commit:
  `git add github.js local.js tests/photo-test.mjs && git commit -m "Photo a day: GitHub and on-phone storage"`.

### Task 4: Home and camera (`photos.js`, wired into `index.html`)

**Files:**
- Create: `photos.js`
- Modify: `index.html`:
  - The inline `<script>` becomes `type="module"`, and imports
    `startPhotos` from `./photos.js`.
  - `show('app')` calls `photos.refresh()`.
  - Add the photo styles to the existing `<style>` block.
- Test: `tests/photo-test.mjs`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces from `photos.js`:
  - `startPhotos({ root: HTMLElement, getToken: () => string|null, onUnauthorized: () => void }) -> { refresh(): Promise<void> }`
- Index side: `onUnauthorized` clears `keel-token`, shows the token screen,
  and sets its error to `GitHub rejected the saved code.` The queue is
  kept.

**Behaviour:**
- **Home state for today:** checked in this order.
  1. A queued photo or a remote file for today: `Today's done`.
  2. `isUsed(today)`: `No photo today`.
  3. Otherwise the `Open camera · one shot` button.
- **The current month's count** is remote days plus queued days. No image of
  the current month is ever put in the DOM.
- **Opening the camera:**
  1. Call `getUserMedia({video:{facingMode:'environment', width:{ideal:1920}, height:{ideal:1920}}, audio:false})`.
  2. Wait for the video's `playing` event.
  3. `await markUsed(day)`.
  4. Only then unhide the camera layer.

  A `NotAllowedError` gives the blocked message. A `NotFoundError` or
  `OverconstrainedError` gives the no-camera message. In both cases
  `markUsed` is not called.
- **The camera layer** has exactly two buttons: the flip button
  (`aria-label="Flip camera"`) and the shutter (`aria-label="Take photo"`),
  which stays disabled until `playing`.
  - The front camera's preview gets the CSS `transform: scaleX(-1)`.
  - Flipping stops the tracks and reopens with `facingMode:'user'` or
    `'environment'`. Flipping never calls `markUsed` again.
- **Shutter tap:**
  1. Draw the frame to a canvas at most 1500px on its long side, unmirrored.
  2. `toBlob('image/jpeg', 0.85)`, then stop the tracks.
  3. `enqueue(day, blob)`, where `day` is the day captured when the camera
     opened.
  4. Close the layer, re-render home, then `flushQueue()`.

  If encoding or enqueuing fails, keep the canvas and retry 3 times, 1
  second apart, then show `Couldn't save today's photo: {message}`.
- **`flushQueue()`:** for each queued day, oldest first, call `putPhoto`.
  - `saved`: dequeue it.
  - `exists`: compare `remoteSha` with `blobSha`. If they're the same,
    dequeue quietly. If they differ, dequeue and call `setNotice` with the
    conflict message.
  - `unauthorized`: call `onUnauthorized()` and stop.
  - `offline`: stop.

  Run it on `refresh()`, on `window` `online`, and after each shot.
- **`visibilitychange` to hidden** while the camera is open: stop the
  tracks, close the layer, and re-render home. The day is already used.
- **Day rollover:** a 30-second interval re-renders home when
  `dayKey(new Date())` changes.
- **Notices:** home shows `takeNotice()` once, as a line under today's state.

- [ ] **Step 1: Write the failing tests** in `tests/photo-test.mjs`, a
  section that starts on a fresh profile. Each test sets the clock and
  opens the page as needed. Names are C1–C12.
  - **C1** (camera granted, clock `2026-11-14T09:00`): home text includes
    `Open camera · one shot` and `November · 0 days`.
  - **C2** (camera denied): tapping open shows
    `Camera blocked. Allow camera access for Keel, then try again. Today isn't used.`.
    `isUsed('2026-11-14')` is false, and the open button is still there.
  - **C2b** (camera `'none'`): shows `No camera found. Today isn't used.`,
    and `isUsed` is false.
  - **C3** (granted): tap open. Right after the camera layer is visible,
    `isUsed('2026-11-14')` is true. The layer contains exactly 2 buttons,
    labelled `Flip camera` and `Take photo`. Read straight after the tap,
    before `playing`, the shutter's `disabled` is true.
  - **C4:** tap the shutter. Then:
    - home shows `Today's done` and `November · 1 day`
    - `H.github.files` has `photos/2026/11/2026-11-14.jpg`
    - `jpegInfo(bytes)` has a long side of at most 1500 and
      `hasExif === false`
    - `document.querySelectorAll('#app img').length === 0`
  - **C5:** reload. Home shows `Today's done`, and there's no open button.
  - **C6** (clock `2026-11-15T09:00`): open the camera, then fake `hidden`
    and dispatch `visibilitychange`. Expected:
    - every track is `readyState === 'ended'` (stash the stream on
      `window` from the test through
      `MediaStreamTrack.prototype.stop` spying)
    - home shows `No photo today`, and still does after a reload
    - no file exists for `2026-11-15`
  - **C7** (clock `2026-11-16T09:00`, offline): take a photo. Home shows
    `Today's done`, `queuedDays()` is `['2026-11-16']`, and there's no
    remote file. Go online and dispatch `online`. The file arrives within
    3 seconds and the queue is empty.
  - **C8** (clock `2026-11-17T09:00`, `failNextPut = 502`): take a photo.
    The queue still holds `2026-11-17`. Reload. The queue is empty, no
    conflict notice appears, and there is exactly 1 commit for that path.
  - **C9:** offline, clock `2026-11-18T09:00`. Take a photo, then
    `H.github.seed` a different JPEG at `2026-11-18`. Go online and reload.
    Expected:
    - the notice reads exactly
      `Another phone already saved 18 Nov. The photo from this phone was dropped.`
    - the queue is empty, and the remote bytes are the seeded ones
    - after another reload, the notice is gone
  - **C10** (clock `2026-11-19T09:00`): `seed` today's file, then open.
    Home shows `Today's done`, with no open button.
  - **C11** (clock `2026-11-20T09:00`, offline): take a photo. Set
    `H.github.token = 'github_pat_new'` so the stored code is rejected, then go online and reload.
    Expected: the token screen shows `GitHub rejected the saved code.`,
    and `queuedDays()` is `['2026-11-20']`. Paste `github_pat_new` and tap
    `Not now`. The file arrives and the queue is empty.
  - **C12:** clock `2026-11-21T23:59:59`, home rendered. Open the camera,
    `advanceClock(2000)`, then shoot. The file is saved at `2026-11-21`.
    Then `advanceClock(31000)`. With no reload, home shows
    `Open camera · one shot`.
- [ ] **Step 2:** Run `node tests/photo-test.mjs local`. Expected: C1–C12 FAIL,
  and S1–S6 still pass.
- [ ] **Step 3:** Implement `photos.js` (home and camera) and wire it into
  `index.html` per Behaviour above. The camera layer is a `position:fixed`
  full-screen `<div>`, with the video set to `object-fit: cover`.
- [ ] **Step 4:** Run `node tests/photo-test.mjs local` and
  `node tests/app-test.mjs local`. Expected: `photo-test: 19/19 passed`,
  and app-test unchanged.
- [ ] **Step 5:** Commit:
  `git add photos.js index.html tests/photo-test.mjs && git commit -m "Photo a day: home and one-shot camera"`.

### Task 5: Reveal and grid

**Files:**
- Modify: `photos.js`, `index.html` (styles)
- Test: `tests/photo-test.mjs`

**Interfaces:**
- Consumes: `pendingReveals`, `monthGrid`, `monthLabel` and `shortDate`;
  `listMonths`, `listDays` and `getPhoto`; `cacheGet`, `cachePut`,
  `revealPos` and `setRevealPos`.
- Produces: nothing new outside `photos.js`.

**Behaviour:**
- **Starting the reveal:** `refresh()` computes `pendingReveals`. If any
  are pending, it opens the reveal for the oldest one before showing home.
  - Months come from `listMonths` plus the months of queued days.
  - A month's days come from `listDays` plus that month's queued days.
- **Reveal layer:** one full-screen `<img>` (`object-fit: contain`), plus a
  corner label `{shortDate} · {i}/{n}`.
  - Tapping goes to the next photo.
  - A rightward swipe of more than 50px, or the left-arrow key, goes back.
  - Each move calls `setRevealPos(month, index)`.
  - After the last photo: `setRevealPos(month, 'done')`, then the next
    pending month. When none are left, show the grid of the last month
    revealed.
  - The reveal resumes at `revealPos` when it's a number.
- **Getting each photo:** try `cacheGet`, then the queued blob, then
  `getPhoto` followed by `cachePut`.
  - If it fails offline, show `Waiting for signal`. Don't advance or save
    progress past that photo.
  - Retry on `online`.
  - Preload the next 2 photos.
- **Grid:**
  - A header `{monthLabel} · {n} of {total} days`, plus a `Back` button
    that returns home.
  - The weekday header row is `M T W T F S S`.
  - Cells come from `monthGrid`. A day with a photo shows a thumbnail;
    a missed day shows its number, dimmed.
  - Tapping a photo opens it full screen; tapping again closes it.
- **Home list:** unlocked months, newest first, as rows
  `{monthLabel} · {n} of {total} days`. A row opens the grid, or the reveal
  if that month isn't `done` yet.
- Object URLs are revoked when a layer closes.

- [ ] **Step 1: Write the failing tests** in `tests/photo-test.mjs`, on a
  fresh profile. Seed 27 labelled JPEGs for October 2026: every day except
  the 5th, 12th, 19th and 26th. Seed 2 for September 2026: the 3rd and the
  20th. Use `makeJpeg`.
  - **R1** (clock `2026-10-31T23:59:00`): no reveal layer. Home shows
    `October · 27 days`, and there are no `img` elements.
  - **R2** (clock `2026-11-01T00:00:30`, reload): the reveal is visible
    without any tap, and the label is `3 Sep · 1/2`.
  - **R3:** tap twice. The label is `1 Oct · 1/27`.
  - **R4:** tap 4 times, giving `6 Oct · 5/27`, then swipe right. The label
    is `4 Oct · 4/27`. Reload: the reveal resumes at `4 Oct · 4/27`.
  - **R5:** tap through to the end. The grid shows the header
    `October · 27 of 31 days`. The first row has 3 empty leading cells.
    It has 27 `img` cells and 4 missed cells with the numbers 5, 12, 19
    and 26.
  - **R6:** reload. There's no reveal. Home rows, in order, are
    `October · 27 of 31 days` then `September · 2 of 30 days`. Tap October
    and the grid shows; tap a photo and a full-size view shows; tap it again
    and it closes.
  - **R7:** on a fresh profile (nothing cached), clock `2026-11-01T08:00`,
    offline, then reload.
    - The reveal shows `Waiting for signal`. A tap doesn't change the
      label or `revealPos`.
    - Go online and dispatch `online`. The photo shows within 3 seconds.
  - **R8:** after R6, go offline and open the October grid. All 27
    thumbnails load from the cache (`naturalWidth > 0`).
- [ ] **Step 2:** Run `node tests/photo-test.mjs local`. Expected: R1–R8 FAIL,
  and the earlier tests still pass.
- [ ] **Step 3:** Implement the reveal, grid and home list in `photos.js`.
- [ ] **Step 4:** Run `node tests/photo-test.mjs local`. Expected:
  `photo-test: 27/27 passed`.
- [ ] **Step 5:** Commit:
  `git add photos.js index.html tests/photo-test.mjs && git commit -m "Photo a day: monthly reveal and grid"`.

### Task 6: Ship

**Files:**
- Modify: `README.md` (a short "Photo a day" section: the rules and where
  the photos live), `gates/GATES.md`

- [ ] **Step 1:** Add gates to `gates/GATES.md`:
  - **G14:** `node tests/days-test.mjs`, expecting `/days-test: (\d+)\/\1 passed/`
  - **G15:** `node tests/photo-test.mjs local`, expecting
    `photo-test: 27/27 passed`
  - **G16:** `node tests/photo-test.mjs` against the live site, expecting
    `photo-test: 27/27 passed`
  - **G17:** the live page serves `photos.js`, `github.js`, `local.js` and
    `days.js` with status 200 and a JavaScript content type
- [ ] **Step 2:** Push, wait for the Pages build of `HEAD`, then run
  `node "C:\Users\ethan\.agents\skills\unlazy\scripts\gate-check.mjs" gates/GATES.md`.
  Expected: `ALL MET`.
- [ ] **Step 3:** Commit the README:
  `git commit -m "Photo a day: README"`, then push.
