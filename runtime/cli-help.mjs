// CLI help is the single agent-facing command reference. Keep it in sync with
// the dispatcher's supported commands and flags.
const common = 'Use \`webhelm COMMAND --help\` or \`webhelm help COMMAND\` for detailed usage.';

const sections = {
  '': `webhelm — operate managed Chrome through persistent browser Sessions and site Actions

Usage:
  webhelm <command> [options]
  webhelm help [command [subcommand]]

Commands:
  webhelm setup                            Set up managed Chrome and local Actions
  webhelm status                           Report browser and daemon status (JSON)
  webhelm ensure                           Check and recover managed Chrome health
  webhelm upgrade [--force]                Check npm and upgrade the Runtime
  webhelm capacity                         Report available browser capacity (JSON)
  webhelm session start [--url URL]        Start a persistent browser Session
  webhelm session list                    List CLI-owned Sessions
  webhelm session exec ID [--code-file F]  Run JavaScript in a Session
  webhelm session heartbeat ID            Keep a Session alive during idle waits
  webhelm session stop ID|--all           Stop a Session or explicitly stop all CLI Sessions
  webhelm design start --url URL          Open reference site with native ChatGPT Split View
  webhelm design attach ID                Split an existing CLI Session
  webhelm design status                   Show active Design Mode Sessions
  webhelm design stop ID                  Unsplit; stop only Design-created Sessions
  webhelm platform list                   List installed website integrations
  webhelm platform profile NAME           Inspect a site's supported fields
  webhelm platform source NAME ACTION     Read the source of an installed Action
  webhelm platform run NAME ACTION [...]  Execute an installed site Action
  webhelm platform sync                   Update installed site Actions
  webhelm platform publish --message MSG  Publish reviewed site Action changes
  webhelm help [command [subcommand]]     Show command help
Options:
  -h, --help                       Show help without running the command

Output: operational commands emit JSON; platform source prints JavaScript source.
${common}`,
  help: `webhelm help — show command usage without side effects

Usage:
  webhelm --help
  webhelm help [COMMAND [SUBCOMMAND]]
  webhelm COMMAND [SUBCOMMAND] --help

Shows all commands or detailed usage for any available command and subcommand.
Help never initializes Chrome, changes Sessions, or runs site Actions.

Example:
  webhelm help session exec`,
  setup: `webhelm setup — prepare local Actions and managed Chrome

Usage:
  webhelm setup

Initializes or reuses the site Actions checkout, starts or reuses managed
Chrome and its daemon, and registers the login-time health check.
Does not replace an existing Actions checkout with local changes.
Output: JSON with status, Actions checkout path, daemon and browser details.

Example:
  webhelm setup`,
  upgrade: `webhelm upgrade — update the npm Runtime when safely idle\n\nUsage:\n  webhelm upgrade [--force]\n\nChecks npm once. Stages newer Runtime without executing install scripts.\nCutover waits until all Sessions and in-flight queue workers are idle;\notherwise reports deferred and retries on the next hourly LaunchAgent run.\nOld daemons without the upgrade protocol defer safely.\n--force bypasses idle checks and sends SIGTERM to the verified WebHelm\ndaemon (including legacy versions), which is then restarted.\nActive Sessions and in-flight queue work may be interrupted.\nThe hourly updater never uses --force.\nNever updates a source-mode checkout or deliberately restarts Chrome.\n\nOutput: JSON current, upgraded, deferred, or source_checkout.`,
  status: `webhelm status — inspect managed browser and daemon

Usage:
  webhelm status

Output: JSON describing CLI version, installed Actions location, managed
Chrome process and profile, health-check state, and daemon Session count.

Example:
  webhelm status`,
  ensure: `webhelm ensure — verify and recover managed Chrome health

Usage:
  webhelm ensure

Checks the existing daemon and managed browser and attempts a safe recovery.
May defer an incompatible upgrade while active Sessions are running.
Output: JSON health or deferred-upgrade result.

Example:
  webhelm ensure`,
  capacity: `webhelm capacity — inspect browser availability

Usage:
  webhelm capacity

Reports allocatable browser capacity without opening a Session.
Output: JSON capacity information.

Example:
  webhelm capacity`,
  design: `webhelm design — share one native site with the active ChatGPT thread

Usage:
  webhelm design <start|attach|status|stop> [options]

Start creates one managed WebHelm Session and pairs it with an existing
ChatGPT thread Tab in Chrome Split View; attach reuses an existing Session.
The Extension automatically tracks and protects the companion ChatGPT tab.
Sessions in Design Mode are heartbeat-renewed by the daemon.
Stopping Design Mode restores the original ChatGPT tab layout; a Session
created with design start is also stopped.

Examples:
  webhelm design start --url https://mobbin.com/
  webhelm design attach SESSION_ID
  webhelm design status
  webhelm design stop SESSION_ID`,
  'design start': `webhelm design start — open the selected design reference site and split with ChatGPT

Usage:
  webhelm design start --url HTTPS_URL

The native reference URL is selected by the Agent using
skills/webhelm/references/design-mode.md. Requires an existing ChatGPT
conversation tab in WebHelm managed Chrome (Chrome 155+).
No screenshot, iframe aggregator, or duplicate ChatGPT tab is created.
If no suitable thread exists, the new Session is rolled back.

Example:
  webhelm design start --url https://www.motionlex.online/`,
  'design attach': `webhelm design attach — enable Design Mode on an existing Session

Usage:
  webhelm design attach SESSION_ID

Preserves Session identity and existing site state; opens native Split View.
Repeated calls are idempotent.

Example:
  webhelm design attach SESSION_ID`,
  'design status': `webhelm design status — list shared Design Mode Sessions

Usage:
  webhelm design status

Returns JSON with current session_id, original site URL (when known),
ownership, and heartbeat time. No browser navigation or Session creation.

Example:
  webhelm design status`,
  'design stop': `webhelm design stop — end native Split View

Usage:
  webhelm design stop SESSION_ID

Restores the companion ChatGPT Tab to its original window/group/index.
Only Sessions created with design start are also stopped; attached Sessions
return to ordinary Session lifecycle.
A Session stopped or garbage-collected independently also auto-unsplits.

Example:
  webhelm design stop SESSION_ID`,
  session: `webhelm session — manage persistent JavaScript browser Sessions

Usage:
  webhelm session <subcommand> [options]

Subcommands:
  start [--url URL]           Start a Session and receive a session_id
  list                        List active CLI-owned Sessions
  exec ID [--code-file FILE]  Run JavaScript in a persistent Session
  heartbeat ID                Refresh the idle timer for a Session
  stop ID                     Stop one Session and release its tab
  stop --all                  Stop all CLI-owned Sessions (destructive)

Always reuse the returned session_id; stop only Sessions owned by your task.
An idle Session can be reclaimed after five minutes without activity.
Long-running workflows should heartbeat at least every 60 seconds.

Examples:
  webhelm session start --url https://example.com
  webhelm session list
  webhelm session exec SESSION_ID --code-file ./inspect.js
  webhelm session stop SESSION_ID

Run 'webhelm session <subcommand> --help' for detailed usage.`,
  'session start': `webhelm session start — open a persistent browser Session

Usage:
  webhelm session start [--url URL]

Options:
  --url URL     Optional initial http(s) destination
  -h, --help   Show help without opening a browser Session

Output: JSON containing the new session_id. Retain it for exec and stop.

Example:
  webhelm session start --url https://example.com`,
  'session list': `webhelm session list — list CLI-owned Sessions

Usage:
  webhelm session list

Output: JSON with session_count and sessions array, including session_id.
Does not create a Session.

Example:
  webhelm session list`,
  'session exec': `webhelm session exec — run JavaScript in an existing Session

Usage:
  webhelm session exec SESSION_ID [--code-file FILE]
  webhelm session exec SESSION_ID <<'JS'
  console.log(await snapshot());
  JS

Arguments:
  SESSION_ID       ID returned by 'webhelm session start'

Options:
  --code-file FILE Read JavaScript from FILE instead of standard input
  -h, --help      Show help without executing code

The JavaScript context persists across exec calls. Browser helpers are async:
  snapshot, page_info, goto_url, wait_for_load, wait_for_element,
  fill_input, click, js, cdp, new_tab, current_tab, list_tabs,
  switch_tab, close_tab, upload_file, type_text, capture_screenshot,
  wait.
Read 'snapshot()' before using element references and refresh after navigation.
Use 'new_tab()' rather than raw CDP target creation.
Output: JSON with execution status and captured result/stdout.

Example:
  printf 'console.log(await page_info());\\n' | webhelm session exec SESSION_ID`,
  'session heartbeat': `webhelm session heartbeat — keep an active Session alive

Usage:
  webhelm session heartbeat SESSION_ID

Refreshes the Session's idle timer without navigating or changing tabs.
Use at least every 60 seconds during long waits with no browser operations.
Output: JSON heartbeat result.

Example:
  webhelm session heartbeat SESSION_ID`,
  'session stop': `webhelm session stop — release browser Sessions

Usage:
  webhelm session stop SESSION_ID
  webhelm session stop --all

Arguments:
  SESSION_ID    Release one Session owned by the current workflow

Options:
  --all        Stop every CLI-owned Session; use only when explicitly authorized
  -h, --help  Show help without stopping Sessions

Output: JSON release result. Stopping a Session may return its tab to idle.
Do not use --all for ordinary task cleanup.

Example:
  webhelm session stop SESSION_ID`,
  platform: `webhelm platform — use installed website Actions

Usage:
  webhelm platform <subcommand> [options]

Subcommands:
  list                         List installed site platforms
  profile PLATFORM             Report site fields and capabilities
  source PLATFORM ACTION       Print the Action's JavaScript source
  run PLATFORM ACTION [opts]   Execute a site Action in a browser Session
  sync                         Fast-forward local Action definitions
  publish --message MESSAGE    Test, commit and push reviewed Action changes

Examples:
  webhelm platform list
  webhelm platform profile chatgpt
  webhelm platform source z new-turn
  webhelm platform run z new-turn --session-id SESSION_ID --config ./input.json

Run 'webhelm platform <subcommand> --help' for detailed usage.`,
  'platform list': `webhelm platform list — discover installed website platforms

Usage:
  webhelm platform list

Output: JSON array of available site names, read from installed Actions.

Example:
  webhelm platform list`,
  'platform profile': `webhelm platform profile — inspect a website integration

Usage:
  webhelm platform profile PLATFORM

Arguments:
  PLATFORM    Site name from 'webhelm platform list'

Output: JSON profile with available capabilities, field schemas and notes
when declared by the platform. Read it before building Action input.

Example:
  webhelm platform profile chatgpt`,
  'platform source': `webhelm platform source — inspect an installed site Action

Usage:
  webhelm platform source PLATFORM ACTION

Arguments:
  PLATFORM    Site name from 'webhelm platform list'
  ACTION      Action name defined by the site's manifest

Output: JavaScript source text (not JSON). Inspection has no browser effect.

Example:
  webhelm platform source z new-turn`,
  'platform run': `webhelm platform run — execute an installed site Action

Usage:
  webhelm platform run PLATFORM ACTION --session-id SESSION_ID [--config FILE] [--url URL]
  webhelm platform run PLATFORM ACTION --auto-session [--config FILE] [--url URL]
  webhelm platform run PLATFORM QUEUED_ACTION [--config FILE]

Arguments:
  PLATFORM       Site name from 'webhelm platform list'
  ACTION         Action name declared by the site's manifest

Options:
  --session-id ID Reuse a caller-owned Session (normal interactive mode)
  --auto-session  Create and release a Session for one self-contained Action
  --config FILE   Read a JSON object of Action-specific inputs (default: {})
  --url URL       Optional initial URL for a browser Action
  -h, --help     Show help without executing an Action

--session-id and --auto-session cannot be combined. A Platform Policy in
queues/*.mjs makes a no-Session invocation asynchronous and durable; providing
--session-id runs the declared Action directly. No mode flag or config field.
Inspect 'platform profile' and 'platform source' for Action-specific inputs.
Output: JSON Action result. An accepted submission may require later verification.

Examples:
  webhelm platform run z new-turn --session-id SESSION_ID --config ./turn.json
  webhelm platform run chatgpt new-turn --config ./turn.json
  webhelm platform run chatgpt new-turn --session-id SESSION_ID --config ./turn.json`,
  'platform sync': `webhelm platform sync — update installed site Actions

Usage:
  webhelm platform sync

Fetches and fast-forwards the Actions checkout. Refuses to overwrite local
changes or a diverged checkout. Does not update the browser Runtime.
Output: JSON sync status and revision.

Example:
  webhelm platform sync`,
  'platform publish': `webhelm platform publish — publish verified site Action changes

Usage:
  webhelm platform publish --message "DESCRIPTION"

Options:
  --message DESCRIPTION  Required commit description (8–250 characters)
  -h, --help             Show help without publishing

Runs the independent Actions tests, stages site Action files, commits, and
pushes without force. Use only for reviewed, authorized changes. Do not
publish account data, secrets or browser traces.
Output: JSON publish status and revision.

Example:
  webhelm platform publish --message "fix(z): update composer selector"`,
};

export const helpTopics = Object.freeze(Object.keys(sections).filter(Boolean));
export function cliHelp(topics=[]) {
  const parts = topics.filter(Boolean);
  const key = parts.length>1 && ['session','platform','design'].includes(parts[0])
    ? parts.slice(0,2).join(' ') : (parts[0] || '');
  if (!Object.hasOwn(sections,key)) throw Error(`unknown help topic: ${parts.join(' ')}`);
  return sections[key];
}
