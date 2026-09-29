# DEP-01 — инвентаризация готовности к деплою

Дата проверки: 2026-09-23 (Europe/Moscow)
Claim: d56d3b28-1266-451e-b106-186447d33423
HEAD при бронировании и до создания отчёта: 1fce9715c6b4c9ed197ae6be50d0fc067dcaaa52
Разрешённый файл: vk-tech-hackathon/docs/DEPLOY_READINESS.md
Статус claim при сдаче: awaiting_acceptance; бронь сохранена до независимой приёмки.

Статусы относятся к проверенному коду и доступному окружению. «Есть» не означает production-ready. Содержимое .env.local, ключи, токены и приватные данные не читались. Provider-вызовов, cloud API-запросов, сборок, тестов и деплоя не выполнялось.

## Итог

Готовность к удалённому деплою: нет. Приложение имеет отдельный lockfile, локально связанную библиотеку PPTX, синхронные API-маршруты, дисковое хранилище job и код двух режимов LLM. Но в пакете пока нет Linux image/compose-конфигурации; Linux-версии renderer и набор шрифтов не зафиксированы; приложение не имеет auth, HTTP rate limits, политики retention и health/readiness. Доступ к Yandex Cloud и наличие ресурсов не удалось проверить: yc отсутствует в PATH. Последняя проверка VK Tech / Visual в roadmap — NO-GO.

## Инвентаризация

| Область | Статус | Evidence | Точный блокер |
|---|---|---|---|
| Отдельный пакет и lockfile | есть | vk-tech-hackathon/package.json, package-lock.json; имя пакета @lazyum/vk-tech-hackathon, lockfile v3. Root workspaces включают только packages/* и apps/*, не этот пакет. | Для отдельной Linux-сборки ещё нет описания образа и команды запуска. |
| Локальная зависимость PPTX | есть | Пакет объявляет @studydeck/pptxgenjs: file:../packages/pptxgenjs; lockfile фиксирует ссылку ../packages/pptxgenjs как link; packages/pptxgenjs/package.json сообщает версию 4.0.1-studydeck.0. | Build context должен включать одновременно корневой packages/pptxgenjs и vk-tech-hackathon; такой Dockerfile пока отсутствует. |
| Node, используемый при проверке | есть | node --version → v24.13.0; npm → 11.6.2. Установленный Next — 16.3.5, его package metadata задаёт node >=20.9.0. Root .github/workflows/release-gates.yml использует Node 22 для root jobs, но hackathon package не входит в root workspaces. | Hackathon package.json не задаёт engines; нет .nvmrc/.node-version или Docker base pin. Целевая версия Node для Linux-образа не закреплена. |
| Стартовые npm-команды | есть | В package scripts: dev и start используют порт 3030; production script — next start -p 3030; сборка — next build --webpack. | Для Linux production runtime нет Dockerfile, Compose-файла и зафиксированного запуска с постоянным томом. |
| Linux renderer: LibreOffice/Poppler | не проверено | Код render evidence требует LibreOffice Impress headless, pdfinfo и pdftoppm (src/lib/render-evidence.ts). В hackathon-пакете нет Dockerfile, .dockerignore и compose.demo.yml; WSL Linux runtime не подтвердился. На Windows host найдены soffice.exe (file version 26.8.0.3) и Poppler pdfinfo/pdftoppm версии 26.07.0. | Host Windows не доказывает наличие или версию Linux-пакетов. Вызов soffice --version не вернул результат за отведённое время; версию Windows exe взял из метаданных файла. Linux image не создавался по ограничению задачи. |
| Шрифты | не проверено | Renderer сохраняет observed fonts и имеет fallback Arial (src/lib/renderer.ts); renderer font tests содержат Aptos/Aptos Display. На Windows host обнаружены файлы Arial и Liberation; Aptos-файлов в проверенной папке Windows Fonts нет. | Не определены Linux font packages, их версии и fallback/substitution для Aptos и шрифтов входных шаблонов. В образе шрифты не проверялись. |
| Размер PPTX-шаблона | есть | src/lib/template-parser.ts: максимум 50 MiB; отдельный лимит XML — 3 MiB. /api/analyze принимает один PPTX. | Лимит проверяется parser-ом после чтения multipart файла в память; до разбора запроса общий HTTP-body limit в приложении не задан. |
| Размер и число материалов | есть | src/lib/content-parser.ts: максимум 12 MiB на материал, максимум 12 файлов, извлечённый текст ограничен 50 000 символов на документ. /api/generate берёт первые 12 полей materials; UI также удерживает до 12. | Размер каждого файла проверяется при обработке уже прочитанного буфера. Общий multipart/body cap не найден; лишние материалы API обрезает до 12, а не отклоняет явной ошибкой. Теоретический совокупный payload по текущим per-file лимитам — до 194 MiB плюс multipart overhead. |
| Генерационный диапазон | есть | POST /api/generate: slideCount по умолчанию 10, clamp 5–15; генерация и ответ выполняются синхронно. | Нет фоновой очереди, ограничения одновременных запросов и подтверждённого SLA полного flow для Linux production. |
| API routes | есть | POST /api/analyze, POST /api/generate, GET /api/jobs/[jobId], GET /api/artifacts/[jobId]/[...path], POST /api/export (PPTX), POST /api/export/pdf, POST /api/export/html. Все реализованы в src/app/api/**/route.ts. | Отдельных health/readiness routes нет. |
| LLM modes | есть | src/lib/planner-provider.ts: VK_HACKATHON_LLM_PROVIDER выбирает deterministic или yandex-ai-studio; если переменная не задана, кодовый default — deterministic. Yandex path требует API key, folder ID и проверяемые метаданные модели/политики. | Фактический режим запущенного приложения не проверен: .env.local существует, но не читался; значения процесса не выводились. В ходе DEP-01 provider-вызовов не было. |
| LLM limits | есть | Код задаёт defaults: timeout 60 000 ms (верхняя граница 120 000), до 2 попыток (макс. 3), input/output/total budgets 8 000/1 500/18 000 tokens (макс. 24 000/8 000/48 000). | Эффективные значения окружения не проверены; нет развернутого server-side secret configuration. |
| Запись артефактов | есть | src/lib/artifact-store.ts: VK_HACKATHON_ARTIFACT_ROOT; default — .data/vk-tech-hackathon/jobs относительно process.cwd(). Job-каталог содержит входные файлы и manifest, parsed data, planning, варианты, audits, orchestration/render data и exports. Запись выполняется через временный файл и rename; пути проверяются относительно job root. | Хранилище локальное filesystem; production volume, права non-root пользователя, backup/restore и общая storage-схема не настроены. |
| Auth и приватность job/artifacts | нет | В API route tree нет auth middleware или проверки identity/Authorization/cookie; GET job и artifact читают публикацию по job ID без пользовательской авторизации. | Перед внешним доступом DEP-03 должен закрыть UI, API, job и все artifact/export URLs одной выбранной моделью доступа и проверить обходы. |
| HTTP rate limits / concurrency | нет | В route tree не найдено HTTP rate limiter или общий semaphore для generate/analyze/export. Renderer имеет process/job timeout, но обработчики синхронны. | Не ограничены частота запросов, суммарный multipart body и количество одновременных тяжёлых задач/LibreOffice процессов. |
| Retention / cleanup | нет | В ArtifactStore есть точечная очистка render evidence и удаление части временных результатов при ошибке; задания на prune/TTL для старых jobs не обнаружены. | Не определены срок хранения, безопасная очистка активных/опубликованных jobs, мониторинг диска, backup и restore. |
| Health/readiness | нет | В src/app/api отсутствуют health/readiness endpoints. | Нет проверки живого процесса, доступности writable artifact volume и renderer binaries. |
| Yandex Cloud CLI/API | не проверено | Get-Command yc → команда не найдена на host PATH. План сообщает только целевую архитектуру; конкретных resource IDs в проверенной конфигурации не найдено. | Read-only Cloud API запросы выполнить нечем; профили/credentials не исследовались. |
| VM и постоянный диск | не проверено | Нет подтверждённого Cloud API inventory. | Без yc/доступного Cloud API нельзя установить наличие VM, диска, их состояние/зону и привязку volume. |
| Сеть / Security Group / IP | не проверено | Нет подтверждённого Cloud API inventory. | Нельзя проверить сеть, firewall/security groups, адрес или публичную доступность без read-only Cloud API. |
| Container Registry | не проверено | Нет подтверждённого Cloud API inventory; образ приложения пока не описан. | Нельзя подтвердить registry/repository или наличие образов без Cloud API. |
| DNS и домен | не проверено | В плане нет выбранного staging FQDN/resource ID; домен не задавался. | Нет подтверждённого имени/зоны для безопасного DNS lookup; DNS-запрос по придуманному имени не выполнялся. |
| Claims | есть | task-coordination.ps1 -Action List до завершения: DEP-01 claim d56d3b28-1266-451e-b106-186447d33423, in_progress, этот отчёт; отдельный P0-8 claim 94fc97a9-7982-4fe7-afb6-308610a3bdd9, in_progress, scope: agent report, src/lib/audit.ts, src/lib/schemas.ts, tests/audit.test.ts. Конфликта путей с DEP-01 нет. | Блокера по активным claims для разрешённого отчёта нет; обе брони остаются открыты до приёмки. |
| Исходный dirty worktree | есть | Снимок git status --short до отчёта: m .codex-worktrees/current-head-baseline-20260902; ? .codex-worktrees/deploy-8d2211bf; m .codex-worktrees/deploy-current-20260902; m .codex-worktrees/landing-style-fix-20260831; ? .codex-worktrees/narration-slide-count-fix; m .codex-worktrees/p0-12-5-render-feedback; m .codex-worktrees/production-deploy-20260904; ? .codex-worktrees/staging-release-23; M AGENTS.md; M AGENTS_VK.md; M docs/VK_TECH_CURRENT_STATE_AND_ROADMAP.md; M vk-tech-hackathon/docs/REAL_TEMPLATE_ACCEPTANCE.md; M vk-tech-hackathon/scripts/task-coordination.ps1; M vk-tech-hackathon/src/app/page.tsx; M vk-tech-hackathon/src/lib/renderer.ts; M vk-tech-hackathon/tests/browser/audit-actions.spec.ts; M vk-tech-hackathon/tests/browser/generation-reopen-export.spec.ts; M vk-tech-hackathon/tests/renderer-audit-regressions.test.ts; ?? vk-tech-hackathon/docs/DEPLOY_YANDEX_CLOUD_PLAN.md; ?? vk-tech-hackathon/public/; ?? vk-tech-hackathon/src/app/icon.png; ?? vk-tech-hackathon/src/components/startup-intro.module.css; ?? vk-tech-hackathon/src/components/startup-intro.tsx. | Изменения существовали до DEP-01; не включать их в deployment candidate без отдельной проверки и решения. Они не редактировались в этой задаче. В контрольном снимке перед сдачей дополнительно появились M vk-tech-hackathon/src/lib/audit.ts, M vk-tech-hackathon/src/lib/schemas.ts и M vk-tech-hackathon/tests/audit.test.ts из отдельного активного P0-8 claim; это вне DEP-01 allowlist и не менялось мной. В текущем Git status также присутствует этот новый разрешённый отчёт. |
| Visual acceptance | есть | Roadmap §20K (2026-09-23): последний VK Tech / Visual full-deck rerun получил NO-GO; /api/generate не опубликовал ready job (fatal_deterministic_audit/planner_schema_invalid), direct-export audit имел 5 ошибок; это диагностический export. | Visual остаётся блокером публичного GO до нового успешного ready job и полной visual acceptance. Это не блокирует саму инвентаризацию DEP-01. |

## Минимальные параметры для следующих DEP-пунктов

### DEP-02 — Linux build

- Собирать только пакет vk-tech-hackathon; корневой build context должен содержать также packages/pptxgenjs, так как lockfile использует локальный file:../packages/pptxgenjs.
- Node 24.13.0 — фактически проверенный локальный кандидат; root CI использует Node 22, но не запускает hackathon package как workspace. Пакет не закрепляет версию. DEP-02 должен выбрать и зафиксировать Linux base image/runtime version и проверить сборку этим runtime.
- Production команда пакета — npm run build, затем npm run start; порт по умолчанию 3030.
- Зафиксировать Linux-версии LibreOffice Impress, Poppler (pdfinfo, pdftoppm) и установленных font packages. Текущие Windows версии не подменяют эту проверку.
- Вынести VK_HACKATHON_ARTIFACT_ROOT на отдельный writable persistent volume; в образ не копировать .env.local, .data, .agent-state и тестовые артефакты.

### DEP-03/04/05/06 — доступ, лимиты, health, данные

- До реализации DEP-03 выбрать модель доступа, которая охватывает frontend и все API/job/artifact/export URLs; сейчас авторизации нет.
- DEP-04 должен задать reverse-proxy/app общий body limit, отклонять превышение числа/размера файлов и ограничивать частоту и concurrency тяжёлых маршрутов. Текущий worst-case сумма per-file ограничений — около 194 MiB плюс multipart overhead, поэтому безопасный общий предел нужно выбрать и проверить, а не считать уже заданным.
- Readiness в DEP-05 должен проверять writable artifact volume и доступность трёх renderer binaries.
- DEP-06 требует решения владельца о TTL пользовательских jobs; сейчас automatic retention и backup/restore отсутствуют.

### DEP-08/10/11 — Yandex Cloud

- Целевой план: одна Linux VM, HTTPS reverse proxy, отдельный постоянный том, сначала deterministic provider; Yandex AI Studio — отдельная конфигурация после model/policy и budget checks.
- До DEP-08/10 нужно получить безопасный read-only inventory либо точную причину отсутствия доступа, а также выбрать folder/zone, sizing, домен/DNS, registry, roles/secrets и бюджет. В этом аудите ничего из облачных ресурсов не подтверждено.
- DEP-11 не может считаться GO, пока для выбранного сценария не снят известный Visual NO-GO.

## Обновление 2026-09-27 — локальный Node/npm pin

Для локальной разработки пакета закреплены Node.js 24.13.0 и npm 11.6.2 по
версиям, обнаруженным на Windows-хосте. Pin находится в `.nvmrc`,
`package.json` и корневой записи `package-lock.json`. Это закрывает только
отсутствие локального pin, отмеченное в датированной инвентаризации выше.
Версия Node для Linux-образа, Linux-версии LibreOffice/Poppler и шрифтов,
Linux build и runtime acceptance остаются непроверенными; DEP-02 не закрыт.

## Использованные источники и проверки

Прочитаны пользовательские инструкции/контекст: AGENTS_VK.md, VK_TECH_HACKATHON_CONTEXT_FOR_CODEX.md, docs/VK_TECH_CURRENT_STATE_AND_ROADMAP.md, vk-tech-hackathon/docs/DEPLOY_YANDEX_CLOUD_PLAN.md, vk-tech-hackathon/docs/TASK_COORDINATION.md, а также vk-tech-hackathon/AGENTS.md и пакетные source/config файлы, указанные выше. Секретные файлы не открывались.

Команды/проверки: git rev-parse HEAD; git status --short; scripts/task-coordination.ps1 -Action List; scripts/task-coordination.ps1 -Action Mark ... -Status in_progress; node --version; npm --version; чтение JSON metadata package/lock/library; точечные rg/чтения API, parser, provider и artifact-store; Get-Command для renderer/yc/WSL/Docker; версии Windows Poppler; метаданные soffice.exe; проверка наличия Linux build files и report path. Read-only Yandex Cloud запросы не выполнены, потому что yc отсутствует. soffice --version не вернул вывод за 10 секунд; запущенные этой проверкой процессы остановлены, повторный запуск не выполнялся.

Не запускались тесты, build, Docker, provider calls, cloud API calls или deploy. После создания отчёта отдельно выполнены git diff --check и сверка изменённых путей с allowlist.
