$TargetFile = "C:\Users\mmirm\Downloads\nexastra ai client hunting agent\start_agent.bat"
$ShortcutPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\NexastraAgent.lnk"
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetFile
$Shortcut.WorkingDirectory = "C:\Users\mmirm\Downloads\nexastra ai client hunting agent"
$Shortcut.Save()
Write-Host "✅ Startup shortcut for Nexastra Agent created successfully at: $ShortcutPath"
