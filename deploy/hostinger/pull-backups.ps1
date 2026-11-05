<#
Copie hors hebergement des sauvegardes quotidiennes de la base : rapatrie sur le poste du porteur les sauvegardes
gic-daily-AAAAMMJJ-HHMMSS.sql.gz creees par backup-db.sh (dossier ~/backups_db/daily du serveur) qui ne sont pas encore
dans le dossier local, verifie chaque archive apres copie (lecture complete de l'archive gzip), garde les plus recentes
et supprime les plus anciennes du dossier LOCAL (jamais rien sur le serveur). Une sauvegarde qui n'est que sur
l'hebergement est perdue avec lui : cette copie est la seconde.

Usage, depuis n'importe quel dossier :
  powershell -ExecutionPolicy Bypass -File deploy\hostinger\pull-backups.ps1
Options : -LocalDir (defaut %USERPROFILE%\gic-backups), -Keep (nombre de sauvegardes locales gardees, 30 par defaut),
          -ListOnly (liste sans copier), -HostName, -Port, -User, -KeyPath.
A planifier au besoin dans le Planificateur de taches de Windows (une fois par jour, apres 02 h 30 heure du serveur).
Les sauvegardes contiennent toutes les donnees de GIC (comptes, ventes, clients) : garder le dossier local sur un disque
du porteur, chiffre si possible ; ne jamais le publier ni le copier dans le depot.

Aucun secret dans ce fichier : la cle SSH reste dans %USERPROFILE%\.ssh.
Fichier ASCII volontairement : Windows PowerShell 5.1 lit mal l'UTF-8 sans BOM.
#>
param(
  [string]$HostName = '145.79.20.169',
  [int]$Port = 65002,
  [string]$User = 'u720123645',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\gic_agropelc_deploy'),
  [string]$RemoteDir = 'backups_db/daily',
  [string]$LocalDir = (Join-Path $env:USERPROFILE 'gic-backups'),
  [int]$Keep = 30,
  [switch]$ListOnly
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $KeyPath)) { throw "Cle SSH introuvable : $KeyPath" }
if ($Keep -lt 1) { throw '-Keep doit etre au moins 1.' }

$pattern = '^gic-daily-\d{8}-\d{6}\.sql\.gz$'
$target = "$User@$HostName"
$sshOptions = @('-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new')

# Archive gzip lisible jusqu'au bout ? (une copie interrompue ou tronquee ne l'est pas)
function Test-GzipArchive([string]$Path) {
  $buffer = New-Object byte[] 1048576
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $gzip = New-Object System.IO.Compression.GZipStream($stream, [System.IO.Compression.CompressionMode]::Decompress)
    try { while ($gzip.Read($buffer, 0, $buffer.Length) -gt 0) { } } finally { $gzip.Dispose() }
    return $true
  } catch {
    return $false
  } finally {
    $stream.Dispose()
  }
}

$listing = & ssh @sshOptions -p $Port $target "ls -1 '$RemoteDir' 2>/dev/null"
if ($LASTEXITCODE -ne 0) { throw 'Lecture du dossier distant impossible (ssh).' }
$remote = @($listing | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match $pattern } | Sort-Object)
if ($remote.Count -eq 0) { Write-Host "Aucune sauvegarde quotidienne dans $RemoteDir (backup-db.sh n'a pas encore tourne ?)."; return }
Write-Host "Sur le serveur : $($remote.Count) sauvegarde(s), la plus recente : $($remote[-1])"
if ($ListOnly) { $remote | ForEach-Object { Write-Host "  $_" }; return }

New-Item -ItemType Directory -Force -Path $LocalDir | Out-Null
# Seules les $Keep plus recentes sont utiles localement : inutile de rapatrier le reste.
$wanted = @($remote | Select-Object -Last $Keep)
$copied = 0
foreach ($name in $wanted) {
  $dest = Join-Path $LocalDir $name
  if (Test-Path $dest) { continue }
  $partial = "$dest.partial"
  Write-Host "== Copie de $name"
  & scp @sshOptions -P $Port "${target}:${RemoteDir}/$name" $partial
  if ($LASTEXITCODE -ne 0) { Remove-Item $partial -ErrorAction SilentlyContinue; throw "Copie de $name impossible (scp)." }
  if (-not (Test-GzipArchive $partial)) {
    Remove-Item $partial -ErrorAction SilentlyContinue
    throw "L'archive copiee $name est illisible : elle est supprimee, relancer le script."
  }
  Move-Item $partial $dest
  $copied += 1
  Write-Host ("   verifiee ({0:N1} Mo)" -f ((Get-Item $dest).Length / 1MB))
}

# Rotation locale : les $Keep plus recentes (le nom porte la date), jamais rien d'autre que ces fichiers.
$local = @(Get-ChildItem -Path $LocalDir -File | Where-Object { $_.Name -match $pattern } | Sort-Object Name)
$removed = 0
if ($local.Count -gt $Keep) {
  foreach ($old in $local[0..($local.Count - $Keep - 1)]) { Remove-Item $old.FullName; $removed += 1 }
}
Write-Host "Termine : $copied copiee(s), $removed ancienne(s) supprimee(s) du dossier local ($LocalDir)."
