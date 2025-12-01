# Local Testing/Linting Commands

## Python SDK
```bash
cd python
ruff check .
ruff format --check .
uv run pytest
```

## TypeScript SDK
```bash
cd typescript
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run build
```

## GitHub Actions (act)
```bash
# All jobs
act push

# Specific jobs
act push -j py-style
act push -j py-test
act push -j ts-style
act push -j ts-test

# Matrix builds (single version)
act push -j py-test --matrix python-version:3.13
act push -j ts-test --matrix node-version:20
```

## Pre-commit
```bash
pre-commit run --all-files
```
