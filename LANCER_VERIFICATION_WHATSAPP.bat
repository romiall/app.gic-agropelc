@echo off
title Verificateur WhatsApp B2B - GIC AGROPELC
color 0A
cd /d "%~dp0scratch\whatsapp_verifier"

:MENU
cls
echo =====================================================================
echo       VERIFICATEUR WHATSAPP B2B HAUT DEBIT - GIC AGROPELC
echo =====================================================================
echo Classeur cible : BASE_CLIENTS_ET_PARTENAIRES_AFRIQUE_CENTRALE.xlsx
echo Numeros documentes : 9 543 (dont 8 126 mobiles et 1 417 lignes fixes)
echo ---------------------------------------------------------------------
echo.
echo   [1] Lancer la verification integrale Haute Securite (Conseille)
echo       - Teste tous les 8 126 numeros mobiles uniques
echo       - Anti-blocage automatique, temoin et reprise sans perte
echo       - Ecarte d'office les lignes fixes Camtel/Telecom
echo.
echo   [2] Lancer la verification par Grands Lots (Methode directe)
echo       - Progression ligne par ligne avec synchronisation continue
echo       - Promotion automatique des mobiles secondaires sur WhatsApp
echo.
echo   [3] Synchroniser les resultats vers le classeur Excel principal
echo       - Met a jour Base Contacts et _ENRICHI sans modifier la mise en page
echo.
echo   [4] Mode Test / Diagnostic (Verifie les fichiers sans se connecter)
echo.
echo   [5] Quitter
echo.
echo =====================================================================
set /p CHOIX="Choisissez une option (1-5) : "

if "%CHOIX%"=="1" goto VERIF_COMPLETE
if "%CHOIX%"=="2" goto VERIF_LOTS
if "%CHOIX%"=="3" goto SYNC_EXCEL
if "%CHOIX%"=="4" goto DIAGNOSTIC
if "%CHOIX%"=="5" goto FIN

echo Choix invalide.
timeout /t 2 >nul
goto MENU

:VERIF_COMPLETE
cls
echo =====================================================================
echo Lancement de la verification integrale Haute Securite...
echo (Appuyez sur Ctrl+C a tout moment pour arreter proprement)
echo =====================================================================
echo.
node verifier_whatsapp_complet.js --sans-fixes
echo.
echo Synchronisation automatique des resultats dans Excel...
python sync_whatsapp_to_excel.py
echo.
pause
goto MENU

:VERIF_LOTS
cls
echo =====================================================================
echo Lancement de la verification par Lots...
echo =====================================================================
echo.
node verifier_lots.js --lot=8500
echo.
pause
goto MENU

:SYNC_EXCEL
cls
echo =====================================================================
echo Synchronisation des statuts WhatsApp vers le classeur Excel...
echo =====================================================================
echo.
python sync_whatsapp_to_excel.py
echo.
pause
goto MENU

:DIAGNOSTIC
cls
echo =====================================================================
echo Verification de la configuration et des donnees...
echo =====================================================================
echo.
node verifier_whatsapp_complet.js --essai --sans-fixes
echo.
pause
goto MENU

:FIN
exit
