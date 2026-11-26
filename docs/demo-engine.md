# WebHelm Demo Engine

`webhelm.demo/1` implements the iPhoneHelm Demo vocabulary inside the existing daemon-owned WebHelm Session. It resolves targets through read-only `Runtime.evaluate`, streams real CDP `Page.screencastFrame` JPEGs into a live FFmpeg H.264 encoder at the requested cadence, and composes annotations onto that capture. Between changed CDP frames the encoder repeats the latest real frame; the short optional end hold only prevents the last timeline event being clipped. This is continuous capture from the live tab, not a slideshow assembled from saved screenshots. No Playwright, second profile, global capture service, extension ownership transfer, platform Action, target DOM decoration, or input interception is introduced.

The canonical `native/NeoUseDemoCommands.inc` enumeration has **14 commands**, despite request prose saying 15: `step`, `spotlight`, `annotate`, `caption`, `say`, `cursor`, `highlight`, `clear`, `pause`, `resume`, `wait`, `status`, `start_recording`, and `stop_recording`. WebHelm rejects unknown commands rather than inventing a fifteenth. Canonical review sources were `native/NeoUseDemoCommands.inc`, `scripts/demo-session.py`, `scripts/demo_markcut.py`, and the existing Demo workflow/conformance documentation in the iPhoneHelm checkout. Limits are exactly 1..1500 characters for required text, 0..30000 ms for waits, and 1..30 fps for capture. A recording is bounded to five minutes and 256 MiB; these are WebHelm transport bounds, not guaranteed FPS or duration claims.

## Invocation

```bash
webhelm session start --url http://127.0.0.1:8787/demo-fixture.html
webhelm demo "$SESSION_ID" start_recording --output-dir /tmp/webhelm-demo --fps 15
webhelm demo "$SESSION_ID" step --title "Open preferences"
webhelm demo "$SESSION_ID" spotlight --label "Preferences" --text "Account settings"
webhelm demo "$SESSION_ID" say --text "Preferences are ready"
webhelm demo "$SESSION_ID" wait --ms 500
webhelm demo "$SESSION_ID" pause
webhelm demo "$SESSION_ID" resume
webhelm demo "$SESSION_ID" stop_recording --output-dir /tmp/webhelm-demo \
  --markcut "$(command -v markcut)" --render
webhelm session stop "$SESSION_ID"
```

`start_recording` preflights FFmpeg/ffprobe, refuses an existing nonempty output directory, resets the timeline, starts live screencast capture, and only then starts the Demo event timeline. Thus every later Demo event has a monotonic relative timestamp and live capture. It returns `video_recorded:false`. `stop_recording` must supply the exact resolved directory used at start and a Markcut CLI path. It returns `video_recorded:true` only after FFmpeg writes a valid H.264/yuv420p capture, ffprobe verifies it, Markcut verifies its project, and the default final render (unless `--no-render`) is valid H.264 with AAC audio when narration is present. Invalid or unavailable ffmpeg/ffprobe/markcut/say dependencies fail with actionable messages; failed exports clean task-owned capture artifacts and keep `video_recorded:false`.

Fresh `data-ref` values come from `snapshot()` and are resolved only against the owning Session's currently active target. Labels use case-insensitive substring matching over safe accessible names on visible interactive nodes. Ref and label are mutually exclusive; missing, stale, ambiguous, invisible, zero-area, and cross-Session targets fail before Demo state changes. Target evaluation is read-only: Demo adds no DOM nodes/styles, focus, clicks, or listeners. WebHelm's ordinary `snapshot()` may set its existing temporary ref attributes, but the Demo Engine itself does not.

Overlays work without recording and are represented only in captured frame composition. Step and caption persist until replaced or cleared. Spotlight/annotation persist until replaced/cleared; highlight expires after 650 ms; cursor is shown for 480 ms. FFmpeg scales CSS-pixel target frames to actual screencast pixel dimensions, and the encoder adds a short last-frame hold only when needed so recorded events and visible effects are not clipped.

## Safety and cleanup

Each command is serialized on the owning Session mutex. CDP screencast callbacks filter by CDP `sessionId`, so another Session or tab is untouched. Capture brings the Session's active target to the foreground so CDP can render it; switching targets during recording is rejected. Outside recording, Demo follows the Session's current active target. Normal stop, close, idle expiry, export failure, capture failure, and daemon process cleanup dispose the encoder, remove its listener, and clear Demo state before tab release; release failure leaves Session ownership available for retry without closing unrelated tabs or changing the signed-in profile.

Target refs must be unique, visible, positive-area, and current in the owning Session; accessible labels are case-insensitive substrings of visible interactive nodes and ambiguity is rejected. Resolution is read-only. `docs/demo-parity.json` is the machine-readable matrix; `docs/demo-recipe.json` is the deterministic local recipe.

## Verification

The default `npm test` suite covers the command protocol, ownership, timing,
validation and non-media behavior without FFmpeg, ffprobe or Markcut. Run
`npm run test:demo-media` explicitly on a machine with those three tools
installed (set `WEBHELM_DEMO_MARKCUT` to override the executable). It checks
real H.264 encoding, probe failure, artifact layout and overwrite refusal.
The real browser integration remains `node test/e2e/demo-engine.e2e.mjs`.
These media gates are separate from the dependency-free npm publication tests;
do not interpret a passing default test suite as proof of media encoding.
