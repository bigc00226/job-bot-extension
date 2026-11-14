@echo off
rem Removes Job Finder Helper. Job Finder then shows its notifications in a Chrome window again.
taskkill /im JobFinderHelper.exe /f >nul 2>&1
for %%B in ("Google\Chrome" "Microsoft\Edge" "BraveSoftware\Brave-Browser") do reg delete "HKCU\Software\%%~B\NativeMessagingHosts\com.jobfinder.helper" /f >nul 2>&1
rmdir /s /q "%LOCALAPPDATA%\JobFinderHelper" 2>nul
echo Job Finder Helper was removed.
pause
