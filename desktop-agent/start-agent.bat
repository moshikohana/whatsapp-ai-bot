@echo off
chcp 65001 >nul
title Boti Desktop Agent
cd /d "%~dp0"
echo ============================================
echo   Boti Desktop Agent
echo ============================================
echo.
where node >nul 2>&1 || (echo [X] Node.js not found - install from nodejs.org & pause & exit /b 1)
if not exist "%~dp0agent.config.json" (echo [X] agent.config.json missing & pause & exit /b 1)
node "%~dp0agent.js"
echo.
echo Agent stopped. Press any key to close.
pause >nul
