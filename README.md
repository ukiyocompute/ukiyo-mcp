# Ukiyo MCP server

Let an AI agent rent a GPU, run commands on it and shut it down, through the [Model Context Protocol](https://modelcontextprotocol.io). Works with Cursor, VS Code and other MCP clients that run local (stdio) servers.

**Current version: 0.2.0** · [Docs](https://docs.u-kiyo.ai/connect/mcp) · [Website](https://u-kiyo.ai) · [Live GPU prices](https://u-kiyo.ai/gpu/)

## 1. Download and verify

Requires [Node.js 22+](https://nodejs.org) and OpenSSH (`ssh`).

```bash
mkdir -p ~/.ukiyo && cd ~/.ukiyo
curl -fsSLO https://u-kiyo.ai/releases/mcp/0.2.0/ukiyo-mcp-0.2.0.mjs
echo "e32c8b638856c16eb8315b9d086c8c39d88f7ac89f1b0cd311bf7a7a18de81a1  ukiyo-mcp-0.2.0.mjs" | shasum -a 256 -c -
```

## 2. Get an API token

Create an account and a scoped agent token with the [Ukiyo CLI](https://github.com/ukiyocompute/ukiyo-cli) (`ukiyo signup --accept-terms 2026-10-10 --json`), then fund it once with `ukiyo topup link --amount 5 --json`. Browsing GPUs and prices needs no token.

## 3. Add it to your editor

**Cursor**: merge into `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ukiyo": {
      "type": "stdio",
      "command": "node",
      "args": ["${userHome}/.ukiyo/ukiyo-mcp-0.2.0.mjs"],
      "env": { "UKIYO_API_TOKEN": "${env:UKIYO_API_TOKEN}" }
    }
  }
}
```

**VS Code**: run **MCP: Open User Configuration** and merge:

```json
{
  "servers": {
    "ukiyo": {
      "type": "stdio",
      "command": "node",
      "args": ["${userHome}/.ukiyo/ukiyo-mcp-0.2.0.mjs"],
      "env": { "UKIYO_API_TOKEN": "${input:ukiyo-api-token}" }
    }
  },
  "inputs": [
    { "id": "ukiyo-api-token", "type": "promptString", "description": "Funded scoped Ukiyo agent token", "password": true }
  ]
}
```

Both keep the token out of the file: Cursor reads it from your environment, VS Code asks for it in a masked prompt. Full setup and troubleshooting: [docs.u-kiyo.ai/connect/mcp](https://docs.u-kiyo.ai/connect/mcp).

## Tools

| Tool | What it does |
| --- | --- |
| `list_offers` | Rentable GPUs and prices (no token needed) |
| `list_gpus` | GPU models and price ranges |
| `get_account` | Balance and key limits |
| `rent_gpu` | Rent an exact offer (`offerId`, `budgetMinor`, `idempotencyKey`) |
| `get_rental` | Rental status; can wait until the GPU is ready |
| `list_deployments` | Your rentals |
| `run_command` | Run a shell command on the GPU over SSH; keys never appear in output |
| `terminate_gpu` | Shut the GPU down and stop billing |

A typical agent run: `list_offers` → `rent_gpu` → `get_rental` (wait for ACTIVE) → `run_command` → `terminate_gpu`.

## Safety

- Use a scoped **agent** token with spending limits, never an owner token, and never paste it into a chat.
- SSH keys are written to a private temporary file and deleted after each command.
- Termination is permanent; copy off any results first.

## Build from source

```bash
npm install
npm test             # 13 tests
npm run release      # writes dist/release/ukiyo-mcp-0.2.0.mjs
```

The bundle you build matches the published file except for the module path labels esbuild writes next to each bundled file. `src/cli/` holds the API client and SSH helper shared with [ukiyo-cli](https://github.com/ukiyocompute/ukiyo-cli).

## Related

- [ukiyo-cli](https://github.com/ukiyocompute/ukiyo-cli) · [ukiyo-skill](https://github.com/ukiyocompute/ukiyo-skill) · [ukiyo-api](https://github.com/ukiyocompute/ukiyo-api) · [ukiyo-guides](https://github.com/ukiyocompute/ukiyo-guides)

## Support and security

**contact@u-kiyo.ai**. Please don't include API keys or private keys in issues.

## License

[MIT](LICENSE) © 2026 Ukiyo Compute LLC. Covers this client software; the Ukiyo service is governed by the [Terms](https://u-kiyo.ai/terms/).
