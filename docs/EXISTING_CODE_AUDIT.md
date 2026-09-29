# Existing Lazyum code audit

Audit date: 2026-09-15
Repository baseline: `9bb5f96` on `codex/release-gates-automation`

## Isolation decision

The hackathon MVP lives entirely in `vk-tech-hackathon/`.  It does not add a
route, a database migration, a queue, or an environment requirement to the
production Lazyum applications.  Its package declares the runtime libraries it
uses and can be run from this directory.  Code is adapted into local modules
rather than importing production application internals at runtime.

## Reusable implementation assets

| Existing area | What it already provides | MVP use |
| --- | --- | --- |
| `apps/web/src/components/new-project-form.tsx` | Russian creation-flow copy, file drop-zone behavior, slide-count control, useful loading and recoverable-error states. | Recreate the compact topic/template/materials form with the same interaction conventions, not the production project creation API. |
| `apps/web/src/components/project-editor/editor-canvas.tsx` | DOM rendering conventions for `CanvasElement` kinds and an accessible element label. | Adapt its native-text/shape canvas rendering into the local editor. |
| `apps/web/src/components/project-editor/editor-geometry.ts` | Canvas coordinate model and pointer-driven move/resize patterns. | Use the same 16:9 pixel geometry and selection semantics in the local editor. |
| `apps/web/src/components/project-editor/project-editor.tsx` | Slide rail, canvas, selection, text editing, move/resize and local save flow. | Keep only the editor core; exclude project workflow, auth, collaboration, defense and API persistence. |
| `packages/shared/src/presentation/schemas.ts` | Zod-first `CanvasElement`, `SlideCanvas`, slide and theme contracts. | Keep the same essential canvas shape locally, with additional template provenance. |
| `packages/shared/src/presentation/canvas-audit.ts` | Bounds, overflow and generated-canvas safety checks. | Adapt deterministic bounds/overlap/typography checks into the hackathon audit layer. |
| `packages/shared/src/presentation/canvas-builder.ts` | Existing editable-canvas construction, ordering and fallback concepts. | Preserve the editable-canvas-first approach, but do not call Lazyum's standard-theme builders because template layouts must be the primary source of visual language. |
| `apps/worker/src/tasks/export/pptx-canvas.ts` and `pptx-content.ts` | Native `addText`/`addShape` PPTX mapping, pixel-to-inch conversion and element ordering. | Adapt native PPTX export locally so exported text and shapes are not flattened. |
| `apps/worker/src/tasks/extract.ts` | ZIP/XML extraction approach for document sources. | Reuse the same dependency choices for deterministic PPTX and DOCX inspection. |
| `apps/worker/src/tasks/presentation/orchestrator.ts` and `providers/generation.ts` | Separation of orchestration, provider selection, prompts and normalized generation output. | Keep provider-independent planning behind a local `LlmProvider`; the default MVP planner is deterministic and requires no credentials. |

## What must be copied or adapted

1. A compact, self-contained `CanvasElement` schema and editor renderer.  The
   production editor imports routing, React Query, save queues, dialogs and
   project-specific state; copying all of that would tie the MVP to production
   APIs and defeat the isolation requirement.
2. Native-object PPTX export primitives: slide sizing, text, shapes, image
   relationships and z-order.  The production worker exporter depends on
   storage and job infrastructure not needed for a local hackathon flow.
3. Office ZIP/XML parsing primitives using `jszip` and `fast-xml-parser`.
   The parser needs separate handling for themes, masters, layouts, slides and
   relationship files; source extraction alone is insufficient.
4. Form state and validation patterns from the existing creation screen,
   without billing, authentication or a persisted Lazyum project.

## What the MVP deliberately omits

- Auth.js, accounts, usage limits, billing, pricing, subscriptions and
  commercial generation caps.
- Dashboard, folders, referrals, collaboration, admin and legacy MVP routes.
- BullMQ, PostgreSQL, Redis and MinIO.  This MVP keeps its deck in browser
  state and sends only explicit upload/export requests to its local server.
- Lazyum's standard style picker and generic theme builders.  A supplied PPTX
  template is the style source.
- AI image generation and arbitrary pixel coordinates from an LLM.  The
  default planner is deterministic; a future provider can only return the
  validated semantic `PresentationPlan`.

## New MVP dependencies

The isolated package needs the already used TypeScript/Next/React runtime plus
`zod`, `jszip`, `fast-xml-parser`, `mammoth`, `pdf-parse` and
`@studydeck/pptxgenjs`.  No new external service or credential is required for
the deterministic end-to-end path.  The package records these dependencies in
its own `package.json`.

## Production areas that must not be changed

- `apps/web`, including its App Router routes, project creation and editor
  persistence.
- `apps/api`, especially `sources` and `exports` controllers/services.
- `apps/worker`, including generation, extraction, queues, exports and cost
  envelope enforcement.
- `packages/shared`, whose production contracts are already in a dirty
  worktree and must remain backwards compatible.
- Docker compose files, production routes, database schema/migrations and
  deployment scripts.

## Functions that must not be rebuilt unnecessarily

- Office packages are ZIP archives: use `JSZip` and XML parsing rather than a
  binary PPTX parser written from scratch.
- PPTX export must call native `addText`, `addShape` and `addImage` operations
  from the existing PptxGenJS stack, never rasterize a slide into a background.
- The 16:9 editable canvas already has clear geometry conventions: elements
  have stable IDs, `x/y/w/h`, z-order, and text/shape/image-specific payloads.
- Existing input upload patterns already cover drag-and-drop, file chips,
  validation and recoverable errors; this MVP only needs a local equivalent.

## Audit conclusion

The fastest safe path is a nested, independently runnable Next application
with local parser, planner, layout-engine, renderer, auditor and exporter
modules.  It adapts the production canvas/export vocabulary but has no runtime
dependency on a Lazyum API, worker, database or production route.
