# Agent guide

`@kgoggin/facts-checker` is a TypeScript library published to npm. It logs in to FACTS (RenWeb) through the Nelnet sign-in and MFA, and its client reads the FACTS mobile API. [README.md](README.md) covers the public API. [docs/research.md](docs/research.md) records the protocol as observed against FACTS.

## Layout

- `src/protocol.ts` has the FACTS OAuth (PKCE) flow, the cookie-carrying login session, and form handling for the legacy login pages.
- `src/nelnet.ts` drives the Nelnet SPA API: sign-in, authenticator MFA and email MFA.
- `src/auth.ts` is the public `@kgoggin/facts-checker/auth` entry point. It has `login`, `refresh` and the `FACTS_*` environment handling.
- `src/client.ts` is the public `@kgoggin/facts-checker/client` entry point. `FactsClient` handles token lifecycle and typed API methods.
- `src/totp.ts` implements RFC 6238 itself, with no dependency.
- `src/index.ts` re-exports the public API. Anything not exported there is internal.
- `test/` holds Vitest suites. They run on fixtures and stubbed `fetch`, and must never contact FACTS.

## Rules

- **Never add login retries.** A rejected password or OTP must stop the login. Repeated attempts can lock the parent account.
- **Keep redirects and form posts on the allowlist.** Credentials only go to `accounts.renweb.com` and `login.nelnet.net`. Don't loosen the origin checks.
- **Don't change the protocol on a guess.** If an endpoint or response shape changes, verify it against a live account and update `docs/research.md`.
- **Raise `FactsError` from public code paths,** using one of the existing codes. Add a code only if callers need to handle it differently.
- **Never commit secrets.** `.env` is gitignored. Never print tokens, passwords or TOTP secrets in logs or test output.

## Checks

Run all three before pushing. CI runs them on Node 22 and 24 for every PR and push to `main`:

```sh
npm run typecheck
npm test
npm run build
```

## Commits

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/), and CI enforces this with commitlint. PRs are squash-merged, so the PR title becomes the commit on `main`.

```
<type>(<optional scope>): <imperative summary>
```

Use these types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci` and `chore`. Mark breaking changes with `!` after the type (for example `feat!: …`) or a `BREAKING CHANGE:` footer.

The commit type tells you what changeset to add:

| Commit | Changeset |
| --- | --- |
| `fix`, `perf` | `patch` |
| `feat` | `minor` |
| `!` / `BREAKING CHANGE` | `major` (`minor` while the version is below 1.0) |
| `docs`, `test`, `ci`, `build`, `chore`, internal `refactor` | none |

## Releases

Releases go through [Changesets](https://github.com/changesets/changesets). Never edit `version` in `package.json`, tag releases or run `npm publish` by hand.

1. Every PR that changes published behaviour includes a changeset. Run `npx changeset`, choose the bump from the table above, write a one-line summary for library users and commit the generated `.changeset/*.md`.
2. When that PR merges to `main`, `.github/workflows/release.yml` opens or updates a "Version Packages" PR. That PR bumps the version and updates `CHANGELOG.md`.
3. Merging "Version Packages" runs `scripts/release.sh`. It stages the version on npm through trusted publishing (OIDC, with provenance) and creates the git tag and GitHub release.
4. The version isn't installable until a maintainer approves it with 2FA, on npmjs.com or with `npm stage approve`. CI can't approve. If a staged version is rejected, delete its tag and GitHub release by hand.
