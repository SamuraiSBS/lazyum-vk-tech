# Модели, planner и локальные роли

## Planner в POST /api/generate

В коде есть два режима planner.

| Режим | Поведение |
| --- | --- |
| deterministic | Офлайн-планировщик из src/lib/planner.ts. Используется, если VK_HACKATHON_LLM_PROVIDER не задан; ключ провайдера не нужен. |
| yandex-ai-studio | Опциональный серверный OpenAI-compatible Chat Completions adapter в src/lib/yandex-ai-studio.ts. Маршрут запроса по умолчанию — https://ai.api.cloud.yandex.net/v1/chat/completions. Он применяется только при явном выборе режима и полной конфигурации. Qwen3.6-35B-A3B рассматривается в проектном контексте как кандидат; код не зашивает эту модель и требует явные name/URI аттестации. |

Planner является единственной model-provider границей встроенного
POST /api/generate. Model name и URI не зашиты как default; этот документ не
утверждает, какие значения заданы в текущем runtime.

## Fail-closed конфигурация Yandex

Если VK_HACKATHON_LLM_PROVIDER=yandex-ai-studio, исходники требуют:

| Переменная | Gate |
| --- | --- |
| YANDEX_CLOUD_API_KEY | обязательный секрет на стороне сервера |
| YANDEX_CLOUD_FOLDER_ID | обязательный folder ID |
| YANDEX_CLOUD_MODEL_NAME | явная непустая аттестация имени модели |
| YANDEX_CLOUD_MODEL_URI | явная непустая аттестация model URI |
| YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B | явная положительная числовая аттестация, не больше 35 |
| YANDEX_CLOUD_MODEL_OPEN_WEIGHTS | обязательно true |
| YANDEX_CLOUD_MODEL_LICENSE | только Apache-2.0 или MIT |
| YANDEX_CLOUD_OPENAI_BASE_URL | необязательно; по умолчанию Yandex AI Studio base URL |

Значение 35 проходит локальную числовую проверку. Это не решает, как
организаторы считают MoE total parameters, vision encoder или округление и
одобряют ли managed inference. У адаптера нет неявной модели по умолчанию и
нет deterministic fallback при ошибке выбранного провайдера. API key
предназначен только для серверного окружения и не должен помещаться в
NEXT_PUBLIC_* или выводиться в логи.

Границы запросов задаются кодом и ограничены сверху: timeout по умолчанию
60 секунд, максимум 120 секунд; две попытки по умолчанию, максимум три;
input budget 8 000 estimated tokens на попытку, максимум 24 000; output budget
1 500 на попытку, максимум 8 000; total budget 18 000 для запроса, максимум
48 000. Total budget должен покрывать output budget. Входная оценка использует
ceil(UTF-8 bytes / 3); адаптер устанавливает max_tokens в output budget и
отказывает до fetch, если следующая попытка превысит total envelope.
Повторяются только timeout, HTTP 429 и HTTP 5xx. Успешная planner metadata
сохраняет policy, лимиты/число попыток, оценку бюджета и сообщённый upstream
usage либо usageUnknown. Оценка токенов не является стоимостью или счётом.

Фактические .env, секреты и значения process environment в рамках обновления
этого документа не читались. Поэтому здесь не утверждается, что Yandex mode
сейчас настроен или что в runtime выбрана конкретная модель.

## Системные требования и границы runtime

- Для локального пакета закреплены Node.js 24.13.0 и npm 11.6.2: `.nvmrc`
  фиксирует Node, а `package.json` и lockfile содержат Node/npm pins. Это версии, установленные на проверенном
  Windows-хосте. Запуск пакета на Linux/macOS и production runtime на Linux
  этими данными не подтверждены.
- Штатный deterministic planner работает локальным кодом и не требует модели,
  API-ключа или GPU. Опциональный Yandex AI Studio planner выполняет inference
  удалённо: нужны исходящий HTTPS-доступ и перечисленные выше серверные
  настройки; локальные VRAM/GPU требования для него не заявляются.
- Для `/api/analyze` и сохранения render evidence код использует LibreOffice
  Impress и Poppler (`pdfinfo`, `pdftoppm`). Linux-версии этих программ и
  шрифтов не закреплены и не проверены; текущие Windows-версии не считаются
  Linux acceptance.
- Минимальные CPU/RAM/disk-параметры приложения и его throughput не
  бенчмаркировались. Пока нет данных для численных аппаратных требований.
  Историю проверки runtime см. в [DEPLOY_READINESS.md](DEPLOY_READINESS.md).

## Deterministic local mock roles

Реестр содержит одиннадцать contract roles с версией v1. Функция
runAgentDryRun запускает их локальным кодом из src/lib/agent-mock-runner.ts;
это не вызов LLM и не отдельные inference workers.

| Role ID | Реализованное назначение в mock runner |
| --- | --- |
| template-analyst | Нормализует layout families, typography guidance и template risks из уже извлечённых данных. |
| evidence-analyst | Преобразует source chunks в bounded claims с source refs. |
| narrative-architect | Строит narrative slide sequence из brief, template/evidence context и числа слайдов. |
| visual-director | Выдаёт структурированные visual specs и fallback intent. |
| variant-designer-compact | Создаёт контрактный план Compact с более плотным содержанием. |
| variant-designer-balanced | Создаёт контрактный план Balanced. |
| variant-designer-visual | Создаёт контрактный план Visual с более свободной плотностью. |
| semantic-critic | Возвращает advisory-only сообщения об отсутствующей или повторной привязке evidence claims. |
| visual-critic | Возвращает advisory-only mock note; не смотрит на изображение моделью и не выполняет VLM review. |
| repair-planner | Сейчас создаёт bounded план со статусом no_repair и пустым списком операций. |
| final-jury | Проверяет входной контракт и детерминированно рассчитывает ranking/notes для dry-run DAG. |

Выход каждого mock role проверяется схемой. Встроенный POST /api/generate не
запускает весь этот DAG: он вызывает runPublishedGenerationJury отдельно и
только после сохранения планов, трёх документов и audit-отчётов. Этот
опубликованный jury ranking — детерминированный расчёт по фактически
сохранённым документам и audit metrics, а не LLM или внешний jury review.

Контракты ролей лежат в agents/registry.json и agents/<role>/v1/contract.json;
заявленные system prompt paths находятся в prompts/agents/<role>/v1/system.md.
Реализация dry-run — в src/lib/agent-orchestrator.ts и
src/lib/agent-mock-runner.ts. Отдельный semantic-audit normalizer
(src/lib/skills/semantic-audit.ts) также фиксирует advisory-only границу,
но сам по себе не подключает модель.

Полноценный multi-agent LLM runtime и live VLM здесь не описываются и не
подтверждаются этими документами. Deterministic dry-run evidence не является
проверкой качества или визуальной приёмкой.

## Официальные источники моделей и провайдера

Источниковедческий аудит от 24 сентября 2026 года проверял следующие
официальные первичные страницы:

- Qwen, [Qwen3.6-35B-A3B model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/README.md) и [Apache 2.0 license](https://huggingface.co/Qwen/Qwen3.6-35B-A3B/raw/main/LICENSE). Карточка заявляет 35B total и 3B activated для MoE language model и описывает vision encoder; это не решает трактовку правила организаторов.
- Yandex Cloud, [AI Studio digest: Qwen3.6-35B-A3B и model URI](https://yandex.cloud/en/blog/digest-april-2026) и [OpenAI-compatible AI Studio integration docs](https://yandex.cloud/en/docs/tutorials/ml-ai/ai-model-ide-integration). Это подтверждает опубликованную техническую возможность managed route, но не его разрешённость правилами конкурса.
- Qwen, [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B) и [Apache 2.0 license](https://huggingface.co/Qwen/Qwen3.8-27B/raw/main/LICENSE). Карточка помогает сопоставить название из переданного проектного контекста; она не доказывает существование конкретного VK endpoint или доступность модели для top-10.

## Неразрешённые VERIFY организаторам

1. **Managed route и допуск конкурса.** Подтвердить, разрешён ли Yandex AI Studio для этапа отбора при соблюдении заявленных требований к открытым весам, размеру и лицензии либо требуется самостоятельный hosting.
2. **Порог 35B для MoE и vision encoder.** Подтвердить, что считается total parameters, а не activated parameters; как учитывать vision encoder и округлённое значение ровно 35B; относится ли правило к числу из карточки модели или ко всем компонентам.
3. **VK model endpoint для top-10.** Подтвердить точную модель за названием «Qwen 3.8 27b», revision, VK model ID/URI и API endpoint, дать официальные access docs, а также подтвердить этап, когда VK inference становится обязательным.

Открытые страницы производителя и провайдера не заменяют ответы организаторов.
До получения этих ответов допуск маршрута и модели остаётся не подтверждённым.
