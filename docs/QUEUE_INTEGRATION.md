# Platform Queue Policy development contract

WebHelm is the **generic durable Queue Manager**. Each site owns its browser Actions and its Queue Policy in the separate `webhelm-actions` checkout. The daemon discovers and watches `$WEBHELM_PLATFORM_DIR/<platform>/queues/*.mjs` (normally `~/.local/webhelm/platforms/<platform>/queues/`), including new or changed files. No queue manifest keys, Runtime site-specific senders or daemon restarts are required for discovery.

## One policy per queue

Create `platforms/<platform>/queues/<queue-name>.mjs`, exporting one default object:

```js
export default {
  action: 'new-turn',                    // Required: existing manifest.actions key
  validate: 'validate_new_turn_ready',   // Required: read-only readiness Action
  group: config => config.thread_id,    // Required: stable FIFO partition key
  title: config => config.message.slice(0, 52), // Required: UI title (no secrets)
  url: config => `https://example.com/c/${encodeURIComponent(config.thread_id)}`, // Optional HTTPS UI link
  concurrency: 4,                       // Optional max parallel groups (default 1)
  intervalMs: 10000,                    // Optional retry/cooldown cadence
  retries: 1,                          // Optional failed-attempt retries (default 1; 0 disables)
  execute: config => config,             // Optional transform of Action config
  merge(previous, incoming) { return null; }, // Optional: merged config or null
  success: value => value?.status === 'submitted', // Optional success receipt gate
};
```

`group(config)` and `title(config)` receive Action **config**, not a queue record. `action` and `validate` must name Actions already declared in the Platform's `manifest.yaml`. They run through the **same `invokePlatformAction` / `runPlatform` path** as direct execution. The `validate` Action returns `true` (READY) or `false` (NOT_READY); `{ready:true|false}` is also accepted. It decides **whether the next action is safe to deliver**, not whether the incoming config is syntactically valid and not whether a previously sent action succeeded. It must not click Send or cause the delivery side effect. The sending Action still checks its own immediate pre-click conditions; never rely on an earlier readiness check for correctness. `execute(config)` adapts the queued payload to the Action's direct execution mode without creating a second sender. The optional `url` must never contain prompt/query secrets.

## Enqueue, merge, and execution

Call daemon `queue-enqueue` with `{platform,queue,config}`; CLI `webhelm platform run PLATFORM ACTION` chooses the registered queue by default (when no caller Session is supplied), or `--session-id SESSION_ID` for direct execution. The response includes `queue_id`, `state`, and partition/group information. Queue registration is **by file discovery**, not by `manifest.yaml` queue declarations.

WebHelm owns SQLite transactions (WAL + FULL synchronous writes), idempotency keys, FIFO by `(platform,queue,group(config))`, per-queue concurrency, worker leases, recovery, Session ownership and cleanup, list/cancel for the Extension, and upgrade drain. `idempotency_key` prevents duplicate submissions; a reused key with a different payload fails. No independent Platform queue dispatcher or browser sender is permitted.

At **enqueue time only**, inspect the last item in the same queue/group. If both items set `mergeable:true`, the last item is unleased `QUEUED`, and the policy exports `merge(previous,incoming)`, call it inside the SQLite transaction. A returned config atomically replaces the tail; `null` appends a new item. Every original idempotency key continues to resolve to that one queue ID, even after a daemon restart. Never merge `CHECKING`, `SENDING`, `SENT`, `FAILED`, `CANCELLED`, or any claimed record. `mergeable` is optional; default false. The policy must check platform-specific compatibility such as Project, enforcement context and attachments.

Each claimed head calls the read-only `validate` Action. NOT_READY releases the Session and keeps the item QUEUED with a later check; the next item in its group stays blocked. READY moves it to SENDING and invokes `action` with `execute(config)` in a private queue-owned Session. A successful Action receipt marks SENT, with per-group cooldown; Failed validation or sending attempts retry after `intervalMs` until the policy's `retries` limit is reached, then become terminal FAILED. The default is one additional retry. NOT_READY is not a failure and does not consume retries. Expired worker leases count against the same attempt budget. FAILED, SENT and CANCELLED are not listed as queue entries, but idempotency references prevent accidentally reenqueuing an uncertain result. Policies for non-idempotent delivery actions that cannot prove non-delivery (such as ChatGPT) should set `retries: 0` to avoid duplicate submissions. Direct calls and queue sends must execute the same Action module. A successful click is not independent proof of provider delivery.

A watcher reload is transactional at registration level: invalid new policies are rejected, while an existing valid policy stays active; inflight work keeps its captured policy. Deleting a file must not erase durable items. Daemon upgrade must drain in-flight Actions. Never run two dispatchers on the same database.

## UI and storage

`queue-list` exposes `id`, `queue_id`, `platform`, `queue`, `group`, `title`, optional `url`, `state`, `attempts`, `created_at` and non-sensitive `receipt`, not the prompt. The Extension groups by Platform and group, opens only HTTPS links, and always shows Cancel for an active queue entry. Cancellation removes QUEUED or pre-send CHECKING entries; sending cannot safely be interrupted. Missing, already sending and terminal entries are silently skipped without an error. During cutover, the legacy `chatgpt-new-turn.sqlite3` database is imported **read-only** into an initially empty generic ChatGPT queue database. Existing queue IDs, original idempotency aliases, content, order, state and attempt counts are preserved. Legacy `UNCERTAIN`/`SENDING` rows become terminal FAILED without resending; unclaimed pending rows may be discarded during an explicitly non-migrating queue reset. Import runs once and is atomic; the original SQLite remains untouched. Never start two dispatchers or enable real sends during an unverified migration.

## Verification gates

Test discovery/watch/reload, invalid module preservation, two independent platforms, validate NOT_READY → QUEUED → READY, identical direct/queued Action imports, merge and all original keys, FIFO/concurrency/cooldown, cancel and crash recovery, `queue-list` Extension shape, and clean generic database startup. Use an isolated daemon/fixture for sending tests; a real owned Chrome Session is necessary before claiming site E2E. Do not restart a daemon with active Sessions or queued turns just to test a refactor.
