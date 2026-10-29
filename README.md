# facts-checker

A TypeScript library for logging in to the [FACTS](https://factsmgt.com/) (RenWeb) family portal and reading its mobile API. It automates the FACTS app's own OAuth flow, including the Nelnet sign-in and MFA, so any Node script can read a student's homework without a browser.

> Unofficial. It relies on undocumented endpoints observed in the FACTS mobile app (see [docs/research.md](docs/research.md)), so a change on FACTS's side can break it.

```sh
npm install @kgoggin/facts-checker
```

Requires Node.js 20.18+.

## Configuration

Every FACTS login asks for an MFA code. With an authenticator secret the library generates the code itself, so the whole login can run unattended:

```sh
FACTS_DISTRICT=ABC-XY      # district code from the FACTS login page
FACTS_USERNAME=parent@example.com
FACTS_PASSWORD=...
FACTS_TOTP_SECRET=JBSWY3DPEHPK3PXP   # base32 secret or otpauth:// URI
```

You get the TOTP secret when you add FACTS to an authenticator app: it's the key behind the setup QR code. Many apps can export it. Anything passed in code takes precedence over these variables.

## Client

```ts
import { createClient } from '@kgoggin/facts-checker';

const facts = createClient();            // logs in from FACTS_* on first use
for (const student of await facts.students()) {
  console.log(student.name, await facts.homework(student));
}
```

The client manages its own tokens. It logs in on first use, refreshes about a minute before the access token expires, refreshes and retries once on a `401`, and falls back to a full login if FACTS rejects the refresh token. Concurrent requests share one refresh.

The client keeps tokens in memory only. To avoid logging in again on every process start, save them yourself:

```ts
const facts = createClient({
  tokens: await loadSavedTokens(),       // { accessToken?, refreshToken?, expiresAt? }
  onTokens: tokens => saveTokens(tokens), // called after every login or refresh
});
```

| Option | Default | |
| --- | --- | --- |
| `tokens` | none | Saved tokens. A refresh token alone is enough. |
| `login` | `{}` (env) | [Login options](#auth) for when a full login is needed. `false` disables login, so requests throw `FACTS_LOGIN_REQUIRED` instead. |
| `onTokens` | none | Persistence hook. |
| `refreshMarginMs` | `60000` | How early to refresh before expiry. |

Methods:

- `students()` returns `{ id, name, context: { student, school, year, term } }[]` for every student on the account, using each school's default year and term.
- `homework(student | id)` returns `{ id, classId, course, eventDate, homework }[]`. `eventDate` is `YYYY-MM-DD` and `homework` is plain text.
- `get(path)` makes an authenticated GET relative to `https://nbsmobileapi.renweb.com/api/`.
- `accessToken()` returns a current bearer token. The `tokens` property holds the current token set.

Every method accepts `{ signal }`.

## Bring your own auth

Use `@kgoggin/facts-checker/api` when an OAuth proxy, token manager, or bundled or sandboxed runtime handles authentication:

```ts
import { createApi } from '@kgoggin/facts-checker/api';

const facts = createApi({
  fetch: async (url, init) => fetch(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${await getToken()}` },
  }),
});

for (const student of await facts.students()) {
  console.log(student.name, await facts.homework(student));
}
```

`getToken()` is supplied by your host. You can also pass a proxy's authenticated `fetch`, or `globalThis.fetch` when the host authenticates requests itself. This entry point contains the same `get(path)`, `students()` and `homework(student | id)` methods and response checks as the client, without importing the library's login modules. All three methods accept `{ signal }`; requests have a 30-second timeout and reject redirects.

The API adds no authorization header and never logs in, refreshes or retries. Your `fetch` receives an absolute URL and request options. A `401` throws `FACTS_LOGIN_REQUIRED`; other failed or unsupported responses throw `FACTS_UNAVAILABLE`.

`API_BASE` and `FACTS_OAUTH` are exported from `.`, `./api`, `./auth` and `./client`. An OAuth-aware host can use `FACTS_OAUTH.issuer`, `authorizationEndpoint`, `tokenEndpoint`, `clientId`, `redirectUri` and `scopes` to configure the public PKCE client. FACTS only registers the mobile-app redirect (`com.renweb.accounts:/oauthredirect`), so these hosts must be seeded with a refresh token obtained through the app's sign-in flow, rather than running sign-in themselves.

## Auth

Use `@kgoggin/facts-checker/auth` if you only want tokens:

```ts
import { login, refresh } from '@kgoggin/facts-checker/auth';

const tokens = await login();            // { accessToken, refreshToken, expiresAt }
const renewed = await refresh(tokens.refreshToken);
```

`login(options)` accepts `district`, `username`, `password`, `totpSecret`, `env`, `signal`, `onProgress` and `otp`. `otp` is a callback for prompts the TOTP secret can't answer, such as when the account uses email MFA:

```ts
await login({
  otp: async request => {
    if (request.type === 'email-destination') return request.options[0]; // pick an address
    return prompt(`FACTS ${request.type} code: `);                        // 'authenticator' | 'email'
  },
});
```

The library never retries a rejected password or code. Retrying could lock the account.

## Errors

Every error the library raises is a `FactsError` with a `code`:

| Code | Meaning |
| --- | --- |
| `FACTS_CONFIG` | A credential or OTP source is missing or invalid. |
| `FACTS_LOGIN_REQUIRED` | FACTS rejected the tokens or credentials and login is disabled. |
| `FACTS_LOGIN_FAILED` | The login flow failed or changed shape. The message describes the step. |
| `FACTS_UNAVAILABLE` | FACTS could not be reached or returned an unexpected response. |

## Contributing

```sh
npm ci
npm run typecheck && npm test && npm run build
```

The tests use fixtures and never contact FACTS. CI runs the typecheck, tests and build on Node 22 and 24 for every pull request.

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat: …`, `fix: …`, `docs: …`), and CI checks them with commitlint. PRs are squash-merged, so the PR title becomes the commit on `main`.

Releases use [Changesets](https://github.com/changesets/changesets). Don't bump the version or publish by hand.

1. In any PR that changes published behaviour, run `npx changeset`. Choose the bump that matches the commit type: `fix`/`perf` is patch, `feat` is minor, and a breaking change is major. Commit the generated file.
2. After the PR merges to `main`, the release workflow opens a "Version Packages" PR that bumps the version and updates `CHANGELOG.md`.
3. Merging "Version Packages" stages the version on npm via trusted publishing and creates the git tag and GitHub release.
4. A maintainer approves the staged version with 2FA on npmjs.com or with `npm stage approve`. Until then it isn't installable.

See [AGENTS.md](AGENTS.md) for contributor and agent guidelines.

## License

MIT
