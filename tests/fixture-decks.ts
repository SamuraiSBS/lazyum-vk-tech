import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PptxGenJS = require("@studydeck/pptxgenjs") as new () => any;

export type FixtureTheme = "bright" | "dark" | "photo" | "portrait";

export async function createFixtureTemplate(theme: FixtureTheme = "bright") {
  const pptx = new PptxGenJS();
  if (theme === "portrait") {
    pptx.defineLayout({ name: "FIXTURE_PORTRAIT", width: 7.5, height: 13.333 });
    pptx.layout = "FIXTURE_PORTRAIT";
  } else {
    pptx.layout = "LAYOUT_WIDE";
  }
  pptx.author = "VK Tech hackathon tests";
  pptx.theme = {
    headFontFace: theme === "bright" ? "Aptos Display" : "Arial",
    bodyFontFace: theme === "bright" ? "Aptos" : "Calibri",
    lang: "ru-RU",
  };
  const background = theme === "bright" ? "F7F1FF" : theme === "photo" ? "EEF7FA" : "17202A";
  const ink = theme === "bright" || theme === "photo" ? "251142" : "F7F9FA";
  const accent = theme === "bright" ? "7B3DFF" : theme === "photo" ? "0077B6" : "37BFA7";
  const surface = theme === "bright" || theme === "photo" ? "FFFFFF" : "263545";

  const title = pptx.addSlide();
  title.background = { color: background };
  title.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.22, fill: { color: accent }, line: { color: accent } });
  title.addText("Шаблон " + theme, { x: 0.75, y: 1.15, w: 8.6, h: 0.72, fontFace: theme === "bright" ? "Aptos Display" : "Arial", fontSize: 36, bold: true, color: ink, margin: 0 });
  title.addText("Пример титульной композиции", { x: 0.78, y: 2.12, w: 5.4, h: 0.42, fontFace: theme === "bright" ? "Aptos" : "Calibri", fontSize: 17, color: ink, margin: 0 });
  title.addShape(pptx.ShapeType.ellipse, { x: 9.7, y: 1.05, w: 2.1, h: 2.1, fill: { color: accent, transparency: 15 }, line: { color: accent } });
  if (theme === "photo") {
    title.addImage({
      data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZ4QAAAABJRU5ErkJggg==",
      x: 9.7,
      y: 3.55,
      w: 2.1,
      h: 1.5,
    });
  }

  const cards = pptx.addSlide();
  cards.background = { color: background };
  cards.addText("Три опорных пункта", { x: 0.75, y: 0.55, w: 8.2, h: 0.55, fontFace: theme === "bright" ? "Aptos Display" : "Arial", fontSize: 27, bold: true, color: ink, margin: 0 });
  [0, 1, 2].forEach((index) => {
    const x = theme === "portrait" ? 0.75 : 0.75 + index * 4.05;
    const y = theme === "portrait" ? 2.0 + index * 3.15 : 2.0;
    cards.addShape(pptx.ShapeType.roundRect, { x, y, w: 3.35, h: 2.8, rectRadius: 0.12, fill: { color: surface }, line: { color: accent, width: 1.2 } });
    cards.addText("Пункт " + (index + 1), { x: x + 0.3, y: y + 0.45, w: 2.7, h: 0.38, fontFace: theme === "bright" ? "Aptos" : "Calibri", fontSize: 18, bold: true, color: ink, margin: 0 });
    cards.addText("Короткое пояснение для карточки", { x: x + 0.3, y: y + 1.15, w: 2.7, h: 0.78, fontFace: theme === "bright" ? "Aptos" : "Calibri", fontSize: 13, color: ink, margin: 0 });
  });
  return pptx.write({ outputType: "nodebuffer" }) as Promise<Buffer>;
}
