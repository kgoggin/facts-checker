---
"@kgoggin/facts-checker": minor
---

Replace the FACTS OAuth HTTP service with a TypeScript library: `login()`/`refresh()` from `@kgoggin/facts-checker/auth` (credentials and TOTP from `FACTS_*` env vars) and a self-refreshing `createClient()` with `students()` and `homework()`.
