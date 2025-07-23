import { describe, it, expect, vi } from "vitest";
import dotenv from "dotenv";

import { VibeKit } from "../packages/vibekit/src/index.js";
import { createE2BProvider } from "../packages/e2b/dist/index.js";

dotenv.config();

describe("VibeKit SDK", () => {
  it("should create working directory", async () => {
    const dir = "/var/vibe0";

    const e2bProvider = createE2BProvider({
      apiKey: process.env.E2B_API_KEY!,
      templateId: "vibekit-claude",
    });

    const vibeKit = new VibeKit()
      .withAgent({
        type: "claude",
        provider: "anthropic",
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: "claude-sonnet-4-20250514",
      })
      .withSandbox(e2bProvider)
      .withWorkingDirectory(dir);

    const result = await vibeKit.executeCommand("pwd");

    const pwd = result.stdout.trim();

    await vibeKit.kill();

    expect(pwd).toBe(dir);
  }, 60000);

  it("should download repository", async () => {
    const dir = "/var/vibe0";

    const e2bProvider = createE2BProvider({
      apiKey: process.env.E2B_API_KEY!,
      templateId: "vibekit-claude",
    });

    const vibeKit = new VibeKit()
      .withAgent({
        type: "claude",
        provider: "anthropic",
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: "claude-sonnet-4-20250514",
      })
      .withSandbox(e2bProvider)
      .withGithub({
        token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN!,
        repository: process.env.GH_REPOSITORY || "superagent-ai/signals",
      })
      .withWorkingDirectory(dir);

    let codeGenerationSuccessful = false;
    const receivedEvents: any[] = [];

    vibeKit.on("update", (data) => {
      try {
        const parsedData = JSON.parse(data);
        receivedEvents.push(parsedData);
        
        // Check for successful code generation completion
        if (parsedData.type === "result" && parsedData.subtype === "success") {
          codeGenerationSuccessful = true;
        }
      } catch (error) {
        // Handle malformed JSON in end events
        if (data.includes('"type": "end"')) {
          receivedEvents.push({ type: 'end', parsed: false });
        }
      }
    });

    // Test that the VibeKit instance with GitHub configuration can generate code
    const result = await vibeKit.generateCode({ prompt: "Hi there" });

    await vibeKit.kill();

    // Verify that code generation was successful with GitHub configuration
    expect(codeGenerationSuccessful).toBe(true);
    expect(result).toBeTruthy();
    expect(receivedEvents.some(e => e.type === 'result')).toBe(true);
  }, 60000);
  it("should set env variables", async () => {
    const e2bProvider = createE2BProvider({
      apiKey: process.env.E2B_API_KEY!,
      templateId: "vibekit-claude",
    });

    const vibeKit = new VibeKit()
      .withAgent({
        type: "claude",
        provider: "anthropic",
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: "claude-sonnet-4-20250514",
      })
      .withSandbox(e2bProvider)
      .withGithub({
        token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN!,
        repository: process.env.GH_REPOSITORY || "superagent-ai/signals",
      })
      .withSecrets({ MY_SECRET: "test" });

    const output = await vibeKit.executeCommand("echo $MY_SECRET");
    const secret = output.stdout.trim();

    expect(secret).toBe("test");
  }, 60000);
});
