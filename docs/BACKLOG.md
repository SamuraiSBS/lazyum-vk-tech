# Priority backlog

## P0 — acceptance before a demo

1. **P0-TEMPLATE-FIDELITY — role-aware template transfer (highest priority).**
   On the ordinary generation path, select suitable template slide roles and
   compositions for the opening, substantive content, lists, diagrams,
   summary and ending, in narrative order. Replace sample text and data while
   preserving the selected slide's role, composition, background and important
   artwork on the cover, intermediate slides and final slide. Matching the
   cover background and reproducing template compositions that use black
   backgrounds with white text are part of this same P0. Do not force a global
   black background and white text when the selected source composition does
   not use that style. Keep the implementation generic across PPTX files; do
   not branch on a template filename.
   - Reproduce the user-reported symptom that only the first-slide background
     matched using the ordinary `/api/generate` → published `/api/export` path
     for a 10-slide `VK Tech шаблон.pptx` deck. Treat this as user testimony
     until reproduced; do not attribute it to the existing PowerPoint review.
   - Review all 10 slides of the published export in PowerPoint. The narrative
     roles must fit, the ending must be last, the selected compositions and
     important template elements must carry through, and text must remain
     readable without overlaps or clipping. Tests or audit PASS alone are not
     Visual GO.
2. Run the browser flow with at least three real user-provided PPTX templates:
   one corporate template, one photo-led template and one deck with a strong
   master/layout system. Compare editor, PPTX and PowerPoint editability.
3. Add visual export parity: render the editor, generated PPTX/PDF and compare
   title/body positions, text overflow and margins.
4. Preserve template image assets and image cropping relationships in the
   local asset store so image-led templates retain their visual anchors.

The three retained P0 checks above remain regression and demo criteria for
P0-TEMPLATE-FIDELITY.

## P1 — fidelity and reliability

1. Resolve slide-to-layout-to-master relationships explicitly and extend
   background, placeholder and master-shape inheritance beyond the selected
   slide-role/composition transfer required by P0-TEMPLATE-FIDELITY.
2. Support grouped transforms, custom geometry, tables and charts more deeply.
3. Add a per-layout confidence score and show parser warnings beside the
   selected slide.
4. Use deterministic text measurement for installed fonts instead of the
   conservative character estimate.
5. Persist local presentations in an isolated MVP database or file store,
   retaining no dependency on production Lazyum project tables.

## P2 — future generation quality

1. Implement a source-grounded VK/local/external LlmProvider adapter with
   strict schema parsing and provider/cost policy.
2. Make Compact, Balanced and Visual differ in semantic plan density as well
   as layout ranking.
3. Add a VLM or rendered-slide audit only after the deterministic audit
   remains the hard baseline.
4. Add safe image search/attribution and editable diagram/chart builders.
