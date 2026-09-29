import JSZip from "jszip";
import { expect, test } from "@playwright/test";
import { createFixtureTemplate } from "../fixture-decks";

const affectedSource = "ppt/slides/slide1.xml";
const missingTarget = "ppt/slideLayouts/missing-layout.xml";

test.use({
  httpCredentials: {
    username: process.env.VK_HACKATHON_DEMO_AUTH_USER ?? "",
    password: process.env.VK_HACKATHON_DEMO_AUTH_PASSWORD ?? "",
  },
  launchOptions: process.env.VK_HACKATHON_PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.VK_HACKATHON_PLAYWRIGHT_EXECUTABLE }
    : {},
});

async function fixtureWithBrokenLayoutRelationship() {
  const zip = await JSZip.loadAsync(await createFixtureTemplate("bright"));
  const relationshipFile = "ppt/slides/_rels/slide1.xml.rels";
  const relationship = zip.file(relationshipFile);
  if (!relationship) throw new Error("Fixture relationship part is missing");
  const original = await relationship.async("string");
  const match = original.match(/<Relationship\b(?=[^>]*\bId="([^"]+)")(?=[^>]*\bType="([^"]*\/slideLayout)")[^>]*\bTarget="\.\.\/slideLayouts\/slideLayout\d+\.xml"[^>]*\/?\s*>/u);
  if (!match) throw new Error("Fixture slide layout relationship is missing");
  zip.file(relationshipFile, original.replace(match[0], match[0].replace(
    /Target="[^"]+"/u, 'Target="../slideLayouts/missing-layout.xml"',
  )));
  return {
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
    warning: "Invalid slide layout relationship target: sourceFile=" + affectedSource +
      "; relationshipId=" + match[1] + "; relationshipType=" + match[2] + "; target=" + missingTarget,
  };
}

test("shows a bounded score with each retained layout preview", async ({ page }) => {
  const fixture = await fixtureWithBrokenLayoutRelationship();
  await page.goto("/");
  await page.getByLabel("Тема / brief").fill("Проверка диагностики макетов");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.locator("#template-file").setInputFiles({
    name: "broken-layout.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: fixture.buffer,
  });
  const analyzeResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/analyze") && response.request().method() === "POST",
  { timeout: 60_000 });
  await page.getByRole("button", { name: "Проверить шаблон", exact: true }).click();
  const analyzeResponse = await analyzeResponsePromise;
  expect(analyzeResponse.ok()).toBe(true);
  const design = (await analyzeResponse.json()).designSystem as {
    layouts: Array<{ sourceFile?: string; confidence?: number; parserWarnings?: string[] }>;
  };
  expect(design.layouts.length).toBeGreaterThan(0);
  for (const layout of design.layouts) {
    expect(layout.confidence).toBeGreaterThanOrEqual(0);
    expect(layout.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(layout.parserWarnings)).toBe(true);
  }

  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.getByLabel("Количество слайдов").selectOption("5");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  const generationResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/generate") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Создать презентацию", exact: true }).click();
  expect((await generationResponsePromise).ok()).toBe(true);
  await page.getByTestId("diagnostics-disclosure").locator("summary").first().click();
  const previews = page.locator(".layout-previews .layout-preview");
  await expect(previews).toHaveCount(Math.min(4, design.layouts.length));
  await expect(previews.first().getByTestId("layout-confidence"))
    .toContainText(/^Уверенность: \d+%$/);
  const affectedIndex = design.layouts.findIndex((layout) => layout.sourceFile === affectedSource);
  expect(affectedIndex).toBeGreaterThanOrEqual(0);
  expect(affectedIndex).toBeLessThan(4);
  expect(design.layouts[affectedIndex].parserWarnings).toContain(fixture.warning);
  const displayedWarnings = previews.nth(affectedIndex).getByTestId("layout-parser-warnings");
  await expect(displayedWarnings).toBeVisible();
  await expect(displayedWarnings.locator("li").first()).toHaveText(fixture.warning);
});
