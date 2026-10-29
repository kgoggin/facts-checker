# Initial findings — 2026-10-17

Reference: https://github.com/k4deng/facts-gradechecker at commit `21ce648d3eb54881c2d1111c4b23ca076dadb3fd` (read for protocol/field research; this repo is a fresh implementation).

## Observed without credentials

- `https://accounts.renweb.com/.well-known/openid-configuration` is live and advertises authorization-code, refresh-token and PKCE support.
- An authorization request with the reference client's `aware3` ID, scopes and `com.renweb.accounts:/oauthredirect` URI reaches a district-first form posting to `/Account/SignIn`.
- That form includes `District`, hidden `ReturnUrl`, `MemberId`, and `__RequestVerificationToken`. The original code instead assumes district, username and password can all be posted to the initial login URL.
- Reaching a login page does not prove that the client/scopes/redirect URI will be accepted at token issuance. Public discovery lists only standard scopes, while the reference uses additional app-specific scopes; acceptance needs a real login.

## Endpoints from reference source (now authenticated and verified)

Base: `https://nbsmobileapi.renweb.com/api/`

- `SchoolsAndStudents/v1?featureName=10`: school/student/year/term discovery.
- `Homework/students/{studentId}/schoolYearId/{yearId}/legacyTermId/{termId}`: dedicated homework feed. Reference reads `studentHomeworkDateRangeModels[].notesDetails[]`, with `classId`, `courseTitle`, `eventDate`, `homeworkHTML`.
- `StudentClasses/{schoolCode}/{yearId}/{termId}/{studentId}`: class list and summary grades.
- `StudentClasses/v2/{schoolCode}/{yearId}/{termId}/{studentId}/{classId}`: gradebook categories and graded assignments, including assigned/due dates and points.

The reference homework view filters to the current week; this experiment retains every returned range. Homework and gradebook assignments may overlap but must not be assumed to be the same records.

## Credential-based follow-up

- The district step redirects to `https://login.nelnet.net/connect/authorize`, then to its JavaScript login app at `/login/sign-in`, carrying `returnUrl` and `tenantKey`.
- The app obtains its CSRF cookie/header names from `/api/spa-data-json` (`antiForgeryTokenInfo`). The observed names are `Passport-Xsrf-Cookie` and `Passport-Xsrf-Header`.
- Sign-in uses GET then POST `/bff/api/v2/login/sign-in`, with JSON `username` and `password` and the preserved query context. A live password submission succeeded and led to `/mfa/verify`.
- The public SPA uses GET then POST `/bff/api/v2/mfa-verify-code` with JSON `{code}` for that OTP step. Live OTP verification succeeded. Unlike sign-in, the OTP response is `{result, scenario}`: `result=1` means valid, and `scenario=0` returns to the OAuth authorization flow.
- Email OTP candidates from the SPA are `/bff/api/v2/email-mfa/get-emails`, `/send-verification-code` and `/submit-code`; these are implemented provisionally but have not been tested against the live account.
- Identity-provider redirects are restricted to the observed FACTS and Nelnet origins. No credential values or token payloads are written to logs.

## Historical upstream verification

The earlier experiment completed FACTS/Nelnet OTP login, token refresh, school/student discovery and homework retrieval against a live parent account. That establishes the observed upstream protocol; the library has not yet been re-verified end to end against a live account.

- Nelnet finishes federation with a hidden `form_post` containing `code`, `state`, `session_state` and `iss`, addressed to `https://accounts.renweb.com/signin-openidconnect_prod`.
- FACTS renders `/External/Callback`, whose refresh meta tag contains an explicit `data-url`. The driver extracts it without executing JavaScript, validates callback state and exchanges the code using PKCE.
- Homework includes `uid` and `homeworkPlaintext` as well as HTML. The client preserves the UID, prefers plain text and retains all returned calendar ranges. `eventDate` is not assumed to be a due date.
- Upstream refresh succeeded without password or OTP. Refresh lifetime/revocation policy remains unknown.

Grade endpoints above are research only; the client exposes homework only and writes nothing to disk.

## Token lifetime

**Results pending.** Refresh-token lifetime, rotation, concurrent-grant revocation and
FACTS mobile-app effects have not been measured. IdentityServer's possible 15-day
sliding / 30-day absolute defaults are a hypothesis, not an observed FACTS policy.

The dev-only [token probe](token-probe.md) creates six independent grants. `rolling` is
the first login and refreshes every six hours, keeping replacement tokens; the next
five logins let its first check test whether later grants revoke earlier ones. `reuse`
refreshes once, then tests the original token once if rotation occurred. `idle-1d`,
`idle-7d`, `idle-16d` and `idle-31d` stay untouched until their own login ages reach
those targets, then refresh once. Rejected lanes stop permanently; unavailable
attempts are logged and left for the next scheduled check. Manual marks correlate
phone-app logins/logouts with later refresh outcomes.

The maintainer will run the experiment; implementation and fixture tests do not contact
FACTS. Fill this table from `.token-probe/log.jsonl` and `report` after collecting results.
The private state includes live tokens and must not be committed or shared. Logs use
token hashes and whitelisted metadata; review manual notes before sharing them.

| Question | Evidence to collect | Result |
| --- | --- | --- |
| Unused lifetime; sliding window and absolute cap | Four idle-lane outcomes at actual ages; rolling last success and first rejection across weeks | Pending |
| Rotation; old token accepted after rotation? | Rolling token hashes; reuse lane's first refresh and old-token outcome | Pending |
| Do new logins invalidate previous grants? | First rolling check after the five later lane logins | Pending |
| Do mobile-app login/logout events invalidate grants? | Timestamped manual marks and checks before/after each event | Pending |

Six-hour sampling bounds expiration rather than proving its exact instant. An idle
success establishes a lower bound, and a transient failure establishes neither expiry
nor revocation. Concurrent-grant or phone-app revocation may confound lifetime results;
isolate those effects in follow-up experiments if observed.
