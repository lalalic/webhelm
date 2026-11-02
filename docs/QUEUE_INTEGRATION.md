# Queue integration for platform maintainers

Queueing is **opt-in Runtime orchestration**, not a Platform Action feature. Today only the asynchronous ChatGPT `new-turn` path is queued. All other Actions run directly, and creating a platform manifest or Action does **not** register a queue.

## Where registration belongs

| Concern | Owner | Reference |
| --- | --- | --- |
| Site automation and result | Platform Action in `webhelm-actions/platforms/<platform>/actions/` | `runtime/platforms.mjs` (`invokePlatformAction`) |
| Durable atomic queue operations and scheduler | WebHelm Runtime | `runtime/durable-queue-core.mjs` |
| Queue-specific SQL schema, partition, merge and recovery policy | Runtime-owned queue adapter | `runtime/chatgpt/chatgpt-queue.mjs` |
| Queue initialization, execution and Extension status/cancel bridge | Runtime daemon | `runtime/node-daemon.mjs` (`getChatGPTQueue`, `handle`, `pollExtensionControl`) |
| Routing an Action invocation into that queue | Runtime dispatcher / CLI | `runtime/cli.mjs` (`runPlatform`), daemon IPC |

**There is no `queue:` manifest key, generic `registerQueuePolicy()` API, or automatic plugin loading at present.** Do not add one to an Actions manifest and assume it works. A new queue integration requires a reviewed WebHelm Runtime change. Action implementations must never import the Queue Core, own a queue database, manage browser sessions, or implement their own FIFO/retries.

## To opt an Action into the queue

1. **Keep the Platform Action unchanged.** Define its input schema and direct Session behavior normally. Decide whether the operation truly needs durable asynchronous delivery; do not queue ordinary read-only Actions by default.
2. **Implement a Runtime-owned queue adapter/policy.** Import `DurableQueueCore` from `runtime/durable-queue-core.mjs`. Provide a persistent database and the policy functions `rows(db)`, `enqueue(db, request, now)`, `claim(db, owner, now, ...args)`, `cancel(db, id)`, and `list(db)`. `DurableQueueCore` wraps `enqueue`, `claim`, and `cancel` in a single `BEGIN IMMEDIATE` transaction. These functions are **not** exposed from a platform manifest.
3. **Provide the execution lifecycle.** Implement `process(item)`, `stopScheduler()`/cleanup and any site-specific completion and recovery transitions in the Runtime adapter. Use `startSession`, `execSession`, `stopSession` through the daemon, not directly in the Action. Wire a single adapter instance into daemon startup/shutdown. Never run two dispatchers against the same DB.
4. **Register the Action at the Runtime dispatch boundary.** Match exactly `(platform, action)` and the intended invocation mode. On the queued path validate its input, supply or validate a stable idempotency key, call `adapter.enqueue(request)`, and return the durable acceptance receipt. The direct path for other Actions must remain unchanged. ChatGPT's existing async `new-turn` branch in `runtime/cli.mjs` and `chatgpt-new-turn-enqueue` daemon operation are the current concrete example, **not** a reusable registration API. Do not silently queue sync requests.
5. **Expose management to the Extension, not a public queue CLI.** The daemon can supply `list().items` to `workspace.control.poll`/`heartbeat` and consume an authenticated `queue-cancel` control request. The Extension must never execute the Action or maintain its own queue copy. Do not add `webhelm queue` CLI commands.
6. **Test before rollout.** Cover atomic enqueue-time merge (if supported), duplicate idempotency keys, FIFO on one partition, parallel independent partitions, global concurrency, queued-only cancel, daemon restart, uncertain send outcomes, Extension status and cancel, and unchanged direct execution. Test with a real owned browser Session before claiming E2E completion.

## Concurrency, partitioning and merge

- The **policy** determines a stable resource/partition identity (ChatGPT uses `thread_id`) and atomically claims only a runnable partition head. Do not permit two active items for the same resource.
- The **Core scheduler** limits overall active work via `concurrency`; use a bounded value appropriate for the site (ChatGPT currently caps it at four). Acquire browser Sessions only after claim, never while waiting in the FIFO.
- Optional **enqueue-time tail merge** is a policy decision within `enqueue`'s transaction. Merge only an eligible `QUEUED` tail for the same partition and compatibility domain; do not modify claimed/running/`WAITING` items. Preserve each original idempotency key and map all accepted requests to the resulting durable queue ID.
- Submission side effects must be verified before marking success. If a crash or timeout occurs after a possible submission, enter an **uncertain / needs-reconciliation** state; never blindly resend. Follow the existing ChatGPT policy's `SENDING`, `UNCERTAIN` and receipt checks as a reference, without copying its database schema into the Core.

## Exact current Core contract

This snippet shows an **adapter constructor pattern**, not a complete runnable queue or a manifest registration API:

```js
import { DurableQueueCore } from '../durable-queue-core.mjs';

class PlatformDeliveryQueue extends DurableQueueCore {
  constructor(db, policy, executeItem) {
    super(db, policy, () => Date.now() / 1000, {
      concurrency: 4,
      intervalMs: 60_000,
    });
    this.executeItem = executeItem;
  }
  async process(item) {
    await this.executeItem(item); // Runtime-owned execution, with durable state transitions
  }
}
```

`policy` must provide the five functions listed above, including transaction-safe partition ordering and idempotency. The adapter must own shutdown and DB close **after** `await stopScheduler()`; the Core does not close the DB. Consult `ChatGPTQueue` before writing production delivery logic.

For a new website that does not need a queue, follow `webhelm-actions/platforms/NEW_PLATFORM.md` and implement only the Action and its tests. Publish Runtime and Actions changes through their **separate** repositories and release paths.
