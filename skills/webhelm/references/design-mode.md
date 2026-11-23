# Design Mode — native site + ChatGPT thread

Use when the user asks for a visual design collaboration, such as
"design mode with web", "design mode with iPhone app UI", "design mode with app UI",
"design mode with video", or wants to inspect a native motion effect together.

**Goal:** the user and Agent see and interact with the same original site in
Chrome Split View. The existing active ChatGPT thread is the companion pane.
Neither screenshots nor an iframe/search aggregation page substitute for the
real site.

## Pick a starting site

The Agent chooses the closest **original site**, not a local term catalog.
These are examples, not a required set; follow the user's named URL/site and
verify availability before claiming that any specific search/demos work.

| User intent | Default site | Alternative (different focus) |
|---|---|---|
| Web UI motion / effects | https://www.motionlex.online/ | https://vibe-dictionary.picamoji.com/ (interactive effect terms) |
| Web page layouts and patterns | https://www.awwwards.com/ | https://www.figma.com/community |
| iPhone / iOS app UI | https://mobbin.com/ | https://screenlane.com/ (mobile screen patterns) |
| General app / desktop UI | https://mobbin.com/ | https://www.figma.com/community |
| App button animation / interaction | https://www.motionlex.online/ | https://rive.app/community/ (interactive animation) |
| Video / camera transitions / shot language | https://eyecannndy.com/ | https://vincentwei1021.github.io/video-shotcraft/ |
| Motion graphics / Lottie | https://lottiefiles.com/ | https://rive.app/community/ |

For "app UI", use Mobbin by default. Prefer a motion demo site if the user
specifies button behavior, animation, or micro-interactions. For iPhone native
apps, the reference website is viewed through Chrome; actual iOS UI execution
still requires a phone-testing tool.

## Agent workflow

1. Confirm the user has an **active ChatGPT conversation Tab** inside the
   managed WebHelm Chrome Profile. The Extension refuses to split when the
   active tab is not a ChatGPT thread; it never guesses among background tabs.
   A Session already in Design Mode can always be exited.
2. Reuse any relevant existing WebHelm Design Session first:
   `webhelm design status`. Reuse its session ID with `webhelm session exec`
   for continued discussion; do not start another browser session each turn.
3. To begin, choose a source site and run:
   `webhelm design start --url https://mobbin.com/`
   Retain the returned `session_id`. To pair a *previously created* CLI
   Session without losing its state: `webhelm design attach SESSION_ID`.
4. Use `webhelm session exec SESSION_ID` and `snapshot()/click()/fill_input()`
   to search **inside the original site**, showing the resulting original
   demos to the user. Do not navigate away while the user is examining or
   manipulating the page. Wait for explicit follow-up instructions.
5. Continue in the **same Session and same Tab**. Report which original
   URL/view is open; do not pretend a blocked/failed site loaded.
6. When the user explicitly ends the design discussion:
   `webhelm design stop SESSION_ID`. The Split View is undone, the original
   ChatGPT Tab is restored to its prior window/group/index, and only Sessions
   created by `design start` are also stopped. A manually attached Session
   returns to normal lifecycle, and its owner must eventually stop it.

## Lifecycle and failure policy

- Design Mode Sessions are renewed by the existing daemon heartbeat.
  **No extra keepalive service** is required.
- When a Session stops or is garbage-collected, the daemon requests
  the Extension to **unsplit and restore the companion ChatGPT Tab first**.
  If restoration fails, leave ownership protected and report a real error;
  never silently recycle a still-shared Tab.
- If the daemon restarts without its former Session, the Extension checks
  for now-orphaned Design records after the daemon reconnects, then restores
  the companion. During disconnection it waits, avoiding false GC.
- A start failure (unsupported Chrome Split View, no active ChatGPT thread,
  blocked reference site) must not leave a new leased Session behind.
- Users may toggle Design Mode from the Extension's per-Session icon.
  The icon is absent for unpaired Sessions when the active Tab is not ChatGPT;
  active Design Sessions always expose an exit icon.
- The Agent must not close/recreate the ChatGPT Tab, override other Session
  ownership, change authentication state, or bypass source site restrictions.

## CLI

```sh
webhelm design start --url https://mobbin.com/
webhelm design status
webhelm session exec SESSION_ID
webhelm design attach SESSION_ID
webhelm design stop SESSION_ID
```

Use `webhelm help design` and `webhelm help design start` for the authoritative
installed-runtime syntax. For normal one-shot browser automation, use the
ordinary WebHelm Session contract instead.
