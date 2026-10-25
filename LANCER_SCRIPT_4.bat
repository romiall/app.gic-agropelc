@echo off
title Verificateur WhatsApp B2B - SCRIPT 4 (Contacts 6001 a 8126) - GIC AGROPELC
color 0D
cd /d "%~dp0scratch\whatsapp_verifier"
echo =====================================================================
echo    VERIFICATEUR WHATSAPP B2B — SCRIPT 4 (PAR LOTS DE 500)
echo =====================================================================
echo Segment : Contacts 6 001 a 8 126 (Lots 13 a 17)
echo Session dediee : .wwebjs_auth/session-script-4
echo.
echo [NOTE] Lors du premier lancement, scannez le QR code avec WhatsApp
echo (Menu > Appareils connectes > Connecter un appareil).
echo La session restera ensuite memorisee definitivement.
echo =====================================================================
echo.
node verifier_whatsapp_script_4.js %*
echo.
pause
