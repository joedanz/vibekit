// Slim core export with dynamic imports
export { VibeKit } from "./core/vibekit";

// Essential type exports only
export type {
  AgentType,
  AgentMode,
  ModelProvider,
  SandboxProvider,
  SandboxInstance,
  TelemetryConfig,
  Conversation,
} from "./types";

// Telemetry storage types
export type {
  LocalStoreConfig,
  TelemetryRecord,
  TelemetryQueryFilter,
  TelemetryStats,
  TelemetryDBError,
  TelemetryDBInitError,
  TelemetryDBQueryError,
} from "./types/telemetry-storage";

// Optional exports with dynamic imports
export const createClaudeAgent = async () => {
  const { ClaudeAgent } = await import("./agents/claude");
  return ClaudeAgent;
};

export const createCodexAgent = async () => {
  const { CodexAgent } = await import("./agents/codex");
  return CodexAgent;
};

export const createOpenCodeAgent = async () => {
  const { OpenCodeAgent } = await import("./agents/opencode");
  return OpenCodeAgent;
};

export const createGeminiAgent = async () => {
  const { GeminiAgent } = await import("./agents/gemini");
  return GeminiAgent;
};

export const createTelemetryService = async () => {
  const { TelemetryService } = await import("./services/telemetry");
  return TelemetryService;
};

// Authentication is handled separately via @vibe-kit/auth package
// Users should get tokens from auth package and pass them as API keys

// Type-only exports for advanced usage
export type { ClaudeConfig, ClaudeResponse } from "./types";
export type { CodexConfig, CodexResponse } from "./types";
export type { OpenCodeConfig, OpenCodeResponse } from "./types";
export type { GeminiConfig } from "./types";
export type { TelemetryData } from "./services/telemetry";
export type { BaseAgentConfig, PullRequestResult } from "./agents/base";
