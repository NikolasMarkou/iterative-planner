# build.ps1 - PowerShell build script for Iterative Planner Claude Skill
# Usage: .\build.ps1 [command]
# Commands: build, build-combined, package, validate, clean, list, help

param(
    [Parameter(Position=0)]
    [string]$Command = "help"
)

$SkillName = "iterative-planner"
$Version = (Get-Content "$PSScriptRoot/VERSION" -Raw).Trim()
$BuildDir = "build"
$DistDir = "dist"

function Show-Help {
    Write-Host "Iterative Planner Skill - Build Script" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage: .\build.ps1 [command]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  build            - Build skill package structure"
    Write-Host "  build-combined   - Build single-file skill with inlined references"
    Write-Host "  package          - Create zip package"
    Write-Host "  package-combined - Create single-file skill in dist/"
    Write-Host "  package-tar      - Create tarball package"
    Write-Host "  validate         - Validate skill structure"
    Write-Host "  lint             - Check script syntax"
    Write-Host "  test             - Run tests"
    Write-Host "  clean            - Remove build artifacts"
    Write-Host "  list             - Show package contents"
    Write-Host "  help             - Show this help"
    Write-Host ""
    Write-Host "Skill: $SkillName v$Version" -ForegroundColor Green
}

function Invoke-Build {
    Write-Host "Building skill package: $SkillName" -ForegroundColor Yellow

    # Create directories
    $skillDir = Join-Path $BuildDir $SkillName
    New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$skillDir/references" | Out-Null
    New-Item -ItemType Directory -Force -Path "$skillDir/scripts" | Out-Null

    # Copy main skill file
    Copy-Item "src/SKILL.md" $skillDir

    # Copy reference files
    Copy-Item "src/references/*.md" "$skillDir/references/"

    # Copy scripts
    Copy-Item "src/scripts/*.mjs" "$skillDir/scripts/"

    # Copy documentation
    @("README.md", "LICENSE", "CHANGELOG.md") | ForEach-Object {
        if (Test-Path $_) {
            Copy-Item $_ $skillDir
        }
    }

    Write-Host "Build complete: $skillDir" -ForegroundColor Green
}

function Invoke-BuildCombined {
    Write-Host "Building combined single-file skill..." -ForegroundColor Yellow

    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

    $outputFile = Join-Path $BuildDir "$SkillName-combined.md"

    # Start with SKILL.md
    $content = Get-Content "src/SKILL.md" -Raw
    $content += "`n`n---`n`n# Bundled References`n"

    # Append each reference file
    Get-ChildItem "src/references/*.md" | ForEach-Object {
        $content += "`n---`n`n"
        $content += Get-Content $_.FullName -Raw
    }

    $content += "`n---`n`n"
    $content += "> **Note**: This combined file does not include ``bootstrap.mjs``. Bootstrap commands`n"
    $content += "> referenced in the protocol require the full package. Plan directories must be`n"
    $content += "> created manually or by using the zip/tarball distribution.`n"

    Set-Content -Path $outputFile -Value $content

    Write-Host "Combined skill created: $outputFile" -ForegroundColor Green
}

function Invoke-Package {
    Invoke-Build

    Write-Host "Packaging skill as zip..." -ForegroundColor Yellow

    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

    $zipFile = Join-Path (Resolve-Path $DistDir) "$SkillName-v$Version.zip"
    $sourcePath = Resolve-Path (Join-Path $BuildDir $SkillName)

    # Remove existing zip if present
    if (Test-Path $zipFile) {
        Remove-Item $zipFile
    }

    # Use .NET ZipFile for cross-platform compatibility
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($zipFile, 'Create')

    try {
        Get-ChildItem -Path $sourcePath -Recurse -File | ForEach-Object {
            $relativePath = $_.FullName.Substring($sourcePath.Path.Length + 1)
            # Convert backslashes to forward slashes for cross-platform compatibility
            $entryName = "$SkillName/" + ($relativePath -replace '\\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entryName) | Out-Null
        }
    }
    finally {
        $zip.Dispose()
    }

    Write-Host "Package created: $zipFile" -ForegroundColor Green
}

function Invoke-PackageCombined {
    Invoke-BuildCombined

    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

    $source = Join-Path $BuildDir "$SkillName-combined.md"
    $dest = Join-Path $DistDir "$SkillName-combined.md"

    Copy-Item $source $dest

    Write-Host "Combined skill copied to: $dest" -ForegroundColor Green
}

function Invoke-Validate {
    Write-Host "Validating skill structure..." -ForegroundColor Yellow

    $errors = @()

    # Check SKILL.md exists
    if (-not (Test-Path "src/SKILL.md")) {
        $errors += "ERROR: src/SKILL.md not found"
    } else {
        $content = Get-Content "src/SKILL.md" -Raw
        if ($content -notmatch "(?m)^name:") {
            $errors += "ERROR: SKILL.md missing 'name' in frontmatter"
        }
        if ($content -notmatch "(?m)^description:") {
            $errors += "ERROR: SKILL.md missing 'description' in frontmatter"
        }

        # Verify all references/ cross-references resolve to actual files
        Write-Host "Checking cross-references..."
        $refs = [regex]::Matches($content, 'references/[a-z0-9_-]+\.md') | ForEach-Object { $_.Value } | Sort-Object -Unique
        foreach ($ref in $refs) {
            if (-not (Test-Path "src/$ref")) {
                $errors += "ERROR: SKILL.md references src/$ref but file not found"
            }
        }

        # Verify transition table entries appear in Mermaid diagram
        Write-Host "Checking state machine consistency..."
        $transitions = @(
            @("EXPLORE", "PLAN"), @("PLAN", "EXPLORE"), @("PLAN", "PLAN"),
            @("PLAN", "EXECUTE"), @("EXECUTE", "REFLECT"), @("REFLECT", "CLOSE"),
            @("REFLECT", "RE[-_]PLAN"), @("REFLECT", "EXPLORE"), @("RE[-_]PLAN", "PLAN")
        )
        foreach ($pair in $transitions) {
            $pattern = "$($pair[0]).*$($pair[1])"
            if ($content -notmatch $pattern) {
                $errors += "ERROR: Transition $($pair[0]) -> $($pair[1]) missing from SKILL.md"
            }
        }
    }

    # Check directories
    if (-not (Test-Path "src/references")) {
        $errors += "ERROR: src/references/ directory not found"
    }
    if (-not (Test-Path "src/scripts")) {
        $errors += "ERROR: src/scripts/ directory not found"
    }

    # Verify bootstrap.mjs creates expected plan directory files
    if (Test-Path "src/scripts/bootstrap.mjs") {
        Write-Host "Checking bootstrap file list..."
        $bsContent = Get-Content "src/scripts/bootstrap.mjs" -Raw
        foreach ($f in @("state.md", "plan.md", "decisions.md", "findings.md", "progress.md")) {
            if ($bsContent -notmatch [regex]::Escape($f)) {
                $errors += "ERROR: bootstrap.mjs does not create $f"
            }
        }
        # Verify bootstrap.mjs creates expected subdirectories
        Write-Host "Checking bootstrap directory creation..."
        foreach ($d in @("checkpoints", "findings")) {
            if ($bsContent -notmatch [regex]::Escape($d)) {
                $errors += "ERROR: bootstrap.mjs does not create $d/ directory"
            }
        }
        # Verify bootstrap.mjs references consolidated files
        Write-Host "Checking consolidated file references..."
        if ($bsContent -notmatch "FINDINGS\.md") {
            $errors += "ERROR: bootstrap.mjs does not reference FINDINGS.md"
        }
        if ($bsContent -notmatch "DECISIONS\.md") {
            $errors += "ERROR: bootstrap.mjs does not reference DECISIONS.md"
        }
    }

    if ($errors.Count -gt 0) {
        $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }
        exit 1
    }

    Write-Host "Validation passed!" -ForegroundColor Green
}

function Invoke-Lint {
    Write-Host "Checking script syntax..." -ForegroundColor Yellow
    node --check src/scripts/bootstrap.mjs
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Syntax check passed!" -ForegroundColor Green
    } else {
        Write-Host "Syntax check failed!" -ForegroundColor Red
        exit 1
    }
}

function Invoke-PackageTar {
    Invoke-Build

    Write-Host "Packaging skill as tarball..." -ForegroundColor Yellow

    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

    $tarFile = Join-Path (Resolve-Path $DistDir) "$SkillName-v$Version.tar.gz"
    $sourcePath = Join-Path $BuildDir $SkillName

    tar -czvf $tarFile -C $BuildDir $SkillName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tarball creation failed!" -ForegroundColor Red
        exit 1
    }

    Write-Host "Package created: $tarFile" -ForegroundColor Green
}

function Invoke-Test {
    Invoke-Lint

    Write-Host "Running bootstrap.mjs tests..." -ForegroundColor Yellow

    # Verify help exits cleanly
    node src/scripts/bootstrap.mjs help | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Help command failed!" -ForegroundColor Red
        exit 1
    }

    # Round-trip: new -> status -> close (uses temp directory to avoid clobbering active plans)
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "iterative-planner-test-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    try {
        Push-Location $tmpDir
        $scriptPath = Join-Path $PSScriptRoot "src/scripts/bootstrap.mjs"
        node $scriptPath new "test goal" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "new command failed" }
        $status = node $scriptPath status
        if ($LASTEXITCODE -ne 0) { throw "status command failed" }
        if ($status -notmatch "test goal") { throw "status output missing goal" }
        node $scriptPath close | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "close command failed" }
        if (-not (Test-Path "plans/FINDINGS.md")) { throw "plans/FINDINGS.md not created after close" }
        if (-not (Test-Path "plans/DECISIONS.md")) { throw "plans/DECISIONS.md not created after close" }
        Write-Host "  Round-trip (new -> status -> close) passed."
    }
    catch {
        Write-Host "Test failed: $_" -ForegroundColor Red
        exit 1
    }
    finally {
        Pop-Location
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    }

    Write-Host "Tests passed!" -ForegroundColor Green
}

function Invoke-Clean {
    Write-Host "Cleaning build artifacts..." -ForegroundColor Yellow

    if (Test-Path $BuildDir) {
        Remove-Item -Recurse -Force $BuildDir
    }
    if (Test-Path $DistDir) {
        Remove-Item -Recurse -Force $DistDir
    }

    Write-Host "Clean complete" -ForegroundColor Green
}

function Invoke-List {
    Invoke-Build

    Write-Host "Package contents:" -ForegroundColor Cyan
    Get-ChildItem -Recurse (Join-Path $BuildDir $SkillName) |
        Where-Object { -not $_.PSIsContainer } |
        ForEach-Object { $_.FullName.Replace((Get-Location).Path + [IO.Path]::DirectorySeparatorChar, "") }
}

# Execute command
switch ($Command.ToLower()) {
    "build"            { Invoke-Build }
    "build-combined"   { Invoke-BuildCombined }
    "package"          { Invoke-Package }
    "package-combined" { Invoke-PackageCombined }
    "package-tar"      { Invoke-PackageTar }
    "validate"         { Invoke-Validate }
    "lint"             { Invoke-Lint }
    "test"             { Invoke-Test }
    "clean"            { Invoke-Clean }
    "list"             { Invoke-List }
    "help"             { Show-Help }
    default            { Show-Help }
}
