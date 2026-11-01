<#
Ecrit en ligne la reprise des donnees du reporting commercial (AV-489). Une seule commande, a la racine du depot :
  powershell -ExecutionPolicy Bypass -File deploy\hostinger\reprise-reporting-ecriture.ps1 -ManagerEmail <e-mail> -ManagerName '<NOM PRENOM>' -ManagerPhone <+237...>

Le script envoie l'outil et les donnees dans un dossier prive du serveur, lance l'ecriture (sauvegarde de la base, confirmation
OUI, mot de passe provisoire du responsable saisi masque, deux fois), rapatrie le rapport dans
import-reporting-commercial\rapports\import-en-ligne, puis supprime tout du serveur : aucune donnee de personne n'y reste.
Rejouable : rien n'est duplique (identifiants deterministes). Aucun secret ni donnee de personne dans ce fichier.
Pourquoi un fichier : coller un long bloc dans le terminal de VS Code fait perdre des espaces (constate le 01/11/2026).
Fichier ASCII volontairement (Windows PowerShell 5.1).
#>
param(
  [Parameter(Mandatory = $true)][string]$ManagerEmail,
  [Parameter(Mandatory = $true)][string]$ManagerName,
  [Parameter(Mandatory = $true)][string]$ManagerPhone,
  [string]$HostName = '145.79.20.169',
  [int]$Port = 65002,
  [string]$User = 'u720123645',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\gic_agropelc_deploy')
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path $KeyPath)) { throw "Cle SSH introuvable : $KeyPath" }
$files = @(
  (Join-Path $root 'deploy\hostinger\import-reporting-commercial.mjs'),
  (Join-Path $root 'deploy\hostinger\reporting-import-mapping.mjs'),
  (Join-Path $root 'deploy\hostinger\mariadb-compat.mjs'),
  (Join-Path $root 'import-reporting-commercial\donnees_extraites.json')
)
foreach ($f in $files) { if (-not (Test-Path $f)) { throw "Fichier introuvable : $f" } }

$o = @('-i', $KeyPath, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=15')
$t = "$User@$HostName"
$d = "/home/$User/import-reporting"
$app = "/home/$User/domains/gic-agropelc.com/nodejs-app"
$report = "$d/rapport-import-en-ligne"
$remote = "export PATH=/opt/alt/alt-nodejs22/root/usr/bin:`$PATH; umask 077; node --env-file=$app/.env $d/import-reporting-commercial.mjs --data $d/donnees_extraites.json --apply --app-dir $app --manager-email $ManagerEmail --manager-name '$ManagerName' --manager-phone $ManagerPhone --expect-clients 194 --expect-contacts 58 --expect-journal 14 --report-dir $report"

Write-Host '== 1/4 Envoi des fichiers (dossier prive du serveur)'
& ssh @o -p $Port $t "umask 077; mkdir -p $d"
if ($LASTEXITCODE -ne 0) { throw 'Connexion impossible (ssh).' }
& scp @o -P $Port @files "${t}:$d/"
if ($LASTEXITCODE -ne 0) { throw 'Envoi impossible (scp).' }

$code = -1
try {
  Write-Host '== 2/4 Ecriture : tapez OUI, puis le mot de passe provisoire (saisie masquee) et sa confirmation'
  & ssh -t @o -p $Port $t $remote
  $code = $LASTEXITCODE
  Write-Host "== 3/4 Rapport (code de sortie de l'ecriture : $code ; 0 = conforme)"
  & scp -r @o -P $Port "${t}:$report" (Join-Path $root 'import-reporting-commercial\rapports\import-en-ligne')
}
finally {
  Write-Host '== 4/4 Nettoyage du serveur (aucune donnee de personne n y reste)'
  & ssh @o -p $Port $t "rm -f $d/*.mjs $d/donnees_extraites.json; rm -rf $report; rmdir $d"
}
Write-Host "Termine. Code de l'ecriture : $code. Recopiez-moi les messages ci-dessus : le mot de passe n'y est jamais affiche."
