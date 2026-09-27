# Deterministic audit, advisory findings and export gate

## Что проверяет детерминированный audit

Основная реализация — [src/lib/audit.ts](../src/lib/audit.ts); допустимые
finding codes, severity и поля отчёта зафиксированы в
[src/lib/schemas.ts](../src/lib/schemas.ts). Проверки работают по модели
редактируемого холста, а не по реальному рендерингу браузера или PowerPoint.

| Finding | Severity | Условие |
| --- | --- | --- |
| OUTSIDE_SLIDE | error | Геометрия элемента выходит за границы слайда. |
| TEXT_OVERFLOW | error | Детерминированная оценка переноса строк и высоты показывает, что текст не помещается в свой элемент. |
| ELEMENT_OVERLAP | error / warning | Повторяющийся canvas element ID и пересечение двух текстовых элементов — error. Прочие неразрешённые пересечения — warning. Линии не входят в проверку foreground overlaps; перекрытие фигур между собой и текст, полностью содержащийся в фигуре, допускаются. |
| EMPTY_PLACEHOLDER | error | Пустой/пробельный текст или отдельный маркер lorem ipsum, XXX, TODO либо «вставьте текст» без учёта регистра. Совпадения внутри обычных слов не считаются маркерами. |
| SMALL_TEXT | warning | Размер текста меньше 14 canvas px. |
| UNSUPPORTED_FONT | warning | Шрифт текста отсутствует в heading/body fonts дизайн-системы и не входит в локальный fallback allowlist Arial, Calibri, Aptos. |
| COLOR_OUTSIDE_DESIGN_SYSTEM | warning / info | Цвет текста вне извлечённой палитры и фона — warning. Для фигуры finding severity info возникает, только если и fill, и stroke вне этой палитры. |
| LOW_TEXT_CONTRAST | warning | Для читаемого hex-цвета и однозначно определённого фона вычисленный контраст ниже 4.5:1 для обычного текста или 3:1 для крупного. Неоднозначные фоны, изображения за текстом и неподдерживаемые цветовые форматы пропускаются. |
| SMALL_MARGIN | warning | Текст подходит ближе чем на 3.5% меньшей стороны слайда к краю. Нижняя footer-зона исключается по геометрии, а не по ID элемента. |
| DENSE_LAYOUT | warning | На слайде больше 70 редактируемых элементов. |

Текстовая метрика намеренно упрощена: она детерминированно оценивает
переносы, символы на строку и высоту и не использует браузерный либо Office
font engine. AuditReport.passed равен false при наличии любого error; warning
и info сами по себе не делают audit неуспешным. Это не проверка содержания,
реального pixel-overlap, контрастности на растровом изображении или
визуального качества слайда.

## Advisory mock critic output

Локальный mock DAG в
[src/lib/agent-mock-runner.ts](../src/lib/agent-mock-runner.ts) содержит
semantic-critic и visual-critic. Выход обоих помечен advisoryOnly. Mock
semantic critic может сообщить о неподвязанной к claim slide или повторном
использовании evidence; mock visual critic выдаёт advisory note о том, что
геометрия остаётся авторитетной. Он не применяет vision model к картинке и
не является PowerPoint review. Эти findings не являются детерминированным
AuditReport и не управляют export gate.

Отдельный
[semantic-audit normalizer](../src/lib/skills/semantic-audit.ts) также
принимает только ограниченные finding/evidence references и нормализует их
как advisory-only результат без полей passed или exportDecision. Это контракт
нормализации, а не evidence работающей внешней модели. Ни mock critics, ни
этот normalizer не заменяют визуальный review.

Обычный POST /api/generate использует auditPresentation для каждого из трёх
вариантов. Если хотя бы один report имеет passed=false, маршрут помечает job
failed; jury ranking и ready snapshot не публикуются. Критики из отдельного
runAgentDryRun не становятся gate этого endpoint.

## Fix, ignore и effective audit

[src/lib/audit-actions.ts](../src/lib/audit-actions.ts) поддерживает два
действия, привязанных к issueKey — стабильному tuple из slide ID, finding
type, element ID и сообщения.

- Safe auto-fix доступен только для OUTSIDE_SLIDE (clamp геометрии в пределы
  слайда с ограничением ширины/высоты) и UNSUPPORTED_FONT (выбор шрифта из
  дизайн-системы). Решение fix записывается лишь когда повторный
  deterministic audit подтвердил исчезновение того же finding.
- Для остальных findings доступно только ignore. Ignore не удаляет finding:
  effective audit сохраняет его видимым, отмечает ignored=true и исключает
  игнорированный error из расчёта passed.
- Apply all safe fixes запускает только два описанных вида исправления.
- Решения сохраняются в auditDecisions внутри PresentationDocument. Это
  состояние документа/браузерного черновика, а не изменение уже
  опубликованного серверного snapshot. В HackathonStudio применение действия
  обновляет finding, помечает вариант отредактированным и повторно вычисляет
  effective audit.

Если пользователь экспортирует job-based неизменённый вариант, UI отправляет
jobId и variant, и маршрут читает опубликованный документ. После редактирования
варианта UI отправляет текущий документ. В обоих случаях новый export проходит
preflight. Сохранённый published snapshot не переписывается пользовательскими
изменениями редактора.

## Export preflight

[src/lib/export-preflight.ts](../src/lib/export-preflight.ts) сначала
проверяет presentationDocumentSchema, затем строит effective audit без
изменения исходного документа.

| Результат preflight | Поведение маршрутов |
| --- | --- |
| Невалидный документ | Не экспортируется; результат INVALID_DOCUMENT. |
| Есть error, не отмеченный ignored | Fail-closed отказ AUDIT_ERRORS. Каждый POST /api/export, /api/export/pdf и /api/export/html возвращает HTTP 422 со структурированными issues и audit. |
| Только warning/info и/или ignored errors | Экспорт разрешён; findings остаются видны в ответе preflight. |
| Ошибки отсутствуют | Экспорт разрешён. |

PPTX создаётся нативными редактируемыми объектами экспортёра; PDF и standalone
HTML создаются своими форматными экспортёрами. Для запроса с jobId готовые
байты сохраняются под exports/<variant>/<format>.<extension>, а путь и
SHA-256 добавляются в job manifest. Запрос без jobId возвращает файл без
публикации экспорта в job. См. также
[src/lib/export-response.ts](../src/lib/export-response.ts) и
[src/lib/artifact-store.ts](../src/lib/artifact-store.ts).

## Сохранённые audit и jury evidence

После generation маршрут сохраняет все три документа и три audit report в
локальном ArtifactStore. Manifest ссылается на:

- audit/compact.json, audit/balanced.json, audit/visual.json;
- orchestration/jury-ranking.json;
- orchestration/stage-trace.json.

Каждая published reference содержит относительный путь, размер и SHA-256.
Jury ranking хранит ссылки на конкретные plan, variant и audit artifacts,
включая их размеры и hashes. runPublishedGenerationJury читает их после
сохранения и рассчитывает ranking детерминированно из audit metrics и
структуры вариантов. Это не LLM-критика и не оценка человеком. Stage trace
является сохранённой записью этапов, а не текущим live status stream.

GET /api/jobs/[jobId] повторно открывает только ready job с полным набором
валидных опубликованных references и совпадающими данными. Manifest,
повреждённый файл, несвязанные jury refs, неполный аудит или несовпадающие
slide IDs закрывают reopen fail-closed. Интерфейс HackathonStudio получает
этот immutable snapshot по параметру ?job=<jobId>.

## Точные связанные тесты

Перечислены тесты, которые содержат проверки описанных контрактов; они не
запускались в рамках docs-only задачи.

- [tests/audit.test.ts](../tests/audit.test.ts) — placeholder, empty text,
  structured findings, text measurement, footer margin, contrast thresholds,
  ambiguous background и правило passed.
- [tests/audit-title-body-collision.test.ts](../tests/audit-title-body-collision.test.ts)
  — фатальное пересечение заголовка/тела и допустимый текст внутри фоновой
  фигуры.
- [tests/audit-actions.test.ts](../tests/audit-actions.test.ts) —
  deterministic issue key, visible ignored findings, проверенные fix для
  OUTSIDE_SLIDE и UNSUPPORTED_FONT.
- [tests/browser/audit-actions.spec.ts](../tests/browser/audit-actions.spec.ts)
  — UI safe-fix/ignore и восстановление действий после reload.
- [tests/export-preflight.test.ts](../tests/export-preflight.test.ts) —
  видимые non-fatal findings, error gate, title/body collision, fix не
  обходит текущий error, explicit ignore и schema failure.
- [tests/export-route.test.ts](../tests/export-route.test.ts) —
  PPTX route, request limit, filename и HTTP 422 на fatal audit.
- [tests/export-pdf-html.test.ts](../tests/export-pdf-html.test.ts) — PDF/HTML
  routes, bounded request, standalone HTML и HTTP 422 на fatal audit.
- [tests/generate-route-artifacts.test.ts](../tests/generate-route-artifacts.test.ts)
  — persisted plan/variants/audits, ranking привязан к фактически сохранённым
  документам и manifests для failed generation.
- [tests/job-reopen-route.test.ts](../tests/job-reopen-route.test.ts) —
  reopen только полного snapshot, контролируемые ошибки и fail-closed jury
  ranking.
- [tests/export-artifact-graph.test.ts](../tests/export-artifact-graph.test.ts)
  — публикация и повторное чтение exports всех трёх вариантов и трёх форматов.
- [tests/agent-orchestrator.test.ts](../tests/agent-orchestrator.test.ts) —
  deterministic mock DAG, ranking refs, missing evidence и остановка до
  critics/repair/jury при fatal audit.
- [tests/semantic-audit.test.ts](../tests/semantic-audit.test.ts) —
  advisory-only normalizer, проверка refs и запрет audit/export authority.

PASS этих unit/integration/browser checks не заменяет review результата в
PowerPoint. Известные visual blockers не сняты: текущий статус остаётся
Visual NO-GO. См. [MVP_STATUS.md](MVP_STATUS.md) и
[REAL_TEMPLATE_ACCEPTANCE.md](REAL_TEMPLATE_ACCEPTANCE.md).
