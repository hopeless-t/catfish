import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { safeFetchText } from "../lib/core";

export const schema = {
  url: z.string().url().max(4000).describe("Public http/https URL to read"),
};

export const metadata: ToolMetadata = {
  name: "catfish_fetch",
  description: "Read a public URL as compact agent-friendly text. Private and local network targets are rejected.",
  annotations: { title: "Read a URL", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function run({ url }: InferSchema<typeof schema>) {
  const r = await safeFetchText(url);
  return JSON.stringify({ ok: r.status >= 200 && r.status < 400, ...r }, null, 2);
}
