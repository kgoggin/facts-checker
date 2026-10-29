# Changesets

Any PR that changes published behaviour needs a changeset. Run `npx changeset`, choose the bump that matches the PR's Conventional Commit type (`fix`/`perf` → patch, `feat` → minor, breaking → major), and commit the generated file.

When the PR merges to `main`, the release workflow opens a "Version Packages" PR. Merging that PR stages the release on npm for a maintainer to approve. See [AGENTS.md](../AGENTS.md#releases).
