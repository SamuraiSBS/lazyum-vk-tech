import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { chromium, expect, test, type Download, type Page } from "@playwright/test";

const fixturePath = path.resolve(process.cwd(), "fixtures/templates/organizer/VK Tech шаблон.pptx");
const TEXT_OVERFLOW_MESSAGE = "Text exceeds element bounds";
const formats = [
  { id: "pptx", label: "PPTX", extension: ".pptx" },
  { id: "pdf", label: "PDF", extension: ".pdf" },
  { id: "html", label: "HTML", extension: ".html" },
] as const;
const variants = ["Compact", "Balanced", "Visual"] as const;
const variantLabels = {
  compact: "Compact",
  balanced: "Balanced",
  visual: "Visual",
} as const;
const stageLabels: Record<string, string> = {
  "narrative-selection": "Планирование",
  "variant-design": "Три варианта",
  "render-audit": "Рендер и аудит",
  "final-jury": "Рекомендация жюри",
};

type PublishedSnapshot = {
  ranking: {
    recommendedVariant: keyof typeof variantLabels;
    rankedVariants: Array<{
      variant: keyof typeof variantLabels;
      score: number;
      deterministicAuditScore: number;
      advisoryScore: number;
    }>;
    blockingReasons: string[];
    remainingUserVisibleIssues: string[];
  };
  stageTrace: Array<{ stage: string; status: "completed" | "blocked" }>;
};

type LocalExportDocument = {
  jobId?: unknown;
  slides?: Array<{
    id: string;
    canvas: { elements: Array<{ id: string; type: string; text?: string; dataUrl?: string; crop?: unknown; color?: string; fontSize?: number; alt?: string }> };
  }>;
  auditDecisions?: Array<{
    issueKey: string;
    slideId: string;
    elementId?: string;
    action: "fix" | "ignore";
  }>;
};

async function expectPublishedSummary(page: Page, snapshot: PublishedSnapshot) {
  const disclosure = page.getByTestId("compare-disclosure");
  if (await disclosure.getAttribute("open") === null) {
    await disclosure.locator(":scope > summary").click();
  }
  const summary = page.getByTestId("generation-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText(
    `Рекомендуемый вариант: ${variantLabels[snapshot.ranking.recommendedVariant]}`,
  );
  const ranking = summary.getByRole("list", { name: "Порядок вариантов" });
  await expect(ranking.locator("li")).toHaveCount(3);
  for (const [index, entry] of snapshot.ranking.rankedVariants.entries()) {
    const row = ranking.locator("li").nth(index);
    await expect(row).toContainText(variantLabels[entry.variant]);
    if (entry.variant === snapshot.ranking.recommendedVariant) {
      await expect(row).toContainText("· рекомендация");
    }
    await expect(row).toContainText(
      `#${index + 1} · итог ${entry.score}/100 · аудит ${entry.deterministicAuditScore}/100 · доп. оценка ${entry.advisoryScore}/100`,
    );
  }
  for (const reason of snapshot.ranking.blockingReasons) {
    await expect(summary).toContainText(reason);
  }
  for (const issue of snapshot.ranking.remainingUserVisibleIssues) {
    await expect(summary).toContainText(issue);
  }
}

async function expectGenerationDiagnostics(page: Page, snapshot: PublishedSnapshot) {
  const disclosure = page.getByTestId("diagnostics-disclosure");
  if (await disclosure.getAttribute("open") === null) {
    await disclosure.locator(":scope > summary").click();
  }
  const stages = page.getByTestId("generation-stages");
  await expect(stages).toBeVisible();
  await expect(page.getByTestId("template-diagnostics")).toBeVisible();
  for (const stage of snapshot.stageTrace) {
    const label = stageLabels[stage.stage];
    if (!label) continue;
    const row = stages.locator("dl > div").filter({ hasText: label });
    await expect(row).toContainText(
      stage.status === "completed" ? "Завершён" : "Заблокирован",
    );
  }
  await expect(stages).toContainText("Сохранённый итог job, не live-прогресс.");
}

async function readPublishedSnapshot(page: Page, jobId: string) {
  const response = await page.request.get(
    new URL(`/api/jobs/${encodeURIComponent(jobId)}`, page.url()).toString(),
    { timeout: 120_000 },
  );
  expect(response.ok()).toBeTruthy();
  return await response.json() as PublishedSnapshot;
}

function removeInlineImages(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(removeInlineImages);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "imageDataUrl" || key === "dataUrl") {
      delete (value as Record<string, unknown>)[key];
    } else {
      removeInlineImages(child);
    }
  }
}

function findExecutable(command: string, candidates: string[]) {
  const candidate = candidates.find((value) => existsSync(value));
  if (candidate) return candidate;
  try {
    return execFileSync("where.exe", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .find(Boolean) || null;
  } catch {
    return null;
  }
}

const browserExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() || chromium.executablePath();
const libreOfficeExecutable = findExecutable("soffice", [
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
]);
const blockers: string[] = [];
if (!existsSync(browserExecutable)) {
  blockers.push(`BLOCKED: Chromium executable not found at ${browserExecutable}`);
}
if (!libreOfficeExecutable) {
  blockers.push("BLOCKED: LibreOffice/soffice executable not found via where.exe or standard install paths; template PNG analysis cannot run.");
}

test.describe("P0 persisted generation job browser E2E", () => {
  test("analyzes fixture, persists generation job, exports three formats, and reopens published job", async ({}, testInfo) => {
    test.skip(blockers.length > 0, blockers.join(" "));
    testInfo.annotations.push({ type: "provider", description: "VK_HACKATHON_LLM_PROVIDER=deterministic" });
    expect(existsSync(fixturePath)).toBeTruthy();

    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    const context = await browser.newContext({
      baseURL: "http://localhost:3030",
      acceptDownloads: true,
      httpCredentials: {
        username: process.env.VK_HACKATHON_DEMO_AUTH_USER ?? "playwright",
        password: process.env.VK_HACKATHON_DEMO_AUTH_PASSWORD ?? "playwright",
      },
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);

    try {
      await page.goto("/");
      const briefField = page.getByLabel("Тема / brief");
      await briefField.fill("Внутренний питч нового сервиса VK для команды продукта на 7 слайдов");
      await expect(briefField).toHaveValue("Внутренний питч нового сервиса VK для команды продукта на 7 слайдов");
      await page.getByRole("button", { name: "Продолжить", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Выберите шаблон" })).toBeVisible();
    await page.locator("#template-file").setInputFiles(fixturePath);
    await expect(page.getByText("VK Tech шаблон.pptx", { exact: true })).toBeVisible();

    const analyzeResponsePromise = page.waitForResponse((response) => (
      response.url().endsWith("/api/analyze") && response.request().method() === "POST"
    ), { timeout: 300_000 });
    await page.getByRole("button", { name: "Проверить шаблон", exact: true }).click();
    const analyzeResponse = await analyzeResponsePromise;
    expect(analyzeResponse.ok()).toBeTruthy();
    await expect(page.getByRole("status")).toContainText("Шаблон проанализирован: токены, layouts и фактический PNG-render сохранены в job.");

    const renderImage = page.getByRole("img", { name: "Фактический PNG-render первого слайда шаблона" });
    await expect(renderImage).toBeVisible();
    await expect.poll(() => renderImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const renderSrc = await renderImage.getAttribute("src");
    expect(renderSrc).toBeTruthy();
    const analysisJobId = decodeURIComponent(new URL(renderSrc!, page.url()).pathname.match(/\/api\/artifacts\/([^/]+)\//u)?.[1] || "");
    expect(analysisJobId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
    const renderArtifactResponse = await page.request.get(new URL(renderSrc!, page.url()).toString());
    expect(renderArtifactResponse.ok()).toBeTruthy();
    expect(renderArtifactResponse.headers()["content-type"]).toContain("image/png");
    expect((await renderArtifactResponse.body()).byteLength).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await page.getByLabel("Количество слайдов").selectOption("10");
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();

    const generationResponsePromise = page.waitForResponse((response) => (
      response.url().endsWith("/api/generate") && response.request().method() === "POST"
    ), { timeout: 300_000 });
    const publishedJobResponsePromise = page.waitForResponse((response) => (
      response.url().includes("/api/jobs/") && response.request().method() === "GET"
    ), { timeout: 300_000 }).catch(() => null);
    await expect(page.getByRole("heading", { name: "Всё готово к созданию" })).toBeVisible();
    await expect(page.getByTestId("effective-slide-count")).toHaveText("7 слайдов (по брифу)");
    const createButton = page.getByRole("button", { name: "Создать презентацию", exact: true });
    await expect(createButton).toBeEnabled();
    await createButton.focus();
    await page.keyboard.press("Enter");
    const generationResponse = await generationResponsePromise;
    if (!generationResponse.ok()) {
      throw new Error(`Generation failed: ${await generationResponse.text()}`);
    }
    const publishedJobResponse = await publishedJobResponsePromise;
    expect(publishedJobResponse?.ok()).toBeTruthy();
    const generationUrl = new URL(page.url());
    const generationJobId = generationUrl.searchParams.get("job");
    expect(generationJobId).toMatch(/^job-[A-Za-z0-9-]+$/u);
    const generationSnapshot = await readPublishedSnapshot(page, generationJobId!);
    const generationPayload = generationSnapshot as PublishedSnapshot & { presentations: Record<string, any> };
    await expect(page.locator(".notice[role='status']")).toContainText("Готово: один job создал три варианта по 7 слайдов.");
    await expect(page.getByTestId("save-status")).toBeVisible();
    await expect(page.locator("header.topbar").getByTestId("export-control")).toHaveCount(1);
    await expect(page.locator(".editor-toolbar [data-testid='export-control']")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Список слайдов" })).toBeVisible();
    await expect(page.locator(".editable-canvas")).toBeVisible();
    await expect(page.getByTestId("object-properties")).toContainText(
      "Выберите объект на холсте, чтобы увидеть его тип и геометрию.",
    );
    const canvasBounds = await page.locator(".editable-canvas").boundingBox();
    const inspectorBounds = await page.locator(".inspector").boundingBox();
    expect(canvasBounds?.width).toBeGreaterThan((inspectorBounds?.width || 0) * 2);

    const compareDisclosure = page.getByTestId("compare-disclosure");
    const diagnosticsDisclosure = page.getByTestId("diagnostics-disclosure");
    const auditDisclosure = page.getByTestId("audit-disclosure");
    expect(await compareDisclosure.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    expect(await diagnosticsDisclosure.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    expect(await auditDisclosure.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    await expect(page.getByTestId("generation-summary")).toBeHidden();
    await expect(page.getByTestId("generation-stages")).toBeHidden();
    await expect(page.getByTestId("template-diagnostics")).toBeHidden();

    const projectMenu = page.getByTestId("project-menu");
    await expect(page.getByRole("complementary", { name: "Список слайдов" }).getByRole("button", { name: "Создать новый проект" })).toHaveCount(0);
    await projectMenu.locator(":scope > summary").click();
    await expect(projectMenu.getByRole("button", { name: "Создать новый проект" })).toBeVisible();
    await projectMenu.locator(":scope > summary").click();

    await expectPublishedSummary(page, generationSnapshot);
    await expectGenerationDiagnostics(page, generationSnapshot);

    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    for (const variant of variants) {
      const tab = tabs.filter({ hasText: variant });
      await expect(tab).toContainText(variant);
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    }
    const balancedTab = tabs.filter({ hasText: "Balanced" });
    await expect(balancedTab).toContainText("Рекомендуем");
    await balancedTab.click();
    await expect(page.getByRole("tab", { name: /Balanced/u })).toHaveAttribute("aria-selected", "true");
    const slideRail = page.getByRole("complementary", { name: "Список слайдов" });
    const thumbnails = slideRail.locator("button.thumbnail");
    await expect(thumbnails).toHaveCount(7);

    const firstSlideTitle = await page.locator(".editor-toolbar h2").textContent();
    await thumbnails.nth(1).click();
    await expect(page.locator(".editor-toolbar h2")).not.toHaveText(firstSlideTitle || "");
    await thumbnails.nth(0).click();
    await expect(page.locator(".editor-toolbar h2")).toHaveText(firstSlideTitle || "");

    const movableSelector = ".canvas-object:not(:has(textarea))";
    const movableIndex = await page.locator(movableSelector).evaluateAll((elements) => {
      let bestIndex = -1;
      let bestArea = 0;
      elements.forEach((element, index) => {
        const bounds = element.getBoundingClientRect();
        const area = bounds.width * bounds.height;
        const target = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        if (area > bestArea && target && element.contains(target)) {
          bestIndex = index;
          bestArea = area;
        }
      });
      return bestIndex;
    });
    expect(movableIndex).toBeGreaterThanOrEqual(0);
    const movableObject = page.locator(movableSelector).nth(movableIndex);
    await expect(movableObject).toBeVisible();
    await movableObject.click();
    const objectProperties = page.getByTestId("object-properties");
    const positionOutput = objectProperties.locator("output").nth(0);
    const positionBeforeMove = await positionOutput.textContent();
    const movableBounds = await movableObject.boundingBox();
    if (!movableBounds) throw new Error("The selected canvas object has no bounds.");
    const moveStartX = movableBounds.x + movableBounds.width / 2;
    const moveStartY = movableBounds.y + movableBounds.height / 2;
    await page.mouse.move(moveStartX, moveStartY);
    await page.mouse.down();
    await page.mouse.move(moveStartX + 28, moveStartY + 18, { steps: 4 });
    await page.mouse.up();
    await expect(positionOutput).not.toHaveText(positionBeforeMove || "");
    await expect(auditDisclosure).toBeVisible();
    await auditDisclosure.locator(":scope > summary").click();
    const auditSection = page.locator(".audit-section");
    const overflowingText = Array.from({ length: 40 }, () => "намеренное переполнение").join(" ");
    const editableText = page.getByRole("textbox", { name: "Редактируемый текст" }).first();
    await editableText.click();
    await editableText.fill(overflowingText);
    await expect(editableText).toHaveValue(overflowingText);
    await expect(objectProperties).toContainText("Текст");
    await expect(objectProperties).toContainText("Положение · x / y");
    await expect(objectProperties).toContainText("Размер · w × h");
    await expect(objectProperties.getByLabel("Размер шрифта")).toBeVisible();
    await objectProperties.getByLabel("Размер шрифта").fill("32");
    await expect(objectProperties.getByLabel("Размер шрифта")).toHaveValue("32");
    await objectProperties.getByLabel("Размер шрифта").fill("999");
    await expect(objectProperties.getByLabel("Размер шрифта")).toHaveValue("32");
    const sizeOutput = objectProperties.locator("output").nth(1);
    const sizeBeforeResize = await sizeOutput.textContent();
    const resizeHandle = page.getByRole("button", { name: "Изменить размер объекта" });
    const resizeBounds = await resizeHandle.boundingBox();
    if (!resizeBounds) throw new Error("The selected text object has no resize handle.");
    const resizeStartX = resizeBounds.x + resizeBounds.width / 2;
    const resizeStartY = resizeBounds.y + resizeBounds.height / 2;
    await page.mouse.move(resizeStartX, resizeStartY);
    await page.mouse.down();
    await page.mouse.move(resizeStartX + 28, resizeStartY + 20, { steps: 4 });
    await page.mouse.up();
    await expect(sizeOutput).not.toHaveText(sizeBeforeResize || "");

    const auditIssues = auditSection.locator("li");
    const overflowIssue = auditIssues.filter({ hasText: TEXT_OVERFLOW_MESSAGE });
    await expect(overflowIssue).toHaveCount(1);
    await expect(overflowIssue).toHaveClass(/severity-error/u);
    await expect(overflowIssue).not.toContainText("— ignored");
    await expect(page.getByTestId("audit-count")).not.toHaveClass(/audit-ok/u);

    await overflowIssue.getByRole("button", { name: "Игнорировать", exact: true }).click();
    await expect(page.locator(".notice[role='status']")).toContainText(
      "Замечание помечено как ignored и audit выполнен повторно.",
    );
    await expect(overflowIssue).toContainText("— ignored");
    await expect(
      auditIssues.filter({ hasText: TEXT_OVERFLOW_MESSAGE }).filter({ hasNotText: /— ignored/u }),
    ).toHaveCount(0);

    const localExportControl = page.locator("header.topbar").getByTestId("export-control");
    await localExportControl.locator(":scope > summary").click();
    await page.evaluate(() => {
      const trackedWindow = window as Window & { __editedExportError?: string };
      const previousFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await previousFetch(...args);
        if (response.url.includes("/api/export") && !response.ok) {
          trackedWindow.__editedExportError = await response.clone().text();
        }
        return response;
      };
    });
    const rejectedExportPromise = page.waitForResponse((response) => (
      response.url().endsWith("/api/export") && response.request().method() === "POST"
    ), { timeout: 120_000 });
    await localExportControl.getByRole("button", { name: "PPTX", exact: true }).click();
    const rejectedExport = await rejectedExportPromise;
    expect(rejectedExport.status()).toBe(422);
    await expect.poll(() => page.evaluate(() => (
      window as Window & { __editedExportError?: string }
    ).__editedExportError)).toBeTruthy();
    const rejectedBody = JSON.parse((await page.evaluate(() => (
      window as Window & { __editedExportError?: string }
    ).__editedExportError)) || "null") as {
      error?: { code?: string; reason?: string; issues?: Array<{ severity?: string; ignored?: boolean }> };
    };
    expect(rejectedBody.error?.code).toBe("EXPORT_PREFLIGHT_FAILED");
    expect(rejectedBody.error?.reason).toBe("AUDIT_ERRORS");
    expect(rejectedBody.error?.issues?.some((issue) => issue.severity === "error" && !issue.ignored)).toBeTruthy();
    console.log(`[P0-E2E] rejectedEditedExport=422/${rejectedBody.error?.reason}, issues=${rejectedBody.error?.issues?.length}`);

    // Preflight requires every fatal audit issue to be resolved or explicitly
    // ignored. Work through the inspector for each slide, including issues
    // that were previously hidden after the first five entries.
    const slideThumbnails = page.getByRole("complementary", { name: "Список слайдов" }).locator("button.thumbnail");
    for (let slideIndex = 0; slideIndex < await slideThumbnails.count(); slideIndex += 1) {
      await slideThumbnails.nth(slideIndex).click();
      const pendingErrors = auditSection.locator("li.severity-error").filter({ hasNotText: /— ignored/u });
      for (let decisionCount = 0; decisionCount < 100; decisionCount += 1) {
        const before = await pendingErrors.count();
        if (before === 0) break;
        await pendingErrors.first().getByRole("button", { name: "Игнорировать", exact: true }).click();
        await expect.poll(() => pendingErrors.count()).toBeLessThan(before);
      }
      await expect(pendingErrors).toHaveCount(0);
    }
    await expect(page.getByTestId("audit-count")).toHaveClass(/audit-ok/u);

    const localExportResults: string[] = [];
    for (const format of formats) {
      await expect(localExportControl.getByRole("button", { name: format.label, exact: true })).toBeVisible();
    }
    for (const format of formats) {
      const endpoint = format.id === "pptx" ? "/api/export" : `/api/export/${format.id}`;
      await page.evaluate(() => {
        (window as Window & { __editedExportError?: string }).__editedExportError = undefined;
      });
      const exportRequestPromise = page.waitForRequest((request) => (
        request.url().endsWith(endpoint) && request.method() === "POST"
      ), { timeout: 120_000 });
      const exportResponsePromise = page.waitForResponse((response) => (
        response.url().endsWith(endpoint) && response.request().method() === "POST"
      ), { timeout: 120_000 });
      const downloadPromise = new Promise<Download>((resolve) => page.once("download", resolve));
      await localExportControl.getByRole("button", { name: format.label, exact: true }).click();
      const [exportResponse, exportRequest] = await Promise.all([
        exportResponsePromise,
        exportRequestPromise,
      ]);
      if (!exportResponse.ok()) {
        const responseBody = await page.evaluate(() => (
          window as Window & { __editedExportError?: string }
        ).__editedExportError);
        throw new Error(`Edited ${format.id} export returned ${exportResponse.status()}: ${responseBody || "body unavailable"}`);
      }
      const download = await downloadPromise;
      const exportByteLength = Number(exportResponse.headers()["content-length"] || 0);
      expect(exportByteLength).toBeGreaterThan(0);
      expect(exportResponse.headers()["x-vk-hackathon-artifact-path"]).toBeUndefined();

      const submittedDocument = exportRequest.postDataJSON() as LocalExportDocument;
      expect(submittedDocument.jobId).toBeUndefined();
      const overflowTarget = (submittedDocument.slides || [])
        .flatMap((slide) => slide.canvas.elements.map((element) => ({ slide, element })))
        .find(({ element }) => element.type === "text" && element.text === overflowingText);
      expect(overflowTarget).toBeDefined();
      if (!overflowTarget) throw new Error("Local export payload omitted the overflowing Balanced text.");
      const ignoredDecision = (submittedDocument.auditDecisions || []).find((decision) => (
        decision.action === "ignore"
          && decision.slideId === overflowTarget.slide.id
          && decision.elementId === overflowTarget.element.id
      ));
      expect(ignoredDecision).toBeDefined();
      if (!ignoredDecision) throw new Error("Local export payload omitted the ignored TEXT_OVERFLOW decision.");
      expect(ignoredDecision.issueKey).toBe(JSON.stringify([
        overflowTarget.slide.id,
        "TEXT_OVERFLOW",
        overflowTarget.element.id,
        TEXT_OVERFLOW_MESSAGE,
      ]));
      await expect(page.locator(".notice[role='status']")).toContainText(
        `${format.label} скачан из текущего изменённого документа.`,
      );

      const downloadPath = testInfo.outputPath("downloads", `local-balanced-${format.id}${format.extension}`);
      await fs.mkdir(path.dirname(downloadPath), { recursive: true });
      await download.saveAs(downloadPath);
      const downloadSize = (await fs.stat(downloadPath)).size;
      expect(downloadSize).toBeGreaterThan(0);
      expect(download.suggestedFilename()).toMatch(new RegExp(`${format.extension.replace(".", "\\.")}$`, "u"));
      localExportResults.push(`${format.id}: local document, ${downloadSize} bytes (content-length ${exportByteLength})`);
    }

    // Keep Balanced locally edited while exporting the untouched Visual sibling.
    // The sibling must still use its published job artifact, not the draft body.
    const visualTab = page.getByRole("tab", { name: /Visual/u });
    await visualTab.click();
    await expect(visualTab).toHaveAttribute("aria-selected", "true");
    const siblingRequestPromise = page.waitForRequest((request) => (
      request.url().endsWith("/api/export/html") && request.method() === "POST"
    ), { timeout: 120_000 });
    const siblingResponsePromise = page.waitForResponse((response) => (
      response.url().endsWith("/api/export/html") && response.request().method() === "POST"
    ), { timeout: 120_000 });
    const siblingDownloadPromise = page.waitForEvent("download", { timeout: 120_000 });
    await localExportControl.getByRole("button", { name: "HTML", exact: true }).click();
    const [siblingRequest, siblingResponse, siblingDownload] = await Promise.all([
      siblingRequestPromise,
      siblingResponsePromise,
      siblingDownloadPromise,
    ]);
    expect(siblingResponse.ok()).toBeTruthy();
    expect(siblingRequest.postDataJSON()).toEqual({ jobId: generationJobId, variant: "visual" });
    const siblingArtifactPath = siblingResponse.headers()["x-vk-hackathon-artifact-path"];
    expect(siblingArtifactPath).toBe("exports/visual/html.html");
    const siblingArtifactResponse = await page.request.get(new URL(
      `/api/artifacts/${encodeURIComponent(generationJobId!)}/${siblingArtifactPath}`,
      page.url(),
    ).toString());
    expect(siblingArtifactResponse.ok()).toBeTruthy();
    const siblingDownloadPath = testInfo.outputPath("downloads", "published-visual-while-balanced-edited.html");
    await fs.mkdir(path.dirname(siblingDownloadPath), { recursive: true });
    await siblingDownload.saveAs(siblingDownloadPath);
    expect(await fs.readFile(siblingDownloadPath)).toEqual(await siblingArtifactResponse.body());
    await balancedTab.click();
    await expect(balancedTab).toHaveAttribute("aria-selected", "true");
    await slideThumbnails.first().click();
    await expect(page.getByRole("textbox", { name: "Редактируемый текст" }).first()).toHaveValue(overflowingText);

    const localDraft = "Локальный черновик не должен быть восстановлен";
    await slideThumbnails.first().click();
    await editableText.fill(localDraft);
    await expect(editableText).toHaveValue(localDraft);
    await expect(page.getByTestId("save-status")).toContainText("Сохранено локально");
    await expect(page).not.toHaveURL(generationUrl.toString());
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".notice[role='status']")).toContainText("Восстановлен локально сохранённый черновик.");
    await expect(page.getByRole("textbox", { name: "Редактируемый текст" }).first()).toHaveValue(localDraft);
    const reopenedJobResponsePromise = page.waitForResponse((response) => (
      response.url().includes(`/api/jobs/${generationJobId}`) && response.request().method() === "GET"
    ), { timeout: 120_000 });
    await page.goto(generationUrl.toString(), { waitUntil: "domcontentloaded" });
    const reopenedJobResponse = await reopenedJobResponsePromise;
    expect(reopenedJobResponse.ok()).toBeTruthy();
    const reopenedSnapshot = await readPublishedSnapshot(page, generationJobId!);
    expect(reopenedSnapshot.ranking).toEqual(generationSnapshot.ranking);
    expect(reopenedSnapshot.stageTrace).toEqual(generationSnapshot.stageTrace);
    await expect(page).toHaveURL(generationUrl.toString());
    await expect(page.locator(".notice[role='status']")).toContainText("Открыт опубликованный job. Локальный несохранённый черновик не применён.");
    await expect(page.getByTestId("generation-summary")).toBeHidden();
    await expect(page.getByTestId("generation-stages")).toBeHidden();
    await expect(page.getByTestId("template-diagnostics")).toBeHidden();
    expect(await page.getByTestId("audit-disclosure").evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    await expectPublishedSummary(page, reopenedSnapshot);
    await expect(page.getByRole("tab")).toHaveCount(3);
    await expect(page.getByRole("complementary", { name: "Список слайдов" })).toContainText("7 слайдов");
    await expect(page.getByRole("textbox", { name: "Редактируемый текст" }).first()).not.toHaveValue(localDraft);
    await expect(page.locator("body")).not.toContainText(localDraft);

    const exportControl = page.locator("header.topbar").getByTestId("export-control");
    await exportControl.locator(":scope > summary").click();
    const exportResults: string[] = [];
    for (const format of formats) {
      const exportResponsePromise = page.waitForResponse((response) => (
        response.url().endsWith(format.id === "pptx" ? "/api/export" : `/api/export/${format.id}`)
          && response.request().method() === "POST"
      ), { timeout: 120_000 });
      const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
      const [download, exportResponse] = await Promise.all([
        downloadPromise,
        exportResponsePromise,
        exportControl.getByRole("button", { name: format.label, exact: true }).click(),
      ]);
      expect(exportResponse.ok()).toBeTruthy();
      const exportByteLength = Number(exportResponse.headers()["content-length"] || 0);
      expect(exportByteLength).toBeGreaterThan(0);
      const artifactPath = exportResponse.headers()["x-vk-hackathon-artifact-path"];
      expect(artifactPath).toBe(`exports/balanced/${format.id}${format.extension}`);
      await expect(exportControl.getByTitle(artifactPath)).toBeVisible();

      const artifactResponse = await page.request.get(new URL(
        `/api/artifacts/${encodeURIComponent(generationJobId!)}/${artifactPath}`,
        page.url(),
      ).toString());
      expect(artifactResponse.ok()).toBeTruthy();
      expect(Number(artifactResponse.headers()["content-length"] || 0)).toBeGreaterThan(0);
      expect((await artifactResponse.body()).byteLength).toBeGreaterThan(0);

      const downloadPath = testInfo.outputPath("downloads", `${format.id}${format.extension}`);
      await fs.mkdir(path.dirname(downloadPath), { recursive: true });
      await download.saveAs(downloadPath);
      const downloadSize = (await fs.stat(downloadPath)).size;
      expect(downloadSize).toBeGreaterThan(0);
      expect(download.suggestedFilename()).toMatch(new RegExp(`${format.extension.replace(".", "\\.")}$`, "u"));
      exportResults.push(`${format.id}: ${artifactPath}, ${downloadSize} bytes (content-length ${exportByteLength})`);
    }

    const invalidSummarySourceResponse = await page.request.get(
      new URL(`/api/jobs/${encodeURIComponent(generationJobId!)}`, page.url()).toString(),
    );
    expect(invalidSummarySourceResponse.ok()).toBeTruthy();
    const invalidSummarySource = await invalidSummarySourceResponse.json() as Record<string, unknown>;
    const publishedRanking = invalidSummarySource.ranking as PublishedSnapshot["ranking"];
    removeInlineImages(invalidSummarySource);
    invalidSummarySource.ranking = {
      ...publishedRanking,
      recommendedVariant: "not-a-variant",
    };
    const invalidSummaryBody = JSON.stringify(invalidSummarySource);
    await page.route(`**/api/jobs/${generationJobId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: invalidSummaryBody,
      });
    });
    const invalidSummaryReloadPromise = page.waitForResponse((response) => (
      response.url().includes(`/api/jobs/${generationJobId}`) && response.request().method() === "GET"
    ), { timeout: 120_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    const invalidSummaryResponse = await invalidSummaryReloadPromise;
    expect(invalidSummaryResponse.ok()).toBeTruthy();
    await page.getByTestId("compare-disclosure").locator(":scope > summary").click();
    await expect(page.getByTestId("generation-summary")).toContainText(
      "Ответ сводки не прошёл проверку и не будет показан.",
    );
    await expect(page.getByRole("tab")).toHaveCount(3);
    await expect(page.getByRole("complementary", { name: "Список слайдов" })).toContainText("7 слайдов");
    await expect(page.getByRole("textbox", { name: "Редактируемый текст" }).first()).toBeVisible();

    // Seed a separate local draft with an image so the editor image path is
    // exercised even when the deterministic template renders only shapes/text.
    const imageFixture = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is unavailable.");
      context.fillStyle = "#abcdef";
      context.fillRect(0, 0, 1, 1);
      return canvas.toDataURL("image/png");
    });
    const imageDraft = structuredClone(generationPayload.presentations.visual);
    const existingShape = imageDraft.slides[0].canvas.elements.find((element: { type: string }) => element.type === "shape");
    if (!existingShape) throw new Error("Visual draft has no shape fixture.");
    imageDraft.slides[0].canvas.elements.push({
      ...existingShape, id: "browser-shape-fixture", x: 300, y: 300, w: 100, h: 80, zIndex: 101,
    });
    imageDraft.slides[0].canvas.elements.push({
      id: "browser-image-fixture", type: "image", x: 80, y: 80, w: 100, h: 80,
      zIndex: 100, locked: false, alt: "Исходное изображение", dataUrl: imageFixture,
      crop: { left: 10, right: 0, top: 0, bottom: 0 },
    });
    const imageContext = await browser.newContext({
      baseURL: "http://localhost:3030",
      acceptDownloads: true,
      httpCredentials: {
        username: process.env.VK_HACKATHON_DEMO_AUTH_USER ?? "playwright",
        password: process.env.VK_HACKATHON_DEMO_AUTH_PASSWORD ?? "playwright",
      },
    });
    const imagePage = await imageContext.newPage();
    try {
      await imagePage.goto("/");
      await imagePage.evaluate(async (draft) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("vk-tech-hackathon-drafts", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("drafts");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("drafts", "readwrite");
          transaction.objectStore("drafts").put(draft, "vk-tech-hackathon-presentation-v1");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
        database.close();
      }, imageDraft);
      await imagePage.reload();
      await imagePage.locator(".canvas-object[data-element-id='browser-shape-fixture']").click();
      const imageProperties = imagePage.getByTestId("object-properties");
      await expect(imageProperties.getByLabel("Заливка фигуры")).toBeVisible();
      await imageProperties.getByLabel("Заливка фигуры").fill("#123456");
      await expect(imageProperties.getByLabel("Заливка фигуры")).toHaveValue("#123456");
      const imageObject = imagePage.locator(".canvas-object[data-element-id='browser-image-fixture']");
      await expect(imageObject.locator("img")).toHaveAttribute("alt", "Исходное изображение");
      await imageObject.click();
      await expect(imageProperties).toContainText("Изображение");
      const imageFile = imageProperties.getByLabel("Заменить изображение");
      await imageFile.setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not a png") });
      await expect(imagePage.locator(".notice[role='status']")).toContainText("Файл не соответствует формату изображения.");
      await expect(imageObject.locator("img")).toHaveAttribute("src", imageFixture);
      await imageFile.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(8 * 1024 * 1024 + 1) });
      await expect(imagePage.locator(".notice[role='status']")).toContainText("до 8 МБ");
      await expect(imageObject.locator("img")).toHaveAttribute("src", imageFixture);
      const replacementDataUrl = await imagePage.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 2; canvas.height = 2;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D is unavailable.");
        context.fillStyle = "#123456";
        context.fillRect(0, 0, 2, 2);
        return canvas.toDataURL("image/png");
      });
      await imageFile.setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: Buffer.from(replacementDataUrl.split(",")[1], "base64") });
      await expect(imageProperties.getByLabel("Описание изображения")).toHaveValue("replacement.png");
      await expect(imageObject.locator("img")).toHaveAttribute("src", replacementDataUrl);
      await imageProperties.getByLabel("Описание изображения").fill("Локальная замена");
      await imageProperties.getByLabel("Свойство x").fill("90");
      await expect(imageProperties.getByLabel("Свойство x")).toHaveValue("90");
      const visualExport = imagePage.locator("header.topbar").getByTestId("export-control");
      await visualExport.locator(":scope > summary").click();
      const visualRequestPromise = imagePage.waitForRequest((request) => request.url().endsWith("/api/export/html") && request.method() === "POST");
      const visualResponsePromise = imagePage.waitForResponse((response) => response.url().endsWith("/api/export/html") && response.request().method() === "POST");
      const visualDownloadPromise = imagePage.waitForEvent("download");
      const [visualRequest, visualResponse, visualDownload] = await Promise.all([
        visualRequestPromise, visualResponsePromise, visualDownloadPromise,
        visualExport.getByRole("button", { name: "HTML", exact: true }).click(),
      ]);
      expect(visualResponse.ok()).toBeTruthy();
      expect(visualResponse.headers()["x-vk-hackathon-artifact-path"]).toBeUndefined();
      const editedVisual = visualRequest.postDataJSON() as LocalExportDocument;
      expect(editedVisual.jobId).toBeUndefined();
      const editedImage = editedVisual.slides?.[0].canvas.elements.find((element) => element.id === "browser-image-fixture");
      expect(editedImage).toMatchObject({ type: "image", x: 90, y: 80, w: 100, h: 80, alt: "Локальная замена", dataUrl: replacementDataUrl });
      expect(editedImage?.crop).toBeUndefined();
      expect(editedVisual.slides?.[0].canvas.elements.find((element) => element.id === "browser-shape-fixture"))
        .toMatchObject({ type: "shape", fill: "#123456" });
      await visualDownload.delete();
      await expect(imagePage.getByTestId("save-status")).toContainText("Сохранено локально");
      await imagePage.reload();
      await expect(imagePage.locator("img[alt='Локальная замена']")).toHaveAttribute("src", replacementDataUrl);
      const serverVisual = await imagePage.request.get(new URL(`/api/jobs/${generationJobId}`, imagePage.url()).toString());
      const serverVisualPayload = await serverVisual.json() as Record<string, any>;
      expect(serverVisualPayload.presentations.visual.slides[0].canvas.elements.some((element: { id: string }) => element.id === "browser-image-fixture")).toBe(false);
    } finally {
      await imageContext.close();
    }

    console.log(`[P0-E2E] analysisJobId=${analysisJobId}`);
    console.log(`[P0-E2E] generationJobId=${generationJobId}`);
    console.log(`[P0-E2E] url=${page.url()}`);
    console.log(`[P0-E2E] analysis=success, pngArtifact=success, generation=deterministic/5-slides/3-variants, ranking+four-saved-stages=after-generation-and-reload, invalid-summary=editor-preserved`);
    console.log(`[P0-E2E] localExports=${localExportResults.join("; ")}`);
    console.log(`[P0-E2E] publishedExports=${exportResults.join("; ")}`);
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  });
});
