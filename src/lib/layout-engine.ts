import type { DesignSystem, LayoutVariant, PlanSlide, TemplateLayout } from "./schemas";
import { measureTextForBox } from "./audit";

const MAX_RENDERABLE_LAYOUT_ELEMENTS = 180;
const TEXT_SLOT_MIN_WIDTH = 0.12;
const TEXT_SLOT_MIN_HEIGHT = 0.05;
const MIN_READABLE_TEXT_FONT_SIZE = 14;
const GRAPHIC_MIN_AREA_RATIO = 0.003;
const GRAPHIC_BACKGROUND_AREA_RATIO = 0.82;
const LAYOUT_CLEARANCE_SCORE = 3_500;
const ROLE_COMPOSITION_SCORE = 8_000;
const NAMED_ROLE_SCORE = 8_000;
const ENDING_ROLE_SCORE = 15_000;
// The parser rounds PPTX EMU geometry to whole pixels, so allow at most that
// rounding error at the right and bottom canvas edges.
const CANVAS_EDGE_TOLERANCE = 1;

type NarrativePosition = {
  slideIndex: number;
  slideCount: number;
  layoutUseCounts?: ReadonlyMap<string, number>;
};

type NarrativeRole = "opening" | "ending" | "timeline" | "cards" | "diagram" | "content";

export function chooseTemplateLayout(
  designSystem: DesignSystem,
  slide: PlanSlide,
  variant: LayoutVariant = "balanced",
  preferredLayoutId?: string,
  narrativePosition?: NarrativePosition,
): TemplateLayout {
  const layouts = designSystem.layouts.map(normalizeTemplateLayout);
  const renderableLayouts = layouts.filter((layout) => layout.elements.length <= MAX_RENDERABLE_LAYOUT_ELEMENTS);
  const candidates = renderableLayouts.length ? renderableLayouts : layouts;
  if (preferredLayoutId) {
    const preferred = layouts.find((layout) => layout.id === preferredLayoutId);
    if (!preferred) throw new Error(`Unknown template layout reference: ${preferredLayoutId}`);
    if (preferred.elements.length <= MAX_RENDERABLE_LAYOUT_ELEMENTS || !renderableLayouts.length) return preferred;
    throw new Error(`Template layout reference is not renderable: ${preferredLayoutId}`);
  }
  const profileFeatures = profileFeaturesFor(layouts);
  const role = narrativeRoleFor(slide, narrativePosition);
  const scored = candidates
    .map((layout) => ({
      layout,
      score: scoreLayout(layout, slide, variant, profileFeatures.get(layout.id), role),
      uses: narrativePosition?.layoutUseCounts?.get(layout.id) || 0,
    }))
    .sort((left, right) => right.score - left.score
      || left.uses - right.uses
      || compareLayoutIds(left.layout.id, right.layout.id));
  return scored[0]?.layout || candidates[0] || designSystem.layouts[0];
}

function scoreLayout(
  layout: TemplateLayout,
  slide: PlanSlide,
  variant: LayoutVariant,
  profile = DEFAULT_PROFILE_FEATURES,
  role: NarrativeRole,
) {
  let score = 0;
  const desired = desiredComposition(slide, role);
  if (layout.composition === desired) score += 80;
  score += roleCompositionScore(layout, slide, role);
  if (slide.visualIntent === "cards" && layout.cardCount >= Math.min(3, slide.content.length)) score += 58;
  if (slide.visualIntent === "timeline" && layout.composition === "timeline") score += 58;
  if ((slide.visualIntent === "image" || slide.visualIntent === "diagram") && profile.usableVisualSlots > 0) score += 42;
  if (slide.content.length <= Math.max(1, profile.usableTextSlots + layout.cardCount)) score += 22;
  if (profile.inCanvasElementCount > 1) score += 6;
  score += roleTextCapacityScore(layout, slide, role);
  if (slide.purpose !== "title") {
    const visualTextDemand = variant === "visual" && slide.content.length > 0
      ? visualTextDemandScore(layout, slide)
      : 0;
    score += variantProfileScore(variant, profile, slide.content.length > 0, visualTextDemand);
  }
  const collisionRisk = layoutTextCollisionRisk(layout, slide, variant);
  score += collisionRisk === 0
    ? LAYOUT_CLEARANCE_SCORE
    : -LAYOUT_CLEARANCE_SCORE - collisionRisk * LAYOUT_CLEARANCE_SCORE;
  score += rasterBackgroundRoleScore(layout, slide, role);
  if (role === "opening") score += coverArtworkSeparationScore(layout);
  if (role === "cards") score += cardArtworkAlignmentScore(layout) + cardLineInterferenceScore(layout);
  const cardItems = splitSingleCardStatement(slide.content, layout.cardCount);
  if (role === "cards" && layout.cardCount >= 2 && cardItems.length > layout.cardCount) {
    score -= ROLE_COMPOSITION_SCORE * 4;
  }
  return score;
}

function coverArtworkSeparationScore(layout: TemplateLayout) {
  const title = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0))[0];
  if (!title) return 0;
  const art = layout.elements.filter((element) => element.type === "image"
    && Boolean(element.imageDataUrl)
    && isInsideCanvas(element, layout)
    && (element.w * element.h) / (layout.width * layout.height) >= 0.08
    && (element.w * element.h) / (layout.width * layout.height) < GRAPHIC_BACKGROUND_AREA_RATIO);
  if (!art.length) return 0;
  const titleCenter = title.x + title.w / 2;
  const artCenter = art.reduce((sum, element) => sum + element.x + element.w / 2, 0) / art.length;
  const separation = Math.abs(titleCenter - artCenter) / layout.width;
  return separation >= 0.2 ? 20_000 : -900;
}

function cardArtworkAlignmentScore(layout: TemplateLayout) {
  if (layout.cardCount < 2) return 0;
  const slots = layout.elements.filter((element) => isRenderableTextSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y);
  const title = slots[0];
  if (!title) return 0;
  const cards = reusableCardTextSlots(layout, slots.filter((slot) => slot.id !== title.id
    && slot.y >= title.y + title.h && !overlaps(slot, title)));
  const icons = layout.elements.filter((element) => element.type === "image"
    && Boolean(element.imageDataUrl)
    && isInsideCanvas(element, layout)
    && (element.w * element.h) / (layout.width * layout.height) < 0.08);
  if (cards.length < 2 || icons.length < 2) return 0;
  const aligned = cards.filter((slot) => icons.some((icon) => {
    const center = icon.x + icon.w / 2;
    return center >= slot.x && center <= slot.x + slot.w;
  })).length;
  return aligned < Math.min(cards.length, icons.length) ? -9_000 : 500;
}

function cardLineInterferenceScore(layout: TemplateLayout) {
  const textSlots = layout.elements.filter((element) => isRenderableTextSlot(element, layout));
  const crossingLine = layout.elements.some((element) => (
    (element.type === "line" || element.type === "shape" || element.type === "image")
    && element.w >= layout.width * 0.55
    && element.h <= layout.height * 0.025
    && textSlots.some((slot) => slot.y < element.y && slot.y + slot.h > element.y
      && slot.x < element.x + element.w && slot.x + slot.w > element.x)
  ));
  return crossingLine ? -ROLE_COMPOSITION_SCORE * 5 : 0;
}

function rasterBackgroundRoleScore(layout: TemplateLayout, slide: PlanSlide, role: NarrativeRole) {
  if (role === "opening" || role === "ending" || role === "timeline") return 0;
  const hasFullBleedRaster = layout.elements.some((element) => (
    element.type === "image"
    && Boolean(element.imageDataUrl)
    && isInsideCanvas(element, layout)
    && (element.w * element.h) / (layout.width * layout.height) >= GRAPHIC_BACKGROUND_AREA_RATIO
  ));
  if (!hasFullBleedRaster) return 0;
  if (role === "cards") return -ROLE_COMPOSITION_SCORE * 5;

  const textSlots = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
  const title = textSlots[0];
  if (!title) return 0;
  const bodySlots = textSlots.filter((slot) => slot.id !== title.id
    && slot.y >= title.y + title.h
    && !overlaps(slot, title));
  const broadBodySlot = bodySlots.some((slot) => (
    slot.w >= layout.width * 0.7
    && slot.h >= layout.height * 0.25
  ));
  if (!broadBodySlot) return 0;

  // Keep image compositions available when they are the only viable choice,
  // while preferring a layout whose content area does not cross a full-slide
  // illustration when another source composition fits the narrative role.
  return slide.visualIntent === "image" ? -2_200 : -5_000;
}

function roleTextCapacityScore(layout: TemplateLayout, slide: PlanSlide, role: NarrativeRole) {
  if (!slide.content.length) return 0;
  if (role === "opening") return 0;
  // Timeline labels are laid out separately by the renderer. Source timeline
  // labels therefore do not need the same body-slot gate as prose layouts.
  if (role === "timeline") return 0;

  const slots = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
  const titleSlot = slots[0];
  if (!titleSlot) return -8_000;
  const bodySlots = slots.filter((slot) => slot.id !== titleSlot.id
    && slot.y >= titleSlot.y + titleSlot.h
    && !overlaps(slot, titleSlot));
  if (!bodySlots.length) return role === "ending" ? -1_800 : -8_000;

  const cardItems = splitSingleCardStatement(slide.content, layout.cardCount);
  if (role === "cards" && layout.cardCount >= 2 && cardItems.length >= 2) {
    const cardSlots = reusableCardTextSlots(layout, bodySlots);
    const requiredSlots = cardItems.length;
    const cardContent = packVisualCardContent(cardItems, requiredSlots);
    if (cardSlots.length < requiredSlots
      || !cardContent.every((content, index) => textFitsSlot(content, cardSlots[index]!))) return -8_000;
    return 1_800;
  }

  if (layout.cardCount >= 2 && slide.content.length >= 2) {
    const cardSlots = reusableCardTextSlots(layout, bodySlots);
    const requiredSlots = Math.min(slide.content.length, layout.cardCount);
    const cardContent = packVisualCardContent(slide.content, requiredSlots);
    if (cardSlots.length < requiredSlots
      || !cardContent.every((content, index) => textFitsSlot(content, cardSlots[index]!))) return -8_000;
    return 500;
  }

  const bodyText = slide.content.length > 1
    ? slide.content.map((item) => "• " + item).join("\n")
    : slide.content[0] || "";
  if (bodySlots.some((slot) => textFitsSlot(bodyText, slot))) return 1_600;
  if (bodySlots.some((slot) => textFitsSlot(slide.content.slice(0, 3).join(" · "), slot))) return 800;
  return -5_000;
}

function narrativeRoleFor(slide: PlanSlide, position?: NarrativePosition): NarrativeRole {
  if (position?.slideIndex === 0) return "opening";
  if (position && position.slideCount > 0 && position.slideIndex === position.slideCount - 1) return "ending";
  if (slide.purpose === "title") return "opening";
  if (slide.purpose === "summary" || slide.purpose === "next_steps") return "ending";
  if (slide.visualIntent === "timeline") return "timeline";
  if (slide.visualIntent === "cards" || slide.visualIntent === "metrics") return "cards";
  if (slide.visualIntent === "diagram" || slide.visualIntent === "image") return "diagram";
  return "content";
}

function roleCompositionScore(layout: TemplateLayout, slide: PlanSlide, role: NarrativeRole) {
  const roleTarget = desiredComposition(slide, role);
  const compositionAnchor = layout.composition === roleTarget ? ROLE_COMPOSITION_SCORE : 0;
  const namedRole = semanticLayoutRole(layout.name);
  const semanticAnchor = semanticLayoutRoleScore(namedRole, role);
  if (role === "opening") {
    return semanticAnchor + compositionAnchor + (layout.composition === "title" ? 260 : -150)
      + (layout.cardCount === 0 ? 28 : -Math.min(90, layout.cardCount * 18))
      + (layout.textSlots <= 3 ? 24 : 0)
      + titleSlotFitScore(layout, slide);
  }

  if (role === "ending") {
    const nonOpeningComposition = layout.composition === "title" ? -180 : 35;
    const contentFit = layout.cardCount >= 2 && slide.content.length >= 2
      ? Math.min(72, layout.cardCount * 18)
      : layout.composition === "text" || layout.composition === "split"
        ? 50
        : 0;
    return semanticAnchor + compositionAnchor + nonOpeningComposition + contentFit + titleAndBodySlotScore(layout, slide)
      + centeredClosingCompositionScore(layout);
  }

  const avoidsCoverComposition = layout.composition === "title" ? -145 : 0;
  if (role === "timeline" && layout.composition === "timeline") return semanticAnchor + compositionAnchor + avoidsCoverComposition + 95;
  if (role === "cards" && layout.composition === "cards") {
    const slots = layout.elements
      .filter((element) => isRenderableTextSlot(element, layout))
      .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
    const titleSlot = slots[0];
    const bodySlots = titleSlot
      ? slots.filter((slot) => slot.id !== titleSlot.id
        && slot.y >= titleSlot.y + titleSlot.h
        && !overlaps(slot, titleSlot))
      : [];
    const cardItems = splitSingleCardStatement(slide.content, layout.cardCount);
    const requiredSlots = cardItems.length;
    const cardContent = packVisualCardContent(cardItems, requiredSlots);
    const fits = requiredSlots > 0
      && requiredSlots <= layout.cardCount
      && reusableCardTextSlots(layout, bodySlots).length >= requiredSlots
      && cardContent.every((content, index) => textFitsSlot(content, reusableCardTextSlots(layout, bodySlots)[index]!));
    return semanticAnchor + (fits ? compositionAnchor + avoidsCoverComposition + 80 : -ROLE_COMPOSITION_SCORE);
  }
  if (role === "diagram" && layout.composition === "visual") return semanticAnchor + compositionAnchor + avoidsCoverComposition + 80;
  if (role === "content" && (layout.composition === "split" || layout.composition === "text")) {
    return semanticAnchor + compositionAnchor + 45;
  }
  return semanticAnchor + compositionAnchor + avoidsCoverComposition;
}

function semanticLayoutRoleScore(namedRole: NarrativeRole | undefined, role: NarrativeRole) {
  if (namedRole === role) return role === "ending" ? ENDING_ROLE_SCORE : NAMED_ROLE_SCORE;
  if (namedRole === "opening" || namedRole === "ending") return -ENDING_ROLE_SCORE;
  return namedRole ? -180 : 0;
}

/**
 * Some template parsers conservatively tag a large group of source pages as
 * timelines. Correct those broad classifications from generic layout labels
 * and reusable shape/slot geometry, without consulting filenames, ids or
 * palette values.
 */
function normalizeTemplateLayout(layout: TemplateLayout): TemplateLayout {
  const repeatedPanels = repeatedTextPanels(layout);
  const repeatedTextCards = repeatedTextSlotCount(layout);
  const namedRole = semanticLayoutRole(layout.name);
  const timelineGeometry = hasTimelineGeometry(layout);
  let composition = layout.composition;
  let cardCount = Math.max(layout.cardCount, repeatedPanels, repeatedTextCards);

  if (namedRole === "opening") {
    composition = "title";
    cardCount = 0;
  } else if (namedRole === "timeline" && timelineGeometry) {
    composition = "timeline";
  } else if (layout.composition === "timeline" && timelineGeometry) {
    composition = "timeline";
  } else if (namedRole === "cards" && repeatedPanels >= 2) {
    composition = "cards";
    cardCount = repeatedPanels;
  } else if (layout.composition === "timeline" && !timelineGeometry) {
    if (repeatedPanels >= 2) {
      composition = "cards";
      cardCount = repeatedPanels;
    } else if (namedRole === "ending") {
      composition = structuralComposition(layout);
    } else if (namedRole === "diagram") {
      composition = "visual";
    } else if (namedRole === "content") {
      composition = structuralComposition(layout);
    } else if (namedRole === "timeline") {
      composition = "timeline";
    } else {
      composition = structuralComposition(layout);
    }
  } else if ((repeatedPanels >= 2 || repeatedTextCards >= 3) && composition !== "title") {
    composition = "cards";
    cardCount = Math.max(repeatedPanels, repeatedTextCards);
  }

  return composition === layout.composition && cardCount === layout.cardCount
    ? layout
    : { ...layout, composition, cardCount };
}

function semanticLayoutRole(name: string): NarrativeRole | undefined {
  const label = name.normalize("NFKC").toLowerCase().replace(/[._-]+/gu, " ");
  if (/\b(?:cover|opening|title\s*(?:slide|page)?|front\s*page)\b|обложк|титульн|открывающ|начальн|первый\s+слайд/u.test(label)) {
    return "opening";
  }
  if (/\b(?:closing|ending|thank\s*you|summary|conclusion|final(?:e)?|wrap\s*up)\b|итог|заключ|финал|заверш|спасибо|до\s+встречи/u.test(label)) {
    return "ending";
  }
  if (/\b(?:timeline|roadmap|milestones?|process\s*flow)\b|таймлайн|хронолог|этап|последовательност/u.test(label)) {
    return "timeline";
  }
  if (/\b(?:cards?|grid|list|metrics?|features?)\b|карточ|список|преимуществ|метрик/u.test(label)) {
    return "cards";
  }
  if (/\b(?:diagram|chart|flowchart|graph|map)\b|диаграмм|схем|график/u.test(label)) {
    return "diagram";
  }
  if (/\b(?:content|body|text|paragraph|article)\b|содержан|основной\s+текст|заголовок\s*[+и]\s*текст/u.test(label)) {
    return "content";
  }
  return undefined;
}

function structuralComposition(layout: TemplateLayout): TemplateLayout["composition"] {
  const textSlots = layout.elements.filter((element) => isRenderableTextSlot(element, layout));
  const visualSlots = layout.elements.filter((element) => (
    ["image", "chart", "table"].includes(element.type)
    && isInsideCanvas(element, layout)
    && (element.w * element.h) / (layout.width * layout.height) >= 0.025
  ));
  const bodySlots = textSlots.filter((slot) => (
    slot.y > layout.height * 0.23 && slot.h > layout.height * 0.075
  ));
  if (visualSlots.length && bodySlots.some((slot) => visualSlots.some((visual) => (
    Math.abs((slot.x + slot.w / 2) - (visual.x + visual.w / 2)) > layout.width * 0.18
  )))) return "visual";

  const contentColumns = bodySlots.map((slot) => slot.x + slot.w / 2).sort((left, right) => left - right);
  if (contentColumns.some((center, index) => index > 0 && center - contentColumns[index - 1]! > layout.width * 0.2)) {
    return "split";
  }
  if (textSlots.length >= 2) return "text";
  if (textSlots.length === 1) return "title";
  return "blank";
}

function repeatedTextPanels(layout: TemplateLayout) {
  const slots = layout.elements.filter((element) => isRenderableTextSlot(element, layout));
  const panels = layout.elements.filter((element) => (
    (element.type === "shape" || ((element.type === "text" || element.type === "placeholder") && !element.text.trim()))
    && Boolean(element.fill)
    && isInsideCanvas(element, layout)
    && (element.w * element.h) / (layout.width * layout.height) >= 0.025
    && (element.w * element.h) / (layout.width * layout.height) <= 0.36
    && slots.some((slot) => slot.id !== element.id && rectContains(element, slot))
  ));
  const groups: typeof panels[] = [];
  for (const panel of panels) {
    const group = groups.find((existing) => {
      const reference = existing[0];
      if (!reference) return false;
      const similarSize = Math.abs(panel.w / layout.width - reference.w / layout.width) <= 0.08
        && Math.abs(panel.h / layout.height - reference.h / layout.height) <= 0.08;
      const sameRow = Math.abs(panel.y - reference.y) <= layout.height * 0.08;
      const sameColumn = Math.abs(panel.x - reference.x) <= layout.width * 0.08;
      return similarSize && (sameRow || sameColumn);
    });
    if (group) group.push(panel);
    else groups.push([panel]);
  }
  return Math.max(0, ...groups.map((group) => group.length));
}

function repeatedTextSlotCount(layout: TemplateLayout) {
  const slots = layout.elements.filter((element) => (
    isRenderableTextSlot(element, layout)
    && element.y >= layout.height * 0.2
    && element.h >= layout.height * 0.09
    && element.w <= layout.width * 0.42
  ));
  const groups: typeof slots[] = [];
  for (const slot of slots) {
    const group = groups.find((existing) => {
      const reference = existing[0];
      if (!reference) return false;
      const similarSize = Math.abs(slot.w / layout.width - reference.w / layout.width) <= 0.08
        && Math.abs(slot.h / layout.height - reference.h / layout.height) <= 0.08;
      const sameRow = Math.abs(slot.y - reference.y) <= layout.height * 0.08;
      const sameColumn = Math.abs(slot.x - reference.x) <= layout.width * 0.08;
      return similarSize && (sameRow || sameColumn);
    });
    if (group) group.push(slot);
    else groups.push([slot]);
  }
  const count = Math.max(0, ...groups.map((group) => group.length));
  return count >= 3 ? count : 0;
}

function reusableCardTextSlots(
  layout: TemplateLayout,
  bodySlots: TemplateLayout["elements"],
) {
  const maximumWidth = Math.min(layout.width * 0.48, layout.width / Math.max(1, layout.cardCount) * 1.7);
  const candidates = bodySlots
    .filter((slot) => slot.h >= layout.height * 0.09 && slot.w <= maximumWidth)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  return candidates.filter((slot, index) => !candidates.slice(0, index).some((previous) => (
    previous.x < slot.x + slot.w && slot.x < previous.x + previous.w
    && previous.y < slot.y + slot.h && slot.y < previous.y + previous.h
  )));
}

export function splitSingleCardStatement(content: string[], cardCount: number): string[] {
  if (content.length !== 1 || cardCount < 2) return content;
  const statement = content[0] || "";
  const clauses = statement.match(/[^,;.!?]+[,;.!?]?/gu)?.map((part) => part.trim()).filter(Boolean) || [];
  return clauses.length >= 2 ? clauses : content;
}

function hasTimelineGeometry(layout: TemplateLayout) {
  const textSlots = layout.elements.filter((element) => isRenderableTextSlot(element, layout));
  return layout.elements.some((element) => {
    if ((element.type !== "line" && element.type !== "shape") || !isInsideCanvas(element, layout)) return false;
    const horizontalSpan = element.w / layout.width;
    const thickness = element.h / layout.height;
    const centerY = (element.y + element.h / 2) / layout.height;
    if (horizontalSpan < 0.62 || thickness > 0.035 || centerY < 0.24 || centerY > 0.82) return false;
    const associatedSlots = textSlots.filter((slot) => (
      slot.x + slot.w / 2 >= element.x - layout.width * 0.05
      && slot.x + slot.w / 2 <= element.x + element.w + layout.width * 0.05
      && slot.w <= layout.width * 0.35
      && Math.abs((slot.y + slot.h / 2) - (element.y + element.h / 2)) <= layout.height * 0.25
    ));
    const distinctCenters = associatedSlots.map((slot) => (slot.x + slot.w / 2) / layout.width)
      .sort((left, right) => left - right)
      .filter((center, index, centers) => index === 0 || center - centers[index - 1]! >= 0.12);
    return distinctCenters.length >= 3;
  });
}

function rectContains(
  container: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
  content: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
) {
  return content.x >= container.x
    && content.y >= container.y
    && content.x + content.w <= container.x + container.w
    && content.y + content.h <= container.y + container.h;
}

function centeredClosingCompositionScore(layout: TemplateLayout) {
  const slots = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
  const title = slots[0];
  if (!title) return 0;
  const body = slots
    .filter((slot) => slot.id !== title.id && slot.y >= title.y + title.h && !overlaps(slot, title))
    .sort((left, right) => right.w * right.h - left.w * left.h)[0];
  if (!body) return isHorizontallyCentered(title, layout) ? 28 : 0;
  if (isHorizontallyCentered(title, layout) && isHorizontallyCentered(body, layout)) return 84;
  if (isHorizontallyCentered(title, layout) || isHorizontallyCentered(body, layout)) return 38;
  return 0;
}

function isHorizontallyCentered(
  element: Pick<TemplateLayout["elements"][number], "x" | "w">,
  layout: TemplateLayout,
) {
  return Math.abs(element.x + element.w / 2 - layout.width / 2) <= layout.width * 0.06;
}

function titleSlotFitScore(layout: TemplateLayout, slide: PlanSlide) {
  const slots = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
  const titleSlot = slots[0];
  if (!titleSlot) return -70;
  const titleScore = textFitsSlot(slide.title, titleSlot) ? 54 : -54;
  const subtitleSlot = slots.find((slot) => slot.id !== titleSlot.id && slot.y >= titleSlot.y + titleSlot.h);
  return titleScore + (subtitleSlot && slide.content[0] && textFitsSlot(slide.content[0], subtitleSlot) ? 18 : 0);
}

function titleAndBodySlotScore(layout: TemplateLayout, slide: PlanSlide) {
  const slots = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
  const titleSlot = slots[0];
  if (!titleSlot) return -54;
  const bodySlot = slots
    .filter((slot) => slot.id !== titleSlot.id && slot.y >= titleSlot.y + titleSlot.h && !overlaps(slot, titleSlot))
    .sort((left, right) => right.w * right.h - left.w * left.h)[0];
  if (!bodySlot) return -44;
  const body = slide.content.length > 1 ? slide.content.join("\n") : slide.content[0] || "";
  return (textFitsSlot(slide.title, titleSlot) ? 24 : -36)
    + (textFitsSlot(body, bodySlot) ? 30 : -30);
}

function compareLayoutIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Estimate how much of the text this layout would place over retained
 * template artwork. The renderer can move an individual slot during
 * materialization, so score the best usable geometry in this layout instead
 * of tying the result to a layout name, source slide number, or color.
 */
function layoutTextCollisionRisk(layout: TemplateLayout, slide: PlanSlide, variant: LayoutVariant) {
  const artwork = layout.elements.filter((element) => {
    if (element.type === "image") {
      const relativeArea = (element.w * element.h) / (layout.width * layout.height);
      return Boolean(element.imageDataUrl)
        && isInsideCanvas(element, layout)
        && relativeArea >= GRAPHIC_MIN_AREA_RATIO
        && relativeArea < GRAPHIC_BACKGROUND_AREA_RATIO;
    }
    if ((element.type !== "shape" && element.type !== "line") || element.text.trim()
      || isTextSlotBackground(element, layout) || !isInsideCanvas(element, layout)) {
      return false;
    }
    const relativeArea = (element.w * element.h) / (layout.width * layout.height);
    return relativeArea < GRAPHIC_BACKGROUND_AREA_RATIO && relativeArea >= GRAPHIC_MIN_AREA_RATIO;
  });
  const textSlots = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .map((element) => adjustLayoutVariantSlot(element, layout, variant, slide.purpose))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
  const titleSlot = textSlots[0] || fallbackTitleSlot(layout);
  const titleRisk = slotGraphicOverlapRatio(titleSlot, artwork);
  const allBodySlots = textSlots.filter((slot) => slot.id !== titleSlot.id && !overlaps(slot, titleSlot));
  const bodySlots = allBodySlots.filter((slot) => slot.y >= titleSlot.y + titleSlot.h);

  if (slide.visualIntent === "timeline" && layout.composition !== "timeline") {
    return Math.max(titleRisk, fallbackTimelineGraphicRisk(layout, titleSlot, artwork, slide.content.length));
  }

  if (!slide.content.length) return titleRisk;
  if (layout.cardCount >= 2 && slide.content.length >= 2) {
    const cardSlots = reusableCardTextSlots(layout, bodySlots);
    const requiredSlots = Math.min(cardSlots.length, slide.content.length, layout.cardCount);
    if (cardSlots.length >= Math.min(slide.content.length, layout.cardCount)) {
      const assigned = cardSlots.slice(0, requiredSlots);
      return Math.max(titleRisk, ...assigned.map((slot) => slotGraphicOverlapRatio(slot, artwork)));
    }
  }

  const bodyText = slide.content.length > 1
    ? slide.content.map((item) => "• " + item).join("\n")
    : slide.content[0] || "";
  const minimumBodyWidth = variant === "visual" ? layout.width * 0.16 : layout.width * 0.2;
  const bodyCandidates = bodySlots
    .filter((slot) => slot.h >= layout.height * 0.1 && slot.w >= minimumBodyWidth && textFitsSlot(bodyText, slot))
    .sort((left, right) => right.w * right.h - left.w * left.h);
  const titleSeparated = bodyCandidates.filter((slot) => slot.y >= titleSlot.y + titleSlot.h);
  const bodyRisk = titleSeparated.length
    ? Math.min(...titleSeparated.map((slot) => slotGraphicOverlapRatio(slot, artwork)))
    : slotGraphicOverlapRatio(fallbackBodySlot(layout, titleSlot), artwork);
  const orderRisk = allBodySlots.length > 0 && bodySlots.length === 0 ? 1 : 0;
  return Math.max(titleRisk, bodyRisk, orderRisk);
}

/**
 * A filled shape that fully contains a template text slot is usually the
 * intended card, label or title surface. Treat it as composition styling,
 * rather than as artwork that generated text must avoid.
 */
function isTextSlotBackground(
  shape: TemplateLayout["elements"][number],
  layout: TemplateLayout,
) {
  if (shape.type !== "shape") return false;
  return layout.elements.some((slot) => (
    (slot.type === "text" || slot.type === "placeholder")
    && slot.x >= shape.x
    && slot.y >= shape.y
    && slot.x + slot.w <= shape.x + shape.w
    && slot.y + slot.h <= shape.y + shape.h
  ));
}

function adjustLayoutVariantSlot(
  element: TemplateLayout["elements"][number],
  layout: TemplateLayout,
  variant: LayoutVariant,
  purpose: PlanSlide["purpose"],
) {
  if (purpose === "title" || (element.type !== "text" && element.type !== "placeholder")) return element;
  const widthFactor = variant === "compact" ? 1.08 : variant === "visual" ? 0.82 : 1;
  const targetWidth = Math.max(layout.width * 0.12, Math.min(layout.width * 0.82, element.w * widthFactor));
  const x = Math.max(0, Math.min(layout.width - targetWidth, element.x + (element.w - targetWidth) / 2));
  return { ...element, x, w: targetWidth };
}

function fallbackTitleSlot(layout: TemplateLayout): TemplateLayout["elements"][number] {
  return {
    id: "fallback-title",
    type: "text",
    name: "Title",
    x: layout.width * 0.09,
    y: layout.height * 0.13,
    w: layout.width * 0.82,
    h: layout.height * 0.19,
    text: "",
    fontSize: 44,
    zIndex: 50,
  };
}

function fallbackBodySlot(layout: TemplateLayout, titleSlot: TemplateLayout["elements"][number]): TemplateLayout["elements"][number] {
  const bodyY = Math.max(layout.height * 0.4, titleSlot.y + titleSlot.h + layout.height * 0.06);
  const bodyHeight = Math.max(layout.height * 0.16, Math.min(layout.height * 0.35, layout.height * 0.92 - bodyY));
  return {
    id: "fallback-body",
    type: "text",
    name: "Body",
    x: layout.width * 0.1,
    y: bodyY,
    w: layout.width * 0.58,
    h: bodyHeight,
    text: "",
    fontSize: 24,
    zIndex: 51,
  };
}

function fallbackTimelineGraphicRisk(
  layout: TemplateLayout,
  titleSlot: TemplateLayout["elements"][number],
  artwork: TemplateLayout["elements"],
  contentCount: number,
) {
  const labelCount = Math.min(4, contentCount);
  if (!labelCount) return 0;
  const labelHeight = Math.min(58, layout.height * 0.1);
  const labelToLineGap = Math.min(26, layout.height * 0.04);
  const verticalPadding = Math.min(8, layout.height * 0.02);
  const horizontalPadding = Math.min(12, layout.width * 0.02 / labelCount);
  const titleGap = Math.max(12, layout.height * 0.025);
  const minY = Math.max(verticalPadding, titleSlot.y + titleSlot.h + titleGap + verticalPadding);
  const maxY = layout.height - labelHeight - labelToLineGap - 10;
  if (minY > maxY) return 1;
  const candidateYs: number[] = [minY, maxY];
  const stepY = Math.max(12, layout.height / 36);
  for (let y = minY; y <= maxY; y += stepY) candidateYs.push(y);
  candidateYs.push(Math.max(minY, Math.min(maxY, layout.height * 0.76 - labelHeight - labelToLineGap)));

  const candidateWidths = Array.from({ length: 14 }, (_, index) => layout.width * (0.76 - index * 0.04));
  const startsForWidth = (width: number) => {
    const maxStart = Math.max(0, layout.width - width);
    const preferredStart = layout.width * 0.12;
    return uniqueNumbers([
      0,
      maxStart,
      maxStart / 2,
      preferredStart,
      ...artwork.flatMap((element) => [
        element.x - width - horizontalPadding,
        element.x + element.w + horizontalPadding,
      ]),
    ].map((value) => Math.max(0, Math.min(maxStart, value))));
  };

  for (const width of candidateWidths) {
    const step = width / labelCount;
    const labelWidth = Math.min(210, step * 0.86);
    for (const start of startsForWidth(width)) {
      for (const labelY of candidateYs) {
        const panels = Array.from({ length: labelCount }, (_, index) => {
          const center = start + step * (index + 0.5);
          return {
            x: center - labelWidth / 2 - horizontalPadding,
            y: labelY - verticalPadding,
            w: labelWidth + horizontalPadding * 2,
            h: labelHeight + verticalPadding * 2,
          };
        });
        const lineY = labelY + labelHeight + labelToLineGap;
        const line = { x: start, y: lineY, w: width, h: 3 };
        const dots = Array.from({ length: labelCount }, (_, index) => {
          const center = start + step * (index + 0.5);
          return { x: center - 10, y: lineY - 10, w: 20, h: 20 };
        });
        if (panels.some((panel) => !isInsideCanvas(panel, layout)
          || overlaps(panel, titleSlot)
          || artwork.some((element) => overlaps(panel, element)))) continue;
        if ([line, ...dots].some((element) => !isInsideCanvas(element, layout)
          || overlaps(element, titleSlot)
          || artwork.some((obstacle) => overlaps(element, obstacle)))) continue;
        return 0;
      }
    }
  }

  return 1;
}

function slotGraphicOverlapRatio(
  slot: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
  artwork: TemplateLayout["elements"],
) {
  const slotArea = slot.w * slot.h;
  if (slotArea <= 0) return 1;
  const overlapArea = artwork.reduce((total, element) => total + intersectionArea(slot, element), 0);
  return Math.min(1, overlapArea / slotArea);
}

function intersectionArea(
  left: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
  right: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
) {
  const width = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function textFitsSlot(value: string, slot: TemplateLayout["elements"][number]) {
  if (!value) return true;
  let fontSize = Math.max(MIN_READABLE_TEXT_FONT_SIZE, Math.round(slot.fontSize || 24));
  while (fontSize > MIN_READABLE_TEXT_FONT_SIZE
    && measureTextForBox(value, fontSize, slot.w).height > slot.h * 0.86) {
    fontSize -= 1;
  }
  return measureTextForBox(value, fontSize, slot.w).height <= slot.h;
}

type LayoutProfileFeatures = {
  textCapacity: number;
  visualCapacity: number;
  cardCapacity: number;
  textDensity: number;
  compactness: number;
  usableTextArea: number;
  usableTextSlots: number;
  usableVisualSlots: number;
  inCanvasElementCount: number;
};

const DEFAULT_PROFILE_FEATURES: LayoutProfileFeatures = {
  textCapacity: 0.5,
  visualCapacity: 0.5,
  cardCapacity: 0.5,
  textDensity: 0.5,
  compactness: 0.5,
  usableTextArea: 0.5,
  usableTextSlots: 0,
  usableVisualSlots: 0,
  inCanvasElementCount: 0,
};

/**
 * Profiles are computed from the candidate set rather than fixture names or
 * layout ids. This makes their scale meaningful for both sparse and dense
 * unknown templates.
 */
function profileFeaturesFor(layouts: TemplateLayout[]) {
  const raw = layouts.map((layout) => {
    const inCanvasElements = layout.elements.filter((element) => isInsideCanvas(element, layout));
    const usableText = inCanvasElements.filter((element) => (
      (element.type === "text" || element.type === "placeholder")
      && element.w >= layout.width * TEXT_SLOT_MIN_WIDTH
      && element.h >= layout.height * TEXT_SLOT_MIN_HEIGHT
    ));
    const canvasArea = layout.width * layout.height;
    const usableTextArea = canvasArea > 0
      ? Math.min(1, usableText.reduce((total, element) => total + element.w * element.h, 0) / canvasArea)
      : 0;
    const visualElements = inCanvasElements.filter((element) => ["image", "chart", "table"].includes(element.type));
    // Parser slot totals include clipped/off-canvas shapes. Measure capacity
    // from the actual geometries that can be rendered within the slide.
    const textCapacity = usableText.length;
    const visualCapacity = visualElements.length;
    const cardCapacity = layout.cardCount;
    return {
      id: layout.id,
      textCapacity,
      visualCapacity,
      cardCapacity,
      textDensity: textCapacity / Math.max(1, inCanvasElements.length),
      compactness: 1 / Math.max(1, inCanvasElements.length),
      usableTextArea,
      usableTextSlots: textCapacity,
      usableVisualSlots: visualCapacity,
      inCanvasElementCount: inCanvasElements.length,
    };
  });
  const normalized = {
    textCapacity: normalizeFeature(raw.map((feature) => feature.textCapacity)),
    visualCapacity: normalizeFeature(raw.map((feature) => feature.visualCapacity)),
    cardCapacity: normalizeFeature(raw.map((feature) => feature.cardCapacity)),
    textDensity: normalizeFeature(raw.map((feature) => feature.textDensity)),
    compactness: normalizeFeature(raw.map((feature) => feature.compactness)),
    usableTextArea: normalizeFeature(raw.map((feature) => feature.usableTextArea)),
  };
  return new Map(raw.map((feature, index) => [feature.id, {
    textCapacity: normalized.textCapacity[index] ?? 0.5,
    visualCapacity: normalized.visualCapacity[index] ?? 0.5,
    cardCapacity: normalized.cardCapacity[index] ?? 0.5,
    textDensity: normalized.textDensity[index] ?? 0.5,
    compactness: normalized.compactness[index] ?? 0.5,
    usableTextArea: normalized.usableTextArea[index] ?? 0.5,
    usableTextSlots: feature.usableTextSlots,
    usableVisualSlots: feature.usableVisualSlots,
    inCanvasElementCount: feature.inCanvasElementCount,
  }]));
}

function isInsideCanvas(
  element: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
  layout: TemplateLayout,
) {
  return Number.isFinite(element.x)
    && Number.isFinite(element.y)
    && Number.isFinite(element.w)
    && Number.isFinite(element.h)
    && element.x >= 0
    && element.y >= 0
    && element.w > 0
    && element.h > 0
    && element.x + element.w <= layout.width + CANVAS_EDGE_TOLERANCE
    && element.y + element.h <= layout.height + CANVAS_EDGE_TOLERANCE;
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values.filter(Number.isFinite))];
}

function normalizeFeature(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return values.map(() => 0.5);
  return values.map((value) => (value - min) / (max - min));
}

function variantProfileScore(
  variant: LayoutVariant,
  profile: LayoutProfileFeatures,
  requiresReadableText: boolean,
  visualTextDemand = 0,
) {
  if (variant === "compact") {
    return profile.textCapacity * 190
      + profile.textDensity * 150
      + profile.compactness * 90
      + profile.usableTextArea * 70
      - profile.visualCapacity * 45;
  }
  if (variant === "visual") {
    if (!requiresReadableText) {
      return profile.visualCapacity * 230
        + profile.cardCapacity * 120
        + (1 - profile.textDensity) * 65
        + (1 - profile.compactness) * 35;
    }
    // Visual density is useful only when the layout still leaves enough room
    // for the slide's message. Keep slots as a preference, not a way to
    // overwhelm semantic composition and readable text capacity.
    return profile.visualCapacity * 150
      + profile.cardCapacity * 45
      + (1 - profile.textDensity) * 35
      + (1 - profile.compactness) * 20
      + profile.usableTextArea * 45
      + profile.textCapacity * 25
      + visualTextDemand;
  }
  return centered(profile.textCapacity) * 145
    + centered(profile.visualCapacity) * 105
    + centered(profile.textDensity) * 85
    + centered(profile.compactness) * 65
    + centered(profile.usableTextArea) * 55;
}

/**
 * Score whether this Visual candidate has actual in-canvas text boxes that can
 * hold this slide's title and body at the renderer's minimum readable size.
 * A passing candidate receives a clear preference over every undersized one;
 * when none pass, the closest measured fit is preferred.
 */
function visualTextDemandScore(layout: TemplateLayout, slide: PlanSlide) {
  const slots = layout.elements
    .filter((element) => isRenderableTextSlot(element, layout))
    .map((element) => fitVisualVariantSlot(element, layout))
    .sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0) || left.y - right.y || left.x - right.x);
  const titleSlot = slots[0];
  if (!titleSlot) return 0;

  const titleFit = textDemandFit(slide.title, titleSlot);
  const bodySlots = slots.filter((slot) => slot.id !== titleSlot.id
    && slot.y >= titleSlot.y + titleSlot.h
    && !overlaps(slot, titleSlot));
  if (!bodySlots.length) return 0;

  let contentFits: number[];
  if (layout.cardCount >= 2 && slide.content.length >= 2) {
    const cardSlots = bodySlots.filter((slot) => slot.h >= layout.height * 0.09);
    if (!cardSlots.length) return 0;
    const packedContent = packVisualCardContent(slide.content, cardSlots.length);
    contentFits = packedContent.map((content, index) => textDemandFit(content, cardSlots[index]!));
  } else {
    const bodyText = slide.content.length > 1
      ? slide.content.map((item) => "• " + item).join("\n")
      : slide.content[0] || "";
    const bodyCandidates = bodySlots
      .filter((slot) => slot.h >= layout.height * 0.1 && slot.w >= layout.width * 0.16)
      .sort((left, right) => right.w * right.h - left.w * left.h);
    if (!bodyCandidates.length) return 0;
    contentFits = [Math.max(...bodyCandidates.map((slot) => textDemandFit(bodyText, slot)))];
  }

  const fit = Math.min(titleFit, ...contentFits);
  return fit >= 1 ? 2_000 : fit * 1_000;
}

function packVisualCardContent(content: string[], slotCount: number) {
  if (content.length <= slotCount) return content;
  const leading = content.slice(0, Math.max(0, slotCount - 1));
  const final = content.slice(Math.max(0, slotCount - 1)).join(" · ");
  return [...leading, final];
}

function isRenderableTextSlot(
  element: TemplateLayout["elements"][number],
  layout: TemplateLayout,
) {
  const areaRatio = (element.w * element.h) / (layout.width * layout.height);
  return (element.type === "text" || element.type === "placeholder")
    && isInsideCanvas(element, layout)
    && element.w >= layout.width * TEXT_SLOT_MIN_WIDTH
    && element.h >= layout.height * TEXT_SLOT_MIN_HEIGHT
    && areaRatio <= 0.78;
}

function fitVisualVariantSlot(
  element: TemplateLayout["elements"][number],
  layout: TemplateLayout,
) {
  const width = Math.max(layout.width * TEXT_SLOT_MIN_WIDTH, element.w * 0.82);
  return { ...element, x: element.x + (element.w - width) / 2, w: width };
}

function textDemandFit(value: string, slot: TemplateLayout["elements"][number]) {
  if (!value) return 1;
  const measured = measureTextForBox(value, MIN_READABLE_TEXT_FONT_SIZE, slot.w);
  return Math.min(1, slot.h / measured.height);
}

function overlaps(
  left: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
  right: Pick<TemplateLayout["elements"][number], "x" | "y" | "w" | "h">,
) {
  return left.x < right.x + right.w && left.x + left.w > right.x
    && left.y < right.y + right.h && left.y + left.h > right.y;
}

function centered(value: number) {
  return 1 - Math.abs(value - 0.5) * 2;
}

function desiredComposition(slide: PlanSlide, role: NarrativeRole): TemplateLayout["composition"] {
  if (role === "opening") return "title";
  if (slide.visualIntent === "timeline") return "timeline";
  if (slide.visualIntent === "cards" || slide.visualIntent === "metrics") return "cards";
  if (slide.visualIntent === "image" || slide.visualIntent === "diagram") return "visual";
  if (slide.content.length >= 3) return "text";
  return "split";
}
