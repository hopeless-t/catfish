import { type ToolMetadata } from "xmcp";

export const schema = {};
export const metadata: ToolMetadata = {
  name: "catfish_about",
  description: "Describe CATFISH Public, its safety boundary, and current capabilities.",
  annotations: { title: "About CATFISH", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};
export default function run() {
  return JSON.stringify({
    name: "CATFISH Public",
    version: "0.1.0",
    capabilities: ["web search", "public URL fetch"],
    safety: ["rejects private/local network targets", "response size limits", "manual redirect validation"],
    localEdition: "CATFISH Local additionally supports browser sessions, persistent profiles, eval, and local CDP; those powers are intentionally not exposed by the public service."
  }, null, 2);
}
