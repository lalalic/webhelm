# Creating a WebHelm platform

**Canonical location:** `$HOME/.local/webhelm/platforms/<platform>/`. This is the `lalalic/webhelm-actions` checkout, **not** the Skill repository and **not** npm's runtime directory. When an agent is asked to support an unknown website, it must follow this workflow. Do not add `platforms/` beneath `skills/webhelm/`, `runtime/` or npm's `_npx` cache.

1. Prepare and verify the independent checkout: `npx --yes webhelm@latest setup`. Resolve the actual root from the returned `actions_home`. Default: `$HOME/.local/webhelm`. Do not overwrite an existing checkout or create a second clone if the directory exists.
2. Inspect `platforms/<similar-platform>/manifest.yaml`, Actions, and tests in that checkout for structure and helper usage. Pick a lowercase hyphenated slug such as `example-site`, and a harmless read-only Action name such as `inspect`.
3. Create **all** new platform files in the checkout: `platforms/<slug>/manifest.yaml`, `platforms/<slug>/actions/_inspect.mjs`, `platforms/<slug>/README.md`, and `platforms/<slug>/tests/inspect.test.mjs`. Confirm the path with `pwd -P` before editing. Never write credentials, cookies, screenshots, or conversation text into these tracked files.
4. Begin with a minimal manifest and action. Example (replace `example-site` with the new slug):

   `~/.local/webhelm/platforms/example-site/manifest.yaml`:

   ```yaml
   platform: example-site
   display_name: Example Site
   status: unverified
   last_verified: null
   actions:
     inspect: actions/_inspect.mjs
   ```

   `~/.local/webhelm/platforms/example-site/actions/_inspect.mjs`:

   ```js
   export default async function run({ helpers, config = {} }) {
     const page = await helpers.page_info();
     const snapshot = await helpers.snapshot();
     return { ok: true, url: page.url, title: page.title, snapshot: snapshot.slice(0, 2000) };
   }
   ```

5. Add independent Node tests inside the same new platform directory (`tests/*.test.mjs`). Run `npm test` from the Actions checkout. Only then run `npx --yes webhelm@latest platform list` and `platform profile <slug>` to confirm the new module is discovered directly from `$HOME/.local/webhelm/platforms`.
6. For live verification, start a **caller-owned** Session, run the new Action through `npx --yes webhelm@latest platform run <slug> inspect --session-id SESSION_ID`, and release that Session. Do not perform external writes or claim a platform is verified solely from mock tests.
7. After verifying the source and tests, publish the modifications to the **Actions Git repository** (not npm, not the Skill repo): `npx --yes webhelm@latest platform publish --message "feat(example-site): add read-only inspector"`. This command runs Actions tests, commits only `platforms/` and pushes without force. A dirty working tree blocks `platform sync` until changes are resolved.

Existing Actions also have one canonical source: edit only `$HOME/.local/webhelm/platforms/<slug>/...`; use `platform sync` for upstream changes. Changing Actions should **never** require republishing npm or reinstalling the Skill. Changing this guide or Skill should **never** copy Actions into the Skill.
