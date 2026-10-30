<#
Met l'application en ligne sur Hostinger : construit le paquet, l'envoie, puis lance remote-update.sh sur le serveur
(sauvegarde de la base, nouveaux fichiers, migrations, semis, redemarrage, controle ; retour automatique en cas d'echec).

Usage, a la racine du depot :
  powershell -ExecutionPolicy Bypass -File deploy\hostinger\deploy.ps1
Options : -SkipBuild (reutilise la construction existante), -NoDbBackup (ignore la sauvegarde de la base),
          -HostName, -Port, -User, -KeyPath (valeurs par defaut ci-dessous), -BuildOnly (construit le paquet et s'arrete).

Aucun secret dans ce fichier : la cle SSH reste dans %USERPROFILE%\.ssh et le .env reste sur le serveur.
Fichier ASCII volontairement : Windows PowerShell 5.1 lit mal l'UTF-8 sans BOM.
#>
param(
  [string]$HostName = '145.79.20.169',
  [int]$Port = 65002,
  [string]$User = 'u720123645',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\gic_agropelc_deploy'),
  [string]$AppDir = 'domains/gic-agropelc.com/nodejs-app',
  [switch]$SkipBuild,
  [switch]$NoDbBackup,
  [switch]$BuildOnly
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $KeyPath)) { throw "Cle SSH introuvable : $KeyPath" }

& "$PSScriptRoot\build-bundle.ps1" -SkipBuild:$SkipBuild
if ($BuildOnly) { Write-Host 'Construction terminee (-BuildOnly) : rien n''a ete envoye.'; return }

$bundle = Join-Path $env:TEMP 'gic-app-bundle.tar.gz'
$release = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = "$User@$HostName"
$remoteHome = "/home/$User"
$remoteBundle = "$remoteHome/$AppDir/incoming-$release.tar.gz"
$sshOptions = @('-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new')

Write-Host "== Envoi du paquet ($release)"
& scp @sshOptions -P $Port $bundle "${target}:${remoteBundle}"
if ($LASTEXITCODE -ne 0) { throw 'Envoi du paquet impossible (scp).' }

Write-Host '== Mise a jour sur le serveur'
$script = ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'remote-update.sh'))) -replace "`r`n", "`n"
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$noBackup = if ($NoDbBackup) { '1' } else { '0' }
# PowerShell ajoute un retour chariot a la fin du texte envoye : tr le retire (sinon bash l'executerait comme une commande
# et renverrait 127 meme si la mise a jour a reussi), sed retire l'eventuel BOM de la premiere ligne.
$command = "tr -d '\r' | sed '1s/^\xEF\xBB\xBF//' | APP_DIR=$remoteHome/$AppDir NO_DB_BACKUP=$noBackup bash -s -- '$remoteBundle' '$release'"
$script | & ssh @sshOptions -p $Port $target $command
if ($LASTEXITCODE -ne 0) { throw 'La mise a jour a signale une erreur (voir ci-dessus ; en cas d''echec du script distant, l''ancienne version est remise en place par lui).' }
Write-Host 'Termine.'
