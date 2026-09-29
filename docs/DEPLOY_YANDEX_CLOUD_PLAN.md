# План развёртывания хакатонного MVP в Yandex Cloud

Статус на 2026-09-23: **план**, удалённый релиз не выполнен. Источник требований —
`VK_TECH_HACKATHON_CONTEXT_FOR_CODEX.md`, текущее состояние —
`docs/VK_TECH_CURRENT_STATE_AND_ROADMAP.md`. Перед каждым пунктом проверять
актуальные код, тесты, Git, локальный реестр броней и состояние облака: этот
файл не заменяет фактическую проверку.

## Цель и выбранный первый контур

Развернуть **только** изолированное приложение `vk-tech-hackathon` как
одиночный Next.js Node runtime на Linux VM в Yandex Compute Cloud. Перед ним
поставить HTTPS reverse proxy; сохраняемые job-артефакты держать на отдельном
постоянном томе. В образе нужны LibreOffice Impress, Poppler и проверенные
шрифты. Сначала проверить `deterministic` режим без платных AI-вызовов;
включение Yandex AI Studio — отдельный пункт после проверки модели и бюджета.

Это стартовая архитектура для демо, а не решение о горизонтальном
масштабировании. Пока `ArtifactStore` использует локальный каталог, приложение
работает в одном экземпляре. Если потребуется несколько реплик, нужен новый
план для общего хранилища, очереди и синхронизации состояния.

Не использовать root `docker-compose.yml`, `apps/*`, Prisma, существующий
production Lazyum, его домен или deploy scripts. Сборка хакатонного образа
может читать локальную зависимость `packages/pptxgenjs` через контекст сборки
из корня репозитория; менять эту библиотеку только отдельным согласованным
пунктом, если без этого сборка невозможна.

## Как работает команда

Точная команда пользователя **«делай пункты деплоя хакатона»** запускает
навигационный цикл, аналогичный «что делать по проекту хакатона»:

1. Прочитать `AGENTS_VK.md`, контекст, общий roadmap, этот план и
   `vk-tech-hackathon/docs/TASK_COORDINATION.md`; проверить текущий код,
   `git status`, активные claims и уже полученные доказательства.
2. Выбрать **ровно один** минимальный незавершённый и разблокированный пункт
   `DEP-*` по зависимостям ниже. Не выдавать весь этап одним заданием. Если
   пункт фактически выполнен, проверить его критерии, отразить подтверждение
   в этом плане и перейти к следующему. Если пункт занят или пересекается с
   dirty files, выбрать независимый безопасный пункт; иначе назвать блокер.
3. До выдачи задания создать `Claim` со стабильным `DEP-*` ID и точным
   allowlist **файлов**, включая новые. Путь к этому плану и общий roadmap
   не включать в scope исполнителя. В готовом промпте указать claim ID,
   точные пути, зависимости, non-goals, критерии, команды проверки и правила
   `Mark`, `Extend`, `Accept` из `TASK_COORDINATION.md`.
4. Исполнитель работает в отдельном чате. Текущий навигационный чат принимает
   его deep link/отчёт, сверяет реальный diff, проверки и критерии, затем
   выносит `Accepted`, `Not accepted` или `Cannot verify`. Только после
   `Accepted` закрыть claim и обновить статусы плана и общего roadmap.
5. Следующий вызов команды выбирает следующий пункт. Сама команда назначает
   работу, но не запускает код, не создаёт VM, не тратит деньги, не делает
   live/provider вызовы и не выполняет commit, push или deploy.

Если пользователь явно просит в текущем чате **исполнить** конкретный `DEP-*`,
это отдельный режим: выполнять только названный пункт в его границах. Для
платного вызова, облачных ресурсов, публикации или cutover заранее нужны
конкретные параметры и разрешение на соответствующее действие. Предыдущая
приёмка локального пункта такого разрешения не даёт.

После принятия пункта навигационный чат отвечает отдельной строкой:
`Решение принято. Начинай новый чат и спрашивай «делай пункты деплоя хакатона».`

## Пункты

Все пункты ниже имеют статус `planned` до проверки. Предлагаемые пути —
начальный scope; перед `Claim` уточнить точный список файлов по текущему коду.
При необходимости нового пути исполнитель сначала делает `Extend`. Ни один
пункт не должен поглощать уже изменённые чужие файлы. Если новый пункт требует
файл, оставшийся dirty после принятого предыдущего пункта, остановиться:
проверить безопасный независимый пункт либо запросить отдельное решение о
точечном commit. Не обходить проверку dirty files и не делать commit по
умолчанию.

### DEP-01 — инвентаризация и параметры запуска

Зависимости: нет. Scope: только новый отчёт
`vk-tech-hackathon/docs/DEPLOY_READINESS.md`.

Проверить текущий пакет и lockfile, связь `file:../packages/pptxgenjs`, версию
Node, Linux-зависимости `soffice`/`pdfinfo`/`pdftoppm`, шрифты, размеры
загрузок, маршруты, режимы LLM, запись артефактов, наличие auth/rate limits,
retention и health. Отдельно зафиксировать active claims/dirty files и
известный Visual `NO-GO`. Проверить доступ к Yandex Cloud и уже существующие
VM, сеть, registry, DNS **только чтением**, не выводя секреты.

Готово, когда отчёт содержит подтверждённое `есть/нет/не проверено`, точные
блокеры и минимальные параметры для следующих пунктов. Проверка: ссылки на
прочитанные файлы, результаты read-only команд, `git diff --check`.

### DEP-02 — воспроизводимая Linux-сборка

Зависимости: DEP-01. Предлагаемые пути:
`vk-tech-hackathon/Dockerfile`,
`vk-tech-hackathon/Dockerfile.dockerignore`,
`vk-tech-hackathon/compose.demo.yml` и при необходимости один точный файл
скрипта сборки в `vk-tech-hackathon/scripts/`.

Build context должен оставаться корнем репозитория из-за локальной зависимости
`packages/pptxgenjs`. Чтобы не менять root infrastructure и при этом фильтровать
именно этот context, использовать Dockerfile-specific ignore file рядом с
Dockerfile; обычный package-local `.dockerignore` не действует на root context.

Собрать только hackathon app из корневого Docker build context с локальной
зависимостью `packages/pptxgenjs`. Зафиксировать поддерживаемую Node-версию,
версии LibreOffice/Poppler, системные шрифты, непривилегированного runtime
пользователя, writable temp и volume `VK_HACKATHON_ARTIFACT_ROOT` вне образа.
Проверить, что `.env*`, `.data`, `.agent-state`, тестовые артефакты и ключи не
попадают в image. Не подключать root production Compose.

Готово, когда `docker build` проходит, контейнер стартует в deterministic
режиме, внутри доступны `soffice`, `pdfinfo`, `pdftoppm`, а повторный старт с
тем же volume видит ранее сохранённый job. Команды и image digest записать
в отчёт. Не считать локальный build доказательством качества презентаций.

### DEP-03 — доступ к демо и приватным артефактам

Зависимости: DEP-01, DEP-02. Предлагаемые пути определяются после
инвентаризации: точный reverse-proxy config либо новые файлы защиты доступа
в `vk-tech-hackathon/src/`, плюс точный тестовый файл. Если требуется правка
`compose.demo.yml` из DEP-02, сначала решить проблему dirty overlap.

Закрыть путь к загруженным материалам и скачиваемым артефактам для чужих
посетителей выбранной моделью доступа. Для раннего ограниченного демо
допустим access control на reverse proxy, если он охватывает **все**
UI/API/artifact маршруты, Next не доступен напрямую снаружи и есть проверка
обхода. Конкретную модель доступа зафиксировать до реализации.

Готово, когда неавторизованный запрос не получает ни страницу, ни job,
artifact или export; авторизованный полный локальный flow проходит. Не
вводить SaaS auth/billing Lazyum.

**Проверенная приёмка (2026-09-27, claim `1d93b00b-3d88-4654-956e-9ef93fc493f3`): ACCEPTED.** Демо закрыто HTTP Basic Auth в Next Proxy: без credentials приложение отвечает 401, при отсутствующей конфигурации — 503; публичным оставлен только `/api/health`. Demo Compose требует оба секрета и публикует порт только на `127.0.0.1`. Для полного разрешённого upload Proxy limit установлен в 196 MiB, ровно до существующего `REQUEST_BODY_LIMITS.generate`.

`npm run typecheck`, production build, Compose config и `tests/demo-access.test.ts` (15/15) прошли. Локальный deterministic runtime принял organizer PPTX 20,525,772 bytes, создал три варианта, отдал job и planning artifact авторизованному клиенту и экспортировал PPTX 3,509,998 bytes. Запросы без credentials к UI, generate, job, artifact и export получили 401; `/api/health` получил 200. Независимый read-only reviewer вернул ACCEPTED. Проверка локальная: облако, внешний HTTPS proxy, commit и deploy не выполнялись; публичный запуск остаётся NO-GO до остальных пунктов и общей Visual-приёмки.

Следующий пункт очереди — **DEP-04: лимиты запросов и тяжёлых процессов**.

### DEP-04 — лимиты запросов и тяжёлых процессов

Зависимости: DEP-01. Предлагаемые пути: точные route и lib файлы после
инвентаризации, плюс отдельные тесты. Не пересекать активные scopes DEP-03.

Ограничить HTTP-body, частоту запросов и одновременные тяжёлые
`analyze/generate/export`, чтобы несколько запросов не запускали
неограниченное число LibreOffice-процессов. Сохранить текущие лимиты
шаблонов и материалов, добавить контролируемую ошибку при превышении.

Готово, когда тесты подтверждают каждый лимит и нормальный одиночный flow;
параллельные запросы не обходят общий предел процесса.

### DEP-05 — health и готовность runtime

Зависимости: DEP-01. Предлагаемые пути:
`vk-tech-hackathon/src/app/api/health/route.ts`,
`vk-tech-hackathon/tests/health-route.test.ts`.

Добавить безопасный health endpoint для процесса и отдельную readiness
проверку доступности artifact volume и renderer binaries. Не выдавать
внутренние пути, конфигурацию провайдера или секреты.

Готово, когда health отвечает при живом процессе, readiness обнаруживает
отсутствие volume или бинарника, а тесты проходят на локальном Node runtime.

### DEP-06 — хранение, очистка и восстановление

Зависимости: DEP-01. Предлагаемые пути:
`vk-tech-hackathon/scripts/prune-jobs.ts`,
`vk-tech-hackathon/tests/prune-jobs.test.ts`,
`vk-tech-hackathon/docs/DEPLOY_DATA_OPERATIONS.md`.

Определить срок хранения job, очистку старых данных без удаления активных
jobs, мониторинг свободного места, backup/restore volume и процедуры
остановки/повторного запуска.

Готово, когда cleanup работает в dry-run и на тестовом каталоге, а
restart/restore возвращает опубликованный job. Для реальных пользовательских
данных срок хранения требует решения владельца.

### DEP-07 — локальная приёмка production-образа

Зависимости: DEP-02…DEP-06. Scope: новый
`vk-tech-hackathon/docs/DEPLOY_LOCAL_ACCEPTANCE.md` и, если необходим,
`vk-tech-hackathon/tests/deploy-container-smoke.test.ts`.

Запустить контейнер через production команду с изолированным volume и
deterministic provider. Проверить health, upload неизвестного/held-out PPTX,
PNG, `generate` с тремя вариантами, reopen, аудит и скачивание PPTX/PDF/HTML;
повторить после restart. Проверить отказ при отсутствии volume/renderer и
проверки доступа. Зафиксировать wall-clock время полного flow относительно
предела 5 минут из ТЗ. Реальные provider-вызовы здесь не нужны.

Готово, когда тесты, команды, HTTP-коды, artifact refs и ограничения записаны
и воспроизводимы. Visual `NO-GO` из общего roadmap остаётся отдельным
release blocker, пока новый полный просмотр не примет качество.

### DEP-08 — спецификация Yandex Cloud и секретов

Зависимости: DEP-01, DEP-07. Scope: только новый документ
`vk-tech-hackathon/docs/DEPLOY_YANDEX_CLOUD_RUNBOOK.md`.

Сопоставить фактический cloud/folder, billing, зону, VM и диск, сеть и
Security Group, SSH, статический IP, домен/DNS, registry, роли service
account, место хранения секретов, резервное копирование и предполагаемый
бюджет. Начать с одной VM и HTTPS proxy; размер VM/диска выбрать по замерам
DEP-07, а не считать прежнюю оценку обязательной. Развести deterministic и
Yandex AI Studio конфигурации; модель должна пройти `MODELS.md` и требования
организаторов до первого платного вызова.

Готово, когда есть проверяемая схема ресурсов, точные команды создания,
ожидаемые расходы и rollback. Секреты и приватные ключи в документ не писать.
Недостающий домен, доступ или бюджет обозначить как `NEEDS_USER_DECISION`.

### DEP-09 — фиксация release candidate

Зависимости: DEP-07, DEP-08 и приёмка всех изменений, включаемых в релиз.
Scope: новый отчёт `vk-tech-hackathon/docs/DEPLOY_RELEASE_CANDIDATE.md`;
Git commit/push только после отдельного согласования точного набора файлов.

Собрать список изменений для релиза из проверенных `DEP-*` и принятых
продуктовых задач. Сверить его с dirty files и active claims; не включать
посторонние root Lazyum или незавершённые работы. Прогнать предусмотренные
планом проверки на точном кандидатном дереве, записать SHA исходников,
зависимости, сборочные команды и способ повторной сборки. Если без commit
нельзя получить воспроизводимый исходный SHA, подготовить узкий staged set и
показать его владельцу до фиксации.

Готово, когда есть проверенный неизменяемый source ref и отчёт, какие файлы
вошли, какие проверки прошли и какие dirty изменения остались за пределами.
Непринятый Visual результат не включать в публичный `GO`.

### DEP-10 — создание staging и доставка неизменяемого релиза

Зависимости: DEP-08, DEP-09 и явное согласование конкретных ресурсов и
расходов. Scope: только согласованные ресурсы Yandex Cloud и новый отчёт
`vk-tech-hackathon/docs/DEPLOY_STAGING_RELEASE.md`; не трогать сервер Lazyum.

Создать/настроить VM, диск, сеть, firewall, registry и service account;
выпустить образ с уникальным тегом и digest; развернуть digest на staging.
Секреты передать через защищённый server-only канал. HTTPS и доступ проверить
снаружи. Никакого `latest` как идентификатора выпуска.

Готово, когда записаны resource IDs, release SHA, image digest, адрес staging,
результат health/readiness и способ отката. Создание облачных ресурсов,
commit/push и выкладка — отдельные явные действия после проверки
подготовленного результата.

### DEP-11 — staging acceptance и решение о публичном запуске

Зависимости: DEP-10, отсутствие Visual `NO-GO` для выбранного демонстрационного
сценария. Scope: новый отчёт
`vk-tech-hackathon/docs/DEPLOY_STAGING_ACCEPTANCE.md` и изолированные тестовые
артефакты; источник и результат не добавлять в Git без решения.

Из внешнего браузера проверить закрытый доступ, полный flow с незнакомым
PPTX и материалом, 3 варианта, пользовательский audit, reopen, PPTX/PDF/HTML,
перезапуск и сохранность job. Просмотреть полный выбранный PPTX в PowerPoint,
проверить редактируемость объектов и время генерации. Зафиксировать ошибки,
нагрузку CPU/RAM/диска и расход. Live Yandex provider проверять только при
отдельном разрешении с точным лимитом вызовов/стоимости и подтверждённой
моделью; deterministic PASS не означает live PASS.

Готово, когда независимая проверка подтверждает критерии выбранного демо и
даёт `GO` или честный `NO-GO` с конкретным блокером.

### DEP-12 — домен и публичный cutover

Зависимости: DEP-11 `GO`, согласованный домен/DNS и явное решение владельца о
публикации. Scope: DNS/HTTPS/reverse proxy именно хакатонного сервиса и новый
отчёт `vk-tech-hackathon/docs/DEPLOY_PUBLIC_CUTOVER.md`.

Привязать домен к проверенному release digest, проверить HTTPS, доступ,
полный внешний smoke, логи, сохранность volume и rollback. Не менять
`slides.lazyum.ru` или release текущего продукта.

Готово, когда публичный URL отвечает, smoke проходит, доступ к приватным
артефактам закрыт, а инструкция и адрес отката проверены. Зафиксировать
точный digest, дату, URL и оставшиеся ограничения.

## Правила приёмки и состояния

Статус каждого пункта менять только после проверки: `planned`, `claimed`,
`awaiting_acceptance`, `accepted`, `blocked`. Строка статуса и ссылка на
evidence добавляются навигационным чатом после приёмки; локальный claim остаётся
источником истины о том, кто сейчас владеет файлами. Деплой на staging и
публичный cutover не являются автоматическим продолжением локального PASS.

| ID | Статус | Evidence после приёмки |
| --- | --- | --- |
| DEP-01 | accepted | `vk-tech-hackathon/docs/DEPLOY_READINESS.md` (2026-09-23) |
| DEP-02 | accepted | claim `a7ae1b81-3f3d-4bef-a32d-ee9d2152798e`; run `HACK-20260924-dep-02-dockerhub-retry-02`; Buildx image digest `sha256:3c9c13563f5c152769ba519ebe5ac3b73169e6064463916832a66f3d1f363a7b`; cycle 12 runtime review ACCEPTED; see `.agent-state/task-reports/dep-02-linux-build.md` |
| DEP-03 | planned | — |
| DEP-04 | accepted | claim `0ef2c1c8-ae01-4e55-84f9-613549cc9c1c`; run `HACK-20260924-2004-dep-04-request-guards`; 5 files / 24 tests, typecheck and scoped diff checks passed (2026-09-24) |
| DEP-05 | accepted | commit `2314069` + independent review `HACK-20260924-1702-dep-05-acceptance`; route suite 4/4, typecheck exit 0 (2026-09-24) |
| DEP-06 | accepted | claim `18e5e954-112f-469a-99b5-aa54cce2056a`; independent read-only review, focused Vitest 4/4, typecheck and disposable CLI smoke (2026-09-27); `docs/DEPLOY_DATA_OPERATIONS.md` |
| DEP-07 | accepted | claim `602dd629-9072-4829-a90f-fbf8f3b6834e`; run `HACK-20260927-2028-dep-07-local-acceptance`, cycle 5 reviewer `/root/dep07_review_c5` ACCEPTED; `docs/DEPLOY_LOCAL_ACCEPTANCE.md` |
| DEP-08 | accepted | claim `924efa48-52e8-4d25-a115-8435a41b2c54`; `docs/DEPLOY_YANDEX_CLOUD_RUNBOOK.md`; independent read-only reviewer `/root/dep08_review2` ACCEPTED (2026-09-28); cloud resources not created; unresolved inputs remain `NEEDS_USER_DECISION` |
| DEP-09 | accepted | run `HACK-20260928-0916-dep-09-release-candidate`; source commit `d1aaa38c1359867fb8c6eb99e130596eae4bba63`, tree `0de898c9244accf5b6a2af0a17f15032a19f1f2a`; local linux/amd64 image `sha256:de5a440d69fac6291aaffd1c1bba28fc4355238b77db7ccdbf9a5da7ed1a8422`; `vk-tech-hackathon/docs/DEPLOY_RELEASE_CANDIDATE.md`; independent cycle 8 review `/root/dep09_reviewer_c8` ACCEPTED. Local image only: no push/cloud/staging/prod deploy; host-port reachability unconfirmed. |
| DEP-10 | planned | — |
| DEP-11 | planned | — |
| DEP-12 | planned | — |

`DEP-01` принят 2026-09-23; проверенные факты и ограничения записаны в
`vk-tech-hackathon/docs/DEPLOY_READINESS.md`. `DEP-05` принят 2026-09-24:
health отвечает 200 без кэширования; readiness проверяет настроенный каталог
артефактов на запись и наличие `soffice`, `pdfinfo`, `pdftoppm`, возвращая
503 при отсутствии любого обязательного условия. Ответ не содержит путей или
конфигурации. Проверка подтверждает доступный writable-каталог, но не доказывает,
что он является постоянным смонтированным томом; renderer binaries не запускались.
`DEP-02` остаётся заблокированным claim `a7ae1b81-3f3d-4bef-a32d-ee9d2152798e`
на base HEAD `6969541ecba9467f300b7ce6bec656b18e4ac294`. `docker compose config
--quiet` прошёл; единственный фактический build из чистого архивного контекста
завершился exit 1 на `npm ci` (`ECONNRESET`), после чего параллельная установка
Debian-пакетов была отменена. Независимый reviewer вынес `BLOCKED`: образ и
runtime acceptance не получены, а версии LibreOffice, Poppler и шрифтов ещё не
закреплены. Отчёт: `vk-tech-hackathon/.agent-state/task-reports/dep-02-linux-build.md`;
архивный SHA-256: `825B9725E7E29B73E85E41240DB01C7A104744B6236FDF361D4C58AAC0BE67FC`.
Сборка не повторялась, контейнеры не запускались; claim остаётся активным до
восстановления npm registry route/cache, закрепления системных версий и полной
локальной проверки по критериям DEP-02.
Visual `NO-GO` остаётся отдельным блокером публичного запуска.

`DEP-06` принят 2026-09-27 после независимой read-only проверки. Добавлены
dry-run по умолчанию для выборочной очистки завершённых старых jobs,
проверки реального artifact root, manifest и времени, а также явное требование
остановить все writer-процессы перед удалением. Тест 4/4 проверил защиту
активных jobs и повторное чтение опубликованного артефакта после копирования
и восстановления тестового тома; typecheck и CLI smoke прошли. Процедуры
мониторинга места, backup/restore и restart записаны в
`vk-tech-hackathon/docs/DEPLOY_DATA_OPERATIONS.md`. Срок хранения и применение
удаления к реальным данным требуют решения владельца; контейнерный restore
остаётся критерием DEP-07.

`DEP-04` принят 2026-09-24 после независимой проверки. В `/api/analyze` и
`/api/generate` поток тела ограничен 52 MiB и 196 MiB соответственно; export
PPTX/PDF/HTML ограничен 50 MiB. Сохранены пределы файла шаблона 50 MiB,
source-файла 12 MiB и 12 source-файлов. Process-local guard ограничивает
analyze/generate пятью запросами в минуту, exports — 30 запросами в минуту и
одной тяжёлой операцией одновременно. Нарушения получают HTTP 413, 429 или 503;
`Retry-After` возвращается для 429/503. Focused suite прошёл 5 файлов / 24
теста после одного разрешённого повтора по `spawn EPERM`; `npm run typecheck` и
scoped `git diff --check` завершились с exit 0. Ограничители действуют только
в одном Node-процессе и сбрасываются при перезапуске. DEP-02 всё ещё blocked;
это не подтверждает Linux image, runtime или удалённый deploy. Visual `NO-GO`
остаётся отдельным блокером публичного запуска.

**Актуальное продолжение DEP-02 по реестру claim на 2026-09-24:** второй
Docker build не запускался. Docker Desktop VHDX находится на `C:` с
2,754,125,824 свободными байтами; `docker system df` завис, поэтому доступный
объём не удалось подтвердить. Подготовка чистого архива и проверка Compose
завершились успешно, но образ и runtime acceptance отсутствуют. Claim
`a7ae1b81-3f3d-4bef-a32d-ee9d2152798e` остаётся `blocked` до проверки/освобождения
места и безопасного возобновления той же задачи.

## DEP-02 accepted locally (2026-09-27)

Run `HACK-20260924-dep-02-dockerhub-retry-02`, claim
`a7ae1b81-3f3d-4bef-a32d-ee9d2152798e`, cycle 12: fresh independent
read-only reviewer `/root/dep02_cycle12_reviewer` returned `ACCEPTED`.
Cycle 11's clean-context Buildx build completed for `linux/amd64`; image
`dep02-cycle11-20260927-hackathon-demo:local` has digest
`sha256:3c9c13563f5c152769ba519ebe5ac3b73169e6064463916832a66f3d1f363a7b`.
The image uses the pinned Node base and Debian package snapshot recorded above.

An isolated loopback-only Compose project started the existing image with the
`deterministic` provider and a dedicated named artifact volume. Health and
readiness returned HTTP 200; `soffice` was LibreOffice 7.4.7.2 and
`pdfinfo`/`pdftoppm` were Poppler 22.12.0. One fixture-backed job returned
HTTP 200 and `manifestStatus=ready`; after removing and recreating the
container without deleting its volume, the same job remained ready. The volume
contained 12 job files; the copied fixture SHA-256 matched the source file.
Reviewer independently repeated read-only GETs for health, readiness, and the
job, all HTTP 200.

The sole generation request's decoded brief was malformed, but DEP-02 does not
specify its exact text; its deterministic-job criterion is evidenced by the
ready fixture-backed job and its persistence. No second POST was sent. This is
local image/runtime acceptance only: no provider, cloud, staging or production
deploy was run, and it does not claim presentation quality or public GO.
The next unblocked deployment item is DEP-03 (access to the demo and private
artifacts); its access model must be selected before implementation. Visual
`NO-GO` remains a separate blocker for public launch.
