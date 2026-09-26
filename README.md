# Setup

From the repo root, run `npm install` once.

Set these environment variables before starting the server or app:

| Variable              | Used by | Purpose                                                       |
| --------------------- | ------- | ------------------------------------------------------------- |
| `ADE_COMPANION_HOST`  | Server  | Listen address; defaults to `127.0.0.1` (this computer only). |
| `ADE_COMPANION_PORT`  | Server  | Port; defaults to `4317`.                                     |
| `ADE_COMPANION_URL`   | App     | Startup address; defaults to `ws://127.0.0.1:4317/companion`. |
| `ADE_COMPANION_TOKEN` | Both    | Optional shared secret; use the same value on both sides.     |

For a remote server, use the `wss://` address and token supplied by its operator.

# Server

Run `npm run server`.

# App

Run `npm run dev`.

The app connects to `ADE_COMPANION_URL` on startup and retries after failures or disconnects.
Select **Reconnect** to force a new connection.
