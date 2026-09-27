# Архитектура и фактический generation flow

## Граница пакета

Это отдельное локальное Next.js-приложение в vk-tech-hackathon со своими
маршрутами, пакетными зависимостями и тестами. Runtime-поток использует
локальную файловую систему для job-артефактов; он не пишет в production
Lazyum DB, не ставит задания в очереди и не подключает production API.

## POST /api/generate

Текущий generation flow выполняется одним синхронным HTTP-запросом Node.js
маршрута:

1. Request guard резервирует тяжёлую операцию и ограничивает multipart body.
   Требуются PPTX-шаблон и brief; число слайдов ограничивается диапазоном
   5–15, число материалов — 12. Шаблон ограничен 50 MiB, каждый материал —
   12 MiB, общий body — 196 MiB.
2. ArtifactStore создаёт job и сохраняет исходный шаблон и ссылки на входы.
3. parsePptxTemplate разбирает PPTX в DesignSystem и композиции макетов;
   normalizeContent извлекает и нормализует brief и материалы. Эти два
   действия запускаются параллельно. Текстовые и табличные locator-ы
   сохраняют точность, которую реально предоставляет формат; DOCX/PDF
   получают document-level locator.
4. createPresentationPlan строит один семантический план через выбранный
   planner. По умолчанию это локальный deterministic planner. Опциональный
   серверный Yandex AI Studio adapter вызывается только при явном выборе и
   полной конфигурации policy gate. Ошибки конфигурации, ответа или grounding
   завершают запрос; автоматической подмены результата offline-планом нет.
5. renderer строит по этому плану документы Compact, Balanced и Visual.
   auditPresentation проверяет каждый из трёх документов.
6. ArtifactStore сохраняет planning/plan.json, variants/<variant>.json и
   audit/<variant>.json. Если хотя бы один audit report имеет passed=false,
   generation завершается как failed и job не становится ready.
7. После сохранения документов и audit-отчётов runPublishedGenerationJury
   перечитывает именно сохранённые данные, рассчитывает детерминированный
   ranking и stage trace и привязывает их к ссылкам и SHA-256 исходных
   артефактов. Затем markGenerationReady проверяет полноту набора, связи и
   схемы опубликованных артефактов.

Успешный ответ содержит три документа и три аудита, удобные aliases для
Balanced, normalized content, jobId и manifest. Provider metadata плана может
показывать режим и usage evidence; это не превращает сохранённый ranking в
модельную оценку.

## Persisted artifact graph и повторное открытие

Корень по умолчанию — .data/vk-tech-hackathon/jobs относительно рабочей
директории. VK_HACKATHON_ARTIFACT_ROOT задаёт альтернативное расположение.
Manifest публикует относительные пути и размеры с SHA-256; записи JSON
выполняются через временный файл и атомарный rename. Чтение опубликованного
артефакта проверяет, что путь указан в manifest, остаётся внутри каталога job,
а размер и SHA-256 совпадают с зарегистрированной ссылкой.

В manifest отдельно связаны исходный шаблон и источники, parsed
DesignSystem, planning, варианты, аудит, exports, jury ranking и stage trace.
Стандартный путь audit-файлов — audit/compact.json, audit/balanced.json и
audit/visual.json; ranking и trace хранятся в orchestration/jury-ranking.json
и orchestration/stage-trace.json. Export-файлы сохраняются под
exports/<variant>/<format>.<extension>.

GET /api/jobs/[jobId] принимает только job со статусом ready и валидирует
полный snapshot, включая сохранённый planning artifact, все три варианта, их
аудиты, ranking и stage trace. Ответ содержит manifest, DesignSystem,
варианты, аудиты, ranking и stage trace; planning представлен ссылкой в
manifest и проверяется при reopen, но отдельным полем ответа не возвращается.
Повреждённая ссылка, несовпадающий digest, отсутствие артефакта,
несогласованные slide IDs или неверный ranking закрывают повторное открытие
контролируемой ошибкой. HackathonStudio открывает snapshot
по query-параметру ?job=<jobId>; локальный несохранённый черновик для этого
пути не подмешивается. В интерфейсе stage trace обозначен как сохранённый
итог job, не live-прогресс.

## Детали локальной orchestration

Интегрированный POST /api/generate не запускает полный mock-agent DAG.
После реального planner и deterministic render/audit он вызывает только
runPublishedGenerationJury над опубликованным планом, вариантами и аудитами.
Этот рейтинг локально вычисляется из audit metrics и структуры документов;
его score и название «jury» не означают внешний или человеческий review.
Сохранённый stage trace этого flow описывает narrative-selection,
variant-design, render-audit и final-jury.

Отдельный runAgentDryRun проверяет контрактный DAG из детерминированных
локальных mock roles и artifact graph. Его роли и ограничения описаны в
[MODELS.md](MODELS.md). Эта функция не является скрытым API-вызовом и не
подключает live multi-agent LLM runtime. Её граф не является manifest
обычного POST /api/generate.

## Audit и экспорт

Детерминированные проверки холста выполняются в [audit.ts](../src/lib/audit.ts).
Export routes используют один общий
[export preflight](../src/lib/export-preflight.ts): документ должен пройти
схему; активные audit errors блокируют PPTX, PDF и HTML с HTTP 422; warnings и
info остаются видимыми, но сами по себе экспорт не останавливают. Указанный
пользователем ignore хранится как решение для конкретного finding и снимает
только соответствующую блокировку. Полный перечень checks, действий
пользователя, persisted evidence и ограничений приведён в
[AUDIT.md](AUDIT.md).

POST /api/export создаёт PPTX, POST /api/export/pdf — PDF, POST
/api/export/html — standalone HTML. Запрос с jobId и вариантом берёт
опубликованный документ и сохраняет созданный экспорт в тот же job; запрос с
документом без jobId только возвращает скачиваемый файл.

## Другие ограничения и приёмка

Process-local guard по умолчанию ограничивает генерацию пятью запросами в
минуту, экспорт — тридцатью запросами в минуту и одной одновременной тяжёлой
операцией. Эти значения действуют в одном процессе. POST /api/analyze
сохраняет отдельный результат разбора шаблона и render evidence; он не
заменяет текущий POST /api/generate.

Unit/integration проверки подтверждают контракты и работу описанных
детерминированных путей, но не оценивают реальную визуальную fidelity,
PowerPoint rendering/editability или качество моделей. Advisory mock critics
не заменяют визуальный review. Полный MVP и Visual GO этой архитектурой не
подтверждаются; актуальные ограничения — в
[MVP_STATUS.md](MVP_STATUS.md) и [REAL_TEMPLATE_ACCEPTANCE.md](REAL_TEMPLATE_ACCEPTANCE.md).
