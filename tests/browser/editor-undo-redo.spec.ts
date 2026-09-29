import { existsSync } from "node:fs";
import { chromium, expect, test } from "@playwright/test";
import { presentationDocumentSchema } from "../../src/lib/schemas";
import { auditPresentation } from "../../src/lib/audit";

const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim(),
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => Boolean(candidate && existsSync(candidate))) || null;

test.use({ launchOptions: { executablePath: browserExecutable || chromium.executablePath() } });
test.skip(!browserExecutable, "No Chromium-compatible browser is installed.");

const purposes = ["title", "problem", "solution", "implementation", "summary"] as const;
const fixture = presentationDocumentSchema.parse({
  version: 1,
  title: "Editor history fixture",
  variant: "balanced",
  designSystem: {
    version: 1,
    sourceName: "fixture.pptx",
    slideSize: { width: 960, height: 540, aspectRatio: 16 / 9 },
    colors: ["#FFFFFF", "#1F2937", "#4C6FFF"],
    typography: { headingFonts: ["Arial"], bodyFonts: ["Arial"], fontSizes: [24], fontWeights: [400] },
    spacing: { horizontalMargins: [48], verticalMargins: [32], gaps: [16] },
    shapes: { types: ["rect"], radii: [0], strokes: ["#4C6FFF"] },
    masters: [],
    layouts: [{
      id: "fixture-layout", name: "Fixture", source: "slide", sourceFile: "fixture.pptx",
      width: 960, height: 540, elements: [], textSlots: 1, placeholderCount: 1,
      visualSlots: 0, cardCount: 0, composition: "text", recurringElementIds: [],
    }],
    recurringElements: [], visualPatterns: [], warnings: [],
  },
  plan: {
    title: "Editor history fixture", planner: "deterministic",
    slides: purposes.map((purpose, index) => ({
      id: `slide-${index}`, purpose, title: `Slide ${index}`, content: [`Content ${index}`], visualIntent: "none",
    })),
  },
  slides: purposes.map((purpose, index) => ({
    id: `slide-${index}`, order: index + 1, purpose, title: `Slide ${index}`,
    templateLayoutId: "fixture-layout",
    canvas: { width: 960, height: 540, background: "#FFFFFF", elements: [{
      id: `text-${index}`, type: "text", x: 80, y: 80, w: 760, h: 80,
      text: `Original ${index}`, fontFamily: "Arial", fontSize: 24, fontWeight: 400,
      color: "#1F2937", align: "left", zIndex: 0, locked: false,
    }, ...(index === 0 ? [{
      id: "shape-0", type: "shape" as const, x: -12, y: 40, w: 80, h: 50,
      shape: "rect", fill: "#4C6FFF", stroke: "#4C6FFF", strokeWidth: 0,
      radius: 0, zIndex: 1, locked: false,
    }, {
      id: "image-0", type: "image" as const, x: 800, y: 300, w: 80, h: 80,
      alt: "Old image", zIndex: 2, locked: false,
    }] : [])] },
  })),
});

test("undo and redo restore text and geometry, then persist the restored draft", async ({ page }) => {
  await page.setExtraHTTPHeaders({ authorization: `Basic ${Buffer.from("editor-test:editor-test").toString("base64")}` });
  await page.addInitScript((document) => {
    if (window.localStorage.getItem("editor-history-seeded")) return;
    window.localStorage.setItem("vk-tech-hackathon-presentation-v1", JSON.stringify(document));
    window.localStorage.setItem("editor-history-seeded", "1");
  }, fixture);
  await page.goto("/");
  const text = page.getByRole("textbox", { name: "Редактируемый текст" });
  await expect(text).toHaveValue("Original 0");
  await text.fill("Edited 0");
  await expect(page.getByRole("button", { name: "Отменить" })).toBeEnabled();
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(text).toHaveValue("Original 0");
  await page.keyboard.press("Control+y");
  await expect(text).toHaveValue("Edited 0");
  await text.click();
  await page.getByRole("spinbutton", { name: "Свойство x" }).fill("120");
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByRole("spinbutton", { name: "Свойство x" })).toHaveValue("80");
  await page.locator(".audit-section").locator("xpath=ancestor::details").locator("summary").click();
  const outsideIssue = page.locator(".audit-section li").filter({ hasText: "Element extends outside the slide" });
  await outsideIssue.getByRole("button", { name: "Игнорировать" }).click();
  await expect(outsideIssue).toContainText("ignored");
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(outsideIssue).not.toContainText("ignored");
  await page.locator('[data-element-id="image-0"]').click();
  await page.getByRole("textbox", { name: "Описание изображения" }).fill("New image");
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByRole("textbox", { name: "Описание изображения" })).toHaveValue("Old image");
  await page.locator('input[aria-label="Заменить изображение"]').setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(page.getByRole("textbox", { name: "Описание изображения" })).toHaveValue("replacement.png");
  await page.getByRole("button", { name: "Отменить" }).click();
  await expect(page.getByRole("textbox", { name: "Описание изображения" })).toHaveValue("Old image");
  await expect(page.getByText("Сохранено локально")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Редактируемый текст" })).toHaveValue("Edited 0");
});

test("image replacement finishes in its starting variant after a switch", async ({ page }) => {
  const presentations = {
    balanced: fixture,
    compact: presentationDocumentSchema.parse({ ...fixture, variant: "compact" }),
    visual: presentationDocumentSchema.parse({ ...fixture, variant: "visual" }),
  };
  const published = JSON.stringify(presentations);
  const exportBodies: unknown[] = [];
  let jobWrites = 0;
  await page.setExtraHTTPHeaders({ authorization: `Basic ${Buffer.from("editor-test:editor-test").toString("base64")}` });
  await page.route("**/api/jobs/editor-history-fixture", async (route) => {
    if (route.request().method() !== "GET") jobWrites++;
    await route.fulfill({ json: {
      manifest: {}, designSystem: fixture.designSystem, presentations,
      audits: Object.fromEntries(Object.entries(presentations).map(([key, document]) => [key, auditPresentation(document)])),
      ranking: null, stageTrace: null,
    } });
  });
  await page.route("**/api/export", async (route) => {
    exportBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/octet-stream", body: "fixture export" });
  });
  await page.addInitScript(() => {
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      if (this.size !== 16) return original.call(this);
      const blob = this;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        (window as Window & { releaseImageRead?: () => void; imageReadBlocked?: boolean }).imageReadBlocked = true;
        (window as Window & { releaseImageRead?: () => void }).releaseImageRead = () => {
          original.call(blob).then(resolve, reject);
        };
      });
    };
  });
  await page.goto("/?job=editor-history-fixture");
  await expect(page.getByRole("tab", { name: /Balanced/ })).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-element-id="image-0"]').click();
  await page.locator('input[aria-label="Заменить изображение"]').setInputFiles({
    name: "delayed.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64"),
  });
  await page.waitForFunction(() => (window as Window & { imageReadBlocked?: boolean }).imageReadBlocked === true);
  await page.getByRole("tab", { name: /Visual/ }).click();
  await expect(page.getByRole("tab", { name: /Visual/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => (window as Window & { releaseImageRead?: () => void }).releaseImageRead?.());
  await expect(page.getByRole("button", { name: "Отменить" })).toBeDisabled();
  await page.locator('[data-element-id="image-0"]').click();
  await expect(page.getByRole("textbox", { name: "Описание изображения" })).toHaveValue("Old image");
  await expect(page.getByText("Сохранено локально")).toBeVisible();
  await expect.poll(() => page.evaluate(() => new Promise<string | null>((resolve, reject) => {
    const open = indexedDB.open("vk-tech-hackathon-drafts", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction("drafts", "readonly").objectStore("drafts").get("vk-tech-hackathon-presentation-v1");
      request.onsuccess = () => { resolve((request.result as { variant?: string } | undefined)?.variant || null); database.close(); };
      request.onerror = () => { reject(request.error); database.close(); };
    };
  }))).toBe("visual");
  await page.getByTestId("export-control").locator("summary").click();
  await page.getByRole("button", { name: "PPTX" }).click();
  await expect.poll(() => exportBodies.length).toBe(1);
  expect(exportBodies[0]).toEqual({ jobId: "editor-history-fixture", variant: "visual" });
  await page.getByRole("tab", { name: /Balanced/ }).click();
  await page.locator('[data-element-id="image-0"]').click();
  await expect(page.getByRole("textbox", { name: "Описание изображения" })).toHaveValue("delayed.png");
  await expect(page.getByRole("button", { name: "Отменить" })).toBeEnabled();
  if (await page.getByTestId("export-control").getAttribute("open") === null) {
    await page.getByTestId("export-control").locator("summary").click();
  }
  await page.getByRole("button", { name: "PPTX" }).click();
  await expect.poll(() => exportBodies.length).toBe(2);
  expect((exportBodies[1] as typeof fixture).slides[0].canvas.elements.find((element) => element.id === "image-0")).toMatchObject({ alt: "delayed.png" });
  expect(JSON.stringify(presentations)).toBe(published);
  expect(jobWrites).toBe(0);
});
