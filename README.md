# magpie-notion-ai

An open-source **Magpie / OpenCode** provider plugin that exposes **Personal Notion AI (`notion_ai` — regular chat)** and optional workspace **Custom Agents** as a full OpenAI-compatible API (`http://127.0.0.1:3425/v1`) through the official **Notion Agent APIs** (`Notion-Version: 2026-03-11`).

Use **Claude Opus 5.5**, **Claude Sonnet 5.5**, **Claude Fable 5.2**, **GPT-6.2 Sol**, **GPT-6 Astra**, **Grok 4.7**, **Gemini 3.7 Flash**, and more inside **Claude Code**, **Codex**, **Cline**, **Cursor**, or any OpenAI-compatible client!

## Features

- **100% Official Notion Agent APIs (`2026-03-11`)**: Uses your official Notion Personal Access Token (PAT) with `POST /v1/agents/query`, `PATCH /v1/agents/:id`, `POST /v1/sessions` (SSE streaming), and `POST /v1/file_uploads`.
- **Direct Clean Sessions**: Starts every session directly from your prompt — zero briefing preamble or wasted tokens.
- **34 Live-Verified Models with Dynamic Model Pinning (`PATCH /v1/agents/:id`)**:
  - **Claude:** `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`, `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`
  - **GPT:** `gpt-6.2-sol`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`
  - **SpaceXAI (Grok):** `grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3`, `grok-build-0.1`
  - **Gemini & Auto:** `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `auto`
  - Automatically discovers new Custom Agents and any new models configured in Notion UI on refresh.
- **Full Streaming Tool Calling (`<tool_call>` bridge)**: Works out of the box inside **Claude Code**, **Codex**, and **Cline** for reading/editing files and running commands.
- **Automatic File-Upload Overflow (`POST /v1/file_uploads`)**: Large prompts or tool schemas exceeding Notion's 10,000-character field limit are uploaded automatically via Notion's Direct File Upload API and attached to the session.
- **Resilient SSE Auto-Resume (`continue_from`)**: Automatically resumes interrupted SSE streams from the last committed `event.id` on transient network/VPN drops, plus automatic retries on `429/502/503/504/529`.

---

## Quick Start

### 1. Create a Notion Personal Access Token (PAT)
1. Open **Notion → Settings** and enable **Developer Mode**.
2. Go to **Personal access tokens → New token**.
3. Select your workspace, enable the **Notion API** capability, and copy your token (`ntn_...`).
4. Model calls route directly through your regular Personal Notion AI (`notion_ai`) — no Custom Agent setup required!

### 2. Install & Connect in Magpie

```bash
magpie plugin add https://github.com/AmyraxVPN-Main/magpie-notion-ai
magpie plugin login notion-ai
magpie provider refresh notion-ai
```

> **Tip:** Restart **Magpie** once after signing in so the running gateway reloads the new provider cleanly.

### 3. Use in Claude Code (or any Agent)

```bash
# Example: Run Claude Code on Claude Opus 5.5 via Notion
magpie claude notion-ai/claude-opus-5-5
magpie claude haiku notion-ai/claude-opus-5-5
magpie claude effort medium

# Or switch to any other model anytime:
magpie claude notion-ai/gpt-6.2-sol
magpie claude notion-ai/claude-sonnet-5-5
```

### 4. Expose All 34 Models in Magpie (Optional)
By default Magpie displays the first 24 models of a provider. Expose all remaining models with:

```bash
magpie provider models notion-ai +gpt-5.4-mini +gpt-5.2 +grok-4.7 +grok-4.6 +grok-4.5 +grok-4.3 +grok-build-0.1 +gemini-3.7-flash +gemini-3.6-flash +gemini-3.5-flash
```

---

## Plugin Options (Optional)

```bash
magpie plugin options notion-ai '{"defaultAgentId":"<custom-agent-uuid>","extraModels":["new-model-id"]}'
```

| Option | Description |
| --- | --- |
| `defaultAgentId` | Optional Custom Agent UUID to route model-pinned calls through (defaults to `notion_ai`, your regular Personal Notion AI chat). |
| `extraModels` | Additional Notion public model IDs to include in the Magpie model list. |
| `sessionReuse` | Reuse Notion `session_id` across multi-turn conversations (default: `true`). |
| `sessionTtlMs` | Cached session TTL in milliseconds (default: `86400000` = 24h). |

## Notes on Effort Levels

Per-model effort levels (`low`/`medium`/`high`/`xhigh`/`max`/`ultra`) are surfaced in Magpie and passed as a reasoning-depth hint in `prompt_context`. Notion's official REST API (`2026-03-11`) currently enforces `model` selection (`auto` or `pinned`) server-side and does not yet expose a dedicated server-side `effort` field.

## Testing

```bash
npm test

# Standalone live PAT & SSE diagnostic:
node bin/test-connection.mjs --token ntn_YOUR_TOKEN --raw-sse
```

## License

MIT
