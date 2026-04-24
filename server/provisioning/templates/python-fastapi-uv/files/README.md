# Python · FastAPI + uv starter

Minimal FastAPI service managed with [uv](https://docs.astral.sh/uv/) for
reproducible, fast dependency resolution.

## Getting started

```bash
uv sync                             # install runtime + dev dependencies
uv run uvicorn app.main:app --reload  # start the dev server on :8000
uv run pytest -q                    # run the test suite
uv run ruff check .                 # lint
```

## Layout

```
app/
  __init__.py
  main.py           FastAPI app with `/` and `/healthz`
tests/
  test_main.py      pytest smoke tests using fastapi.testclient
pyproject.toml      runtime + dev deps + ruff config
```

## Why this stack

- **FastAPI** — modern async-first web framework with first-class OpenAPI
  generation and type-driven validation.
- **uv** — a Rust-backed package manager / runner that replaces pip, venv, and
  tox with one reproducible workflow. `uv sync` gives you a lockfile-backed
  env in seconds.
- **pytest + ruff** — the Python defaults; no surprises.

If you outgrow FastAPI, the handlers are plain Python functions — porting to
Flask, Litestar, or Django is low-risk.
