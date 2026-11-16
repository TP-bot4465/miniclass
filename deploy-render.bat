@echo off
chcp 65001 >nul
title MiniClass - Deploy len Cloud 24/7 (Render Blueprint YAML)
echo ============================================================
echo   DANG DAY MA NGUON LEN GITHUB: TP-bot4465/miniclass
echo ============================================================

git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/TP-bot4465/miniclass.git
git add .
git -c user.name="MiniClass" -c user.email="dev@miniclass.local" commit -m "chore: deploy MiniClass v1.0 with Render Blueprint YAML" 2>nul

echo.
echo Dang day ma nguon va render.yaml len GitHub (ghi de nhanh main)...
git push -u origin main --force

echo.
echo ============================================================
echo   HOAN TAT DAY CODE LEN GITHUB!
echo   Dang mo trang Render Blueprint de kich hoat Cloud 24/7...
echo ============================================================
start https://dashboard.render.com/blueprints
pause
