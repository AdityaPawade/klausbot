# klausbot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Screenshot placeholder - klausbot Telegram interaction]

## Why I Built It

<!--
USER: Fill in your personal narrative here.
- What problem were you trying to solve?
- What's your background/journey?
- What vision does klausbot represent?
-->

[Personal narrative to be added]

## What It Does

klausbot is a Telegram gateway that connects you to Claude, Anthropic's AI assistant, through a persistent conversational interface. It runs 24/7 on your own infrastructure, giving you a private AI assistant that never forgets your context and learns from every interaction.

Unlike web-based chat interfaces that reset with each session, klausbot maintains continuous memory of your conversations. It stores transcripts, learns your preferences, and can recall relevant context from past discussions. This creates a truly personal assistant that grows more helpful over time.

The bot integrates with Claude's MCP (Model Context Protocol) tools, enabling capabilities beyond simple chat:

- **24/7 Claude-powered Telegram assistant** - Send messages anytime, get thoughtful responses from Claude
- **Persistent memory** - Conversations are stored and searchable; Claude can recall what you discussed weeks ago
- **Scheduled tasks** - Create reminders and recurring tasks using natural language ("remind me every Monday at 9am to review expenses")
- **Voice transcription** - Send voice messages; klausbot transcribes and processes them automatically
- **Semantic search** - Find past conversations by meaning, not just keywords (requires OpenAI API key)

## Installation

### Prerequisites

- **Node.js 20+** - JavaScript runtime
- **Telegram bot token** - Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
- **Claude CLI** - Install and authenticate: `npm install -g @anthropic-ai/claude-code`

### Quick Start

```bash
npm install -g klausbot
klausbot setup
```

The setup wizard guides you through:
1. Configuring your Telegram bot token
2. Initializing the data directory (~/.klausbot/)
3. Installing the background service (launchd on macOS, systemd on Linux)

### Pairing Your Telegram Account

After installation, you need to pair your Telegram account with klausbot:

1. Open Telegram and find your bot (search for the username you created with @BotFather)
2. Send `/start` to the bot
3. The bot displays a 6-character pairing code
4. On your server, approve the pairing:
   ```bash
   klausbot pairing approve XXXXXX
   ```
5. You're connected! Send any message to start chatting with Claude.

Only approved users can interact with the bot, keeping your instance private.

### Docker (Coming Soon)

Docker support is planned for a future release. For now, use the native installation above.

## Usage

### CLI Commands

| Command | Description |
|---------|-------------|
| `klausbot setup` | First-time setup wizard |
| `klausbot daemon` | Start the gateway daemon |
| `klausbot status` | Check service and config status |
| `klausbot restart` | Restart background service |
| `klausbot uninstall` | Remove background service |
| `klausbot init` | Reset ~/.klausbot/ directory |
| `klausbot cron [action] [id]` | Manage scheduled jobs (list/enable/disable/delete) |
| `klausbot config validate` | Validate environment and config |
| `klausbot pairing list` | List pending/approved users |
| `klausbot pairing approve <code>` | Approve pairing request |
| `klausbot pairing reject <code>` | Reject pairing request |
| `klausbot pairing revoke <chatId>` | Revoke user access |

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Request pairing or check status |
| `/status` | Show queue and approval status |
| `/model` | Show current model info |
| `/crons` | List scheduled tasks |
| `/help` | Show available commands |

## Configuration

### Environment Variables

Environment variables are loaded from `~/.klausbot/.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token from @BotFather |
| `OPENAI_API_KEY` | No | - | OpenAI API key for semantic memory search |
| `LOG_LEVEL` | No | `info` | Log level (silent/trace/debug/info/warn/error/fatal) |

Copy `.env.example` to get started:

```bash
cp .env.example ~/.klausbot/.env
# Edit ~/.klausbot/.env with your values
```

### JSON Configuration

Optional configuration in `~/.klausbot/config/klausbot.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `model` | `claude-sonnet-4-20250514` | AI model for responses |
| `logVerbosity` | `normal` | Logging detail (minimal/normal/verbose) |
| `preferences.timezone` | - | Timezone for date/time formatting |
| `preferences.language` | `en` | Preferred language code |

Example:

```json
{
  "model": "claude-sonnet-4-20250514",
  "logVerbosity": "normal",
  "preferences": {
    "timezone": "America/New_York",
    "language": "en"
  }
}
```

## Troubleshooting

### Bot not responding?

1. Check service status:
   ```bash
   klausbot status
   ```

2. Verify your bot token format: `123456789:ABC-DEF...`

3. Make sure the bot is running:
   - macOS: `launchctl list | grep klausbot`
   - Linux: `systemctl --user status klausbot`

4. Check logs via `klausbot status` for detailed diagnostics.

### Memory search not working?

Semantic memory search requires an OpenAI API key for embeddings.

1. Check if configured:
   ```bash
   klausbot status
   ```
   Look for "OpenAI API Key: configured"

2. If not configured, add to `~/.klausbot/.env`:
   ```bash
   OPENAI_API_KEY=sk-your-key-here
   ```

3. Restart the service:
   ```bash
   klausbot restart
   ```

### How do I restart after config changes?

```bash
klausbot restart
```

### Where are logs?

Run `klausbot status` for diagnostics including log locations and recent errors.

### Pairing code not working?

1. Ensure you're using the exact code displayed (case-insensitive)
2. Codes expire after 15 minutes; send `/start` again to get a new one
3. Check pending requests:
   ```bash
   klausbot pairing list
   ```

### Claude CLI not authenticated?

klausbot requires an authenticated Claude CLI installation:

1. Install Claude CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. Authenticate:
   ```bash
   claude auth login
   ```

3. Verify authentication:
   ```bash
   klausbot status
   ```
   Look for "Claude CLI: authenticated"

### Need more help?

Open an issue on [GitHub Issues](https://github.com/klausbot/klausbot/issues).

## License

MIT - see [LICENSE](LICENSE)

