import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const rootDir = process.cwd();

export const config = {
  host: process.env.API_HOST ?? "0.0.0.0",
  port: Number(process.env.API_PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret",
  adminUsername: process.env.ADMIN_USERNAME ?? "Milagro",
  adminPassword: process.env.ADMIN_PASSWORD ?? "change-me-before-deploy",
  dataDir: path.resolve(rootDir, process.env.OPENCLAUDE_DATA_DIR ?? ".openclaude"),
  runtimeMode: process.env.AGENT_RUNTIME_MODE ?? (process.env.OPENROUTER_API_KEY ? "claude" : "mock"),
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://openrouter.ai/api",
  wallClockTimeoutMs: Number(process.env.AGENT_WALL_CLOCK_TIMEOUT_MS ?? 10 * 60 * 1000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  perUserConcurrentRuns: Number(process.env.PER_USER_CONCURRENT_RUNS ?? 4),
  agentMaxTurns: Number(process.env.AGENT_MAX_TURNS ?? 60)
};
