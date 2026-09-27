# VK Tech hackathon project

Автономное локальное приложение для кейса VK Tech / ЛЦТ 2026. PPTX-шаблон,
brief и дополнительные материалы проходят через разбор, планирование,
материализацию трёх вариантов презентации, аудит и экспорт. В репозитории есть
исходники приложения и локальная совместимая сборка PptxGenJS. Приложение не
подключается к production web/API, базе данных, очередям или Docker-сервисам
Lazyum.

Этот README описывает существующий локальный поток. Наличие генерации,
сохранённых артефактов, audit PASS или файлов экспорта не означает готовность
полного MVP и не является визуальной или PowerPoint-приёмкой. Текущий статус
визуального направления остаётся NO-GO; см. [состояние поставки](docs/MVP_STATUS.md)
и [порядок приёмки реальных шаблонов](docs/REAL_TEMPLATE_ACCEPTANCE.md).

## Что работает


1. Интерфейс отправляет multipart-запрос в POST /api/generate: обязательные
   PPTX-шаблон и brief, число слайдов (5–15) и до 12 файлов материалов.
2. Маршрут создаёт локальный job, параллельно разбирает дизайн-систему PPTX и
   нормализует brief и материалы. Текущий видимый file picker предлагает PDF,
   DOCX, PPTX, TXT, MD и CSV. Content parser/API дополнительно умеет XLSX,
   PNG, JPG/JPEG, WEBP и GIF, но UI picker их не предлагает. Точность
   locator-ов зависит от формата и зафиксирована в данных source chunks.
3. Планировщик создаёт один семантический план. По умолчанию используется
   офлайн deterministic planner; дополнительный серверный режим Yandex AI
   Studio с явно заданным model URI (включая рассматриваемого в проектном
   контексте Qwen-кандидата) включается явной конфигурацией, описанной ниже и в
   [документе о моделях](docs/MODELS.md).
4. Один план материализуется в три варианта: Compact, Balanced и Visual.
   Для каждого варианта запускается детерминированный аудит.
5. Сохраняются план, три документа вариантов, три audit-отчёта, ranking
   вариантов и итоговый stage trace. Job получает статус ready только после
   сохранения и проверки полного набора артефактов. Фатальная ошибка аудита
   оставляет job в failed.
6. GET /api/jobs/[jobId] повторно открывает только полный валидированный
   опубликованный job. В интерфейсе его можно открыть параметром
   ?job=<jobId>. Это сохранённый итог, а не live-прогресс.
7. PPTX, PDF и HTML экспортируются через POST /api/export,
   POST /api/export/pdf и POST /api/export/html. Каждый формат проходит общий
   export preflight. Для job-запроса экспорт сохраняется в его manifest;
   экспорт текущего документа без jobId возвращается без сохранения в job.

Интерфейс позволяет редактировать холст и показывает audit findings. Для
OUTSIDE_SLIDE и UNSUPPORTED_FONT доступны безопасные исправления; пользователь
также может отдельно пометить finding как ignored. Редактируемый браузерный
черновик сохраняется локально. Подробности поведения аудита и экспорта — в
[docs/AUDIT.md](docs/AUDIT.md).

POST /api/analyze остаётся отдельным маршрутом разбора шаблона и сохранения
render evidence; он не является единственным сохраняемым потоком генерации.

## Системные требования и проверенная среда

- Для локального пакета закреплены Node.js 24.13.0 и npm 11.6.2: `.nvmrc`
  фиксирует Node, а `package.json` и lockfile содержат Node/npm pins. Они выбраны по версиям,
  установленным на Windows-хосте проекта; это не подтверждает запуск на Linux
  или macOS.
- Planner по умолчанию deterministic и не требует API-ключа или GPU. Опциональный
  Yandex AI Studio planner требует исходящий HTTPS-доступ и серверные секреты;
  полный список настроек приведён в [документе о моделях](docs/MODELS.md).
- POST /api/analyze сохраняет PDF/PNG render evidence с помощью LibreOffice
  Impress и Poppler (`pdfinfo`, `pdftoppm`). Эти программы должны быть доступны
  процессу. Версии Linux-пакетов и совместимость Linux runtime пока не
  проверены; см. [документ о моделях и среде запуска](docs/MODELS.md).
- Минимальные CPU, RAM и свободное место не измерялись. Для них пока нет
  подтверждённых численных требований.

## Запуск

Из корня клонированного репозитория:

    npm ci
    npm run dev

Откройте http://localhost:3030. Выберите шаблон PPTX, введите brief и при
необходимости добавьте материалы.

Совместимая сборка PptxGenJS лежит в `packages/pptxgenjs`, поэтому npm-зависимость
разрешается внутри этой репозитории. Лицензия и атрибуция находятся рядом с
пакетом. Для локальной проверки доступны команды:

    npm run typecheck
    npm run test
    npm run fixtures
    npm run build

Синтетические тестовые PPTX создаются командой `npm run fixtures` в
`fixtures/templates`. Оригинальные organizer-шаблоны не распространяются
в публичной репозитории; если они доступны вашей команде, поместите их в
`fixtures/templates/organizer` и сверьте контрольные суммы и порядок
приёмки с [инструкцией к набору](fixtures/templates/organizer/README.md).
Тесты на синтетических шаблонах и успешный детерминированный audit сами по
себе не подтверждают визуальное качество в PowerPoint.

## Хранилище и ограничения запросов

По умолчанию job-файлы хранятся в .data/vk-tech-hackathon/jobs относительно
рабочей директории процесса. Переменная VK_HACKATHON_ARTIFACT_ROOT позволяет
задать другой корень. Manifest содержит опубликованные относительные пути,
размеры и SHA-256 артефактов.

Текущие лимиты маршрутов: шаблон до 50 MiB, не более 12 файлов материалов по
12 MiB каждый, тело generate до 196 MiB, тело каждого export до 50 MiB.
Process-local guard ограничивает генерацию пятью запросами в минуту, экспорт —
тридцатью запросами в минуту, и допускает одну одновременную тяжёлую операцию
на процесс. Это ограничение одного процесса, а не общий лимит между
несколькими репликами.

## Planner environment

Без конфигурации VK_HACKATHON_LLM_PROVIDER выбирается deterministic planner;
для этого режима cloud credentials не нужны. Для Yandex AI Studio задайте
серверные переменные окружения:

    VK_HACKATHON_LLM_PROVIDER=yandex-ai-studio
    YANDEX_CLOUD_API_KEY=<server-side secret>
    YANDEX_CLOUD_FOLDER_ID=<folder-id>
    YANDEX_CLOUD_MODEL_NAME=<explicit model name>
    YANDEX_CLOUD_MODEL_URI=<explicit model URI>
    YANDEX_CLOUD_MODEL_TOTAL_PARAMETERS_B=<explicit total parameter count>
    YANDEX_CLOUD_MODEL_OPEN_WEIGHTS=true
    YANDEX_CLOUD_MODEL_LICENSE=Apache-2.0

Для policy gate URI, имени, общего числа параметров, статуса open weights и
лицензии должны быть заданы явно: код принимает числовое значение больше 0 и
не больше 35, true и только Apache-2.0 либо MIT соответственно. У модели нет
значения по умолчанию, и при ошибке провайдера автоматического
deterministic-fallback нет. Эти настройки являются локальными проверяемыми
аттестациями, а не решением организаторов о допуске модели или managed route.
Не записывайте секрет в NEXT_PUBLIC_* и не считайте этот пример свидетельством
текущих значений runtime. Остальные границы и официальные источники описаны в
[docs/MODELS.md](docs/MODELS.md).

## Карта проекта

- src/lib/template-parser.ts — разбор PPTX и извлечение наблюдаемой структуры.
- src/lib/content-parser.ts — нормализация brief, материалов, source chunks и
  facts.
- src/lib/planner.ts и src/lib/planner-provider.ts — семантический план и
  граница deterministic / optional Yandex planner.
- src/lib/renderer.ts — материализация планов в редактируемые варианты.
- src/lib/audit.ts и src/lib/export-preflight.ts — детерминированный аудит и
  общий export gate.
- src/lib/agent-orchestrator.ts и src/lib/agent-mock-runner.ts — локальная
  orchestration logic и deterministic mock roles; см. ограничения в
  [architecture](docs/ARCHITECTURE.md).
- src/lib/artifact-store.ts — локальное job-хранилище, manifest и ссылки на
  артефакты.
- src/app/api — API маршруты анализа, генерации, повторного открытия job и
  экспорта.
- src/components/hackathon-studio.tsx — локальная студия создания, редактирования,
  восстановления job и скачивания экспорта.

Дополнительные документы: [архитектура](docs/ARCHITECTURE.md),
[модели и роли](docs/MODELS.md), [аудит и export gate](docs/AUDIT.md),
[состояние поставки](docs/MVP_STATUS.md) и
[приёмка реальных шаблонов](docs/REAL_TEMPLATE_ACCEPTANCE.md).
