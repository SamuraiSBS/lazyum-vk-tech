"use client";

import {
  ChangeEvent,
  DragEvent,
  PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  RotateCcw,
  RotateCw,
  FileStack,
  GripVertical,
  ImagePlus,
  LoaderCircle,
  Palette,
  Play,
  Plus,
  ScanSearch,
  UploadCloud,
  X,
} from "lucide-react";
import {
  applyAllSafeAuditFixes,
  applyAuditDecision,
  effectiveAuditPresentation,
  isAutoFixableAuditIssue,
} from "@/lib/audit-actions";
import { publishedVariantRankingSchema } from "@/lib/agent-contracts";
import {
  clearPresentationDraft,
  loadPresentationDraft,
  savePresentationDraft,
} from "@/lib/draft-storage";
import { VK_WAVE_COLORS, WavyBackground } from "@/components/wavy-background";
import { clampToCanvas, clientDeltaToCanvas } from "@/lib/editor-geometry";
import {
  editorShortcut,
  isHistoryAtInitial,
  recordHistory,
  startHistory,
  travelHistory,
  type VariantHistories,
} from "@/lib/editor-history";
import { resolveEffectiveSlideCount } from "@/lib/slide-count";
import type {
  AuditReport,
  CanvasElement,
  DesignSystem,
  GenerationStageTrace,
  LayoutVariant,
  PresentationDocument,
  RenderEvidenceArtifact,
} from "@/lib/schemas";
import { generationStageTraceSchema } from "@/lib/schemas";
import type { PublishedVariantRanking } from "@/lib/agent-contracts";

type GenerationResponse = {
  jobId: string;
  presentations: Record<LayoutVariant, PresentationDocument>;
  audits: Record<LayoutVariant, AuditReport>;
  presentation: PresentationDocument;
  audit: AuditReport;
  normalizedContent: { documents: Array<{ name: string }>; keywords: string[] };
};

type AnalyzeResponse = {
  designSystem: DesignSystem;
  jobId: string;
  renderEvidence: RenderEvidenceArtifact;
};

type JobReopenResponse = {
  manifest: unknown;
  designSystem: DesignSystem;
  presentations: Record<LayoutVariant, PresentationDocument>;
  audits: Record<LayoutVariant, AuditReport>;
  ranking: unknown;
  stageTrace: unknown;
};

type GenerationSummary = {
  ranking: PublishedVariantRanking;
  stages: GenerationStageTrace[number][];
};

type GenerationSummaryStatus = "idle" | "loading" | "ready" | "unavailable";

type DragOperation = {
  elementId: string;
  mode: "move" | "resize";
  pointerX: number;
  pointerY: number;
  original: CanvasElement;
} | null;

type ExportFormat = "pptx" | "pdf" | "html";
type DraftSaveStatus = "idle" | "saving" | "saved" | "memory" | "error";

type ExportState = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  artifactPath?: string;
};

type VariantExportStates = Record<
  LayoutVariant,
  Record<ExportFormat, ExportState>
>;

const materialExtensions = [".pdf", ".docx", ".pptx", ".txt", ".md", ".csv"];
const MAX_REPLACEMENT_IMAGE_BYTES = 8 * 1024 * 1024;
const replacementImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isSupportedImageSignature(bytes: Uint8Array, type: string) {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (type === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (type === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (type === "image/gif") return starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
  if (type === "image/webp") return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return false;
}

function readImageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Файл изображения не прочитан."));
    reader.onerror = () => reject(new Error("Файл изображения не прочитан."));
    reader.readAsDataURL(file);
  });
}

function decodeImage(dataUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 ? resolve() : reject(new Error("Изображение повреждено."));
    image.onerror = () => reject(new Error("Изображение повреждено."));
    image.src = dataUrl;
  });
}
const generationVariants: Array<{
  id: LayoutVariant;
  label: string;
  description: string;
}> = [
  { id: "compact", label: "Compact", description: "Плотная подача" },
  {
    id: "balanced",
    label: "Balanced",
    description: "Сбалансированный вариант",
  },
  { id: "visual", label: "Visual", description: "Больше визуальных акцентов" },
];
const exportFormats: Array<{
  id: ExportFormat;
  label: string;
  endpoint: string;
  extension: ".pptx" | ".pdf" | ".html";
}> = [
  { id: "pptx", label: "PPTX", endpoint: "/api/export", extension: ".pptx" },
  { id: "pdf", label: "PDF", endpoint: "/api/export/pdf", extension: ".pdf" },
  {
    id: "html",
    label: "HTML",
    endpoint: "/api/export/html",
    extension: ".html",
  },
];

const generationSummaryStages = [
  { id: "narrative-selection", label: "Планирование" },
  { id: "variant-design", label: "Три варианта" },
  { id: "render-audit", label: "Рендер и аудит" },
  { id: "final-jury", label: "Рекомендация жюри" },
] as const;

const variantLabels: Record<LayoutVariant, string> = {
  compact: "Compact",
  balanced: "Balanced",
  visual: "Visual",
};

const wizardSteps = [
  {
    title: "О чём будет презентация?",
  },
  {
    title: "Выберите шаблон",
  },
  {
    title: "Добавьте материалы",
  },
  {
    title: "Сколько будет слайдов?",
  },
  {
    title: "Выберите подачу",
  },
  {
    title: "Всё готово к созданию",
  },
] as const;

function emptyExportStates(): VariantExportStates {
  return Object.fromEntries(
    generationVariants.map(({ id: variant }) => [
      variant,
      Object.fromEntries(
        exportFormats.map(({ id: format }) => [
          format,
          { status: "idle" as const },
        ]),
      ),
    ]),
  ) as VariantExportStates;
}

function emptyVariantChanges(): Record<LayoutVariant, boolean> {
  return Object.fromEntries(
    generationVariants.map(({ id: variant }) => [variant, false]),
  ) as Record<LayoutVariant, boolean>;
}

function parseGenerationSummary(payload: unknown): GenerationSummary {
  if (!payload || typeof payload !== "object") {
    throw new Error("Опубликованный job не содержит сводку генерации.");
  }
  const record = payload as Record<string, unknown>;
  const ranking = publishedVariantRankingSchema.parse(record.ranking);
  const stageTrace = generationStageTraceSchema.parse(record.stageTrace);
  const stages = generationSummaryStages.map(({ id }) => {
    const matches = stageTrace.filter((stage) => stage.stage === id);
    if (matches.length !== 1) {
      throw new Error("Сохранённый stage trace не содержит ожидаемые этапы.");
    }
    return matches[0];
  });
  return { ranking, stages };
}

function generationSummaryErrorMessage(reason: unknown) {
  if (reason instanceof Error && reason.name === "ZodError") {
    return "Ответ сводки не прошёл проверку и не будет показан.";
  }
  return `Не удалось загрузить сводку: ${messageFor(reason)}`;
}

function stageStatusLabel(status: GenerationStageTrace[number]["status"]) {
  return status === "completed" ? "Завершён" : "Заблокирован";
}

function draftSaveStatusLabel(status: DraftSaveStatus) {
  switch (status) {
    case "saving":
      return "Сохраняем…";
    case "saved":
      return "Сохранено локально";
    case "memory":
      return "Только эта вкладка";
    case "error":
      return "Не сохранено";
    default:
      return "Автосохранение";
  }
}

function canvasElementTypeLabel(element: CanvasElement) {
  switch (element.type) {
    case "text":
      return "Текст";
    case "shape":
      return "Фигура";
    case "image":
      return "Изображение";
    case "table":
      return "Таблица";
    case "chart":
      return "Диаграмма";
  }
}

function SummaryNotes({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <h4 style={{ margin: "8px 0 4px", fontSize: "0.76rem" }}>{title}</h4>
      {items.length ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: "0.74rem" }}>
          {items.map((item, index) => (
            <li key={`${index}-${item}`} style={{ marginBottom: 3 }}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, fontSize: "0.74rem", color: "var(--muted)" }}>
          {empty}
        </p>
      )}
    </div>
  );
}

export function HackathonStudio() {
  const [brief, setBrief] = useState("");
  const [slideCount, setSlideCount] = useState(10);
  const [variant, setVariant] = useState<LayoutVariant>("balanced");
  const [template, setTemplate] = useState<File | null>(null);
  const [materials, setMaterials] = useState<File[]>([]);
  const [designSystem, setDesignSystem] = useState<DesignSystem | null>(null);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [generationJobId, setGenerationJobId] = useState<string | null>(null);
  const [generationSummary, setGenerationSummary] =
    useState<GenerationSummary | null>(null);
  const [generationSummaryStatus, setGenerationSummaryStatus] =
    useState<GenerationSummaryStatus>("idle");
  const [generationSummaryError, setGenerationSummaryError] = useState("");
  const [renderEvidence, setRenderEvidence] =
    useState<RenderEvidenceArtifact | null>(null);
  const [presentations, setPresentations] = useState<Record<
    LayoutVariant,
    PresentationDocument
  > | null>(null);
  const [audits, setAudits] = useState<Record<
    LayoutVariant,
    AuditReport
  > | null>(null);
  const [presentation, setPresentation] = useState<PresentationDocument | null>(
    null,
  );
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [selectedSlide, setSelectedSlide] = useState(0);
  const [selectedElement, setSelectedElement] = useState<string | null>(null);
  const [draftSaveStatus, setDraftSaveStatus] =
    useState<DraftSaveStatus>("idle");
  const [busy, setBusy] = useState<"analyze" | "generate" | null>(null);
  const [setupStep, setSetupStep] = useState(0);
  const [changedVariants, setChangedVariants] =
    useState<Record<LayoutVariant, boolean>>(emptyVariantChanges);
  const [exportStates, setExportStates] =
    useState<VariantExportStates>(emptyExportStates);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [templateDragging, setTemplateDragging] = useState(false);
  const draftWarningShown = useRef(false);
  const skipNextDraftSave = useRef(false);
  const histories = useRef<VariantHistories>({});
  const activeVariant = useRef<LayoutVariant>("balanced");
  const historyGeneration = useRef(0);
  const [historyRevision, setHistoryRevision] = useState(0);

  function resetHistories(documents: Partial<Record<LayoutVariant, PresentationDocument>>) {
    historyGeneration.current += 1;
    histories.current = Object.fromEntries(
      Object.entries(documents).map(([key, document]) => [key, startHistory(document)]),
    ) as VariantHistories;
    setHistoryRevision((value) => value + 1);
  }

  function commitDocument(document: PresentationDocument, targetVariant: LayoutVariant = variant) {
    const current = histories.current[targetVariant] || startHistory(document);
    const next = recordHistory(current, document);
    if (next === current) return;
    histories.current = { ...histories.current, [targetVariant]: next };
    setHistoryRevision((value) => value + 1);
    if (activeVariant.current === targetVariant) setPresentation(next.present);
    setPresentations((all) => all ? { ...all, [targetVariant]: next.present } : all);
    setChangedVariants((all) => ({ ...all, [targetVariant]: !isHistoryAtInitial(next) }));
    setAudits((all) => all ? { ...all, [targetVariant]: effectiveAuditPresentation(next.present) } : all);
    if (generationJobId) replaceJobInUrl(null);
  }

  function travelDocument(direction: "undo" | "redo") {
    const current = histories.current[variant];
    if (!current) return;
    const next = travelHistory(current, direction);
    if (next === current) return;
    histories.current = { ...histories.current, [variant]: next };
    setHistoryRevision((value) => value + 1);
    setPresentation(next.present);
    setPresentations((all) => all ? { ...all, [variant]: next.present } : all);
    setChangedVariants((all) => ({ ...all, [variant]: !isHistoryAtInitial(next) }));
    setSelectedElement((id) => id && next.present.slides[selectedSlide]?.canvas.elements.some((element) => element.id === id) ? id : null);
    setError("");
    if (generationJobId) replaceJobInUrl(null);
  }

  useEffect(() => {
    if (!presentation) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = editorShortcut(event);
      if (!direction || !histories.current[variant]) return;
      event.preventDefault();
      travelDocument(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [presentation, variant, historyRevision]);

  useEffect(() => {
    let cancelled = false;
    const jobId = new URLSearchParams(window.location.search)
      .get("job")
      ?.trim();
    if (jobId) {
      setGenerationSummary(null);
      setGenerationSummaryStatus("loading");
      setGenerationSummaryError("");
      void fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      })
        .then(async (response) => {
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok) throw new Error(jobReopenErrorMessage(payload));
          return payload as JobReopenResponse;
        })
        .then((result) => {
          if (cancelled) return;
          const restored = result.presentations.balanced;
          let restoredSummary: GenerationSummary | null = null;
          let summaryError = "";
          try {
            restoredSummary = parseGenerationSummary(result);
          } catch (reason) {
            summaryError = generationSummaryErrorMessage(reason);
          }
          // A URL job is an immutable published snapshot. Ignore any local editor
          // draft rather than presenting it as a recovered server-side change.
          skipNextDraftSave.current = true;
          setDesignSystem(result.designSystem);
          setPresentations(result.presentations);
          resetHistories(result.presentations);
          setAudits(result.audits);
          setGenerationJobId(jobId);
          setGenerationSummary(restoredSummary);
          setGenerationSummaryStatus(
            restoredSummary ? "ready" : "unavailable",
          );
          setGenerationSummaryError(summaryError);
          setChangedVariants(emptyVariantChanges());
          setExportStates(emptyExportStates());
          setVariant("balanced");
          activeVariant.current = "balanced";
          setPresentation(restored);
          setAudit(result.audits.balanced);
          setSelectedSlide(0);
          setSelectedElement(null);
          setSuccess(
            "Открыт опубликованный job. Локальный несохранённый черновик не применён.",
          );
        })
        .catch((reason) => {
          if (cancelled) return;
          setError(
            `Не удалось открыть job из URL: ${messageFor(reason)}. Можно создать новую презентацию.`,
          );
        });
    } else {
      void loadPresentationDraft().then((document) => {
        if (cancelled || !document) return;
        setVariant(document.variant || "balanced");
        activeVariant.current = document.variant || "balanced";
        setPresentation(document);
        resetHistories({ [document.variant || "balanced"]: document });
        setDesignSystem(document.designSystem);
        setAudit(effectiveAuditPresentation(document));
        setSuccess("Восстановлен локально сохранённый черновик.");
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!presentation) return;
    if (skipNextDraftSave.current) {
      skipNextDraftSave.current = false;
      return;
    }
    const nextAudit = effectiveAuditPresentation(presentation);
    setAudit(nextAudit);
    setAudits((current) =>
      current ? { ...current, [variant]: nextAudit } : current,
    );
    setDraftSaveStatus("saving");
    void savePresentationDraft(presentation)
      .then((mode) => {
        if (mode === "memory") {
          setDraftSaveStatus("memory");
          if (!draftWarningShown.current) {
            draftWarningShown.current = true;
            setSuccess(
              "Черновик открыт в текущей вкладке: браузерное хранилище недоступно.",
            );
          }
          return;
        }
        setDraftSaveStatus("saved");
      })
      .catch(() => setDraftSaveStatus("error"));
  }, [presentation]);

  const currentSlide = presentation?.slides[selectedSlide];
  const selectedCanvasElement = currentSlide?.canvas.elements.find(
    (element) => element.id === selectedElement,
  );
  const activeWizardStep = wizardSteps[setupStep] || wizardSteps[0];
  const issues =
    audit?.slides.find((slide) => slide.slideId === currentSlide?.id)?.issues ||
    [];
  const totalIssues =
    audit?.slides.reduce((total, slide) => total + slide.issues.length, 0) || 0;
  const safeFixCount =
    audit?.slides.reduce(
      (total, slide) =>
        total +
        slide.issues.filter(
          (issue) => !issue.ignored && isAutoFixableAuditIssue(issue),
        ).length,
      0,
    ) || 0;

  async function analyzeTemplate() {
    if (!template) {
      setError("Добавьте PPTX-шаблон, чтобы увидеть дизайн-систему.");
      return;
    }
    setBusy("analyze");
    setError("");
    setSuccess("");
    try {
      const form = new FormData();
      form.set("template", template);
      const response = await fetch("/api/analyze", {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Не удалось проанализировать шаблон.");
      const result = payload as AnalyzeResponse;
      setDesignSystem(result.designSystem);
      setAnalysisJobId(result.jobId);
      setRenderEvidence(result.renderEvidence);
      setSuccess(
        "Шаблон проанализирован: токены, layouts и фактический PNG-render сохранены в job.",
      );
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    if (!template) {
      setError("Сначала добавьте PPTX-шаблон.");
      return;
    }
    if (brief.trim().length < 2) {
      setError("Опишите, какую презентацию нужно создать.");
      return;
    }
    setBusy("generate");
    setError("");
    setSuccess("");
    setGenerationSummary(null);
    setGenerationSummaryStatus("loading");
    setGenerationSummaryError("");
    try {
      const form = new FormData();
      form.set("template", template);
      form.set("brief", brief.trim());
      form.set("slideCount", String(slideCount));
      materials.forEach((file) => form.append("materials", file));
      const response = await fetch("/api/generate", {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Не удалось создать презентацию.");
      const result = payload as GenerationResponse;
      if (!result.jobId)
        throw new Error("Generation completed without a persisted job id.");
      setPresentations(result.presentations);
      resetHistories(result.presentations);
      setAudits(result.audits);
      setGenerationJobId(result.jobId);
      replaceJobInUrl(result.jobId);
      setChangedVariants(emptyVariantChanges());
      setExportStates(emptyExportStates());
      setVariant(variant);
      activeVariant.current = variant;
      setDesignSystem(result.presentations[variant].designSystem);
      setPresentation(result.presentations[variant]);
      setAudit(effectiveAuditPresentation(result.presentations[variant]));
      setSelectedSlide(0);
      setSelectedElement(null);
      setSuccess(
        "Готово: один job создал три варианта по " +
          result.presentations[variant].slides.length +
          " слайдов.",
      );
      try {
        const summaryResponse = await fetch(
          `/api/jobs/${encodeURIComponent(result.jobId)}`,
          { cache: "no-store" },
        );
        const summaryPayload: unknown = await summaryResponse
          .json()
          .catch(() => null);
        if (!summaryResponse.ok) {
          throw new Error(jobReopenErrorMessage(summaryPayload));
        }
        const summary = parseGenerationSummary(summaryPayload);
        setGenerationSummary(summary);
        setGenerationSummaryStatus("ready");
      } catch (reason) {
        setGenerationSummary(null);
        setGenerationSummaryStatus("unavailable");
        setGenerationSummaryError(generationSummaryErrorMessage(reason));
      }
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  }

  async function exportPresentation(format: ExportFormat) {
    if (!presentation) return;
    const exportFormat = exportFormats.find((item) => item.id === format);
    if (!exportFormat) return;
    const usePublishedArtifact =
      Boolean(generationJobId) && !changedVariants[variant];
    setExportStates((current) => ({
      ...current,
      [variant]: {
        ...current[variant],
        [format]: { status: "loading" },
      },
    }));
    setError("");
    try {
      const response = await fetch(exportFormat.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          usePublishedArtifact
            ? { jobId: generationJobId, variant }
            : presentation,
        ),
      });
      if (!response.ok) {
        throw new Error(
          await exportErrorMessage(
            response,
            `${exportFormat.label} export failed.`,
          ),
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFor(presentation.title, exportFormat.extension);
      anchor.click();
      URL.revokeObjectURL(url);
      const artifactPath =
        response.headers.get("X-VK-Hackathon-Artifact-Path") || undefined;
      setExportStates((current) => ({
        ...current,
        [variant]: {
          ...current[variant],
          [format]: { status: "ready", artifactPath },
        },
      }));
      setSuccess(
        usePublishedArtifact
          ? `${exportFormat.label} скачан и опубликован в artifact job: ${artifactPath || "путь не указан"}.`
          : `${exportFormat.label} скачан из текущего изменённого документа.`,
      );
    } catch (reason) {
      const exportError = messageFor(reason);
      setExportStates((current) => ({
        ...current,
        [variant]: {
          ...current[variant],
          [format]: { status: "error", error: exportError },
        },
      }));
      setError(`${exportFormat.label}: ${exportError}`);
    }
  }

  function addTemplate(file: File | undefined) {
    if (!file) return;
    if (!/\.pptx$/i.test(file.name)) {
      setError("Для шаблона подойдёт только файл .pptx.");
      return;
    }
    setTemplate(file);
    setError("");
    setSuccess("");
  }

  function addMaterials(files: FileList | File[]) {
    const accepted = Array.from(files).filter((file) =>
      materialExtensions.some((extension) =>
        file.name.toLowerCase().endsWith(extension),
      ),
    );
    const rejected = Array.from(files).length - accepted.length;
    setMaterials((current) => [...current, ...accepted].slice(0, 12));
    if (rejected) setError("Поддерживаются PDF, DOCX, PPTX, TXT, MD и CSV.");
  }

  function updateElement(elementId: string, patch: Partial<CanvasElement>) {
    if (!currentSlide?.canvas.elements.some((element) => element.id === elementId)) return;
    const updateDocument = (current: PresentationDocument) => {
      return {
        ...current,
        slides: current.slides.map((slide) =>
          slide.id !== currentSlide.id
            ? slide
            : {
                ...slide,
                canvas: {
                  ...slide.canvas,
                  elements: slide.canvas.elements.map((element) =>
                    element.id === elementId
                      ? ({ ...element, ...patch } as CanvasElement)
                      : element,
                  ),
                },
              },
        ),
      };
    };
    if (presentation) commitDocument(updateDocument(histories.current[variant]?.present || presentation));
  }

  function updateSelectedNumber(
    key: "x" | "y" | "w" | "h" | "fontSize" | "strokeWidth",
    raw: string,
    min: number,
    max: number,
  ) {
    if (!selectedCanvasElement || raw.trim() === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) return;
    updateElement(selectedCanvasElement.id, { [key]: value } as Partial<CanvasElement>);
  }

  function updateSelectedColor(key: "color" | "fill" | "stroke", value: string) {
    if (!selectedCanvasElement || !/^#[0-9a-f]{6}$/iu.test(value)) return;
    updateElement(selectedCanvasElement.id, { [key]: value } as Partial<CanvasElement>);
  }

  async function replaceSelectedImage(file: File | undefined) {
    const target = selectedCanvasElement;
    const originVariant = variant;
    const originSlideId = currentSlide?.id;
    const originGeneration = historyGeneration.current;
    if (!file || !target || target.type !== "image" || !originSlideId) return;
    if (!replacementImageTypes.has(file.type) || file.size === 0 || file.size > MAX_REPLACEMENT_IMAGE_BYTES) {
      setError("Выберите PNG, JPEG, GIF или WebP размером до 8 МБ.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (!isSupportedImageSignature(bytes, file.type)) throw new Error("Файл не соответствует формату изображения.");
      const dataUrl = await readImageDataUrl(file);
      await decodeImage(dataUrl);
      // A crop belongs to the old source image. Clear it while retaining the
      // selected object's identity, position, size and stacking order.
      if (originGeneration !== historyGeneration.current) return;
      const originDocument = histories.current[originVariant]?.present;
      if (!originDocument) return;
      const slide = originDocument.slides.find((item) => item.id === originSlideId);
      if (!slide?.canvas.elements.some((element) => element.id === target.id && element.type === "image")) return;
      commitDocument({
        ...originDocument,
        slides: originDocument.slides.map((item) => item.id === originSlideId ? {
          ...item,
          canvas: { ...item.canvas, elements: item.canvas.elements.map((element) =>
            element.id === target.id ? { ...element, dataUrl, alt: file.name.slice(0, 160), crop: undefined } : element,
          ) },
        } : item),
      }, originVariant);
      if (activeVariant.current === originVariant) {
        setError("");
        setSuccess("Изображение заменено. Старое кадрирование сброшено.");
      }
    } catch (reason) {
      if (originGeneration === historyGeneration.current && activeVariant.current === originVariant) setError(messageFor(reason));
    }
  }

  function selectVariant(nextVariant: LayoutVariant) {
    const nextPresentation = histories.current[nextVariant]?.present || presentations?.[nextVariant];
    if (!nextPresentation) return;
    activeVariant.current = nextVariant;
    setVariant(nextVariant);
    setPresentation(nextPresentation);
    setAudit(effectiveAuditPresentation(nextPresentation));
    setSelectedSlide(0);
    setSelectedElement(null);
  }

  function saveAuditAction(
    nextPresentation: PresentationDocument,
    message: string,
  ) {
    const nextAudit = effectiveAuditPresentation(nextPresentation);
    commitDocument(nextPresentation);
    setAudit(nextAudit);
    setAudits((current) =>
      current ? { ...current, [variant]: nextAudit } : current,
    );
    setError("");
    setSuccess(message);
  }

  function applyIssueAction(
    issue: AuditReport["slides"][number]["issues"][number],
    action: "fix" | "ignore",
  ) {
    if (!presentation || !currentSlide) return;
    const nextPresentation = applyAuditDecision(
      presentation,
      currentSlide.id,
      issue,
      action,
    );
    if (nextPresentation === presentation && action === "fix") {
      setError(
        "Безопасное исправление не сняло замечание; документ не изменён.",
      );
      return;
    }
    saveAuditAction(
      nextPresentation,
      action === "fix"
        ? "Исправление применено и audit выполнен повторно."
        : "Замечание помечено как ignored и audit выполнен повторно.",
    );
  }

  function applyAllSafeFixes() {
    if (!presentation) return;
    const nextPresentation = applyAllSafeAuditFixes(presentation);
    if (nextPresentation === presentation) return;
    saveAuditAction(
      nextPresentation,
      "Безопасные исправления применены, audit выполнен повторно.",
    );
  }

  function validateSetupStep() {
    if (setupStep === 0 && brief.trim().length < 2) {
      setError("Опишите тему презентации, чтобы продолжить.");
      return false;
    }
    if (setupStep === 1 && !template) {
      setError("Добавьте PPTX-шаблон, чтобы продолжить.");
      return false;
    }
    setError("");
    setSuccess("");
    return true;
  }

  function goToNextSetupStep() {
    if (busy || !validateSetupStep()) return;
    if (setupStep === wizardSteps.length - 1) {
      void generate();
      return;
    }
    setSetupStep((current) => Math.min(wizardSteps.length - 1, current + 1));
  }

  function goToPreviousSetupStep() {
    if (busy) return;
    setError("");
    setSuccess("");
    setSetupStep((current) => Math.max(0, current - 1));
  }

  function resetProject() {
    histories.current = {};
    historyGeneration.current += 1;
    activeVariant.current = "balanced";
    setHistoryRevision((value) => value + 1);
    void clearPresentationDraft();
    replaceJobInUrl(null);
    setPresentations(null);
    setAudits(null);
    setPresentation(null);
    setDesignSystem(null);
    setAnalysisJobId(null);
    setGenerationJobId(null);
    setGenerationSummary(null);
    setGenerationSummaryStatus("idle");
    setGenerationSummaryError("");
    setRenderEvidence(null);
    setAudit(null);
    setChangedVariants(emptyVariantChanges());
    setExportStates(emptyExportStates());
    setSelectedSlide(0);
    setSelectedElement(null);
    setDraftSaveStatus("idle");
    setBrief("");
    setSlideCount(10);
    setVariant("balanced");
    setTemplate(null);
    setMaterials([]);
    setSetupStep(0);
    setError("");
    setSuccess("");
  }

  const effectiveSlideCount = resolveEffectiveSlideCount(brief, slideCount);

  return (
    <main className={presentation ? "app-shell" : "app-shell setup-shell"}>
      {presentation && (
        <header className="topbar">
          <details className="project-menu" data-testid="project-menu">
            <summary className="project-title" title={presentation.title}>
              {presentation.title}
            </summary>
            <div className="project-menu-popover">
              <button
                type="button"
                className="project-menu-action"
                onClick={resetProject}
              >
                <Plus size={16} /> Создать новый проект
              </button>
            </div>
          </details>
          <div className="topbar-status">
            <span
              className={"save-status save-status-" + draftSaveStatus}
              data-testid="save-status"
              aria-live="polite"
            >
              {draftSaveStatus === "saved" ? (
                <CheckCircle2 size={14} />
              ) : draftSaveStatus === "error" ? (
                <AlertCircle size={14} />
              ) : null}
              {draftSaveStatusLabel(draftSaveStatus)}
            </span>
            <ExportControls
              variant={variant}
              states={exportStates[variant]}
              onExport={exportPresentation}
            />
          </div>
        </header>
      )}

      {presentation && (error || success) && (
        <div
          className={
            "notice " +
            (error ? "notice-error" : "notice-success") +
            (!error && success.startsWith("Открыт опубликованный job.")
              ? " notice-published"
              : "")
          }
          role="status"
        >
          {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{error || success}</span>
          <button
            type="button"
            aria-label="Закрыть сообщение"
            onClick={() => {
              setError("");
              setSuccess("");
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {!presentation ? (
        <>
          <WavyBackground
            colors={VK_WAVE_COLORS}
            backgroundFill="#1C1D22"
            waveWidth={46}
            blur={14}
            speed="slow"
            waveOpacity={0.28}
          />
          <section className="creation-wizard" aria-labelledby="wizard-title">
            <form
              className="wizard-content"
              onSubmit={(event) => {
                event.preventDefault();
                goToNextSetupStep();
              }}
            >
              <div className="wizard-heading">
                <h1 id="wizard-title">{activeWizardStep.title}</h1>
              </div>

              <div className="wizard-input-area">
                {setupStep === 0 && (
                  <div className="wizard-field-group">
                    <textarea
                      id="brief"
                      aria-label="Тема / brief"
                      className="brief-field wizard-brief-field"
                      value={brief}
                      onChange={(event) => setBrief(event.target.value)}
                      placeholder="Например: Презентация нового сервиса VK для внутреннего питча"
                      maxLength={10_000}
                      rows={5}
                    />
                  </div>
                )}

                {setupStep === 1 && (
                  <div className="wizard-field-group">
                    <div
                      className={
                        "template-dropzone wizard-dropzone " +
                        (templateDragging ? "is-dragging" : "") +
                        (template ? " has-file" : "")
                      }
                      onDragOver={(event) => {
                        event.preventDefault();
                        setTemplateDragging(true);
                      }}
                      onDragLeave={() => setTemplateDragging(false)}
                      onDrop={(event: DragEvent<HTMLDivElement>) => {
                        event.preventDefault();
                        setTemplateDragging(false);
                        addTemplate(event.dataTransfer.files[0]);
                      }}
                    >
                      <input
                        className="visually-hidden"
                        id="template-file"
                        type="file"
                        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                        onChange={(event) =>
                          addTemplate(event.target.files?.[0])
                        }
                      />
                      {template ? (
                        <div className="selected-file">
                          <span className="file-icon">
                            <FileStack size={21} />
                          </span>
                          <span>
                            <strong>{template.name}</strong>
                            <small>
                              {formatFileSize(template.size)} · дизайн-шаблон
                            </small>
                          </span>
                          <button
                            type="button"
                            aria-label="Удалить шаблон"
                            onClick={() => setTemplate(null)}
                          >
                            <X size={17} />
                          </button>
                        </div>
                      ) : (
                        <label htmlFor="template-file">
                          <span className="upload-icon">
                            <UploadCloud size={23} />
                          </span>
                          <strong>Перетащите PPTX сюда</strong>
                          <span>или выберите файл с компьютера</span>
                        </label>
                      )}
                    </div>
                    <div className="template-actions wizard-template-actions">
                      <p>
                        Шаблон будет разобран как дизайн-система, а не как
                        источник текста.
                      </p>
                      <button
                        className="button button-secondary"
                        type="button"
                        onClick={analyzeTemplate}
                        disabled={!template || busy !== null}
                      >
                        {busy === "analyze" ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ScanSearch size={16} />
                        )}
                        Проверить шаблон
                      </button>
                    </div>
                    {designSystem && renderEvidence && analysisJobId && (
                      <DesignDebug
                        designSystem={designSystem}
                        jobId={analysisJobId}
                        renderEvidence={renderEvidence}
                        compact
                      />
                    )}
                  </div>
                )}

                {setupStep === 2 && (
                  <div className="wizard-field-group">
                    <div className="materials-row wizard-materials-row">
                      <input
                        className="visually-hidden"
                        id="materials"
                        type="file"
                        multiple
                        accept=".pdf,.docx,.pptx,.txt,.md,.csv"
                        onChange={(event) =>
                          event.target.files && addMaterials(event.target.files)
                        }
                      />
                      <label
                        className="material-add wizard-material-add"
                        htmlFor="materials"
                      >
                        <ImagePlus size={17} /> Добавить файлы
                      </label>
                      <span>PDF, DOCX, PPTX, TXT, MD, CSV</span>
                    </div>
                    {materials.length > 0 ? (
                      <ul
                        className="file-chips wizard-file-chips"
                        aria-label="Добавленные материалы"
                      >
                        {materials.map((file, index) => (
                          <li key={file.name + index}>
                            <FileStack size={14} />
                            <span>{file.name}</span>
                            <button
                              type="button"
                              aria-label={"Удалить " + file.name}
                              onClick={() =>
                                setMaterials((current) =>
                                  current.filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                )
                              }
                            >
                              <X size={14} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="wizard-empty-state"></p>
                    )}
                  </div>
                )}

                {setupStep === 3 && (
                  <div className="wizard-choice-grid wizard-count-choice">
                    <label className="wizard-label" htmlFor="slides">
                      Количество слайдов
                    </label>
                    <select
                      id="slides"
                      value={slideCount}
                      onChange={(event) =>
                        setSlideCount(Number(event.target.value))
                      }
                    >
                      {Array.from({ length: 11 }, (_, index) => index + 5).map(
                        (value) => (
                          <option key={value} value={value}>
                            {value} слайдов
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                )}

                {setupStep === 4 && (
                  <div
                    className="wizard-variant-list"
                    role="radiogroup"
                    aria-label="Вариант для открытия редактора"
                  >
                    {generationVariants.map((candidate) => {
                      const selected = variant === candidate.id;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={
                            "wizard-variant-card " +
                            (selected ? "is-selected" : "")
                          }
                          onClick={() => setVariant(candidate.id)}
                        >
                          <span
                            className="wizard-variant-marker"
                            aria-hidden="true"
                          >
                            {selected ? <Check size={14} /> : null}
                          </span>
                          <span>
                            <strong>{candidate.label}</strong>
                            <small>{candidate.description}</small>
                          </span>
                          <ArrowRight size={17} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                )}

                {setupStep === 5 && (
                  <div className="wizard-summary">
                    <div className="wizard-summary-row">
                      <span>Тема</span>
                      <strong>{brief.trim()}</strong>
                    </div>
                    <div className="wizard-summary-row">
                      <span>Шаблон</span>
                      <strong>{template?.name || "Не выбран"}</strong>
                    </div>
                    <div className="wizard-summary-row">
                      <span>Материалы</span>
                      <strong>
                        {materials.length
                          ? `${materials.length} файл${materials.length === 1 ? "" : materials.length < 5 ? "а" : "ов"}`
                          : "Без материалов"}
                      </strong>
                    </div>
                    <div className="wizard-summary-row">
                      <span>Объём</span>
                      <strong data-testid="effective-slide-count">
                        {effectiveSlideCount.count} слайдов
                        {effectiveSlideCount.source === "brief" ? " (по брифу)" : ""}
                      </strong>
                    </div>
                    <div className="wizard-summary-row">
                      <span>Открыть вариант</span>
                      <strong>
                        {
                          generationVariants.find(
                            (candidate) => candidate.id === variant,
                          )?.label
                        }
                      </strong>
                    </div>
                  </div>
                )}
              </div>

              {(error || success) && (
                <div
                  className={
                    "wizard-feedback " + (error ? "is-error" : "is-success")
                  }
                  role="status"
                >
                  {error ? (
                    <AlertCircle size={16} />
                  ) : (
                    <CheckCircle2 size={16} />
                  )}
                  <span>{error || success}</span>
                  <button
                    type="button"
                    aria-label="Закрыть сообщение"
                    onClick={() => {
                      setError("");
                      setSuccess("");
                    }}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}

              <footer className="wizard-actions">
                <button
                  className="wizard-back"
                  type="button"
                  onClick={goToPreviousSetupStep}
                  disabled={setupStep === 0 || busy !== null}
                >
                  <ArrowLeft size={16} /> Назад
                </button>
                <button
                  className="button button-primary wizard-next"
                  type="button"
                  onClick={
                    setupStep === wizardSteps.length - 1
                      ? () => void generate()
                      : goToNextSetupStep
                  }
                  disabled={busy !== null}
                >
                  {busy === "generate" ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : setupStep === wizardSteps.length - 1 ? (
                    <Play size={17} fill="currentColor" />
                  ) : (
                    <ArrowRight size={17} />
                  )}
                  {busy === "generate"
                    ? "Создаём презентацию…"
                    : setupStep === wizardSteps.length - 1
                      ? "Создать презентацию"
                      : "Продолжить"}
                </button>
              </footer>
            </form>
          </section>
        </>
      ) : (
        <section className="studio-layout">
          {presentations && (
            <div
              role="tablist"
              aria-label="Варианты презентации"
              className="variant-switcher"
              data-testid="variant-switcher"
            >
              {generationVariants.map((candidate) => {
                const selected = variant === candidate.id;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => selectVariant(candidate.id)}
                    className="variant-tab"
                  >
                    <span>{candidate.label}</span>
                    {candidate.id === "balanced" && (
                      <span className="variant-recommended">Рекомендуем</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <aside className="slide-rail" aria-label="Список слайдов">
            <div className="rail-heading">
              <div>
                <p>Слайды</p>
                <strong>{presentation.slides.length} слайдов</strong>
              </div>
            </div>
            <div className="thumbnails">
              {presentation.slides.map((slide, index) => (
                <button
                  key={slide.id}
                  type="button"
                  className={
                    "thumbnail " + (selectedSlide === index ? "selected" : "")
                  }
                  onClick={() => {
                    setSelectedSlide(index);
                    setSelectedElement(null);
                  }}
                >
                  <span className="thumbnail-number">{index + 1}</span>
                  <MiniSlide slide={slide.canvas} />
                  <span>{slide.title}</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="editor-workspace">
            <div className="editor-toolbar">
              <div>
                <span className="editor-breadcrumb">
                  Редактор /{" "}
                  {generationVariants.find(
                    (candidate) => candidate.id === variant,
                  )?.label || "Balanced"}{" "}
                  / Слайд {selectedSlide + 1}
                </span>
                <h2>{currentSlide?.title}</h2>
              </div>
              <div className="editor-history-controls" aria-label="История редактора">
                <button type="button" aria-label="Отменить" title="Отменить (Ctrl+Z)" disabled={!histories.current[variant]?.past.length} onClick={() => travelDocument("undo")}><RotateCcw size={16} /> Отменить</button>
                <button type="button" aria-label="Повторить" title="Повторить (Ctrl+Y)" disabled={!histories.current[variant]?.future.length} onClick={() => travelDocument("redo")}><RotateCw size={16} /> Повторить</button>
              </div>
            </div>
            {currentSlide && (
              <EditableCanvas
                canvas={currentSlide.canvas}
                selectedElement={selectedElement}
                onSelect={setSelectedElement}
                onUpdate={updateElement}
              />
            )}
            <p className="editor-hint">
              <GripVertical size={16} /> Выберите объект, перетащите его или
              измените текст. Изменения хранятся в браузере.
            </p>
          </div>

          <aside className="inspector" aria-label="Свойства и инструменты">
            <section
              className="inspector-section object-properties"
              aria-label="Свойства выбранного объекта"
              data-testid="object-properties"
            >
              <div className="inspector-heading">
                <ScanSearch size={17} />
                <h3>Свойства</h3>
              </div>
              {selectedCanvasElement ? (
                <>
                <dl className="design-facts object-facts">
                  <div>
                    <dt>Тип</dt>
                    <dd>{canvasElementTypeLabel(selectedCanvasElement)}</dd>
                  </div>
                  <div>
                    <dt>Положение · x / y</dt>
                    <dd>
                      <output>
                        {Math.round(selectedCanvasElement.x)},{" "}
                        {Math.round(selectedCanvasElement.y)}
                      </output>
                    </dd>
                  </div>
                  <div>
                    <dt>Размер · w × h</dt>
                    <dd>
                      <output>
                        {Math.round(selectedCanvasElement.w)} ×{" "}
                        {Math.round(selectedCanvasElement.h)}
                      </output>
                    </dd>
                  </div>
                </dl>
                <div className="object-property-fields">
                  {(["x", "y", "w", "h"] as const).map((key) => {
                    const canvas = currentSlide!.canvas;
                    const max = key === "x" ? canvas.width - selectedCanvasElement.w
                      : key === "y" ? canvas.height - selectedCanvasElement.h
                      : key === "w" ? canvas.width - selectedCanvasElement.x
                      : canvas.height - selectedCanvasElement.y;
                    return <label key={key}>{key.toUpperCase()}
                      <input aria-label={`Свойство ${key}`} type="number" step="1"
                        min={key === "w" || key === "h" ? 1 : 0} max={max}
                        value={selectedCanvasElement[key]}
                        onChange={(event) => updateSelectedNumber(key, event.target.value, key === "w" || key === "h" ? 1 : 0, max)} />
                    </label>;
                  })}
                  {selectedCanvasElement.type === "text" && <>
                    <label>Размер шрифта
                      <input aria-label="Размер шрифта" type="number" min="1" max="200" step="1"
                        value={selectedCanvasElement.fontSize}
                        onChange={(event) => updateSelectedNumber("fontSize", event.target.value, 1, 200)} />
                    </label>
                    <label>Цвет текста
                      <input aria-label="Цвет текста" type="color" value={selectedCanvasElement.color}
                        onChange={(event) => updateSelectedColor("color", event.target.value)} />
                    </label>
                    <label>Выравнивание
                      <select aria-label="Выравнивание текста" value={selectedCanvasElement.align}
                        onChange={(event) => updateElement(selectedCanvasElement.id, { align: event.target.value as "left" | "center" | "right" })}>
                        <option value="left">Слева</option><option value="center">По центру</option><option value="right">Справа</option>
                      </select>
                    </label>
                  </>}
                  {selectedCanvasElement.type === "shape" && <>
                    <label>Заливка
                      <input aria-label="Заливка фигуры" type="color" value={selectedCanvasElement.fill}
                        onChange={(event) => updateSelectedColor("fill", event.target.value)} />
                    </label>
                    <label>Контур
                      <input aria-label="Контур фигуры" type="color" value={selectedCanvasElement.stroke}
                        onChange={(event) => updateSelectedColor("stroke", event.target.value)} />
                    </label>
                    <label>Толщина контура
                      <input aria-label="Толщина контура" type="number" min="0" max="12" step="1"
                        value={selectedCanvasElement.strokeWidth}
                        onChange={(event) => updateSelectedNumber("strokeWidth", event.target.value, 0, 12)} />
                    </label>
                  </>}
                  {selectedCanvasElement.type === "image" && <>
                    <label className="object-property-wide">Описание
                      <input aria-label="Описание изображения" type="text" maxLength={160}
                        value={selectedCanvasElement.alt}
                        onChange={(event) => updateElement(selectedCanvasElement.id, { alt: event.target.value.slice(0, 160) })} />
                    </label>
                    <label className="object-property-wide">Заменить изображение
                      <input aria-label="Заменить изображение" type="file" accept="image/png,image/jpeg,image/gif,image/webp"
                        onChange={(event) => {
                          void replaceSelectedImage(event.target.files?.[0]);
                          event.target.value = "";
                        }} />
                    </label>
                    <p className="inspector-note object-property-wide">PNG, JPEG, GIF, WebP · до 8 МБ. При замене кадрирование сбрасывается.</p>
                  </>}
                </div>
                </>
              ) : (
                <p className="object-properties-hint">
                  Выберите объект на холсте, чтобы увидеть его тип и геометрию.
                </p>
              )}
            </section>

            {generationJobId && (
              <details
                className="inspector-disclosure"
                data-testid="compare-disclosure"
              >
                <summary className="inspector-disclosure-summary">
                  <CheckCircle2 size={16} aria-hidden="true" />
                  <span>Сравнить</span>
                </summary>
                <section
                  className="inspector-section"
                  aria-label="Сводка жюри"
                  data-testid="generation-summary"
                >
                  <div className="inspector-heading">
                    <h3>Рекомендация жюри</h3>
                  </div>
                  {generationSummary ? (
                    <>
                      <p className="comparison-recommendation">
                        Рекомендуемый вариант:{" "}
                        {variantLabels[generationSummary.ranking.recommendedVariant]}
                      </p>
                      <ol
                        aria-label="Порядок вариантов"
                        className="comparison-ranking"
                      >
                        {generationSummary.ranking.rankedVariants.map(
                          (entry, index) => (
                            <li key={entry.variant}>
                              <strong>
                                {variantLabels[entry.variant]}
                                {entry.variant ===
                                generationSummary.ranking.recommendedVariant
                                  ? " · рекомендация"
                                  : ""}
                              </strong>
                              <div>
                                #{index + 1} · итог {entry.score}/100 · аудит{" "}
                                {entry.deterministicAuditScore}/100 · доп. оценка{" "}
                                {entry.advisoryScore}/100
                              </div>
                            </li>
                          ),
                        )}
                      </ol>
                      <SummaryNotes
                        title="Блокирующие причины"
                        items={generationSummary.ranking.blockingReasons}
                        empty="Нет сохранённых блокирующих причин."
                      />
                      <SummaryNotes
                        title="Замечания для пользователя"
                        items={generationSummary.ranking.remainingUserVisibleIssues}
                        empty="Нет сохранённых замечаний для пользователя."
                      />
                    </>
                  ) : (
                    <p
                      role={
                        generationSummaryStatus === "unavailable"
                          ? "status"
                          : undefined
                      }
                      className="inspector-note"
                    >
                      {generationSummaryStatus === "loading"
                        ? "Загружается сохранённая сводка…"
                        : generationSummaryError ||
                          "Сводка этого job недоступна."}
                    </p>
                  )}
                </section>
              </details>
            )}

            <details
              className="inspector-disclosure"
              data-testid="diagnostics-disclosure"
            >
              <summary className="inspector-disclosure-summary">
                <ScanSearch size={16} aria-hidden="true" />
                <span>Диагностика</span>
              </summary>
              <div className="inspector-disclosure-content">
                {generationJobId && (
                  <section
                    className="inspector-section"
                    data-testid="generation-stages"
                  >
                    <div className="inspector-heading">
                      <h3>Этапы генерации</h3>
                    </div>
                    {generationSummary ? (
                      <>
                        <p className="inspector-note">
                          Сохранённый итог job, не live-прогресс.
                        </p>
                        <dl
                          className="design-facts"
                          aria-label="Статусы этапов генерации"
                        >
                          {generationSummary.stages.map((stage) => {
                            const label = generationSummaryStages.find(
                              (candidate) => candidate.id === stage.stage,
                            )?.label;
                            return (
                              <div key={stage.stage}>
                                <dt>{label || stage.stage}</dt>
                                <dd>{stageStatusLabel(stage.status)}</dd>
                              </div>
                            );
                          })}
                        </dl>
                      </>
                    ) : (
                      <p className="inspector-note">
                        {generationSummaryStatus === "loading"
                          ? "Загружаются сохранённые этапы…"
                          : generationSummaryError ||
                            "Этапы этого job недоступны."}
                      </p>
                    )}
                  </section>
                )}
                <section
                  className="inspector-section"
                  aria-label="Сведения о шаблоне"
                  data-testid="template-diagnostics"
                >
                  <div className="inspector-heading">
                    <Palette size={17} />
                    <h3>Сведения о шаблоне</h3>
                  </div>
                  <p className="source-name">{designSystem?.sourceName}</p>
                  <div className="palette-row" aria-label="Палитра шаблона">
                    {designSystem?.colors.slice(0, 8).map((color) => (
                      <span
                        key={color}
                        title={color}
                        style={{ background: color }}
                      />
                    ))}
                  </div>
                  <dl className="design-facts">
                    <div>
                      <dt>Размер слайда</dt>
                      <dd>
                        {Math.round(designSystem?.slideSize.width || 0)} ×{" "}
                        {Math.round(designSystem?.slideSize.height || 0)}
                      </dd>
                    </div>
                    <div>
                      <dt>Макеты</dt>
                      <dd>{designSystem?.layouts.length}</dd>
                    </div>
                    <div>
                      <dt>Шрифт</dt>
                      <dd>
                        {designSystem?.typography.headingFonts[0] || "не найден"}
                      </dd>
                    </div>
                  </dl>
                  {designSystem && <EvidenceSummary designSystem={designSystem} />}
                </section>

                <section className="inspector-section">
                  <div className="inspector-heading">
                    <ScanSearch size={17} />
                    <h3>Композиции</h3>
                  </div>
                  <div className="layout-previews">
                    {designSystem?.layouts.slice(0, 4).map((layout) => (
                      <LayoutPreview key={layout.id} layout={layout} />
                    ))}
                  </div>
                  {designSystem && globalParserWarnings(designSystem).length > 0 && (
                    <div data-testid="global-parser-warnings">
                      <strong>Общие предупреждения parser</strong>
                      <ul>{globalParserWarnings(designSystem).map((warning, index) => <li key={warning + index}>{warning}</li>)}</ul>
                    </div>
                  )}
                </section>
              </div>
            </details>

            <details
              className="inspector-disclosure"
              data-testid="audit-disclosure"
            >
              <summary className="inspector-disclosure-summary">
                <AlertCircle size={16} aria-hidden="true" />
                <span>Проверка</span>
                <span
                  className={
                    audit?.passed ? "audit-count audit-ok" : "audit-count"
                  }
                  data-testid="audit-count"
                  aria-label={"Всего замечаний: " + totalIssues}
                >
                  {totalIssues}
                </span>
              </summary>
              <section
                className="inspector-section audit-section"
                aria-label="Замечания текущего слайда"
              >
                <div className="inspector-heading">
                  <h3>Текущий слайд</h3>
                </div>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={applyAllSafeFixes}
                  disabled={busy !== null || safeFixCount === 0}
                  style={{ width: "100%", marginBottom: 10 }}
                >
                  Исправить все безопасные
                  {safeFixCount ? ` (${safeFixCount})` : ""}
                </button>
                {issues.length ? (
                  <ul className="audit-list">
                    {issues.map((issue) => (
                      <li
                        key={
                          issue.issueKey ||
                          issue.type + issue.elementId + issue.message
                        }
                        className={"severity-" + issue.severity}
                      >
                        <span>
                          {issue.message}
                          {issue.ignored ? " — ignored" : ""}
                        </span>
                        <span
                          style={{
                            display: "flex",
                            gap: 6,
                            marginTop: 7,
                            flexWrap: "wrap",
                          }}
                        >
                          {isAutoFixableAuditIssue(issue) && !issue.ignored && (
                            <button
                              className="button button-secondary"
                              type="button"
                              onClick={() => applyIssueAction(issue, "fix")}
                              disabled={busy !== null}
                            >
                              Исправить
                            </button>
                          )}
                          <button
                            className="button button-secondary"
                            type="button"
                            onClick={() => applyIssueAction(issue, "ignore")}
                            disabled={busy !== null}
                          >
                            Игнорировать
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="empty-audit">
                    На этом слайде нет детерминированных замечаний.
                  </p>
                )}
              </section>
            </details>
          </aside>
        </section>
      )}
    </main>
  );
}

function ExportControls({
  variant,
  states,
  onExport,
}: {
  variant: LayoutVariant;
  states: Record<ExportFormat, ExportState>;
  onExport: (format: ExportFormat) => Promise<void>;
}) {
  return (
    <details
      className="export-control"
      aria-label={
        "Экспорт варианта " +
        (generationVariants.find((item) => item.id === variant)?.label || variant)
      }
      data-testid="export-control"
    >
      <summary className="button button-primary export-trigger">
        <Download size={16} /> Экспорт
      </summary>
      <div className="export-menu" role="group" aria-label="Формат экспорта">
        {exportFormats.map((format) => {
          const state = states[format.id];
          const isLoading = state.status === "loading";
          return (
            <div key={format.id} className="export-menu-option">
              <button
                className="button button-secondary export-format-button"
                type="button"
                onClick={() => {
                  void onExport(format.id);
                }}
                disabled={isLoading}
                aria-busy={isLoading}
              >
                {isLoading ? (
                  <LoaderCircle className="spin" size={16} />
                ) : null}
                {isLoading ? format.label + "…" : format.label}
              </button>
              {state.status === "error" && (
                <span role="alert" className="export-state export-state-error">
                  {format.label}: {state.error}
                </span>
              )}
              {state.status === "ready" && state.artifactPath && (
                <span
                  title={state.artifactPath}
                  className="export-state export-state-ready"
                >
                  Артефакт: {state.artifactPath}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function EditableCanvas({
  canvas,
  selectedElement,
  onSelect,
  onUpdate,
}: {
  canvas: PresentationDocument["slides"][number]["canvas"];
  selectedElement: string | null;
  onSelect: (value: string | null) => void;
  onUpdate: (id: string, patch: Partial<CanvasElement>) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const operation = useRef<DragOperation>(null);

  function pointerDown(
    event: PointerEvent<HTMLDivElement>,
    element: CanvasElement,
    mode: "move" | "resize" = "move",
  ) {
    if (event.target instanceof HTMLTextAreaElement && mode === "move") {
      event.stopPropagation();
      onSelect(element.id);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    operation.current = {
      elementId: element.id,
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      original: element,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(element.id);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = operation.current;
    const frame = frameRef.current;
    if (!active || !frame) return;
    const rect = frame.getBoundingClientRect();
    const delta = clientDeltaToCanvas(
      { x: active.pointerX, y: active.pointerY },
      { x: event.clientX, y: event.clientY },
      canvas,
      rect,
    );
    if (active.mode === "move") {
      onUpdate(active.elementId, {
        x: clampToCanvas(
          active.original.x + delta.x,
          0,
          canvas.width - active.original.w,
        ),
        y: clampToCanvas(
          active.original.y + delta.y,
          0,
          canvas.height - active.original.h,
        ),
      });
    } else {
      onUpdate(active.elementId, {
        w: clampToCanvas(
          active.original.w + delta.x,
          32,
          canvas.width - active.original.x,
        ),
        h: clampToCanvas(
          active.original.h + delta.y,
          24,
          canvas.height - active.original.y,
        ),
      });
    }
  }

  return (
    <div className="canvas-wrap">
      <div
        ref={frameRef}
        className="editable-canvas"
        style={{
          aspectRatio: canvas.width + " / " + canvas.height,
          background: canvas.background,
        }}
        onPointerMove={pointerMove}
        onPointerUp={() => {
          operation.current = null;
        }}
        onPointerCancel={() => {
          operation.current = null;
        }}
        onPointerDown={() => onSelect(null)}
      >
        {canvas.elements.map((element) => (
          <CanvasObject
            key={element.id}
            element={element}
            canvas={canvas}
            isSelected={selectedElement === element.id}
            onPointerDown={pointerDown}
            onTextChange={(text) =>
              onUpdate(element.id, { text } as Partial<CanvasElement>)
            }
          />
        ))}
      </div>
    </div>
  );
}

function CanvasObject({
  element,
  canvas,
  isSelected,
  onPointerDown,
  onTextChange,
}: {
  element: CanvasElement;
  canvas: PresentationDocument["slides"][number]["canvas"];
  isSelected: boolean;
  onPointerDown: (
    event: PointerEvent<HTMLDivElement>,
    element: CanvasElement,
    mode?: "move" | "resize",
  ) => void;
  onTextChange: (value: string) => void;
}) {
  const style = {
    left: (element.x / canvas.width) * 100 + "%",
    top: (element.y / canvas.height) * 100 + "%",
    width: (element.w / canvas.width) * 100 + "%",
    height: (element.h / canvas.height) * 100 + "%",
    zIndex: element.zIndex,
  };
  return (
    <div
      className={"canvas-object " + (isSelected ? "is-selected" : "")}
      data-element-id={element.id}
      style={style}
      onPointerDown={(event) => onPointerDown(event, element)}
      role="group"
      aria-label={
        element.type === "text"
          ? "Текст: " + element.text.slice(0, 60)
          : "Объект " + element.type
      }
    >
      {element.type === "text" && (
        <textarea
          value={element.text}
          onChange={(event) => onTextChange(event.target.value)}
          style={{
            color: element.color,
            fontFamily: element.fontFamily + ", Arial, sans-serif",
            fontSize:
              Math.max(1.2, (element.fontSize / canvas.width) * 100) + "cqw",
            fontWeight: element.fontWeight,
            textAlign: element.align,
          }}
          aria-label="Редактируемый текст"
        />
      )}
      {element.type === "shape" && (
        <span
          className={"canvas-shape shape-" + element.shape}
          style={{
            background: element.shape === "line" ? "transparent" : element.fill,
            borderColor: element.stroke,
            borderWidth:
              element.shape === "line"
                ? 0
                : Math.max(1, (element.strokeWidth / canvas.width) * 100) +
                  "cqw",
            borderRadius:
              element.shape === "roundRect"
                ? Math.max(1, (element.radius / canvas.width) * 100) + "cqw"
                : element.shape === "ellipse"
                  ? "50%"
                  : 0,
          }}
        />
      )}
      {element.type === "image" && element.dataUrl && (
        element.crop ? (
          <span style={{ display: "block", position: "relative", width: "100%", height: "100%",
            overflow: "hidden", transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined }}>
            <img src={element.dataUrl} alt={element.alt} style={{
              position: "absolute", maxWidth: "none", objectFit: "fill",
              width: `${10000 / (100 - element.crop.left - element.crop.right)}%`,
              height: `${10000 / (100 - element.crop.top - element.crop.bottom)}%`,
              left: `${-100 * element.crop.left / (100 - element.crop.left - element.crop.right)}%`,
              top: `${-100 * element.crop.top / (100 - element.crop.top - element.crop.bottom)}%`,
            }} />
          </span>
        ) : (
          <img src={element.dataUrl} alt={element.alt}
            style={{ objectFit: "fill", transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined }} />
        )
      )}
      {isSelected && (
        <button
          className="resize-handle"
          type="button"
          aria-label="Изменить размер объекта"
          onPointerDown={(event) =>
            onPointerDown(
              event as unknown as PointerEvent<HTMLDivElement>,
              element,
              "resize",
            )
          }
        />
      )}
    </div>
  );
}

function MiniSlide({
  slide,
}: {
  slide: PresentationDocument["slides"][number]["canvas"];
}) {
  return (
    <span className="mini-slide" style={{ background: slide.background }}>
      {slide.elements.slice(0, 16).map((element) => (
        <i
          key={element.id}
          style={{
            left: (element.x / slide.width) * 100 + "%",
            top: (element.y / slide.height) * 100 + "%",
            width: (element.w / slide.width) * 100 + "%",
            height: (element.h / slide.height) * 100 + "%",
            background:
              element.type === "shape"
                ? element.fill
                : element.type === "text"
                  ? element.color
                  : "#999",
            opacity: element.type === "text" ? 0.7 : 1,
          }}
        />
      ))}
    </span>
  );
}

function globalParserWarnings(designSystem: DesignSystem) {
  const local = new Set(designSystem.layouts.flatMap((layout) => layout.parserWarnings || []));
  return designSystem.warnings.filter((warning) => !local.has(warning));
}

function LayoutPreview({
  layout,
}: {
  layout: DesignSystem["layouts"][number];
}) {
  return (
    <div className="layout-preview">
      <span
        className="layout-preview-canvas"
        style={{
          aspectRatio: layout.width + " / " + layout.height,
          background: layout.background || "#F2F4F8",
        }}
      >
        {layout.elements.slice(0, 16).map((element) => (
          <i
            key={element.id}
            style={{
              left: (element.x / layout.width) * 100 + "%",
              top: (element.y / layout.height) * 100 + "%",
              width: (element.w / layout.width) * 100 + "%",
              height: (element.h / layout.height) * 100 + "%",
              background:
                element.fill ||
                (element.type === "text" || element.type === "placeholder"
                  ? "#4B5563"
                  : "#CBD5E1"),
            }}
          />
        ))}
      </span>
      <span>
        <strong>{layout.composition}</strong>
        <small>{layout.name}</small>
        <small data-testid="layout-confidence">Уверенность: {typeof layout.confidence === "number" ? Math.round(layout.confidence * 100) + "%" : "нет данных"}</small>
        {layout.parserWarnings?.length ? (
          <ul data-testid="layout-parser-warnings" aria-label={"Предупреждения макета " + layout.name}>
            {layout.parserWarnings.map((warning, index) => <li key={warning + index}>{warning}</li>)}
          </ul>
        ) : null}
      </span>
    </div>
  );
}

function DesignDebug({
  designSystem,
  jobId,
  renderEvidence,
  compact = false,
}: {
  designSystem: DesignSystem;
  jobId: string;
  renderEvidence: RenderEvidenceArtifact;
  compact?: boolean;
}) {
  const firstSlide = renderEvidence.slides[0];
  const globalWarnings = globalParserWarnings(designSystem);
  if (compact) {
    return (
      <section
        className="template-analysis-result"
        aria-label="Результат анализа шаблона"
      >
        <div className="template-analysis-heading">
          <div>
            <span>Шаблон проанализирован</span>
            <strong>
              {renderEvidence.slideCount} слайдов · {renderEvidence.width} ×{" "}
              {renderEvidence.height} px
            </strong>
          </div>
          <CheckCircle2 size={17} aria-hidden="true" />
        </div>
        {firstSlide && (
          <img
            src={artifactUrl(jobId, firstSlide.relativePath)}
            alt="Фактический PNG-render первого слайда шаблона"
          />
        )}
        <div className="template-analysis-meta">
          <span>{designSystem.layouts.length} композиции</span>
          <span>{designSystem.colors.length} цветов</span>
          <span>
            {designSystem.typography.headingFonts[0] || "Шрифт определён"}
          </span>
        </div>
        {globalWarnings.length > 0 && (
          <div data-testid="global-parser-warnings">
            <strong>Общие предупреждения parser</strong>
            <ul>{globalWarnings.map((warning, index) => <li key={warning + index}>{warning}</li>)}</ul>
          </div>
        )}
      </section>
    );
  }
  return (
    <section className="debug-view" aria-labelledby="debug-title">
      <div>
        <p className="section-kicker">
          <ScanSearch size={16} /> M1 · Template Understanding
        </p>
        <h2 id="debug-title">Найдена дизайн-система шаблона</h2>
      </div>
      <div className="debug-grid">
        <div>
          <span>Палитра</span>
          <div className="palette-row">
            {designSystem.colors.map((color) => (
              <i key={color} style={{ background: color }} title={color} />
            ))}
          </div>
        </div>
        <div>
          <span>Шрифты</span>
          <strong>
            {[
              ...designSystem.typography.headingFonts,
              ...designSystem.typography.bodyFonts,
            ]
              .slice(0, 3)
              .join(" · ") || "Не найдены"}
          </strong>
        </div>
        <div>
          <span>Layouts</span>
          <strong>{designSystem.layouts.length}</strong>
        </div>
        <div>
          <span>Правила</span>
          <strong>
            {designSystem.visualPatterns.join(" · ") || "Базовая композиция"}
          </strong>
        </div>
      </div>
      <EvidenceSummary designSystem={designSystem} />
      <div
        style={{
          marginTop: 24,
          padding: 16,
          border: "1px solid var(--line)",
          borderRadius: 18,
          background: "var(--surface)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <p className="panel-eyebrow" style={{ margin: 0 }}>
              Фактический render шаблона
            </p>
            <strong>LibreOffice Impress → PDF → Poppler PNG</strong>
          </div>
          <span
            style={{
              color: "var(--muted)",
              fontSize: "0.78rem",
              fontWeight: 800,
            }}
          >
            {renderEvidence.slideCount} слайдов · {renderEvidence.width} ×{" "}
            {renderEvidence.height} px
          </span>
        </div>
        {firstSlide && (
          <img
            src={artifactUrl(jobId, firstSlide.relativePath)}
            alt="Фактический PNG-render первого слайда шаблона"
            style={{
              display: "block",
              width: "100%",
              maxHeight: 560,
              marginTop: 14,
              objectFit: "contain",
              borderRadius: 12,
              background: "#ebe5dd",
            }}
          />
        )}
        {renderEvidence.slides.length > 1 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(94px, 1fr))",
              gap: 8,
              marginTop: 12,
            }}
          >
            {renderEvidence.slides.slice(1, 8).map((slide) => (
              <figure key={slide.slideNumber} style={{ margin: 0 }}>
                <img
                  src={artifactUrl(jobId, slide.relativePath)}
                  alt={`Фактический PNG-render слайда ${slide.slideNumber}`}
                  loading="lazy"
                  style={{
                    display: "block",
                    width: "100%",
                    aspectRatio: "4 / 3",
                    objectFit: "contain",
                    borderRadius: 7,
                    background: "#ebe5dd",
                  }}
                />
                <figcaption
                  style={{
                    marginTop: 3,
                    color: "var(--muted)",
                    fontSize: "0.68rem",
                    fontWeight: 800,
                  }}
                >
                  Слайд {slide.slideNumber}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        <p
          style={{
            margin: "10px 0 0",
            color: "var(--muted)",
            fontSize: "0.76rem",
          }}
        >
          PNG загружен из сохранённого artifact job, а не собран DOM
          mini-layout.
        </p>
      </div>
      <div className="debug-layouts">
        {designSystem.layouts.slice(0, 6).map((layout) => (
          <LayoutPreview key={layout.id} layout={layout} />
        ))}
      </div>
      <div style={{ marginTop: 20 }}>
        <span
          style={{
            color: "var(--muted)",
            fontSize: "0.75rem",
            fontWeight: 850,
          }}
        >
          Общие предупреждения parser
        </span>
        {globalWarnings.length ? (
          <ul
            style={{
              margin: "8px 0 0",
              paddingLeft: 18,
              color: "var(--error)",
              fontSize: "0.8rem",
            }}
          >
            {globalWarnings.map((warning, index) => (
              <li key={warning + index}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p
            style={{
              margin: "8px 0 0",
              color: "var(--status-good)",
              fontSize: "0.8rem",
            }}
          >
            Предупреждений нет.
          </p>
        )}
      </div>
    </section>
  );
}

function artifactUrl(jobId: string, relativePath: string) {
  return (
    "/api/artifacts/" +
    encodeURIComponent(jobId) +
    "/" +
    relativePath.split("/").map(encodeURIComponent).join("/")
  );
}

function replaceJobInUrl(jobId: string | null) {
  const url = new URL(window.location.href);
  if (jobId) url.searchParams.set("job", jobId);
  else url.searchParams.delete("job");
  window.history.replaceState(
    window.history.state,
    "",
    url.pathname + url.search + url.hash,
  );
}

function EvidenceSummary({ designSystem }: { designSystem: DesignSystem }) {
  const evidence = designSystem.evidence;
  if (!evidence) return null;
  const groups = [
    { label: "Цвета", entries: evidence.colors },
    {
      label: "Шрифты",
      entries: [
        ...evidence.typography.headingFonts,
        ...evidence.typography.bodyFonts,
      ],
    },
    { label: "Размеры", entries: evidence.typography.fontSizes },
    { label: "Вес", entries: evidence.typography.fontWeights },
    {
      label: "Spacing",
      entries: [
        ...evidence.spacing.horizontalMargins,
        ...evidence.spacing.verticalMargins,
        ...evidence.spacing.gaps,
      ],
    },
    {
      label: "Фигуры",
      entries: [
        ...evidence.shapes.types,
        ...evidence.shapes.radii,
        ...evidence.shapes.strokes,
      ],
    },
    { label: "Фоны", entries: evidence.backgrounds },
  ];
  const entries = groups.flatMap((group) => group.entries);
  const averageConfidence = entries.length
    ? Math.round(
        (entries.reduce((sum, entry) => sum + entry.confidence, 0) /
          entries.length) *
          100,
      )
    : 0;
  const relationships = designSystem.relationships || [];
  const imageAssets = designSystem.imageAssets || [];
  return (
    <div
      style={{
        marginTop: 14,
        padding: 12,
        borderRadius: 12,
        background: "var(--surface-soft)",
        border: "1px solid var(--line)",
      }}
      aria-label="Сводка evidence"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "baseline",
        }}
      >
        <strong style={{ fontSize: "0.8rem" }}>Token evidence</strong>
        <span
          style={{
            color: "var(--muted)",
            fontSize: "0.72rem",
            fontWeight: 800,
          }}
        >
          {entries.length} токенов · {averageConfidence}% confidence
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "4px 12px",
          marginTop: 8,
          fontSize: "0.72rem",
        }}
      >
        {groups.map((group) => {
          const confidence = group.entries.length
            ? Math.round(
                (group.entries.reduce(
                  (sum, entry) => sum + entry.confidence,
                  0,
                ) /
                  group.entries.length) *
                  100,
              )
            : 0;
          return (
            <span key={group.label}>
              <b>{group.label}</b>: {group.entries.length} · {confidence}%
            </span>
          );
        })}
      </div>
      <span
        style={{
          display: "block",
          marginTop: 8,
          color: "var(--muted)",
          fontSize: "0.7rem",
        }}
      >
        Связи:{" "}
        {relationships.filter((item) => item.kind === "layout-master").length}{" "}
        layout→master ·{" "}
        {relationships.filter((item) => item.kind === "slide-layout").length}{" "}
        slide→layout · assets:{" "}
        {imageAssets.filter((asset) => asset.allowed).length}/
        {imageAssets.length}
      </span>
      {imageAssets.length > 0 && (
        <div
          style={{ marginTop: 5, color: "var(--muted)", fontSize: "0.7rem" }}
        >
          Images:{" "}
          {imageAssets
            .slice(0, 3)
            .map((asset) => asset.relationshipId + " → " + asset.target)
            .join("; ")}
        </div>
      )}
      {entries[0] && (
        <details style={{ marginTop: 8, fontSize: "0.7rem" }}>
          <summary>Источники токенов</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
            {entries.slice(0, 6).map((entry, index) => (
              <li key={String(entry.value) + index}>
                <span>
                  {String(entry.value)} · {Math.round(entry.confidence * 100)}%
                </span>
                <div style={{ color: "var(--muted)" }}>
                  {entry.sources
                    .slice(0, 2)
                    .map(evidenceSourceLabel)
                    .join("; ")}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function evidenceSourceLabel(source: {
  sourceFile: string;
  xmlPath?: string;
  elementId?: string;
  relationshipId?: string;
}) {
  const locator = source.elementId
    ? "#" + source.elementId
    : source.xmlPath || "";
  const relationship = source.relationshipId
    ? " · " + source.relationshipId
    : "";
  return source.sourceFile + (locator ? " · " + locator : "") + relationship;
}

function formatFileSize(size: number) {
  return size < 1024 * 1024
    ? Math.max(1, Math.round(size / 1024)) + " КБ"
    : (size / 1024 / 1024).toFixed(1) + " МБ";
}

function messageFor(reason: unknown) {
  return reason instanceof Error
    ? reason.message
    : "Что-то пошло не так. Попробуйте ещё раз.";
}

async function exportErrorMessage(response: Response, fallback: string) {
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return fallback;
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return fallback;
}

function jobReopenErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return "Generation job is unavailable";
  const error = payload.error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message;
  }
  return "Generation job is unavailable";
}

function filenameFor(title: string, extension: ".pptx" | ".pdf" | ".html") {
  const safe = title
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return (safe || "presentation").slice(0, 80) + extension;
}
