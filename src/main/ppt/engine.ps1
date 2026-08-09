<#
  engine.ps1 — drives Microsoft PowerPoint via COM to build the weekly service
  deck from the template + a JSON "job" produced by recipe.js/generator.js.

  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File engine.ps1 -JobPath job.json

  Requires PowerPoint (Office) installed. All progress is written to stdout so the
  Electron main process can stream it into the app's log panel.

  Job schema (see recipe.js buildJob):
    templatePath : string  (.pptx to open)
    outPptx      : string  (where to SaveAs)
    replaceGlobal: { "{token}": "value", ... }   applied to every slide
    steps        : [ {op, ...} ]  structural steps, in order
    exports      : [ {op, marker, outDir, imageType, transparent} ]
#>
param(
  [Parameter(Mandatory = $true)][string]$JobPath
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Log([string]$m) { Write-Host $m }

# PowerPoint enum constants
$ppSaveAsOpenXMLPresentation = 24
$ppShapeFormatPNG = 2
$ppRelativeToSlide = 1
$ppAlertsNone = 1

$job = Get-Content -Raw -LiteralPath $JobPath -Encoding UTF8 | ConvertFrom-Json

Log "=== Church PPT Generator engine ==="
Log ("template : " + $job.templatePath)
Log ("output   : " + $job.outPptx)

if (-not (Test-Path -LiteralPath $job.templatePath)) {
  throw "Template not found: $($job.templatePath)"
}

# ---------- helpers ----------------------------------------------------------

function Get-Notes($slide) {
  $t = ""
  try {
    $np = $slide.NotesPage
    foreach ($sh in $np.Shapes) {
      if ($sh.HasTextFrame -and $sh.TextFrame.HasText) {
        $t += $sh.TextFrame.TextRange.Text + "`n"
      }
    }
  } catch {}
  return $t
}

function Get-SlideText($slide) {
  $t = ""
  foreach ($sh in $slide.Shapes) {
    if ($sh.HasTextFrame) {
      try { if ($sh.TextFrame.HasText) { $t += $sh.TextFrame.TextRange.Text + "`n" } } catch {}
    }
  }
  return $t
}

function Find-SlideIndex($prs, [string]$marker) {
  for ($i = 1; $i -le $prs.Slides.Count; $i++) {
    $notes = Get-Notes $prs.Slides.Item($i)
    if ($notes.Contains($marker)) { return $i }
  }
  return -1
}

function Find-AllSlideIndexes($prs, [string]$marker) {
  $r = @()
  for ($i = 1; $i -le $prs.Slides.Count; $i++) {
    $notes = Get-Notes $prs.Slides.Item($i)
    if ($notes.Contains($marker)) { $r += $i }
  }
  return , $r
}

function Replace-InShape($shape, [string]$from, [string]$to) {
  if (-not $shape.HasTextFrame) { return }
  try {
    if (-not $shape.TextFrame.HasText) { return }
  } catch { return }
  $tr = $shape.TextFrame.TextRange
  # Replace every occurrence; PowerPoint's Replace hits one per call.
  $guard = 0
  while ($true) {
    $found = $tr.Replace($from, $to)
    if ($null -eq $found) { break }
    $guard++
    if ($guard -gt 200) { break }
  }
}

function Replace-InSlide($slide, [string]$from, [string]$to) {
  foreach ($sh in $slide.Shapes) { Replace-InShape $sh $from $to }
}

function Replace-Global($prs, $map) {
  foreach ($prop in $map.PSObject.Properties) {
    if ([string]::IsNullOrEmpty($prop.Name)) { continue }
    for ($i = 1; $i -le $prs.Slides.Count; $i++) {
      Replace-InSlide $prs.Slides.Item($i) $prop.Name $prop.Value
    }
  }
}

# Duplicate the slide at $index, $copies times. Copies land immediately after
# the source, so slides [$index .. $index+$copies] become the fillable block.
function Duplicate-Slide($prs, [int]$index, [int]$copies) {
  for ($k = 0; $k -lt $copies; $k++) {
    $src = $prs.Slides.Item($index)
    [void]$src.Duplicate()
  }
}

# Insert every slide of $srcPath after slide $afterIndex. Returns inserted count.
function Insert-Pptx($pp, $prs, [string]$srcPath, [int]$afterIndex) {
  if (-not (Test-Path -LiteralPath $srcPath)) {
    Log "  ! song file missing, skipping: $srcPath"
    return 0
  }
  $src = $pp.Presentations.Open($srcPath, $true, $false, $false) # ReadOnly, notUntitled, noWindow
  $count = $src.Slides.Count
  try {
    $src.Slides.Range().Copy()
    Start-Sleep -Milliseconds 250
    [void]$prs.Slides.Paste($afterIndex + 1)
  } finally {
    $src.Close()
  }
  return $count
}

function Format-Verse([string]$fmt, $v, [string]$text) {
  if ([string]::IsNullOrEmpty($fmt)) { $fmt = "%t" }
  return $fmt.Replace("%B", [string]$v.bookLong).
    Replace("%b", [string]$v.bookShort).
    Replace("%c", [string]$v.chapter).
    Replace("%v", [string]$v.no).
    Replace("%t", [string]$text)
}

function Fill-VerseSlide($slide, $v) {
  $rx = [regex]'\{each_verse([12])(?::([^}]*))?\}'
  foreach ($sh in $slide.Shapes) {
    if (-not $sh.HasTextFrame) { continue }
    try { if (-not $sh.TextFrame.HasText) { continue } } catch { continue }
    $txt = $sh.TextFrame.TextRange.Text
    $found = $rx.Matches($txt)
    if ($found.Count -eq 0) { continue }
    # Replace each distinct token once.
    $seen = @{}
    foreach ($m in $found) {
      $whole = $m.Value
      if ($seen.ContainsKey($whole)) { continue }
      $seen[$whole] = $true
      $which = $m.Groups[1].Value
      $fmt = if ($m.Groups[2].Success) { $m.Groups[2].Value } else { "%t" }
      $text = if ($which -eq "1") { $v.text1 } else { $v.text2 }
      $out = Format-Verse $fmt $v $text
      Replace-InShape $sh $whole $out
    }
  }
}

function Export-Step($prs, $exp) {
  $dir = $exp.outDir
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null

  $total = [int]$prs.Slides.Count
  $width = ([string]($total + 1)).Length
  $ext = if ($exp.imageType -eq "JPG") { "jpg" } else { "png" }
  $marker = [string]$exp.marker
  $kws = @()
  if ($exp.alsoTextContains) { $kws = @($exp.alsoTextContains) }

  # Single pass: collect matching slide indexes as plain integers (marker in notes
  # OR a visible-text keyword, for template slides that carry no notes marker).
  $idxs = @()
  for ($i = 1; $i -le $total; $i++) {
    $slide = $prs.Slides.Item($i)
    $hit = (Get-Notes $slide).Contains($marker)
    if (-not $hit -and $kws.Count -gt 0) {
      $txt = Get-SlideText $slide
      foreach ($kw in $kws) { if ($txt.Contains([string]$kw)) { $hit = $true; break } }
    }
    if ($hit) { $idxs += [int]$i }
  }
  if ($idxs.Count -eq 0) { Log "  (no slides matched '$marker')"; return }

  foreach ($n in $idxs) {
    $idx = [int]$n
    $slide = $prs.Slides.Item($idx)
    $name = "Slide" + ([string]$idx).PadLeft($width, "0") + "." + $ext
    $file = Join-Path $dir $name
    if ($exp.op -eq "exportSlides") {
      $slide.Export($file, $exp.imageType, 0, 0)
    } else {
      $w = [int]([double]$prs.PageSetup.SlideWidth * 1.563)
      $h = [int]([double]$prs.PageSetup.SlideHeight * 1.563)
      $win = $prs.Windows.Item(1)
      $win.View.GotoSlide($idx)
      $slide.Shapes.SelectAll()
      $win.Selection.ShapeRange.Export($file, $ppShapeFormatPNG, $w, $h, $ppRelativeToSlide)
    }
  }
  Log "  exported $($idxs.Count) image(s) -> $dir"
}

# ---------- run --------------------------------------------------------------

$pp = New-Object -ComObject PowerPoint.Application
$pp.DisplayAlerts = $ppAlertsNone
try { $pp.Visible = $true } catch {}

$prs = $pp.Presentations.Open($job.templatePath)
Log ("opened template with " + $prs.Slides.Count + " slides")

try {
  foreach ($step in $job.steps) {
    Log ("- step: " + $step.name + " (" + $step.op + ")")
    switch ($step.op) {
      "duplicateFill" {
        $idx = Find-SlideIndex $prs $step.repeatMarker
        if ($idx -lt 0) { Log "  ! marker not found: $($step.repeatMarker) (skip)"; break }
        $texts = @($step.texts)
        $n = $texts.Count
        if ($n -gt 1) { Duplicate-Slide $prs $idx ($n - 1) }
        for ($i = 0; $i -lt $n; $i++) {
          Replace-InSlide $prs.Slides.Item($idx + $i) $step.find $texts[$i]
        }
        Log "  filled $n slide(s) at index $idx"
      }
      "insertPptx" {
        $idx = Find-SlideIndex $prs $step.marker
        if ($idx -lt 0) { Log "  ! marker not found: $($step.marker) (skip)"; break }
        $after = $idx
        foreach ($f in @($step.files)) {
          $c = Insert-Pptx $pp $prs $f $after
          if ($c -gt 0) { Log "  inserted $c slide(s) from $(Split-Path $f -Leaf)"; $after += $c }
        }
      }
      "bibleVerses" {
        $idx = Find-SlideIndex $prs $step.repeatMarker
        if ($idx -lt 0) { Log "  ! marker not found: $($step.repeatMarker) (skip)"; break }
        $verses = @($step.verses)
        $n = $verses.Count
        if ($n -gt 1) { Duplicate-Slide $prs $idx ($n - 1) }
        for ($i = 0; $i -lt $n; $i++) {
          Fill-VerseSlide $prs.Slides.Item($idx + $i) $verses[$i]
        }
        Log "  filled $n verse slide(s) at index $idx"
      }
      default { Log "  ! unknown op: $($step.op)" }
    }
  }

  Log "- applying global token replacements"
  Replace-Global $prs $job.replaceGlobal

  $outDir = Split-Path $job.outPptx -Parent
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
  $prs.SaveAs($job.outPptx, $ppSaveAsOpenXMLPresentation)
  Log ("saved: " + $job.outPptx)

  foreach ($exp in $job.exports) {
    Log ("- export: " + $exp.name)
    try { Export-Step $prs $exp } catch { Log "  ! export failed: $($_.Exception.Message)" }
  }

  Log "DONE"
} finally {
  try { $prs.Close() } catch {}
  try { $pp.Quit() } catch {}
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pp) | Out-Null
}
