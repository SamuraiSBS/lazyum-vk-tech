import { existsSync } from "node:fs";
import { chromium, expect, test, type Page } from "@playwright/test";
import {
  presentationDocumentSchema,
  type PresentationDocument,
} from "../../src/lib/schemas";

const DRAFT_KEY = "vk-tech-hackathon-presentation-v1";
const DRAFT_SEED_KEY = "vk-tech-hackathon-audit-actions-e2e-seeded";
const DATABASE_NAME = "vk-tech-hackathon-drafts";
const STORE_NAME = "drafts";
const OUTSIDE_SLIDE_MESSAGE = "Element extends outside the slide";
const TEXT_OVERFLOW_MESSAGE = "Text exceeds element bounds";
const browserExecutable = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim(),
  chromium.executablePath(),
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => Boolean(candidate && existsSync(candidate))) || null;

test.use({
  launchOptions: {
    executablePath: browserExecutable || chromium.executablePath(),
  },
});

const fixturePurposes = [
  "title",
  "problem",
  "solution",
  "implementation",
  "summary",
] as const;

const fixtureDocument: PresentationDocument = presentationDocumentSchema.parse({
  version: 1,
  title: "Audit actions browser fixture",
  variant: "balanced",
  designSystem: {
    version: 1,
    sourceName: "Audit actions fixture",
    slideSize: { width: 960, height: 540, aspectRatio: 16 / 9 },
    colors: ["#FFFFFF", "#1F2937", "#4C6FFF"],
    typography: {
      headingFonts: ["Fixture Sans"],
      bodyFonts: ["Fixture Sans"],
      fontSizes: [20, 24, 28],
      fontWeights: [400, 700],
    },
    spacing: { horizontalMargins: [48], verticalMargins: [32], gaps: [16] },
    shapes: { types: ["rect"], radii: [0], strokes: ["#4C6FFF"] },
    masters: [],
    layouts: [
      {
        id: "fixture-layout",
        name: "Fixture layout",
        source: "slide",
        sourceFile: "fixture.pptx",
        width: 960,
        height: 540,
        elements: [],
        textSlots: 1,
        placeholderCount: 1,
        visualSlots: 0,
        cardCount: 0,
        composition: "text",
        recurringElementIds: [],
      },
    ],
    recurringElements: [],
    visualPatterns: [],
    warnings: [],
  },
  plan: {
    title: "Audit actions browser fixture",
    planner: "deterministic",
    slides: fixturePurposes.map((purpose, index) => ({
      id: `fixture-slide-${index + 1}`,
      purpose,
      title: `Fixture slide ${index + 1}`,
      content: [`Content for fixture slide ${index + 1}`],
      visualIntent: "none",
    })),
  },
  slides: fixturePurposes.map((purpose, index) => ({
    id: `fixture-slide-${index + 1}`,
    order: index + 1,
    purpose,
    title: `Fixture slide ${index + 1}`,
    templateLayoutId: "fixture-layout",
    canvas: {
      width: 960,
      height: 540,
      background: "#FFFFFF",
      elements:
        index === 0
          ? [
              {
                id: "safe-fix-shape",
                type: "shape",
                x: -12,
                y: 40,
                w: 80,
                h: 50,
                shape: "rect",
                fill: "#4C6FFF",
                stroke: "#4C6FFF",
                strokeWidth: 0,
                radius: 0,
                zIndex: 0,
                locked: false,
              },
              {
                id: "ignored-text-overflow",
                type: "text",
                x: 140,
                y: 120,
                w: 72,
                h: 8,
                text: "A sentence that must wrap into several lines",
                fontFamily: "Fixture Sans",
                fontSize: 26,
                fontWeight: 400,
                color: "#1F2937",
                align: "left",
                zIndex: 1,
                locked: false,
              },
            ]
          : [
              {
                id: `fixture-text-${index + 1}`,
                type: "text",
                x: 80,
                y: 80,
                w: 760,
                h: 80,
                text: `Fixture slide ${index + 1}`,
                fontFamily: "Fixture Sans",
                fontSize: 24,
                fontWeight: 400,
                color: "#1F2937",
                align: "left",
                zIndex: 0,
                locked: false,
              },
            ],
    },
  })),
});

async function readPersistedAuditActions(page: Page): Promise<string[]> {
  return page.evaluate(
    async ({ databaseName, storeName, draftKey }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      try {
        const draft = await new Promise<unknown>((resolve, reject) => {
          const request = database
            .transaction(storeName, "readonly")
            .objectStore(storeName)
            .get(draftKey);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        if (!draft || typeof draft !== "object" || !("auditDecisions" in draft)) {
          return [];
        }
        const decisions = (draft as { auditDecisions?: unknown }).auditDecisions;
        return Array.isArray(decisions)
          ? decisions.flatMap((decision) =>
              decision && typeof decision === "object" && "action" in decision
                ? [String((decision as { action: unknown }).action)]
                : [],
            )
          : [];
      } finally {
        database.close();
      }
    },
    { databaseName: DATABASE_NAME, storeName: STORE_NAME, draftKey: DRAFT_KEY },
  );
}

test.describe("P0-8 audit actions", () => {
  test.skip(!browserExecutable, "BLOCKED: no Playwright Chromium, Chrome, or Edge executable is installed.");

  test("applies a safe fix, ignores a separate error, and restores both actions after reload", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(
      ({ draftKey, seedKey, document }) => {
        if (window.localStorage.getItem(seedKey) === "seeded") return;
        window.localStorage.setItem(draftKey, JSON.stringify(document));
        window.localStorage.setItem(seedKey, "seeded");
      },
      { draftKey: DRAFT_KEY, seedKey: DRAFT_SEED_KEY, document: fixtureDocument },
    );

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "Восстановлен локально сохранённый черновик.",
    );

    const auditSection = page.locator(".audit-section");
    const auditIssues = auditSection.locator("li");
    await expect(auditIssues).toHaveCount(2);
    await expect(page.getByText("Нужна проверка", { exact: true })).toBeVisible();

    const outsideSlideIssue = auditIssues.filter({ hasText: OUTSIDE_SLIDE_MESSAGE });
    await expect(outsideSlideIssue).toBeVisible();
    const bulkFixButton = auditSection.getByRole("button", {
      name: /Исправить все безопасные/u,
    });
    await expect(bulkFixButton).toBeEnabled();
    await outsideSlideIssue
      .getByRole("button", { name: "Исправить", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Исправление применено и audit выполнен повторно.",
    );
    await expect(auditIssues.filter({ hasText: OUTSIDE_SLIDE_MESSAGE })).toHaveCount(0);
    await expect(bulkFixButton).toBeDisabled();
    await expect(page.getByText(TEXT_OVERFLOW_MESSAGE, { exact: true })).toBeVisible();
    await expect(page.getByText("Нужна проверка", { exact: true })).toBeVisible();

    const overflowIssue = auditIssues.filter({ hasText: TEXT_OVERFLOW_MESSAGE });
    await overflowIssue
      .getByRole("button", { name: "Игнорировать", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Замечание помечено как ignored и audit выполнен повторно.",
    );
    await expect(overflowIssue).toContainText("ignored");
    await expect(page.getByText("Canvas проверен", { exact: true })).toBeVisible();
    await expect(auditSection.locator(".audit-count")).toHaveClass(/audit-ok/u);
    await expect(auditIssues).toHaveCount(1);

    await expect
      .poll(async () => (await readPersistedAuditActions(page)).sort(), {
        timeout: 15_000,
      })
      .toEqual(["fix", "ignore"]);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Audit", exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText(
      "Восстановлен локально сохранённый черновик.",
    );

    const reopenedAuditIssues = page.locator(".audit-section li");
    await expect(
      reopenedAuditIssues.filter({ hasText: OUTSIDE_SLIDE_MESSAGE }),
    ).toHaveCount(0);
    const reopenedOverflowIssue = reopenedAuditIssues.filter({
      hasText: TEXT_OVERFLOW_MESSAGE,
    });
    await expect(reopenedOverflowIssue).toContainText("ignored");
    await expect(page.getByText("Canvas проверен", { exact: true })).toBeVisible();
    await expect(page.locator(".audit-section .audit-count")).toHaveClass(/audit-ok/u);
    await expect(reopenedAuditIssues).toHaveCount(1);
  });
});
