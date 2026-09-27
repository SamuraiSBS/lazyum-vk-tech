import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFixtureTemplate } from "./fixture-decks";

const target = path.resolve(process.cwd(), "fixtures", "templates");
await mkdir(target, { recursive: true });
await Promise.all([
  createFixtureTemplate("bright").then((buffer) => writeFile(path.join(target, "bright-cards.pptx"), buffer)),
  createFixtureTemplate("dark").then((buffer) => writeFile(path.join(target, "dark-cards.pptx"), buffer)),
  createFixtureTemplate("photo").then((buffer) => writeFile(path.join(target, "photo-led.pptx"), buffer)),
  createFixtureTemplate("portrait").then((buffer) => writeFile(path.join(target, "portrait-cards.pptx"), buffer)),
]);
console.log("Generated four deterministic PPTX template fixtures in " + target);
