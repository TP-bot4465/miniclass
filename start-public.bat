@echo off
chcp 65001 >nul
title MiniClass - Public Server (Free HTTPS)
echo ============================================================
echo   DANG KHOI DONG MINICLASS SERVER CONG 3000...
echo ============================================================
start "MiniClass Local Server" cmd /k "node src/server.mjs"
timeout /t 3 /nobreak >nul

echo.
echo ============================================================
echo   DANG MO DUONG HAM HTTPS CONG KHAI MIEN PHI (localhost.run)
echo   Hay copy duong link https://*.lhr.life ben duoi gui cho hoc sinh!
echo ============================================================
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:3000 nokey@localhost.run
pause
