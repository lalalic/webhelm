---
name: webhelm
description: Use managed Chrome to inspect and interact with websites through persistent JavaScript browser Sessions or installed site Actions.
---

# WebHelm

Use this Skill when a task requires browser interaction in the user's managed Chrome, including signed-in websites. For command syntax and options, use `webhelm --help`, `webhelm session --help`, `webhelm platform --help`, or `webhelm <group> <command> --help`. CLI help is authoritative; do not infer unsupported options.

## Start

```sh
webhelm status
webhelm session list
webhelm platform list
```

If `webhelm` is missing, register the launcher with `sh "<directory containing this SKILL.md>/scripts/install-global-cli.sh"`. Run `webhelm setup` only when initial setup is needed. Do not start a competing browser or daemon. If the browser is unavailable, use `webhelm ensure` and examine its result rather than launching an unmanaged Chrome.

## Browser Sessions

Start one Session for a task, retain its returned `session_id`, and reuse it for all subsequent calls. Run JavaScript in the persistent Session context:

```sh
webhelm session start --url https://example.com
webhelm session exec SESSION_ID <<'JS'
console.log(await page_info());
console.log(await snapshot());
JS
webhelm session stop SESSION_ID
```

Helpers include `snapshot`, `page_info`, `goto_url`, `wait_for_load`, `wait_for_element`, `fill_input`, `click`, `type_text`, `js`, `cdp`, `new_tab`, `current_tab`, `list_tabs`, `switch_tab`, `close_tab`, `upload_file`, `capture_screenshot`, and `wait`. Obtain current element references from `snapshot()` before interacting and refresh them after navigation. Use `new_tab` and Session helpers rather than creating unmanaged browser targets.

Stop only Sessions you own, preferably in a cleanup step. For long-running work with no browser operations, call `webhelm session heartbeat SESSION_ID` at least every 60 seconds to keep the Session active. Never clear all Sessions as routine cleanup.

## Installed site Actions

```sh
webhelm platform list
webhelm platform profile PLATFORM
webhelm platform source PLATFORM ACTION
webhelm platform run PLATFORM ACTION --session-id SESSION_ID --config /path/to/config.json
```

Inspect a platform's profile and Action source for the actual inputs and supported behavior; do not guess a site's selectors or fields. Use `--auto-session` only for self-contained one-shot Actions. Use the returned Action result to decide the next task step.

## Safety

Work in task-owned Sessions and tabs. Protect account data and credentials; do not copy cookies or profile data to third-party services. Obtain authorization for posting, sending, uploading, publishing, purchases, and other external side effects. Verify observable results before reporting completion. Keep the existing signed-in browser and unrelated Sessions intact.
