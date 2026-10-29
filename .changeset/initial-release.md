---
"@kgoggin/facts-checker": minor
---

Initial release: `login()`/`refresh()` from `@kgoggin/facts-checker/auth` log in to FACTS through Nelnet sign-in and TOTP MFA (credentials from `FACTS_*` env vars), and `createClient()` returns a self-refreshing client with `students()` and `homework()`.
