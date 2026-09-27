import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getHealth } from "../src/app/api/health/route";
import { GET as getReadiness } from "../src/app/api/ready/route";

const executableNames = {
  soffice: process.platform === "win32" ? ["soffice.com", "soffice.exe"] : ["soffice"],
  pdfinfo: process.platform === "win32" ? ["pdfinfo.exe"] : ["pdfinfo"],
  pdftoppm: process.platform === "win32" ? ["pdftoppm.exe"] : ["pdftoppm"],
};

describe("deployment health routes", () => {
  let tempRoot: string;
  let artifactRoot: string;
  let binaryRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "vk-hackathon-health-"));
    artifactRoot = path.join(tempRoot, "artifacts");
    binaryRoot = path.join(tempRoot, "bin");
    await mkdir(artifactRoot);
    await mkdir(binaryRoot);
    vi.stubEnv("VK_HACKATHON_ARTIFACT_ROOT", artifactRoot);
    vi.stubEnv("PATH", binaryRoot);

    for (const name of Object.values(executableNames).flat()) {
      await writeFile(path.join(binaryRoot, name), "test executable", { mode: 0o755 });
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns a non-cacheable liveness response for a running process", async () => {
    const response = await getHealth();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("reports ready when the artifact volume is writable and renderer binaries exist", async () => {
    const response = await getReadiness();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      checks: {
        artifactVolume: true,
        rendererBinaries: { soffice: true, pdfinfo: true, pdftoppm: true },
      },
    });
    await expect(readdir(artifactRoot)).resolves.toEqual([]);
  });

  it("reports not ready when the configured artifact volume is missing", async () => {
    await rm(artifactRoot, { recursive: true, force: true });

    const response = await getReadiness();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      checks: {
        artifactVolume: false,
        rendererBinaries: { soffice: true, pdfinfo: true, pdftoppm: true },
      },
    });
    expect(JSON.stringify(body)).not.toContain(tempRoot);
  });

  it("reports not ready when a renderer binary is absent without exposing paths", async () => {
    for (const name of executableNames.pdfinfo) {
      await rm(path.join(binaryRoot, name), { force: true });
    }

    const response = await getReadiness();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      checks: {
        artifactVolume: true,
        rendererBinaries: { soffice: true, pdfinfo: false, pdftoppm: true },
      },
    });
    expect(JSON.stringify(body)).not.toContain(tempRoot);
    await expect(readdir(artifactRoot)).resolves.toEqual([]);
  });
});
