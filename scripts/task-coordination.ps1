param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('List', 'Claim', 'Mark', 'Extend', 'Accept', 'Cancel')]
  [string]$Action,

  [string]$TaskId,
  [string]$Title,
  [string]$Owner,
  [string]$ClaimId,
  [ValidateSet('in_progress', 'awaiting_acceptance', 'blocked')]
  [string]$Status,
  [string[]]$Files,
  [string]$BaseRef,
  [string]$Reason,
  [string]$EvidenceRef,
  [switch]$IncludeHistory
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $packageRoot
$stateDirectory = Join-Path $packageRoot '.agent-state\task-coordination'
$statePath = Join-Path $stateDirectory 'claims.json'
$mutexName = 'Local\StudyDeckVkHackathonTaskCoordination'
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$mutexTaken = $false

function Get-MoscowTime {
  try {
    $zone = [System.TimeZoneInfo]::FindSystemTimeZoneById('Russian Standard Time')
  } catch {
    $zone = [System.TimeZoneInfo]::FindSystemTimeZoneById('Europe/Moscow')
  }
  return [System.TimeZoneInfo]::ConvertTime([DateTimeOffset]::UtcNow, $zone)
}

function Get-TimeText([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '—' }
  $parsed = [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture)
  return $parsed.ToOffset([TimeSpan]::FromHours(3)).ToString(
    'dd.MM.yyyy HH:mm:ss',
    [Globalization.CultureInfo]::GetCultureInfo('ru-RU')
  )
}

function Read-State {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    return [pscustomobject]@{
      schemaVersion = 1
      updatedAt = $null
      claims = @()
    }
  }

  $json = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8
  $state = $json | ConvertFrom-Json
  if ($state.schemaVersion -ne 1 -or $null -eq $state.claims) {
    throw "Unsupported or invalid task coordination registry: $statePath"
  }
  return $state
}

function Test-PathOverlap([string]$First, [string]$Second) {
  $firstKey = $First.TrimEnd('/')
  $secondKey = $Second.TrimEnd('/')
  return $firstKey.Equals($secondKey, [System.StringComparison]::OrdinalIgnoreCase) -or
    $firstKey.StartsWith($secondKey + '/', [System.StringComparison]::OrdinalIgnoreCase) -or
    $secondKey.StartsWith($firstKey + '/', [System.StringComparison]::OrdinalIgnoreCase)
}

function Write-State($State) {
  [System.IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
  $State.updatedAt = (Get-MoscowTime).ToString('o')
  $temporaryPath = Join-Path $stateDirectory ('.claims-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $json = ConvertTo-Json -InputObject $State -Depth 20
  [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Normalize-FileScopes([string[]]$InputFiles) {
  if ($null -eq $InputFiles -or $InputFiles.Count -eq 0) {
    throw 'Claim and Extend require at least one exact file path in -Files.'
  }

  $normalized = [System.Collections.Generic.List[string]]::new()
  foreach ($inputFile in $InputFiles) {
    $path = ([string]$inputFile).Trim().Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($path)) { throw 'File scopes cannot be empty.' }
    if ($path.StartsWith('/') -or $path -match '^[A-Za-z]:' -or $path -match '[*?]') {
      throw "File scope must be a repository-relative exact path: $inputFile"
    }
    $segments = $path.Split('/')
    if ($path.EndsWith('/') -or $segments -contains '..' -or $segments -contains '.' -or $segments -contains '') {
      throw "File scope must identify one exact file and cannot contain dot segments: $inputFile"
    }

    $allowed = $path.StartsWith('vk-tech-hackathon/', [System.StringComparison]::OrdinalIgnoreCase) -or
      $path.Equals('AGENTS_VK.md', [System.StringComparison]::OrdinalIgnoreCase) -or
      $path.Equals('VK_TECH_HACKATHON_CONTEXT_FOR_CODEX.md', [System.StringComparison]::OrdinalIgnoreCase) -or
      $path.StartsWith('docs/VK_TECH_', [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $allowed) {
      throw "Hackathon task scope must stay in vk-tech-hackathon or its named control documents: $inputFile"
    }

    $absolutePath = Join-Path $repoRoot ($path.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    if (Test-Path -LiteralPath $absolutePath -PathType Container) {
      throw "Directory scopes are not allowed; list exact files instead: $inputFile"
    }

    $key = $path.ToLowerInvariant()
    if (-not $normalized.Contains($key)) { $normalized.Add($key) }
  }

  if ($normalized.Count -eq 0) { throw 'No valid file scopes were supplied.' }
  $sorted = @($normalized | Sort-Object)
  for ($index = 0; $index -lt $sorted.Count; $index++) {
    for ($other = $index + 1; $other -lt $sorted.Count; $other++) {
      if (Test-PathOverlap $sorted[$index] $sorted[$other]) {
        throw "File scopes overlap each other: $($sorted[$index]) and $($sorted[$other])"
      }
    }
  }
  return $sorted
}

function Get-DirtyRepoFiles {
  $gitRoot = & git -c "safe.directory=$($repoRoot.Replace('\', '/'))" -C $repoRoot rev-parse --show-toplevel 2>$null
  $gitRootExitCode = $LASTEXITCODE
  if ($gitRootExitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$gitRoot)) {
    throw "Cannot verify dirty files because Git root was not found: $repoRoot"
  }

  $statusLines = @(& git -c "safe.directory=$($repoRoot.Replace('\', '/'))" -C $repoRoot status --porcelain=v1 --untracked-files=all --ignore-submodules=all 2>$null)
  $statusExitCode = $LASTEXITCODE
  if ($statusExitCode -ne 0) { throw 'Cannot inspect dirty files before creating a task claim.' }

  $dirty = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($line in $statusLines) {
    if ([string]$line -and $line.Length -ge 4) {
      $reportedPath = ([string]$line).Substring(3).TrimEnd("`r", "`n")
      $paths = @($reportedPath)
      if ($reportedPath -match '^(.+) -> (.+)$') { $paths = @($Matches[1], $Matches[2]) }
      foreach ($path in $paths) {
        $normalized = $path.Replace('\', '/').ToLowerInvariant()
        if (-not [string]::IsNullOrWhiteSpace($normalized)) { [void]$dirty.Add($normalized) }
      }
    }
  }
  return ,$dirty
}

function Assert-NoDirtyFiles([string[]]$CandidateFiles) {
  $dirty = Get-DirtyRepoFiles
  $overlap = [System.Collections.Generic.List[string]]::new()
  foreach ($candidate in $CandidateFiles) {
    foreach ($dirtyFile in $dirty) {
      if (Test-PathOverlap $candidate $dirtyFile) { $overlap.Add($candidate); break }
    }
  }
  if ($overlap.Count -gt 0) {
    throw "Pre-existing dirty files cannot be claimed automatically; preserve them and choose another task: $($overlap -join ', ')"
  }
}

function Get-ActiveClaims($State) {
  return @($State.claims | Where-Object { $_.status -in @('in_progress', 'awaiting_acceptance', 'blocked') })
}

function Find-Claim($State, [string]$Id) {
  foreach ($item in @($State.claims)) {
    if ([string]$item.claimId -eq $Id) { return $item }
  }
  return $null
}

function Assert-NoConflicts($State, [string]$CandidateTaskId, [string[]]$CandidateFiles, [string]$ExceptClaimId) {
  foreach ($active in (Get-ActiveClaims $State)) {
    if ($ExceptClaimId -and $active.claimId -eq $ExceptClaimId) { continue }
    if ([string]$active.taskId -ieq $CandidateTaskId) {
      throw "Task $CandidateTaskId is already reserved by claim $($active.claimId) ($($active.status))."
    }
    $overlap = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in $CandidateFiles) {
      foreach ($reservedFile in @($active.files)) {
        if (Test-PathOverlap $candidate $reservedFile) { $overlap.Add($candidate); break }
      }
    }
    if ($overlap.Count -gt 0) {
      throw "File scope conflict with $($active.taskId) / claim $($active.claimId): $($overlap -join ', ')"
    }
  }
}

function Assert-ClaimId {
  if ([string]::IsNullOrWhiteSpace($ClaimId)) { throw "-ClaimId is required for $Action." }
  $found = Find-Claim $script:state $ClaimId
  if ($null -eq $found) { throw "Claim not found: $ClaimId" }
  if ($found.status -notin @('in_progress', 'awaiting_acceptance', 'blocked')) {
    throw "Claim $ClaimId is already closed with status $($found.status)."
  }
  return $found
}

function Show-Claims($State) {
  if ($IncludeHistory) { $items = @($State.claims) } else { $items = Get-ActiveClaims $State }
  if ($items.Count -eq 0) {
    if ($IncludeHistory) { Write-Output 'История броней пуста.' } else { Write-Output 'Активных броней нет.' }
    return
  }

  foreach ($item in ($items | Sort-Object startedAt)) {
    $start = Get-TimeText ([string]$item.startedAt)
    Write-Output ("[{0}] {1} — {2}" -f $item.status.ToUpperInvariant(), $item.taskId, $item.title)
    Write-Output ("  Выполняется с {0} MSK | чат: {1} | claim: {2}" -f $start, $item.owner, $item.claimId)
    Write-Output ("  Файлы: {0}" -f (@($item.files) -join ', '))
    if ($item.status -in @('awaiting_acceptance', 'blocked')) {
      Write-Output ("  Обновлено: {0} MSK" -f (Get-TimeText ([string]$item.updatedAt)))
    }
    if ($item.status -eq 'blocked') { Write-Output ("  Блокер: {0}" -f $item.blocker) }
    if ($item.status -eq 'awaiting_acceptance') { Write-Output '  Ожидает независимой приемки; бронь активна.' }
    if ($IncludeHistory -and $item.status -in @('accepted', 'cancelled')) {
      Write-Output ("  Закрыто: {0} MSK | причина: {1}" -f (Get-TimeText ([string]$item.closedAt)), $item.closeReason)
      if ($item.acceptanceEvidence) { Write-Output ("  Приемка: {0}" -f $item.acceptanceEvidence) }
    }
  }
}

try {
  try {
    $mutexTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(20))
  } catch [System.Threading.AbandonedMutexException] {
    # WaitOne acquires an abandoned named mutex; continue with registry recovery.
    $mutexTaken = $true
  }
  if (-not $mutexTaken) { throw 'Timed out waiting for the shared task coordination mutex.' }

  [System.IO.Directory]::CreateDirectory($stateDirectory) | Out-Null
  $script:state = Read-State

  switch ($Action) {
    'List' {
      Show-Claims $script:state
      if ($IncludeHistory) { Write-Output "Реестр: $statePath" }
    }

    'Claim' {
      if ([string]::IsNullOrWhiteSpace($TaskId)) { throw '-TaskId is required for Claim.' }
      if ([string]::IsNullOrWhiteSpace($Title)) { throw '-Title is required for Claim.' }
      if ([string]::IsNullOrWhiteSpace($Owner)) { throw '-Owner is required for Claim.' }
      $files = Normalize-FileScopes $Files
      Assert-NoDirtyFiles $files
      Assert-NoConflicts $script:state $TaskId $files $null
      if ([string]::IsNullOrWhiteSpace($BaseRef)) {
        $BaseRef = (& git -c "safe.directory=$($repoRoot.Replace('\', '/'))" -C $repoRoot rev-parse --short HEAD 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$BaseRef)) {
          throw 'Cannot resolve current git HEAD for the task claim.'
        }
      }
      $now = (Get-MoscowTime).ToString('o')
      $claim = [pscustomobject]@{
        claimId = [guid]::NewGuid().ToString('D')
        taskId = $TaskId.Trim()
        title = $Title.Trim()
        owner = $Owner.Trim()
        status = 'in_progress'
        startedAt = $now
        updatedAt = $now
        baseRef = $BaseRef.Trim()
        files = @($files)
        blocker = $null
        acceptanceEvidence = $null
        closedAt = $null
        closeReason = $null
      }
      $script:state.claims = @($script:state.claims) + @($claim)
      Write-State $script:state
      Write-Output ("Задача зарезервирована: {0} — {1}" -f $claim.taskId, $claim.title)
      Write-Output ("Выполняется с {0} MSK; claim ID: {1}" -f (Get-TimeText $claim.startedAt), $claim.claimId)
      Write-Output ("Чат: {0}" -f $claim.owner)
      Write-Output ("Файлы: {0}" -f (@($claim.files) -join ', '))
    }

    'Mark' {
      $claim = Assert-ClaimId
      $allowedTransitions = @{
        in_progress = @('in_progress', 'awaiting_acceptance', 'blocked')
        awaiting_acceptance = @('awaiting_acceptance', 'in_progress', 'blocked')
        blocked = @('blocked', 'in_progress')
      }
      if ($Status -notin $allowedTransitions[[string]$claim.status]) {
        throw "Invalid status transition: $($claim.status) -> $Status"
      }
      if ($Status -eq 'blocked' -and [string]::IsNullOrWhiteSpace($Reason)) {
        throw 'Marking a claim blocked requires -Reason.'
      }
      $claim.status = $Status
      $claim.updatedAt = (Get-MoscowTime).ToString('o')
      if ($Status -eq 'blocked') { $claim.blocker = $Reason.Trim() } else { $claim.blocker = $null }
      Write-State $script:state
      Write-Output ("Статус claim {0}: {1}; бронь файлов сохраняется." -f $ClaimId, $Status)
    }

    'Extend' {
      $claim = Assert-ClaimId
      $additionalFiles = Normalize-FileScopes $Files
      $additionalFiles = @($additionalFiles | Where-Object { @($claim.files) -notcontains $_ })
      if ($additionalFiles.Count -eq 0) { throw 'Extend must add at least one new exact file scope.' }
      foreach ($candidate in $additionalFiles) {
        foreach ($reservedFile in @($claim.files)) {
          if (Test-PathOverlap $candidate $reservedFile) {
            throw "New file scope overlaps this claim's existing scope: $candidate and $reservedFile"
          }
        }
      }
      Assert-NoDirtyFiles $additionalFiles
      $combined = @(@($claim.files) + @($additionalFiles) | Sort-Object -Unique)
      Assert-NoConflicts $script:state $claim.taskId $additionalFiles $claim.claimId
      $claim.files = @($combined)
      $claim.updatedAt = (Get-MoscowTime).ToString('o')
      Write-State $script:state
      Write-Output ("Область claim {0} расширена: {1}" -f $ClaimId, (@($additionalFiles) -join ', '))
    }

    'Accept' {
      $claim = Assert-ClaimId
      if ($claim.status -ne 'awaiting_acceptance') {
        throw "Claim must be awaiting_acceptance before it can be accepted; current status is $($claim.status)."
      }
      if ([string]::IsNullOrWhiteSpace($EvidenceRef)) {
        throw 'Accept requires -EvidenceRef with the reviewed executor task link or report reference.'
      }
      $claim.status = 'accepted'
      $claim.updatedAt = (Get-MoscowTime).ToString('o')
      $claim.closedAt = $claim.updatedAt
      $claim.acceptanceEvidence = $EvidenceRef.Trim()
      $claim.closeReason = 'Independent acceptance completed.'
      Write-State $script:state
      Write-Output ("Принята задача {0}; бронь снята: {1}" -f $claim.taskId, $ClaimId)
    }

    'Cancel' {
      $claim = Assert-ClaimId
      if ([string]::IsNullOrWhiteSpace($Reason)) { throw 'Cancel requires an explicit -Reason.' }
      $claim.status = 'cancelled'
      $claim.updatedAt = (Get-MoscowTime).ToString('o')
      $claim.closedAt = $claim.updatedAt
      $claim.closeReason = $Reason.Trim()
      Write-State $script:state
      Write-Output ("Бронь отменена: {0} — {1}" -f $claim.taskId, $Reason.Trim())
    }
  }
} catch {
  [Console]::Error.WriteLine("Task coordination blocked: $($_.Exception.Message)")
  exit 2
} finally {
  if ($mutexTaken) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
