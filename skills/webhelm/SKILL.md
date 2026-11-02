---
name: webhelm
description: Control managed Chrome using the latest WebHelm npm CLI, persistent JavaScript browser Sessions, and independently maintained site Actions.
requires:
  skills:
    - daemon-service-manage
---

# WebHelm

**This Skill belongs to `lalalic/webhelm`.** It contains agent instructions, interaction guides, and a small CLI launcher. The Extension is bundled with the npm Runtime, not this Skill. The browser Runtime is the independently published `webhelm` npm package. Site-specific Actions live in `lalalic/webhelm-actions`, checked out locally to `~/.local/webhelm`.

## Setup

Install the Skill with the trusted skill installer, e.g. `npx skills add lalalic/webhelm --skill webhelm`. Its local installer registers a stable `~/.local/bin/webhelm` shortcut:

```sh
SKILL_DIR="<absolute directory containing this SKILL.md>"
sh "$SKILL_DIR/scripts/install-global-cli.sh"
webhelm migrate  # after draining Sessions and stopping managed Chrome/daemon
webhelm setup
webhelm status
webhelm capacity
```

The shortcut invokes **`npm exec --yes --package=webhelm@latest -- webhelm`** on every call. `npx --yes webhelm@latest` is equivalent in a normal shell, but can fail when `npm_config_package` is inherited from an npm worker. In those workers, use the stable shortcut or explicit `npm exec` form. Node.js 22.5+ and npm are required. `setup` clones `https://github.com/lalalic/webhelm-actions` into `~/.local/webhelm` (unless already checked out) and connects to the existing managed Chrome. The Actions live at `~/.local/webhelm/platforms`, not inside this Skill or npm's cache. An existing checkout with local edits is never deleted or overwritten.

On macOS `webhelm setup` registers a per-user LaunchAgent that checks whether the daemon is running at login and every 30 seconds. The daemon itself checks the managed browser and its default `WebHelm` tab group every 15 seconds. The login check calls `webhelm ensure` (a real Chrome and WebHelm group health/recovery check), not `webhelm status`; it runs with the locally installed npm Runtime directly, without requiring network/npm registry access. No Dock launcher is needed. For browser integration tests on macOS, **do not override HOME**: Chrome uses the real login Keychain. Instead isolate `WEBHELM_CONFIG_ROOT`, `WEBHELM_LOCAL_ROOT`, `WEBHELM_RUNTIME_DIR`, `WEBHELM_SOCKET`, `WEBHELM_LOCK`, and `BROWSER_WORKSPACE_CDP_PORT`.

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
# Long-running workers must use webhelm session heartbeat SESSION_ID every 60 seconds.
```

Node reclaims Sessions idle for 5 minutes during new Session allocation; normal `session exec` refreshes activity, and long-running Worker Managers must send `webhelm session heartbeat SESSION_ID` at least every 60 seconds while waiting for a model. On `session stop`, Node returns managed tabs to the Extension idle URL without closing the underlying CDP target. The Extension no longer independently reclaims tabs using Chrome `lastAccessed`.

All CLI Sessions are scoped to the default `WebHelm` Workspace. Never supply `--workspace`, and do not create or resize workspaces through Session code. Relay and other trusted applications own custom workspaces through the daemon IPC and may lease only workspaces they already provisioned.

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

## Chrome Extension (Daemon-owned)

The npm Runtime embeds the Chrome Extension under `runtime/extension/`; **the Skill contains no Extension files**. The Node daemon stages it at the stable local directory `~/.local/webhelm/extension` and verifies the fixed Extension ID `kkkpgmhpoeceojalkpfdidffdfnlgdog`. The managed Chrome launcher uses compatible startup flags on Chrome 138 and older, while Chrome 139+ loads the local directory through the CDP Extension protocol (without `--load-extension` flags). Runtime checks the active Extension version and refuses to allocate unmanaged tabs if it cannot confirm the expected version. The daemon checks Managed Chrome every 15 seconds, recreates it after an auto-update restart, and ensures the default `WebHelm` group with at least one idle tab if the group is missing. Existing `Harness` default groups migrate only after their tabs become idle; custom group names remain unchanged. Legacy `workspace.html` tab URLs remain supported when closing old Sessions. It never closes or takes over an ordinary Chrome profile. `webhelm status` reports `chrome_guard` health. Do not manually install, publish, or update the Web Store Extension.

A running daemon with active Sessions must not be restarted to update the Runtime or Extension. After Sessions and the FIFO have drained, install the new npm Runtime and restart only the daemon; only restart managed Chrome if it is safe to do so and an older Chrome cannot reload Extension through CDP. Source updates propagate through npm; `webhelm platform sync` updates only Actions, and `npx skills add` updates only agent instructions.

## Safe verification

For code under development, use test-specific `WEBHELM_RUNTIME_DIR`, `WEBHELM_SOCKET`, `WEBHELM_LOCK` and optionally `WEBHELM_CDP_URL`, so you do not interrupt production Sessions. Never restart user-owned Chrome or remove another Session. Read site-specific instructions from the Actions repo. Verify real browser outcomes after mock tests; do not infer a successful submission from an accepted queue receipt.

## Managed Chrome and durable data

The canonical browser data root is `~/.local/webhelm/`: `chrome/` contains the existing signed-in Chrome Profile, `platforms/` contains site Actions, and `extension/` is managed by Daemon. `~/.config/webhelm/runtime/` retains the SQLite ChatGPT FIFO, logs, lock and socket; `auth-audit/` and any legacy auxiliary data are also preserved. On nodes previously using `~/.config/browser-workspace/`, stop the legacy Node daemon and Chrome (after closing owned Sessions), then use `webhelm migrate`. This migrates the Chrome Profile to `~/.local/webhelm/chrome` and leaves a compatibility symlink at `~/.config/webhelm/chrome`, while retaining runtime queue data under `~/.config/webhelm/runtime`. Never create a second empty Chrome Profile while the legacy profile exists. Restart using `webhelm setup` and verify Profile path, Chrome logins, queue counts and a caller-owned browser Session. Do not remove the compatibility symlink while external scheduled callers still use it.
