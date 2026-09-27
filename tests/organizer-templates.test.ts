import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { designSystemSchema } from "../src/lib/schemas";

const organizerTemplates = [
  "VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx",
  "VK Tech шаблон.pptx",
  "Шаблон презентации VK Education.pptx",
] as const;

describe("Organizer PPTX templates", () => {
  it.each(organizerTemplates)("extracts structural design evidence from %s", async (fileName) => {
    const templatePath = path.resolve(process.cwd(), "fixtures", "templates", "organizer", fileName);
    const design = await parsePptxTemplate(await readFile(templatePath), fileName);

    expect(() => designSystemSchema.parse(design)).not.toThrow();
    expect(design.sourceName).toBe(fileName);
    expect(design.slideSize.width).toBeGreaterThan(0);
    expect(design.slideSize.height).toBeGreaterThan(0);
    expect(design.layouts.length).toBeGreaterThan(0);
    expect(design.layouts.some((layout) => layout.elements.length > 0)).toBe(true);
    expect(design.evidence?.colors.every((entry) => entry.sources.length > 0)).toBe(true);
    expect(design.relationships?.every((relationship) => relationship.relationshipFile.endsWith(".rels"))).toBe(true);
  });
});
