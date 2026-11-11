<#
Installe sur le serveur les scripts des operations planifiees (sauvegarde quotidienne de la base, rotation, purge des
alertes) dans ~/gic-ops, HORS du dossier de l'application : une mise en ligne (deploy.ps1) ne les ecrase ni ne les efface.
Il ne modifie PAS la table cron du serveur et ne lance rien : il copie les fichiers, les rend executables, puis affiche les
lignes a creer dans hPanel (Avance > Taches Cron). A lancer par le porteur (ou sur son accord explicite) ; relancer
l'installation apres chaque changement de ces scripts.

Usage, a la racine du depot :
  powershell -ExecutionPolicy Bypass -File deploy\hostinger\install-ops.ps1
Options : -HostName, -Port, -User, -KeyPath (valeurs par defaut ci-dessous), -DryRun (affiche sans rien envoyer).

Aucun secret dans ce fichier : la cle SSH reste dans %USERPROFILE%\.ssh et le .env reste sur le serveur.
Fichier ASCII volontairement : Windows PowerShell 5.1 lit mal l'UTF-8 sans BOM.
#>
param(
  [string]$HostName = '145.79.20.169',
  [int]$Port = 65002,
  [string]$User = 'u720123645',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\gic_agropelc_deploy'),
  [string]$OpsDir = 'gic-ops',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $KeyPath)) { throw "Cle SSH introuvable : $KeyPath" }

$files = @('backup-db.sh', 'backup-rotate.mjs', 'purge-alerts-cron.sh')
foreach ($f in $files) {
  if (-not (Test-Path (Join-Path $PSScriptRoot $f))) { throw "Fichier introuvable : $f" }
}
$target = "$User@$HostName"
$remote = "/home/$User/$OpsDir"
$sshOptions = @('-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new')

if ($DryRun) {
  Write-Host "Essai a blanc : $($files -join ', ') seraient copies dans $target`:$remote (aucune connexion ouverte)."
} else {
  Write-Host "== Copie dans $remote"
  & ssh @sshOptions -p $Port $target "mkdir -p '$remote'"
  if ($LASTEXITCODE -ne 0) { throw 'Creation du dossier distant impossible (ssh).' }
  foreach ($f in $files) {
    # Les scripts .sh doivent avoir des fins de ligne Unix : on les convertit avant l'envoi (copie temporaire).
    $local = Join-Path $PSScriptRoot $f
    $tmp = Join-Path $env:TEMP ("gic-ops-" + $f)
    $text = [System.IO.File]::ReadAllText($local) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding $false))
    & scp @sshOptions -P $Port $tmp "${target}:${remote}/$f"
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) { throw "Envoi de $f impossible (scp)." }
  }
  & ssh @sshOptions -p $Port $target "chmod 700 '$remote'/*.sh; ls -l '$remote'"
  if ($LASTEXITCODE -ne 0) { throw 'Controle des fichiers distants impossible (ssh).' }
}

Write-Host ''
Write-Host 'A creer dans hPanel > Avance > Taches Cron (heure du serveur ; le cron passe chaque nuit, mais le script ne sauvegarde qu''une nuit sur deux et garde cinq copies ; la purge le dimanche) :'
Write-Host "  0 2 * * *   /bin/bash $remote/backup-db.sh >> /home/$User/backups_db/cron-backup.log 2>&1"
Write-Host "  30 3 * * 0  /bin/bash $remote/purge-alerts-cron.sh >> /home/$User/backups_db/cron-purge.log 2>&1"
Write-Host ''
Write-Host 'Premier essai a la main (sur le serveur, apres l''installation) : /bin/bash ' -NoNewline
Write-Host "$remote/backup-db.sh"
Write-Host 'Copie hors hebergement : deploy\hostinger\pull-backups.ps1 (depuis le poste du porteur).'
