"""Minimal FastAPI entrypoint.

Run locally with:
    uv run uvicorn app.main:app --reload
"""

from fastapi import FastAPI

app = FastAPI(title="Starter API", version="0.0.1")


@app.get("/")
def read_root() -> dict[str, str]:
    """Root handler — returns a friendly hello payload."""
    return {"message": "Hello, world!"}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe — always returns ok."""
    return {"status": "ok"}
