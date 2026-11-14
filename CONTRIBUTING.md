# Contributing

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <short summary in the imperative>

<optional body: what and why>
```

| Type | Use it for |
|---|---|
| `feat` | a new feature |
| `fix` | a bug fix |
| `update` | an improvement or tweak to an existing feature (not a new feature, not a bug fix) |
| `docs` | documentation only |
| `style` | formatting, whitespace, CSS tidy-ups that don't change behaviour |
| `refactor` | restructuring code without changing behaviour |
| `perf` | performance improvements |
| `test` | adding or fixing tests |
| `build` | build system, Docker, dependencies |
| `ci` | CI configuration and scripts |
| `chore` | maintenance that doesn't touch src or tests |
| `revert` | reverting an earlier commit |

Scopes in use: `backend`, `frontend`. Mark breaking changes with `!` (for example `feat(backend)!: …`) or
add a `BREAKING CHANGE:` footer.

Examples:

```
feat(frontend): add layer opacity slider
fix(backend): handle excellon files with inch units
update(backend): label unclassified layers by their file name
docs: document .env settings
```

## Before pushing

```bash
cd backend && .venv/bin/python -m pytest
cd frontend && npm run build
```
