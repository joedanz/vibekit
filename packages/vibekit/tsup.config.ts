import { defineConfig } from "tsup";

export default defineConfig({
  // Main package and agents (with TypeScript declarations)
  entry: {
    index: "src/index.ts",
    "agents/base": "src/agents/base.ts",
    "agents/claude": "src/agents/claude.ts",
    "agents/codex": "src/agents/codex.ts",
    "agents/gemini": "src/agents/gemini.ts",
    "agents/grok": "src/agents/grok.ts",
    "agents/opencode": "src/agents/opencode.ts",
    "agents/utils": "src/agents/utils.ts",
    "services/index": "src/services/index.ts",
    "registry/index": "src/registry/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  outDir: "dist",
  esbuildOptions(options) {
    // Suppress the direct-eval warning from dependencies
    options.logOverride = {
      "direct-eval": "silent",
    };
  },
  external: [
    // Mark telemetry as external to avoid bundling and warnings
    "@vibe-kit/telemetry",
    "@vibe-kit/db",
  ],
});
