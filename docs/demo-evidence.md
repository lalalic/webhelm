# Demo Engine verification evidence

Status: verified in this checkout on 2026-11-25. Generated media and detailed
browser evidence are outside the repository at
`/tmp/webhelm-demo-evidence-final-742/`; the directory contains only a local
fixture recording, extracted frame samples, media metadata and reproduction
commands. It contains no signed-in page content.

## Reproduction

```sh
WEBHELM_DEMO_EVIDENCE_DIR=/tmp/webhelm-demo-evidence-final-742 \
  node test/e2e/demo-engine.e2e.mjs
```

The E2E uses the existing managed Chrome endpoint, starts two owned WebHelm
Sessions on a deterministic `127.0.0.1` fixture, performs real navigation and a
button click, resolves a fresh snapshot target, applies capture overlays, tests
pause/resume and records the second Session before and after stopping the first.
It stops both owned Sessions and verifies no fixture target remains.

## Measured result

- Node.js 25.6.0; WebHelm package/runtime 1.0.51.
- FFmpeg/ffprobe 7.1.5; Markcut 3.2.0.
- `capture.mp4`: H.264, yuv420p, 1280x694, 1.133333 seconds, measured 15 fps.
- 11 events recorded; final event effects end before capture end.
- Markcut `verify` and `render` succeeded. Render is H.264 with AAC audio and
  positive duration. The `say` narration asset is AAC, starts at the timeline
  event time, and ends within the capture.
- Inspected extracted capture and rendered playback frames: step banner is
  clear of fixture heading; target highlight and caption are visible.
- Demo overlay commands left fixture DOM unchanged. The independent Session
  remained at its initial counter value and survived the first Session stop.
- Final Session count is zero and no owned fixture tab remains.
- `npm test`: 192 passed, 0 failed. Focused Demo unit and real-browser E2E tests
  passed. `npm pack --dry-run --json`: 44 entries; no bundled Actions, evidence,
  generated media, or extra bundles.
- ChatGPT Runner/Queue and Actions contracts were not changed; mandatory
  ChatGPT three-MVP gate was not triggered.

The 15 fps value is this run's measured output, not a guaranteed capture rate.
The browser proof verifies the E2E and export path against the installed local
Chrome, FFmpeg and Markcut versions; it does not certify every site or platform.
