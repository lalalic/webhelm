# WebHelm repository engineering rules

- The Skill lives in `lalalic/webhelm/skills/webhelm`. The distributed Skill contains user-facing guidance, operational scripts and the stable CLI launcher; maintainers keep developer guides, tests and repository policy outside it. Extension source belongs only in `runtime/extension/` and is deployed by the daemon to `~/.local/webhelm/extension`, never bundled in the Skill. It does **not** own the Runtime or platform Actions.
- The npm Runtime is under the repository's `runtime/` and `bin/` and is published as unscoped `webhelm`.
- Platform Actions belong in `lalalic/webhelm-actions` and install to `~/.local/webhelm/platforms`; update them there, not inside this repo. Use `webhelm platform sync` for fast-forward-only pulls and `webhelm platform publish` for authorized, reviewed changes.
- Preserve and migrate the existing signed-in Chrome profile to `~/.local/webhelm/chrome` (compatibility symlink from `~/.config/webhelm/chrome`), extension ID, queue database and Session IPC; never silently switch to a second browser profile or start a parallel queue dispatcher.
- Browser Sessions own their tabs and CDP targets; releases must not close unrelated tabs. Use one CDP WebSocket and explicit independent Session attachments, without a global browser lock. Serialize only shared extension tab lease acquisition.
- Chrome MV3 service workers may be asleep. Use an existing extension page or a temporary task-owned extension page and `chrome.runtime.sendMessage` to wake it; clean up temporary tabs. Do not use the obsolete browser-level CDP ServiceWorker.startWorker command.
- Preserve `result.stdout` JSON and structured `result.value` for NeoY and Relay callers. Expose `webhelm capacity` without a Python process.
- Agent startup commands and npm/Skill releases are independent. Installed Skills use published `@latest` Runtime, while Neo Master may link the checkout directly; neither path may restart a daemon with active Sessions or queued turns.
- After changes, run tests, inspect the npm tarball for accidental bundled Actions/secrets, test real Chrome with owned temporary tabs, and only then push/release. Record verified vs unverified site behavior in the Actions repository.

- For a **new** unsupported site, follow `docs/NEW_PLATFORM.md`. All new manifests, Actions, tests, and readme files live only at `$HOME/.local/webhelm/platforms/<slug>/`, never inside this Skill or npm. Discover them through the existing runtime's local Actions checkout.
