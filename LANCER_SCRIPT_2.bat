@echo off
title Verificateur WhatsApp B2B - SCRIPT 2 (Contacts 2001 a 4000) - GIC AGROPELC
color 0B
cd /d "%~dp0scratch\whatsapp_verifier"
echo =====================================================================
echo    VERIFICATEUR WHATSAPP B2B — SCRIPT 2 (PAR LOTS DE 500)
echo =====================================================================
echo Segment : Contacts 2 001 a 4 000 (Lots 5 a 8)
echo Session dediee : .wwebjs_auth/session-script-2
echo.
echo [NOTE] Lors du premier lancement, scannez le QR code avec WhatsApp
echo (Menu > Appareils connectes > Connecter un appareil).
echo La session restera ensuite memorisee definitivement.
echo =====================================================================
echo.
node verifier_whatsapp_script_2.js %*
echo.
pause
