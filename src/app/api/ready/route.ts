import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, rm, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const rendererExecutables = {
  soffice: process.platform === "win32" ? ["soffice.com", "soffice.exe"] : ["soffice"],
  pdfinfo: process.platform === "win32" ? ["pdfinfo.exe"] : ["pdfinfo"],
  pdftoppm: process.platform === "win32" ? ["pdftoppm.exe"] : ["pdftoppm"],
} as const;

export async function GET() {
  const [artifactVolume, soffice, pdfinfo, pdftoppm] = await Promise.all([
    isArtifactVolumeWritable(),
    hasExecutable(rendererExecutables.soffice),
    hasExecutable(rendererExecutables.pdfinfo),
    hasExecutable(rendererExecutables.pdftoppm),
  ]);
  const checks = { artifactVolume, rendererBinaries: { soffice, pdfinfo, pdftoppm } };
  const ok = artifactVolume && soffice && pdfinfo && pdftoppm;

  return Response.json(
    { ok, checks },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

async function isArtifactVolumeWritable() {
  const configuredRoot = process.env.VK_HACKATHON_ARTIFACT_ROOT?.trim();
  if (!configuredRoot) return false;

  const root = path.resolve(configuredRoot);
  const probePath = path.join(root, `.vk-hackathon-readiness-${randomUUID()}`);
  let probeCreated = false;
  let probeHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    if (!(await stat(root)).isDirectory()) return false;
    probeHandle = await open(probePath, "wx");
    probeCreated = true;
    await probeHandle.close();
    probeHandle = undefined;
    return true;
  } catch {
    return false;
  } finally {
    await probeHandle?.close().catch(() => undefined);
    if (probeCreated) await rm(probePath, { force: true }).catch(() => undefined);
  }
}

async function hasExecutable(names: readonly string[]) {
  const searchPath = process.env.PATH ?? "";
  const executePermission = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;

  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, executePermission);
        return true;
      } catch {
        // Keep probing PATH without exposing filesystem details in the response.
      }
    }
  }

  return false;
}
