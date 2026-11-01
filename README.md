# WebHelm

[WebHelm](https://github.com/lalalic/webhelm) is a Node.js CLI and agent Skill for a visible, managed Chrome instance. One Runtime daemon controls CDP, persistent JavaScript browser Sessions, Chrome Tab Groups, and durable ChatGPT FIFO delivery.

## Two repositories, independent releases

| Repository | Contents | Updates |
|---|---|---|
| [`lalalic/webhelm`](https://github.com/lalalic/webhelm) | npm Runtime/CLI, Skill (`skills/webhelm`), Chrome Extension, tests | npm `webhelm@latest`; Skill source separately |
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
```

Use `npx skills add lalalic/webhelm --skill webhelm` to install agent guidance and the bundled Extension source. The Skill lives **in this repo** at `skills/webhelm/SKILL.md`.

The Actions checkout is `~/.local/webhelm`, with site modules at `~/.local/webhelm/platforms`. Setup clones if absent, then reuses that checkout without discarding local modifications. Run `platform sync` for new commits. For a verified local Action fix, `platform publish --message "..."` tests, commits and pushes only the action changes to the separate repo.

## Architecture and compatibility

The Runtime stores its managed Chrome profile, persistent FIFO queue, and IPC socket under `~/.config/webhelm/`. Run `webhelm migrate` with the legacy daemon and Chrome stopped to migrate existing `~/.config/browser-workspace/` data without dropping logins or queued turns. The command leaves a compatibility symlink for legacy maintenance scripts. Only one daemon is permitted to own the queue. A CLI package update does not kill a running daemon or close another agent's tabs; upgrade daemons when idle.

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
