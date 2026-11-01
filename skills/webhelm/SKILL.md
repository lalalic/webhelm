---
name: webhelm
description: Control managed Chrome using the latest WebHelm npm CLI, persistent JavaScript browser Sessions, and independently maintained site Actions.
requires:
  skills:
    - daemon-service-manage
---

# WebHelm

**This Skill belongs to `lalalic/webhelm`.** It contains agent instructions, the Chrome Extension, interaction guides, and a small CLI launcher. The browser Runtime is the independently published `webhelm` npm package. Site-specific Actions live in `lalalic/webhelm-actions`, checked out locally to `~/.local/webhelm`.

## Setup

Install the Skill with the trusted skill installer, e.g. `npx skills add lalalic/webhelm --skill webhelm`. Its local installer registers a stable `~/.local/bin/webhelm` shortcut:

```sh
SKILL_DIR="<absolute directory containing this SKILL.md>"
sh "$SKILL_DIR/scripts/install-global-cli.sh"
webhelm migrate  # when upgrading an existing Browser Workspace installation, with Chrome/daemon stopped
webhelm setup
webhelm status
webhelm capacity
```

The shortcut invokes **`npm exec --yes --package=webhelm@latest -- webhelm`** on every call. `npx --yes webhelm@latest` is equivalent in a normal shell, but can fail when `npm_config_package` is inherited from an npm worker. In those workers, use the stable shortcut or explicit `npm exec` form. Node.js 22.5+ and npm are required. `setup` clones `https://github.com/lalalic/webhelm-actions` into `~/.local/webhelm` (unless already checked out) and connects to the existing managed Chrome. The Actions live at `~/.local/webhelm/platforms`, not inside this Skill or npm's cache. An existing checkout with local edits is never deleted or overwritten.

Do not install or launch the old Python Browser Harness, Browser Workspace daemon, or separate browser Runtime from this Skill. The Node daemon reuses the existing Chrome profile and Session IPC socket, and never restarts Chrome to update npm code. Existing Sessions and the durable SQLite ChatGPT FIFO must complete safely before a daemon version is changed. **`@latest` applies to new CLI invocations, not a hot swap of a running daemon.**

## Session API

Always retain the returned `session_id` across calls and stop only Sessions owned by your workflow. Independent Sessions are allowed to execute concurrently. The CLI uses CDP Target attachments, not a global tab lock.

```sh
webhelm session start --url https://example.com
webhelm session exec SESSION_ID <<'JS'
console.log(await page_info());
console.log((await snapshot()).slice(0,1800));
await click('[data-ref="e2"]');
JS
webhelm session stop SESSION_ID
```

The JavaScript Session context persists across `exec` calls. Helpers are asynchronous: `snapshot`, `page_info`, `goto_url`, `wait_for_load`, `wait_for_element`, `fill_input`, `click`, `js`, `cdp`, `new_tab`, `current_tab`, `list_tabs`, `switch_tab`, `close_tab`, `upload_file`, `type_text`, `capture_screenshot`, `wait`, `workspace_status`. Use `new_tab` rather than raw CDP target creation to preserve Tab Group ownership. Browser helper references are established by `snapshot`; refresh after navigation.

## Actions (separate repo)

```sh
webhelm platform list
webhelm platform profile chatgpt
webhelm platform source z new-turn
webhelm platform sync
webhelm platform run z new-turn --session-id SESSION_ID --config /path/to/turn.json
```

The Runtime imports site modules directly from `~/.local/webhelm/platforms`. `platform sync` performs a fast-forward-only Git update; it refuses to overwrite local modifications. The current local checkout is used when offline. Do not publish external side effects without verifying them in a real owned Session.

After a user or agent verifies and fixes a site Action in `~/.local/webhelm/platforms`, publish it to the Actions repo with:

```sh
webhelm platform publish --message "fix(z): handle updated chat composer"
```

This runs the independent Actions tests, stages only `platforms/`, commits and pushes without force. Use it only for reviewed and authorized changes. Never include credentials, user content, browser files or private traces. For platforms whose status says `migrated_unverified`, the source migration is not proof of live behavior.

## New platforms and Action repairs — always local to Actions checkout

When an agent discovers an unsupported platform or needs to repair an Action, first run `npx --yes webhelm@latest setup` and read **`NEW_PLATFORM.md`** alongside this Skill. Create and edit platform manifests, JS Actions, tests, and documentation **only under `$HOME/.local/webhelm/platforms/<slug>/`** (the `lalalic/webhelm-actions` Git checkout). Never scaffold a platform in `skills/webhelm/platforms/`, `runtime/platforms/`, `.npm/_npx/`, or another repository. Do not copy the checkout into the Skill when the Skill is reinstalled. Verify with `platform list`, `platform profile`, independent Actions tests, and a caller-owned real browser Session; then use `platform publish` to push authorized changes to the Actions Git repository. Source-only changes do not require a new npm release.

## ChatGPT FIFO

`webhelm platform run chatgpt new-turn --config FILE` defaults to `mode: "async"`, returning a durable queued receipt, *not* proof of delivery. `mode: "sync"` requires a caller-owned `--session-id`. The Node Runtime keeps its SQLite queue dispatcher separately from Actions. An ambiguous send is `UNCERTAIN`, never automatically resent. Stop the old dispatcher safely and preserve the queue DB before switching its version; do not run two dispatchers on one database.

NeoY and Relay's caller compatibility is maintained: completed platform actions provide `result.stdout` as machine-readable JSON and `result.value` as a structured result. NeoY discovers the stable `admin_helper` from `webhelm status`. `webhelm capacity` reads the Extension workspace without opening a new Session.

## Chrome Extension and updates

The single canonical extension source remains in this repository at `skills/webhelm/extension/` (published Chrome Extension ID `kkkpgmhpoeceojalkpfdidffdfnlgdog`). It manages visible Tab Groups and leases, not another OS daemon. Use the verified Chrome Web Store install, or `sh "$SKILL_DIR/scripts/prepare-local-extension.sh"` for manually approved offline installation. Do not install duplicates.

Updating this Skill via `npx skills add lalalic/webhelm --skill webhelm` only updates agent instructions and the extension source. Updating the CLI uses npm `webhelm@latest`. Updating Actions uses `webhelm platform sync`. These three releases are independent.

## Safe verification

For code under development, use test-specific `WEBHELM_RUNTIME_DIR`, `WEBHELM_SOCKET`, `WEBHELM_LOCK` and optionally `WEBHELM_CDP_URL`, so you do not interrupt production Sessions. Never restart user-owned Chrome or remove another Session. Read site-specific instructions from the Actions repo. Verify real browser outcomes after mock tests; do not infer a successful submission from an accepted queue receipt.

## Managed Chrome and durable data

The canonical browser data root is `~/.config/webhelm/`: `chrome/` holds the existing signed-in Chrome Profile; `runtime/` holds the SQLite ChatGPT FIFO, logs, lock and socket; `auth-audit/` and any legacy auxiliary data are also preserved. On nodes previously using `~/.config/browser-workspace/`, stop the legacy Node daemon and Chrome (after closing owned Sessions), then use `webhelm migrate`. It performs an atomic same-filesystem rename and keeps a compatibility symlink at the legacy path for retired maintenance tasks. Never create a second empty Chrome Profile while the legacy profile exists. Restart using `webhelm setup` and verify Profile path, Chrome logins, queue counts and a caller-owned browser Session. Do not remove the compatibility symlink while external scheduled callers still use it.
