# Статус MVP

Последнее обновление: 2026-09-21

| Область | Статус | Подтверждение |
| --- | --- | --- |
| Изолированная директория проекта | Реализовано | Весь код хакатона находится в `vk-tech-hackathon`; production-код не изменялся. |
| M1: понимание шаблона PPTX | Реализовано для deterministic evidence slice | Парсер извлекает размеры слайда, token-level evidence для цветов, шрифтов, размеров, weight, spacing, shape/stroke и фонов с confidence и OOXML sources; фиксирует разрешённые `.rels` связи slide→layout→master, theme sources и image asset metadata (target, размер, SHA-256). UI показывает компактную сводку confidence/evidence и источники без необработанного XML. Это structural evidence, а не visual parity или PowerPoint editability. |
| P0/M1: реальное PPTX render evidence | Реализовано и принято для локального server-side slice | Существующий adapter подключён к route: LibreOffice Impress экспортирует PDF, Poppler `pdfinfo` считает страницы, `pdftoppm` создаёт `slide-N.png` для каждого слайда. Job сохраняет PDF, PNG и `parsed/render-evidence.json`; route возвращает `RENDER_BLOCKER` с кодом при отсутствии renderer или timeout. Полный handler acceptance и реальные HTTP POST через собранный `next start` 2026-09-16 дали HTTP 200/`ready` для трёх organizer PPTX: 54/29/55 PNG. Default job timeout — 300000 ms (жёсткий максимум 900000), отдельный process timeout — 60000 ms. |
| P0-10.1: held-out-template acceptance harness | Harness готов; external PASS отсутствует | Opt-in тест требует одновременно `VK_HACKATHON_HELD_OUT_TEMPLATE_ACCEPTANCE=1` и абсолютный `VK_HACKATHON_HELD_OUT_TEMPLATE_PATH`; иначе suite skipped. Он прогоняет внешний PPTX только через `POST /api/analyze` и сверяет server-side manifest, DesignSystem, render evidence, immutable input, PDF и все фактически отрендеренные PNG с byteSize/SHA-256. Внешний файл не добавляется в fixture/golden, временный artifact root удаляется. Реальный held-out файл ещё не предоставлен и запуск не выполнялся, поэтому это не PASS и не доказательство arbitrary-template visual fidelity. |
| P0/M1: deterministic golden/side-by-side regression | Реализовано для render slice | Opt-in `npm run render-compare` сравнивает полный набор 54/29/55 PNG с versioned `fixtures/render-goldens/manifest.json` по page count, dimensions, byte size, SHA-256 и decoded pixel diff; 9 representative first/middle/last PNG дают HTML side-by-side evidence во временном каталоге. PASS означает воспроизводимость LibreOffice/Poppler baseline, а отдельная PowerPoint-проверка ниже закрывает узкий visual-fidelity acceptance slice. |
| P0/M1: текущая ручная visual-fidelity и PowerPoint acceptance | Реализовано и принято для этого узкого acceptance slice | 2026-09-17: elevated `next start` и реальные API-запросы подтвердили запуск существующего `soffice.com` через Node `spawn`; все три immutable organizer fixture показали фактические PNG artifact jobs: 54/29/55 слайдов, `900 × 1600` (фиксированная цель Poppler rasterizer). Compact/Balanced/Visual на одном brief прошли на `VK Tech`, edit actions прошли, а финальный 10-слайдовый Visual export создан для каждого шаблона. PowerPoint COM открыл все три финальных export: нативные текст/фигуры/изображения редактируемы, page setup совпадает (`720 × 405` / `960 × 540`), `0x1A8` не возник. После ограничения количества template elements и синхронизации wrapping финальная Education Visual генерация проходит; прежний `too_big` закрыт. PowerPoint PNG review подтвердил сохранение organizer assets/геометрии и отсутствие crop/overlap на проверенных первых слайдах; generated copy закономерно отличается от placeholder copy. Подробная таблица — в `docs/REAL_TEMPLATE_ACCEPTANCE.md`. |
| M2: поток ввода | Реализовано | Brief, обязательный шаблон PPTX, необязательные PDF/DOCX/PPTX/TXT/MD/CSV/XLSX и PNG/JPEG/WebP/GIF, 5–15 слайдов, три варианта плотности и валидированные ошибки. |
| M2: контент и планирование | Частично реализовано | Парсер сохраняет обратные поля `brief`, `documents`, `excerpts`, `keywords` и формирует детерминированные source chunks для TXT/MD/CSV/PPTX/XLSX с точными locator-ами, source-level chunks для DOCX/PDF с `precision=document`, а для поддержанных изображений — проверенные MIME/byte metadata chunks без OCR. Планировщик поддерживает явный deterministic offline mode и изолированный Yandex AI Studio adapter; `PresentationPlan.meta` фиксирует provider/modelUri/prompt hash/timestamp/attempts, `PlanClaim.precision` и `PlanSlide.sourceRefs` проходят source-grounding validation, а route возвращает bounded error code/stage/attempts. Retry/cost policy, live provider acceptance и VLM/retrieval остаются открытыми. |
| M2: выбор макета по шаблону | Реализовано | Движок макетов ранжирует исходные композиции по назначению, числу карточек, визуальному намерению, вместимости и выбранному варианту. |
| M2: редактируемая презентация | Реализовано | Локальная адаптированная геометрия редактора Lazyum: лента слайдов, редактируемый текст, выделение, перемещение, изменение размера и сохранение черновика в браузере. |
| M2: экспорт PPTX | Реализовано для этого acceptance slice | Нативное отображение текста/фигур/изображений через PptxGenJS и HTTP 200 подтверждены для трёх финальных 10-слайдовых Visual export. PowerPoint открыл все файлы; native editability probe, отдельные объекты и page setup прошли. |
| Сохраняемый artifact/job slice | Реализовано для `/api/analyze` и `/api/generate` | `ArtifactManifest` v1 и файловое хранилище сохраняют input/parsed evidence, а один generation job теперь публикует `planning/plan.json`, `variants/{compact,balanced,visual}.json` и `audit/{compact,balanced,visual}.json` с безопасными путями, byteSize и SHA-256. Read-only artifact route выдаёт только опубликованные ссылки; старый одиночный v1 reference и `/api/export` остаются читаемыми. |
| M3: Compact/Balanced/Visual | Реализовано для технического contract slice | Один `/api/generate` создаёт ровно три документа и три audit reports от общего normalizedContent/DesignSystem/PresentationPlan; UI показывает selectable cards/tabs, переключение не вызывает повторную генерацию, а edit/export работают с выбранным документом. Полная visual fidelity и held-out-template acceptance не заявляются. |
| M4: детерминированный аудит | Реализовано | Проверки границ, переполнения, перекрытий, мелкого текста, пустых слотов, неподдерживаемых шрифтов, дрейфа палитры, отступов и плотности возвращают структурированный JSON. |
| Покрытие тестами | Реализовано для contract slice | Focused tests подтверждают metadata/precision/slide refs, provider modelUri и error classification, три варианта, общий plan/design system/normalized content, все artifact paths с size/SHA и artifact route, balanced export alias и failed partial save без ready manifest. Финальный `npm run test` — 79 passed / 4 skipped; 22 test files passed, 1 skipped. Это не полноценный browser E2E и не visual-fidelity acceptance. |

## Известные ограничения

1. Анализ шаблона детерминированный, но это не полный движок рендеринга
   PowerPoint. SmartArt, неподдерживаемые диаграммы, анимация, произвольная
   геометрия, трансформации групп и часть унаследованных деталей master-слайдов
   отмечаются в отчёте или аппроксимируются, а не воспроизводятся точно.
2. Ресурсы изображений шаблона, встроенные в обычные связи слайда, сохраняются;
   кадрирование, внешние связанные изображения и сложные эффекты изображения —
   будущая работа.
3. Подгонка текста — детерминированная оценка. Render evidence подтверждает
   реальный путь LibreOffice/Poppler и PNG входного шаблона, но не доказывает
   визуальное сопоставление экспортированного PPTX/PDF с редактором для
   сложных шрифтов и письменностей.
4. Планирование намеренно детерминированно. Подключение настоящего провайдера
   требует утверждённого адаптера, политики моделей, привязки к источникам и
   контроля стоимости. Для текущего local contract slice adapter wired, но live
   provider acceptance и retry/cost control остаются открытыми.
5. Provenance покрывает только текущие поддерживаемые текстовые материалы:
   TXT/MD/CSV/PPTX получают точные строковые/табличные/слайдовые locator-ы,
   DOCX/PDF — только locator `document` с `precision=document`, без
   выдумывания страниц. Это минимальный source-chunk срез, а не полноценный
   source grounding или аудит утверждений.
6. UI выдаёт три варианта из одного generation job и позволяет переключаться
   между ними без повторной генерации; полноценная visual-distinctness и
   held-out-template acceptance остаются отдельными задачами.
7. Полная render parity между DOM/PPTX и экспортом PDF/HTML в проекте не
   заявляется. Доступен сохраняемый локальный `PPTX -> PDF -> PNG` evidence
   через LibreOffice и Poppler, deterministic golden regression для полного
   набора страниц и отдельная PowerPoint-проверка трёх organizer templates.
   Последняя закрывает только этот узкий acceptance slice, а не любые
   сложные шрифты, SmartArt, master-объекты или произвольные будущие layouts.
   `LlmProvider` имеет изолированный Yandex adapter, но реальный billable/live
   acceptance провайдера не выполнялся.
8. Acceptance rerun 2026-09-17 подтвердил UI renderer и фактические PNG
   artifact для всех трёх organizer fixtures: jobs `job-0523aa61-aaff-49ab-
   8981-ae46497b2e47` (54), `job-44bb0601-86dd-4eb8-9421-8801df2771c5`
   (29) и `job-e3d643f5-e400-4c47-997b-c0654ff3bb88` (55), все `900 × 1600`.
   На одном brief/10 слайдах `VK Tech` прошли Compact, Balanced и Visual;
   title edit, shape move/resize и IndexedDB reload persistence подтверждены.
   Финальный Visual API generation/export прошёл для всех трёх templates.
   PowerPoint render review первых слайдов подтвердил organizer
   assets/геометрию, нативный page setup и отсутствие crop/overlap; точный
   PowerPoint pixel parity с другим текстовым содержимым не заявляется.
9. Token-level evidence описывает детерминированные OOXML-наблюдения и
   fallback-диагностику. Он не доказывает visual parity, качество композиции
   или редактируемость экспортированного PowerPoint.

В рамках этого slice проверены `npm run build`, `npm run typecheck`,
`npm run test`, gated real acceptance test, реальные HTTP POST через собранный
`next start`, `npm run render-smoke` и `npm run render-compare`; root build, commit, push и deploy не
выполняются. Если на Windows отсутствует LibreOffice или Poppler, route и
`render-smoke`/`render-compare` останавливаются с точной причиной, а это не считается зелёным
render acceptance. Следующие P0 — более широкий held-out/arbitrary-template
visual fidelity, сохраняемые planning/variants/exports и source-grounded
planning; узкий PowerPoint acceptance slice уже принят без объявления полной
visual fidelity доказанной.

## Текущий acceptance-run 2026-09-17

Итог: **ACCEPTED / GREEN для этого узкого acceptance slice**. Тестовый
`next start` запущен на `http://localhost:3030` с процессным override
`VK_HACKATHON_LLM_PROVIDER=deterministic`. Существующий
`C:\Program Files\LibreOffice\program\soffice.com` запускается из Node
`child_process.spawn` внутри работающего Next-приложения:

```text
event=close code=0 stdout=LibreOffice 26.8.0.3 bce0998afefdbc355585ca324285661a2170ba77 stderr=
```

### UI analysis и artifact PNG

Все три immutable organizer PPTX проверены через UI. UI показывает фактические
PNG сохранённого artifact job, а не DOM mini-layout; в интерфейсе присутствует
текст `PNG загружен из сохранённого artifact job, а не собран DOM mini-layout.`

| Шаблон | Job | PNG pages | Natural dimensions |
| --- | --- | ---: | --- |
| `VK Tech шаблон.pptx` | `job-0523aa61-aaff-49ab-8981-ae46497b2e47` | 54 | `900 × 1600` |
| `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx` | `job-44bb0601-86dd-4eb8-9421-8801df2771c5` | 29 | `900 × 1600` |
| `Шаблон презентации VK Education.pptx` | `job-e3d643f5-e400-4c47-997b-c0654ff3bb88` | 55 | `900 × 1600` |

`900 × 1600` — фиксированная цель Poppler rasterizer, а не нативная
ориентация слайда. Повторная UI-проверка Education также показала 10 слайдов,
фактические image nodes из artifact, редактируемые title/body и успешное UI
сообщение `PPTX скачан. Текст и фигуры в нём сохранены как нативные объекты.`

### Generation, editor и exports

Для brief `Презентация цифрового дизайнера презентаций для внутреннего питча`
на 10 слайдов UI успешно создал Compact, Balanced и Visual для `VK Tech`; все
результаты содержали 10 слайдов. На `VK Tech` / Balanced подтверждены title
edit (`Как работает pipeline`), move shape примерно `x=159.3,y=520.3` →
`x=184.3,y=535.3` и resize примерно `12 × 12` → `36.5 × 31.5`.

Финальный реальный Visual generation через API и экспорт `/api/export` для
всех трёх immutable templates вернули HTTP 200 и 10 слайдов:

| Шаблон | Final JSON / PPTX | Размер PPTX |
| --- | --- | ---: |
| `VK Tech` | `.data/acceptance/final6/vk-tech-10-visual.json` / `.pptx` | 25,918,699 bytes |
| `VK WorkSpace` | `.data/acceptance/final6/workspace-10-visual.json` / `.pptx` | 5,644,181 bytes |
| `VK Education` | `.data/acceptance/final6/education-10-visual.json` / `.pptx` | 8,776,147 bytes |

Education Visual больше не выбирает oversized image-mosaic composition и
проходит schema validation. Для финальных первых слайдов canvas elements было
`3` / `63` / `42` соответственно; прежний `too_big` для
`slides[0..9].canvas.elements` закрыт ограничением template image set и
выбором вместимой композиции. Wrapping renderer и PPTX text breaks
синхронизированы, поэтому title/body остаются видимыми без crop/overlap.

### Microsoft PowerPoint acceptance

PowerPoint COM `16.0` открыл все три финальных export. `LICENSE STATUS:
---LICENSED---` было подтверждено ранее в том же acceptance-контуре;
лицензирование не менялось. Read-only object-model probe прошёл для всех
трёх: отдельное редактирование текста, move/resize фигуры и move изображения.

| Export | Slides | Page setup (pt) | First-slide native objects |
| --- | ---: | --- | --- |
| `VK Tech` | 10 | `720 × 405` | 3 shapes, 2 text, 1 picture |
| `VK WorkSpace` | 10 | `960 × 540` | 63 shapes, 59 text, 4 pictures |
| `VK Education` | 10 | `960 × 540` | 42 shapes, 40 text, 2 pictures |

Нативные page setup экспортов совпадают с исходными organizer PPTX. Первые
слайды дополнительно отрендерены самим PowerPoint в:

- `.data/acceptance/final6/powerpoint/vk-tech-10-visual.png`;
- `.data/acceptance/final6/powerpoint/workspace-10-visual.png`;
- `.data/acceptance/final6/powerpoint/education-10-visual.png`.

Side-by-side review закрыла прежний узкий blocker: organizer backgrounds,
logos, image assets и геометрия сохранены; title/body видимы и не перекрывают
композицию. Текст brief намеренно отличается от placeholder text исходного
организатора, поэтому это не заявление о pixel parity при другом содержимом.

### Обязательные проверки

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test` | PASS — 49 passed, 3 skipped; 15 test files passed, 1 skipped |
| `npm run render-smoke` | PASS — LibreOffice `26.8.0.3` + Poppler, 54/29/55 pages; PNG reproducible |
| `npm run render-compare` | PASS — full golden page sets 54/29/55; representative slides 1/27/54, 1/15/29, 1/28/55 exact |
| Node `child_process.spawn` → LibreOffice | PASS в elevated running Next acceptance app; ordinary restricted sandbox `spawn EPERM` не является поведением приложения |
| UI analysis всех трёх шаблонов | PASS — artifact jobs и фактические PNG 54/29/55 |
| UI generation Compact/Balanced/Visual | PASS — один brief/10 слайдов на `VK Tech`; финальный Education Visual PASS |
| Контролируемый PPTX export | PASS — финальные три `/api/export` HTTP 200 |
| PowerPoint COM / editability | PASS — все три export открыты; native text/shape/image probe PASS; `0x1A8` не возник |
| PowerPoint page setup/proportions | PASS — `720 × 405 pt` / `960 × 540 pt` совпадают с исходниками |
| PowerPoint visual-fidelity slice | PASS — assets/геометрия сохранены, crop/overlap не обнаружены на проверенных первых слайдах |

### Verdict

**Accepted / GREEN для запрошенного узкого acceptance slice.** Закрыты
`spawn` blocker, Education Visual `too_big` и прежнее существенное расхождение
PowerPoint-render с organizer composition на проверенных первых слайдах.
Не добавлялись второй renderer, provider/features или обход PowerShell-only
smoke; Office licensing не исправлялась. Более широкая pixel parity для
произвольных будущих шаблонов, master-объектов и другого содержимого этим
acceptance не заявляется.
