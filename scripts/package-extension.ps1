[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageManifest = Get-Content -LiteralPath (Join-Path $packageRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($packageManifest.manifest_version -ne 3) {
    throw 'Only Manifest V3 packages are supported.'
}
if ($packageManifest.version -notmatch '^\d+(\.\d+){0,3}$') {
    throw 'The manifest must contain a valid numeric Chrome extension version.'
}

# An explicit allowlist prevents source-control metadata, tests, private settings,
# documentation, and screenshots from accidentally entering the upload package.
$packageFiles = @(
    'manifest.json',
    'background.js',
    'content.js',
    'content.css',
    'popup.html',
    'popup.css',
    'popup.js',
    'LICENSE'
)
if ($packageManifest.icons) {
    $packageFiles += @($packageManifest.icons.PSObject.Properties | ForEach-Object { [string]$_.Value })
}
if ($packageManifest.action.default_icon -is [string]) {
    $packageFiles += $packageManifest.action.default_icon
} elseif ($packageManifest.action.default_icon) {
    $packageFiles += @($packageManifest.action.default_icon.PSObject.Properties | ForEach-Object { [string]$_.Value })
}
$packageFiles = @($packageFiles | Select-Object -Unique)
$packageRootPrefix = $packageRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
foreach ($packageRelativePath in $packageFiles) {
    $packageSource = [System.IO.Path]::GetFullPath((Join-Path $packageRoot $packageRelativePath))
    if (-not $packageSource.StartsWith($packageRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "A package asset points outside the repository: $packageRelativePath"
    }
    if (-not (Test-Path -LiteralPath $packageSource -PathType Leaf)) {
        throw "Missing package asset: $packageRelativePath"
    }
}

$packageOutputDirectory = Join-Path $packageRoot 'dist'
$packageOutput = Join-Path $packageOutputDirectory ("uestc-course-playback-assistant-v{0}.zip" -f $packageManifest.version)
if (Test-Path -LiteralPath $packageOutput) {
    throw "The package already exists; it will not be overwritten: $packageOutput"
}
$null = New-Item -ItemType Directory -Path $packageOutputDirectory -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$packageArchive = [System.IO.Compression.ZipFile]::Open($packageOutput, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($packageRelativePath in $packageFiles) {
        $packageSource = Join-Path $packageRoot $packageRelativePath
        $packageEntryName = $packageRelativePath.Replace('\', '/')
        $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $packageArchive,
            $packageSource,
            $packageEntryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        )
    }
} finally {
    $packageArchive.Dispose()
}

[pscustomobject]@{
    Version = [string]$packageManifest.version
    Path = $packageOutput
    SizeBytes = (Get-Item -LiteralPath $packageOutput).Length
    SHA256 = (Get-FileHash -LiteralPath $packageOutput -Algorithm SHA256).Hash
    Files = $packageFiles
}
