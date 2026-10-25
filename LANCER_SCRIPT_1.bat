@echo off
title Verificateur WhatsApp B2B - SCRIPT 1 (Contacts 1 a 2000) - GIC AGROPELC
color 0A
cd /d "%~dp0scratch\whatsapp_verifier"
echo =====================================================================
echo    VERIFICATEUR WHATSAPP B2B — SCRIPT 1 (PAR LOTS DE 500)
echo =====================================================================
echo Segment : Contacts 1 a 2 000 (Lots 1 a 4)
echo.
node verifier_whatsapp_script_1.js %*
echo.
pause
