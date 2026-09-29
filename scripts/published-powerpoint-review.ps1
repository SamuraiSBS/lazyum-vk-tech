param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $PptxPath).Path
if ([IO.Path]::GetExtension($source) -ine '.pptx') { throw 'Input must be a .pptx file.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($output -eq $source -or $source.StartsWith($output + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must not contain the source PPTX.'
}
if (Test-Path -LiteralPath $output) {
  if (@(Get-ChildItem -LiteralPath $output -Force).Count -gt 0) { throw "OutputDirectory is not empty: $output" }
} else { New-Item -ItemType Directory -Path $output -Force | Out-Null }

$before = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
$app = $null
$presentation = $null
$createdApp = $false
try {
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
  if ($null -eq $app) {
    $app = New-Object -ComObject PowerPoint.Application
    $createdApp = $true
  }
  $version = [string]$app.Version
  if (-not $version.StartsWith('16.')) { throw "Expected PowerPoint 16.x; found $version" }
  # ReadOnly, Untitled, WithWindow. Never call Save/SaveAs on the inspected deck.
  $presentation = $app.Presentations.Open($source, -1, 0, 0)
  $actuallyReadOnly = [bool]$presentation.ReadOnly
  if (-not $actuallyReadOnly) { throw 'PowerPoint did not open the PPTX read-only.' }
  $count = [int]$presentation.Slides.Count
  if ($count -ne 10) { throw "Expected 10 slides; found $count" }
  $width = [double]$presentation.PageSetup.SlideWidth
  $height = [double]$presentation.PageSetup.SlideHeight
  $slides = @()
  for ($index = 1; $index -le $count; $index++) {
    $slide = $presentation.Slides.Item($index)
    $native = [ordered]@{ shapeCount = [int]$slide.Shapes.Count; textShapes = 0; pictures = 0; tables = 0; charts = 0; groups = 0; other = 0 }
    for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
      $shape = $slide.Shapes.Item($shapeIndex)
      $kind = [int]$shape.Type
      if ($kind -eq 13 -or $kind -eq 11) { $native.pictures++ }
      elseif ($kind -eq 6) { $native.groups++ }
      elseif ($kind -eq 3) { $native.charts++ }
      else { $native.other++ }
      try { if ($shape.HasTable -eq -1) { $native.tables++ } } catch { }
      try { if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) { $native.textShapes++ } } catch { }
    }
    $png = Join-Path $output ('slide-{0:D2}.png' -f $index)
    $slide.Export($png, 'PNG', 1600, 900)
    if (-not (Test-Path -LiteralPath $png)) { throw "PowerPoint did not export slide $index" }
    $slides += [ordered]@{
      order = $index
      png = $png
      pngBytes = (Get-Item -LiteralPath $png).Length
      pngSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $png).Hash.ToLowerInvariant()
      native = $native
    }
  }
  $presentation.Close()
  $presentation = $null
  $after = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
  if ($after -ne $before) { throw "PPTX SHA-256 changed during inspection: $before -> $after" }
  $evidence = [ordered]@{
    inputPptx = $source
    sha256Before = $before
    sha256After = $after
    powerPointVersion = $version
    readOnly = $actuallyReadOnly
    attachedToExistingApp = (-not $createdApp)
    slideCount = $count
    pageWidthPoints = $width
    pageHeightPoints = $height
    slides = $slides
  }
  $evidencePath = Join-Path $output 'powerpoint-evidence.json'
  $evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  Write-Output "POWERPOINT_EVIDENCE=$evidencePath"
  Write-Output "PPTX_SHA256=$before"
} finally {
  if ($null -ne $presentation) { try { $presentation.Close() } catch { } }
  if ($null -ne $app -and $createdApp) { try { $app.Quit() } catch { } }
  if ($null -ne $presentation) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  if ($null -ne $app) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
