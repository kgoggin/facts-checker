# @kgoggin/facts-checker

## 0.3.0

### Minor Changes

- [#7](https://github.com/kgoggin/facts-checker/pull/7) [`62c038f`](https://github.com/kgoggin/facts-checker/commit/62c038fbdf51d4a66b8a8e8409008b34cc64c486) Thanks [@kgoggin](https://github.com/kgoggin)! - Add a bring-your-own-auth API entry point for authenticated fetch implementations.

## 0.2.0

### Minor Changes

- [#3](https://github.com/kgoggin/facts-checker/pull/3) [`782d1af`](https://github.com/kgoggin/facts-checker/commit/782d1af056c990ce0c32354ca9449aaad3d61aaf) Thanks [@kgoggin](https://github.com/kgoggin)! - Initial release: `login()`/`refresh()` from `@kgoggin/facts-checker/auth` log in to FACTS through Nelnet sign-in and TOTP MFA (credentials from `FACTS_*` env vars), and `createClient()` returns a self-refreshing client with `students()` and `homework()`.
