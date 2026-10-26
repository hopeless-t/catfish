import { type XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  http: true,
  paths: {
    tools: "./src/tools",
    prompts: false,
    resources: false,
  },
  template: {
    name: "CATFISH Public",
    description: "Read-only web search and fetch for agents, with provider fallback and SSRF protection.",
    instructions: "Use catfish_search to discover public URLs and catfish_fetch to read them. Browser sessions, profiles, eval, and CDP are intentionally local-only.",
    homePage: "https://github.com/hopeless-t/catfish",
    icons: [{ src: "./xmcp.svg" }],
  },
};

export default config;
