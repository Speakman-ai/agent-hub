"""Smoke tests for the starter FastAPI app."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_root_returns_hello() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Hello, world!"}


def test_healthz_returns_ok() -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
