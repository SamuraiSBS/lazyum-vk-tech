# P0 — Multi-agent generation pipeline

**Status:** implementation in progress. See [the project backlog](BACKLOG.md);\nreconcile this plan with current code and acceptance evidence before assigning\nwork.

**Scope:** only this repository. Do not modify unrelated Lazyum\napplications, production routes, or infrastructure.

## Objective


Raise generation quality by adding specialized model roles around the existing
deterministic presentation compiler:

```text
immutable inputs
  ↓
deterministic parser + content/fact normalization
  ↓
template analyst ─────┐
evidence analyst ─────┼─→ narrative ensemble → visual direction
                      │                         ↓
                      └────────────────── 3 variant designers
                                                ↓
                                  deterministic render + audit
                                                ↓
                              semantic/VLM critics in parallel
                                                ↓
                                       bounded repair loop
                                                ↓
                                           final jury
```

The product runtime gets one deterministic orchestrator. Model agents only
produce validated JSON artifacts. The parser, layout engine, renderer, audit,
patch application and export remain code-owned and deterministic.

This runtime multi-agent system must not be confused with the coding workflow.
The normal manual workflow may have multiple user-launched Codex executor chats
only for dependency-independent tasks with disjoint exact file scopes registered
in the shared local claim ledger described in `docs/TASK_COORDINATION.md`.
Every task still needs one independent read-only reviewer. This does not create
coding subagents or enable SourceCraft. The separately named automated
orchestrator workflow remains one executor plus one reviewer.

## Agent roles

The following are logical roles. They may use the same approved provider and
model, but each has a separate versioned prompt, schema and responsibility.

### 1. `template-analyst`

Input: `DesignSystem`, observed layouts, template render evidence and bounded
image references.

Output: `TemplateInterpretation`:

- semantic layout families and likely purposes;
- typography, spacing and color roles;
- text density and visual-capacity guidance;
- reusable layout IDs and confidence;
- template-specific risks and prohibited compositions.

It must not create coordinates, edit XML, or mutate the PPTX. Structural
geometry remains authoritative in the parser output.

### 2. `evidence-analyst`

Input: `NormalizedContent`, source chunks, typed facts and brief.

Output: `EvidencePack`:

- prioritized facts and claims;
- contradictions and unresolved gaps;
- audience-relevant evidence;
- exact `sourceChunkId`/`factId` references;
- unsupported material that must not become a claim.

Every substantive claim must be traceable. No external search, invented fact or
unreferenced statistic is allowed in the first version.

### 3. `narrative-architect`

Input: brief, `TemplateInterpretation` and `EvidencePack`.

Output: `NarrativePlan` / canonical `PresentationPlan`:

- audience and deck objective;
- slide order and purpose;
- one main message per slide;
- supporting claims and evidence refs;
- visual intent and transition to the next slide.

Run two independent candidates when quality mode is enabled, then use a
deterministic or model-based judge to select one. The selected plan remains
semantic and contains no coordinates or PPTX commands.

### 4. `visual-director`

Input: selected narrative plan, evidence pack and template interpretation.

Output: `VisualSpecPack`:

- chart/table/diagram/timeline/card/image intent;
- data and fact references;
- labels, units, legends and accessibility text;
- native-rendering requirements;
- fallback if the requested visual cannot be produced safely.

Use the existing `data-visual-spec` contract as the validation boundary.

### 5–7. `variant-designer-compact`, `variant-designer-balanced`,
`variant-designer-visual`

These are three independent agents running in parallel from the same canonical
plan, evidence graph and template interpretation.

Each produces a `VariantPlan` containing:

- explicit density/visual profile;
- selected observed layout IDs;
- semantic slot assignments;
- content compression or expansion decisions;
- visual-spec placement intent;
- rationale and expected trade-offs.

They may select observed layout IDs and semantic slots, but may not invent
arbitrary geometry. The deterministic layout engine materializes the result.
All three variants must remain available to the user.

### 8. `semantic-critic`

Input: rendered variant metadata, canonical plan, evidence pack and source refs.

Output: `CritiqueReport` with findings for:

- factual accuracy and grounding;
- narrative coherence;
- title/body alignment;
- unsupported or duplicated claims;
- weak slide transitions;
- unclear or overly verbose wording.

It is advisory and cannot directly change the deterministic audit verdict or
export decision.

### 9. `visual-critic`

Input: rendered PNG/PDF evidence, template render evidence, variant plan and
design tokens.

Output: `CritiqueReport` with findings for:

- template style fidelity;
- visual hierarchy and balance;
- clipping, overflow and contrast;
- layout repetition and density;
- image crop/stretch problems;
- whether the visual actually supports the slide message.

This role may use a VLM only behind a separate `VlmProvider` boundary. Its
output is advisory and never replaces deterministic geometry or export checks.

### 10. `repair-planner`

Input: deterministic audit, semantic/visual critiques and the current
`VariantPlan`.

Output: bounded `RepairPlan` with explicit slide/element targets and allowed
operations such as rewrite, switch observed layout, reduce content, or replace
a visual spec.

The renderer and patch applier execute repairs. The model never edits PPTX/XML,
filesystem artifacts or user drafts directly. At most two repair rounds are
allowed per variant in the first implementation.

### 11. `final-jury`

Input: all three variants, their audit reports, critique reports, repair history
and evidence coverage.

Output: `VariantRanking`:

- ranked variants;
- weighted score breakdown;
- blocking reasons;
- recommended default variant;
- remaining user-visible issues.

The jury ranks the three required outputs; it must not silently delete a
variant or override a fatal deterministic gate.

## Runtime orchestration contract

The orchestrator must execute the following DAG:

1. Create an immutable job and artifact manifest.
2. Run existing deterministic template parsing and content normalization.
3. Run `template-analyst` and `evidence-analyst` in parallel.
4. Run two narrative candidates and select one after schema and grounding
   validation.
5. Run `visual-director`.
6. Run the three variant designers in parallel.
7. Render and deterministically audit all three variants.
8. Run semantic and visual critics in parallel for each variant.
9. If needed, run a bounded repair plan, materialize patches deterministically,
   render again and re-audit.
10. Run `final-jury` and publish the three complete variant artifact sets.

Independent branches may run concurrently. Every stage must have a timeout,
attempt limit, structured status and persisted input/output artifact refs.
There must be no open-ended agent-to-agent chat or automatic retry loop.

## Artifact and provider contracts

Create versioned schemas and registry entries for:

```text
agents/template-analyst/v1
agents/evidence-analyst/v1
agents/narrative-architect/v1
agents/visual-director/v1
agents/variant-designer-compact/v1
agents/variant-designer-balanced/v1
agents/variant-designer-visual/v1
agents/semantic-critic/v1
agents/visual-critic/v1
agents/repair-planner/v1
agents/final-jury/v1
```

External prompts belong under `prompts/agents/<agent-id>/v1/system.md` and
must not be embedded in TypeScript.

Persist safe metadata for every run:

- agent ID and version;
- provider/model and policy result;
- prompt hash;
- parent artifact refs;
- attempt and duration;
- bounded usage metadata;
- output status and validation errors.

Never persist raw provider responses, secrets, authorization headers, hidden
reasoning, arbitrary filesystem paths or unbounded source payloads in public
manifests.

The provider layer should evolve from the current `LlmProvider` into separate
structured boundaries for text agents and optional `VlmProvider` image review.
The current competition policy still applies: only an approved model with the
required open-weights, licence and total-parameter evidence may make live
calls. Unlimited budget does not remove the competition's model restrictions
or the five-minute generation target.

## Hard gates

- Unknown or invalid agent output fails closed before the next stage.
- Every nontrivial claim has a valid source/fact reference or is omitted.
- No agent receives shell, filesystem, XML/PPTX mutation or export authority.
- Deterministic fatal audit blocks export.
- VLM/semantic findings remain advisory unless converted into a validated
  deterministic repair and re-audited.
- The three variants share the same accepted evidence graph but have measurable
  structural and visual differences.
- A job is not ready until planning, three variants, three deterministic audits
  and the final ranking are persisted with size/SHA references.
- Live/provider acceptance requires fresh explicit authorization; local mock
  agents and deterministic tests must cover the orchestration first.

## Implementation sequence

### P0-12.1 — Contracts and dry-run orchestrator

Add schemas, versioned registry, prompt locations, artifact graph and a
deterministic mock-agent runner. Do not make live model calls and do not change
the current generation result yet.

### P0-12.2 — Template/evidence specialist layer

Implement `template-analyst` and `evidence-analyst` against mock providers,
connect their validated outputs to the existing planner boundary, and prove
source/reference preservation.

### P0-12.3 — Narrative ensemble

Add two narrative candidates and a judge, with grounding and schema gates. Keep
the existing deterministic planner as an explicit fallback mode.

### P0-12.4 — Three variant designers

Add parallel Compact/Balanced/Visual `VariantPlan` branches and deterministic
materialization through the existing layout engine and renderer.

### P0-12.5 — Render-feedback critics and bounded repair

Persist rendered evidence, add semantic/VLM provider interfaces, critique
schemas, repair patches and at most two re-render/re-audit rounds.

### P0-12.6 — Jury, UI status and full acceptance

Expose stage progress and critique findings in the UI, persist ranking and run
the focused deterministic browser, export, held-out-template and PowerPoint
acceptance gates. Live provider/VLM acceptance is a separate explicitly
authorized step.

## First-task acceptance criteria

P0-12.1 is complete only when:

- the registry contains the agent IDs and versions above;
- every agent has a strict input/output contract;
- the dry-run DAG executes with deterministic mock agents;
- no live/provider/network call is made;
- all outputs are persisted as bounded artifact refs;
- invalid output, missing refs and fatal audit stop the pipeline;
- the existing single-planner deterministic generation remains unchanged;
- focused tests, package typecheck and `git diff --check` pass;
- no root Lazyum files, commit, push or deploy are touched.
