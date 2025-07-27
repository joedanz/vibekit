/**
 * VibeKit Dagger Local Sandbox Provider
 *
 * Implements the same interface as E2B and Daytona providers but uses Dagger
 * for local containerized development environments with ARM64 agent images.
 */

import { connect } from "@dagger.io/dagger";
import type { Client, Container, Directory } from "@dagger.io/dagger";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { EventEmitter } from "events";

const execAsync = promisify(exec);

// Environment interface for provider methods
interface Environment {
  id: string;
  name: string;
  status: "running" | "stopped" | "pending" | "error";
  agentType?: string;
  createdAt?: Date;
  lastUsed?: Date;
  branch?: string;
  environment?: {
    VIBEKIT_AGENT_TYPE?: string;
    AGENT_TYPE?: string;
    [key: string]: string | undefined;
  };
}

// Interface definitions matching E2B/Northflank patterns
export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxCommandOptions {
  timeoutMs?: number;
  background?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

export interface SandboxCommands {
  run(
    command: string,
    options?: SandboxCommandOptions
  ): Promise<SandboxExecutionResult>;
}

export interface SandboxInstance {
  sandboxId: string;
  commands: SandboxCommands;
  kill(): Promise<void>;
  pause(): Promise<void>;
  getHost(port: number): Promise<string>;
  // EventEmitter methods for VibeKit streaming compatibility
  on(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

export interface SandboxProvider {
  create(
    envs?: Record<string, string>,
    agentType?: "codex" | "claude" | "opencode" | "gemini" | "grok",
    workingDirectory?: string
  ): Promise<SandboxInstance>;
  resume(sandboxId: string): Promise<SandboxInstance>;
}

export type AgentType = "codex" | "claude" | "opencode" | "gemini" | "grok";

export interface LocalConfig {
  preferRegistryImages?: boolean; // If true, use registry images instead of building from Dockerfiles
  dockerHubUser?: string; // User's Docker Hub username for custom images
  pushImages?: boolean; // Whether to push images during setup
  privateRegistry?: string; // Alternative registry (ghcr.io, etc.)
  autoInstall?: boolean; // Whether to automatically install Dagger CLI if not found
}



// Helper function to get Dockerfile path based on agent type
const getDockerfilePathFromAgentType = (
  agentType?: AgentType
): string | undefined => {
  if (agentType === "claude") {
    return "assets/dockerfiles/Dockerfile.claude";
  } else if (agentType === "codex") {
    return "assets/dockerfiles/Dockerfile.codex";
  } else if (agentType === "opencode") {
    return "assets/dockerfiles/Dockerfile.opencode";
  } else if (agentType === "gemini") {
    return "assets/dockerfiles/Dockerfile.gemini";
  } else if (agentType === "grok") {
    return "assets/dockerfiles/Dockerfile.grok";
  }
  return undefined; // fallback to base image
};

// Helper to get registry image name (configurable version for future use)
const getConfigurableRegistryImage = (
  agentType?: AgentType,
  config?: LocalConfig
): string => {
  const registry = config?.privateRegistry || "docker.io";
  const user = config?.dockerHubUser || "superagent-ai"; // fallback to project default

  switch (agentType) {
    case "claude":
      return `${
        registry === "docker.io" ? "" : `${registry}/`
      }${user}/vibekit-claude:latest`;
    case "codex":
      return `${
        registry === "docker.io" ? "" : `${registry}/`
      }${user}/vibekit-codex:latest`;
    case "gemini":
      return `${
        registry === "docker.io" ? "" : `${registry}/`
      }${user}/vibekit-gemini:latest`;
    case "opencode":
      return `${
        registry === "docker.io" ? "" : `${registry}/`
      }${user}/vibekit-opencode:latest`;
    case "grok":
      return `${
        registry === "docker.io" ? "" : `${registry}/`
      }${user}/vibekit-grok-cli:latest`;
    default:
      return "ubuntu:24.04"; // fallback for unknown agent types
  }
};

// Helper to get registry image name (current implementation with user config support)
const getRegistryImage = async (agentType?: AgentType): Promise<string> => {
  // Check if user has configured their own images
  try {
    const config = await getVibeKitConfig();
    if (agentType && config.registryImages?.[agentType]) {
      return config.registryImages[agentType]!;
    }
  } catch {
    // Fall back to default if config reading fails
  }

  // Default fallback to superagent-ai
  const baseRegistry = "superagent-ai";
  switch (agentType) {
    case "claude":
      return `${baseRegistry}/vibekit-claude:latest`;
    case "codex":
      return `${baseRegistry}/vibekit-codex:latest`;
    case "gemini":
      return `${baseRegistry}/vibekit-gemini:latest`;
    case "opencode":
      return `${baseRegistry}/vibekit-opencode:latest`;
    case "grok":
      return `${baseRegistry}/vibekit-grok-cli:latest`;
    default:
      return "ubuntu:24.04"; // fallback for unknown agent types
  }
};

// Helper to get tagged image name (for local builds only)
const getImageTag = (agentType?: AgentType): string => {
  return `vibekit-${agentType || "default"}:latest`;
};

// Local Dagger implementation with proper workspace state persistence and VibeKit streaming compatibility
class LocalSandboxInstance extends EventEmitter implements SandboxInstance {
  private isRunning = true;
  private workspaceDirectory: Directory | null = null;
  private baseContainer: Container | null = null;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    public sandboxId: string,
    private image: string, // Fallback image if no Dockerfile
    private envs?: Record<string, string>,
    private workDir?: string,
    private dockerfilePath?: string, // Path to Dockerfile if building from source
    private agentType?: AgentType
  ) {
    super(); // Call EventEmitter constructor
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeBaseContainer();
    }
    await this.initializationPromise;
  }

  private async initializeBaseContainer(): Promise<void> {
    await connect(async (client) => {
      // Create the base container once and store it for reuse
      this.baseContainer = await this.createBaseContainer(
        client,
        this.dockerfilePath,
        this.agentType
      );
    });
  }

  get commands(): SandboxCommands {
    return {
      run: async (
        command: string,
        options?: SandboxCommandOptions
      ): Promise<SandboxExecutionResult> => {
        await this.ensureInitialized();

        // Emit start event for VibeKit streaming compatibility
        this.emit(
          "update",
          JSON.stringify({
            type: "start",
            command: command,
            timestamp: Date.now(),
          })
        );

        let result: SandboxExecutionResult = {
          exitCode: 1,
          stdout: "",
          stderr: "Command execution failed",
        };

        try {
          await connect(async (client) => {
            try {
              // Get or create persistent workspace container using our reusable base
              let container = await this.getWorkspaceContainer(client);

              if (options?.background) {
                // Background execution: start and detach
                container = container.withExec(["sh", "-c", command], {
                  experimentalPrivilegedNesting: true,
                });

                // CRITICAL: Export the workspace directory to capture any changes
                this.workspaceDirectory = container.directory(
                  this.workDir || "/vibe0"
                );

                result = {
                  exitCode: 0,
                  stdout: `Background process started: ${command}`,
                  stderr: "",
                };
              } else {
                // Foreground execution with output
                container = container.withExec(["sh", "-c", command]);

                // CRITICAL: Export the workspace directory to capture filesystem changes
                this.workspaceDirectory = container.directory(
                  this.workDir || "/vibe0"
                );

                try {
                  // Execute the command and get output
                  const stdout = await container.stdout();
                  const stderr = await container.stderr();

                  // Simulate incremental streaming by splitting into lines and emitting with delays
                  const emitIncremental = async (
                    type: "stdout" | "stderr",
                    fullOutput: string,
                    callback?: (data: string) => void
                  ) => {
                    const lines = fullOutput
                      .split("\n")
                      .filter((line) => line.trim());
                    for (const [index, line] of lines.entries()) {
                      await new Promise((resolve) =>
                        setTimeout(resolve, 100 + index * 50)
                      ); // Progressive delay
                      const message = line; // Simple string as per docs
                      this.emit(
                        type === "stdout" ? "update" : "error",
                        message
                      );
                      if (callback) callback(line);
                    }
                  };

                  // Handle stdout
                  if (stdout) {
                    await emitIncremental("stdout", stdout, options?.onStdout);
                  }

                  // Handle stderr (non-fatal: route to 'update' with flag)
                  if (stderr) {
                    await emitIncremental("stderr", stderr, options?.onStderr);
                    this.emit("update", `STDERR: ${stderr}`); // Docs-compatible update
                  }

                  result = {
                    exitCode: 0,
                    stdout: stdout,
                    stderr: stderr,
                  };
                } catch (execError) {
                  // Fatal error: emit 'error' as per docs
                  const errorMessage =
                    execError instanceof Error
                      ? execError.message
                      : String(execError);
                  this.emit("error", errorMessage);
                  // If the container execution failed, extract exit code and return proper result
                  const exitCode = errorMessage.includes("exit code")
                    ? parseInt(
                        errorMessage.match(/exit code (\d+)/)?.[1] || "1"
                      )
                    : 1;

                  // Return error result instead of throwing for better test compatibility
                  result = {
                    exitCode: exitCode,
                    stdout: "",
                    stderr: errorMessage,
                  };
                }
              }
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const exitCode = errorMessage.includes("exit code")
                ? parseInt(errorMessage.match(/exit code (\d+)/)?.[1] || "1")
                : 1;

              // Emit error event for VibeKit compatibility
              this.emit("error", errorMessage);

              result = {
                exitCode: exitCode,
                stdout: "",
                stderr: errorMessage,
              };
            }
          });
        } catch (connectError) {
          // Handle errors from the connect function itself
          const errorMessage =
            connectError instanceof Error
              ? connectError.message
              : String(connectError);
          const exitCode = errorMessage.includes("exit code")
            ? parseInt(errorMessage.match(/exit code (\d+)/)?.[1] || "1")
            : 1;

          // Emit error event for VibeKit compatibility
          this.emit("error", errorMessage);

          result = {
            exitCode: exitCode,
            stdout: "",
            stderr: errorMessage,
          };
        }

        // Emit end event for VibeKit streaming compatibility
        this.emit(
          "update",
          JSON.stringify({
            type: "end",
            command: command,
            exitCode: result.exitCode,
            timestamp: Date.now(),
          })
        );

        return result;
      },
    };
  }

  /**
   * Get or create a persistent workspace container that maintains state across commands
   * This is the key method that makes our implementation work like E2B/Northflank
   */
  private async getWorkspaceContainer(client: Client): Promise<Container> {
    if (!this.baseContainer) {
      throw new Error("Base container not initialized");
    }

    // Start with our cached base container but create a new instance for this session
    let container = this.baseContainer;

    // If we have a saved workspace directory, restore it using withDirectory (copies content)
    if (this.workspaceDirectory) {
      container = container.withDirectory(
        this.workDir || "/vibe0",
        this.workspaceDirectory
      );
    } else {
      // First time: ensure working directory exists
      container = container.withExec(["mkdir", "-p", this.workDir || "/vibe0"]);
    }

    // Ensure we're in the working directory
    container = container.withWorkdir(this.workDir || "/vibe0");

    return container;
  }

  private async createBaseContainer(
    client: Client,
    dockerfilePath?: string,
    agentType?: AgentType
  ): Promise<Container> {
    let container: Container;

    try {
      // Priority 1: Always try public registry image first for agent types (fastest)
      const registryImage = await getRegistryImage(agentType);
      if (agentType && registryImage !== "ubuntu:24.04") {
        console.log(`🚀 Trying public registry image: ${registryImage}`);
        try {
          container = client.container().from(registryImage);
          console.log(`✅ Successfully loaded ${registryImage} from registry`);
          // If we get here, registry worked - skip Dockerfile build
        } catch (registryError) {
          console.log(
            `⚠️ Registry failed, falling back to Dockerfile: ${
              registryError instanceof Error
                ? registryError.message
                : String(registryError)
            }`
          );
          throw registryError; // This will trigger the catch block below
        }
      } else if (dockerfilePath) {
        // Priority 2: Build from Dockerfile (slower fallback)
        console.log(`🏗️ Building from Dockerfile: ${dockerfilePath}`);
        const context = client.host().directory(".");
        container = client
          .container()
          .build(context, { dockerfile: dockerfilePath });

        const imageTag = getImageTag(agentType);
        // Export to local Docker daemon for future use
        try {
          await container.export(imageTag);
          console.log(
            `✅ Image ${imageTag} built and exported to local Docker`
          );
        } catch (exportError) {
          console.log(
            `Note: Could not export ${imageTag} to local Docker: ${
              exportError instanceof Error
                ? exportError.message
                : String(exportError)
            }`
          );
        }
      } else {
        // Priority 3: Use fallback base image
        console.log(`🔄 Using fallback base image: ${this.image}`);
        container = client.container().from(this.image);
      }
    } catch (error) {
      console.error(
        `❌ Error with primary image strategy: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      // Fallback chain: try Dockerfile -> base image
      if (dockerfilePath) {
        try {
          console.log(`🔄 Falling back to Dockerfile build: ${dockerfilePath}`);
          const context = client.host().directory(".");
          container = client
            .container()
            .build(context, { dockerfile: dockerfilePath });
        } catch (dockerfileError) {
          console.error(
            `❌ Dockerfile build failed: ${
              dockerfileError instanceof Error
                ? dockerfileError.message
                : String(dockerfileError)
            }`
          );
          console.log(`🔄 Using final fallback: ${this.image}`);
          container = client.container().from(this.image);
        }
      } else {
        console.log(`🔄 Using fallback base image: ${this.image}`);
        container = client.container().from(this.image);
      }
    }

    // Add environment variables
    if (this.envs) {
      for (const [key, value] of Object.entries(this.envs)) {
        container = container.withEnvVariable(key, value);
      }
    }

    return container;
  }

  // File operations for git workflow
  async readFile(path: string): Promise<string> {
    await this.ensureInitialized();

    let content = "";
    await connect(async (client) => {
      if (!this.baseContainer) {
        throw new Error("Base container not initialized");
      }

      const container = await this.getWorkspaceContainer(client);
      content = await container.file(path).contents();
    });
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureInitialized();

    await connect(async (client) => {
      if (!this.baseContainer) {
        throw new Error("Base container not initialized");
      }

      let container = await this.getWorkspaceContainer(client);
      container = container.withNewFile(path, content);
      // CRITICAL: Export the workspace directory to persist the file write
      this.workspaceDirectory = container.directory(this.workDir || "/vibe0");
    });
  }

  async kill(): Promise<void> {
    this.isRunning = false;
    this.workspaceDirectory = null;
    this.baseContainer = null;

    // Close the Dagger connection
    // No explicit action needed here as the connection is managed by the shared connect
  }

  async pause(): Promise<void> {
    // Not applicable for Dagger containers
  }

  async getHost(port: number): Promise<string> {
    return Promise.resolve("localhost"); // Local containers run on localhost
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  constructor(private config: LocalConfig = {}) {}

  async create(
    envs?: Record<string, string>,
    agentType?: AgentType,
    workingDirectory?: string
  ): Promise<SandboxInstance> {
    const sandboxId = `dagger-${agentType || "default"}-${Date.now().toString(
      36
    )}`;
    const workDir = workingDirectory || "/vibe0";

    // Get Dockerfile path for the agent type (only if not preferring registry images)
    const dockerfilePath = this.config.preferRegistryImages
      ? undefined
      : getDockerfilePathFromAgentType(agentType);

    // Create sandbox instance with Dockerfile if available and not preferring registry, otherwise use registry/base image
    const instance = new LocalSandboxInstance(
      sandboxId,
      "ubuntu:24.04", // fallback image
      envs,
      workDir,
      dockerfilePath,
      agentType
    );

    return instance;
  }

  async resume(sandboxId: string): Promise<SandboxInstance> {
    // For Dagger, resume is the same as create since containers are ephemeral
    // The workspace state is maintained through the Directory persistence
    return await this.create();
  }

  async listEnvironments(): Promise<Environment[]> {
    // For Dagger-based local provider, we don't maintain persistent environments
    // Return empty array as environments are created on-demand
    return [];
  }
}

export function createLocalProvider(
  config: LocalConfig = {}
): LocalSandboxProvider {
  return new LocalSandboxProvider(config);
}

/**
 * Pre-cache all agent images for faster startup times
 * This function pulls public registry images to local cache and/or builds from Dockerfiles as fallback
 */
export async function prebuildAgentImages(): Promise<{
  success: boolean;
  results: Array<{
    agentType: AgentType;
    success: boolean;
    error?: string;
    source: "registry" | "dockerfile" | "cached";
  }>;
}> {
  const agentTypes: AgentType[] = [
    "claude",
    "codex",
    "opencode",
    "gemini",
    "grok",
  ];
  const results: Array<{
    agentType: AgentType;
    success: boolean;
    error?: string;
    source: "registry" | "dockerfile" | "cached";
  }> = [];

  console.log("🚀 Pre-caching agent images for faster future startup...");
  console.log("📋 Priority: Registry images → Dockerfile builds → Skip");

  for (const agentType of agentTypes) {
    const registryImage = await getRegistryImage(agentType);
    const imageTag = getImageTag(agentType);
    const dockerfilePath = getDockerfilePathFromAgentType(agentType);

    try {
      console.log(`⏳ Processing ${agentType} agent...`);

      // Check if registry image is already cached locally
      const { stdout } = await execAsync(`docker images -q ${registryImage}`);
      if (stdout.trim()) {
        console.log(`✅ ${registryImage} already cached locally`);
        results.push({ agentType, success: true, source: "cached" });
        continue;
      }

      // Try to pull from public registry first (fastest)
      if (registryImage !== "ubuntu:24.04") {
        try {
          console.log(`📥 Pulling ${registryImage} from registry...`);
          await execAsync(`docker pull ${registryImage}`);
          console.log(`✅ ${registryImage} pulled successfully from registry`);
          results.push({ agentType, success: true, source: "registry" });
          continue;
        } catch (pullError) {
          console.log(
            `⚠️ Failed to pull ${registryImage}, trying Dockerfile build...`
          );
        }
      }

      // Fallback: Build from Dockerfile using Dagger
      if (dockerfilePath) {
        console.log(`🏗️ Building ${imageTag} from Dockerfile...`);
        await connect(async (client) => {
          const context = client.host().directory(".");
          const container = client
            .container()
            .build(context, { dockerfile: dockerfilePath });

          // Export to local Docker daemon
          await container.export(imageTag);
        });

        console.log(`✅ ${imageTag} built and cached successfully`);
        results.push({ agentType, success: true, source: "dockerfile" });
      } else {
        console.log(
          `⚠️ No registry image or Dockerfile found for ${agentType}, skipping`
        );
        results.push({
          agentType,
          success: false,
          error: "No image source available",
          source: "dockerfile",
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `❌ Failed to cache image for ${agentType}: ${errorMessage}`
      );
      results.push({
        agentType,
        success: false,
        error: errorMessage,
        source: "dockerfile",
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const registryCount = results.filter(
    (r) => r.success && r.source === "registry"
  ).length;
  const dockerfileCount = results.filter(
    (r) => r.success && r.source === "dockerfile"
  ).length;
  const cachedCount = results.filter(
    (r) => r.success && r.source === "cached"
  ).length;

  console.log(
    `🎯 Pre-cache complete: ${successCount}/${agentTypes.length} images ready`
  );
  console.log(
    `📊 Sources: ${registryCount} registry, ${dockerfileCount} dockerfile, ${cachedCount} cached`
  );

  return {
    success: successCount > 0,
    results,
  };
}

// Docker login and configuration utilities
export interface DockerLoginInfo {
  isLoggedIn: boolean;
  username?: string;
  registry?: string;
}

export interface VibeKitConfig {
  dockerHubUser?: string;
  lastImageBuild?: string;
  registryImages?: Partial<Record<AgentType, string>>;
}

// Check if user is logged into Docker Hub
export async function checkDockerLogin(): Promise<DockerLoginInfo> {
  try {
    // Method 1: Try docker info
    const { stdout } = await execAsync("docker info");
    const usernameMatch = stdout.match(/Username:\s*(.+)/);
    if (usernameMatch) {
      return {
        isLoggedIn: true,
        username: usernameMatch[1].trim(),
        registry: "https://index.docker.io/v1/",
      };
    }

    // Method 2: Try credential store (Docker Desktop)
    try {
      const { stdout: credList } = await execAsync(
        "docker-credential-desktop list"
      );
      const creds = JSON.parse(credList);
      const dockerHubUser = creds["https://index.docker.io/v1/"];

      if (dockerHubUser) {
        return {
          isLoggedIn: true,
          username: dockerHubUser,
          registry: "https://index.docker.io/v1/",
        };
      }
    } catch {
      // Credential store method failed, continue
    }

    // Method 3: Try a simple docker push test (safe way)
    try {
      // This will fail fast if not logged in without actually pushing anything
      await execAsync('docker info | grep -q "Username"');
    } catch {
      // Not logged in
    }

    return { isLoggedIn: false };
  } catch (error) {
    return { isLoggedIn: false };
  }
}

// Get or create VibeKit configuration
export async function getVibeKitConfig(): Promise<VibeKitConfig> {
  const configPath = join(process.cwd(), ".vibekit-config.json");

  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  return {};
}

// Save VibeKit configuration
export async function saveVibeKitConfig(config: VibeKitConfig): Promise<void> {
  const configPath = join(process.cwd(), ".vibekit-config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

// Upload images to user's Docker Hub account
export async function uploadImagesToUserAccount(
  dockerHubUser: string
): Promise<{
  success: boolean;
  results: Array<{
    agentType: AgentType;
    success: boolean;
    error?: string;
    imageUrl?: string;
  }>;
}> {
  const agentTypes: AgentType[] = ["claude", "codex", "opencode", "gemini"];
  const results: Array<{
    agentType: AgentType;
    success: boolean;
    error?: string;
    imageUrl?: string;
  }> = [];

  console.log(
    `🚀 Uploading VibeKit images to ${dockerHubUser}'s Docker Hub account...`
  );

  for (const agentType of agentTypes) {
    try {
      console.log(`📦 Processing ${agentType} agent...`);

      // Check if local image exists
      const localImageTag = getImageTag(agentType);
      const { stdout: localImages } = await execAsync(
        `docker images -q ${localImageTag}`
      );

      if (!localImages.trim()) {
        console.log(
          `⚠️ Local image ${localImageTag} not found, building from Dockerfile...`
        );

        // Build image if it doesn't exist
        const dockerfilePath = getDockerfilePathFromAgentType(agentType);
        if (dockerfilePath) {
          await execAsync(
            `docker build -t ${localImageTag} -f ${dockerfilePath} .`
          );
          console.log(`✅ Built ${localImageTag} from Dockerfile`);
        } else {
          results.push({
            agentType,
            success: false,
            error: "No Dockerfile found and no local image",
          });
          continue;
        }
      }

      // Tag for user's account
      const userImageTag = `${dockerHubUser}/vibekit-${agentType}:latest`;
      await execAsync(`docker tag ${localImageTag} ${userImageTag}`);
      console.log(`🏷️ Tagged as ${userImageTag}`);

      // Push to user's Docker Hub
      console.log(`📤 Pushing ${userImageTag} to Docker Hub...`);
      await execAsync(`docker push ${userImageTag}`);
      console.log(`✅ Successfully pushed ${userImageTag}`);

      results.push({
        agentType,
        success: true,
        imageUrl: userImageTag,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to upload ${agentType} image: ${errorMessage}`);
      results.push({ agentType, success: false, error: errorMessage });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  console.log(
    `🎯 Upload complete: ${successCount}/${agentTypes.length} images uploaded successfully`
  );

  return {
    success: successCount > 0,
    results,
  };
}

// Setup user's Docker registry integration
export async function setupUserDockerRegistry(): Promise<{
  success: boolean;
  config?: VibeKitConfig;
  error?: string;
}> {
  try {
    console.log("🐳 Setting up VibeKit Docker Registry Integration...");

    // Step 1: Check Docker login
    console.log("🔍 Checking Docker login status...");
    const loginInfo = await checkDockerLogin();

    if (!loginInfo.isLoggedIn || !loginInfo.username) {
      return {
        success: false,
        error: 'Not logged into Docker Hub. Please run "docker login" first.',
      };
    }

    console.log(`✅ Logged in as: ${loginInfo.username}`);

    // Step 2: Upload images to user's account
    const uploadResult = await uploadImagesToUserAccount(loginInfo.username);

    if (!uploadResult.success) {
      return {
        success: false,
        error: "Failed to upload images to Docker Hub",
      };
    }

    // Step 3: Update configuration
    const config: VibeKitConfig = {
      dockerHubUser: loginInfo.username,
      lastImageBuild: new Date().toISOString(),
      registryImages: {},
    };

    // Map successful uploads to registry images
    for (const result of uploadResult.results) {
      if (result.success && result.imageUrl) {
        config.registryImages![result.agentType] = result.imageUrl;
      }
    }

    await saveVibeKitConfig(config);
    console.log("💾 Configuration saved to .vibekit-config.json");

    console.log(
      "🎉 Setup complete! VibeKit will now use your Docker Hub images."
    );
    console.log("📋 Your images:");
    for (const result of uploadResult.results) {
      if (result.success) {
        console.log(`  ✅ ${result.agentType}: ${result.imageUrl}`);
      }
    }

    return { success: true, config };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Setup failed: ${errorMessage}`,
    };
  }
}
