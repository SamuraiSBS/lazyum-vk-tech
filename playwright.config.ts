import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = "http://localhost:3030";
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "vk-tech-hackathon-e2e-"));

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: path.join(tempRoot, "playwright"),
  timeout: 420_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: path.join(tempRoot, "report"), open: "never" }]],
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      VK_HACKATHON_LLM_PROVIDER: "deterministic",
      VK_HACKATHON_ARTIFACT_ROOT: path.join(tempRoot, "artifacts"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
