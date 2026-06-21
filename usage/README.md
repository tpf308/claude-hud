# Third-party API balance in the claude-hud statusline

Shows your third-party Claude API provider's remaining balance / rate-limit
windows (a 5h window + a weekly window) in claude-hud's **Usage** line, e.g.:

```
Context ██████░░░░ 60% │ Usage 5h $6.37 (4h 35m) | 7d $13.29 (5d 2h)          project git:(branch) │ [Opus 4.8]
```

## How it works

When Claude Code talks to a third-party (Anthropic-compatible) endpoint, stdin
carries no first-party `rate_limits`, so claude-hud's built-in **external usage
snapshot** becomes the sole source of the Usage line. This integration just
writes that snapshot from your provider's usage endpoint — no change to how the
plugin runs.

- `usage/statusline.mjs` (default mode) = the `statusLine.command` wrapper:
  - if the snapshot is stale, fire a background `--poll` (fire-and-forget, never
    blocks the render);
  - render the HUD in the same process via `import('../dist/index.js').main()`
    (reads stdin / writes stdout) — no second node process.
- `usage/statusline.mjs --poll` = one-shot: query the provider usage endpoint
  and — with the same cookie — the sibling `/api/billing` endpoint for the
  account's extra prepaid balance (the poller has real `fetch`, so one poll
  covers both endpoints), then atomically write `usage-snapshot.json`.
- Plugin side: three small source tweaks add a per-window `detail` string so each
  window can show a concrete amount (e.g. `$6.37`) in place of `NN%`, while the
  bar still fills by used-percentage (`src/types.ts`, `src/external-usage.ts`,
  `src/render/lines/usage.ts`).

## Cookie source (`source`)

The usage endpoint is authenticated by a browser session **cookie** (the API key
returns 401 there), so `usage.config.json`'s `source` decides which cookie to use:

- `cc-switch` (default): every poll opens `~/.cc-switch/cc-switch.db` (read-only)
  and reads the `usage_script` cookie of the provider with
  `app_type='claude' AND is_current=1` — i.e. **whichever provider is currently
  active**, so it auto-follows switches/failover. Falls back to the static cookie.
- `static`: always use the `cookie` + `apiUrl` in `usage.config.json`.
- The `USAGE_COOKIE` env var overrides both.

> Requires that the active provider has a valid usage cookie configured in
> cc-switch (and not expired). On failure the HUD shows a query-failed message.

## Files

| Path | Role |
|---|---|
| `usage/statusline.mjs` | wrapper + poller (one file, two modes) |
| `usage/usage.config.json` | cookie / apiUrl / refresh params (**secret, gitignored**) |
| `usage/usage-snapshot.json` | snapshot (poller writes, plugin reads) |
| `usage/poll.log`, `.poll.lock` | log / throttle lock |
| `~/.claude/plugins/claude-hud/config.json` | `display.externalUsagePath` → snapshot + display options |
| `~/.claude/settings.json` → `statusLine.command` | `node "<repo>/usage/statusline.mjs"` |

### `usage.config.json` (create this; gitignored)

```json
{
  "source": "cc-switch",
  "apiUrl": "https://<provider>/api/usage",
  "cookie": "bm_session=…",
  "refreshStaleMs": 120000,
  "balanceEnabled": true,
  "balancePrefix": "额外 "
}
```

The poller maps the endpoint's `window5h` / `windowWeek` (`usedCents` /
`limitCents` / `resetsAt`) into the snapshot. When `balanceEnabled` (default
true), it also reads `creditCents` from `/api/billing` (derived from `apiUrl` by
swapping the trailing `usage`→`billing`, or set `balanceUrl`) and appends it
after the windows as `<balancePrefix>$X` (default `额外 $X`).

## Single-line / right-aligned layout

`~/.claude/plugins/claude-hud/config.json` collapses the model/project block onto
the Usage line and right-aligns it. Relevant `display` options (all added in this
fork):

- `mergeGroups: [["context","usage","project"]]` + an `elementOrder` that keeps
  those three adjacent → one merged line.
- `rightAlignTail: true` → the last segment (project) is pushed to the right edge
  using the `COLUMNS` Claude Code passes in.
- `rightAlignReserve: N` → keep N columns free at the right edge. **Needed** when
  the terminal renders ambiguous-width glyphs (bars/box-drawing) as 2 cells, which
  would otherwise overflow and truncate the tail. Increase it if the tail is cut.
- `projectModelAtEnd: true` → `project git │ [model]` (project before model).
- `sevenDayBarEnabled: false` / `usageBarEnabled: false` → hide the weekly / all
  usage bars (independent of the context bar).
- `modelFormat: "compact"` → drop the redundant `(1M context)` suffix.

## Manual test

```bash
node usage/statusline.mjs --poll        # one query → poll.log / usage-snapshot.json
echo '{"model":{"display_name":"Opus 4.8"},"context_window":{"current_usage":{"input_tokens":90000},"context_window_size":200000},"transcript_path":"x"}' \
  | node usage/statusline.mjs           # render the statusline
```

## Revert

Delete the `statusLine` block from `~/.claude/settings.json` to restore the
default; the plugin source tweaks live only in this fork.
