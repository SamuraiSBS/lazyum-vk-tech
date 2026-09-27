# Приёмка на реальных шаблонах

Автоматические фикстуры защищают детерминированное поведение парсера и
экспорта, но не заменяют приёмку в PowerPoint. Перед демонстрацией выполните
эту последовательность для трёх предоставленных шаблонов из
`fixtures/templates/organizer/`:

## Вспомогательный bounded render smoke

Для локального доказательства PPTX-render используется LibreOffice Impress в
headless-режиме:

- renderer: `C:\Program Files\LibreOffice\program\soffice.com`;
- версия, проверенная 2026-09-17: `LibreOffice 26.8.0.3`;
- конвертация: `PPTX -> PDF` через `pdf:impress_pdf_Export`;
- определение числа страниц и получение PNG: уже установленный Poppler
  (`pdfinfo` и `pdftoppm`), это только PDF-rasterizer, не второй PPTX renderer;
- команда: `npm run render-smoke` из `vk-tech-hackathon`.

Smoke перебирает все три `.pptx` из `fixtures/templates/organizer/`, проверяет
непустой PDF и PNG только первого слайда каждого входа, число страниц, bounded
job timeout `300000 ms` и отдельный process timeout `60000 ms`, а также
повторяемость PNG SHA-256 между двумя запусками. Артефакты
сохраняются только во временный каталог `%TEMP%\vk-tech-hackathon-render-smoke-*`
и не добавляются в Git. Имена, цвета и layouts конкретных organizer fixtures не
используются как ветвления в production-коде.

Этот smoke намеренно остаётся быстрым диагностическим first-slide check и не
считается полной route acceptance: он не rasterizes все страницы и не вызывает
`POST /api/analyze`.

Последний успешный запуск `2026-09-17` на LibreOffice `26.8.0.3` получил:

| Вход | Страницы | Первый PNG SHA-256, одинаковый в двух запусках |
| --- | ---: | --- |
| `VK Tech шаблон.pptx` | 54 | `e94877d5449b38d010f2258eb8ded2a5cf8ac631c4be53460fca9b6e4fbe4dbc` |
| `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx` | 29 | `e1df884b337d2aec7bfc310c8c02b4a0058cca89dbeab2a56be29219d246ab80` |
| `Шаблон презентации VK Education.pptx` | 55 | `3e1434ffc36a7a3b5721e7595b5c76afbdd67e38a71bd2d36ed98021b1878cf4` |

Это доказывает доступность и воспроизводимость выбранного локального
renderer-path для первых страниц трёх acceptance-входов, но не визуальную
fidelity и не parity с PowerPoint/DOM.
LibreOffice может отличаться в шрифтах, эффектах, SmartArt, диаграммах,
кадрировании и унаследованных master-объектах. PDF содержит изменяемые
renderer metadata, поэтому PDF SHA-256 между запусками может отличаться;
повторяемость smoke оценивается по отрендеренному PNG и числу страниц. Adapter
реализован в `src/lib/render-evidence.ts` и подключён к `/api/analyze`; UI
загружает PNG через безопасный artifact route, а не рисует заменяющий DOM
mini-layout.

## Deterministic golden / side-by-side comparison

Отдельный opt-in runner запускается из `vk-tech-hackathon`:

```powershell
npm run render-compare
```

Намеренное обновление baseline выполняется только отдельной командой:

```powershell
npm run render-compare -- --update-golden
```

Runner перечисляет все `.pptx` в `fixtures/templates/organizer/`, прогоняет
каждый файл целиком через существующий LibreOffice → PDF → Poppler adapter,
проверяет page count, непустые PNG и metadata, затем сравнивает весь набор с
`fixtures/render-goldens/manifest.json`. Manifest хранит SHA-256, byte size и
размеры каждой из 138 страниц, но в Git лежат только 9 representative PNG:
first/middle/last для каждого fixture. Runtime current pages, копии baseline,
HTML и `report.json` остаются в `%TEMP%\vk-tech-hackathon-render-compare-*`.
Лимиты runner: job `300000 ms`, отдельный process `60000 ms`. При отсутствии
LibreOffice или Poppler runner останавливается с точным `RENDER_BLOCKER` и не
выбирает другой renderer.

Формат отчёта: stdout содержит `RENDER_COMPARE_STATUS`, manifest/report paths,
`pageCount=expected/current`, baseline/current `pageSetSha256`, baseline/current
PNG SHA-256 и byte size для representative slides, а также пути side-by-side
HTML. `status=passed` означает точное совпадение bytes/SHA и decoded RGBA
pixels с versioned PNG baseline. Это deterministic regression evidence только
для выбранного LibreOffice/Poppler pipeline; оно не утверждает parity с
PowerPoint или DOM и не закрывает visual fidelity.

Последний успешный запуск `2026-09-17`:

| Вход | Страницы | Полный baseline/current page-set SHA-256 |
| --- | ---: | --- |
| `VK Tech шаблон.pptx` | 54 | `063fa079a0f7318028d9a8abd42b39db31dc60eda29976e86187717de6609f51` |
| `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx` | 29 | `adf90790fa8b7c08bb5c13695e55fd01aa280790884ca16a8173083d562467e3` |
| `Шаблон презентации VK Education.pptx` | 55 | `fbc3716158659ffbec27ece404fb1b96feb3cd0963844c37b1590e7df1d8ce4b` |

Для этого запуска baseline/current SHA representative pages совпали:
`VK Tech шаблон.pptx` — slides `1/27/54`, `VK_WorkSpace...` — `1/15/29`,
`VK Education` — `1/28/55`. JSON report:
`C:\Temp\vk-tech-hackathon-render-compare-acnVgO\report.json`.
Side-by-side evidence:
`C:\Temp\vk-tech-hackathon-render-compare-acnVgO\side-by-side\fixture-1.html`,
`fixture-2.html`, `fixture-3.html`.

## Полная route acceptance

Полный путь проверяется отдельным тестом и реальными HTTP-запросами:

```powershell
$env:VK_HACKATHON_REAL_TEMPLATE_ACCEPTANCE = "1"
npm run test -- tests/analyze-route-real.acceptance.test.ts
```

2026-09-16 собранный `next start` был запущен с
`VK_HACKATHON_ARTIFACT_ROOT=C:\Temp\vk-tech-hackathon-m1-runtime-20260916-1055`,
после чего реальные multipart `POST /api/analyze` отправлены для всех трёх
immutable organizer PPTX:

| Вход | HTTP | Job | Status | PNG | Файлов в job |
| --- | ---: | --- | --- | ---: | ---: |
| `VK Tech шаблон.pptx` | 200 | `job-e90155a7-2079-4d5f-a1be-820ab7fff21b` | `ready` | 54 | 59 |
| `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx` | 200 | `job-f15959d9-0344-4b72-8f4b-3393da7653fd` | `ready` | 29 | 34 |
| `Шаблон презентации VK Education.pptx` | 200 | `job-f74e7a80-4b5b-40bf-b77e-6cb3cb3ca5a3` | `ready` | 55 | 60 |

Каждый job фактически содержит:

- `manifest.json`;
- `input/template.pptx`;
- `parsed/design-system.json`;
- `parsed/render-evidence.json`;
- `parsed/renders/template.pdf`;
- `parsed/renders/slide-1.png` … `slide-N.png`, где `N` равен полному числу
  страниц входного PDF.

Read-only проверка этих трёх job подтвердила `metadataOk=true` и
`safeRelativePaths=true` для всех опубликованных input/parsed/PDF/PNG
references: размеры совпадают с файлами, SHA-256 совпадает с содержимым, а
пути остаются относительными и безопасными. Маленький 2-слайдовый fixture
покрыт route integration test и продолжает проходить.

- `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx`
- `VK Tech шаблон.pptx`
- `Шаблон презентации VK Education.pptx`

Их контрольные суммы и правило не подгонять реализацию под конкретные файлы
указаны в `fixtures/templates/organizer/README.md`.

## Opt-in acceptance для внешнего held-out шаблона

Harness находится в `tests/analyze-route-held-out-template.acceptance.test.ts`.
Он намеренно не содержит внешний PPTX в репозитории, fixtures или golden
manifest и запускается только когда одновременно заданы явный флаг и
абсолютный путь. Во всех остальных случаях Vitest помечает suite как skipped.

```powershell
$env:VK_HACKATHON_HELD_OUT_TEMPLATE_ACCEPTANCE = "1"
$env:VK_HACKATHON_HELD_OUT_TEMPLATE_PATH = "C:\ABSOLUTE\PATH\TO\held-out-template.pptx"
npm run test -- tests/analyze-route-held-out-template.acceptance.test.ts
```

Тест вызывает существующий `POST /api/analyze`, не вызывает generation,
export, model/provider API или PowerPoint COM и не выбирает parser, renderer,
layout либо ожидаемое число страниц по имени файла. Число страниц берётся
только из полученного `renderEvidence`; проверяются status `200`, валидные
`DesignSystem`/manifest/render evidence, `input/template.pptx`, PDF, PNG для
каждой фактически отрендеренной страницы и соответствие содержимого каждому
опубликованному `byteSize`/SHA-256. Artifact root создаётся во временном
каталоге и удаляется в `afterAll`.

**Статус:** harness готов, но held-out acceptance пока **не PASS**: внешний
файл не был предоставлен, поэтому отдельный результат не сохранён и реальный
held-out прогон не выполнялся.

1. В `vk-tech-hackathon` выполните `npm ci` и `npm run dev`.
2. Загрузите каждый шаблон и убедитесь, что отладочное представление сообщает
   верные пропорции, палитру, макеты и все предупреждения парсера.
3. Для одного brief сгенерируйте 10 слайдов в вариантах Compact, Balanced и
   Visual. Убедитесь, что Compact содержит меньше деталей в основном тексте,
   а Visual отдаёт приоритет визуальным композициям.
4. Убедитесь, что исходное изображение появляется на редактируемом холсте,
   если выбранный исходный макет содержит встроенную картинку.
5. Отредактируйте один заголовок, переместите одну фигуру, измените размер
   одного элемента и экспортируйте PPTX.
6. Откройте экспорт в PowerPoint. Убедитесь, что текст редактируется, фигуры
   можно выделять независимо, встроенные изображения являются отдельными
   картинками, а размер страницы совпадает с исходным шаблоном.
7. До объявления MVP принятым зафиксируйте предупреждения парсера и визуальные
   расхождения в `docs/MVP_STATUS.md`.

## Результат текущего acceptance-run

Дата: `2026-09-17`.

Итог: **ACCEPTED / GREEN для этого узкого acceptance slice**.

### Renderer и UI analysis

Из запущенного Next-приложения `npm run start` на
`http://localhost:3030` существующий
`C:\Program Files\LibreOffice\program\soffice.com` успешно запускается
через Node `child_process.spawn`:

```text
event=close code=0 stdout=LibreOffice 26.8.0.3 bce0998afefdbc355585ca324285661a2170ba77 stderr=
```

Все три immutable organizer PPTX проверены через UI. UI показывает фактические
PNG из сохранённых artifact jobs, включая текст
`PNG загружен из сохранённого artifact job, а не собран DOM mini-layout.`

| Шаблон | Job | PNG pages | Natural dimensions |
| --- | --- | ---: | --- |
| `VK Tech шаблон.pptx` | `job-0523aa61-aaff-49ab-8981-ae46497b2e47` | 54 | `900 × 1600` |
| `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx` | `job-44bb0601-86dd-4eb8-9421-8801df2771c5` | 29 | `900 × 1600` |
| `Шаблон презентации VK Education.pptx` | `job-e3d643f5-e400-4c47-997b-c0654ff3bb88` | 55 | `900 × 1600` |

Парсерные fallback warnings зафиксированы и не являются blocker. Размер
`900 × 1600` — фиксированная цель Poppler rasterizer, а не нативная
ориентация слайда.

### Generation, variants, editor и exports

Для brief `Презентация цифрового дизайнера презентаций для внутреннего питча`
на 10 слайдов UI создал Compact, Balanced и Visual на `VK Tech`; каждый
результат содержит 10 слайдов. На `VK Tech` / Balanced подтверждены
редактирование заголовка, move фигуры примерно `x=159.3,y=520.3` →
`x=184.3,y=535.3` и resize примерно `12 × 12` → `36.5 × 31.5`.

После узкого исправления layout selection и template image set `VK Education`
Visual проходит без прежней ошибки:

```text
too_big: Array must contain at most 200 element(s)
path: slides[0..9].canvas.elements
```

Финальные реальные Visual generation/export для всех трёх templates вернули
HTTP 200 и 10 слайдов:

| Шаблон | JSON / PPTX | PPTX size |
| --- | --- | ---: |
| `VK Tech` | `.data/acceptance/final6/vk-tech-10-visual.json` / `.pptx` | 25,918,699 bytes |
| `VK WorkSpace` | `.data/acceptance/final6/workspace-10-visual.json` / `.pptx` | 5,644,181 bytes |
| `VK Education` | `.data/acceptance/final6/education-10-visual.json` / `.pptx` | 8,776,147 bytes |

Финальный первый слайд содержит `3` / `63` / `42` canvas elements для VK
Tech / WorkSpace / Education; oversized Education mosaic больше не выбирается.
Renderer и PPTX export используют согласованный перенос строк, поэтому
сгенерированные title/body помещаются в своих slots без crop/overlap.

### Microsoft PowerPoint и визуальная проверка

PowerPoint COM `16.0` открыл все три финальных export. Ранее в этом же
acceptance-контуре было подтверждено `LICENSE STATUS: ---LICENSED---`;
licensing не менялась. Read-only editability probe без сохранения прошёл для
всех export: отдельное редактирование текста, move/resize фигуры и move
изображения.

| Export | Slides | Page setup | First-slide native objects |
| --- | ---: | --- | --- |
| `VK Tech` | 10 | `720 × 405 pt` | 3 shapes, 2 text, 1 picture |
| `VK WorkSpace` | 10 | `960 × 540 pt` | 63 shapes, 59 text, 4 pictures |
| `VK Education` | 10 | `960 × 540 pt` | 42 shapes, 40 text, 2 pictures |

Page setup совпадает с нативными organizer PPTX. PowerPoint-render первых
слайдов сохранён в:

- `.data/acceptance/final6/powerpoint/vk-tech-10-visual.png`;
- `.data/acceptance/final6/powerpoint/workspace-10-visual.png`;
- `.data/acceptance/final6/powerpoint/education-10-visual.png`.

Side-by-side review закрыла прежний visual blocker в пределах этой задачи:
organizer backgrounds, logos, image assets и геометрия сохранены, а title/body
видимы без crop/overlap. Содержимое brief отличается от исходного placeholder
текста по назначению, поэтому exact pixel parity для другого текста не
заявляется. `0x1A8` не возник.

### Проверки и точные результаты

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test` | PASS — 49 passed, 3 skipped; 15 test files passed, 1 skipped |
| `npm run render-smoke` | PASS — reproducible, LibreOffice `26.8.0.3` + Poppler, 54/29/55 pages |
| `npm run render-compare` | PASS — full golden page sets 54/29/55; representative slides 1/27/54, 1/15/29, 1/28/55 exact |
| Node `child_process.spawn` → LibreOffice | PASS в elevated running Next acceptance app; restricted sandbox `spawn EPERM` не является blocker приложения |
| `npm run start` + `http://localhost:3030` | PASS — собранное приложение поднято, HTTP `200` |
| UI analysis всех трёх шаблонов | PASS — фактические artifact PNG, jobs и 54/29/55 pages |
| UI generation Compact/Balanced/Visual | PASS — один brief/10 слайдов на `VK Tech`; Education Visual PASS после fix |
| Контролируемый PPTX export | PASS — финальные три `/api/export` HTTP 200 |
| PowerPoint COM / editability | PASS — все три export открыты, native object probe PASS, `0x1A8` не возник |
| PowerPoint page setup/proportions | PASS — `720 × 405 pt` / `960 × 540 pt` совпадают с исходниками |
| PowerPoint visual-fidelity slice | PASS — assets/геометрия сохранены, crop/overlap не обнаружены на проверенных первых слайдах |

### Verdict

**Accepted / GREEN для запрошенного узкого acceptance slice.** Закрыты
`spawn` blocker, `VK Education` Visual `too_big` и прежнее существенное
расхождение PowerPoint-render с organizer composition на проверенных первых
слайдах. Не добавлялись второй renderer, provider/features или обход
PowerShell-only smoke; Office licensing не исправлялась. Более широкая pixel
parity для произвольных будущих шаблонов, master-объектов и другого содержимого
этим acceptance не заявляется.

## 2026-09-23 — Deterministic organizer-template PowerPoint gate

### Scope and fixes

Deterministic local acceptance (`VK_HACKATHON_LLM_PROVIDER=deterministic`)
covered all three immutable organizer templates and all three generated
variants (`Compact`, `Balanced`, `Visual`), with 10 slides per export. No live
provider or network request was made.

The first run exposed two fatal-audit defects. Timeline fallback labels were
drawn over the regular body-text slot; the renderer now uses the timeline
labels as the body content and packs the content into at most four labels.
WorkSpace inherited decorative lines outside the canvas and long body text was
placed in a slot too narrow to fit; the renderer now clips decorative geometry
to the slide and selects a body slot only when the deterministic text-fit
estimate accepts it. Regression tests cover both defects and the timeline
fallback.

### Route, audit, export, and PowerPoint evidence

All three generation routes returned HTTP 200 and `ready`; all nine variant
audits passed with zero error-severity issues, and all nine `/api/export`
requests returned PPTX files. Non-fatal audit warnings remain, including
`ELEMENT_OVERLAP`, `DENSE_LAYOUT`, and `COLOR_OUTSIDE_DESIGN_SYSTEM` in some
variants. The current first Visual slide for VK Tech places body text across a
large dark phone image; the text remains legible, but the overlap warning is
not treated as proof of visual polish.

| Organizer template | Job | Slides per variant | Page setup |
| --- | --- | ---: | --- |
| `VK Tech шаблон.pptx` | `job-354e9832-33e3-4f74-81f4-34b0fd32e595` | 10 | `720 × 405 pt` |
| `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx` | `job-482bd570-c7d5-4bab-b878-34fbfabe8d7c` | 10 | `960 × 540 pt` |
| `Шаблон презентации VK Education.pptx` | `job-ca17a61d-15f3-4ec2-a06e-6aaa5b1f73b5` | 10 | `960 × 540 pt` |

Microsoft PowerPoint `16.0` opened all nine exports. For each file, transient
text edit/restore, shape move/resize, and picture move probes passed; SHA-256
checks before and after the probes matched. Page setup matches the respective
source template. The first Visual slide from each template was rendered by
PowerPoint at `1920 × 1080` and visually reviewed. This is a three-slide visual
sample, not a manual review of all 90 exported slides.

### Verification and artifacts

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| Focused renderer, generation-route, and export-route tests | PASS — 3 files, 16 tests |
| Deterministic parser/planner/renderer/audit preflight | PASS — 9/9 variant audits, zero errors |
| HTTP generation and PPTX export | PASS — 3/3 jobs ready, 9/9 exports |
| PowerPoint open/editability/page setup probes | PASS — 9/9 exports |
| PowerPoint first-Visual-slide review | PASS for the inspected sample; see overlap limitation above |

Full route evidence, input and export hashes, PowerPoint probe details, and
PNG hashes are in
`.data/acceptance/p0-12.6b-powerpoint-20260923-after-overlap-fix/final-export/acceptance-summary.json`.
The reviewed PowerPoint PNGs are
`.../final-export/powerpoint/vk-tech-visual.png`,
`.../final-export/powerpoint/workspace-visual.png`, and
`.../final-export/powerpoint/education-visual.png` under the same evidence
directory. Source and regression changes remain uncommitted. This acceptance
does not establish full-deck visual parity, arbitrary-template fidelity, or
live-provider/VLM readiness.
