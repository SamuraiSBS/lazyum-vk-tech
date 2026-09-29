# DEP-07: локальная приёмка production container

Дата: 2026-09-27. Claim `602dd629-9072-4829-a90f-fbf8f3b6834e`, run `HACK-20260927-2028-dep-07-local-acceptance`. Исходный checkout `b16b6b78bc9829440eeeb0287973af55e530f969`. Все запросы направлены только на `127.0.0.1`; режим провайдера `deterministic`. Cloud, staging, публикации и live/paid provider-вызовов не было.

## Область и воспроизведение

Исходный принятый DEP-02 образ `dep02-cycle11-20260927-hackathon-demo:local` (`linux/amd64`, image ID `sha256:3c9c13563f5c152769ba519ebe5ac3b73169e6064463916832a66f3d1f363a7b`) использован только для диагностического прогона. Он собран до принятой DEP-03 авторизации и **не является образом текущего `HEAD`**. Отдельный контейнер `dep07-20260927-c1` слушает только `127.0.0.1:31437`; его volume `dep07-20260927-c1-artifacts` сохранён для проверки. Учётная пара `dep07-local:dep07-local-only-20260927` создана только для этого локального прогона и не является секретом развёртывания.

Чистый build context текущего `HEAD` получен без dirty файлов командой `git -c safe.directory=D:/presentation archive --format=tar --output=<temp>/source.tar HEAD packages/pptxgenjs vk-tech-hackathon` (exit 0). Архив: 62 883 840 байт, SHA-256 `A93CE9FB0F665BA525B9C0078B229E30CC286DFF33575FDE421167F3BF47B611`. Команда `tar -xf` в `C:\Temp` завершилась exit 1 с Windows `Write failed`; извлечённый каталог не использовался. Buildx принимает сам tar как контекст стандартного ввода; для него выбран новый тег `dep07-b16b6b7-20260927-c1:local`.

Команды локального прогона (PowerShell, из `D:\presentation\vk-tech-hackathon`; `docker` потребовал повышенного доступа к локальному named pipe):

```powershell
docker image inspect dep02-cycle11-20260927-hackathon-demo:local --format '{{.Id}} {{.Os}}/{{.Architecture}}'
docker run -d --name dep07-20260927-c1 --platform linux/amd64 --init -p 127.0.0.1:31437:3030 -v dep07-20260927-c1-artifacts:/app/.data/artifacts -e HOSTNAME=0.0.0.0 -e PORT=3030 -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 -e VK_HACKATHON_ARTIFACT_ROOT=/app/.data/artifacts -e VK_HACKATHON_LLM_PROVIDER=deterministic -e VK_HACKATHON_DEMO_AUTH_USER=dep07-local -e VK_HACKATHON_DEMO_AUTH_PASSWORD=dep07-local-only-20260927 dep02-cycle11-20260927-hackathon-demo:local
curl.exe -sS -w ' HTTP:%{http_code} TIME:%{time_total}' http://127.0.0.1:31437/api/health
curl.exe -sS -w ' HTTP:%{http_code} TIME:%{time_total}' -u dep07-local:dep07-local-only-20260927 http://127.0.0.1:31437/api/ready
$env:DEP07_BASE_URL='http://127.0.0.1:31437'
$env:DEP07_BASIC_AUTH=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('dep07-local:dep07-local-only-20260927'))
npm run test -- tests/deploy-container-smoke.test.ts
```

Первый `curl` сразу после запуска получил `Empty reply from server`, exit 1 / HTTP 000. `docker top` показал работающий `npm run start`; позднее лог сообщил `Next.js 16.3.5`, `Ready in 9.4s`. Повторные health и readiness завершились exit 0 / HTTP 200: `{"ok":true}` и `artifactVolume=true`, `soffice=true`, `pdfinfo=true`, `pdftoppm=true`. Это задержка старта, не зафиксированный отказ runtime.

## Диагностический flow на прежнем образе

Новый тест `tests/deploy-container-smoke.test.ts` создаёт в памяти отдельный синтетический PPTX (не копию organizer fixtures), 70-байтовый PNG, отправляет один multipart `generate` на пять слайдов, проверяет три варианта и три аудита, делает `GET /api/jobs/{jobId}` и сохраняемые PPTX/PDF/HTML exports. Доступ к тесту включается только через `DEP07_BASE_URL` и `DEP07_BASIC_AUTH`; без них он пропускается. Тест не создаёт и не удаляет контейнеры.

Перед добавлением проверки auth один завершённый прогон теста: `npm run test -- tests/deploy-container-smoke.test.ts`, exit 0, 1/1. Job `job-28856cdb-c8fb-47d7-80d3-2117602a6c17`, `manifest.status=ready`, варианты `compact`, `balanced`, `visual`, по 5 слайдов, все три `audit.passed=true`; reopen HTTP 200 и тот же job ID. Входной PPTX 46 743 байта, SHA-256 `102b9ff038adcdffeb477ad3645df454b694b8481e0388fe92378f62d0e40272`; PNG 70 байт, SHA-256 `fb423fe89054fd541987161ff6038e43374237dd3d23c07a8ef6f4a7610030ad`.

| Export | HTTP | Artifact ref | Bytes | SHA-256 |
| --- | ---: | --- | ---: | --- |
| PPTX | 200 | `exports/balanced/pptx.pptx` | 81 524 | `dab10a36d7dcb668681c3f7e34d48e9d735a59345c8937850f0285890e84616d` |
| PDF | 200 | `exports/balanced/pdf.pdf` | 43 700 | `f36e006bf29e5b4d85606faa6dbbefb4cba9184a2be33eb78544fde90ee1629e` |
| HTML | 200 | `exports/balanced/html.html` | 9 376 | `01d37729ad36e214c85ae000546a0cb6e4a38a2031d34d142346f40a5f6af670` |

Wall clock от отправки `generate` до завершения HTML export: **57 105 ms**, меньше лимита ТЗ 300 000 ms. Это один локальный синтетический сценарий на тёплом процессе; он не доказывает SLA для неизвестного большого PPTX или реального провайдера. До успешного прогона теста два предыдущих прогона завершились exit 1 из-за неверных ожиданий **самого теста** о форме ответа `GET /api/jobs` и пути export; приложение возвращало HTTP 200. Первый неповышенный запуск Vitest завершился exit 1 с реальным `spawn EPERM` на старте esbuild; после точечного запуска с разрешением процесс стартовал.

`docker restart dep07-20260927-c1` завершился exit 0. `docker inspect` после restart подтвердил прежний mount `dep07-20260927-c1-artifacts:/app/.data/artifacts`; health вновь дал HTTP 200. Повторный `GET /api/jobs/job-28856cdb-c8fb-47d7-80d3-2117602a6c17` дал HTTP 200, тот же `manifest.jobId`, `status=ready`, те же три варианта и аудита. `GET /api/artifacts/{jobId}/exports/balanced/pptx.pptx` дал HTTP 200 и 81 524 байта. Это подтверждает сохранность job и PPTX в выделенном томе после **restart того же контейнера**; пересоздание контейнера в этом DEP-07 прогоне не проверено.

## Обнаруженный блокер

На прежнем образе `GET /api/ready` без заголовка Authorization и с неверным паролем возвращал HTTP 200. Неавторизованные probes на несуществующие `/api/jobs/job-missing` и `/api/artifacts/job-missing/manifest.json` вернули HTTP 404 вместо 401. Текущий `src/proxy.ts` в `HEAD` требует Basic auth для всех путей кроме `/api/health`; поэтому прежний образ нельзя использовать как доказательство DEP-03/DEP-07 access gate. Для приёмки нужен новый образ из чистого текущего `HEAD`, повторный flow и проверка отказов. Visual `NO-GO` из общего roadmap остаётся самостоятельным блокером публичного `GO`; этот отчёт не принимает PowerPoint визуальное качество.

## Продолжение после перезапуска Docker (2026-09-27)

### Проверка среды и чистый контекст

После сообщения о перезапуске Docker команда `docker info --format '{{.ServerVersion}} {{.OSType}} {{.Architecture}}'` завершилась exit 0 и вернула `29.4.2 linux x86_64`. Порт `31438` был свободен. Исходный контейнер `dep07-20260927-c1` оставался `Exited (255)` на `127.0.0.1:31437`, volume `dep07-20260927-c1-artifacts` присутствовал; оба ресурса сохранены без запуска или удаления.

К моменту продолжения текущий коммит был `f2da69db0b68c175371055447b1dcd60ad3bf700`; `b16b6b78bc9829440eeeb0287973af55e530f969` является его предком. Свежий контекст создан через `git archive` из текущего `HEAD`, только с путями `packages/pptxgenjs` и `vk-tech-hackathon`, поэтому dirty working tree в него не вошёл. Архив: 62 894 080 байт, SHA-256 `E01253185E63573E7B7903E89FB3FAB6D0839333796DADAFC853BD9159620C93`. Имя временного tar-файла содержало суффикс `b16b6b7`, но при запуске сборки его зафиксированное содержимое соответствовало `f2da69db`; тег образа также явно содержит `f2da69d`.

### Единственная fresh-сборка

Команда: `docker.exe buildx build --load --platform linux/amd64 --progress=plain --tag dep07-f2da69d-20260927-c2:local -f vk-tech-hackathon/Dockerfile - < C:\Temp\dep07-b16b6b7-20260927-c2-source.tar`. Buildx ID `l7j8qsqvc9rjzw3qy692at2kp`, builder `desktop-linux`, статус `Error`, build duration `2m 42s`; оболочка начала команду в `23:12:28.024 +03` и вернула exit 1 в `23:16:00.182 +03`.

Контекст и pinned Node image загрузились. `npm ci` завершился успешно за `60.1s`, установил 122 пакета; audit сообщил 5 уязвимостей (3 moderate, 1 high, 1 critical). `next build --webpack` на Next.js `16.3.5` скомпилировал webpack успешно за `14.5s`, затем упал на TypeScript-проверке committed `tests/browser/export-visual-parity.spec.ts`: отсутствующий `Page` на строках 525, 646, 712 и 739; implicit `any` у `box` на строке 592 и `frame`/`expectedSize` на строке 713; TS2347 у generic-вызова на строке 721. Docker завершил шаг `RUN npm run build && npm prune --omit=dev` с exit 1. TLS/network failure не возник. Новый тег отсутствует (`docker image inspect dep07-f2da69d-20260927-c2:local` exit 1); новую сборку и контейнерный flow не повторял.

### Проверки кода и пределы доказательств

После добавления auth probes локальный `npm run typecheck` завершился exit 1 на синтаксически повреждённом сгенерированном `.next/dev/types/validator.ts`: строка 116 — TS1128, TS1005 и TS1002 (unterminated string literal), строка 120 — TS1128. Этот `.next` файл не входит в claim и не менялся.

В `tests/deploy-container-smoke.test.ts` добавлены проверки для корректного публичного `/api/health`, отсутствующего и неверного Basic auth на `/api/ready` и `/api/generate`, а также уже имевшиеся проверки хороших credentials, неавторизованных job и artifact. Команда `npm run test -- tests/deploy-container-smoke.test.ts` запущена с удалёнными из окружения `DEP07_BASE_URL` и `DEP07_BASIC_AUTH`; exit 0, `1 test skipped`. Это подтвердило загрузку теста Vitest, но не исполнило HTTP-проверки: образ текущего `HEAD` не собрался. Повторный прогон smoke и readiness с ошибочным artifact root или ограниченным `PATH` поэтому невозможен на этом образе.

В рамках этого продолжения менялись только два claim-файла: этот отчёт и `tests/deploy-container-smoke.test.ts`. Прежний контейнер и volume не менялись. Visual `NO-GO` остаётся в силе; DEP-07 и публичный `GO` не приняты.

## Цикл 2: current-HEAD image и локальная runtime-приёмка

### Provenance временного build context

В начале цикла HEAD общей рабочей копии продвинулся с f2da69db0b68c175371055447b1dcd60ad3bf700 до 3f6cf95ec438da0d6941343782a1b92e10b26a07. Коммит 3f6cf95 добавил editor controls и изменил пять committed путей: src/app/globals.css, src/components/hackathon-studio.tsx, src/lib/request-guards.ts, tests/browser/generation-reopen-export.spec.ts и tests/request-guards.test.ts. Поэтому ранее подготовленный архив f2da не использовался для Buildx. Dockerfile, package manifest/lock и два DEP-07 пути этими коммитами не менялись.

Проверка git diff --unified=0 -- vk-tech-hackathon/tests/browser/export-visual-parity.spec.ts подтвердила, что рабочий diff состоял только из замены одной строки импорта: добавлен уже принятый type Page. Временный context создан из exact committed HEAD 3f6cf95..., включал только packages/pptxgenjs и vk-tech-hackathon (234 файла). В temp-копии заменена только эта строка; сравнение хешей дерева подтвердило ровно один изменившийся файл vk-tech-hackathon/tests/browser/export-visual-parity.spec.ts. Репозиторий, включая этот исходник, для overlay не редактировался.

| Артефакт | Размер | SHA-256 |
| --- | ---: | --- |
| git archive exact HEAD 3f6cf95... | 62 904 320 B | 5C2F2F92DF4011AF0E27B85B71D2D6F886FA0E5B1C08B5B85E75BC739DC4F6A2 |
| Overlay import file внутри temp tree | — | 62387F5CF28B9D0CDEEACAD9FE98FBDD40C6AB77B781C77D012146E5527FD549 |
| Упакованный patched context | 62 906 368 B | 765F40CB92B5A5F938F7076320F0CD7F352532F5F7E9BE7E94089CC6BB8B20D7 |

Buildx получил проверенный каталог C:\Temp\dep07-c2-current-ab6671fa2e284255ad943462c0d0e5f4\tree; его 234 файла совпадали с archive tree, кроме указанного импорта. Архив-отпечаток приведён для точного воспроизведения содержимого каталога. Никакие прочие dirty-файлы не вошли.

### Production image build

    docker.exe buildx build --load --platform linux/amd64 --progress=plain --tag dep07-head-3f6cf95-overlay-c2-20260927:local --file C:\Temp\dep07-c2-current-ab6671fa2e284255ad943462c0d0e5f4\tree\vk-tech-hackathon\Dockerfile C:\Temp\dep07-c2-current-ab6671fa2e284255ad943462c0d0e5f4\tree

Команда завершилась exit 0. Buildx ID 8rwdp8opjecw8d6t08x8pfg0k, builder desktop-linux, 2026-09-27 23:30:22.914 +03 — 23:39:51.045 +03, 568.130 s, 18/18 шагов, 5 cached. npm ci добавил 122 пакета за 52.3 s; audit до pruning сообщил 5 проблем (3 moderate, 1 high, 1 critical). next build --webpack успешно завершил webpack compilation за 29.2 s, TypeScript за 8.7 s и создал 10/10 static pages. npm prune --omit=dev занял 337.4 s, удалил 50 пакетов, финальный npm audit сообщил 0 vulnerabilities. Runtime renderer apt слой был cached. Buildx выдал две lint warnings FromPlatformFlagConstDisallowed для константного FROM --platform=linux/amd64 в строках 9 и 33 Dockerfile; они не помешали сборке.

Immutable image: sha256:16d8fa416335df1e54e99acb475f4711b44f17da26968d6d998c75e8e8feecea, linux/amd64, 493 505 604 B. OCI index digest sha256:16d8fa416335df1e54e99acb475f4711b44f17da26968d6d998c75e8e8feecea, amd64 manifest sha256:77549710ef1e8a32f72a8ff021e1af68435384e2da840d824824549c27b7b22c. Цикл 1 остаётся отдельной историей: clean HEAD f2 build упал на TypeScript errors без принятого Page import; этот ошибочный image не использовался. Новый image собран из следующего committed HEAD 3f плюс единственный разрешённый временный overlay.

### Основной контейнер и smoke

Основной контейнер dep07-head-3f6cf95-overlay-c2-20260927 запущен из нового image на 127.0.0.1:31439, volume dep07-head-3f6cf95-overlay-c2-artifacts-20260927:/app/.data/artifacts, провайдер deterministic, NODE_ENV=production. Для Basic auth использована отдельная локальная тестовая пара dep07-c2-local:dep07-c2-only-20260927, не credential развёртывания. Контейнер и volume от цикла 1 не трогались.

Фактическая команда запуска (exit 0, затем inspect показал состояние running и указанный named volume):

    docker.exe run -d --name dep07-head-3f6cf95-overlay-c2-20260927 --platform linux/amd64 --init -p 127.0.0.1:31439:3030 -v dep07-head-3f6cf95-overlay-c2-artifacts-20260927:/app/.data/artifacts -e HOSTNAME=0.0.0.0 -e PORT=3030 -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 -e VK_HACKATHON_ARTIFACT_ROOT=/app/.data/artifacts -e VK_HACKATHON_LLM_PROVIDER=deterministic -e VK_HACKATHON_DEMO_AUTH_USER=dep07-c2-local -e VK_HACKATHON_DEMO_AUTH_PASSWORD=dep07-c2-only-20260927 dep07-head-3f6cf95-overlay-c2-20260927:local

Для curl проб использовался заголовок Authorization: Basic с этими тестовыми credentials; неверная пара была dep07-invalid:wrong-password. Например:

    $good = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('dep07-c2-local:dep07-c2-only-20260927'))
    curl.exe -sS -w 'HTTP:%{http_code} TIME:%{time_total}' http://127.0.0.1:31439/api/health
    curl.exe -sS -H "Authorization: Basic $good" -w 'HTTP:%{http_code} TIME:%{time_total}' http://127.0.0.1:31439/api/ready

Preflight curl results на свежем image:

| Запрос | Результат |
| --- | --- |
| GET /api/health, без auth | HTTP 200, 0.417 s |
| GET /api/ready, без auth / неверный Basic auth | HTTP 401 / 401 |
| GET /api/ready, корректный Basic auth | HTTP 200, 0.057 s; artifactVolume=true, soffice/pdfinfo/pdftoppm=true |
| POST /api/generate, без auth / неверный Basic auth | HTTP 401 / 401 |

Команда smoke была исполнена с локальными opt-in переменными и не была пропущена:

    $env:DEP07_BASE_URL = 'http://127.0.0.1:31439'
    $env:DEP07_BASIC_AUTH = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('dep07-c2-local:dep07-c2-only-20260927'))
    npm.cmd run test -- tests/deploy-container-smoke.test.ts

Первый фактический прогон завершился exit 1 (1 failed, 98.44 s): generation, reopen и PPTX export прошли; первый cold soffice вызов превысил установленный приложением process timeout 60 000 ms и POST /api/export/pdf вернул HTTP 500. Server-only diagnostic зафиксировал stage=run_libreoffice, errorCode=timeout, rendererBasename=soffice, без stdout/stderr. Это ограничение осталось в отчёте и не скрыто. Одна диагностическая повторная PDF-конверсия для того же job после прогрева LibreOffice завершилась HTTP 200 за 11.191335 s, 43 700 B, application/pdf, SHA-256 6773391E4A580794030A2D2A9B201BE690599E4039D952E21A44E17E7F1A955B.

Затем полный smoke command исполнен ещё раз на том же свежем image; он завершился exit 0: 1 test passed, 0 skipped; Vitest total 5.95 s. Новый held-out input создан в памяти теста, не взят из organizer fixture:

| Результат | Значение |
| --- | --- |
| Новый job | job-cc7b60e6-9049-421f-927e-841eabf81be7, manifest.status=ready |
| PPTX input | 46 743 B, SHA-256 983d8badfb940edc9c423d6a3227392a5c98e2ac51cf190a954c785629abcea3 |
| PNG input | 70 B, SHA-256 fb423fe89054fd541987161ff6038e43374237dd3d23c07a8ef6f4a7610030ad |
| Generation/reopen | generation HTTP 200 за 318 ms; reopen HTTP 200 с тем же job ID |
| Variants and audits | compact, balanced, visual; по 5 slides на вариант; три audit.passed=true |
| Unauthorized reads | job и artifact без credentials: HTTP 401 / 401 |
| Полный flow | 4 288 ms от generate до конца HTML export; меньше лимита 300 000 ms |

Все exports — HTTP 200, artifact path headers совпали с сохранённым путём:

| Format | Artifact ref | Bytes | SHA-256 | Время с начала flow |
| --- | --- | ---: | --- | ---: |
| PPTX | exports/balanced/pptx.pptx | 81 524 | 05b94e9e01044fba0378b815fee102659f041b875f457d397f227afa32d366a8 | 401 ms |
| PDF | exports/balanced/pdf.pdf | 43 700 | 1014f7f55ab056a9b5e4e7a7d747f9fe478d55d1863d4b604537f871e7300c3d | 4 243 ms |
| HTML | exports/balanced/html.html | 9 376 | 01d37729ad36e214c85ae000546a0cb6e4a38a2031d34d142346f40a5f6af670 | 4 288 ms |

### Readiness отказ при отсутствующем root и renderer PATH

Readiness implementation в exact HEAD проверяет наличие и возможность записать probe-файл в заданном VK_HACKATHON_ARTIFACT_ROOT; затем ищет исполняемые файлы только в process.env.PATH. Любой false check даёт HTTP 503. Для первого negative container volume не монтировался, а root /app/.data/dep07-no-artifact-volume отсутствовал. Первый запрос сразу после docker run был слишком ранним: curl exit 52 / HTTP 000; после фактического старта authenticated readiness вернул HTTP 503 за 0.195 s, artifactVolume=false, три renderer checks true.

#### Зафиксированная конфигурация missing-root контейнера

`docker inspect dep07-head-3f6cf95-overlay-c2-missing-root-20260927 --format '{{json .}}'` завершился exit 0. Снимок конфигурации: container ID `7fb35fcf8e95ad8d4dda1c9972d243b13889c879b2168538986ba366a1bc2ec6`, состояние `running`; image tag `dep07-head-3f6cf95-overlay-c2-20260927:local`, image ID `sha256:16d8fa416335df1e54e99acb475f4711b44f17da26968d6d998c75e8e8feecea`; entrypoint `docker-entrypoint.sh`, command `npm run start`, working directory `/app/vk-tech-hackathon`; mapping `127.0.0.1:31440 -> 3030/tcp`; `Mounts=[]` и `HostConfig.Binds=null`. Env включал `HOSTNAME=0.0.0.0`, `PORT=3030`, `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `VK_HACKATHON_ARTIFACT_ROOT=/app/.data/dep07-no-artifact-volume`, `VK_HACKATHON_LLM_PROVIDER=deterministic` и отдельные тестовые auth credentials `dep07-c2-local:dep07-c2-only-20260927`.

Историческая строка запуска не была сохранена дословно. Следующий блок воспроизводит её effective Docker-конфигурацию по `docker inspect`; это replay recipe, а не утверждение, что буквальная строка была исходной командой. Он проверяет image ID и использует `--pull=never`, не монтирует volume и не делает сетевого pull. При повторном запуске замените **оба** значения имени и порта: сохранённый контейнер уже занимает `dep07-head-3f6cf95-overlay-c2-missing-root-20260927` и порт `31440`.

```powershell
# Replace both placeholders with a unique container name and a free host port before running.
$containerName = 'REPLACE_WITH_UNIQUE_CONTAINER_NAME'
$hostPort = 'REPLACE_WITH_FREE_HOST_PORT'
$image = 'dep07-head-3f6cf95-overlay-c2-20260927:local'
$expectedImageId = 'sha256:16d8fa416335df1e54e99acb475f4711b44f17da26968d6d998c75e8e8feecea'
$actualImageId = docker.exe image inspect $image --format '{{.Id}}'
$inspectExit = $LASTEXITCODE
if ($inspectExit -ne 0 -or $actualImageId -ne $expectedImageId) {
  throw "Expected local DEP-07 image $expectedImageId; got $actualImageId (exit $inspectExit)."
}

$authUser = 'dep07-c2-local'
$authPassword = 'dep07-c2-only-20260927'
docker.exe run --pull=never -d --name $containerName --platform linux/amd64 --init `
  -p "127.0.0.1:${hostPort}:3030" `
  -e 'HOSTNAME=0.0.0.0' `
  -e 'PORT=3030' `
  -e 'NODE_ENV=production' `
  -e 'NEXT_TELEMETRY_DISABLED=1' `
  -e 'VK_HACKATHON_ARTIFACT_ROOT=/app/.data/dep07-no-artifact-volume' `
  -e 'VK_HACKATHON_LLM_PROVIDER=deterministic' `
  -e "VK_HACKATHON_DEMO_AUTH_USER=$authUser" `
  -e "VK_HACKATHON_DEMO_AUTH_PASSWORD=$authPassword" `
  $image
if ($LASTEXITCODE -ne 0) { throw 'docker run failed; readiness was not requested.' }

# Do not count a request until the actual Next.js Ready startup log appears.
$readySeen = $false
$deadline = (Get-Date).AddMinutes(2)
while ((Get-Date) -lt $deadline) {
  $state = docker.exe inspect --format '{{.State.Status}}' $containerName
  if ($LASTEXITCODE -ne 0 -or $state -ne 'running') {
    docker.exe logs --tail 100 $containerName
    throw "Container did not remain running (state '$state'); readiness was not requested."
  }
  $startupLog = docker.exe logs --tail 100 $containerName 2>&1 | Out-String
  if ($startupLog -match 'Ready in \d+(?:\.\d+)?\s?(?:ms|s)') {
    $readySeen = $true
    break
  }
  Start-Sleep -Seconds 1
}
if (-not $readySeen) {
  docker.exe logs --tail 100 $containerName
  throw 'Next.js Ready was not observed within 2 minutes; readiness was not requested.'
}

$basicAuth = [Convert]::ToBase64String(
  [Text.Encoding]::UTF8.GetBytes($authUser + ':' + $authPassword)
)
$response = @(& curl.exe --silent --show-error `
  -H "Authorization: Basic $basicAuth" `
  -w "`nHTTP:%{http_code} TIME:%{time_total}`n" `
  "http://127.0.0.1:${hostPort}/api/ready")
$curlExit = $LASTEXITCODE
$response
if ($curlExit -ne 0) { throw "curl transport failed with exit $curlExit." }
$expectedJson = '{"ok":false,"checks":{"artifactVolume":false,"rendererBinaries":{"soffice":true,"pdfinfo":true,"pdftoppm":true}}}'
$responseBody = $response | Select-Object -First 1
$responseMetrics = $response | Where-Object { $_ -match '^HTTP:503 TIME:\d+(?:\.\d+)?$' } | Select-Object -First 1
if ($responseBody -cne $expectedJson -or -not $responseMetrics) {
  throw 'Readiness response did not match the expected HTTP 503 body and timing line.'
}
```

Captured startup log from the preserved container: `✓ Ready in 1334ms`. Only after this signal, authenticated `GET http://127.0.0.1:31440/api/ready` completed with `curl` exit `0`, HTTP `503`, duration `0.195 s`, and body `{"ok":false,"checks":{"artifactVolume":false,"rendererBinaries":{"soffice":true,"pdfinfo":true,"pdftoppm":true}}}`. For a replay, expect this JSON and HTTP 503; measured duration may vary. An earlier curl before the Ready signal returned exit `52` / HTTP `000`; that premature attempt is retained as startup evidence and is not the readiness result.

Для renderer negative сначала использован штатный npm CMD с PATH=/usr/local/bin; контейнер завершился exit 254 до старта Next (npm error spawn sh ENOENT), поэтому этот запрос не является readiness evidence. Без изменения image создан отдельный контейнер с PATH=/nonexistent и абсолютными Node/Next entrypoint, dedicated artifact volume и тем же deterministic env. Next стартовал за 2.2 s; authenticated readiness вернул HTTP 503 за 0.215 s, artifactVolume=true, а soffice, pdfinfo, pdftoppm все false. Оба успешных negative результата получены через отдельные localhost ports 31440 и 31442 на этом же immutable image; containers/volumes сохранены, failed npm-path container также оставлен для диагностики.

Использованный renderer-negative запуск отличался PATH и entrypoint; путь Node/Next передавался как аргументы контейнера:

    $good = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('dep07-c2-local:dep07-c2-only-20260927'))
    docker.exe run -d --name dep07-head-3f6cf95-overlay-c2-no-renderers-direct-node-20260927 --platform linux/amd64 --init -p 127.0.0.1:31442:3030 -v dep07-head-3f6cf95-overlay-c2-no-renderers-direct-node-artifacts-20260927:/app/.data/artifacts -e HOSTNAME=0.0.0.0 -e PORT=3030 -e NODE_ENV=production -e NEXT_TELEMETRY_DISABLED=1 -e VK_HACKATHON_ARTIFACT_ROOT=/app/.data/artifacts -e VK_HACKATHON_LLM_PROVIDER=deterministic -e PATH=/nonexistent -e VK_HACKATHON_DEMO_AUTH_USER=dep07-c2-local -e VK_HACKATHON_DEMO_AUTH_PASSWORD=dep07-c2-only-20260927 --entrypoint /usr/local/bin/node dep07-head-3f6cf95-overlay-c2-20260927:local /app/vk-tech-hackathon/node_modules/next/dist/bin/next start -p 3030

    curl.exe -sS -H "Authorization: Basic $good" -w 'HTTP:%{http_code} TIME:%{time_total}' http://127.0.0.1:31442/api/ready

### Restart и persistence

Для job job-cc7b60e6-9049-421f-927e-841eabf81be7 перед restart authenticated GET /api/jobs/{jobId} дал HTTP 200 (79 118 B), ready, три варианта, по пять слайдов, три аудита passed. Команда docker restart dep07-head-3f6cf95-overlay-c2-20260927 завершилась exit 0. После шести health polls /api/health вернул HTTP 200; authenticated /api/ready — HTTP 200 со всеми checks true. docker inspect подтвердил тот же named volume, смонтированный в /app/.data/artifacts.

    $good = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('dep07-c2-local:dep07-c2-only-20260927'))
    docker.exe restart dep07-head-3f6cf95-overlay-c2-20260927
    curl.exe -sS -H "Authorization: Basic $good" http://127.0.0.1:31439/api/jobs/job-cc7b60e6-9049-421f-927e-841eabf81be7
    curl.exe -sS -H "Authorization: Basic $good" -o pptx-after-restart.bin -w 'HTTP:%{http_code} BYTES:%{size_download}' http://127.0.0.1:31439/api/artifacts/job-cc7b60e6-9049-421f-927e-841eabf81be7/exports/balanced/pptx.pptx

После restart тот же job снова получен HTTP 200 (79 118 B), ID и status совпали. Артефакты повторно скачаны с HTTP 200; байты и SHA-256 совпали с чтениями до restart:

| Format | До restart | После restart | Hash совпал |
| --- | --- | --- | --- |
| PPTX | 81 524 B, 05b94e9e01044fba0378b815fee102659f041b875f457d397f227afa32d366a8 | 81 524 B, тот же SHA-256 | да |
| PDF | 43 700 B, 1014f7f55ab056a9b5e4e7a7d747f9fe478d55d1863d4b604537f871e7300c3d | 43 700 B, тот же SHA-256 | да |
| HTML | 9 376 B, 01d37729ad36e214c85ae000546a0cb6e4a38a2031d34d142346f40a5f6af670 | 9 376 B, тот же SHA-256 | да |

### Ограничения и статус

Fresh image acceptance доказывает один held-out синтетический сценарий на localhost и deterministic provider. Первый холодный PDF export на свежем контейнере один раз превысил 60-секундный renderer timeout; повтор после прогрева и полный второй smoke прошли. Это наблюдение явно передаётся независимому reviewer; результат не обобщается на холодный запуск/тяжёлый документ и не заявляется как SLA. Временный overlay не был записан в repo или commit, а образ не является clean-HEAD image: он построен из committed HEAD 3f6cf95... плюс только временный уже принятый Page import для TypeScript gate. Изменялись только claim report и ранее подготовленный smoke test; Docker/roadmap/DEP plan и посторонние dirty файлы не менялись. Visual NO-GO остаётся самостоятельным публичным блокером.
