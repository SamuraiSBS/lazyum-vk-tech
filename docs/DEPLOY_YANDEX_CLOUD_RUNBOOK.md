# DEP-08 — runbook Yandex Cloud и секретов

Дата подготовки: 2026-09-28. Статус: локальная спецификация. Cloud-ресурсы не создавались и API inventory не проверялся. Этот документ не подтверждает доступы, не утверждает бюджет и не разрешает staging deploy.

## Решения, требующие владельца

В проверенном checkout команда yc отсутствует в PATH. DEP-01 также зафиксировал, что Cloud API inventory, credentials и .env.local не проверялись. Реальные Cloud ID, folder, billing account и resource IDs неизвестны; значения не выдумываются.

| Поле | Статус | Что требуется решить или проверить |
|---|---|---|
| Cloud ID, folder ID и владелец | NEEDS_USER_DECISION | Получить read-only inventory и указать целевой folder. Не использовать production Lazyum folder без отдельного решения. |
| Billing account, месячный лимит, owner | NEEDS_USER_DECISION | Подтвердить доступ к биллингу, лимит регулярных и разовых расходов, уведомления и способ остановить ресурсы. |
| Зона и доступность платформы | NEEDS_USER_DECISION | Выбрать после проверки квот, образа и тарифа. Не подставлять ru-central1-a автоматически. |
| VM CPU/RAM и диски | NEEDS_USER_DECISION | DEP-07 измерил один тёплый synthetic flow за 57 105 ms; CPU/RAM, cold start, большой входной PPTX и параллельность не бенчмаркировались. Размер не утверждён. |
| VPC/subnet CIDR и SSH source CIDR | NEEDS_USER_DECISION | Проверить пересечения с существующими сетями. SSH разрешить только с согласованного admin IPv4 /32 либо выбрать другой управляемый путь. |
| FQDN, владелец домена и DNS | NEEDS_USER_DECISION | Нужен отдельный staging hostname и доступ к его DNS. |
| Registry и image scanning | NEEDS_USER_DECISION | Подтвердить создание registry и политику scanning, который тарифицируется. Разделить push и runtime identities. |
| Lockbox secret owner и runtime loader | NEEDS_USER_DECISION | Секрет хранить в Lockbox; DEP-10 должен реализовать доставку без вывода значения в логи и без записи в Git. |
| Backup destination, периодичность и retention | NEEDS_USER_DECISION | Выбрать период, срок, отдельный destination и бюджет. DEP-06 запрещает destructive retention до решения владельца. |
| Yandex AI Studio | Отключено | Сначала подтвердить модель и policy организаторами, budget cap и разрешение на платные вызовы. |

## Целевая схема первого staging

Только изолированный пакет vk-tech-hackathon: одна Linux VM, container runtime и один экземпляр Next.js. HTTPS reverse proxy принимает 80/443 и проксирует на loopback приложения 3030. Внешний порт 3030 закрыт. Отдельный persistent disk монтируется в VM и контейнер как /app/.data/artifacts. VM использует static public IPv4; SSH закрыт от Интернета. Не подключать root docker-compose, production Lazyum, его домен или deploy scripts.

| Ресурс | Предлагаемое имя/роль | Параметр |
|---|---|---|
| VPC/subnet | vk-hackathon-staging-vpc / vk-hackathon-staging-subnet | CIDR только после проверки inventory |
| Security Group | vk-hackathon-staging-sg | Ingress TCP 80/443; TCP 22 только с admin /32; egress DNS и HTTP/HTTPS |
| Static IP | vk-hackathon-staging-ip | Привязан к running VM; неиспользуемый reserved IP продолжает тарифицироваться |
| Runtime service account | vk-hackathon-runtime | Pull нужного image и чтение конкретного Lockbox secret; без статического ключа VM |
| Container Registry | vk-hackathon-staging | Приватный; tag с source SHA и записанный digest; не использовать latest |
| Artifact disk | vk-hackathon-artifacts | Отдельный network disk, auto-delete=false; тип и размер после оценки данных/retention |
| Lockbox secret | vk-hackathon-staging-runtime | Demo auth user/password; начальный provider deterministic, AI key не нужен |

Роли runtime identity: container-registry.images.puller только на нужный registry/repository и lockbox.payloadViewer только на нужный secret. Для CI push нужен отдельный deploy service account с container-registry.images.pusher на целевой registry/repository. Не использовать одну широкую identity для VM и CI. Подключённая к VM identity получает IAM token через metadata service; до DEP-10 проверить, что Lockbox loader использует именно её, а не ключ service account.

Первой конфигурации нужны VK_HACKATHON_DEMO_AUTH_USER и VK_HACKATHON_DEMO_AUTH_PASSWORD; это новые deployment secrets, не локальные тестовые credentials. Хранить значения только в Lockbox, не в документе, Git, Docker build args, image layers или NEXT_PUBLIC_* переменных. Если AI Studio отдельно разрешат, ключ и все аттестационные параметры добавляются после проверки MODELS.md и требований организаторов. Текущая provider-конфигурация fail-closed; deterministic evidence не доказывает live acceptance.

## Подготовка и read-only inventory

Сначала получить одобренный read-only доступ. Команды ниже предназначены для будущей инвентаризации и не запускались в DEP-08. Не использовать yc config list, не запрашивать токены, не читать .env-файлы или payload секретов.

~~~~bash
yc config get cloud-id
yc config get folder-id

yc compute instance list --folder-id "$FOLDER_ID"
yc compute disk list --folder-id "$FOLDER_ID"
yc vpc network list --folder-id "$FOLDER_ID"
yc vpc subnet list --folder-id "$FOLDER_ID"
yc vpc address list --folder-id "$FOLDER_ID"
yc container registry list --folder-id "$FOLDER_ID"
yc lockbox secret list --folder-id "$FOLDER_ID"
yc compute zone list
~~~~

Сверить resource IDs, attached disks, subnet CIDRs, адреса, владельца и расход с владельцем Cloud/billing. Записывать только IDs/metadata и безопасные результаты. Не полученный inventory означает «неизвестно», а не отсутствие ресурсов.

До apply заполнить placeholders, проверить zone/image/platform/квоты и посчитать тариф в калькуляторе Yandex Cloud. Команды может выполнять только согласованный operator после отдельного разрешения на ресурсы и подтверждения бюджета. Здесь их не запускали.

## Шаблоны команд создания

Примеры для Bash. Значения в угловых скобках — placeholders; команды нельзя запускать до их замены и согласования расходов. Не вставлять секреты в shell command line.

### 1. Контекст и параметры

~~~~bash
export CLOUD_ID='<approved-cloud-id>'
export FOLDER_ID='<approved-folder-id>'
export ZONE='<approved-available-zone>'
export NETWORK_NAME='vk-hackathon-staging-vpc'
export SUBNET_NAME='vk-hackathon-staging-subnet'
export SUBNET_CIDR='<approved-non-overlapping-cidr>'
export SG_NAME='vk-hackathon-staging-sg'
export ADMIN_CIDR='<approved-admin-ipv4>/32'
export ADDRESS_NAME='vk-hackathon-staging-ip'
export REGISTRY_NAME='vk-hackathon-staging'
export VM_NAME='vk-hackathon-staging-vm'
export VM_SA_NAME='vk-hackathon-runtime'
export SECRET_NAME='vk-hackathon-staging-runtime'
export IMAGE_ID='<verified-linux-image-id>'
export PLATFORM='<available-compute-platform>'
export VM_CORES='<benchmarked-core-count>'
export VM_RAM_GB='<benchmarked-ram-gb>'
export BOOT_DISK_GB='<sized-boot-disk-gb>'
export ARTIFACT_DISK_GB='<sized-artifact-disk-gb>'
export SSH_PUBLIC_KEY_PATH='<operator-public-key-file>'
export NETWORK_ID='<id-returned-by-network-create>'
export SUBNET_ID='<id-returned-by-subnet-create>'
export SG_ID='<id-returned-by-security-group-create>'
export STATIC_IPV4='<ip-returned-by-address-create>'
export REGISTRY_ID='<id-returned-by-registry-create>'
export VM_SA_ID='<id-returned-by-service-account-create>'
export SECRET_ID='<id-returned-by-lockbox-create>'
~~~~

Не менять глобальный cloud/folder профиль оператора. В каждой resource-команде явно задавать --cloud-id и --folder-id. После каждой команды проверять назначение и список ресурсов.

### 2. VPC, subnet, правила и static IP

~~~~bash
yc vpc network create \
  --name "$NETWORK_NAME" \
  --description "Isolated VK hackathon staging" \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"

yc vpc subnet create \
  --name "$SUBNET_NAME" \
  --zone "$ZONE" \
  --network-name "$NETWORK_NAME" \
  --range "$SUBNET_CIDR" \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"

yc vpc security-group create \
  --name "$SG_NAME" \
  --description "VK hackathon staging ingress and restricted SSH" \
  --network-id "$NETWORK_ID" \
  --rule "description=HTTP challenge and redirect,direction=ingress,port=80,protocol=tcp,v4-cidrs=[0.0.0.0/0]" \
  --rule "description=HTTPS staging,direction=ingress,port=443,protocol=tcp,v4-cidrs=[0.0.0.0/0]" \
  --rule "description=SSH from approved admin CIDR,direction=ingress,port=22,protocol=tcp,v4-cidrs=[$ADMIN_CIDR]" \
  --rule "description=DNS UDP egress,direction=egress,port=53,protocol=udp,v4-cidrs=[0.0.0.0/0]" \
  --rule "description=DNS TCP egress,direction=egress,port=53,protocol=tcp,v4-cidrs=[0.0.0.0/0]" \
  --rule "description=HTTP egress for OS mirrors,direction=egress,port=80,protocol=tcp,v4-cidrs=[0.0.0.0/0]" \
  --rule "description=HTTPS egress for registry and APIs,direction=egress,port=443,protocol=tcp,v4-cidrs=[0.0.0.0/0]" \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"

yc vpc address create \
  --name "$ADDRESS_NAME" \
  --external-ipv4 "zone=$ZONE" \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"
~~~~

Правила IPv4 не открывают 3030. IPv6 требует отдельного решения и CIDR-правил. Egress следует сузить, если это не мешает обновлениям, registry pulls, Lockbox, TLS и выбранному provider. Не разрешать SSH с 0.0.0.0/0.

### 3. Приватный Registry и runtime identity

~~~~bash
yc container registry create \
  --name "$REGISTRY_NAME" \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"

yc iam service-account create \
  --name "$VM_SA_NAME" \
  --folder-id "$FOLDER_ID" \
  --cloud-id "$CLOUD_ID"

yc container registry add-access-binding "$REGISTRY_ID" \
  --service-account-id "$VM_SA_ID" \
  --role container-registry.images.puller \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"
~~~~

Не добавлять --secure автоматически: image vulnerability scans тарифицируются. Если policy требует scanning, принять решение и учесть стоимость. CI push должен использовать отдельный service account и точечную роль container-registry.images.pusher; приватный ключ не хранить на VM.

### 4. Lockbox secret

~~~~bash
yc lockbox secret create \
  --name "$SECRET_NAME" \
  --description "Runtime demo authentication for VK hackathon staging" \
  --deletion-protection \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"

yc lockbox secret add-access-binding \
  --id "$SECRET_ID" \
  --service-account-id "$VM_SA_ID" \
  --role lockbox.payloadViewer \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"
~~~~

Первую версию с ключами VK_HACKATHON_DEMO_AUTH_USER и VK_HACKATHON_DEMO_AUTH_PASSWORD добавить через согласованный защищённый Lockbox UI/operator flow. Не вводить значения как CLI arguments, shell history, CI logs или этот файл. Runtime loader — отдельная часть DEP-10: получить значения с VM identity, использовать временное защищённое runtime-представление, не логировать payload и проверить доступ только сервиса и администратора. Не запускать приложение до проверки loader.

### 5. VM и persistent artifact disk

~~~~bash
yc compute instance create "$VM_NAME" \
  --zone "$ZONE" \
  --platform "$PLATFORM" \
  --cores "$VM_CORES" \
  --memory "$VM_RAM_GB"G \
  --core-fraction 100 \
  --create-boot-disk "name=vk-hackathon-staging-boot,type=network-ssd,size=$BOOT_DISK_GB,image-id=$IMAGE_ID" \
  --create-disk "name=vk-hackathon-artifacts,type=network-ssd,size=$ARTIFACT_DISK_GB,device-name=artifacts,auto-delete=false" \
  --network-interface "subnet-id=$SUBNET_ID,nat-ip-version=ipv4,nat-address=$STATIC_IPV4,security-group-ids=$SG_ID" \
  --service-account-id "$VM_SA_ID" \
  --ssh-key "$SSH_PUBLIC_KEY_PATH" \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"
~~~~

После создания записать instance ID, IP, disk IDs и exact image reference в DEPLOY_STAGING_RELEASE.md. Форматировать и монтировать data disk только после сверки disk ID; настроить mount по UUID и проверить после reboot. В контейнер пробрасывать только artifact path. Приложение держать за proxy на 127.0.0.1:3030. До DNS/TLS и внешнего теста demo auth должен быть включён.

## Домен, HTTPS и образ

Staging FQDN неизвестен. После согласования проверить доступ к DNS-зоне, создать A-запись на static IPv4 и проверить resolution снаружи. Выбрать сертификат через автоматический ACME на reverse proxy с корректным FQDN и открытыми 80/443 либо через оформленный Certificate Manager flow. На proxy направить HTTPS на loopback app port; HTTP оставить для redirect и ACME challenge.

Публикация образа относится к DEP-09/DEP-10. Собирать из принятых исходников; tag связывает образ с source SHA, после push записать digest и развернуть именно digest. Не менять production Lazyum pipeline. Registry storage и scans учитывать в бюджете. VM получает только pull; push получает отдельная CI/deploy identity.

## Artifact disk, backup и восстановление

App сохраняет входные PPTX и результаты генерации; artifact disk — приватные пользовательские данные. Использовать отдельный persistent disk, не writable layer контейнера. Backup держать вне единственного диска приложения; snapshot в том же Cloud не заменяет независимую копию и проверенный restore. Retention jobs, частота snapshot и доступ к копиям требуют решения владельца.

После согласования backup окна остановить все процессы, пишущие в artifact root, создать snapshot и дождаться READY:

~~~~bash
yc compute snapshot create \
  --name '<unique-vk-hackathon-artifacts-snapshot>' \
  --description "Quiesced VK hackathon artifact disk backup" \
  --disk-id '<approved-artifact-disk-id>' \
  --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"

yc compute snapshot list --folder-id "$FOLDER_ID"
yc compute snapshot get '<snapshot-id>' --format json
~~~~

Проверить READY и записать snapshot ID, размер, дату и destination. Для restore создать новый disk из одобренного snapshot, остановить writers, подключить новый disk, восстановить mount ownership и проверить readiness, reopen известного job и SHA-256 export. Не менять или удалять исходный disk, пока restore не подтверждён. Schedule, retention и внешняя копия не настроены; они требуют budget approval. DEP-06 описывает quiesce/reopen и запрет destructive retention до решения владельца.

## Предварительная оценка расходов

Снимок тарифов региона Россия, страницы просмотрены 2026-09-28. Рубли указаны с НДС. Это сценарий для оценки, а не выбранный размер VM или оферта; тарифы различаются по регионам.

Предварительный subtotal за условные 720 часов:

| Статья | Иллюстративная база | Расчёт | RUB / 30 дней |
|---|---|---:|---:|
| VM compute | 2 × 100% vCPU, 8 GB RAM, Linux; ставки 1,24 RUB/vCPU-hour и 0,33 RUB/GB-hour | 720 × (2 × 1,24 + 8 × 0,33) | 3 686,40 |
| Активный static IPv4 | Один адрес на running VM, 0,26352 RUB/hour | 720 × 0,26352 | 189,73 |
| Lockbox | Одна версия, 0,0274 RUB/version-hour; get отдельно — 3,79 RUB за 10 000 | 720 × 0,0274 | 19,73 |
| Известная часть subtotal | Сценарные строки выше | 3 686,40 + 189,73 + 19,73 | 3 895,86 |

Это не полный ожидаемый счёт. Не включены boot/artifact disks, OS/license configuration, snapshot/backup retention, Registry storage, image scans, egress сверх бесплатной квоты, домен/DNS/certificate services и AI Studio. Первые 100 GB исходящего Интернета за календарный месяц не тарифицируются по опубликованным правилам Compute/VPC; диск, регион и billing agreement пересчитать калькулятором до выбора бюджета. VM billing останавливается при полной остановке VM, но disks и snapshots продолжают тарифицироваться. Для inactive reserved static IPv4 опубликована ставка 0,6039 RUB/hour, или 434,81 RUB за условные 720 часов. Удалить адрес после остановки проекта, если он больше не нужен.

Официальный пример snapshot: 20 GB × 1 440 часов × 0,0051 RUB/GB-hour = 146,88 RUB за 60 дней; условный 30-дневный эквивалент — 73,44 RUB. Фактическая сумма зависит от хранимого объёма и актуального тарифа. Container Registry считает занятый image storage, egress и scans; повторно используемый слой не тарифицируется повторно. Перед ресурсным изменением открыть калькулятор снова и записать расчёт дисков и Registry.

## Безопасное отключение и rollback

Rollback релиза: остановить новые запросы на proxy, вернуть прежний immutable image digest, запустить приложение на прежнем volume, проверить /api/health, authenticated /api/ready и reopen прежнего ready job/export. DEP-07 подтверждает один локальный deterministic synthetic flow и ограниченную local volume проверку; cloud restore и внешний staging не подтверждены.

Rollback инфраструктуры при ошибке bootstrap: остановить VM и app; сохранить и проверить artifact disk/snapshot; убедиться, что нужные данные не остались только на VM; затем удалить VM. Persistent disk с auto-delete=false оставить до проверенного архивирования. Если static IP не нужен, удалить его отдельно: остановка VM не прекращает оплату reserved IP. Пустые network/subnet/security group удалять после проверки зависимостей; Lockbox secret с deletion protection и backup сохранять до отдельного решения.

~~~~bash
yc compute instance stop '<instance-id>' --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"
# Только после backup review и решения владельца:
yc compute instance delete '<instance-id>' --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"
# Удалить IP только после подтверждения, что он не нужен:
yc vpc address delete '<address-id>' --cloud-id "$CLOUD_ID" --folder-id "$FOLDER_ID"
~~~~

Не запускать delete автоматически при ошибке smoke test. Сначала сохранить IDs и logs, проверить backup, посчитать продолжающие тарифицироваться ресурсы и получить решение владельца. Не удалять artifact disk/snapshot до подтверждения restore или отдельной копии.

## Acceptance для DEP-09 / DEP-10

До создания ресурсов зафиксировать cloud/folder/billing owner, месячный бюджет, zone, image/platform, измеренный размер VM/disks, свободный CIDR, admin SSH CIDR, hostname/DNS owner, runtime/CI identities и backup/retention choice. Неизвестные поля сменить по фактической проверке или оставить NEEDS_USER_DECISION.

После отдельного разрешения и создания ресурсов следующий отчёт фиксирует resource IDs, OS/image/package pins, registry URL, immutable source SHA/image digest, Lockbox secret ID и точечные роли без значений, DNS/TLS, calculator export, artifact mount, snapshot ID, rollback digest, authenticated health/readiness и restore/reopen evidence. DEP-08 ничего не создавал и не утверждает публичный GO; Visual NO-GO из общего roadmap остаётся блокером публичного запуска.

## Официальные источники Yandex Cloud

Тарифы и CLI syntax перепроверять перед каждым resource change.

- [Тарифы Compute Cloud](https://yandex.cloud/ru/docs/compute/pricing) — VM, disks, snapshots, egress и региональные ставки.
- [Тарифы Virtual Private Cloud](https://yandex.cloud/ru/docs/vpc/pricing) — static IP, security groups, NAT и egress.
- [Тарифы Lockbox](https://yandex.cloud/ru/docs/lockbox/pricing) — версии и операции get.
- [Тарифы Container Registry](https://yandex.cloud/ru/docs/container-registry/pricing) и [создание registry](https://yandex.cloud/ru/docs/container-registry/operations/registry/registry-create) — storage, egress, scan charge.
- [Создать VPC](https://yandex.cloud/ru/docs/vpc/operations/network-create), [subnet CLI](https://yandex.cloud/en/docs/cli/cli-ref/vpc/cli-ref/subnet/create), [Security Group](https://yandex.cloud/ru/docs/vpc/operations/security-group-create), [правила SG](https://yandex.cloud/ru/docs/vpc/operations/security-group-add-rule), [static IP CLI](https://yandex.cloud/en/docs/cli/cli-ref/vpc/cli-ref/address/create).
- [Создать VM CLI](https://yandex.cloud/en/docs/cli/cli-ref/compute/cli-ref/instance/create), [создать service account](https://yandex.cloud/en/docs/iam/operations/sa/create), [использование IAM](https://yandex.cloud/en/docs/iam/best-practices/using-iam-securely).
- [Создать Lockbox secret](https://yandex.cloud/en/docs/lockbox/operations/secret-create), [выдать доступ к secret](https://yandex.cloud/en/docs/lockbox/operations/secret-access), [VM с доступом к Lockbox](https://yandex.cloud/ru/docs/compute/operations/vm-create/create-with-lockbox-secret).
- [Роли Container Registry](https://yandex.cloud/en/docs/container-registry/security/), [назначить роль registry](https://yandex.cloud/en/docs/container-registry/operations/roles/grant).
- [Создать snapshot](https://yandex.cloud/ru/docs/compute/operations/disk-control/create-snapshot).
- [Калькулятор Yandex Cloud](https://yandex.cloud/ru/prices).

## Локальные основания и ограничения

- [DEPLOY_READINESS.md](DEPLOY_READINESS.md): DEP-01 не подтвердил доступность Cloud/account/resources; yc отсутствовал в PATH; credentials и .env.local не читались.
- [DEPLOY_LOCAL_ACCEPTANCE.md](DEPLOY_LOCAL_ACCEPTANCE.md): DEP-07 зафиксировал 57 105 ms одного тёплого synthetic flow и ограниченную local volume проверку; это не sizing benchmark и не cloud restore acceptance.
- [MODELS.md](MODELS.md): deterministic не требует ключа; Yandex AI Studio fail-closed с явной моделью и policy. Требования организаторов проверить до первого платного вызова.
- [DEPLOY_DATA_OPERATIONS.md](DEPLOY_DATA_OPERATIONS.md): private artifacts, quiesce writers перед backup/cleanup, readiness и job/export reopen после restore; production TTL требует решения владельца.
- План деплоя: [DEPLOY_YANDEX_CLOUD_PLAN.md](DEPLOY_YANDEX_CLOUD_PLAN.md) задаёт одну VM с HTTPS proxy, отдельный persistent volume, параметры Cloud/secrets/backup/budget и rollback.