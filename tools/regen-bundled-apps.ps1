param()

$ErrorActionPreference = 'Stop'

$adventurePath = Join-Path $PSScriptRoot '..\apps\adventure.dapp'
$tetrisPath = Join-Path $PSScriptRoot '..\apps\tetris.dapp'
$docSrcPath = Join-Path $PSScriptRoot '..\docs\DAPP.txt'
$outPath = Join-Path $PSScriptRoot '..\BundledApps.h'

$adventureSrc = Get-Content $adventurePath -Raw
$tetrisSrc = Get-Content $tetrisPath -Raw
$docSrc = Get-Content $docSrcPath -Raw

$header = "#pragma once`r`n`r`n"
$header += "// Generated from apps/adventure.dapp for firmware-side LittleFS seeding.`r`n"
$header += "static const char BUNDLED_APP_ADVENTURE[] = R`"DSAPP(" + $adventureSrc + ")DSAPP`";`r`n`r`n"
$header += "// Generated from apps/tetris.dapp for firmware-side LittleFS seeding.`r`n"
$header += "static const char BUNDLED_APP_TETRIS[] = R`"DSAPP(" + $tetrisSrc + ")DSAPP`";`r`n`r`n"
$header += "// Generated from docs/DAPP.txt for firmware-side LittleFS seeding.`r`n"
$header += "static const char BUNDLED_DOC_DAPP[] = R`"DSDOC(" + $docSrc + ")DSDOC`";`r`n"

Set-Content -Path $outPath -Value $header -NoNewline
