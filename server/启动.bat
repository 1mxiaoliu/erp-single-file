@echo off
chcp 65001 >nul
title 云进销存 · 本机服务器
cd /d "%~dp0"

rem ===== 只改这一行：把 change-me-please 换成你自己的密码 =====
rem 注意：这个文件会进 Git 仓库，千万别把真实密码写在这里。
rem 本机自用请复制一份改名为「启动-我的密码.bat」，密码写在副本里（副本已被 .gitignore 排除）。
set ERP_PASS=change-me-please
rem ==========================================================

set PORT=8080
set DATA_DIR=%~dp0data
set WEB_DIR=%~dp0web

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 没找到 Node.js。请先到 https://nodejs.org 下载 LTS 版安装，一路下一步即可。
  echo.
  pause
  exit /b
)

echo.
echo   云进销存 正在启动...
echo   本机访问：http://127.0.0.1:%PORT%
echo   同一 WiFi 下手机可访问：http://本机IP:%PORT%
echo   关闭这个黑窗口 = 停止服务（数据已经存盘，不会丢）
echo.
node app.js
pause
