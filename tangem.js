import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Connect waits for the OAuth login, which needs a QR scan in the Tangem app.
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

let connecting = null;

/** Returns the shared, connected Tangem MCP client (connects on first call). */
export function getTangemClient() {
  if (!connecting) {
    const attempt = connect().then(
      (client) => {
        // Reconnect on the next call if mcp-remote exits.
        client.onclose = () => {
          if (connecting === attempt) connecting = null;
        };
        return client;
      },
      (err) => {
        if (connecting === attempt) connecting = null;
        throw err;
      },
    );
    connecting = attempt;
  }
  return connecting;
}

export async function closeTangemClient() {
  if (!connecting) return;
  const client = await connecting.catch(() => null);
  connecting = null;
  await client?.close();
}

async function connect() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: [
      "-y",
      "mcp-remote@latest",
      "https://mcp.tangem.org/mcp",
      "--client-metadata-url",
      "https://opencode.ai/oauth/opencode/client.json",
      "--callback-path",
      "/callback",
      "--authorize-param",
      "scope=",
      "--transport",
      "http-only",
    ],
    stderr: "inherit",
  });
  const client = new Client({ name: "auto-stack", version: "1.0.0" });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return client;
}
