import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { auditPresentation } from "../src/lib/audit";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { renderPresentation } from "../src/lib/renderer";
import { presentationDocumentSchema } from "../src/lib/schemas";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

describe("end-to-end editable PPTX MVP", () => {
  it("turns a fixture template, brief and source into a native-object PPTX", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("photo"), "fixture-template.pptx");
    const content = await normalizeContent("Презентация сервиса VK для внутреннего питча", [{
      name: "materials.txt",
      type: "text/plain",
      buffer: Buffer.from("Сервис помогает командам быстрее согласовывать решения. Пилот начинается с трёх подразделений."),
    }]);
    const plan = await createPresentationPlan(content, 10);
    const presentation = renderPresentation(design, plan, "balanced");
    const persisted = presentationDocumentSchema.parse(JSON.parse(JSON.stringify(presentation)));
    const audit = auditPresentation(persisted);
    const pptx = await createPresentationPptx(persisted);
    const archive = await JSZip.loadAsync(pptx);
    const firstSlide = await archive.files["ppt/slides/slide1.xml"]?.async("string");

    expect(persisted.slides).toHaveLength(10);
    expect(new Set(plan.slides[6]?.content).size).toBeGreaterThan(1);
    expect(persisted.slides[0]?.canvas.elements.filter((element) => element.type === "shape").length).toBeLessThan(3);
    expect(audit.slides).toHaveLength(10);
    expect(audit.passed).toBe(true);
    expect(pptx.byteLength).toBeGreaterThan(8_000);
    expect(firstSlide).toContain("<a:t>");
    expect(firstSlide).toContain("<p:sp>");
    expect(firstSlide).toContain("<p:pic>");
  });
});
