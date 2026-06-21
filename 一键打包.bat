@echo off
chcp 65001 >nul
echo.
echo   ═══════════════════════════════════════
echo   忍者手记 — 一键打包
echo   ═══════════════════════════════════════
echo.
cd /d "%~dp0"
node scripts/bundle.mjs
node scripts/build-regex.mjs
if %errorlevel% neq 0 (
    echo.
    echo   ❌ 打包失败！请确保已安装 Node.js
    echo.
    pause
    exit /b 1
)
echo   按任意键退出...
pause >nul
