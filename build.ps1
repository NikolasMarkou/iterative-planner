# build.ps1 - PowerShell build script for Iterative Planner Claude Skill
# Usage: .\build.ps1 [command]
# Commands: build, build-combined, package, package-combined, package-tar, validate, lint, test, clean, list, sync-skill, help

param(
    [Parameter(Position=0)]
    [string]$Command = "package"
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
    Write-Host "  sync-skill       - Opt-in: deploy repo source to local installed skill (writes to `$HOME)"
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
    New-Item -ItemType Directory -Force -Path "$skillDir/scripts/modules" | Out-Null

    # Copy main skill file
    Copy-Item "src/SKILL.md" $skillDir
    $skillMdPath = Join-Path $skillDir "SKILL.md"
    $skillMdContent = Get-Content $skillMdPath -Raw
    $skillMdContent = $skillMdContent -replace '__SKILL_VERSION__', $Version
    $skillMdContent = $skillMdContent -replace '__SKILL_DATE__', (Get-Date -Format 'yyyy-MM-dd')
    $skillMdContent = $skillMdContent -replace '__SKILL_COMMIT__', (git rev-parse --short HEAD)
    Set-Content $skillMdPath $skillMdContent

    # Copy reference files
    Copy-Item "src/references/*.md" "$skillDir/references/"

    # Copy scripts
    Get-ChildItem "src/scripts/*.mjs" -Exclude "*.test.mjs" | Copy-Item -Destination "$skillDir/scripts/"

    # Copy per-state rule modules (emitted on demand by emit-state.mjs)
    Copy-Item "src/scripts/modules/*.md" "$skillDir/scripts/modules/"

    # Copy agent definitions (if any)
    if (Test-Path "src/agents") {
        New-Item -ItemType Directory -Force -Path "$skillDir/agents" | Out-Null
        Copy-Item "src/agents/*.md" "$skillDir/agents/"
    }

    # Copy documentation. VERSION ships INSIDE the package: bootstrap.mjs resolves the skill
    # version at runtime by probing <pkg>/VERSION (installed) / <repo>/VERSION (dev). Without
    # it the installed skill stamps every new plan "unknown". 1:1 with the Makefile DOC_FILES.
    @("README.md", "LICENSE", "CHANGELOG.md", "VERSION") | ForEach-Object {
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
    Get-ChildItem "src/references/*.md" | Sort-Object Name | ForEach-Object {
        $content += "`n---`n`n"
        $content += Get-Content $_.FullName -Raw
    }

    # Re-inline the per-state rule modules so the single-file channel is self-contained
    # (emit-state.mjs is not runnable in a paste context — the bodies must be baked in).
    $content += "`n`n---`n`n# Bundled State Modules`n"
    Get-ChildItem "src/scripts/modules/*.md" | Sort-Object Name | ForEach-Object {
        $state = $_.BaseName -replace '^state-', ''
        $content += "`n---`n`n"
        $content += "## State Module: $state`n`n"
        $content += Get-Content $_.FullName -Raw
    }

    $content += "`n---`n`n"
    $content += "> **Note**: This combined file does not include ``bootstrap.mjs`` or the sub-agent`n"
    $content += "> definitions (``src/agents/*.md``) — it runs in SKILL.md's single-thread monolithic-fallback`n"
    $content += "> mode. Bootstrap commands referenced in the protocol require the full package. Plan`n"
    $content += "> directories must be created manually or by using the zip/tarball distribution.`n"

    # Rewrite references/ cross-references to anchor links (content is inlined above).
    # Keys are SINGLE-quoted, so backticks are literal — they must use SINGLE
    # backticks to match SKILL.md's single-backtick code spans (`references/x.md`).
    # Double backticks here matched nothing, leaving dangling links on Windows (L7).
    $refMap = @{
        '`references/blast-radius.md`' = 'the Blast Radius Reference section below'
        '`references/code-hygiene.md`' = 'the Code Hygiene Reference section below'
        '`references/complexity-control.md`' = 'the Complexity Control Reference section below'
        '`references/convergence-metrics.md`' = 'the Convergence Metrics Reference section below'
        '`references/decision-anchoring.md`' = 'the Decision Anchoring Reference section below'
        '`references/file-formats.md`' = 'the File Formats Reference section below'
        '`references/planning-rigor.md`' = 'the Planning Rigor Reference section below'
        '`references/python-software.md`' = 'the Python / Software-Engineering Caveat section below'
        '`src/references/blast-radius.md`' = 'the Blast Radius Reference section below'
        '`src/references/code-hygiene.md`' = 'the Code Hygiene Reference section below'
        '`src/references/complexity-control.md`' = 'the Complexity Control Reference section below'
        '`src/references/convergence-metrics.md`' = 'the Convergence Metrics Reference section below'
        '`src/references/decision-anchoring.md`' = 'the Decision Anchoring Reference section below'
        '`src/references/file-formats.md`' = 'the File Formats Reference section below'
        '`src/references/planning-rigor.md`' = 'the Planning Rigor Reference section below'
        '`src/references/python-software.md`' = 'the Python / Software-Engineering Caveat section below'
    }
    foreach ($key in $refMap.Keys) {
        $content = $content.Replace($key, $refMap[$key])
    }

    $content = $content -replace '__SKILL_VERSION__', $Version
    $content = $content -replace '__SKILL_DATE__', (Get-Date -Format 'yyyy-MM-dd')
    $content = $content -replace '__SKILL_COMMIT__', (git rev-parse --short HEAD)

    Set-Content -Path $outputFile -Value $content

    Write-Host "Combined skill created: $outputFile" -ForegroundColor Green
}

function Invoke-Package {
    Invoke-Validate
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
    Invoke-Validate
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
            @("REFLECT", "PIVOT"), @("REFLECT", "EXPLORE"), @("PIVOT", "PLAN")
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
        foreach ($f in @("state.md", "plan.md", "decisions.md", "findings.md", "progress.md", "verification.md", "changelog.md")) {
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
        if ($bsContent -notmatch "LESSONS\.md") {
            $errors += "ERROR: bootstrap.mjs does not reference LESSONS.md"
        }
        if ($bsContent -notmatch "INDEX\.md") {
            $errors += "ERROR: bootstrap.mjs does not reference INDEX.md"
        }
    }

    # Verify agent definitions have required frontmatter
    if (Test-Path "src/agents") {
        Write-Host "Checking agent definitions..."
        Get-ChildItem "src/agents/*.md" | ForEach-Object {
            $agentContent = Get-Content $_.FullName -Raw
            if ($agentContent -notmatch "(?m)^name:") {
                $errors += "ERROR: $($_.Name) missing 'name' in frontmatter"
            }
            if ($agentContent -notmatch "(?m)^description:") {
                $errors += "ERROR: $($_.Name) missing 'description' in frontmatter"
            }
            if ($agentContent -notmatch "(?m)^tools:") {
                $errors += "ERROR: $($_.Name) missing 'tools' in frontmatter"
            }
        }
    }

    # Verify validate-plan.mjs VALID_TRANSITIONS covers all SKILL.md transitions
    if (Test-Path "src/scripts/validate-plan.mjs") {
        Write-Host "Checking validator transition coverage..."
        $vpContent = Get-Content "src/scripts/validate-plan.mjs" -Raw
        $requiredTransitions = @(
            "EXPLORE→PLAN", "PLAN→EXPLORE", "PLAN→PLAN",
            "PLAN→EXECUTE", "EXECUTE→REFLECT", "REFLECT→CLOSE",
            "REFLECT→PIVOT", "REFLECT→EXPLORE", "PIVOT→PLAN"
        )
        foreach ($t in $requiredTransitions) {
            if (-not $vpContent.Contains("`"$t`"")) {
                $errors += "ERROR: validate-plan.mjs VALID_TRANSITIONS missing $t"
            }
        }
    }

    # Verify README <-> SKILL.md File Ownership table parity
    if (Test-Path "src/scripts/check-doc-parity.mjs") {
        Write-Host "Checking doc parity (README <-> SKILL.md File Ownership)..."
        node src/scripts/check-doc-parity.mjs
        if ($LASTEXITCODE -ne 0) {
            $errors += "ERROR: README File Ownership table out of parity with SKILL.md (see check-doc-parity.mjs)"
        }
    }

    # Verify README version badge and test-count badge match VERSION and TEST_COUNT files
    if (Test-Path "src/scripts/check-readme-parity.mjs") {
        Write-Host "Checking README badge parity (version + test count)..."
        node src/scripts/check-readme-parity.mjs
        if ($LASTEXITCODE -ne 0) {
            $errors += "ERROR: README badges out of parity with VERSION/TEST_COUNT (see check-readme-parity.mjs)"
        }
    }

    # Verify agent/module prose wiring: script paths, reference citations, section pointers, skill-path resolution
    if (Test-Path "src/scripts/check-agent-wiring.mjs") {
        Write-Host "Checking agent wiring (script paths, references, section pointers)..."
        node src/scripts/check-agent-wiring.mjs
        if ($LASTEXITCODE -ne 0) {
            $errors += "ERROR: agent/module prose wiring is broken (see check-agent-wiring.mjs)"
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
    foreach ($script in @("bootstrap.mjs", "validate-plan.mjs", "blast-radius.mjs", "shared.mjs", "check-doc-parity.mjs", "check-readme-parity.mjs", "check-test-count.mjs", "check-agent-wiring.mjs", "emit-state.mjs", "emit-template.mjs", "schema.mjs")) {
        node --check "src/scripts/$script"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Syntax check failed: $script" -ForegroundColor Red
            exit 1
        }
    }
    Write-Host "Syntax check passed!" -ForegroundColor Green
}

function Invoke-PackageTar {
    Invoke-Validate
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

# NOTE: check-test-count.mjs is wired here and NOT into Invoke-Validate — it re-runs the
# suite (defect #7: nothing compared TEST_COUNT against reality; README<->TEST_COUNT
# parity passes when BOTH are stale). Validate must stay fast and suite-free.
# Keep this function in lockstep with the Makefile's `test` target.
function Invoke-Test {
    Invoke-Lint

    Write-Host "Running all test suites..." -ForegroundColor Yellow

    node --test src/scripts/bootstrap.test.mjs src/scripts/validate-plan.test.mjs src/scripts/blast-radius.test.mjs src/scripts/check-doc-parity.test.mjs src/scripts/emit-state.test.mjs src/scripts/emit-template.test.mjs src/scripts/check-readme-parity.test.mjs src/scripts/shared.test.mjs src/scripts/check-test-count.test.mjs src/scripts/schema.test.mjs src/scripts/check-agent-wiring.test.mjs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tests failed!" -ForegroundColor Red
        exit 1
    }

    Write-Host "Checking TEST_COUNT against the live suite result..." -ForegroundColor Yellow

    node src/scripts/check-test-count.mjs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "TEST_COUNT is out of sync with the live suite result!" -ForegroundColor Red
        exit 1
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

# Opt-in: deploy repo source to the local installed skill (writes to $HOME). Not a prereq of build/package.
function Invoke-SyncSkill {
    $skillInstallDir = Join-Path $HOME ".claude/skills/$SkillName"
    $agentsInstallDir = Join-Path $HOME ".claude/agents"

    Write-Host "Syncing repo source to local installed skill: $skillInstallDir" -ForegroundColor Yellow

    New-Item -ItemType Directory -Force -Path "$skillInstallDir/references" | Out-Null
    New-Item -ItemType Directory -Force -Path "$skillInstallDir/scripts" | Out-Null
    New-Item -ItemType Directory -Force -Path "$skillInstallDir/scripts/modules" | Out-Null
    New-Item -ItemType Directory -Force -Path "$skillInstallDir/agents" | Out-Null
    New-Item -ItemType Directory -Force -Path $agentsInstallDir | Out-Null

    # Prune before copy: Copy-Item alone cannot remove a file that was DELETED from the repo, so a
    # copy-only sync leaves orphans behind forever (v2.35.0 removed xml.mjs/changelog.mjs; a
    # copy-only sync would have left both live in the install). Prune by glob, per directory.
    # The four dirs below are wholly owned by this skill, so a glob prune is safe there.
    Remove-Item "$skillInstallDir/scripts/*.mjs" -Force -ErrorAction SilentlyContinue
    Remove-Item "$skillInstallDir/scripts/modules/*.md" -Force -ErrorAction SilentlyContinue
    Remove-Item "$skillInstallDir/references/*.md" -Force -ErrorAction SilentlyContinue
    Remove-Item "$skillInstallDir/agents/*.md" -Force -ErrorAction SilentlyContinue
    # $agentsInstallDir is SHARED with every other installed skill. Prune ONLY our own ip-*.md
    # agents here — a glob prune would delete other skills' agent definitions.
    Remove-Item (Join-Path $agentsInstallDir "ip-*.md") -Force -ErrorAction SilentlyContinue

    Copy-Item "src/SKILL.md" "$skillInstallDir/SKILL.md"
    Copy-Item "src/scripts/*.mjs" "$skillInstallDir/scripts/"
    Copy-Item "src/scripts/modules/*.md" "$skillInstallDir/scripts/modules/"
    Copy-Item "src/references/*.md" "$skillInstallDir/references/"
    @("README.md", "LICENSE", "CHANGELOG.md", "VERSION") | ForEach-Object {
        if (Test-Path $_) { Copy-Item $_ $skillInstallDir }
    }
    Copy-Item "src/agents/*.md" "$skillInstallDir/agents/"
    Copy-Item "src/agents/*.md" $agentsInstallDir

    # Verify every synced tree. The Makefile checked only agents+modules and build.ps1 checked
    # nothing at all, so a stale script or reference could survive a clean-looking sync.
    $pairs = @(
        @{ Src = "src/scripts";         Dst = "$skillInstallDir/scripts";         Filter = "*.mjs" },
        @{ Src = "src/scripts/modules"; Dst = "$skillInstallDir/scripts/modules"; Filter = "*.md"  },
        @{ Src = "src/references";      Dst = "$skillInstallDir/references";       Filter = "*.md"  },
        @{ Src = "src/agents";          Dst = "$skillInstallDir/agents";           Filter = "*.md"  }
    )
    $mismatch = $false
    foreach ($p in $pairs) {
        $srcNames = @(Get-ChildItem -Path $p.Src -Filter $p.Filter -File | Select-Object -ExpandProperty Name | Sort-Object)
        $dstNames = @(Get-ChildItem -Path $p.Dst -Filter $p.Filter -File | Select-Object -ExpandProperty Name | Sort-Object)
        $delta = Compare-Object -ReferenceObject $srcNames -DifferenceObject $dstNames
        if ($delta) {
            Write-Host "ERROR: sync mismatch in $($p.Dst)" -ForegroundColor Red
            $delta | ForEach-Object {
                $side = if ($_.SideIndicator -eq '<=') { "missing from install" } else { "orphan in install" }
                Write-Host "  $($_.InputObject) — $side" -ForegroundColor Red
            }
            $mismatch = $true
            continue
        }
        foreach ($n in $srcNames) {
            $a = (Get-FileHash (Join-Path $p.Src $n) -Algorithm SHA256).Hash
            $b = (Get-FileHash (Join-Path $p.Dst $n) -Algorithm SHA256).Hash
            if ($a -ne $b) {
                Write-Host "ERROR: content differs: $n in $($p.Dst)" -ForegroundColor Red
                $mismatch = $true
            }
        }
    }
    $skillSrcHash = (Get-FileHash "src/SKILL.md" -Algorithm SHA256).Hash
    $skillDstHash = (Get-FileHash "$skillInstallDir/SKILL.md" -Algorithm SHA256).Hash
    if ($skillSrcHash -ne $skillDstHash) {
        Write-Host "ERROR: content differs: SKILL.md" -ForegroundColor Red
        $mismatch = $true
    }
    # VERSION is copied, so VERSION is verified — an unverified copy is how the pre-v2.35.0
    # orphan bug survived. 1:1 with the Makefile's `diff -q VERSION` line.
    $versionDst = Join-Path $skillInstallDir "VERSION"
    if (-not (Test-Path $versionDst)) {
        Write-Host "ERROR: missing from install: VERSION" -ForegroundColor Red
        $mismatch = $true
    } elseif ((Get-FileHash "VERSION" -Algorithm SHA256).Hash -ne (Get-FileHash $versionDst -Algorithm SHA256).Hash) {
        Write-Host "ERROR: content differs: VERSION" -ForegroundColor Red
        $mismatch = $true
    }
    if ($mismatch) { exit 1 }

    Write-Host "Sync verified (scripts, references, agents, modules, SKILL.md, VERSION)." -ForegroundColor Green
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
    "sync-skill"       { Invoke-SyncSkill }
    "help"             { Show-Help }
    default            {
        Show-Help
        exit 1
    }
}
