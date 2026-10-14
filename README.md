# Telegram ↔ Claude Code bridge

`bridge.mjs` (run with Bun) polls a Telegram bot and runs `claude -p --resume <session>` for each chat or topic.
- Each Telegram chat or topic keeps its own Claude session and working folder.
- It streams the reply back, and delivers any `SEND_FILE:` lines as attachments.

| File | Purpose |
|---|---|
| `bridge.mjs` | The bridge. |
| `start-bridge.ps1` | Starts the bridge. |
| `restart-when-idle.ps1` / `apply-when-idle.ps1` | Restart or apply updates once no Claude run is active. |

Not in git, kept local:
- `.env`: `TELEGRAM_BOT_TOKEN=...`
- `mcp.json`: contains the token.
- `access.json`: allowed senders.
- `bridge-state.json`: sessions per chat.
- `inbox/`: received files.
- logs
