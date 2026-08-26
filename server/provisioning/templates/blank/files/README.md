# New project

This repo was created empty on purpose. The first Agent Hub build session
implements the product from the description you gave at project creation:

- Chooses language and framework from that description
- Writes the application, tests, and lint config
- Adds a `Dockerfile` / `docker-compose.yml` so the app runs locally in Docker
- Rewrites `.agent-hub/ci.yaml` with the real test and lint commands
- Wires the in-browser preview (`devServer.startCommand`, ports, health)

Do not assume Node or `package.json`. Pick the stack that fits the product.
