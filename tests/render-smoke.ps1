$ErrorActionPreference = "Stop"

$organizerDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\fixtures\templates\organizer"))
$fixturePaths = @(Get-ChildItem -LiteralPath $organizerDir -Filter "*.pptx" -File | Sort-Object Name | ForEach-Object FullName)
if ($fixturePaths.Count -ne 3) {
  throw "Expected exactly three organizer PPTX fixtures in $organizerDir, found $($fixturePaths.Count)"
}

$jobTimeoutMs = if ($env:VK_HACKATHON_RENDER_TIMEOUT_MS) { [int]$env:VK_HACKATHON_RENDER_TIMEOUT_MS } else { 300000 }
$processTimeoutMs = 60000
if ($jobTimeoutMs -lt 60000 -or $jobTimeoutMs -gt 900000) {
  throw "VK_HACKATHON_RENDER_TIMEOUT_MS must be between 60000 and 900000"
}

$programFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
$programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
if (-not $programFilesX86) { $programFilesX86 = "C:\Program Files (x86)" }
$rendererCandidates = @(
  (Join-Path $programFiles "LibreOffice\program\soffice.com"),
  (Join-Path $programFilesX86 "LibreOffice\program\soffice.com"),
  (Join-Path $programFiles "LibreOffice\program\soffice.exe"),
  (Join-Path $programFilesX86 "LibreOffice\program\soffice.exe")
)
$rendererPath = $rendererCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $rendererPath) {
  $rendererCommand = Get-Command soffice.com -ErrorAction SilentlyContinue
  if (-not $rendererCommand) { $rendererCommand = Get-Command soffice.exe -ErrorAction SilentlyContinue }
  $rendererPath = if ($rendererCommand) { $rendererCommand.Source } else { $null }
}
if (-not $rendererPath) {
  throw "RENDER_SMOKE_STOP: LibreOffice soffice was not found. No PPTX renderer is available."
}

$rasterizerCommand = Get-Command pdftoppm.exe -ErrorAction SilentlyContinue
if (-not $rasterizerCommand) {
  throw "RENDER_SMOKE_STOP: Poppler pdftoppm was not found. LibreOffice PDF conversion cannot be rasterized to the required PNG."
}
$rasterizerPath = $rasterizerCommand.Source
$pdfInfoCommand = Get-Command pdfinfo.exe -ErrorAction SilentlyContinue
if (-not $pdfInfoCommand) {
  throw "RENDER_SMOKE_STOP: Poppler pdfinfo was not found. Rendered PDF page count cannot be determined."
}
$pdfInfoPath = $pdfInfoCommand.Source

$artifactRoot = Join-Path ([IO.Path]::GetTempPath()) ("vk-tech-hackathon-render-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

function Invoke-BoundedTool([string]$path, [string[]]$arguments, [string]$label, [int]$limitMs, [string]$logStem) {
  $stdoutPath = Join-Path $artifactRoot ($logStem + ".stdout.log")
  $stderrPath = Join-Path $artifactRoot ($logStem + ".stderr.log")
  $process = $null
  try {
    $quotedArguments = @($arguments | ForEach-Object {
      $argument = [string]$_
      if ($argument -match '[\s"]') { '"' + $argument.Replace('"', '\"') + '"' } else { $argument }
    })
    $process = Start-Process -FilePath $path -ArgumentList ($quotedArguments -join " ") -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    if (-not $process.WaitForExit($limitMs)) {
      & taskkill.exe /PID $process.Id /T /F | Out-Null
      throw "$label exceeded the $limitMs ms timeout"
    }
    $process.Refresh()
    $exitCode = if ($null -eq $process.ExitCode) { 0 } else { [int]$process.ExitCode }
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
    if ($exitCode -ne 0) {
      $stderrText = if ($null -eq $stderr) { "" } else { ([string]$stderr).Trim() }
      $stdoutText = if ($null -eq $stdout) { "" } else { ([string]$stdout).Trim() }
      throw "$label failed with exit code $($exitCode): $stderrText $stdoutText"
    }
    return [pscustomobject]@{ stdout = $stdout; stderr = $stderr; exitCode = $exitCode }
  } catch {
    throw $_.Exception.Message
  } finally {
    if ($process) { $process.Dispose() }
  }
}

function Get-FileSha256([string]$path) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash([IO.File]::ReadAllBytes($path))
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha256.Dispose()
  }
}

function Invoke-RenderRun([string]$fixturePath, [string]$runRoot, [int]$runNumber, [string]$logPrefix) {
  $profilePath = Join-Path $runRoot "profile"
  $outputPath = Join-Path $runRoot "slide-1.png"
  New-Item -ItemType Directory -Path $runRoot,$profilePath -Force | Out-Null
  $profileUri = ([Uri]$profilePath).AbsoluteUri
  $pdfName = [IO.Path]::GetFileNameWithoutExtension($fixturePath) + ".pdf"
  $pdfPath = Join-Path $runRoot $pdfName
  $outputPrefix = Join-Path $runRoot "slide-1"

  $watch = [Diagnostics.Stopwatch]::StartNew()
  [void](Invoke-BoundedTool $rendererPath @(
    "-env:UserInstallation=$profileUri",
    "--headless",
    "--convert-to",
    "pdf:impress_pdf_Export",
    "--outdir",
    $runRoot,
    $fixturePath
  ) "LibreOffice PPTX conversion (run $runNumber)" $processTimeoutMs ($logPrefix + "-soffice"))
  if (-not (Test-Path -LiteralPath $pdfPath -PathType Leaf)) {
    throw "LibreOffice reported success but did not create the PDF: $pdfPath"
  }
  $pdfFile = Get-Item -LiteralPath $pdfPath
  if ($pdfFile.Length -le 0) { throw "LibreOffice created an empty PDF: $pdfPath" }

  $pdfInfo = Invoke-BoundedTool $pdfInfoPath @($pdfPath) "Poppler pdfinfo (run $runNumber)" $processTimeoutMs ($logPrefix + "-pdfinfo")
  $pageMatch = [regex]::Match($pdfInfo.stdout, "(?m)^Pages:\s+(\d+)\s*$")
  if (-not $pageMatch.Success) { throw "Poppler pdfinfo did not report a page count for $pdfPath" }
  $slideCount = [int]$pageMatch.Groups[1].Value
  if ($slideCount -le 0) { throw "Rendered PDF has an invalid page count: $slideCount" }

  [void](Invoke-BoundedTool $rasterizerPath @(
    "-png",
    "-f", "1",
    "-l", "1",
    "-singlefile",
    "-scale-to-x", "900",
    "-scale-to-y", "1600",
    $pdfPath,
    $outputPrefix
  ) "Poppler PNG rasterization (run $runNumber)" $processTimeoutMs ($logPrefix + "-pdftoppm"))
  if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
    throw "Poppler reported success but did not create the PNG: $outputPath"
  }
  $pngFile = Get-Item -LiteralPath $outputPath
  if ($pngFile.Length -le 0) { throw "Poppler created an empty PNG: $outputPath" }
  $watch.Stop()
  if ($watch.ElapsedMilliseconds -gt $jobTimeoutMs) {
    throw "Render run $runNumber exceeded the total $jobTimeoutMs ms timeout"
  }

  return [pscustomobject]@{
    pdfPath = $pdfPath
    pdfBytes = [int64]$pdfFile.Length
    pdfSha256 = Get-FileSha256 $pdfPath
    outputPath = $outputPath
    outputBytes = [int64]$pngFile.Length
    outputSha256 = Get-FileSha256 $outputPath
    slideCount = $slideCount
    elapsedMs = [int64]$watch.ElapsedMilliseconds
  }
}

try {
  $versionResult = Invoke-BoundedTool $rendererPath @("--headless", "--version") "LibreOffice version check" $processTimeoutMs "soffice-version"
  $versionLine = $versionResult.stdout -split "\r?\n" | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1
  if ($null -eq $versionLine) { throw "LibreOffice returned no version" }
  $rendererVersion = ([string]$versionLine).Trim()
  $reports = @()
  $fixtureIndex = 0

  foreach ($fixturePath in $fixturePaths) {
    $fixtureIndex += 1
    $fixtureRoot = Join-Path $artifactRoot ("fixture-" + $fixtureIndex)
    $fixtureStem = [IO.Path]::GetFileNameWithoutExtension($fixturePath) -replace "[^\p{L}\p{N}._-]", "_"
    $first = Invoke-RenderRun $fixturePath (Join-Path $fixtureRoot "run-1") 1 ("fixture-" + $fixtureIndex + "-" + $fixtureStem + "-run-1")
    $second = Invoke-RenderRun $fixturePath (Join-Path $fixtureRoot "run-2") 2 ("fixture-" + $fixtureIndex + "-" + $fixtureStem + "-run-2")
    if ($first.slideCount -ne $second.slideCount) {
      throw "Renderer output was not reproducible for ${fixturePath}: slideCount $($first.slideCount)/$($second.slideCount)"
    }
    if ($first.outputSha256 -ne $second.outputSha256) {
      throw "Renderer PNG output was not reproducible for ${fixturePath}: sha256 $($first.outputSha256)/$($second.outputSha256)"
    }
    if ($first.outputBytes -ne $second.outputBytes) {
      throw "Renderer PNG output size was not reproducible for ${fixturePath}: bytes $($first.outputBytes)/$($second.outputBytes)"
    }
    $reports += [ordered]@{
      inputPath = $fixturePath
      slideCount = [int]$first.slideCount
      outputFormat = "png"
      outputBytes = [int64]$first.outputBytes
      outputSha256 = $first.outputSha256
      pdfBytes = @([int64]$first.pdfBytes, [int64]$second.pdfBytes)
      pdfSha256 = @($first.pdfSha256, $second.pdfSha256)
      artifacts = @($first.outputPath, $second.outputPath, $first.pdfPath, $second.pdfPath)
      renderElapsedMs = @([int64]$first.elapsedMs, [int64]$second.elapsedMs)
    }
  }

  [ordered]@{
    status = "passed"
    reproducible = $true
    renderer = "libreoffice-impress-headless"
    rendererPath = $rendererPath
    rendererVersion = $rendererVersion
    rasterizer = "poppler-pdftoppm"
    rasterizerPath = $rasterizerPath
    pageCounter = "poppler-pdfinfo"
    pageCounterPath = $pdfInfoPath
    fixtures = $reports
    timeoutMs = $jobTimeoutMs
    processTimeoutMs = $processTimeoutMs
    artifactRoot = $artifactRoot
  } | ConvertTo-Json -Depth 5
} catch {
  Write-Error ("RENDER_SMOKE_STOP: " + $_.Exception.Message)
  exit 1
}
