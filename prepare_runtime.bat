@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "runtime" mkdir "runtime"
set "VERSION=26.9.0"
set "BASE_URL=https://nodejs.org/dist/v%VERSION%"
set "NODE_URL=%BASE_URL%/win-x64/node.exe"
set "SUM_URL=%BASE_URL%/SHASUMS256.txt"
set "SUM_FILE=%TEMP%\nyXflash_shasums.txt"
set "HASH_FILE=%TEMP%\nyXflash_hash.txt"
if exist "runtime\node.exe" del /q "runtime\node.exe" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%NODE_URL%' -OutFile 'runtime\node.exe'; Invoke-WebRequest -UseBasicParsing -Uri '%SUM_URL%' -OutFile '%SUM_FILE%'"
if errorlevel 1 (
  echo Falha ao baixar o Node.js.
  del /q "runtime\node.exe" >nul 2>nul
  pause
  exit /b 1
)
set "EXPECTED="
powershell -NoProfile -ExecutionPolicy Bypass -Command "$line=Get-Content -LiteralPath '%SUM_FILE%' | Where-Object { $_ -match 'win-x64/node\.exe$' } | Select-Object -First 1; if ($line) { [Console]::Out.Write($line.Split()[0]) }" > "%TEMP%\nyXflash_expected_hash.txt"
set /p EXPECTED=<"%TEMP%\nyXflash_expected_hash.txt"
del /q "%TEMP%\nyXflash_expected_hash.txt" >nul 2>nul
if not defined EXPECTED (
  echo Nao foi possivel obter o SHA256 oficial.
  del /q "runtime\node.exe" >nul 2>nul
  del /q "%SUM_FILE%" >nul 2>nul
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=(Get-FileHash -LiteralPath 'runtime\node.exe' -Algorithm SHA256).Hash; [Console]::Out.Write($h)" > "%HASH_FILE%"
set /p ACTUAL=<"%HASH_FILE%"
del /q "%SUM_FILE%" "%HASH_FILE%" >nul 2>nul
if /i not "%ACTUAL%"=="%EXPECTED%" (
  echo SHA256 invalido.
  echo Esperado: %EXPECTED%
  echo Obtido:   %ACTUAL%
  del /q "runtime\node.exe" >nul 2>nul
  pause
  exit /b 1
)
echo Node.js portatil v%VERSION% verificado.
runtime\node.exe -v
pause
endlocal
