// Dumps tool input schemas and resources to tangem-schemas.json. Calls no tools.
import { writeFile } from "node:fs/promises";
import { getTangemClient, closeTangemClient } from "./src/tangem.js";

const OUT_FILE = "tangem-schemas.json";
const RESOURCE_URIS = [
  "express+tangem-express://networks",
  "express+tangem-express://providers",
];

async function listAll(fetchPage, key) {
  const items = [];
  let cursor;
  do {
    const page = await fetchPage(cursor ? { cursor } : undefined);
    items.push(...page[key]);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function decodeContents(contents) {
  return contents.map(({ uri, mimeType, text, blob }) => {
    if (text === undefined) return { uri, mimeType, blob };
    try {
      return { uri, mimeType, json: JSON.parse(text) };
    } catch {
      return { uri, mimeType, text };
    }
  });
}

try {
  const client = await getTangemClient();

  const tools = await listAll((p) => client.listTools(p), "tools");
  const resources = await listAll((p) => client.listResources(p), "resources");

  const resourceContents = {};
  for (const uri of RESOURCE_URIS) {
    try {
      const { contents } = await client.readResource({ uri });
      resourceContents[uri] = decodeContents(contents);
    } catch (err) {
      resourceContents[uri] = { error: String(err?.message ?? err) };
    }
  }

  const dump = {
    generatedAt: new Date().toISOString(),
    tools: tools.map(({ name, inputSchema }) => ({ name, inputSchema })),
    resources,
    resourceContents,
  };
  await writeFile(OUT_FILE, JSON.stringify(dump, null, 2) + "\n");
  console.log(`Wrote ${OUT_FILE}: ${tools.length} tools, ${resources.length} resources.`);
} catch (err) {
  console.error("Failed:", err);
  process.exitCode = 1;
} finally {
  await closeTangemClient();
}
