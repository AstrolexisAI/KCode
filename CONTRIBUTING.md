# Contributing to KCode

Thanks for your interest in contributing to KCode! This guide covers the basics.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/AstrolexisAI/KCode/issues) with:

- A clear, descriptive title
- Steps to reproduce the problem
- Expected vs. actual behavior
- Your OS, Bun version, and KCode version

## Submitting Changes

1. **Fork** the repository and create a feature branch from `main`.
2. **Implement** your changes with clear, focused commits.
3. **Test** by running `bun test` and ensuring all tests pass.
4. **Open a Pull Request** against `main` with a description of what your change does and why.

Keep PRs small and focused on a single concern when possible.

## Code Style

- TypeScript, targeting the Bun runtime.
- Follow the existing conventions in the codebase.
- Run `bun test` before submitting.

## Pro Features

Features gated behind `src/core/pro.ts` are maintained exclusively by Astrolexis. PRs modifying pro-gated functionality will not be accepted.

## Licensing

KCode is licensed under AGPLv3. By submitting a contribution, you agree that your work is licensed under the same terms. See [LICENSE](LICENSE) for details.
