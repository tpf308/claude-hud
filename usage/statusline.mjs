#!/usr/bin/env node
/**
 * Third-party Claude API balance statusline for claude-hud.
 *
 * Shows your provider's remaining balance / rate-limit windows in the claude-hud
 * Usage line. When Claude Code talks to a third-party (OpenAI-compatible/Anthropic
 * -compatible) endpoint it sends no first-party rate_limits on stdin, so claude-hud's
 * built-in external-usage snapshot becomes the sole source of the Usage line — this
 * script feeds that snapshot.
 *
 * Two modes in one file:
 *
 *   (default)  Wrapper. Used as the Claude Code `statusLine.command`.
 *              1. If the snapshot is stale, fire off a background `--poll`
 *                 (detached, never blocks the HUD render).
 *              2. Render the HUD in-process by importing the local build's
 *                 main() — it reads stdin and writes stdout itself, so there
 *                 is no second node process and no stdin piping.
 *
 *   --poll     One-shot. Fetch the provider's usage endpoint, map it into the
 *              snapshot schema claude-hud's external-usage reader understands,
 *              and write it atomically.
 *
 * Cookie source: by default the active provider's usage cookie is read live from
 * cc-switch's DB (so the balance always tracks whichever provider is serving you,
 * including failover); a static cookie in usage.config.json is the fallback.
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  appendFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
const DIR = dirname(SELF);
const CONFIG_PATH = join(DIR, 'usage.config.json');
const SNAPSHOT_PATH = join(DIR, 'usage-snapshot.json');
const LOCK_PATH = join(DIR, '.poll.lock');
const LOG_PATH = join(DIR, 'poll.log');
const HUD_ENTRY = new URL('../dist/index.js', import.meta.url);

const DEFAULTS = {
  // Where to get the usage cookie:
  //   'cc-switch' = read the CURRENT claude provider's usage_script cookie from
  //                 cc-switch's DB, so the HUD auto-follows the active account
  //                 (incl. failover). Falls back to the static cookie below.
  //   'static'    = always use `cookie` / `apiUrl` from usage.config.json.
  source: 'cc-switch',
  // Override the cc-switch DB path; empty = ~/.cc-switch/cc-switch.db.
  ccSwitchDb: '',
  // Provider usage endpoint + cookie for the static fallback. Set these in
  // usage.config.json (gitignored); left blank here so no endpoint is hardcoded.
  apiUrl: '',
  cookie: '',
  userAgent: 'cc-switch/1.0',
  // Wrapper triggers a background refresh once the snapshot is older than this.
  refreshStaleMs: 120000,
  // The wrapper will not spawn more than one poll per this window (throttle).
  lockTtlMs: 60000,
  // fetch timeout for the usage request.
  timeoutMs: 10000,
  // Also show the account's extra prepaid balance (creditCents) from the
  // sibling /api/billing endpoint. This poller runs in real Node with fetch
  // (unlike cc-switch's sandboxed extractor, which can only hit one endpoint
  // per config), so it can query usage + billing in the same poll and append
  // the balance after the usage windows.
  balanceEnabled: true,
  // Override the balance endpoint; empty = derive from the usage url by
  // swapping the trailing path segment (…/usage → …/billing).
  balanceUrl: '',
  // Text shown before the balance amount, e.g. "额外 $43.13".
  balancePrefix: '额外 ',
};

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function log(msg) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* logging is best-effort */
  }
}

function mtimeMs(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// $X for whole dollars, $X.YY otherwise. Negative balances clamp to $0.
function fmtDollars(cents) {
  const v = Math.max(0, Math.round(cents)) / 100;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

function atomicWriteJson(path, obj) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tmp, path);
}

// Surface an error in the HUD only when there is no fresh good snapshot, so a
// transient blip never clobbers good data but an expired cookie eventually shows.
function maybeWriteError(cfg, message) {
  const ts = mtimeMs(SNAPSHOT_PATH);
  const stale = ts === 0 || Date.now() - ts > cfg.refreshStaleMs;
  if (!stale) return;
  try {
    atomicWriteJson(SNAPSHOT_PATH, {
      updated_at: new Date().toISOString(),
      five_hour: { used_percentage: null, resets_at: null, detail: null },
      seven_day: { used_percentage: null, resets_at: null, detail: null },
      balance_label: message,
    });
  } catch (e) {
    log(`maybeWriteError failed: ${e?.message || e}`);
  }
}

// Read the CURRENT claude provider's usage_script (url + Cookie) from the
// cc-switch SQLite DB, so the displayed balance always tracks the active account.
// Returns null if anything is missing/unavailable (caller falls back to static).
async function resolveFromCcSwitch(cfg) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const os = await import('node:os');
    const dbPath = cfg.ccSwitchDb || join(os.homedir(), '.cc-switch', 'cc-switch.db');
    const db = new DatabaseSync(dbPath, { readonly: true });
    let row;
    try {
      row = db
        .prepare(`SELECT name, meta FROM providers WHERE app_type='claude' AND is_current=1 LIMIT 1`)
        .get();
    } finally {
      db.close();
    }
    if (!row) return null;
    const meta = JSON.parse(row.meta);
    const code = meta?.usage_script?.code || '';
    const url = (code.match(/url:\s*"([^"]+)"/) || [])[1];
    const cookie = (code.match(/"Cookie"\s*:\s*"([^"]*)"/) || [])[1];
    if (!url || !cookie || !cookie.includes('bm_session=')) return null;
    return { url, cookie, provider: row.name };
  } catch (e) {
    log(`cc-switch resolve failed: ${e?.message || e}`);
    return null;
  }
}

// Decide which (url, cookie) to query. $USAGE_COOKIE always wins (manual
// override); then cc-switch active provider; then the static config cookie.
async function resolveSource(cfg) {
  if (process.env.USAGE_COOKIE) {
    return { url: cfg.apiUrl, cookie: process.env.USAGE_COOKIE, provider: 'env' };
  }
  if (cfg.source !== 'static') {
    const fromDb = await resolveFromCcSwitch(cfg);
    if (fromDb) return fromDb;
    log('cc-switch source unavailable, falling back to static cookie');
  }
  if (cfg.cookie && cfg.apiUrl) {
    return { url: cfg.apiUrl, cookie: cfg.cookie, provider: 'static' };
  }
  return null;
}

// GET JSON-ish with a *cleared* timeout. AbortSignal.timeout() leaves a dangling
// timer handle that can trip a libuv assertion (UV_HANDLE_CLOSING) when the
// process exits via process.exit() on Windows; an explicit controller +
// clearTimeout in finally removes the lingering handle so exit is clean.
async function fetchWithTimeout(url, cookie, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': cfg.userAgent,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort: fetch the account's extra prepaid balance (creditCents) from the
// provider's /api/billing endpoint, reusing the same cookie as the usage query.
// Returns a short label like "余额 $43.13", or null if disabled/unavailable so
// the usage windows still render on their own. Never throws into poll().
async function fetchBalanceLabel(cfg, src) {
  if (!cfg.balanceEnabled) return null;
  const url = cfg.balanceUrl || src.url.replace(/usage(\?.*)?$/, 'billing$1');
  if (!url || url === src.url) return null; // couldn't derive a distinct endpoint
  try {
    const res = await fetchWithTimeout(url, src.cookie, cfg);
    if (!res.ok) {
      log(`billing: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data || data.creditCents === undefined || data.creditCents === null) {
      log('billing: response missing creditCents');
      return null;
    }
    return `${cfg.balancePrefix}${fmtDollars(data.creditCents)}`;
  } catch (e) {
    log(`billing: fetch error ${e?.message || e}`);
    return null;
  }
}

async function poll() {
  const cfg = loadConfig();
  const src = await resolveSource(cfg);
  if (!src) {
    log('poll: no cookie source (cc-switch usage_script empty and no static cookie / $USAGE_COOKIE)');
    return 1;
  }

  let data;
  try {
    const res = await fetchWithTimeout(src.url, src.cookie, cfg);
    if (!res.ok) {
      log(`poll: HTTP ${res.status}`);
      maybeWriteError(cfg, `额度查询失败 HTTP ${res.status}`);
      return 1;
    }
    data = await res.json();
  } catch (e) {
    log(`poll: fetch error ${e?.message || e}`);
    maybeWriteError(cfg, '额度查询失败:网络错误');
    return 1;
  }

  if (!data || !data.window5h) {
    log('poll: response missing window5h (cookie expired?)');
    maybeWriteError(cfg, '额度查询失败:cookie 可能已过期');
    return 1;
  }

  const h5 = data.window5h;
  const wk = data.windowWeek || {};
  const pct = (used, limit) => (limit > 0 ? Math.round((used / limit) * 100) : 0);
  // Only the remaining balance, e.g. "$3.29".
  const remainDetail = (used, limit) => fmtDollars(limit - used);

  // Same cookie also unlocks the account's extra balance on /api/billing.
  const balanceLabel = await fetchBalanceLabel(cfg, src);

  const snapshot = {
    updated_at: new Date().toISOString(),
    five_hour: {
      used_percentage: pct(h5.usedCents || 0, h5.limitCents || 0),
      resets_at: h5.resetsAt ?? null,
      detail: remainDetail(h5.usedCents || 0, h5.limitCents || 0),
    },
    seven_day: {
      used_percentage: pct(wk.usedCents || 0, wk.limitCents || 0),
      resets_at: wk.resetsAt ?? null,
      detail: remainDetail(wk.usedCents || 0, wk.limitCents || 0),
    },
    balance_label: balanceLabel,
  };

  atomicWriteJson(SNAPSHOT_PATH, snapshot);
  log(`poll: ok [${src.provider}] 5h=${snapshot.five_hour.detail} 7d=${snapshot.seven_day.detail}${balanceLabel ? ` ${balanceLabel}` : ''}`);
  return 0;
}

function maybeSpawnPoll() {
  const cfg = loadConfig();
  const snapTs = mtimeMs(SNAPSHOT_PATH);
  const stale = snapTs === 0 || Date.now() - snapTs > cfg.refreshStaleMs;
  if (!stale) return;

  const lockTs = mtimeMs(LOCK_PATH);
  const locked = lockTs !== 0 && Date.now() - lockTs < cfg.lockTtlMs;
  if (locked) return;

  // Touch the lock first so concurrent ~300ms ticks don't all spawn a poll.
  try {
    writeFileSync(LOCK_PATH, String(Date.now()), 'utf8');
  } catch {
    /* best-effort */
  }

  try {
    spawn(process.execPath, ['--no-warnings', SELF, '--poll'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch (e) {
    log(`spawn poll failed: ${e?.message || e}`);
  }
}

async function wrapper() {
  // Background refresh — must never throw into the render path.
  try {
    maybeSpawnPoll();
  } catch (e) {
    log(`maybeSpawnPoll error: ${e?.message || e}`);
  }
  // Render the HUD in this same process. main() reads process.stdin (the JSON
  // Claude Code pipes in) and writes the statusline to stdout.
  const mod = await import(HUD_ENTRY.href);
  await mod.main();
}

if (process.argv[2] === '--poll') {
  // Set exitCode and let the event loop drain instead of process.exit(): forcing
  // exit while undici's (Node fetch) keep-alive sockets are mid-close trips a
  // libuv assertion (UV_HANDLE_CLOSING) on Windows. Draining lets those handles
  // close on their own; a short unref'd watchdog still guarantees termination if
  // a socket lingers (its delay never holds back a clean natural exit).
  poll()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      log(`poll fatal: ${e?.message || e}`);
      process.exitCode = 1;
    })
    .finally(() => {
      setTimeout(() => process.exit(process.exitCode ?? 0), 8000).unref();
    });
} else {
  wrapper().catch((e) => {
    log(`wrapper fatal: ${e?.message || e}`);
  });
}
