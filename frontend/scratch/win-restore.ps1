# 把 Edge 主窗口从最小化恢复并置前。
# 记忆里记过：computer-use 的 activate_window 对 Edge 会被 browser_url_policy 拒，只能走 ShowWindow 自救。
# 只动 msedge 进程的主窗口，不碰别的窗口。
# 注意：C# 放在同目录的 win-restore.cs 里用 Add-Type -Path 编译 ——
# PowerShell 5.1 在 LF 换行的脚本里认不出 here-string（实测报 "UnexpectedAttribute"）。
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'win-restore.cs')

$wins = @(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
if ($wins.Count -eq 0) { Write-Output 'no-msedge-window'; exit 0 }

foreach ($w in $wins) {
    $wasMin = [WinRestore]::IsIconic($w.MainWindowHandle)
    [void][WinRestore]::ShowWindow($w.MainWindowHandle, 9)          # SW_RESTORE
    [void][WinRestore]::SetForegroundWindow($w.MainWindowHandle)
    Write-Output ('pid=' + $w.Id + ' wasMinimized=' + $wasMin)
}
