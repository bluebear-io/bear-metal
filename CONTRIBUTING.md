# Contributing to bear-metal

## Before You Start

- For bugs, feature requests, and design discussions, prefer opening a GitHub issue first unless you already have maintainer guidance.
- Keep pull requests scoped to one logical change.
- For sensitive security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development Setup

```bash
git clone https://github.com/bluebear-io/bear-metal
cd bear-metal
npm install
cp .env.example .env   # fill in credentials (see README Setup section)
npm run dev:all        # manager on :3100, UI dev server on :5273
```

Common checks before opening a pull request:

```bash
npm run build   # type-check + compile
npm test        # run tests
```

## Commit Convention

Semantic commits are recommended:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks
- `ci`: CI/CD changes

### Examples

```bash
feat(worker): add GitLab support via personal access tokens

fix(scheduler): handle missing PR ref without crashing

docs: clarify workspace builder dynamic routing example

chore(deps): update pi-coding-agent to 0.75.0
```

### Footers

```bash
# Reference GitHub issues
Refs: #123

# Breaking changes
BREAKING CHANGE: renamed WORKER_CONCURRENCY to MAX_WORKERS

# Co-authored commits
Co-Authored-By: Claude <noreply@anthropic.com>
```

## Development Workflow

1. Create or identify the GitHub issue for the change when appropriate.
2. Create a descriptive branch such as `feat/gitlab-support` or `fix/missing-pr-ref`.
3. Make the smallest change that fully addresses the problem.
4. Add or update tests when behavior changes.
5. Run the relevant checks locally before opening a PR.
6. Open a pull request with context, risk notes, and any follow-up work.

## Pull Requests

- Use a clear title that describes the change.
- Link the related issue when one exists, for example `Closes #123`.
- Include test coverage notes or explain why tests were not added.
- Ensure CI passes before requesting review.
- Address review comments explicitly in follow-up commits or replies.

## Questions?

- Open a GitHub issue for product or implementation questions.
- Open a GitHub Discussion if you want feedback before writing code.
