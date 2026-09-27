import { copyFile, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectRenderPageMetadata,
  calculateRenderPageSetSha256,
  RENDER_COMPARISON_CAVEAT,
  RenderComparisonError,
  renderAndCompareFixture,
  resolveSafeRelativePath,
} from "../src/lib/render-comparison";
import {
  findLibreOfficeExecutable,
  renderPptxToPngs,
  RenderEvidenceError,
  RENDER_TIMEOUT_LIMITS,
} from "../src/lib/render-evidence";
import {
  renderGoldenManifestSchema,
  type RenderGoldenFixture,
  type RenderGoldenManifest,
} from "../src/lib/schemas";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const organizerRoot = path.join(packageRoot, "fixtures", "templates", "organizer");
const goldenRoot = path.join(packageRoot, "fixtures", "render-goldens");
const manifestPath = path.join(goldenRoot, "manifest.json");
const updateGolden = process.argv.includes("--update-golden");

type FixtureReport = {
  inputPath: string;
  status: "passed" | "failed";
  expectedPageCount: number;
  currentPageCount: number;
  expectedPageSetSha256: string;
  currentPageSetSha256: string;
  currentArtifactDirectory: string;
  sideBySidePath: string;
  representatives: Array<{
    slideNumber: number;
    status: "passed" | "failed";
    baselineBytes: number;
    currentBytes: number;
    baselineSha256: string;
    currentSha256: string;
    pixelDiff: unknown;
    reasons: string[];
  }>;
};

async function main() {
  const fixturePaths = await listOrganizerFixtures();
  if (fixturePaths.length === 0) {
    throw new RenderComparisonError("invalid_path", `No .pptx fixtures found in ${organizerRoot}`);
  }

  await findLibreOfficeExecutable();
  const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "vk-tech-hackathon-render-compare-"));
  const currentRoot = path.join(artifactRoot, "current");
  const sideBySideRoot = path.join(artifactRoot, "side-by-side");
  const baselineArtifactRoot = path.join(artifactRoot, "baseline");
  await mkdir(currentRoot, { recursive: true });
  await mkdir(sideBySideRoot, { recursive: true });
  await mkdir(baselineArtifactRoot, { recursive: true });

  let manifest: RenderGoldenManifest | undefined;
  if (!updateGolden) {
    manifest = await readManifest();
    assertManifestMatchesFixtures(manifest, fixturePaths);
  }

  const reports: FixtureReport[] = [];
  const updatedFixtures: RenderGoldenFixture[] = [];
  for (const [index, fixturePath] of fixturePaths.entries()) {
    const inputPath = toRelativePath(packageRoot, fixturePath);
    const fixtureCurrentRoot = path.join(currentRoot, `fixture-${index + 1}`);
    await mkdir(fixtureCurrentRoot, { recursive: true });
    const expected = manifest?.fixtures.find((fixture) => fixture.inputPath === inputPath);

    if (updateGolden) {
      const updated = await updateFixtureGolden({
        fixturePath,
        inputPath,
        fixtureCurrentRoot,
        fixtureIndex: index + 1,
        baselineArtifactRoot,
        sideBySideRoot,
      });
      reports.push(updated.report);
      updatedFixtures.push(updated.fixture);
      continue;
    }
    if (!expected) throw new RenderComparisonError("invalid_path", `Golden manifest has no fixture entry for ${inputPath}`);

    const comparison = await renderAndCompareFixture({
      inputPath: fixturePath,
      expected,
      baselineRoot: goldenRoot,
      currentRoot: fixtureCurrentRoot,
      render: renderPptxToPngs,
      renderOptions: {
        width: expected.width,
        height: expected.height,
        jobTimeoutMs: RENDER_TIMEOUT_LIMITS.job.defaultMs,
        processTimeoutMs: RENDER_TIMEOUT_LIMITS.process.defaultMs,
      },
    });
    const sideBySidePath = await writeSideBySideEvidence({
      fixtureIndex: index + 1,
      inputPath,
      currentRoot: fixtureCurrentRoot,
      baselineRoot: goldenRoot,
      baselineArtifactRoot,
      sideBySideRoot,
      expected,
      comparisons: comparison.representatives,
    });
    reports.push({
      inputPath,
      status: comparison.status,
      expectedPageCount: comparison.expectedPageCount,
      currentPageCount: comparison.currentPageCount,
      expectedPageSetSha256: comparison.pageSet.expectedPageSetSha256,
      currentPageSetSha256: comparison.pageSet.currentPageSetSha256,
      currentArtifactDirectory: fixtureCurrentRoot,
      sideBySidePath,
      representatives: comparison.representatives.map((representative) => ({
        slideNumber: representative.slideNumber,
        status: representative.comparison.status,
        baselineBytes: representative.comparison.baseline.byteSize,
        currentBytes: representative.comparison.current.byteSize,
        baselineSha256: representative.comparison.baseline.sha256,
        currentSha256: representative.comparison.current.sha256,
        pixelDiff: representative.comparison.pixelDiff,
        reasons: representative.comparison.reasons,
      })),
    });
  }

  if (updateGolden) {
    const updatedManifest = renderGoldenManifestSchema.parse({
      version: 1,
      renderer: "libreoffice-impress-headless",
      rasterizer: "poppler-pdftoppm",
      width: 900,
      height: 1_600,
      fixtures: updatedFixtures,
    });
    await writeFile(manifestPath, JSON.stringify(updatedManifest, null, 2) + "\n", "utf8");
  }

  const status = updateGolden || reports.every((report) => report.status === "passed") ? "passed" : "failed";
  const reportPath = path.join(artifactRoot, "report.json");
  const report = {
    status: updateGolden ? "golden-updated" : status,
    version: 1,
    renderer: "libreoffice-impress-headless",
    rasterizer: "poppler-pdftoppm",
    jobTimeoutMs: RENDER_TIMEOUT_LIMITS.job.defaultMs,
    processTimeoutMs: RENDER_TIMEOUT_LIMITS.process.defaultMs,
    manifestPath,
    artifactRoot,
    caveat: RENDER_COMPARISON_CAVEAT,
    fixtures: reports,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  printReport(report, reportPath);
  if (!updateGolden && status !== "passed") process.exitCode = 1;
}

async function listOrganizerFixtures() {
  const entries = await readdir(organizerRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".pptx")
    .map((entry) => path.join(organizerRoot, entry.name))
    .sort((left, right) => left === right ? 0 : left < right ? -1 : 1);
}

async function readManifest() {
  const contents = await readFile(manifestPath, "utf8");
  return renderGoldenManifestSchema.parse(JSON.parse(contents));
}

function assertManifestMatchesFixtures(manifest: RenderGoldenManifest, fixturePaths: string[]) {
  const expectedPaths = new Set(manifest.fixtures.map((fixture) => fixture.inputPath));
  const actualPaths = fixturePaths.map((fixturePath) => toRelativePath(packageRoot, fixturePath));
  if (expectedPaths.size !== actualPaths.length || actualPaths.some((inputPath) => !expectedPaths.has(inputPath))) {
    throw new RenderComparisonError(
      "invalid_path",
      "Golden manifest fixture set does not exactly match fixtures/templates/organizer",
    );
  }
}

async function updateFixtureGolden(input: {
  fixturePath: string;
  inputPath: string;
  fixtureCurrentRoot: string;
  fixtureIndex: number;
  baselineArtifactRoot: string;
  sideBySideRoot: string;
}): Promise<{ report: FixtureReport; fixture: RenderGoldenFixture }> {
  const renderEvidence = await renderPptxToPngs(input.fixturePath, {
    outputDir: input.fixtureCurrentRoot,
    width: 900,
    height: 1_600,
    jobTimeoutMs: RENDER_TIMEOUT_LIMITS.job.defaultMs,
    processTimeoutMs: RENDER_TIMEOUT_LIMITS.process.defaultMs,
  });
  const pages = await collectRenderPageMetadata(renderEvidence, input.fixtureCurrentRoot);
  const representativeSlides = [1, Math.ceil(renderEvidence.slideCount / 2), renderEvidence.slideCount];
  const representatives = representativeSlides.map((slideNumber) => pages.find((page) => page.slideNumber === slideNumber)!);
  const expected: RenderGoldenFixture = {
    inputPath: input.inputPath,
    pageCount: renderEvidence.slideCount,
    width: 900,
    height: 1_600,
    pageSetSha256: calculateRenderPageSetSha256(pages),
    pages: pages.map(({ relativePath: _relativePath, ...page }) => page),
    representatives: representatives.map((page) => ({
      slideNumber: page.slideNumber,
      byteSize: page.byteSize,
      sha256: page.sha256,
      width: page.width,
      height: page.height,
      goldenPath: `images/fixture-${input.fixtureIndex}/slide-${page.slideNumber}.png`,
    })),
  };
  for (const page of representatives) {
    const goldenPath = resolveSafeRelativePath(goldenRoot, `images/fixture-${input.fixtureIndex}/slide-${page.slideNumber}.png`);
    await mkdir(path.dirname(goldenPath), { recursive: true });
    await copyFile(path.join(input.fixtureCurrentRoot, page.relativePath), goldenPath);
  }
  const sideBySidePath = await writeSideBySideEvidence({
    fixtureIndex: input.fixtureIndex,
    inputPath: input.inputPath,
    currentRoot: input.fixtureCurrentRoot,
    baselineRoot: goldenRoot,
    baselineArtifactRoot: input.baselineArtifactRoot,
    sideBySideRoot: input.sideBySideRoot,
    expected,
    comparisons: [],
  });
  return {
    fixture: expected,
    report: {
      inputPath: input.inputPath,
      status: "passed",
      expectedPageCount: expected.pageCount,
      currentPageCount: expected.pageCount,
      expectedPageSetSha256: expected.pageSetSha256,
      currentPageSetSha256: expected.pageSetSha256,
      currentArtifactDirectory: input.fixtureCurrentRoot,
      sideBySidePath,
      representatives: expected.representatives.map((representative) => ({
        slideNumber: representative.slideNumber,
        status: "passed",
        baselineBytes: representative.byteSize,
        currentBytes: representative.byteSize,
        baselineSha256: representative.sha256,
        currentSha256: representative.sha256,
        pixelDiff: null,
        reasons: [],
      })),
    },
  };
}

async function writeSideBySideEvidence(input: {
  fixtureIndex: number;
  inputPath: string;
  currentRoot: string;
  baselineRoot: string;
  baselineArtifactRoot: string;
  sideBySideRoot: string;
  expected: RenderGoldenFixture;
  comparisons: Array<{ slideNumber: number; goldenPath: string; comparison: { status: string; baseline: { byteSize: number; sha256: string }; current: { byteSize: number; sha256: string }; pixelDiff: unknown; reasons: string[] } }>;
}) {
  const baselineCopyRoot = path.join(input.baselineArtifactRoot, `fixture-${input.fixtureIndex}`);
  await mkdir(baselineCopyRoot, { recursive: true });
  const cards = [];
  for (const representative of input.expected.representatives) {
    const baselineSource = resolveSafeRelativePath(input.baselineRoot, representative.goldenPath);
    const baselineCopy = path.join(baselineCopyRoot, `slide-${representative.slideNumber}.png`);
    await copyFile(baselineSource, baselineCopy);
    const comparison = input.comparisons.find((item) => item.slideNumber === representative.slideNumber)?.comparison;
    cards.push({
      slideNumber: representative.slideNumber,
      baselineSource: `../baseline/fixture-${input.fixtureIndex}/slide-${representative.slideNumber}.png`,
      currentSource: `../current/fixture-${input.fixtureIndex}/slide-${representative.slideNumber}.png`,
      baselineBytes: comparison?.baseline.byteSize ?? representative.byteSize,
      currentBytes: comparison?.current.byteSize ?? representative.byteSize,
      baselineSha256: comparison?.baseline.sha256 ?? representative.sha256,
      currentSha256: comparison?.current.sha256 ?? representative.sha256,
      status: comparison?.status ?? "golden-updated",
      reasons: comparison?.reasons ?? [],
      pixelDiff: comparison?.pixelDiff ?? null,
    });
  }
  const evidencePath = path.join(input.sideBySideRoot, `fixture-${input.fixtureIndex}.html`);
  await writeFile(evidencePath, renderHtml(input.inputPath, cards), "utf8");
  return evidencePath;
}

function renderHtml(inputPath: string, cards: Array<Record<string, unknown>>) {
  const cardHtml = cards.map((card) => `
    <section class="comparison">
      <h2>Slide ${String(card.slideNumber)}</h2>
      <div class="images">
        <figure><figcaption>Baseline</figcaption><img src="${String(card.baselineSource)}" alt="Baseline slide ${String(card.slideNumber)}"></figure>
        <figure><figcaption>Current</figcaption><img src="${String(card.currentSource)}" alt="Current slide ${String(card.slideNumber)}"></figure>
      </div>
      <pre>${escapeHtml(JSON.stringify({
        status: card.status,
        baselineBytes: card.baselineBytes,
        currentBytes: card.currentBytes,
        baselineSha256: card.baselineSha256,
        currentSha256: card.currentSha256,
        reasons: card.reasons,
        pixelDiff: card.pixelDiff,
      }, null, 2))}</pre>
    </section>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Deterministic render comparison</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;background:#f5f6f8;color:#18202a}.comparison{background:#fff;border:1px solid #d8dde5;border-radius:12px;padding:16px;margin:0 0 20px}.images{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0}figcaption{font-weight:700;margin:0 0 8px}img{display:block;width:100%;height:auto;border:1px solid #b8c0cc;background:#eef1f5}pre{white-space:pre-wrap;background:#f0f2f5;padding:12px;border-radius:8px;overflow:auto}</style>
</head><body><h1>Deterministic PNG render comparison</h1><p><strong>Input:</strong> ${escapeHtml(inputPath)}</p><p>${escapeHtml(RENDER_COMPARISON_CAVEAT)}</p>${cardHtml}</body></html>\n`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function toRelativePath(root: string, filePath: string) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function printReport(report: { status: string; artifactRoot: string; manifestPath: string; fixtures: FixtureReport[] }, reportPath: string) {
  console.log(`RENDER_COMPARE_STATUS: ${report.status}`);
  console.log(`RENDER_COMPARE_MANIFEST: ${report.manifestPath}`);
  console.log(`RENDER_COMPARE_REPORT: ${reportPath}`);
  console.log(`RENDER_COMPARE_ARTIFACT_ROOT: ${report.artifactRoot}`);
  for (const fixture of report.fixtures) {
    console.log(`FIXTURE ${fixture.inputPath}: status=${fixture.status} pageCount=${fixture.expectedPageCount}/${fixture.currentPageCount}`);
    console.log(`  pageSetSha256 baseline=${fixture.expectedPageSetSha256} current=${fixture.currentPageSetSha256}`);
    console.log(`  sideBySide=${fixture.sideBySidePath}`);
    for (const representative of fixture.representatives) {
      console.log(`  slide=${representative.slideNumber} status=${representative.status} bytes=${representative.baselineBytes}/${representative.currentBytes} sha256=${representative.baselineSha256}/${representative.currentSha256} reasons=${representative.reasons.join(",") || "none"}`);
    }
  }
  console.log(`RENDER_COMPARE_CAVEAT: ${RENDER_COMPARISON_CAVEAT}`);
}

main().catch((error) => {
  if (error instanceof RenderEvidenceError) {
    console.error(`RENDER_BLOCKER [${error.code}]: ${error.message}`);
  } else if (error instanceof RenderComparisonError) {
    console.error(`RENDER_COMPARE_BLOCKER [${error.code}]: ${error.message}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`RENDER_COMPARE_FAILED: ${message}`);
  }
  process.exitCode = 1;
});
