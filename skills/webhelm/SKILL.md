---
name: webhelm
description: Use when a task needs real Google Chrome browser control (websites, logged-in pages, tabs, navigation, clicks, forms, uploads, screenshots) or installed WebHelm site/platform Actions such as ChatGPT, Z.ai, DeepSeek, or Xiaohongshu. Provides persistent JavaScript browser Sessions and reusable site-specific Actions in managed Chrome.
---

# WebHelm

Use WebHelm to work in the user's managed Chrome, including already signed-in sites. Choose an installed platform Action when it supports the user goal; otherwise use a browser Session. Do not create a Session just because a platform exists. **CLI `--help` is authoritative** for syntax and options; do not guess flags.

## Initial setup (one time)

If `webhelm` is not on `PATH`, run `sh ~/.agents/skills/webhelm/scripts/install-global-cli.sh` (or the same script via the discovered Skill path). Then:

```sh
webhelm setup
webhelm status
webhelm platform list
```

Skip setup when already configured. If managed Chrome needs recovery, run `webhelm ensure` and inspect its result; do not start a second unmanaged Chrome.

## Sessions: always start and stop as a pair

`session start` returns a `session_id`. Reuse **that exact ID** for every `exec` and stop it in a cleanup step, including after errors. Run the following as one shell script. Never stop unrelated Sessions.

```sh
set -eu
SESSION_ID=$(webhelm session start --url https://example.com | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).session_id')
trap 'webhelm session stop "$SESSION_ID" >/dev/null' EXIT
webhelm session exec "$SESSION_ID" <<'JS'
console.log(await snapshot());      // Inspect before interacting
await click('a');                   // Example Domain's information link
console.log((await page_info()).url);
JS
```

The shell trap releases your Session even if `exec` fails. The Session's JavaScript context persists between `exec` calls. Browser helpers include:

- **Inspect/navigation:** `snapshot`, `page_info`, `goto_url`, `wait_for_load`, `wait_for_element`.
- **Interact:** `click`, `fill_input`, `type_text`, `upload_file`, `js`, `cdp`.
- **Tabs/media:** `new_tab`, `current_tab`, `list_tabs`, `switch_tab`, `close_tab`, `capture_screenshot`, `wait`.

Helpers are asynchronous; use `await`. Obtain element references from `snapshot()` and refresh them after navigation. Open tabs with `new_tab` instead of raw CDP target creation. During long waits without browser operations, call `webhelm session heartbeat SESSION_ID` at least every 60 seconds.

## Platform Actions and on-demand references

```sh
webhelm platform list
webhelm platform profile PLATFORM
webhelm platform source PLATFORM ACTION
webhelm platform run --help  # choose the required mode and Session options first
```

Use the exact platform identifier returned by `platform list`, not a guessed name or site nickname. Read only the references relevant to the task:

| Need | Reference |
| --- | --- |
| CLI commands, flags, output, Session helpers | `webhelm --help`, `webhelm session --help`, `webhelm session exec --help`, `webhelm platform run --help` (and `<command> --help` for any subcommand) |
| Site-specific Actions, accepted fields, expected behavior | `webhelm platform profile PLATFORM`, `webhelm platform source PLATFORM ACTION`, and the relevant `~/.local/webhelm/platforms/PLATFORM/{manifest.yaml,README.md}` |
| **New site/platform or broken Action** | After setup, read `~/.local/webhelm/platforms/NEW_PLATFORM.md`; follow it to create or repair Actions in the separate Actions checkout, not inside this Skill |

Use `--session-id` for Actions requiring a caller-owned Session, `--auto-session` for supported one-shot Actions, or no Session argument when the Action explicitly supports that mode. Read the Action profile and `platform run --help` before choosing. For new platforms, start with read-only Actions, test in an owned Session, and publish reviewed changes using the Action guide.

## Safety

Preserve the existing signed-in Chrome and other agents' Sessions. Do not use `session stop --all` for routine cleanup, export authentication data, or perform unapproved external writes (messages, uploads, purchases or publication). Check the Action result and verify observable outcomes before reporting success.
