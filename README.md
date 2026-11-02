# WebHelm

[WebHelm](https://github.com/lalalic/webhelm) is a Node.js CLI and agent Skill for a visible, managed Chrome instance. One Runtime daemon controls CDP, persistent JavaScript browser Sessions, Chrome Tab Groups, and durable ChatGPT FIFO delivery.

## Two repositories, independent releases

| Repository | Contents | Updates |
|---|---|---|
| [`lalalic/webhelm`](https://github.com/lalalic/webhelm) | npm Runtime/CLI (including the Daemon-managed Chrome Extension), Skill (`skills/webhelm`), tests | npm `webhelm@latest`; Skill source separately |
| [`lalalic/webhelm-actions`](https://github.com/lalalic/webhelm-actions) | Site manifests, ChatGPT/Z.ai/DeepSeek/XHS/etc. Actions | Git checkout at `~/.local/webhelm` |

The npm package **does not include** the Skill or site Actions. The Skill's executable uses `npm exec --yes --package=webhelm@latest -- webhelm` to avoid inherited npm lifecycle variable conflicts; its contents may update without a Runtime release.

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

Use `npx skills add lalalic/webhelm --skill webhelm` to install agent guidance. The Extension is bundled with the npm Runtime and staged by WebHelm Daemon at `~/.local/webhelm/extension`. The Skill lives **in this repo** at `skills/webhelm/SKILL.md`. No Chrome Web Store publication or manual Extension installation is required.

## WebHelm Chrome Extension control panel

The daemon-managed Chrome Extension is installed from the npm Runtime and does not require the Chrome Web Store. Click the WebHelm toolbar icon to see daemon connectivity, each configured workspace's available capacity and current Session count. The toolbar badge shows the number of **active daemon Sessions** across all workspaces (including `0` when idle). `!` means the daemon heartbeat is stale and `?` means the Session count is unknown. The popup separately shows pool availability and idle tabs.

The popup has a confirmation step to stop one Session, clear Sessions in one workspace, or clear Sessions across all workspaces. These actions are executed by the same Node daemon as the CLI, over the existing CDP-backed Extension RPC. No shell access or HTTP listener is granted to the Extension. The persistent ChatGPT queue is not deleted, and queued work may create new Sessions afterward.

New installations use the default Chrome tab group `WebHelm` and the idle page `helm.html`. Idle URLs use only `workspace` and `role=idle`; Lease URLs use Chrome's actual `tabId` for initial CDP target discovery. There is no separate slot identity. The default `WebHelm` tab group is placed at the first position after pinned tabs when created or restored, while Session allocation does not override later user rearrangement. Chrome-saved tab group shortcuts in the bookmarks bar are separate from active groups and cannot safely be deduplicated through the Extension API. Legacy `Harness` default groups migrate only when their tabs are idle. Custom workspace names are unchanged; the old `workspace.html` path and lease titles remain readable until their Sessions finish. Closing an allocated Session returns its managed tabs to the idle page, retaining physical Chrome targets, while unleased popup children are closed. Do not manually remove active managed tabs.

For a real browser integration check on macOS, run `node test/e2e/extension-control.e2e.mjs`; it creates a temporary isolated Chrome profile and daemon and does not touch the current production Sessions.

The Actions checkout is `~/.local/webhelm`, with site modules at `~/.local/webhelm/platforms`. Setup clones if absent, then reuses that checkout without discarding local modifications. Run `platform sync` for new commits. For a verified local Action fix, `platform publish --message "..."` tests, commits and pushes only the action changes to the separate repo.

## Architecture and compatibility

The Runtime stores its managed Chrome profile, persistent FIFO queue, and IPC socket under `~/.config/webhelm/`. Run `webhelm migrate` with the legacy daemon and Chrome stopped to migrate existing `~/.config/browser-workspace/` data without dropping logins or queued turns. The command leaves a compatibility symlink for legacy maintenance scripts. Session idle GC runs on Node before new Session allocation (5 minutes without operations or explicit heartbeat). Managed tabs are navigated back to their Extension idle URL instead of closing CDP targets; the Extension does not use `tab.lastAccessed` GC. Only one daemon is permitted to own the queue. A CLI package update does not kill a running daemon or close another agent's tabs; upgrade daemons when idle.

NeoY and Relay can continue using `webhelm` session commands, `result.stdout` JSON receipts, and `admin_helper` returned by `status`. An `admin_helper` inside the installed Skill is a stable connector to the same Node IPC socket. `webhelm capacity` replaces the legacy Python capacity probe.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```

Keep platform-specific code and tests in `lalalic/webhelm-actions`. Runtime tests should use mock CDP or owned, temporary real Chrome tabs; protect other active Sessions. GitHub Actions runs Runtime/Extension CI. The Skill and Extension remain version-controlled together; npm publishing uses the standalone package at the repository root.

### Adding an unsupported platform

The WebHelm Skill includes [`skills/webhelm/NEW_PLATFORM.md`](skills/webhelm/NEW_PLATFORM.md). All new platform code belongs in **`~/.local/webhelm/platforms/<slug>`**, checked out from `lalalic/webhelm-actions`, including tests and docs. There is no separate `platforms/` directory in the Skill or npm package. Publishing an Action uses Git, not npm.

## npm publishing

`.github/workflows/publish.yml` publishes CLI/Runtime changes on `main` using GitHub Actions and npm OIDC trusted publishing. It reuses Agents Relay's bounded-test and publication-report Actions, as the other repositories do. The CI workflow never stores an npm write token or asks for a local 2FA approval. Configure the **webhelm** npm package's Trusted Publisher once: GitHub user `lalalic`, repository `webhelm`, workflow filename `publish.yml` (no environment), with **Allow npm publish** enabled. New configurations otherwise default to staged-only publishing and require individual approvals. A successful publish is verified against the npm registry and reported to Agents Relay. Skill-only and platform Action changes do not trigger npm publication.
