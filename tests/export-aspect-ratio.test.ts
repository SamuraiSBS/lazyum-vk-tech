import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { normalizeContent } from "../src/lib/content-parser";
import { createPresentationPlan } from "../src/lib/planner";
import { createPresentationPptx } from "../src/lib/pptx-export";
import { renderPresentation } from "../src/lib/renderer";
import { parsePptxTemplate } from "../src/lib/template-parser";
import { createFixtureTemplate } from "./fixture-decks";

describe("PPTX export geometry", () => {
  it("keeps a portrait template's native slide aspect ratio", async () => {
    const design = await parsePptxTemplate(await createFixtureTemplate("portrait"), "portrait.pptx");
    const content = await normalizeContent("Портретная презентация", []);
    const plan = await createPresentationPlan(content, 5);
    const archive = await JSZip.loadAsync(await createPresentationPptx(renderPresentation(design, plan)));
    const presentationXml = await archive.files["ppt/presentation.xml"]?.async("string");
    const width = Number(presentationXml?.match(/cx=\"(\d+)\"/)?.[1]);
    const height = Number(presentationXml?.match(/cy=\"(\d+)\"/)?.[1]);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(width);
  });
});
