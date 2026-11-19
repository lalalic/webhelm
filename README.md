# WebHelm

[WebHelm](https://github.com/lalalic/webhelm) is a Node.js CLI and agent Skill for a visible, managed Chrome instance. One Runtime daemon controls CDP, persistent JavaScript browser Sessions, Chrome Tab Groups, and durable ChatGPT FIFO delivery.

## Two repositories, independent releases

| Repository | Contents | Updates |
|---|---|---|
| [`lalalic/webhelm`](https://github.com/lalalic/webhelm) | npm Runtime/CLI (including the Daemon-managed Chrome Extension), Skill (`skills/webhelm`), tests | npm `webhelm@latest`; Skill source separately |
| [`lalalic/webhelm-actions`](https://github.com/lalalic/webhelm-actions) | Site manifests, ChatGPT/Z.ai/DeepSeek/XHS/etc. Actions | Git checkout at `~/.local/webhelm` |

The npm Runtime and bundled Chrome Extension use the **same semantic version**. The GitHub npm publishing workflow stamps the Extension manifest from the final npm version, including publish retries, and refuses mismatched packages. The Chrome toolbar popup displays the installed Extension version in its header. Use `node scripts/sync-extension-version.mjs --check` to verify the checkout before publishing.

The npm package **does not include** the Skill or site Actions. The Skill's executable uses `npm exec --yes --package=webhelm@latest -- webhelm` to avoid inherited npm lifecycle variable conflicts; its contents may update without a Runtime release.

The agent-facing `webhelm` CLI uses only the `WebHelm` Workspace. It intentionally does not accept `--workspace` or expose Workspace management helpers in `session exec`. `session stop --all` only stops WebHelm Sessions. Application services such as Relay provision their own named Workspaces through daemon IPC `workspace-create`, `workspace-resize`, `workspace-configure`, and `workspace-delete`; they may start Sessions via the daemon `start` operation for those pre-provisioned names. To hide a group from the extension toolbar menu without removing its Chrome tab group or Sessions, send `{ "op": "workspace-configure", "name": "WeChat", "show_in_menu": false }`. On creation, `workspace-create` also accepts optional `show_in_menu: false`. The setting is persisted in the Chrome profile; omitted values preserve existing visibility, and the default is visible. `workspace.list` and `workspace.status` still expose hidden groups and their `showInMenu` property; only `workspace.control.status().workspaces` filters hidden groups for the menu. Leasing a missing Workspace fails rather than creating it.

Neo Master development uses the Git checkout directly via local symlinks for the CLI, Skill, and Extension; production nodes use published npm Runtime installations. Set `WEBHELM_SOURCE_MODE=1` when running the checkout directly; this loads the Extension from the repository and creates a LaunchAgent that references the repository's CLI without staging an npm Runtime copy.

## Install and use

```sh
npx --yes webhelm@latest setup
npx --yes webhelm@latest status
npx --yes webhelm@latest capacity
npx --yes webhelm@latest platform list
npx --yes webhelm@latest platform sync
npx --yes webhelm@latest session start --url https://example.com
npx --yes webhelm@latest session exec SESSION_ID <<'JS'
console.log(await snapshot());
JS
npx --yes webhelm@latest session stop SESSION_ID
# Long-running worker managers: session heartbeat SESSION_ID every 60 seconds
```

Use `npx skills add lalalic/webhelm --skill webhelm` to install agent guidance.
The Extension is bundled with the npm Runtime and staged by WebHelm Daemon at `~/.local/webhelm/extension`. The Skill lives **in this repo** at `skills/webhelm/SKILL.md`. No Chrome Web Store publication or manual Extension installation is required.

### Automatic npm Runtime upgrades (macOS)

`webhelm setup` installs two independent LaunchAgents: the offline Chrome health
check (`com.lalalic.webhelm.keepalive`, every 30 seconds) and the npm Runtime
updater (`com.lalalic.webhelm.runtime-update`, every hour and at login).
The updater checks the npm registry and downloads new releases to a temporary
location without running npm lifecycle scripts. It validates that Runtime and
Extension versions match, stages an immutable copy under
`~/.local/share/webhelm/runtime-VERSION`, and uses the stable
`~/.local/share/webhelm/runtime-current` symlink for subsequent launches.
The scheduled job does not depend on the npx cache. For immediate checking use
`webhelm upgrade`; for a read-only daemon check use `webhelm status`.

**No active Session is interrupted.** Before cutover, the daemon atomically
checks that no Sessions, pending leases, IPC operations or queue workers are
running, then pauses new browser work. New queued ChatGPT turns remain durable
and are accepted during the short cutover. The updater switches the stable
Runtime pointer, waits for the idle daemon to stop gracefully, starts the
new daemon against the existing Chrome/profile/queue, and verifies its version.
A busy daemon returns `deferred` and retries on the next scheduled run. A failed
installation reverts the pointer and resumes the old queue. Unavailable npm or
unrecognized old daemon upgrade protocols fail closed rather than killing a
Session. The update log is at `~/.config/webhelm/runtime/auto-update.log`.

Neo Master uses `WEBHELM_SOURCE_MODE=1` and runs its linked Git checkout, not
a published npm package. Automatic npm updates are deliberately disabled
there; updating a development checkout is a separate, reviewed Git operation.
Existing npm installations need to run `webhelm setup` once after receiving
this release to register the updater LaunchAgent. The setup and updater also
migrate only legacy global CLI symlinks that target an owned immutable
`runtime-VERSION/bin/webhelm.mjs` into the stable Runtime link.

## WebHelm Chrome Extension control panel

The daemon-managed Chrome Extension is installed from the npm Runtime and does not require the Chrome Web Store. Click the WebHelm toolbar icon to see daemon connectivity, each configured workspace's available capacity and current Session count. The toolbar badge shows the number of **active daemon Sessions** across all workspaces (including `0` when idle). `!` means the daemon heartbeat is stale and `?` means the Session count is unknown. The popup separately shows pool availability and idle tabs.

The compact popup shows daemon connectivity and per-workspace capacity and Session counts, with confirmation before stopping a Session or clearing Sessions in one workspace. The popup does not include a global stop-all action. These actions are executed by the same Node daemon as the CLI, over the existing CDP-backed Extension RPC. No shell access or HTTP listener is granted to the Extension. The persistent ChatGPT queue is not deleted, and queued work may create new Sessions afterward.

New installations use the default Chrome tab group `WebHelm` and the idle page `helm.html`. Idle URLs use only `workspace` and `role=idle`; Lease URLs use Chrome's actual `tabId` for initial CDP target discovery. There is no separate slot identity. Every newly created WebHelm-managed tab group (default and custom) is placed at the far left of its Chrome window, immediately after pinned tabs. Existing groups retain their user-chosen position during restoration, legacy migration and Session allocation. Chrome-saved tab group shortcuts in the bookmarks bar are separate from active groups and cannot safely be deduplicated through the Extension API. Legacy `Harness` default groups migrate only when their tabs are idle. Custom workspace names are unchanged; the old `workspace.html` path and lease titles remain readable until their Sessions finish. Closing an allocated Session returns its managed tabs to the idle page, retaining physical Chrome targets, while unleased popup children are closed. **A new lease only selects an actual `role=idle` extension tab with no pending navigation, excluding every tab owned by a live or pending daemon Session.** A briefly idle-looking URL is never sufficient to reclaim an active Session; stale Sessions are recovered only after the inactivity timeout. Do not manually remove active managed tabs.

For a real browser integration check on macOS, run `node test/e2e/extension-control.e2e.mjs`; it creates a temporary isolated Chrome profile and daemon and does not touch the current production Sessions.

The Actions checkout is `~/.local/webhelm`, with site modules at `~/.local/webhelm/platforms`. Setup clones if absent, then reuses that checkout without discarding local modifications. Run `platform sync` for new commits. For a verified local Action fix, `platform publish --message "..."` tests, commits and pushes only the action changes to the separate repo.

## Optional site Keep Alive (Extension)

Only a Session in the **WebHelm** Workspace can use the Extension's **Keep Alive** toggle on an HTTPS page to
register that website's **origin and current path** (without query or fragment).
There is one site entry per origin, so enabling Keep Alive on another path
updates its saved destination. The website stays in the popup's Keep Alive
Sites list even after the original Session ends. Custom/other Workspace
Sessions have no Keep Alive toggle. A green dot and website name mean that
the Platform last confirmed login; gray means not confirmed or not logged in
(hover to see the exact status). Click a website to open/focus it in the
existing managed Chrome profile and sign in again. The × control
clears the registration. Credentials, cookies, URL query strings, and browser
Session IDs are never copied into the registry. Site registration does **not**
keep a WebHelm Session or Tab permanently leased.

A Platform only needs a periodic heartbeat if that specific website requires
one. Site Actions opt in **individually**, in their Actions checkout's
`manifest.yaml`, for example:

```yaml
url_patterns:
  - https://creator.example.com/*
actions:
  heartbeat: actions/_heartbeat.mjs
keep_alive:
  action: heartbeat
  interval_minutes: 30
  url: https://creator.example.com/
```

The Platform's heartbeat Action runs with the existing `helpers` and must be
read-only. It returns `{status:'alive'|'login_required'|'unknown'}` after using
site-specific evidence; never infer login solely from HTTP success or page
load. WebHelm schedules only opted-in platforms, using a temporary browser
Session and an idle pool slot. On failure, the UI displays **Check failed**;
non-opted-in sites display **No heartbeat action** and can still be opened for
manual login. Failed/unknown checks retry no faster than five minutes. Neither
heartbeat nor browser persistence guarantees that the service will extend its
login lifetime. No automatic credential input or challenge bypass occurs.

The Platform Action implementation and its verification belong in
`lalalic/webhelm-actions`, not in this Runtime repository.

## Architecture and compatibility

The Runtime stores the Chrome profile under `~/.local/webhelm/chrome` and the persistent FIFO queue and IPC socket under `~/.config/webhelm/runtime/`. The runtime refuses to start against a conflicting Chrome profile rather than silently replacing an existing login. Session idle GC runs on Node before new Session allocation (5 minutes without operations or explicit heartbeat); no background sweep is started. A timed-out Session refuses subsequent exec, platform Actions and heartbeat, while already-issued browser effects retain tab ownership until settled. A stop that times out while queued cannot execute a late release, and a stop already physically releasing keeps its Session closing until the release finishes. Managed tabs are navigated back to their Extension idle URL instead of closing CDP targets; the Extension does not use `tab.lastAccessed` GC. An async Session execution has a finite deadline: if it expires, its helper capabilities are revoked and the poisoned Session is collected on the next Tab request (or immediately by an explicit stop). Session stop also has a bounded drain/release deadline and cannot leave a permanent closing flag. Client IPC requests have an independent absolute timeout and return an error if the daemon does not respond. These safeguards do not introduce periodic background GC. Only one daemon is permitted to own the queue. A CLI package update does not kill a running daemon or close another agent's tabs; upgrade daemons when idle.

NeoY and Relay can continue using `webhelm` session commands, `result.stdout` JSON receipts, and `admin_helper` returned by `status`. An `admin_helper` inside the installed Skill is a stable connector to the same Node IPC socket. `webhelm capacity` replaces the legacy Python capacity probe.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

Keep platform-specific code and tests in `lalalic/webhelm-actions`. Runtime tests should use mock CDP or owned, temporary real Chrome tabs; protect other active Sessions. GitHub Actions runs Runtime/Extension CI. The Skill and Extension remain version-controlled together; npm publishing uses the standalone package at the repository root.

### Adding an unsupported platform

For new platforms, follow the canonical [`platforms/NEW_PLATFORM.md`](https://github.com/lalalic/webhelm-actions/blob/main/platforms/NEW_PLATFORM.md) in the installed Actions checkout. All new platform code belongs in **`~/.local/webhelm/platforms/<slug>`**, checked out from `lalalic/webhelm-actions`, including tests and docs. There is no separate `platforms/` directory in the Skill or npm package. Publishing an Action uses Git, not npm.

## npm publishing

`.github/workflows/publish.yml` publishes CLI/Runtime changes on `main` using GitHub Actions and npm OIDC trusted publishing. It reuses Agents Relay's bounded-test and publication-report Actions, as the other repositories do. The CI workflow never stores an npm write token or asks for a local 2FA approval. Configure the **webhelm** npm package's Trusted Publisher once: GitHub user `lalalic`, repository `webhelm`, workflow filename `publish.yml` (no environment), with **Allow npm publish** enabled. New configurations otherwise default to staged-only publishing and require individual approvals. A successful publish is verified against the npm registry and reported to Agents Relay. Skill-only and platform Action changes do not trigger npm publication.
