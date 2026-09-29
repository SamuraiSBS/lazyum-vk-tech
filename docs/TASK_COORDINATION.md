# Координация параллельных задач хакатона

Несколько вручную запущенных Codex чатов могут выполнять независимые задачи в
одном checkout. Общий локальный реестр находится в
`.agent-state/task-coordination/claims.json`; каталог `.agent-state/` уже
исключён из Git. Реестр сериализуется именованным Windows mutex, поэтому
одновременные запросы не могут одновременно забронировать один task ID или
один и тот же файл.

## Правила назначения

1. Прочитать текущие инструкции, roadmap/детальный план, код и `git status`.
2. Проверить активные брони командой `-Action List`.
3. Выбрать самую приоритетную незавершённую задачу, которая не заблокирована
   зависимостями и не пересекается по точным файлам с активными бронями.
4. Перед выдачей промпта создать бронь командой `-Action Claim`. Если команда
   сообщает конфликт, выбрать следующий независимый пункт и повторить.
5. В промпт включить claim ID, точный список файлов, критерии и запрет менять
   файлы вне этого списка. Для любого дополнительного файла сначала выполнить
   `-Action Extend`.
6. Оставить бронь активной до независимой приемки или явной отмены пользователя.

File scope состоит из точных путей относительно корня репозитория; каталоги,
маски и glob запрещены. Добавляй и ожидаемые новые файлы. Скрипт автоматически
проверяет tracked и untracked dirty files и откажет в брони, если область уже
затронута незакоммиченными изменениями. Такие файлы нельзя назначать; если все
подходящие области затронуты, сообщи пользователю и дождись его решения.
Скрипт сравнивает пути без учета регистра и допускает только `vk-tech-hackathon/**`,
`AGENTS_VK.md`, `VK_TECH_HACKATHON_CONTEXT_FOR_CODEX.md` и `docs/VK_TECH_*`.
Это сохраняет изоляцию от основного приложения Lazyum.

## Команды

Выполняй из `D:\presentation\vk-tech-hackathon`.

Посмотреть активные брони:

```powershell
.\scripts\task-coordination.ps1 -Action List
```

Посмотреть историю:

```powershell
.\scripts\task-coordination.ps1 -Action List -IncludeHistory
```

Создать бронь перед выдачей исполнительского промпта:

```powershell
.\scripts\task-coordination.ps1 -Action Claim `
  -TaskId 'ID-from-the-plan' `
  -Title 'Short task title' `
  -Owner 'Codex chat title or task ID' `
  -BaseRef 'short-git-head' `
  -Files @(
    'vk-tech-hackathon/path/from-plan/file.ts',
    'vk-tech-hackathon/path/from-plan/new-file.ts'
  )
```

`-BaseRef` можно опустить: скрипт сам запишет текущий short HEAD.

После реализации, до отправки отчета на приемку:

```powershell
.\scripts\task-coordination.ps1 -Action Mark -ClaimId '<claim-id>' -Status awaiting_acceptance
```

Если задача заблокирована, бронь и все файлы остаются занятыми:

```powershell
.\scripts\task-coordination.ps1 -Action Mark -ClaimId '<claim-id>' -Status blocked -Reason 'Точный блокер'
```

После снятия блокера:

```powershell
.\scripts\task-coordination.ps1 -Action Mark -ClaimId '<claim-id>' -Status in_progress
```

Добавить файл до его изменения (операция атомарно проверит конфликты):

```powershell
.\scripts\task-coordination.ps1 -Action Extend -ClaimId '<claim-id>' -Files @('vk-tech-hackathon/src/lib/new-file.ts')
```

После независимой проверки и решения **Accepted** снять бронь:

```powershell
.\scripts\task-coordination.ps1 -Action Accept -ClaimId '<claim-id>' -EvidenceRef '<executor deep link or reviewed report reference>'
```

Общий roadmap обновляет один назначенный navigation/acceptance chat после
приемки, последовательно по одному отчету. Не включай roadmap в executor file
scope и не редактируй его из параллельных чатов. Это позволяет обновлять его
дальше, даже когда предыдущие принятые изменения остаются незакоммиченными.

Снять бронь можно также после явной команды пользователя:

```powershell
.\scripts\task-coordination.ps1 -Action Cancel -ClaimId '<claim-id>' -Reason 'Явная отмена пользователя'
```

Переход в `awaiting_acceptance` или `blocked` бронь не снимает. Автоматического
срока истечения нет. Для повторной попытки после отклоненной приемки верни тот
же claim в `in_progress`; не создавай новую бронь и не освобождай старую.

## Обязательный фрагмент исполнительского промпта

Включай в готовый prompt данные конкретной брони и эти правила:

```text
Твоя задача зарезервирована под claim ID: <claim-id>.
Перед правками проверь, что зарезервированные файлы не изменились после выдачи.
Если появились чужие изменения, ничего не перезаписывай; отметь claim как blocked
с причиной и сообщи мне.
Меняй только перечисленные точные файлы. Если нужен дополнительный файл,
сначала запроси его через Action Extend; при конфликте остановись.
Когда реализация и локальная проверка закончены, выполни:
  .\scripts\task-coordination.ps1 -Action Mark -ClaimId '<claim-id>' -Status awaiting_acceptance
Не принимай и не отменяй бронь самостоятельно. При блокере используй Action Mark
со статусом blocked; при доработке после отклонения верни тот же claim в in_progress.
```

## Статусы

| Статус | Назначение | Удерживает бронь |
| --- | --- | --- |
| `in_progress` | Исполнитель делает задачу | Да |
| `awaiting_acceptance` | Исполнитель закончил, нужен независимый reviewer | Да |
| `blocked` | Работа остановлена на внешнем/техническом блокере | Да |
| `accepted` | Reviewer подтвердил критерии | Нет |
| `cancelled` | Пользователь явно отменил бронь | Нет |

Реестр — локальное состояние одного checkout, не коммить его. Скрипт
координирует брони, но не заменяет анализ зависимостей, проверку Git,
reviewer или защиту от нарушения allowlist исполнителем. Если подходящих свободных задач нет, Codex перечисляет
активные брони и зависимости и не выдает пересекающийся пункт.
