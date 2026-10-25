@echo off
title Verificateur WhatsApp B2B - SCRIPT 3 (Contacts 4001 a 6000) - GIC AGROPELC
color 0E
cd /d "%~dp0scratch\whatsapp_verifier"
echo =====================================================================
echo    VERIFICATEUR WHATSAPP B2B — SCRIPT 3 (PAR LOTS DE 500)
echo =====================================================================
echo Segment : Contacts 4 001 a 6 000 (Lots 9 a 12)
echo Session dediee : .wwebjs_auth/session-script-3
echo.
echo [NOTE] Lors du premier lancement, scannez le QR code avec WhatsApp
echo (Menu > Appareils connectes > Connecter un appareil).
echo La session restera ensuite memorisee definitivement.
echo =====================================================================
echo.
node verifier_whatsapp_script_3.js %*
echo.
pause
