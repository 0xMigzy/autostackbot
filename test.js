import { getTangemClient, closeTangemClient } from "./tangem.js";

try {
  console.log("Connecting to Tangem MCP (approve the login in your Tangem app)...");
  const client = await getTangemClient();

  const { tools } = await client.listTools();
  console.log(`\n${tools.length} tools:`);
  for (const tool of tools) console.log(`  - ${tool.name}`);

  console.log("\nwallets__get_tokens:");
  const result = await client.callTool({ name: "wallets__get_tokens", arguments: {} });
  if (result.isError) process.exitCode = 1;
  if (result.structuredContent) {
    console.log(JSON.stringify(result.structuredContent, null, 2));
  } else {
    for (const part of result.content ?? []) {
      console.log(part.type === "text" ? part.text : JSON.stringify(part, null, 2));
    }
  }
} catch (err) {
  console.error("Failed:", err);
  process.exitCode = 1;
} finally {
  await closeTangemClient();
}
