param(
  [Parameter(Mandatory = $true)][string]$State,
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Token,
  [int]$Owner = 0
)

# Desktop pet stage for Windows: one transparent, always-on-top WPF window per
# pet. The plugin host owns state; this process only paints frames and reports
# drag positions back over HTTP. Nothing else runs here.

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('PetStageNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PetStageNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
}

$ErrorActionPreference = 'Stop'
$script:LogPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($State), 'stage.log')
$script:BaseUrl = "http://127.0.0.1:$Port/petmarket/api"
$script:Pets = @{}
$script:LastSignature = ''
$script:StartedAt = [DateTime]::UtcNow

function Keep-Behind($window) {
  # Re-assert WS_EX_TOPMOST so other topmost apps cannot cover the pet.
  try {
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
    $hwnd = $helper.Handle
    if ($hwnd -eq [IntPtr]::Zero) { return }
    [PetStageNative]::SetWindowPos($hwnd, [PetStageNative]::HWND_TOPMOST, 0, 0, 0, 0,
      [PetStageNative]::SWP_NOMOVE -bor [PetStageNative]::SWP_NOSIZE -bor [PetStageNative]::SWP_NOACTIVATE -bor [PetStageNative]::SWP_SHOWWINDOW) | Out-Null
  } catch {
    # a failed raise only costs z-order
  }
}

function Write-StageLog([string]$message) {
  try {
    $line = ('{0:o} {1}' -f [DateTime]::UtcNow, $message)
    [System.IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine)
  } catch {
    # logging is best effort
  }
}

# Two DSH instances pointed at the same data root would otherwise each paint a
# copy of every pet. The first painter to grab the lock wins; the rest exit.
function Acquire-StageLock {
  $lockPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($State), 'stage.lock')
  try {
    return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    return $null
  }
}

function Post-StageJson([string]$path, $payload) {
  try {
    $json = $payload | ConvertTo-Json -Compress -Depth 6
    # Fire-and-forget: every call here happens on the UI thread, so a slow or dead
    # host would freeze the animation (and, before the capture fix, keep the
    # session's mouse input pinned to this window). Requests are queued in the
    # background and failures only land in stage.log.
    $body = [System.Text.Encoding]::UTF8.GetBytes($json)
    # Surface a failure from the previous fire-and-forget post (out-of-band logging
    # avoids touching the UI thread and avoids ContinueWith overload ambiguity).
    if ($script:LastPostTask -and $script:LastPostTask.IsFaulted) {
      $lastMessage = if ($script:LastPostTask.Exception) { $script:LastPostTask.Exception.GetBaseException().Message } else { 'unknown' }
      Write-StageLog ("post failed " + $script:LastPostTaskPath + ": " + $lastMessage)
    }
    $client = New-Object System.Net.WebClient
    $client.Headers.Add('content-type', 'application/json; charset=utf-8')
    $client.Headers.Add('x-petmarket-stage', [string]$Token)
    $script:LastPostTaskPath = $path
    $script:LastPostTask = $client.UploadDataTaskAsync([Uri]($script:BaseUrl + $path), 'POST', $body)
    return $true
  } catch {
    Write-StageLog ("post failed " + $path + ": " + $_.Exception.Message)
    return $false
  }
}

# `front` tells the painter which way the artwork faces; hosts that predate the
# field send nothing, and older installs recorded a manifest without it, so fall
# back to reading pet.json next to the artwork. Without this the cat (art faces
# left) is mirrored the wrong way round and walks backwards.
function Resolve-PetFront([string]$declared, [string]$imagePath) {
  # The pack on disk is authoritative: hosts and ledgers written before the
  # `front` field existed still say nothing (or the default), which is exactly how
  # the left-facing cat ended up mirrored the wrong way.
  try {
    if ($imagePath) {
      $petDir = Split-Path (Split-Path $imagePath -Parent) -Parent
      $petJson = Join-Path $petDir 'pet.json'
      if (Test-Path -LiteralPath $petJson) {
        $doc = (Get-Content -LiteralPath $petJson -Raw -Encoding UTF8) | ConvertFrom-Json
        if ([string]$doc.renderer.front -eq 'left') { return 'left' }
        return 'right'
      }
    }
  } catch {
    Write-StageLog ('front fallback failed: ' + $_.Exception.Message)
  }
  if ($declared -eq 'left') { return 'left' }
  return 'right'
}

function New-Bitmap([string]$file) {
  $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
  $bitmap.BeginInit()
  $bitmap.UriSource = [Uri]::new($file)
  $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bitmap.CreateOptions = [System.Windows.Media.Imaging.BitmapCreateOptions]::IgnoreImageCache
  $bitmap.EndInit()
  $bitmap.Freeze()
  return $bitmap
}

function Get-PoseAnimation($pet) {
  $name = $null
  if ($pet.states) { $name = [string]$pet.states.($pet.poseName) }
  if (-not $name) { $name = [string]$pet.poseName }
  $anim = $pet.animations[$name]
  if ($null -eq $anim) { $anim = $pet.animations['idle'] }
  return $anim
}

function Get-FrameSource($pet, [int]$index) {
  if ($pet.mode -eq 'frames') {
    $files = @($pet.files)
    if ($files.Count -eq 0) { return $null }
    $file = $files[[Math]::Min($index, $files.Count - 1)]
    if (-not $pet.cache.ContainsKey($file)) { $pet.cache[$file] = New-Bitmap $file }
    return $pet.cache[$file]
  }

  if (-not $pet.atlas) { $pet.atlas = New-Bitmap $pet.image }
  $anim = Get-PoseAnimation $pet
  if ($null -eq $anim) { return $pet.atlas }
  # Cropping costs a bitmap allocation per call; a desktop pet ticks ~30 times a
  # second, so decoded frames are cached per pose+index and reused.
  $cacheKey = [string]$pet.poseName + '#' + [string]$index
  if ($pet.frames.ContainsKey($cacheKey)) { return $pet.frames[$cacheKey] }
  $columns = [Math]::Max(1, [int]$pet.sheet.cols)
  $frameIndex = [int]$anim.from + $index
  $col = $frameIndex % $columns
  $row = [int]$anim.row
  $w = [int]$pet.frame.w
  $h = [int]$pet.frame.h
  $x = [int]$pet.sheet.margin + $col * ($w + [int]$pet.sheet.spacing)
  $y = [int]$pet.sheet.margin + $row * ($h + [int]$pet.sheet.spacing)
  if ($x + $w -gt $pet.atlas.PixelWidth -or $y + $h -gt $pet.atlas.PixelHeight) { return $pet.atlas }
  $rect = New-Object System.Windows.Int32Rect($x, $y, $w, $h)
  $crop = New-Object System.Windows.Media.Imaging.CroppedBitmap($pet.atlas, $rect)
  $crop.Freeze()
  $pet.frames[$cacheKey] = $crop
  return $crop
}

function Get-DpiScale($visual) {
  try {
    $dpi = [System.Windows.Media.VisualTreeHelper]::GetDpi($visual)
    if ($dpi -and $dpi.DpiScaleX -gt 0) { return [double]$dpi.DpiScaleX }
  } catch {
    # fall through to the system default
  }
  try {
    $physical = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $dip = [System.Windows.SystemParameters]::PrimaryScreenWidth
    if ($dip -gt 0) { return [double]($physical / $dip) }
  } catch {
    # keep 1.0
  }
  return 1.0
}

# The app window (DSH itself) is composited above every always-on-top window, so a
# pet dropped underneath it is invisible. New pets therefore pick the first free
# corner instead of always landing bottom-right.
function Get-AppWindowRects {
  $rects = New-Object System.Collections.ArrayList
  $scale = 1.0
  try {
    $physical = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
    $dip = [System.Windows.SystemParameters]::PrimaryScreenWidth
    if ($dip -gt 0) { $scale = $physical / $dip }
  } catch {
    $scale = 1.0
  }
  try {
    foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
      if ($proc.MainWindowHandle -eq [IntPtr]::Zero) { continue }
      $name = ''
      try { $name = [string]$proc.ProcessName } catch { $name = '' }
      if ($name -notmatch 'DeepSeek') { continue }
      $r = New-Object 'PetStageNative+RECT'
      if (-not [PetStageNative]::GetWindowRect($proc.MainWindowHandle, [ref]$r)) { continue }
      $w = ($r.Right - $r.Left) / $scale
      $h = ($r.Bottom - $r.Top) / $scale
      if ($w -lt 200 -or $h -lt 200) { continue }
      [void]$rects.Add([pscustomobject]@{ x = $r.Left / $scale; y = $r.Top / $scale; w = $w; h = $h })
    }
  } catch {
    Write-StageLog ('app window scan failed: ' + $_.Exception.Message)
  }
  return $rects
}

function Get-StartPosition([int]$petW, [int]$petH, [int]$slot) {
  $work = [System.Windows.SystemParameters]::WorkArea
  $step = $petW + 24
  $candidates = @(
    [pscustomobject]@{ x = $work.Right - $petW - 48 - ($slot * $step); y = $work.Bottom - $petH - 72 },
    [pscustomobject]@{ x = $work.Left + 48 + ($slot * $step); y = $work.Bottom - $petH - 72 },
    [pscustomobject]@{ x = $work.Right - $petW - 48 - ($slot * $step); y = $work.Top + 48 },
    [pscustomobject]@{ x = $work.Left + 48 + ($slot * $step); y = $work.Top + 48 }
  )
  $windows = Get-AppWindowRects
  if ($windows.Count -eq 0) { return $candidates[0] }
  foreach ($candidate in $candidates) {
    $free = $true
    foreach ($window in $windows) {
      $overlaps = (($candidate.x + $petW) -gt ($window.x + 12)) -and
                  ($candidate.x -lt ($window.x + $window.w - 12)) -and
                  (($candidate.y + $petH) -gt ($window.y + 12)) -and
                  ($candidate.y -lt ($window.y + $window.h - 12))
      if ($overlaps) { $free = $false; break }
    }
    if ($free) { return $candidate }
  }
  return $candidates[0]
}

function Get-LabelHeight($pet) {
  # The name sits above the sprite inside the same window, so the window is
  # taller than the artwork by exactly one line of text (or zero when unnamed).
  if (-not $pet.name) { return 0 }
  $size = if ([double]$pet.nameFont -gt 0) { [double]$pet.nameFont } else { 14 }
  return [Math]::Ceiling($size * 1.35)
}

function ConvertTo-BrushOrNull([string]$color) {
  if ([string]::IsNullOrWhiteSpace($color)) { return $null }
  try {
    $clean = $color.Trim().TrimStart('#')
    if ($clean.Length -ne 6) { return $null }
    $r = [Convert]::ToInt32($clean.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($clean.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($clean.Substring(4, 2), 16)
    return New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb($r, $g, $b))
  } catch {
    return $null
  }
}

function Get-TextOn([System.Windows.Media.SolidColorBrush]$brush) {
  # White on dark plates, near-black on light ones: the owner can pick any plate
  # colour without ending up with an unreadable name.
  if ($null -eq $brush) { return [System.Windows.Media.Brushes]::White }
  $c = $brush.Color
  $luma = (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
  if ($luma -gt 150) { return (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(28, 32, 42))) }
  return [System.Windows.Media.Brushes]::White
}

function Sync-PetLabel($pet) {
  if (-not $pet.label) { return }
  try {
    $pet.label.Text = if ($pet.name) { [string]$pet.name } else { '' }
    $size = if ([double]$pet.nameFont -gt 0) {
      [double]$pet.nameFont
    } elseif ($pet.frame) {
      [Math]::Max(10, [Math]::Round([double]$pet.frame.h * [double]$pet.scale * 0.14))
    } else {
      14
    }
    $pet.label.FontSize = $size
    if ($pet.nameFamily) {
      $pet.label.FontFamily = New-Object System.Windows.Media.FontFamily ([string]$pet.nameFamily)
    }
    $plate = ConvertTo-BrushOrNull ([string]$pet.nameColor)
    if ($null -ne $plate) {
      $pet.label.Background = $plate
      $pet.label.Foreground = Get-TextOn $plate
    } else {
      $pet.label.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(150, 17, 20, 28))
      $pet.label.Foreground = [System.Windows.Media.Brushes]::White
    }
    $pet.label.Visibility = if ($pet.name) { 'Visible' } else { 'Collapsed' }
  } catch {
    Write-StageLog ('label error: ' + $_.Exception.Message)
  }
}

function Set-PetGeometry($pet, $window) {
  # pet.x / pet.y always mean the sprite's top-left; the window grows upward to
  # hold the label so resizing never drags the artwork off its anchor.
  if ($null -eq $window) { return }
  $spriteW = [Math]::Max(1, [int]$pet.frame.w * $pet.scale)
  $spriteH = [Math]::Max(1, [int]$pet.frame.h * $pet.scale)
  $labelH = Get-LabelHeight $pet
  $window.Width = $spriteW
  $window.Height = $spriteH + $labelH
  $window.Left = [double]$pet.x
  $window.Top = [double]$pet.y - $labelH
}

function Set-Pose($pet, [string]$pose) {
  if (-not $pose) { return }
  if (-not $pet.animations -or -not $pet.animations.ContainsKey($pose)) { return }
  $pet.poseName = $pose
  $pet.poseApplied = $pose
  $pet.index = 0
  $pet.elapsed = 0.0
}

function New-PetMenuItem([string]$header) {
  $item = New-Object System.Windows.Controls.MenuItem
  $item.Header = $header
  $item.Padding = New-Object System.Windows.Thickness (12, 5, 12, 5)
  $item.FontFamily = New-Object System.Windows.Media.FontFamily ('Microsoft YaHei UI, Segoe UI')
  $item.FontSize = 13
  $item.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(48, 42, 36))
  return $item
}

function New-PetMenuStyle() {
  $style = New-Object System.Windows.Style ([System.Windows.Controls.MenuItem])
  $highlight = New-Object System.Windows.Trigger
  $highlight.Property = [System.Windows.Controls.MenuItem]::IsHighlightedProperty
  $highlight.Value = $true
  $setter = New-Object System.Windows.Setter ([System.Windows.Controls.Control]::BackgroundProperty), (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(255, 236, 190)))
  $highlight.Setters.Add($setter)
  $style.Triggers.Add($highlight)
  return $style
}

function Show-PetMenu($pet, $window) {
  # Fixed, pet-agnostic entries: bed time plus a pose submenu built from the
  # sheet itself. A pack with a single animation simply has no submenu.
  $menu = New-Object System.Windows.Controls.ContextMenu
  $menu.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(255, 253, 248))
  $menu.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromRgb(232, 220, 200))
  $menu.BorderThickness = New-Object System.Windows.Thickness 1
  $menu.Padding = New-Object System.Windows.Thickness 4
  $menu.FontFamily = New-Object System.Windows.Media.FontFamily ('Microsoft YaHei UI, Segoe UI')
  $menu.FontSize = 13
  try {
    $template = [System.Windows.Markup.XamlReader]::Parse(@'
<ControlTemplate TargetType="ContextMenu" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
  <Border Background="#FFFDF8" BorderBrush="#E8DCC8" BorderThickness="1" CornerRadius="10" Padding="5">
    <StackPanel IsItemsHost="True" />
  </Border>
</ControlTemplate>
'@)
    $menu.Template = $template
  } catch {
    Write-StageLog ('menu template failed: ' + $_.Exception.Message)
  }
  $menu.ItemContainerStyle = New-PetMenuStyle

  $sleep = New-PetMenuItem '回窝睡觉'
  # Skip closure capture here: a closure runs in a fresh module scope where this
  # script's functions (Post-StageJson, Set-Pose, Write-StageLog) do not exist,
  # so the first click threw CommandNotFoundException and killed the painter.
  # Per-item data rides on Tag instead, and the handler stays in script scope.
  $sleep.Tag = $pet
  $sleep.Add_Click({
      param($s, $e)
      try {
        $target = $s.Tag
        if ($target -and $target.petId) {
          Post-StageJson '/stage/click' @{ petId = $target.petId; action = 'sleep' } | Out-Null
        }
      } catch { Write-StageLog ('menu sleep failed: ' + $_.Exception.Message) }
    })
  $menu.Items.Add($sleep) | Out-Null

  if ($pet.animations -and $pet.animations.Count -gt 0) {
    $poses = New-PetMenuItem '动作'
    foreach ($poseName in $pet.animations.Keys) {
      if ($poseName -eq 'idle') { continue }
      $poseItem = New-PetMenuItem ([string]$poseName)
      $poseItem.Tag = @{ pet = $pet; pose = [string]$poseName }
      $poseItem.Add_Click({
          param($s, $e)
          try {
            $tag = $s.Tag
            if ($tag -and $tag.pet) {
              $tag.pet.holdUntil = [DateTime]::UtcNow.AddMilliseconds(240)
              Set-Pose $tag.pet $tag.pose
            }
          } catch { Write-StageLog ('menu pose failed: ' + $_.Exception.Message) }
        })
      $poses.Items.Add($poseItem) | Out-Null
    }
    if ($poses.Items.Count -gt 0) { $menu.Items.Add($poses) | Out-Null }
  }

  $menu.PlacementTarget = $window
  $menu.Placement = [System.Windows.Controls.Primitives.PlacementMode]::MousePoint
  $menu.IsOpen = $true
}

function New-PetWindow($pet) {
  $image = New-Object System.Windows.Controls.Image
  $image.Stretch = [System.Windows.Media.Stretch]::Fill
  [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($image, [System.Windows.Media.BitmapScalingMode]::NearestNeighbor)

  $label = New-Object System.Windows.Controls.TextBlock
  $label.TextAlignment = [System.Windows.TextAlignment]::Center
  $label.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
  $label.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Center
  $label.Foreground = [System.Windows.Media.Brushes]::White
  $label.FontWeight = [System.Windows.FontWeights]::SemiBold
  # A dim plate keeps the name readable on a bright wallpaper, where white text
  # with a soft shadow alone disappears.
  $label.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(150, 17, 20, 28))
  $label.Padding = New-Object System.Windows.Thickness (4, 1, 4, 1)
  $label.Margin = New-Object System.Windows.Thickness (0, 0, 0, 1)
  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 4
  $shadow.ShadowDepth = 0
  $shadow.Opacity = 0.85
  $shadow.Color = [System.Windows.Media.Colors]::Black
  $label.Effect = $shadow
  $pet.label = $label
  $pet.imageEl = $image

  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Children.Add($label) | Out-Null
  $panel.Children.Add($image) | Out-Null

  $window = New-Object System.Windows.Window
  $window.WindowStyle = [System.Windows.WindowStyle]::None
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.Topmost = $true
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
  $window.Content = $panel
  $window.Cursor = [System.Windows.Input.Cursors]::Hand
  Sync-PetLabel $pet
  Set-PetGeometry $pet $window

  $window.Add_MouseLeftButtonDown({
    param($sender, $e)
    try {
      $pet = $script:Pets[$sender.Tag]
      if ($null -eq $pet) { return }
      $pet.dragging = $true
      $pet.moved = $false
      # Screen coordinates, not window-relative ones: the window moves with the
      # cursor, so window-relative math always reports a zero delta.
      $pet.dragStart = [System.Windows.Forms.Cursor]::Position
      $pet.dragWindowX = $sender.Left
      $pet.dragWindowY = $sender.Top
      $pet.dragDpi = Get-DpiScale $sender
      # No CaptureMouse(): a leaked capture swallows every click in the session.
      # The 33 ms tick keeps dragging while the button reads as pressed.
      $sender.ReleaseMouseCapture()
      $e.Handled = $true
    } catch {
      Write-StageLog ('mouse down error: ' + $_.Exception.Message)
    }
  })

  $window.Add_MouseMove({
    param($sender, $e)
    try {
      $pet = $script:Pets[$sender.Tag]
      if ($null -eq $pet -or -not $pet.dragging) { return }
      # Movement is applied by Update-Drag on the 33 ms tick; here we only keep the
      # "did the user actually move" flag so a click is not mistaken for a drag.
      $ratio = if ($pet.dragDpi -gt 0) { $pet.dragDpi } else { 1.0 }
      $now = [System.Windows.Forms.Cursor]::Position
      $dx = ($now.X - $pet.dragStart.X) / $ratio
      $dy = ($now.Y - $pet.dragStart.Y) / $ratio
      if (([Math]::Abs($dx) + [Math]::Abs($dy)) -gt 3) { $pet.moved = $true }
      $e.Handled = $true
    } catch {
      Write-StageLog ('mouse move error: ' + $_.Exception.Message)
    }
  })

  $window.Add_MouseLeftButtonUp({
    param($sender, $e)
    try {
      $pet = $script:Pets[$sender.Tag]
      if ($null -eq $pet) { return }
      $sender.ReleaseMouseCapture()
      $pet.dragging = $false
      if ($pet.moved) {
        $pet.x = $sender.Left
        $pet.y = $sender.Top + (Get-LabelHeight $pet)
        Post-StageJson '/stage/position' @{ petId = $pet.petId; x = [Math]::Round($pet.x); y = [Math]::Round($pet.y); scale = $pet.scale } | Out-Null
      } else {
        Post-StageJson '/stage/click' @{ petId = $pet.petId } | Out-Null
        Set-Pose $pet 'happy'
        # A click should look like the pet noticed you and scampered off, so the
        # window travels a short distance instead of running on the spot.
        $pet.dashDir = if ((Get-Random -Minimum 0 -Maximum 2) -eq 0) { -1 } else { 1 }
        $pet.dashTargetX = [double]$sender.Left + ($pet.dashDir * (Get-Random -Minimum 140 -Maximum 230))
        $pet.dashing = $true
        $pet.facing = $pet.dashDir
        # Hold the last frame long enough to read, short enough not to look frozen.
        $pet.holdUntil = [DateTime]::UtcNow.AddMilliseconds(240)
      }
      $pet.moved = $false
    } catch {
      Write-StageLog ('mouse up error: ' + $_.Exception.Message)
    }
  })

  $window.Add_MouseRightButtonUp({
    param($sender, $e)
    try {
      $pet = $script:Pets[$sender.Tag]
      if ($null -eq $pet) { return }
      Show-PetMenu $pet $sender
      $e.Handled = $true
    } catch {
      Write-StageLog ('context menu error: ' + $_.Exception.Message)
    }
  })

  $window.Add_Closed({
    param($sender, $e)
    $script:Pets.Remove($sender.Tag) | Out-Null
  })

  $window.Tag = $pet.petId
  $window.Show()
  # Claim the spot right away: pets without a saved position are laid out by
  # slot, and a reshuffle on the next state push would move every other pet.
  Post-StageJson '/stage/position' @{ petId = $pet.petId; x = [Math]::Round($pet.x); y = [Math]::Round($pet.y); scale = $pet.scale } | Out-Null
  return $window
}

function ConvertFrom-State($raw) {
  $doc = $raw | ConvertFrom-Json
  $result = @{}
  $previous = $script:Pets
  foreach ($entry in @($doc.pets)) {
    $petId = [string]$entry.petId
    if (-not $petId) { continue }
    $animations = @{}
    if ($entry.animations) {
      foreach ($name in $entry.animations.PSObject.Properties.Name) {
        $a = $entry.animations.$name
        $animations[$name] = [pscustomobject]@{
          row    = [int]$a.row
          from   = [int]$a.from
          frames = [Math]::Max(1, [int]$a.frames)
          fps    = [Math]::Max(1, [int]$a.fps)
          loop   = if ($null -eq $a.loop) { $true } else { [bool]$a.loop }
          next   = [string]$a.next
        }
      }
    }
    $pos = $entry.pos
    $frameW = [int]$entry.frame.w
    $frameH = [int]$entry.frame.h
    $scale = [Math]::Max(1, [int]$pos.scale)
    $work = [System.Windows.SystemParameters]::WorkArea
    $slot = if ($null -ne $pos.slot) { [int]$pos.slot } else { 0 }
    $petW = $frameW * $scale
    $petH = $frameH * $scale
    if ($null -ne $pos.x -and $null -ne $pos.y) {
      $startX = [double]$pos.x
      $startY = [double]$pos.y
    } else {
      $start = Get-StartPosition $petW $petH $slot
      $startX = $start.x
      $startY = $start.y
    }
    $result[$petId] = [pscustomobject]@{
      petId       = $petId
      name        = [string]$entry.name
      nameFont    = [double]$entry.nameFont
      nameColor   = [string]$entry.nameColor
      nameFamily  = [string]$entry.nameFamily
      front       = Resolve-PetFront ([string]$entry.front) ([string]$entry.image)
      menus       = @($entry.menus)
      mode        = [string]$entry.mode
      image       = [string]$entry.image
      files       = @($entry.files)
      frame       = [pscustomobject]@{ w = $frameW; h = $frameH }
      sheet       = [pscustomobject]@{ cols = [int]$entry.sheet.cols; rows = [int]$entry.sheet.rows; margin = [int]$entry.sheet.margin; spacing = [int]$entry.sheet.spacing }
      animations  = $animations
      states      = $entry.states
      scale       = $scale
      facing      = if ($null -ne $pos.facing -and [int]$pos.facing -eq -1) { -1 } else { 1 }
      x           = $startX
      y           = $startY
      stateX      = $startX
      stateY      = $startY
      poseName    = 'idle'
      poseApplied = 'idle'
      index       = 0
      elapsed     = 0.0
      holdUntil   = [DateTime]::MinValue
      nextWander  = [DateTime]::UtcNow.AddSeconds((Get-Random -Minimum 4 -Maximum 12))
      wanderUntil = [DateTime]::MinValue
      wanderDir   = 1
      dashing     = $false
      dashDir     = 1
      dashTargetX = $startX
      dragging    = $false
      moved       = $false
      dragStart   = [System.Drawing.Point]::new(0, 0)
      dragWindowX = 0.0
      dragWindowY = 0.0
      dragDpi     = 1.0
      atlas       = $null
      cache       = @{}
      frames      = @{}
      appliedFacing = 0
      # WPF bits are attached when the window exists; declared here because a
      # PSCustomObject rejects properties that were not in the literal.
      label       = $null
      imageEl     = $null
    }
  }
  return $result
}

function Sync-Pets() {
  if (-not (Test-Path -LiteralPath $State)) { return }
  try {
    # ReadAllText holds the file with FileShare.Read, which makes the host's
    # write fail with EPERM. Open with a delete/write friendly share instead.
    $stream = [System.IO.File]::Open($State, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
      $raw = $reader.ReadToEnd()
      $reader.Dispose()
    } finally {
      $stream.Dispose()
    }
  } catch {
    return
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return }
  if ($raw -eq $script:LastSignature) { return }

  try {
    $next = ConvertFrom-State $raw
  } catch {
    Write-StageLog ('state parse failed: ' + $_.Exception.Message)
    return
  }
  $script:LastSignature = $raw

  foreach ($petId in @($script:Pets.Keys)) {
    if (-not $next.ContainsKey($petId)) {
      $window = $script:Windows[$petId]
      if ($window) { try { $window.Close() } catch { } }
      $script:Windows.Remove($petId) | Out-Null
      $script:Pets.Remove($petId) | Out-Null
    }
  }

  foreach ($petId in $next.Keys) {
    if ($script:Pets.ContainsKey($petId)) {
      $current = $script:Pets[$petId]
      $incoming = $next[$petId]
      # Bind the window before touching Left/Top: a stale $window from the
      # previous iteration reads as 0 and drops the pet at the screen corner.
      $window = $script:Windows[$petId]
      # The host rewrites state.json on every refresh with the last saved
      # position. Re-applying it every poll would undo the walk animation, so
      # only a *changed* state position wins (drag, panel, another host).
      $stateMoved = ($incoming.x -ne $current.stateX) -or ($incoming.y -ne $current.stateY)
      if (-not $current.dragging -and $stateMoved) {
        $current.x = $incoming.x
        $current.y = $incoming.y
        $current.stateX = $incoming.x
        $current.stateY = $incoming.y
      }
      # A scale change grows the window from its top-left corner, which makes
      # the pet jump up-left on the desktop. Re-anchor on the bottom centre so
      # it stays where the user left it, then report the corrected spot so the
      # host does not hand the old one back on the next poll.
      $rescaled = [double]$incoming.scale -ne [double]$current.scale
      if ($rescaled -and -not $current.dragging) {
        $oldW = [double]$current.frame.w * [double]$current.scale
        $oldH = [double]$current.frame.h * [double]$current.scale
        $newW = [double]$current.frame.w * [double]$incoming.scale
        $newH = [double]$current.frame.h * [double]$incoming.scale
        # pet.x / pet.y are the sprite top-left, so the drag-free anchor is the
        # sprite's own bottom edge — the label above it never enters the math.
        $current.x = [Math]::Round([double]$current.x + ($oldW - $newW) / 2.0)
        $current.y = [Math]::Round([double]$current.y + ($oldH - $newH))
        $current.stateX = $null
        $current.stateY = $null
      }
      $current.scale = $incoming.scale
      $current.facing = $incoming.facing
      $current.states = $incoming.states
      $current.animations = $incoming.animations
      $current.menus = $incoming.menus
      if ($incoming.name -and $incoming.name -ne $current.name) { $current.name = $incoming.name }
      if ($null -ne $incoming.name -and -not $incoming.name) { $current.name = $null }
      if ($null -ne $incoming.nameFont) { $current.nameFont = $incoming.nameFont }
      if ($incoming.front) { $current.front = $incoming.front }
      # Colour and family are plain strings; empty clears back to the default plate.
      $current.nameColor = [string]$incoming.nameColor
      $current.nameFamily = [string]$incoming.nameFamily
      if ($window) {
        $labelChanged = $false
        try {
          $before = Get-LabelHeight $current
          Sync-PetLabel $current
          $after = Get-LabelHeight $current
          $labelChanged = $before -ne $after
        } catch { }
        if ($rescaled -or $labelChanged) {
          Set-PetGeometry $current $window
          Post-StageJson '/stage/position' @{ petId = $petId; x = [Math]::Round($current.x); y = [Math]::Round($current.y); scale = $current.scale } | Out-Null
        } elseif (-not $current.dragging -and $stateMoved) {
          Set-PetGeometry $current $window
        }
        $current.stateX = $current.x
        $current.stateY = $current.y
      }
      continue
    }
    $script:Pets[$petId] = $next[$petId]
    $window = New-PetWindow $script:Pets[$petId]
    $script:Windows[$petId] = $window
    Write-StageLog ("pet window created: " + $petId + " front=" + $script:Pets[$petId].front + " facing=" + $script:Pets[$petId].facing)
  }
}

function Update-Frame($pet, [int]$deltaMs) {
  $anim = Get-PoseAnimation $pet
  if ($null -eq $anim) { return }
  if ($pet.poseApplied -ne $pet.poseName) {
    $pet.poseApplied = $pet.poseName
    $pet.index = 0
    $pet.elapsed = 0.0
  }
  $pet.elapsed += $deltaMs
  $frameMs = 1000.0 / $anim.fps
  if ($frameMs -lt 16) { $frameMs = 16 }
  # Advance at most one frame per tick so a slow poll cannot skip frames.
  if ($pet.elapsed -ge $frameMs) {
    $pet.elapsed -= $frameMs
    $pet.index++
  }
  if ($anim.loop) {
    if ($pet.index -ge $anim.frames) { $pet.index = $pet.index % $anim.frames }
    return
  }
  if ($pet.index -lt $anim.frames) { return }
  $next = [string]$anim.next
  if ($next -and $pet.animations.ContainsKey($next)) {
    $pet.poseName = $next
    $pet.poseApplied = $next
    $pet.index = 0
    $pet.elapsed = 0.0
    return
  }
  $now = [DateTime]::UtcNow
  if ($now -ge $pet.holdUntil) {
    $pet.poseName = 'idle'
    $pet.poseApplied = 'idle'
    $pet.index = 0
    $pet.elapsed = 0.0
    $pet.holdUntil = [DateTime]::MinValue
    $pet.nextWander = $now.AddSeconds((Get-Random -Minimum 2 -Maximum 6))
  } else {
    $pet.index = $anim.frames - 1
  }
}

function Update-Wander($pet, $window, [int]$deltaMs) {
  if ($pet.dragging) { return }
  $now = [DateTime]::UtcNow
  if ($pet.dashing) {
    # A click sends the pet a short hop away; travel beats running in place.
    $step = ($deltaMs / 1000.0) * 260
    $left = [double]$window.Left
    $target = [double]$pet.dashTargetX
    $bounds = [System.Windows.SystemParameters]::WorkArea
    if ($target -lt $left) {
      $left = $left - $step
      if ($left -le $target) { $left = $target }
    } else {
      $left = $left + $step
      if ($left -ge $target) { $left = $target }
    }
    if ($left -lt $bounds.Left) { $left = $bounds.Left }
    if ($left + $window.Width -gt ($bounds.Left + $bounds.Width)) { $left = $bounds.Left + $bounds.Width - $window.Width }
    $window.Left = $left
    $pet.x = $left
    if ([Math]::Abs($left - $target) -lt 1) {
      $pet.dashing = $false
      $pet.poseName = 'idle'
      $pet.poseApplied = 'idle'
      $pet.index = 0
      $pet.elapsed = 0.0
      $pet.nextWander = $now.AddSeconds((Get-Random -Minimum 3 -Maximum 9))
    }
    return
  }
  if ($pet.poseName -ne 'walk') {
    if ($now -ge $pet.nextWander) {
      $pet.poseName = 'walk'
      $pet.poseApplied = 'walk'
      $pet.index = 0
      $pet.elapsed = 0.0
      $pet.wanderDir = if ((Get-Random -Minimum 0 -Maximum 2) -eq 0) { -1 } else { 1 }
      $pet.wanderUntil = $now.AddMilliseconds((Get-Random -Minimum 1800 -Maximum 4200))
    }
    return
  }
  if ($now -ge $pet.wanderUntil) {
    $pet.poseName = 'idle'
    $pet.poseApplied = 'idle'
    $pet.index = 0
    $pet.elapsed = 0.0
    $pet.nextWander = $now.AddSeconds((Get-Random -Minimum 3 -Maximum 9))
    return
  }
  $bounds = [System.Windows.SystemParameters]::WorkArea
  # 46 dip/s: slow enough to read as a walk, fast enough to notice.
  $nextX = $window.Left + ($pet.wanderDir * ($deltaMs / 1000.0) * 46)
  if ($nextX -lt $bounds.Left) { $pet.wanderDir = 1; $nextX = $bounds.Left }
  if ($nextX + $window.Width -gt ($bounds.Left + $bounds.Width)) {
    $pet.wanderDir = -1
    $nextX = $bounds.Left + $bounds.Width - $window.Width
  }
  $window.Left = $nextX
  $pet.x = $nextX
  $pet.facing = if ($pet.wanderDir -eq 1) { 1 } else { -1 }
}

function Update-Facing($pet, $window) {
  # Flip the artwork only: mirroring the whole window would mirror the name.
  $visual = if ($pet.imageEl) { $pet.imageEl } else { $window.Content }
  if ($null -eq $visual) { return }
  # Packs differ in which way their art faces, so `front` decides whether a
  # positive facing needs a mirror. Cats in the demo sheet face left, the dogs
  # face right; without this the cat walks backwards.
  $nativeLeft = ([string]$pet.front -eq 'left')
  $wantsRight = ([double]$pet.facing -ge 0)
  $flip = ($wantsRight -and $nativeLeft) -or ((-not $wantsRight) -and (-not $nativeLeft))
  $state = if ($flip) { 1 } else { 0 }
  if ($pet.appliedFacing -eq $state) { return }
  $pet.appliedFacing = $state
  Write-StageLog ("orientation " + $pet.petId + ": front=" + $pet.front + " facing=" + $pet.facing + " mirror=" + $flip)
  if ($flip) {
    $visual.RenderTransform = New-Object System.Windows.Media.ScaleTransform(-1, 1)
    $visual.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
  } elseif ($visual.RenderTransform) {
    $visual.RenderTransform = $null
  }
}

$script:Windows = @{}
$script:LastTick = [DateTime]::UtcNow

$script:StageLock = Acquire-StageLock
if ($null -eq $script:StageLock) {
  Write-StageLog ("stage skipped pid=" + $PID + ": another painter holds the lock")
  exit 0
}

Write-StageLog ("stage started pid=" + $PID + " state=" + $State)
try {
  $pidFile = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($State), 'stage.pid')
  [System.IO.File]::WriteAllText($pidFile, (@{ pid = $PID; owner = $Owner } | ConvertTo-Json -Compress))
} catch {
  Write-StageLog ('pid file write failed: ' + $_.Exception.Message)
}

# Dragging is driven from the tick, not from mouse capture.
# CaptureMouse() redirects every click in the session to our window until it is
# released; if the matching MouseUp is ever lost (window moves under the pointer,
# another topmost window appears, the handler throws) the whole desktop stops
# reacting to left and right clicks. Polling the button state cannot leak.
function Update-Drag($pet, $window) {
  if (-not $pet.dragging) { return }
  $pressed = [System.Windows.Input.Mouse]::LeftButton -eq [System.Windows.Input.MouseButtonState]::Pressed
  if (-not $pressed) {
    $pet.dragging = $false
    try { $window.ReleaseMouseCapture() } catch { }
    if ($pet.moved) {
      $pet.x = $window.Left
      $pet.y = $window.Top + (Get-LabelHeight $pet)
      Post-StageJson '/stage/position' @{ petId = $pet.petId; x = [Math]::Round($pet.x); y = [Math]::Round($pet.y); scale = $pet.scale } | Out-Null
    }
    $pet.moved = $false
    return
  }
  $ratio = if ($pet.dragDpi -gt 0) { $pet.dragDpi } else { 1.0 }
  $now = [System.Windows.Forms.Cursor]::Position
  $dx = ($now.X - $pet.dragStart.X) / $ratio
  $dy = ($now.Y - $pet.dragStart.Y) / $ratio
  $window.Left = $pet.dragWindowX + $dx
  $window.Top = $pet.dragWindowY + $dy
  if (([Math]::Abs($dx) + [Math]::Abs($dy)) -gt 3) { $pet.moved = $true }
}

$pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$pollTimer.Add_Tick({
    try {
      Sync-Pets
    } catch { Write-StageLog ('sync error: ' + $_.Exception.Message) }
  })

# Other topmost windows (chat clients, corporate watermark overlays, players) steal
# the z-order; re-assert it faster than the poll so the pet does not blink behind them.
$raiseTimer = New-Object System.Windows.Threading.DispatcherTimer
$raiseTimer.Interval = [TimeSpan]::FromMilliseconds(180)
$raiseTimer.Add_Tick({
    foreach ($petId in @($script:Windows.Keys)) {
      $window = $script:Windows[$petId]
      if ($null -eq $window) { continue }
      try {
        if (-not $window.Topmost) { $window.Topmost = $true }
        Keep-Behind $window
      } catch { }
    }
  })

$frameTimer = New-Object System.Windows.Threading.DispatcherTimer
# 33 ms ≈ 30 fps: the tick has to be at least as fast as the fastest animation
# in a pack (12–16 fps) or frames get skipped and the walk looks choppy.
$frameTimer.Interval = [TimeSpan]::FromMilliseconds(33)
$frameTimer.Add_Tick({
    $now = [DateTime]::UtcNow
    $deltaMs = [int](($now - $script:LastTick).TotalMilliseconds)
    $script:LastTick = $now
    if ($deltaMs -le 0) { return }
    foreach ($petId in @($script:Pets.Keys)) {
      $pet = $script:Pets[$petId]
      $window = $script:Windows[$petId]
      if ($null -eq $window) { continue }
      try {
        Update-Drag $pet $window
        Update-Wander $pet $window $deltaMs
        Update-Frame $pet $deltaMs
        Update-Facing $pet $window
        $source = Get-FrameSource $pet $pet.index
        # The window holds a StackPanel (name + artwork), so the image is the
        # one carrying Source, not the window content.
        $target = if ($pet.imageEl) { $pet.imageEl } else { $window.Content }
        if ($source -and $target.Source -ne $source) { $target.Source = $source }
      } catch {
        Write-StageLog ('frame error ' + $petId + ': ' + $_.Exception.Message)
      }
    }
  })

try {
  Sync-Pets
} catch {
  Write-StageLog ('initial sync error: ' + $_.Exception.Message)
}
$pollTimer.Start()
$raiseTimer.Start()
$frameTimer.Start()

# Exit when the host disappears: the state file is rewritten every refresh, and
# the process is killed by the host on dispose, so this only covers a hard crash.
$watchdog = New-Object System.Windows.Threading.DispatcherTimer
$watchdog.Interval = [TimeSpan]::FromSeconds(10)
$watchdog.Add_Tick({
    if (-not (Test-Path -LiteralPath $State)) {
      Write-StageLog 'state file vanished, exiting'
      [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
      return
    }
    if ($Owner -gt 0) {
      $owner = Get-Process -Id $Owner -ErrorAction SilentlyContinue
      if ($null -eq $owner) {
        Write-StageLog ('owner process ' + $Owner + ' is gone, exiting')
        [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
      }
    }
  })
$watchdog.Start()

# Last line of defence: an exception thrown inside a WPF callback used to take
# the whole painter down, which looked like "every pet vanished for a while".
# Log it, mark it handled, keep drawing.
[System.Windows.Threading.Dispatcher]::CurrentDispatcher.add_UnhandledException({
    param($sender, $args)
    try {
      Write-StageLog ('dispatcher exception: ' + $args.Exception.Message)
    } catch { }
    $args.Handled = $true
  })

[System.Windows.Threading.Dispatcher]::Run()
Write-StageLog 'stage stopped'
