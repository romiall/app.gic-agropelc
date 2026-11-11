<#
  verify-all.ps1 - verification de TOUT le projet en une seule commande, jouee jusqu'au bout.
  PowerShell 5.1, fichier ASCII volontairement (PowerShell lit un script sans BOM en ANSI).

  Usage, depuis la racine du depot :
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-all.ps1

  Par defaut tout est joue, dans cet ordre, et une etape en echec n'arrete JAMAIS les suivantes :
    statique  types des cinq paquets, lint, format, frontieres de modules, references de la documentation,
              kit d'exploitation, couche de compatibilite MariaDB
    base      MySQL 8.4 (demarre s'il est arrete), migrations et semis sur la base jetable gic_agropelc_rp,
              types Kysely compares a la base migree, filet SQL MariaDB (corpus analyse par la base)
    essais    domaine, contrats, base, PWA, serveur : tous les fichiers (liste de `vitest list`), par lots, rapport
              JSON par lot ; un lot interrompu est rejoue en lots plus petits, de meme qu'un fichier inacheve (essais
              'pending' d'un worker arrete en cours de lot : jamais comptes comme ignores) ; un fichier en echec est
              rejoue seul, a froid ("instable" s'il passe seul, "en delai" s'il expire) ; une erreur non geree du
              lot (autre qu'un arret de worker) est un constat
    en ligne  sondes publiques en lecture seule (sante, service worker, accueil, routes protegees en 401)
  A la fin : un tableau par etape, les CONSTATS a analyser (fichier, essai, premiere erreur, journal), un verdict,
  code de sortie 0 (aucun echec) ou 1. Journaux dans %TEMP%\gic-verify-<horodatage> : resume.txt, progression.txt.

  Options : -Quick (statique et filet SQL seulement), -NoOnline, -Only <etapes separees par des virgules>,
            -ServerFiles <fichiers>, -LogDir <dossier>, -MySqlExe / -MySqlIni (serveur MySQL 8.4 a demarrer).
  Etapes : types lint format boundaries refs kit compat migrate seed schema corpus domain contracts db pwa server online
  Aucun fichier du depot n'est modifie : migrations sans export du schema, types Kysely generes dans le dossier
  temporaire. Jamais gic_agropelc_dev : seules les bases jetables _rp sont acceptees.
#>
param(
  [switch]$Quick,
  [switch]$NoOnline,
  [string[]]$Only = @(),
  [string[]]$ServerFiles = @(),
  [int]$BatchSize = 25,
  [string]$LogDir = '',
  [string]$OnlineUrl = 'https://app.gic-agropelc.com',
  [string]$MySqlExe = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe',
  [string]$MySqlIni = '',
  [switch]$Full,
  [switch]$Online
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$outDir = $LogDir
if (-not $outDir) { $outDir = Join-Path $env:TEMP ('gic-verify-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force $outDir | Out-Null
$progressFile = Join-Path $outDir 'progression.txt'
$startedAt = Get-Date
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONIOENCODING = 'utf-8'
$env:FORCE_COLOR = '0'
$env:NO_COLOR = '1'
Remove-Item Env:\GIC_SQL_CORPUS_DIR -ErrorAction SilentlyContinue

# --- etapes choisies -------------------------------------------------------------------------------------------------
$staticSteps = @('types', 'lint', 'format', 'boundaries', 'refs', 'kit', 'compat')
$baseSteps = @('migrate', 'seed', 'schema', 'corpus')
$testSteps = @('domain', 'contracts', 'db', 'pwa', 'server')
$selected = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
$onlyFiles = @($ServerFiles | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().Replace('\', '/') -replace '^(\./)?(apps/server/)?', '' } | Where-Object { $_ -ne '' })
if ($selected.Count -eq 0) {
  if ($Quick) { $selected = @($staticSteps) + @('corpus') }
  else {
    $selected = @($staticSteps) + @($baseSteps) + @($testSteps)
    if (-not $NoOnline) { $selected += 'online' }
  }
}
if ($onlyFiles.Count -gt 0 -and ($selected -notcontains 'server')) { $selected += 'server' }

# --- aides -----------------------------------------------------------------------------------------------------------
$results = New-Object System.Collections.ArrayList
$findings = New-Object System.Collections.ArrayList
$script:dbReady = $false
$script:dbMessage = 'base non preparee'
$script:unfinished = @{}   # par etape : fichiers dont un lot s'est arrete avant la fin de leurs essais (rejoues)
$script:workerExits = @{}  # par etape : lots dont un worker de vitest s'est arrete en cours de route
$script:unhandled = @{}    # par etape : erreurs non gerees des lots, autres qu'un arret de worker

function Write-Line([string]$text) {
  $stamped = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $text
  Write-Host $stamped
  try { Add-Content -Path $progressFile -Value $stamped -Encoding UTF8 } catch { }
}

function Add-Result([string]$name, [string]$status, [double]$seconds, [string]$detail) {
  [void]$results.Add([pscustomobject]@{ Etape = $name; Resultat = $status; Duree = ([string][int]$seconds + ' s'); Detail = $detail })
  Write-Line ('{0,-10} {1,-9} {2,6} s  {3}' -f $name, $status, [int]$seconds, $detail)
}

function Add-Finding([string]$name, [string]$text) {
  $clean = ($text -replace '\s+', ' ').Trim()
  if ($clean.Length -gt 400) { $clean = $clean.Substring(0, 400) + '...' }
  [void]$findings.Add($name + ' : ' + $clean)
}

function Invoke-Guarded([string]$name, [scriptblock]$body) {
  try { & $body } catch {
    Add-Result $name 'ECHEC' 0 ('erreur du script de verification : ' + $_.Exception.Message)
    Add-Finding $name ('erreur du script de verification : ' + $_.Exception.Message)
  }
}

function Invoke-Logged([string]$logFile, [string]$exe, [string[]]$arguments) {
  $global:LASTEXITCODE = 0
  & $exe @arguments 2>&1 |
    ForEach-Object { ("$_" -replace '\x1b\[[0-9;]*m', '') -replace 'mysql://[^@\s]+@', 'mysql://***@' } |
    Where-Object { $_ -notmatch '^\{"level"' -and $_ -ne 'System.Management.Automation.RemoteException' } |
    Out-File -FilePath $logFile -Append -Encoding utf8
  return $LASTEXITCODE
}

function Get-FirstErrors([string]$logFile, [int]$max) {
  if (-not (Test-Path $logFile)) { return '' }
  $lines = @(Select-String -Path $logFile -Pattern 'error TS|ERR!|Error:|FAIL|ECHEC|\berror\b|\[warn\]|AssertionError|REFUSEE|refusee' |
      Select-Object -First $max | ForEach-Object { $_.Line.Trim() })
  return ($lines -join ' / ')
}

function Get-EnvValue([string]$file, [string]$key) {
  if (-not (Test-Path $file)) { return $null }
  $line = Get-Content $file | Where-Object { $_ -match ('^\s*' + $key + '\s*=') } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -replace ('^\s*' + $key + '\s*=\s*'), '').Trim().Trim('"').Trim("'"))
}

function Test-Port([string]$hostName, [int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($hostName, $port, $null, $null)
    if ($async.AsyncWaitHandle.WaitOne(3000) -and $client.Connected) { return $true }
    return $false
  } catch { return $false } finally { $client.Close() }
}

try {
  Add-Type -Namespace GicVerify -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
} catch { }
function Set-Awake([bool]$on) {
  try {
    if ($on) { [void][GicVerify.Power]::SetThreadExecutionState([uint32]2147483649) } else { [void][GicVerify.Power]::SetThreadExecutionState([uint32]2147483648) }
  } catch { }
}

# Une etape ordinaire : une commande, un journal, une ligne de resume ; en echec, un constat.
function Invoke-Step([string]$name, [string]$exe, [string[]]$arguments, [scriptblock]$summarize, [string]$workRel) {
  if ($selected -notcontains $name) { return }
  $log = Join-Path $outDir ($name + '.log')
  Write-Line ($name + ' ...')
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $workDir = $repo
  if ($workRel) { $workDir = Join-Path $repo $workRel }
  Push-Location $workDir
  try { $code = Invoke-Logged $log $exe $arguments } finally { Pop-Location }
  $watch.Stop()
  if ($code -ne 0) {
    $errors = Get-FirstErrors $log 3
    Add-Result $name 'ECHEC' $watch.Elapsed.TotalSeconds ('code ' + $code + ' -> ' + $log)
    Add-Finding $name ($errors + ' -> ' + $log)
  } else {
    $detail = [string](& $summarize $log $code)
    Add-Result $name 'OK' $watch.Elapsed.TotalSeconds $detail
  }
}

function Invoke-DbStep([string]$name, [string]$exe, [string[]]$arguments, [scriptblock]$summarize, [string]$workRel) {
  if ($selected -notcontains $name) { return }
  if (-not $script:dbReady) { Add-Result $name 'ECHEC' 0 $script:dbMessage; Add-Finding $name $script:dbMessage; return }
  Invoke-Step $name $exe $arguments $summarize $workRel
}

# --- base jetable : adresses, MySQL 8.4 demarre au besoin ------------------------------------------------------------
function Initialize-Database {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $serverUrl = Get-EnvValue (Join-Path $repo 'apps\server\.env') 'SERVER_DATABASE_URL'
  $migrateUrl = Get-EnvValue (Join-Path $repo 'db\.env') 'DATABASE_URL'
  if (-not $serverUrl -or -not $migrateUrl) {
    $script:dbMessage = 'apps\server\.env ou db\.env absent ou incomplet'
    Add-Result 'mysql' 'ECHEC' 0 $script:dbMessage
    Add-Finding 'mysql' $script:dbMessage
    return
  }
  $env:SERVER_DATABASE_URL = ($serverUrl -replace '/[^/?]+(\?.*)?$', '/gic_agropelc_rp$1')
  $env:DATABASE_URL = ($migrateUrl -replace '/[^/?]+(\?.*)?$', '/gic_agropelc_rp$1')
  if ($env:SERVER_DATABASE_URL -notmatch '_rp(\?|$)' -or $env:DATABASE_URL -notmatch '_rp(\?|$)') {
    $script:dbMessage = 'base refusee : seules les bases jetables _rp sont acceptees'
    Add-Result 'mysql' 'ECHEC' 0 $script:dbMessage
    Add-Finding 'mysql' $script:dbMessage
    return
  }
  $hit = [regex]::Match($env:SERVER_DATABASE_URL, '@([^:/@]+):(\d+)/')
  $dbHost = '127.0.0.1'
  $dbPort = 3307
  if ($hit.Success) { $dbHost = $hit.Groups[1].Value; $dbPort = [int]$hit.Groups[2].Value }
  $started = ''
  if (-not (Test-Port $dbHost $dbPort)) {
    $ini = $MySqlIni
    if (-not $ini) { $ini = Join-Path $env:USERPROFILE 'mysql84\my.ini' }
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'mysqld.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($ini) })
    if ($running.Count -eq 0) {
      if ((Test-Path $MySqlExe) -and (Test-Path $ini)) {
        Write-Line ('mysql : MySQL 8.4 arrete, demarrage detache (' + $ini + ')')
        Start-Process -FilePath $MySqlExe -ArgumentList ('--defaults-file="' + $ini + '"') -WindowStyle Hidden
        $started = ' (demarre par le script)'
      } else {
        $script:dbMessage = 'MySQL 8.4 arrete et introuvable (' + $MySqlExe + ', ' + $ini + ')'
        Add-Result 'mysql' 'ECHEC' $watch.Elapsed.TotalSeconds $script:dbMessage
        Add-Finding 'mysql' $script:dbMessage
        return
      }
    }
    for ($i = 0; $i -lt 72; $i++) {
      if (Test-Port $dbHost $dbPort) { break }
      Start-Sleep -Seconds 5
    }
  }
  if (Test-Port $dbHost $dbPort) {
    $script:dbReady = $true
    Add-Result 'mysql' 'OK' $watch.Elapsed.TotalSeconds ('MySQL 8.4 joignable sur ' + $dbHost + ':' + $dbPort + $started + ', base jetable gic_agropelc_rp')
  } else {
    $script:dbMessage = 'MySQL 8.4 ne repond pas sur ' + $dbHost + ':' + $dbPort + ' apres 6 minutes'
    Add-Result 'mysql' 'ECHEC' $watch.Elapsed.TotalSeconds $script:dbMessage
    Add-Finding 'mysql' $script:dbMessage
  }
}

function Get-BaseSize {
  $probe = Join-Path $outDir 'taille-base.cjs'
  @'
const { createRequire } = require('module');
const req = createRequire(process.argv[2]);
const mysql = req('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ uri: process.env.DATABASE_URL, timezone: 'Z' });
  const [[s]] = await c.query('SELECT ROUND(SUM(data_length + index_length) / 1048576) AS mo FROM information_schema.tables WHERE table_schema = DATABASE()');
  const [[d]] = await c.query('SELECT COUNT(*) AS n FROM identity_devices');
  console.log(s.mo + ' Mo, ' + d.n + ' appareils');
  await c.end();
})().catch((e) => { console.log('inconnue (' + String(e.message).slice(0, 80) + ')'); });
'@ | Out-File -FilePath $probe -Encoding ascii
  try { return [string](& node $probe (Join-Path $repo 'apps\server\package.json') 2>$null) } catch { return 'inconnue' }
}

# --- etapes particulieres --------------------------------------------------------------------------------------------
function Invoke-RefsStep {
  if ($selected -notcontains 'refs') { return }
  $python = $null
  foreach ($candidate in @('python', 'python3', 'py')) {
    $answer = ''
    try { $answer = [string](& $candidate --version 2>&1) } catch { $answer = '' }
    if ($answer -match 'Python 3') { $python = $candidate; break }
  }
  if (-not $python) { Add-Result 'refs' 'ECHEC' 0 'Python 3 introuvable (python, python3, py)'; Add-Finding 'refs' 'Python 3 introuvable'; return }
  Invoke-Step 'refs' $python @('docs/_tools/check_refs.py') { param($log, $code) 'aucune reference orpheline, aucun identifiant en double, aucun lien casse' } ''
}

function Invoke-SchemaStep {
  if ($selected -notcontains 'schema') { return }
  if (-not $script:dbReady) { Add-Result 'schema' 'ECHEC' 0 $script:dbMessage; Add-Finding 'schema' $script:dbMessage; return }
  $log = Join-Path $outDir 'schema.log'
  $generated = Join-Path $outDir 'schema.generated.rp.ts'
  $committed = Join-Path $repo 'apps\server\src\platform\kysely\schema.generated.ts'
  Write-Line 'schema ...'
  $watch = [Diagnostics.Stopwatch]::StartNew()
  Push-Location (Join-Path $repo 'apps\server')
  try { $code = Invoke-Logged $log 'npx' @('kysely-codegen', '--dialect', 'mysql', '--out-file', $generated) } finally { Pop-Location }
  $watch.Stop()
  if ($code -ne 0 -or -not (Test-Path $generated)) {
    Add-Result 'schema' 'ECHEC' $watch.Elapsed.TotalSeconds ('generation des types Kysely impossible (code ' + $code + ') -> ' + $log)
    Add-Finding 'schema' ((Get-FirstErrors $log 3) + ' -> ' + $log)
    return
  }
  $keep = { param($path) @(Get-Content $path | ForEach-Object { ($_ -replace '\s+', ' ').Trim() } | Where-Object { $_ -ne '' -and $_ -notmatch '^(//|/\*|\*)' }) }
  $diff = @(Compare-Object -ReferenceObject (& $keep $committed) -DifferenceObject (& $keep $generated))
  if ($diff.Count -eq 0) {
    Add-Result 'schema' 'OK' $watch.Elapsed.TotalSeconds 'types Kysely du depot identiques a la base jetable migree'
  } else {
    $sample = @($diff | Select-Object -First 4 | ForEach-Object { $(if ($_.SideIndicator -eq '<=') { 'depot: ' } else { 'base: ' }) + $_.InputObject }) -join ' | '
    Add-Result 'schema' 'ECHEC' $watch.Elapsed.TotalSeconds ([string]$diff.Count + ' ligne(s) differente(s) entre schema.generated.ts et la base -> ' + $generated)
    Add-Finding 'schema' ($sample + ' -> ' + $generated)
  }
}

function Invoke-CorpusStep {
  if ($selected -notcontains 'corpus') { return }
  if (-not $script:dbReady) { Add-Result 'corpus' 'ECHEC' 0 $script:dbMessage; Add-Finding 'corpus' $script:dbMessage; return }
  $log = Join-Path $outDir 'corpus.log'
  Write-Line 'corpus ...'
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $work = Join-Path $outDir 'corpus-check'
  New-Item -ItemType Directory -Force $work | Out-Null
  Copy-Item (Join-Path $repo 'deploy\hostinger\check-sql-corpus.mjs') (Join-Path $work 'check-sql-corpus.mjs') -Force
  $link = Join-Path $work 'node_modules'
  $code = 1
  try {
    if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target (Join-Path $repo 'apps\server\node_modules') | Out-Null }
    $env:SQL_CORPUS_FILE = Join-Path $repo 'deploy\hostinger\sql-corpus.json'
    $env:SQL_CORPUS_KNOWN_FILE = Join-Path $repo 'deploy\hostinger\sql-corpus-known.json'
    Push-Location $work
    try { $code = Invoke-Logged $log 'node' @('check-sql-corpus.mjs') } finally { Pop-Location }
  } finally {
    if (Test-Path $link) { [System.IO.Directory]::Delete($link) }
    Remove-Item Env:\SQL_CORPUS_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:\SQL_CORPUS_KNOWN_FILE -ErrorAction SilentlyContinue
  }
  $watch.Stop()
  $line = Select-String -Path $log -Pattern 'requete\(s\) du corpus' | Select-Object -First 1
  $refused = Select-String -Path $log -Pattern 'refusees 0\b' | Select-Object -First 1
  if ($code -eq 0 -and $line -and $refused) {
    Add-Result 'corpus' 'OK' $watch.Elapsed.TotalSeconds ($line.Line.Trim() + ' (MySQL 8.4 ; la MariaDB en ligne les analyse a chaque livraison)')
  } else {
    Add-Result 'corpus' 'ECHEC' $watch.Elapsed.TotalSeconds ('requetes refusees ou controle impossible (code ' + $code + ') -> ' + $log)
    Add-Finding 'corpus' ((Get-FirstErrors $log 4) + ' -> ' + $log)
  }
}

# --- essais : lots, rapport JSON, reprise des lots interrompus, rejeu a froid des echecs -----------------------------
function Read-VitestJson([string]$jsonFile, [string]$prefix, [hashtable]$state, [string]$logFile, [string]$name) {
  if (-not (Test-Path $jsonFile)) { return 0 }
  try { $doc = Get-Content -Raw -Path $jsonFile | ConvertFrom-Json } catch { return 0 }
  $count = 0
  foreach ($tr in $doc.testResults) {
    $fullName = ([string]$tr.name).Replace('\', '/')
    $rel = $fullName
    if ($fullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { $rel = $fullName.Substring($prefix.Length) }
    $passed = 0
    $failed = 0
    $skipped = 0
    $unfinished = 0
    $message = ''
    $failedTest = ''
    foreach ($a in $tr.assertionResults) {
      $st = [string]$a.status
      if ($st -eq 'passed') { $passed++ }
      elseif ($st -eq 'failed') {
        $failed++
        if (-not $message) {
          $failedTest = [string]$a.fullName
          if ($a.failureMessages) { $message = [string]($a.failureMessages | Select-Object -First 1) }
        }
      }
      elseif ($st -eq 'skipped' -or $st -eq 'todo' -or $st -eq 'disabled') { $skipped++ }
      else { $unfinished++ }
    }
    # Essais 'pending' : jamais termines (worker arrete en cours de lot, 10/11/2026 : 17 essais du stock comptes comme
    # ignores). Le fichier n'entre pas dans l'etat : le tour suivant le rejoue (lot de 5, puis seul).
    if ($unfinished -gt 0) {
      if (-not $script:unfinished.ContainsKey($name)) { $script:unfinished[$name] = @() }
      if ($script:unfinished[$name] -notcontains $rel) { $script:unfinished[$name] += $rel }
      continue
    }
    if ([string]$tr.status -eq 'failed' -and -not $message) { $message = [string]$tr.message }
    $state[$rel] = [pscustomobject]@{ Status = [string]$tr.status; Passed = $passed; Failed = $failed; Skipped = $skipped; Test = $failedTest; Message = $message; Log = $logFile }
    $count++
  }
  return $count
}

# Erreurs non gerees d'un lot (sections "Unhandled Error" et "Unhandled Rejection" du journal de vitest) : premiere
# ligne de chacune. Un arret de worker y figure aussi ("Worker exited unexpectedly").
function Get-UnhandledErrors([string]$log) {
  if (-not (Test-Path $log)) { return @() }
  $lines = @(Get-Content -Path $log -Encoding UTF8)
  $found = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ([string]$lines[$i] -cmatch '^\W+ Unhandled (Error|Rejection) \W+$') {
      for ($j = $i + 1; $j -lt $lines.Count; $j++) {
        $text = ([string]$lines[$j]).Trim()
        if ($text -ne '') { $found += $text; break }
      }
    }
  }
  return $found
}

function Invoke-VitestBatch([string]$name, [string]$pkgDir, [string]$prefix, [string]$tag, [string[]]$chunk, [string[]]$extra, [hashtable]$state) {
  $log = Join-Path $outDir ($name + '-' + $tag + '.log')
  $json = Join-Path $outDir ($name + '-' + $tag + '.json')
  Write-Line ('  ' + $name + ' ' + $tag + ' : ' + $chunk.Count + ' fichier(s)')
  $vitestArgs = @('vitest', 'run', '--reporter=default', '--reporter=json', ('--outputFile.json=' + $json.Replace('\', '/'))) + $extra + $chunk
  Push-Location $pkgDir
  try { [void](Invoke-Logged $log 'npx' $vitestArgs) } finally { Pop-Location }
  foreach ($err in @(Get-UnhandledErrors $log)) {
    if ($err -match 'Worker exited unexpectedly|vitest-pool') {
      if (-not $script:workerExits.ContainsKey($name)) { $script:workerExits[$name] = @() }
      $script:workerExits[$name] += $tag
    } else {
      if (-not $script:unhandled.ContainsKey($name)) { $script:unhandled[$name] = @() }
      $script:unhandled[$name] += ('lot ' + $tag + ' : ' + $err + ' -> ' + $log)
    }
  }
  return (Read-VitestJson $json $prefix $state $log $name)
}

function Join-Names([string[]]$names, [int]$max) {
  $shown = @($names | Select-Object -First $max)
  $text = ($shown -join ', ')
  if ($names.Count -gt $max) { $text += ' (+' + ($names.Count - $max) + ')' }
  return $text
}

function Get-FirstLine([string]$text) {
  if (-not $text) { return '' }
  $first = (($text -split "`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -First 1)
  return ([string]$first).Trim()
}

function Invoke-VitestSuite([string]$name, [string]$relDir, [int]$chunkSize, [string[]]$extra, [bool]$needsDb, [string[]]$restrict) {
  if ($selected -notcontains $name) { return }
  if ($needsDb -and -not $script:dbReady) { Add-Result $name 'ECHEC' 0 $script:dbMessage; Add-Finding $name $script:dbMessage; return }
  Write-Line ($name + ' ...')
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $pkgDir = Join-Path $repo $relDir
  $prefix = $pkgDir.Replace('\', '/').TrimEnd('/') + '/'
  $all = @()
  if ($restrict -and $restrict.Count -gt 0) {
    $all = @($restrict)
  } else {
    Push-Location $pkgDir
    try { $raw = @(& npx vitest list --filesOnly 2>$null) } finally { Pop-Location }
    $all = @($raw | ForEach-Object { ("$_" -replace '\x1b\[[0-9;]*m', '').Trim().Replace('\', '/') } |
        Where-Object { $_ -match '\.(test|spec)\.(ts|tsx|mts|js|mjs)$' } | Sort-Object -Unique)
  }
  if ($all.Count -eq 0) {
    Add-Result $name 'ECHEC' $watch.Elapsed.TotalSeconds 'aucun fichier d essai trouve (vitest list)'
    Add-Finding $name 'aucun fichier d essai trouve par vitest list'
    return
  }

  $state = @{}
  $pending = @($all)
  $round = 0
  foreach ($size in @($chunkSize, 5, 1)) {
    if ($pending.Count -eq 0) { break }
    $round++
    $part = 0
    for ($i = 0; $i -lt $pending.Count; $i += $size) {
      $part++
      $last = [Math]::Min($i + $size, $pending.Count) - 1
      [void](Invoke-VitestBatch $name $pkgDir $prefix ('r' + $round + '-' + $part) @($pending[$i..$last]) $extra $state)
    }
    $pending = @($all | Where-Object { -not $state.ContainsKey($_) })
  }

  # Un fichier en echec est rejoue seul, a froid, une fois.
  $unstable = @()
  $firstRuns = @{}
  $failing = @($all | Where-Object { $state.ContainsKey($_) -and ($state[$_].Status -eq 'failed' -or $state[$_].Failed -gt 0) })
  foreach ($file in $failing) {
    $firstRuns[$file] = $state[$file]
    $again = @{}
    [void](Invoke-VitestBatch $name $pkgDir $prefix ('seul-' + ($file -replace '[^A-Za-z0-9]', '_')) @($file) $extra $again)
    if ($again.ContainsKey($file)) {
      if ($again[$file].Status -ne 'failed' -and $again[$file].Failed -eq 0) { $unstable += $file }
      $state[$file] = $again[$file]
    }
  }

  $missing = @($all | Where-Object { -not $state.ContainsKey($_) })
  $bad = @($all | Where-Object { $state.ContainsKey($_) -and ($state[$_].Status -eq 'failed' -or $state[$_].Failed -gt 0) })
  $timeouts = @($bad | Where-Object { $state[$_].Message -match 'timed out' })
  $other = @($bad | Where-Object { $timeouts -notcontains $_ })
  $passedSum = 0
  $failedSum = 0
  $skippedSum = 0
  foreach ($key in $state.Keys) { $passedSum += $state[$key].Passed; $failedSum += $state[$key].Failed; $skippedSum += $state[$key].Skipped }
  $report = @()
  foreach ($file in $all) {
    if ($state.ContainsKey($file)) { $report += ('{0,-8} {1,5} ok {2,3} ko {3,3} ignores  {4}' -f $state[$file].Status, $state[$file].Passed, $state[$file].Failed, $state[$file].Skipped, $file) }
    else { $report += ('NON-EXEC                               {0}' -f $file) }
  }
  $report | Out-File -FilePath (Join-Path $outDir ($name + '-fichiers.txt')) -Encoding utf8

  foreach ($file in $bad) {
    $kind = 'EN ECHEC'
    if ($timeouts -contains $file) { $kind = 'EN DELAI' }
    Add-Finding $name ($kind + ' ' + $file + ' > ' + $state[$file].Test + ' : ' + (Get-FirstLine $state[$file].Message) + ' -> ' + $state[$file].Log)
  }
  foreach ($file in $unstable) {
    Add-Finding $name ('INSTABLE ' + $file + ' (echoue en lot, passe seul) > ' + $firstRuns[$file].Test + ' : ' + (Get-FirstLine $firstRuns[$file].Message) + ' -> ' + $firstRuns[$file].Log)
  }
  foreach ($file in $missing) { Add-Finding $name ('NON EXECUTE ' + $file + ' (inacheve ou sans rapport, meme seul)') }
  $errors = @()
  if ($script:unhandled.ContainsKey($name)) { $errors = @($script:unhandled[$name]) }
  foreach ($err in $errors) { Add-Finding $name ('ERREUR NON GEREE ' + $err) }
  $exits = @()
  if ($script:workerExits.ContainsKey($name)) { $exits = @($script:workerExits[$name]) }
  $rerun = @()
  if ($script:unfinished.ContainsKey($name)) { $rerun = @($script:unfinished[$name] | Where-Object { $state.ContainsKey($_) }) }

  $detail = ('{0} fichiers, {1} essais passes, {2} echoues, {3} ignores' -f $all.Count, $passedSum, $failedSum, $skippedSum)
  if ($unstable.Count -gt 0) { $detail += ' ; instables : ' + (Join-Names $unstable 4) }
  if ($timeouts.Count -gt 0) { $detail += ' ; en delai : ' + (Join-Names $timeouts 4) }
  if ($other.Count -gt 0) { $detail += ' ; en echec : ' + (Join-Names $other 4) }
  if ($missing.Count -gt 0) { $detail += ' ; non executes : ' + (Join-Names $missing 4) }
  if ($exits.Count -gt 0) { $detail += ' ; worker arrete en cours de lot (' + (Join-Names $exits 3) + ')' }
  if ($rerun.Count -gt 0) { $detail += ' ; fichiers inacheves rejoues : ' + (Join-Names $rerun 4) }
  if ($errors.Count -gt 0) { $detail += ' ; erreurs non gerees : ' + $errors.Count }
  $status = 'OK'
  if ($unstable.Count -gt 0 -or $errors.Count -gt 0) { $status = 'ATTENTION' }
  if ($bad.Count -gt 0 -or $missing.Count -gt 0) { $status = 'ECHEC' }
  Add-Result $name $status $watch.Elapsed.TotalSeconds $detail
}

# --- sondes publiques de la version en ligne (lecture seule, sans jeton) ---------------------------------------------
function Get-Http([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 25 -MaximumRedirection 0 -ErrorAction Stop
    return [pscustomobject]@{ Code = [int]$r.StatusCode; Body = [string]$r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return [pscustomobject]@{ Code = [int]$resp.StatusCode; Body = '' } }
    return [pscustomobject]@{ Code = 0; Body = '' }
  }
}

function Invoke-OnlineStep {
  if ($selected -notcontains 'online') { return }
  Write-Line 'online ...'
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
  $base = $OnlineUrl.TrimEnd('/')
  $problems = @()
  $count = 0

  $count++
  $ready = Get-Http ($base + '/health/ready')
  if ($ready.Code -ne 200) { $problems += ('health/ready repond ' + $ready.Code) }
  else {
    $json = $null
    try { $json = $ready.Body | ConvertFrom-Json } catch { }
    if (-not $json -or $json.status -ne 'ok') { $problems += 'health/ready : statut non ok' }
    elseif ([int]$json.checks.failed_jobs -ne 0) { $problems += ('health/ready : failed_jobs ' + $json.checks.failed_jobs) }
  }

  $count++
  $worker = Get-Http ($base + '/sw.js')
  if ($worker.Code -ne 200 -or $worker.Body.Length -lt 5000 -or $worker.Body.TrimStart().StartsWith('<')) { $problems += ('sw.js ' + $worker.Code + ' (taille ' + $worker.Body.Length + ')') }

  $count++
  $front = Get-Http ($base + '/')
  if ($front.Code -ne 200) { $problems += ('page d accueil ' + $front.Code) }

  foreach ($path in @('/api/v1/attachment-archives/catalog', '/api/v1/notifications/push-key', '/api/v1/devices')) {
    $count++
    $probe = Get-Http ($base + $path)
    if ($probe.Code -ne 401) { $problems += ($path + ' : ' + $probe.Code + ' au lieu de 401 sans jeton') }
  }
  $watch.Stop()
  if ($problems.Count -eq 0) { Add-Result 'online' 'OK' $watch.Elapsed.TotalSeconds ([string]$count + ' sondes conformes sur ' + $base + ' (sante, sw.js, accueil, routes protegees en 401)') }
  else {
    Add-Result 'online' 'ECHEC' $watch.Elapsed.TotalSeconds ($problems -join ' ; ')
    foreach ($p in $problems) { Add-Finding 'online' $p }
  }
}

# --- deroulement : chaque etape est gardee, un echec n'arrete jamais la suite ------------------------------------------
$commit = [string](& git -C $repo rev-parse --short HEAD 2>$null)
$branch = [string](& git -C $repo rev-parse --abbrev-ref HEAD 2>$null)
$dirty = @(& git -C $repo status --porcelain --untracked-files=no 2>$null).Count
$baseSize = ''
$timeoutArgs = @('--maxWorkers=1', '--minWorkers=1', '--testTimeout=120000', '--hookTimeout=120000')
Set-Awake $true
try {
  Write-Line ('verification : ' + ($selected -join ' ') + ' ; depot ' + $branch + ' @ ' + $commit + ' (' + $dirty + ' fichier(s) suivis modifies)')

  Invoke-Guarded 'types' { Invoke-Step 'types' 'pnpm' @('-r', 'run', 'typecheck') { param($log, $code) 'cinq paquets (domaine, contrats, base, PWA, serveur)' } '' }
  Invoke-Guarded 'lint' {
    Invoke-Step 'lint' 'npx' @('eslint', 'apps', 'packages', 'db') { param($log, $code)
      $hit = Select-String -Path $log -Pattern '\d+ problems?' | Select-Object -Last 1
      if ($hit) { $hit.Line.Trim() } else { '0 probleme' }
    } ''
  }
  Invoke-Guarded 'format' {
    $globs = @('apps/**/*.{ts,tsx,css,json,mjs,cjs,js}', 'packages/**/*.{ts,json}', 'db/**/*.{ts,json,mjs}', 'deploy/**/*.{mjs,json}')
    Invoke-Step 'format' 'npx' (@('prettier', '--check', '--end-of-line', 'auto') + $globs) { param($log, $code) 'format Prettier conforme' } ''
  }
  Invoke-Guarded 'boundaries' { Invoke-Step 'boundaries' 'pnpm' @('run', 'check:boundaries') { param($log, $code) 'aucune violation de frontiere de module' } '' }
  Invoke-Guarded 'refs' { Invoke-RefsStep }
  Invoke-Guarded 'kit' { Invoke-Step 'kit' 'pnpm' @('run', 'check:deploy-kit') { param($log, $code) 'essais statiques du kit d exploitation' } '' }
  Invoke-Guarded 'compat' { Invoke-Step 'compat' 'node' @('deploy/hostinger/test-mariadb-compat.mjs') { param($log, $code) 'reecritures MariaDB verifiees sur le SQL compile par Kysely' } '' }

  if (@($baseSteps + @('db', 'server')) | Where-Object { $selected -contains $_ }) {
    Invoke-Guarded 'mysql' { Initialize-Database }
    if ($script:dbReady) { $baseSize = Get-BaseSize; Write-Line ('base jetable : ' + $baseSize) }
  }
  Invoke-Guarded 'migrate' {
    Invoke-DbStep 'migrate' 'npx' @('dbmate', '--no-dump-schema', '--migrations-dir', './migrations', 'up') { param($log, $code)
      $n = @(Select-String -Path $log -Pattern '^Applying').Count
      if ($n -gt 0) { [string]$n + ' migration(s) appliquee(s) a la base jetable' } else { 'base jetable a jour, aucune migration en attente' }
    } 'db'
  }
  Invoke-Guarded 'seed' {
    Invoke-DbStep 'seed' 'pnpm' @('run', 'db:seed') { param($log, $code)
      $tail = @(Get-Content $log | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1)
      $text = 'semis rejoues sans erreur'
      if ($tail.Count -gt 0) { $text += ' (' + $tail[0].Trim() + ')' }
      if ($text.Length -gt 220) { $text = $text.Substring(0, 220) + '...' }
      $text
    } ''
  }
  Invoke-Guarded 'schema' { Invoke-SchemaStep }
  Invoke-Guarded 'corpus' { Invoke-CorpusStep }

  Invoke-Guarded 'domain' { Invoke-VitestSuite 'domain' 'packages\domain' 500 @('--maxWorkers=2', '--minWorkers=1') $false @() }
  Invoke-Guarded 'contracts' { Invoke-VitestSuite 'contracts' 'packages\contracts' 500 @('--maxWorkers=2', '--minWorkers=1') $false @() }
  Invoke-Guarded 'db' { Invoke-VitestSuite 'db' 'db' 500 @('--maxWorkers=1', '--minWorkers=1') $true @() }
  Invoke-Guarded 'pwa' { Invoke-VitestSuite 'pwa' 'apps\pwa' 60 $timeoutArgs $false @() }
  Invoke-Guarded 'server' { Invoke-VitestSuite 'server' 'apps\server' $BatchSize $timeoutArgs $true $onlyFiles }
  Invoke-Guarded 'online' { Invoke-OnlineStep }
} finally {
  Set-Awake $false
  Set-Location $repo
}

# --- verdict ---------------------------------------------------------------------------------------------------------
$elapsed = (Get-Date) - $startedAt
$ko = @($results | Where-Object { $_.Resultat -eq 'ECHEC' })
$attention = @($results | Where-Object { $_.Resultat -eq 'ATTENTION' })
$lines = @()
$lines += ''
$lines += ('=== VERIFICATION DU PROJET - ' + (Get-Date -Format 'dd/MM/yyyy HH:mm') + ' - duree ' + [int]$elapsed.TotalMinutes + ' min ===')
$lines += ('depot ' + $branch + ' @ ' + $commit + ' (' + $dirty + ' fichier(s) suivis modifies) ; base jetable : ' + $baseSize)
foreach ($r in $results) { $lines += ('{0,-10} {1,-9} {2,8}  {3}' -f $r.Etape, $r.Resultat, $r.Duree, $r.Detail) }
$lines += ''
if ($findings.Count -gt 0) {
  $lines += ('CONSTATS A ANALYSER (' + $findings.Count + ') :')
  $n = 0
  foreach ($f in $findings) { $n++; $lines += ('  ' + $n + '. ' + $f) }
} else {
  $lines += 'CONSTATS A ANALYSER : aucun'
}
$lines += ''
if ($ko.Count -eq 0 -and $attention.Count -eq 0) { $lines += 'VERDICT : OK' }
elseif ($ko.Count -eq 0) { $lines += 'VERDICT : OK avec attention (voir les constats)' }
else { $lines += ('VERDICT : ECHEC (' + $ko.Count + ' etape(s)) - voir les constats') }
$lines += ('Journaux : ' + $outDir + '  (rejouer une etape : -Only <nom>)')
$lines | Out-File -FilePath (Join-Path $outDir 'resume.txt') -Encoding utf8
$lines | ForEach-Object { Write-Host $_ }
if ($ko.Count -eq 0) { exit 0 } else { exit 1 }
