# Chrome authentication audit and keepalive (Node.js)

These optional maintenance commands use the single WebHelm Skill. They do not start another daemon, install Python, copy credentials, change Chrome Cookies, or bypass reauthentication. They use the existing managed Chrome profile and private `~/.config/webhelm/auth-audit/` data directory.

## Cookie metadata audit (read-only)

```sh
node "$SKILL_DIR/scripts/auth-cookie-audit.mjs"
node "$SKILL_DIR/scripts/auth-cookie-audit.mjs" --site wechat --status logged_in --page-evidence backend_visible
```

`auth-cookie-audit.mjs` reads metadata from `Default/Cookies` using Node's read-only SQLite API. Each Cookie is represented by an HMAC identifier and HMAC fingerprint of the encrypted value. Neither raw encrypted values nor plaintext credential values appear in state files or logs. The per-host local `audit.key` is owner-only (0600). Logs contain per-site counts, Cookie rotation/expiry changes, and selected harmless metadata for WeChat's `sessionid` and `wxuin` names. An unchanged Cookie cannot prove the server session is valid.

Output: private `events.jsonl`, `latest.json`, and `audit.key`. The CLI reports only a small JSON summary. The first run establishes a baseline. Optional site status/evidence fields must describe a separately verified page observation; Cookies alone do not establish login.

## Authenticated page visits (read-only)

```sh
node "$SKILL_DIR/scripts/auth-keepalive-visit.mjs"
```

This starts an isolated WebHelm Session for each WeChat Channels, Xiaohongshu, and Chrome Web Store page, captures only a compact snapshot, classifies visible page evidence, and stops only its own sessions. A failure still attempts cleanup. It also records the Cookie audit around visits. Visits cannot guarantee indefinite login and cannot bypass MFA.

## Local scheduled task migration

The former optional maintenance tasks used `auth-cookie-audit.py`, `auth-keepalive-visit.py` and `uvx browser-workspace`. Before retiring their scheduled wrappers, update their commands to the `.mjs` equivalents above. Use the installed Skill's absolute path, the Node binary, and a `lockf` wrapper (macOS) to prevent overlapping runs. Do not delete the existing private history or `audit.key`.

Do **not** enable two schedulers concurrently. Do not repoint any schedule until the installed Node Skill's `status`, `session start/stop`, and read-only validation actions have succeeded.
