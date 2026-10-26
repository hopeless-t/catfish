import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { webSearch } from "../lib/core";

export const schema = {
  query: z.string().min(1).max(500).describe("Web search query"),
  limit: z.number().int().min(1).max(20).optional().describe("Maximum results, default 8"),
};

export const metadata: ToolMetadata = {
  name: "catfish_search",
  description: "Search the public web with automatic provider fallback. Returns normalized titles and URLs.",
  annotations: { title: "Search the web", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function run({ query, limit }: InferSchema<typeof schema>) {
  const result = await webSearch(query, limit ?? 8);
  return JSON.stringify(result, null, 2);
}
