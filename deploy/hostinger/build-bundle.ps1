<#
Prepare le paquet de mise en ligne (Hostinger) : construit le serveur, la PWA et les paquets partages, compile les
semis en CommonJS pour MariaDB, puis rassemble le tout dans une archive. Ne se connecte a aucun serveur.

Usage, a la racine du depot :
  powershell -ExecutionPolicy Bypass -File deploy\hostinger\build-bundle.ps1 [-SkipBuild]

Sortie : %TEMP%\gic-app-bundle.tar.gz (chemin, taille et empreinte SHA-256 affiches).
Fichier ASCII volontairement : Windows PowerShell 5.1 lit mal l'UTF-8 sans BOM.
#>
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stage = Join-Path $env:TEMP 'gic-deploy-stage'
$bundle = Join-Path $env:TEMP 'gic-app-bundle.tar.gz'
Set-Location $repo
$utf8 = New-Object System.Text.UTF8Encoding $false

if (-not $SkipBuild) {
  Write-Host '== Construction (pnpm run build : paquets, serveur, PWA)'
  pnpm run build
  if ($LASTEXITCODE -ne 0) { throw 'La construction a echoue (pnpm run build).' }
}
foreach ($required in @('apps\server\dist\app.module.js', 'apps\pwa\dist\index.html', 'packages\domain\dist\index.js', 'packages\contracts\dist\index.js')) {
  if (-not (Test-Path (Join-Path $repo $required))) { throw "Fichier construit introuvable : $required (relancer sans -SkipBuild)." }
}

Write-Host '== Assemblage dans' $stage
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
foreach ($d in @('dist', 'pwa', 'pkg-domain\dist', 'pkg-contracts\dist', 'db\migrations', 'seeds-dist')) {
  New-Item -ItemType Directory -Path (Join-Path $stage $d) -Force | Out-Null
}
Copy-Item "$repo\apps\server\dist\*" "$stage\dist" -Recurse -Force
Copy-Item "$repo\apps\pwa\dist\*" "$stage\pwa" -Recurse -Force
Copy-Item "$repo\packages\domain\dist\*" "$stage\pkg-domain\dist" -Recurse -Force
Copy-Item "$repo\packages\domain\package.json" "$stage\pkg-domain\package.json" -Force
Copy-Item "$repo\packages\contracts\dist\*" "$stage\pkg-contracts\dist" -Recurse -Force
# "workspace:*" n'existe pas en dehors du depot.
$contracts = [System.IO.File]::ReadAllText("$repo\packages\contracts\package.json").Replace('"workspace:*"', '"*"')
[System.IO.File]::WriteAllText("$stage\pkg-contracts\package.json", $contracts, $utf8)
Copy-Item "$repo\db\migrations\*.sql" "$stage\db\migrations" -Force
Copy-Item "$PSScriptRoot\server.js" "$stage\server.js" -Force
Copy-Item "$PSScriptRoot\migrate.mjs" "$stage\migrate.mjs" -Force
# Compatibilite MariaDB du code serveur (CAST AS JSON, FOR SHARE) et son controle sur la base reelle.
Copy-Item "$PSScriptRoot\mariadb-compat.mjs" "$stage\mariadb-compat.mjs" -Force
Copy-Item "$PSScriptRoot\compat-check.mjs" "$stage\compat-check.mjs" -Force

# Correctif propre a la mise en ligne (non versionne dans le code source) : connexion par adresse e-mail.
# Il etait applique a la main sur le serveur depuis le 27/10/2026 ; le reprendre ici evite qu'une mise a jour
# l'efface. Echec volontaire si le code a change (voir README.md, section sur les correctifs de mise en ligne).
$authFile = "$stage\dist\modules\identity\api\auth.controller.js"
$auth = [System.IO.File]::ReadAllText($authFile)
$pad = ' ' * 16
$oldLength = 'phone: z.string().min(1).max(20),'
$oldLookup = ".where('phone', '=', phone)`n$pad.orderBy('id', 'desc')`n$pad.limit(1)`n$pad.executeTakeFirst());"
$newLookup = ".where('phone', '=', phone)`n$pad.orderBy('id', 'desc')`n$pad.limit(1)`n$pad.executeTakeFirst()) ??`n" +
  "            (await this.db`n$pad.selectFrom('identity_users')`n$pad.select(['id', 'password_hash', 'status', 'must_change_password'])`n" +
  "$pad.where('email', '=', phone)`n$pad.orderBy('id', 'desc')`n$pad.limit(1)`n$pad.executeTakeFirst());"
if (-not $auth.Contains($oldLength)) { throw 'Correctif de connexion par e-mail : longueur du champ introuvable (auth.controller.js a change).' }
if (-not $auth.Contains($oldLookup)) { throw 'Correctif de connexion par e-mail : recherche par telephone introuvable (auth.controller.js a change).' }
$auth = $auth.Replace($oldLength, 'phone: z.string().min(1).max(200),').Replace($oldLookup, $newLookup)
[System.IO.File]::WriteAllText($authFile, $auth, $utf8)

# Dependances d'execution du serveur : celles de apps\server\package.json, sans les paquets de l'espace de travail.
$serverPackage = [System.IO.File]::ReadAllText("$repo\apps\server\package.json") | ConvertFrom-Json
$deps = [ordered]@{}
foreach ($p in ($serverPackage.dependencies.PSObject.Properties | Sort-Object Name)) {
  if ($p.Name -notlike '@gic/*') { $deps[$p.Name] = $p.Value }
}
$runtime = [ordered]@{ name = 'gic-agropelc-prod'; version = '1.0.0'; private = $true; type = 'module'; dependencies = $deps }
[System.IO.File]::WriteAllText("$stage\package.json", ($runtime | ConvertTo-Json -Depth 5), $utf8)

Write-Host '== Compilation des semis (CommonJS ; CAST(? AS JSON) remplace pour MariaDB)'
$seedFiles = @(Get-ChildItem "$repo\db\seeds\*.ts" | ForEach-Object { $_.FullName })
& "$repo\node_modules\.bin\tsc.cmd" --target ES2022 --module commonjs --moduleResolution node10 --esModuleInterop --skipLibCheck --typeRoots "$repo\db\node_modules\@types" --types node --outDir "$stage\seeds-dist" @seedFiles
if ($LASTEXITCODE -ne 0) { throw 'La compilation des semis a echoue.' }
foreach ($f in (Get-ChildItem "$stage\seeds-dist\*.js")) {
  $text = [System.IO.File]::ReadAllText($f.FullName)
  # '$$' : dans une chaine de remplacement .NET, '$''' insererait la suite du texte.
  $text = [regex]::Replace($text, 'CAST\(\?\s+AS\s+JSON\)', 'JSON_EXTRACT(?, ''$$'')')
  [System.IO.File]::WriteAllText($f.FullName, $text, $utf8)
}
[System.IO.File]::WriteAllText("$stage\seeds-dist\package.json", '{"type":"commonjs"}', $utf8)
if (-not (Test-Path "$stage\seeds-dist\run.js")) { throw 'seeds-dist\run.js absent apres la compilation.' }

Write-Host '== Archive'
if (Test-Path $bundle) { Remove-Item $bundle -Force }
tar -czf $bundle -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'tar a echoue.' }
$info = Get-Item $bundle
Write-Host ('Paquet : ' + $bundle)
Write-Host ('Taille : ' + [math]::Round($info.Length / 1MB, 2) + ' Mo')
Write-Host ('SHA-256 : ' + (Get-FileHash $bundle -Algorithm SHA256).Hash)
Write-Host ('Commit  : ' + (git rev-parse --short HEAD) + $(if (git status --porcelain) { ' (arbre de travail modifie)' } else { '' }))
