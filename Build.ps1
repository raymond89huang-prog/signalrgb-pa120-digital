# SPDX-License-Identifier: GPL-3.0-only
$ErrorActionPreference = 'Stop'

$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The 64-bit Windows .NET Framework C# compiler was not found.'
}

$outputDir = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$output = Join-Path $outputDir 'Pa120Telemetry.exe'
$source = Join-Path $PSScriptRoot 'Pa120Telemetry.cs'
$webExtensions = Join-Path $framework 'System.Web.Extensions.dll'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/reference:$webExtensions" "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "Compiler exited with code $LASTEXITCODE." }
Write-Output $output
