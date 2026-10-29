# Refresh-token lifetime probe

This dev-only tool measures the open questions in [research.md](research.md#token-lifetime).
It is excluded from the npm package. It imports `login` from `dist/auth.js`, then sends raw
refresh requests to the existing `https://accounts.renweb.com/connect/token` endpoint with
`client_id=aware3`. Redirects are disabled. No protocol defaults are assumed or changed.

## Run an experiment

Use the repository's supported Node version (Node 22 or 24 in CI). Run every command from
the same checkout directory; `.token-probe/` is relative to the working directory.

```sh
npm ci
npm run build
node scripts/token-probe.mjs --help
```

Configure the normal `FACTS_DISTRICT`, `FACTS_USERNAME`, `FACTS_PASSWORD` and
`FACTS_TOTP_SECRET` in your gitignored `.env`. The npm script uses Node's
`--env-file=.env`; the probe itself does not load environment files. Only `start`
uses login credentials. `check`, `mark`, `report` and `--help` can be run directly
without an environment file or build.

```sh
npm run probe -- start
node scripts/token-probe.mjs check
node scripts/token-probe.mjs mark "logged in on phone app"
node scripts/token-probe.mjs report
```

`start` creates six independent grants sequentially, in this order:

| Lane | Action during `check` |
| --- | --- |
| `rolling` | Refresh every time, retaining any replacement refresh token. |
| `reuse` | Refresh once; if rotated, try the original token once, then retire. Without rotation, retire immediately. |
| `idle-1d` | First attempt at age ≥24 hours, then retire on success. |
| `idle-7d` | First attempt at age ≥168 hours, then retire on success. |
| `idle-16d` | First attempt at age ≥384 hours, then retire on success. |
| `idle-31d` | First attempt at age ≥744 hours, then retire on success. |

Each age starts at that lane's successful login, not at the start of the experiment.
Between logins, the probe waits until a new 30-second TOTP period, with a small boundary
margin. A failed login stops immediately without retrying; earlier lanes are saved.
There is no automatic login or login-resume command. A partial run can still be checked
and reported, but absent lanes are listed as not started.

An existing `state.json` blocks `start`. Use `start --force` only when deliberately
replacing an experiment: it discards the previous live tokens, appends a new run marker
to the existing log, and logs in again. `report` shows only the current run. To keep a
separate full experiment, move the private directory to a secure location first.

## State, failures and interpretation

- `.token-probe/` is gitignored, created with mode `0700`; state, log and temporary
  files are `0600`. `state.json` contains **live refresh tokens**. Protect backups too.
- `log.jsonl` is append-only. It contains timestamps, ages, outcomes, response field
  names, approved metadata, and the first 12 hex characters of each token's SHA-256.
  It never contains raw tokens, credential values, raw response bodies or provider
  error descriptions. Manual marks are stored verbatim: never include secrets or
  personal data in them, and review logs before sharing.
- Claims are observations decoded without signature verification. Only `iat`, `exp`,
  `nbf`, `auth_time`, `client_id`, `scope`, `idp` and `amr` with simple expected types
  are recorded. Non-JWT tokens have no claims. Response values are limited to
  `token_type`, `scope`, and numeric/ISO timestamp `*expires*` fields. Unknown OAuth
  error values are recorded as `unrecognized_error` rather than arbitrary text.
- HTTP 400/401/403 is `rejected` (except temporary OAuth errors). A rejected lane is
  dead and never touched again. Other HTTP failures, timeouts, redirect failures,
  transport failures and malformed successful responses are `unavailable`. They
  leave the lane eligible for the **next scheduled check**, with no retry loop.
- Idle lanes stay untouched until due, then retire after success or die on rejection.
  If the reuse lane's old-token request is unavailable, its old-token phase is saved
  and attempted once at the next scheduled check. It never repeats the first phase
  after a recorded success. A lost response may mean a token was consumed upstream;
  interpret any later rejection alongside unavailable events.
- Each result is saved before another request. Commands are serialized with
  `.token-probe/.lock`. After an interrupted process, verify no probe process remains
  before removing that lock directory. Inspect its `pid` file if needed; do not delete
  `state.json` or restart logins just to clear a lock.
- `report` prints one row per lane, success/rejection ages, rotation counts and the
  old-token result, followed by manual marks. It is offline and needs no credentials.
  An empty or absent state produces a clear message.

The first rolling check follows five later logins, which tests concurrent grants.
Run a baseline check after `start`. For phone-app experiments, mark each login/logout
near the event and check afterwards; avoid combining several events in one interval.
If later logins or phone activity revoke all grants, that can confound the idle lifetime
measurement. A follow-up isolated experiment may be necessary. A rejection bounds the
lifetime between the last successful use and the rejection; an idle success gives only
a lower bound. An unavailable request is not evidence of expiration.

## Schedule every six hours on macOS with launchd

Run `start` manually first. Replace the example checkout, home and Node paths below
with absolute paths (`command -v node` gives the Node executable). Keep the working
directory fixed. `check` needs no `.env`; omit credentials from scheduler configuration.

Prepare the scheduler output with private permissions:

```sh
umask 077
touch .token-probe/scheduler.log
chmod 600 .token-probe/scheduler.log
```

Save this as `~/Library/LaunchAgents/com.kgoggin.facts-token-probe.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kgoggin.facts-token-probe</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/facts-checker/scripts/token-probe.mjs</string>
    <string>check</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/facts-checker</string>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>/absolute/path/to/facts-checker/.token-probe/scheduler.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/to/facts-checker/.token-probe/scheduler.log</string>
</dict>
</plist>
```

`Umask` is decimal 63, equivalent to octal `077`. Load or remove the job with:

```sh
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kgoggin.facts-token-probe.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kgoggin.facts-token-probe.plist"
```

Use only one scheduler. launchd may coalesce checks while the machine sleeps; actual
attempt ages are recorded, so interpret results at those ages rather than target times.

## Schedule with cron

After manually running `start`, add the following with `crontab -e`, replacing the
absolute checkout and Node paths. The command runs at 00:00, 06:00, 12:00 and 18:00 in
the machine's timezone, with a private output file inside the private state directory.

```cron
0 */6 * * * umask 077; cd /absolute/path/to/facts-checker && /absolute/path/to/node scripts/token-probe.mjs check >> .token-probe/scheduler.log 2>&1
```

Checks more often than six hours leave idle lanes untouched until due. They do consume
rolling refreshes, so keep a consistent interval when measuring its sliding lifetime.
Remove the cron entry or unload launchd when the experiment ends. No scheduler should
ever run `start` automatically.
