@echo off
chcp 65001 >nul
rem ptt_teach：本機啟動（雙擊執行；關閉視窗即停止）
cd /d "%~dp0"
set "PATH=%~dp0node_modules\.bin;%PATH%"
set WRANGLER_SEND_METRICS=false

where wrangler.cmd >nul 2>nul || (
  echo 找不到 wrangler。請先在本資料夾執行 npm install（會安裝 package.json 指定的 wrangler）。
  pause & exit /b 1
)

if not exist ".dev.vars" (
  node -e "require('fs').writeFileSync('.dev.vars','CREATE_SECRET='+require('crypto').randomBytes(12).toString('base64url')+'\nADMIN_EMAILS=admin@example.test\n')"
)
for /f "tokens=1,* delims==" %%a in (.dev.vars) do if "%%a"=="CREATE_SECRET" set "SECRET=%%b"

echo.
echo ============================================================
echo  講師入口： http://localhost:8801/teacher.html
echo  本機測試登入：先執行一次 npm run test-auth，再在講師入口輸入 admin@example.test
echo  備援建場密語： %SECRET%
echo  （這組密語只在本機有效，存在 .dev.vars）
echo  關閉這個視窗即停止伺服器
echo ============================================================
echo.

rem 6 秒後自動開啟講師入口
if not "%NO_BROWSER%"=="1" start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:8801/teacher.html"
if "%DEV_PORT%"=="" set DEV_PORT=8801
call wrangler.cmd dev --ip 127.0.0.1 --port %DEV_PORT%
pause
