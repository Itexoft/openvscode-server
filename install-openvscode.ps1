<#
    OpenVSCode Server WSL installer.
    Downloads https://raw.githubusercontent.com/Itexoft/openvscode-server/refs/heads/main/openvscode-server.sh
    and wires portproxy on Windows.
#>

[CmdletBinding()]
param(
    [switch]$Trace,
    [string]$BootstrapPath,
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$ScriptArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ConsoleCancelHandler = $null
$script:ConsoleCancelHandlerAttached = $false
$script:InstallerRoot = $PSScriptRoot
if (-not $script:InstallerRoot) {
    $invocation = $MyInvocation
    if ($invocation -and $invocation.MyCommand -and ($invocation.MyCommand -is [System.Management.Automation.ExternalScriptInfo])) {
        $script:InstallerRoot = Split-Path -Path $invocation.MyCommand.Path -Parent
    } else {
        $script:InstallerRoot = (Get-Location).Path
    }
}
$script:DebugLogPath = Join-Path -Path $script:InstallerRoot -ChildPath 'install-debug.log'

function Debug-Log {
    param([string]$Message)
    try {
        $timestamp = Get-Date -Format o
        Add-Content -Path $script:DebugLogPath -Value ("[{0}] {1}" -f $timestamp, $Message)
    } catch {
    }
}

Debug-Log "Script bootstrap started"

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8NoBom
    [Console]::InputEncoding = $utf8NoBom
    $script:Utf8Encoding = $utf8NoBom
    if (Get-Variable -Name OutputEncoding -Scope Global -ErrorAction SilentlyContinue) {
        $Global:OutputEncoding = $utf8NoBom
    }
} catch {
}

$ScriptUri = 'https://raw.githubusercontent.com/Itexoft/openvscode-server/refs/heads/main/openvscode-server.sh'
$script:InstallerTraceEnabled = $Trace.IsPresent
$script:PsReadLineDisabled = $false
Debug-Log ("Encodings configured. TraceEnabled={0}" -f $script:InstallerTraceEnabled)

function Write-Trace {
    param([string]$Message)
    if ($script:InstallerTraceEnabled) {
        [Console]::WriteLine("[TRACE] {0}" -f $Message)
    }
}

function Flush-Console {
    try {
        [Console]::Out.Flush()
    } catch {
    }
    try {
        [Console]::Error.Flush()
    } catch {
    }
}

try {
    if ($Host.Name -eq 'ConsoleHost') {
        $psrl = Get-Module -Name PSReadLine -ErrorAction SilentlyContinue
        if ($psrl) {
            Remove-Module -ModuleInfo $psrl -Force -ErrorAction Stop
            $script:PsReadLineDisabled = $true
            Write-Trace "PSReadLine module removed to avoid interactive readline issues."
            Debug-Log "PSReadLine module removed"
        } else {
            Debug-Log "PSReadLine module not loaded"
        }
    }
} catch {
    Write-Trace ("Failed to adjust PSReadLine module: {0}" -f $_.Exception.Message)
    Debug-Log ("Failed to adjust PSReadLine: {0}" -f $_.Exception.Message)
}

try {
    $script:ConsoleCancelHandler = [System.ConsoleCancelEventHandler]{
        param($sender, $eventArgs)
        $eventArgs.Cancel = $true
        Write-Host ""
        Write-ErrorLine "Installation cancelled by user."
        exit 1
    }
    $cancelEvent = [System.Console].GetEvent('CancelKeyPress')
    if ($null -ne $cancelEvent) {
        [System.Console]::add_CancelKeyPress($script:ConsoleCancelHandler)
        $script:ConsoleCancelHandlerAttached = $true
        Debug-Log "CancelKeyPress handler attached"
    }
} catch {
    Write-Trace ("Unable to register Ctrl+C handler: {0}" -f $_.Exception.Message)
    Debug-Log ("Unable to register Ctrl+C handler: {0}" -f $_.Exception.Message)
}

function Write-Info {
    param([string]$Message)
    Write-Host ("[INFO ] {0}" -f $Message) -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host ("[WARN ] {0}" -f $Message) -ForegroundColor Yellow
}

function Write-ErrorLine {
    param([string]$Message)
    Write-Host ("[ERROR] {0}" -f $Message) -ForegroundColor Red
}

function Write-TraceLines {
    param(
        [string]$Header,
        $Lines
    )

    if (-not $script:InstallerTraceEnabled) {
        return
    }

    if ($Header) {
        Write-Trace $Header
    }

    if ($null -eq $Lines) {
        Write-Trace '    <no output>'
        return
    }

    if ($Lines -is [string]) {
        Write-Trace ("    {0}" -f $Lines)
        return
    }

    if ($Lines -is [System.Collections.IEnumerable]) {
        foreach ($line in $Lines) {
            Write-Trace ("    {0}" -f $line)
        }
    } else {
        Write-Trace ("    {0}" -f $Lines)
    }
}

function Parse-WslVersionFromLines {
    param($Lines)

    if (-not $Lines) {
        return $null
    }

    $candidateLines = @()
    if ($Lines -is [string]) {
        $candidateLines = @($Lines)
    } elseif ($Lines -is [System.Collections.IEnumerable]) {
        foreach ($entry in $Lines) { $candidateLines += ,$entry }
    } else {
        $candidateLines = @($Lines)
    }

    $sanitize = {
        param($text)
        $value = [string]$text
        if ($null -eq $value) { return '' }
        $value = [System.Text.RegularExpressions.Regex]::Replace($value, '\p{Cf}', '')
        $value = $value.Replace([string][char]0x00A0, ' ')
        if ($value.Contains("`0")) {
            $value = $value.Replace("`0", '')
        }
        return $value
    }

    $candidateLines = $candidateLines | ForEach-Object { & $sanitize $_ }

    $joined = [string]::Join("`n", $candidateLines)
    if (-not [string]::IsNullOrWhiteSpace($joined)) {
        $regex = 'WSL\s*version\s*:\s*([0-9]+(?:\.[0-9]+)+)'
        $regexMatch = [System.Text.RegularExpressions.Regex]::Match($joined, $regex, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($regexMatch.Success) {
            $value = $regexMatch.Groups[1].Value.Trim()
            try {
                $parsed = [Version]$value
                Write-Trace ("Parsed WSL version via regex '{0}'" -f $parsed)
                return $parsed
            } catch {
                Write-Trace ("Failed to parse WSL version regex capture '{0}': {1}" -f $value, $_.Exception.Message)
            }
        }
    }

    foreach ($line in $candidateLines) {
        $lineString = ([string]$line)
        if ([string]::IsNullOrWhiteSpace($lineString)) { continue }
        $trimmed = $lineString.Trim()
        Write-Trace ("Inspecting line for version: '{0}'" -f $trimmed)
        $codepoints = ($trimmed.ToCharArray() | ForEach-Object { "{0:X4}" -f [int]$_ })
        Write-Trace ("Codepoints: {0}" -f ($codepoints -join ' '))
        if ($trimmed -notmatch 'WSL' -and $trimmed -notmatch 'version') { continue }

        if ($trimmed -match '\d') {
            $versionCandidate = $trimmed
            $versionCandidate = [System.Text.RegularExpressions.Regex]::Replace($versionCandidate, '^[^0-9]+', '')
            $versionCandidate = [System.Text.RegularExpressions.Regex]::Replace($versionCandidate, '[^0-9\.].*$', '')
            $versionCandidate = $versionCandidate.Trim('.')
            Write-Trace ("Version candidate: '{0}'" -f $versionCandidate)
            if ($versionCandidate -match '^\d+(?:\.\d+)*$') {
                try {
                    $parsed = [Version]$versionCandidate
                    Write-Trace ("Parsed WSL version '{0}'" -f $parsed)
                    return $parsed
                } catch {
                    Write-Trace ("Failed to parse WSL version token '{0}': {1}" -f $versionCandidate, $_.Exception.Message)
                }
            }
        }
    }

    return $null
}

function Throw-InstallerError {
    param([string]$Message)
    throw (New-Object System.Exception $Message)
}

function Require-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Throw-InstallerError "Please re-run this script from an elevated PowerShell session (Run as administrator)."
    }
}

function Require-PowerShellVersion {
    $minimum = [Version]'5.1'
    if ($PSVersionTable.PSVersion -lt $minimum) {
        Throw-InstallerError "PowerShell $($PSVersionTable.PSVersion) detected. Version 5.1 or later is required."
    }
}

function Prompt-YesNo {
    param(
        [string]$Prompt,
        [bool]$Default = $true
    )

    $suffix = if ($Default) { "(Y/n)" } else { "(y/N)" }
    while ($true) {
        Write-Host -NoNewline ("{0} {1} " -f $Prompt, $suffix)
        Flush-Console
        $response = Read-Host
        $responseTrimmed = if ($null -eq $response) { '' } else { $response.Trim() }
        if ([string]::IsNullOrWhiteSpace($responseTrimmed)) {
            Write-Warn "Please answer with y or n."
            continue
        }
        switch ($responseTrimmed.ToLowerInvariant()) {
            'y' { return $true }
            'yes' { return $true }
            'n' { return $false }
            'no' { return $false }
            default { Write-Warn "Please answer with y or n." }
        }
    }
}

function Prompt-String {
    param(
        [string]$Prompt,
        [string]$Default,
        [scriptblock]$Validator = $null,
        [string]$ValidationErrorMessage = "Input is not valid."
    )

    while ($true) {
        if ($null -ne $Default -and $Default.Length -gt 0) {
            Write-Host -NoNewline ("{0} [{1}]: " -f $Prompt, $Default)
            Flush-Console
        } else {
            Write-Host -NoNewline ("{0}: " -f $Prompt)
            Flush-Console
        }

        $value = Read-Host
        if ([string]::IsNullOrWhiteSpace($value)) {
            $value = $Default
        }

        if ($null -eq $Validator) {
            return $value
        }

        try {
            if (& $Validator $value) {
                return $value
            }
        } catch {
            Write-Warn $_.Exception.Message
        }
        Write-Warn $ValidationErrorMessage
    }
}

function Prompt-Selection {
    param(
        [string]$Prompt,
        [string[]]$Options
    )

    if ($Options.Count -eq 0) {
        Throw-InstallerError "No options available for '$Prompt'."
    }

    if ($Options.Count -eq 1) {
        Write-Info "$Prompt $($Options[0])"
        return $Options[0]
    }

    Write-Host $Prompt
    for ($i = 0; $i -lt $Options.Count; $i++) {
        Write-Host ("  [{0}] {1}" -f ($i + 1), $Options[$i])
    }

    while ($true) {
        Write-Host -NoNewline "Enter choice (1-$($Options.Count)): "
        Flush-Console
        $response = Read-Host
        $parsed = 0
        if ([int]::TryParse($response, [ref]$parsed)) {
            $index = $parsed - 1
            if ($index -ge 0 -and $index -lt $Options.Count) {
                return $Options[$index]
            }
        }
        Write-Warn "Please select a valid option."
    }
}

function Get-WindowsBuildNumber {
    try {
        return [int][Environment]::OSVersion.Version.Build
    } catch {
        return $null
    }
}

function Get-WslVersionNumber {
    try {
        $output = & wsl.exe --version 2>&1
    } catch {
        $output = $null
    }

    Write-TraceLines "wsl --version output:" $output
    if ($LASTEXITCODE -ne 0) {
        Write-Trace ("wsl --version exited with code {0}" -f $LASTEXITCODE)
    }

    if ($LASTEXITCODE -eq 0 -and $output) {
        $parsed = Parse-WslVersionFromLines $output
        if ($parsed) {
            return $parsed
        }
    }

    try {
        $statusOutput = & wsl.exe --status 2>&1
    } catch {
        $statusOutput = $null
    }

    Write-TraceLines "wsl --status output:" $statusOutput
    if ($LASTEXITCODE -ne 0) {
        Write-Trace ("wsl --status exited with code {0}" -f $LASTEXITCODE)
    }

    if ($LASTEXITCODE -eq 0 -and $statusOutput) {
        $parsed = Parse-WslVersionFromLines $statusOutput
        if ($parsed) {
            return $parsed
        }
    }

    Write-Trace "Unable to parse WSL version from 'wsl --version' or 'wsl --status'."
    return $null
}

function Get-WslMirroredNetworkingSupport {
    $build = Get-WindowsBuildNumber
    $wslVersion = Get-WslVersionNumber

    $supported = $true
    $reason = $null

    if ($null -eq $build) {
        $supported = $false
        $reason = 'Unable to determine Windows build number.'
    } elseif ($build -lt 22621) {
        $supported = $false
        $reason = "Requires Windows build 22621 or newer. Detected build $build."
    }

    if ($supported) {
        if ($null -eq $wslVersion) {
            $supported = $false
            $reason = 'Unable to determine WSL version (try updating WSL from Microsoft Store).'
        } elseif ($wslVersion -lt [Version]'1.2.0') {
            $supported = $false
            $reason = "Requires WSL version 1.2.0 or newer. Detected version $wslVersion."
        }
    }

    return [pscustomobject]@{
        Supported    = $supported
        WindowsBuild = $build
        WslVersion   = $wslVersion
        Reason       = $reason
    }
}

function Invoke-WslUpdate {
    Write-Info "Updating WSL (this may take a few minutes)..."
    $output = & wsl.exe --update 2>&1
    $exitCode = $LASTEXITCODE
    if ($script:InstallerTraceEnabled) {
        if ($output) { $output | ForEach-Object { Write-Trace ("    {0}" -f $_) } }
    } elseif ($output) {
        $output | ForEach-Object { Write-Host ("    {0}" -f $_) }
    }

    if ($exitCode -ne 0) {
        Write-Warn ("'wsl --update' failed with exit code {0}. Trying '--web-download'." -f $exitCode)
        $output = & wsl.exe --update --web-download 2>&1
        $exitCode = $LASTEXITCODE
        if ($script:InstallerTraceEnabled) {
            if ($output) { $output | ForEach-Object { Write-Trace ("    {0}" -f $_) } }
        } elseif ($output) {
            $output | ForEach-Object { Write-Host ("    {0}" -f $_) }
        }
    }

    if ($exitCode -ne 0) {
        Write-Warn "Automatic WSL update failed. Update manually via Microsoft Store or 'wsl --update --web-download'."
        return $false
    }

    Write-Info "WSL update completed successfully. Restarting WSL..."
    Restart-Wsl
    return $true
}

function Set-WslconfigNetworkingModeMirrored {
    param([string]$Mode = 'mirrored')

    $configPath = Join-Path -Path $env:USERPROFILE -ChildPath '.wslconfig'
    $existed = Test-Path -Path $configPath
    $original = $null
    if ($existed) {
        $original = Get-Content -Path $configPath -Raw -ErrorAction SilentlyContinue
    }

    $lines = @()
    if ($original) {
        $lines = $original -split "`n"
    }

    $inSection = $false
    $sectionFound = $false
    $keyWritten = $false
    $result = New-Object System.Collections.Generic.List[string]

    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\s*\[.+\]\s*$') {
            if ($inSection -and -not $keyWritten) {
                $result.Add("networkingMode=$Mode")
                $keyWritten = $true
            }
            $inSection = ($trimmed -ieq '[wsl2]')
            if ($inSection) {
                $sectionFound = $true
            }
            $result.Add($line)
            continue
        }

        if ($inSection -and $trimmed -match '^networkingMode\s*=') {
            $result.Add("networkingMode=$Mode")
            $keyWritten = $true
        } else {
            $result.Add($line)
        }
    }

    if (-not $sectionFound) {
        if ($result.Count -gt 0 -and $result[$result.Count - 1].Trim().Length -ne 0) {
            $result.Add('')
        }
        $result.Add('[wsl2]')
        $result.Add("networkingMode=$Mode")
    } elseif ($inSection -and -not $keyWritten) {
        $result.Add("networkingMode=$Mode")
    }

    $newContent = ($result -join "`n")
    if ($result.Count -gt 0 -and -not $newContent.EndsWith("`n")) {
        $newContent += "`n"
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($configPath, $newContent, $utf8NoBom)
    return [pscustomobject]@{
        Path            = $configPath
        PreviousContent = $original
        Existed         = $existed
    }
}

function Restore-WslconfigNetworkingMode {
    param($UpdateInfo)

    if (-not $UpdateInfo) {
        return
    }

    $configPath = $UpdateInfo.Path
    $existed = $UpdateInfo.Existed
    $previous = $UpdateInfo.PreviousContent

    Write-Trace ("Reverting .wslconfig to previous state at {0}" -f $configPath)

    if ($existed) {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        $contentToWrite = if ($null -eq $previous) { '' } else { $previous }
        [System.IO.File]::WriteAllText($configPath, $contentToWrite, $utf8NoBom)
    } else {
        if (Test-Path -Path $configPath) {
            Remove-Item -Path $configPath -Force -ErrorAction SilentlyContinue | Out-Null
        }
    }
}

function Disable-WslMirroredNetworking {
    $configPath = Join-Path -Path $env:USERPROFILE -ChildPath '.wslconfig'
    if (-not (Test-Path -Path $configPath)) {
        return $false
    }

    $raw = Get-Content -Path $configPath -Raw -ErrorAction SilentlyContinue
    if ($null -eq $raw -or $raw -notmatch 'networkingMode\s*=') {
        return $false
    }

    $lines = $raw -split "`n"
    $result = New-Object System.Collections.Generic.List[string]
    $removed = $false
    foreach ($line in $lines) {
        if ($line -match '^\s*networkingMode\s*=') {
            $removed = $true
            continue
        }
        $result.Add($line)
    }

    if (-not $removed) {
        return $false
    }

    # collapse consecutive blank lines
    $normalized = New-Object System.Collections.Generic.List[string]
    $lastBlank = $false
    foreach ($entry in $result) {
        $isBlank = [string]::IsNullOrWhiteSpace($entry)
        if ($isBlank -and $lastBlank) {
            continue
        }
        $normalized.Add($entry)
        $lastBlank = $isBlank
    }

    while ($normalized.Count -gt 0 -and [string]::IsNullOrWhiteSpace($normalized[$normalized.Count - 1])) {
        $normalized.RemoveAt($normalized.Count - 1)
    }

    if ($normalized.Count -eq 0) {
        Remove-Item -Path $configPath -Force -ErrorAction SilentlyContinue | Out-Null
    } else {
        $newContent = ($normalized -join "`n")
        if (-not $newContent.EndsWith("`n")) {
            $newContent += "`n"
        }
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($configPath, $newContent, $utf8NoBom)
    }

    Write-Warn "WSL reported an unsupported request. Mirrored networking has been disabled in .wslconfig."
    return $true
}

function Test-WslUnsupportedRequest {
    param($Output)

    if (-not $Output) {
        return $false
    }

    $text = if ($Output -is [string]) {
        $Output
    } elseif ($Output -is [System.Collections.IEnumerable]) {
        [string]::Join(' ', $Output)
    } else {
        [string]$Output
    }

    return ($text -match 'The specified request is unsupported')
}

function Test-WslCatastrophicFailure {
    param($Output)

    if (-not $Output) {
        return $false
    }

    $text = if ($Output -is [string]) {
        $Output
    } elseif ($Output -is [System.Collections.IEnumerable]) {
        [string]::Join(' ', $Output)
    } else {
        [string]$Output
    }

    return ($text -match 'Catastrophic failure' -or $text -match 'E_UNEXPECTED')
}

function Wait-WslServiceReady {
    param(
        [int]$TimeoutSeconds = 60,
        [string]$Distro = $null
    )

    $start = [DateTime]::UtcNow
    $deadline = $start.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            & wsl.exe -l -q >$null 2>&1
            if ($LASTEXITCODE -ne 0) {
                Start-Sleep -Seconds 2
                continue
            }

            if ($Distro) {
                & wsl.exe -d $Distro -- true >$null 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Start-Sleep -Seconds 2
                    continue
                }
            }

            Write-Trace ("Wait-WslServiceReady satisfied after {0:N1} seconds." -f ([DateTime]::UtcNow - $start).TotalSeconds)
            return $true
        } catch {
            Write-Trace ("Wait-WslServiceReady poll failed: {0}" -f $_.Exception.Message)
        }
        Start-Sleep -Seconds 2
    }

    Write-Trace ("Wait-WslServiceReady timed out after {0} seconds." -f $TimeoutSeconds)
    return $false
}

function Ensure-WslServiceReady {
    param(
        [int]$TimeoutSeconds = 60,
        [string]$Distro = $null,
        [switch]$AllowContinue
    )

    $target = if ($Distro) { "WSL distro '$Distro'" } else { 'WSL' }
    Write-Info ("Waiting up to {0} seconds for {1} to become ready..." -f $TimeoutSeconds, $target)
    if (Wait-WslServiceReady -TimeoutSeconds $TimeoutSeconds -Distro $Distro) {
        return $true
    }

    Write-Warn ("{0} did not report ready within {1} seconds." -f $target, $TimeoutSeconds)
    if ($AllowContinue) {
        Write-Warn "Proceeding anyway. Subsequent WSL commands may fail until the distro finishes starting."
        return $false
    }

    $instruction = if ($Distro) {
        "Start the distro manually (wsl -d $Distro) or run 'wsl --shutdown' and rerun this installer."
    } else {
        "Start WSL (for example by running 'wsl') or run 'wsl --shutdown', then rerun this installer."
    }
    Throw-InstallerError ("{0} is not ready. {1}" -f $target, $instruction)
}

function Invoke-WslRetryDelay {
    param([int]$Attempt)

    $seconds = [Math]::Min(30, 2 + 2 * ($Attempt + 1))
    if ($seconds -lt 1) { $seconds = 1 }
    Write-Trace ("Retrying WSL command after {0} seconds." -f $seconds)
    Start-Sleep -Seconds $seconds
}

function Get-WslBootConfiguration {
    param([string]$Distro)

    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command "cat /etc/wsl.conf 2>/dev/null" -Description "Read /etc/wsl.conf"
    $lines = @()
    if ($result.Output) {
        if ($result.Output -is [System.Array]) {
            $lines = [string[]]$result.Output
        } else {
            $lines = @([string]$result.Output)
        }
    }

    $command = $null
    $inBoot = $false
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\s*\[.+\]\s*$') {
            $inBoot = ($trimmed -ieq '[boot]')
            continue
        }
        if ($inBoot -and $trimmed -match '^\s*command\s*=\s*(.+)$') {
            $command = ($trimmed -replace '^\s*command\s*=\s*', '').Trim()
            break
        }
    }

    [pscustomobject]@{
        Lines   = $lines
        Command = $command
    }
}

function Build-WslConfWithBootCommand {
    param(
        [string[]]$Lines,
        [string]$Command,
        [string]$ExpectedCommand
    )

    $result = New-Object System.Collections.Generic.List[string]
    $bootProcessed = $false
    $inBoot = $false
    $bootHeader = $null
    $bootBody = $null

    foreach ($line in $Lines) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\s*\[.+\]\s*$') {
            if ($inBoot) {
                $processed = Process-BootSection $bootHeader $bootBody $Command $ExpectedCommand
                if ($processed) {
                    foreach ($l in $processed) { $result.Add($l) }
                }
                $bootProcessed = $true
                $inBoot = $false
                $bootHeader = $null
                $bootBody = $null
            }

            if ($trimmed -ieq '[boot]') {
                $inBoot = $true
                $bootHeader = $line
                $bootBody = New-Object System.Collections.Generic.List[string]
            } else {
                $result.Add($line)
            }
            continue
        }

        if ($inBoot) {
            $bootBody.Add($line)
        } else {
            $result.Add($line)
        }
    }

    if ($inBoot) {
        $processed = Process-BootSection $bootHeader $bootBody $Command $ExpectedCommand
        if ($processed) {
            foreach ($l in $processed) { $result.Add($l) }
        }
        $bootProcessed = $true
    }

    if ($Command -and -not $bootProcessed) {
        if ($result.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($result[$result.Count - 1])) {
            $result.Add('')
        }
        $result.Add('[boot]')
        $result.Add("command=$Command")
    }

    return $result.ToArray()
}

function Process-BootSection {
    param(
        [string]$Header,
        [System.Collections.Generic.List[string]]$Body,
        [string]$Command,
        [string]$ExpectedCommand
    )

    if (-not $Header) {
        return $null
    }

    $bodyResult = New-Object System.Collections.Generic.List[string]
    $commandHandled = $false

    foreach ($line in $Body) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\s*command\s*=\s*(.+)$') {
            $existing = ($trimmed -replace '^\s*command\s*=\s*', '').Trim()
            if ($Command) {
                $bodyResult.Add("command=$Command")
                $commandHandled = $true
            } else {
                $shouldRemove = $true
                if ($ExpectedCommand -and $existing -ne $ExpectedCommand) {
                    $shouldRemove = $false
                }
                if ($shouldRemove) {
                    $commandHandled = $true
                    continue
                } else {
                    $bodyResult.Add($line)
                }
            }
        } else {
            $bodyResult.Add($line)
        }
    }

    if ($Command -and -not $commandHandled) {
        $bodyResult.Add("command=$Command")
    }

    while ($bodyResult.Count -gt 0 -and [string]::IsNullOrWhiteSpace($bodyResult[$bodyResult.Count - 1])) {
        $bodyResult.RemoveAt($bodyResult.Count - 1)
    }

    if (-not $Command -and $ExpectedCommand -and -not $commandHandled) {
        # Nothing to remove
        return @($Header) + $Body.ToArray()
    }

    if ($Command -or $bodyResult.Count -gt 0) {
        $section = New-Object System.Collections.Generic.List[string]
        $section.Add($Header)
        foreach ($item in $bodyResult) { $section.Add($item) }
        return $section.ToArray()
    }

    return @()
}

function Set-WslBootCommand {
    param(
        [string]$Distro,
        [string]$Command,
        [string]$ExpectedCommand = $null
    )

    $config = Get-WslBootConfiguration -Distro $Distro
    $newLines = Build-WslConfWithBootCommand $config.Lines $Command $ExpectedCommand

    $originalText = [string]::Join("`n", $config.Lines)
    if ($config.Lines.Count -gt 0 -and -not $originalText.EndsWith("`n")) {
        $originalText += "`n"
    }
    $newText = [string]::Join("`n", $newLines)
    if ($newLines.Count -gt 0 -and -not $newText.EndsWith("`n")) {
        $newText += "`n"
    }

    if ($originalText -eq $newText) {
        return $false
    }

    $tempName = "/tmp/openvscode-wslconf-$([guid]::NewGuid().ToString('N'))"
    Write-ContentToWslFile -Distro $Distro -RemotePath $tempName -Content $newText
    $escapedTemp = Escape-SingleQuotes $tempName
    $escapedTarget = Escape-SingleQuotes '/etc/wsl.conf'
    Invoke-WslCommand -Distro $Distro -Command "sudo mv '$escapedTemp' $escapedTarget && sudo chmod 644 $escapedTarget" -Description "Update /etc/wsl.conf"
    return $true
}

function Get-WslHostPatcherStatus {
    param([string]$Distro)

    $config = Get-WslBootConfiguration -Distro $Distro
    $command = $config.Command
    $managed = $false
    $windowsPath = $null
    $exeExists = $false

    if ($command) {
        $managed = ($command -match '(?i)WSLHostPatcher\.exe')
        $commandPath = $command.Trim('"')
        $windowsPath = Convert-WslPathToWindows -Distro $Distro -WslPath $commandPath
        if ($windowsPath) {
            $exeExists = Test-Path -LiteralPath $windowsPath
        }
    }

    [pscustomobject]@{
        Lines        = $config.Lines
        BootCommand  = $command
        IsManaged    = $managed
        WindowsPath  = $windowsPath
        ExeExists    = $exeExists
    }
}

function Download-WslHostPatcher {
    param([string]$DestinationDirectory)

    $destinationFull = [System.IO.Path]::GetFullPath($DestinationDirectory)
    $exePath = Join-Path -Path $destinationFull -ChildPath 'WSLHostPatcher.exe'
    if (Test-Path -LiteralPath $exePath) {
        Write-Info ("WSLHostPatcher.exe already exists at {0}. Reusing existing binary." -f $exePath)
        return $exePath
    }

    $uri = 'https://github.com/CzBiX/WSLHostPatcher/releases/latest/download/WSLHostPatcher.zip'
    $tempZip = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("wslhostpatcher-{0}.zip" -f ([guid]::NewGuid().ToString('N')))
    Write-Info "Downloading WSLHostPatcher from $uri"
    try {
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            Invoke-WebRequest -Uri $uri -OutFile $tempZip -UseBasicParsing | Out-Null
        } else {
            Invoke-WebRequest -Uri $uri -OutFile $tempZip | Out-Null
        }
    } catch {
        Throw-InstallerError ("Failed to download WSLHostPatcher: {0}" -f $_.Exception.Message)
    }

    try {
        if (-not (Test-Path -LiteralPath $destinationFull)) {
            New-Item -ItemType Directory -Path $destinationFull -Force | Out-Null
        }
        Expand-Archive -Path $tempZip -DestinationPath $destinationFull -Force
    } finally {
        if (Test-Path -Path $tempZip) {
            Remove-Item -Path $tempZip -Force -ErrorAction SilentlyContinue | Out-Null
        }
    }

    if (-not (Test-Path -LiteralPath $exePath)) {
        Throw-InstallerError "WSLHostPatcher.exe not found after extraction."
    }
    return $exePath
}

function Enable-WslHostPatcher {
    param(
        [string]$Distro,
        [string]$DefaultDirectory,
        $CurrentStatus
    )

    $standardInstallRoot = 'C:\WSLHostPatcher'
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

    $defaultDir = $null
    if ($CurrentStatus -and $CurrentStatus.WindowsPath) {
        $defaultDir = Split-Path -Path $CurrentStatus.WindowsPath -Parent
    } elseif (-not [string]::IsNullOrWhiteSpace($DefaultDirectory)) {
        $defaultDir = [System.IO.Path]::GetFullPath($DefaultDirectory)
    } elseif (-not [string]::IsNullOrWhiteSpace($script:InstallerRoot)) {
        $defaultDir = [System.IO.Path]::GetFullPath($script:InstallerRoot)
    } else {
        $defaultDir = $standardInstallRoot
    }

    if ([string]::IsNullOrWhiteSpace($defaultDir)) {
        $defaultDir = $standardInstallRoot
    }

    $defaultDirFull = [System.IO.Path]::GetFullPath($defaultDir)
    if ($defaultDirFull.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $defaultDirFull = $standardInstallRoot
    }

    if (-not ($CurrentStatus -and $CurrentStatus.WindowsPath)) {
        $existingPatcher = Join-Path -Path $standardInstallRoot -ChildPath 'WSLHostPatcher.exe'
        if (Test-Path -LiteralPath $existingPatcher) {
            $defaultDirFull = $standardInstallRoot
        }
    }

    $targetDir = Prompt-String -Prompt "Directory for WSLHostPatcher.exe" -Default $defaultDirFull -Validator {
        param($value)
        return -not [string]::IsNullOrWhiteSpace($value)
    } -ValidationErrorMessage "Please enter a non-empty path."

    $fullDir = [System.IO.Path]::GetFullPath($targetDir)
    $exePath = Download-WslHostPatcher -DestinationDirectory $fullDir
    $wslPath = Convert-WindowsPathToWsl -Distro $Distro -WindowsPath $exePath
    if (-not $wslPath) {
        Throw-InstallerError "Failed to resolve WSL path for $exePath."
    }

    $changed = Set-WslBootCommand -Distro $Distro -Command $wslPath
    if ($changed) {
        Write-Info "WSLHostPatcher configured to run at distro boot."
    } else {
        Write-Info "WSLHostPatcher autostart already configured. No changes were made."
    }

    Invoke-WslHostPatcher -Distro $Distro -WindowsPath $exePath
    Write-Info "Restart WSL (wsl --shutdown) to keep port forwarding enabled after distro reboot."
}

function Disable-WslHostPatcher {
    param(
        [string]$Distro,
        $Status
    )

    if (-not $Status -or -not $Status.IsManaged) {
        Write-Info "WSLHostPatcher is not managed by this installer - nothing to disable."
        return
    }

    $changed = Set-WslBootCommand -Distro $Distro -Command $null -ExpectedCommand $Status.BootCommand
    if ($changed) {
        Write-Info "WSLHostPatcher autostart disabled."
    } else {
        Write-Info "/etc/wsl.conf was not modified."
    }
    Write-Info "Run 'wsl --shutdown' to stop the patcher."
}

function Invoke-WslHostPatcher {
    param(
        [string]$Distro,
        [string]$WindowsPath
    )

    if ([string]::IsNullOrWhiteSpace($WindowsPath)) {
        return
    }

    try {
        $wslExecutable = Convert-WindowsPathToWsl -Distro $Distro -WindowsPath $WindowsPath
    } catch {
        $wslExecutable = $null
    }

    if ([string]::IsNullOrWhiteSpace($wslExecutable)) {
        Write-Warn "Unable to resolve WSLHostPatcher path for execution."
        return
    }

    $escaped = Escape-SingleQuotes $wslExecutable
    try {
        Invoke-WslCommand -Distro $Distro -Command "$escaped" -Description "Run WSLHostPatcher"
    } catch {
        Write-Warn ("Failed to run WSLHostPatcher immediately: {0}" -f $_.Exception.Message)
    }
}

function Restart-Wsl {
    param(
        [string]$Distro = $null,
        [int]$TimeoutSeconds = 60
    )

    Write-Trace 'Invoking wsl.exe --shutdown'
    & wsl.exe --shutdown 2>$null
    Start-Sleep -Seconds 2
    if (-not (Wait-WslServiceReady -TimeoutSeconds $TimeoutSeconds -Distro $Distro)) {
        Write-Warn ("WSL did not become ready within {0} seconds after restart." -f $TimeoutSeconds)
    }
}

function Get-WslInterfaceInformation {
    param([string]$Distro)

    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command "ip -o -4 addr show scope global" -Description 'Enumerate IPv4 addresses'
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        return @()
    }

    $interfaces = New-Object System.Collections.Generic.List[object]
    foreach ($line in $result.Output) {
        if ($line -match '^[^:]+:\s*(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/(\d+)') {
            $iface = $matches[1]
            $address = $matches[2]
            $prefix = [int]$matches[3]
            $interfaces.Add([pscustomobject]@{
                Interface = $iface
                Address   = $address
                Prefix    = $prefix
            })
        }
    }

    return $interfaces.ToArray()
}

function Get-WslDefaultGateway {
    param([string]$Distro)

    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command "ip route | awk '/^default/ {print \$3; exit}'" -Description 'Detect default gateway'
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        return $null
    }
    return ($result.Output[0]).Trim()
}

function Get-WslDnsServers {
    param([string]$Distro)

    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command "awk '/^nameserver/ {print \$2}' /etc/resolv.conf" -Description 'Read DNS servers'
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        return @()
    }
    $servers = $result.Output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    return @($servers | ForEach-Object { $_.Trim() })
}

function Test-IPv4Address {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $parsed = $null
    return [System.Net.IPAddress]::TryParse($Value, [ref]$parsed)
}

function Configure-WslStaticNetworking {
    param(
        [string]$Distro,
        [string]$Interface,
        [string]$Address,
        [int]$Prefix,
        [string]$Gateway,
        [string[]]$DnsServers
    )

    $cidr = "$Address/$Prefix"
    $dnsList = ($DnsServers | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $dnsYaml = if ($dnsList.Count -gt 0) { $dnsList -join ', ' } else { '' }

    $yamlLines = @(
        'network:',
        '  version: 2',
        '  renderer: networkd',
        '  ethernets:',
        ("    {0}:" -f $Interface),
        '      dhcp4: false',
        '      addresses:',
        ("        - {0}" -f $cidr)
    )

    if ($Gateway) {
        $yamlLines += @(
            '      routes:',
            '        - to: default',
            ("          via: {0}" -f $Gateway)
        )
    }

    if ($dnsList.Count -gt 0) {
        $yamlLines += @(
            '      nameservers:',
            ("        addresses: [{0}]" -f $dnsYaml)
        )
    }

    $yamlContent = ($yamlLines -join "`n") + "`n"
    $tempPath = "/tmp/openvscode-static-netplan.yaml"
    Write-ContentToWslFile -Distro $Distro -RemotePath $tempPath -Content $yamlContent

    $escapedTemp = Escape-SingleQuotes $tempPath
    $targetPath = '/etc/netplan/99-openvscode-static.yaml'
    $escapedTarget = Escape-SingleQuotes $targetPath

    $moveCommand = "sudo mv '$escapedTemp' '$escapedTarget' && sudo chmod 600 '$escapedTarget'"
    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command $moveCommand -Description 'Install netplan configuration'
    if ($result.ExitCode -ne 0) {
        Write-Warn "Failed to install netplan configuration file."
        return $false
    }

    $applyResult = Invoke-WslCommandNoThrow -Distro $Distro -Command "sudo netplan apply" -Description 'Apply netplan configuration'
    if ($applyResult.ExitCode -ne 0) {
        Write-Warn "netplan apply reported an error. Check the configuration inside WSL."
        return $false
    }

    return $true
}

function Configure-WslMirroredNetworking {
    param(
        [string]$Distro,
        [string]$SuggestedPort
    )

    $supportInfo = Get-WslMirroredNetworkingSupport
    $attemptedUpdate = $false
    while (-not $supportInfo.Supported) {
        if ($supportInfo.Reason) {
            Write-Warn $supportInfo.Reason
        }

        $canAttemptUpdate = (-not $attemptedUpdate) -and $supportInfo.Reason -and (
            $supportInfo.Reason -match 'WSL version' -or
            $supportInfo.Reason -match 'Unable to determine WSL version'
        )

        if ($canAttemptUpdate -and (Prompt-YesNo -Prompt "Attempt to update WSL now (runs 'wsl --update')?" -Default $true)) {
            $attemptedUpdate = $true
            if (Invoke-WslUpdate) {
                $supportInfo = Get-WslMirroredNetworkingSupport
                continue
            } else {
                Write-Warn "WSL update did not complete successfully. Mirrored networking remains unavailable."
            }
        }

        if (-not $supportInfo.Supported) {
            if (-not $canAttemptUpdate) {
                Write-Warn "Run 'wsl --update' (requires administrator) to upgrade WSL and enable mirrored networking."
            }
            return [pscustomobject]@{ Success = $false; Reason = $supportInfo.Reason }
        }
    }

    Write-Trace ("Mirrored networking supported. Windows build {0}; WSL {1}" -f $supportInfo.WindowsBuild, $supportInfo.WslVersion)

    if (-not (Prompt-YesNo -Prompt "Enable WSL mirrored networking (static IP, no portproxy)?" -Default $false)) {
        return [pscustomobject]@{ Success = $false }
    }

    Write-Info "Enabling mirrored networking mode via .wslconfig"
    $configUpdate = Set-WslconfigNetworkingModeMirrored
    Write-Trace ("Updated .wslconfig at {0}" -f $configUpdate.Path)

    try {
        Write-Info "Restarting WSL to apply networking changes"
        Restart-Wsl -Distro $Distro

        Write-Trace ("Priming distro {0} after restart" -f $Distro)
        $prime = Invoke-WslCommandNoThrow -Distro $Distro -Command 'true' -Description 'Prime distro'
        if ($prime.ExitCode -ne 0) {
            Write-Warn "Unable to start the distro after switching to mirrored mode."
            Write-Info "Reverting mirrored networking configuration."
            Restore-WslconfigNetworkingMode -UpdateInfo $configUpdate
            Restart-Wsl -Distro $Distro
            return [pscustomobject]@{ Success = $false; Reason = 'Distro failed to start after enabling mirrored networking.' }
        }

        $interfaces = Get-WslInterfaceInformation -Distro $Distro
        if ($interfaces.Count -eq 0) {
            Write-Warn "Could not enumerate network interfaces inside WSL after enabling mirrored mode."
            Write-Info "Reverting mirrored networking configuration."
            Restore-WslconfigNetworkingMode -UpdateInfo $configUpdate
            Restart-Wsl -Distro $Distro
            return [pscustomobject]@{ Success = $false; Reason = 'No network interfaces detected in mirrored mode.' }
        }

        $options = $interfaces | ForEach-Object { "{0} ({1}/{2})" -f $_.Interface, $_.Address, $_.Prefix }
        $selection = if ($options.Count -eq 1) {
            Write-Info ("Detected interface: {0}" -f $options[0])
            $interfaces[0]
    } else {
        $choice = Prompt-Selection -Prompt 'Select network interface for static IP' -Options $options
        $index = $options.IndexOf($choice)
        $interfaces[$index]
    }

    $defaultIp = $selection.Address
    $defaultPrefix = $selection.Prefix
    $defaultGateway = Get-WslDefaultGateway -Distro $Distro
    $dnsServers = Get-WslDnsServers -Distro $Distro

    $ipAddress = Prompt-String -Prompt 'Static IPv4 address' -Default $defaultIp -Validator {
        param($value)
        return (Test-IPv4Address $value)
    } -ValidationErrorMessage 'Enter a valid IPv4 address.'

    $prefixString = Prompt-String -Prompt 'Prefix length (CIDR)' -Default $defaultPrefix.ToString() -Validator {
        param($value)
        $parsed = 0
        return ([int]::TryParse($value, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 32)
    } -ValidationErrorMessage 'Enter an integer between 1 and 32.'
    $prefixLength = [int]$prefixString

    $gateway = $null
    if ($defaultGateway) {
        $gateway = Prompt-String -Prompt 'Default gateway' -Default $defaultGateway -Validator {
            param($value)
            return (Test-IPv4Address $value)
        } -ValidationErrorMessage 'Enter a valid IPv4 gateway address.'
    }

    $dnsDefault = if ($dnsServers.Count -gt 0) { $dnsServers -join ', ' } else { '' }
    $dnsInput = Prompt-String -Prompt 'DNS servers (comma separated)' -Default $dnsDefault
    $dnsArray = @()
    if (-not [string]::IsNullOrWhiteSpace($dnsInput)) {
        $dnsArray = $dnsInput.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }

        if (-not (Configure-WslStaticNetworking -Distro $Distro -Interface $selection.Interface -Address $ipAddress -Prefix $prefixLength -Gateway $gateway -DnsServers $dnsArray)) {
            Write-Info "Reverting mirrored networking configuration."
            Restore-WslconfigNetworkingMode -UpdateInfo $configUpdate
            Restart-Wsl -Distro $Distro
            return [pscustomobject]@{ Success = $false; Reason = 'Failed to configure static networking inside WSL.' }
        }

        Write-Info "Static networking configured for mirrored mode."
        if ($SuggestedPort) {
            Write-Info ("Access OpenVSCode Server via http(s)://{0}:{1}" -f $ipAddress, $SuggestedPort)
        }

        return [pscustomobject]@{
            Success   = $true
            Address   = $ipAddress
            Prefix    = $prefixLength
            Gateway   = $gateway
            Dns       = $dnsArray
            Interface = $selection.Interface
        }
    } catch {
        Write-Warn ("Mirrored networking setup failed: {0}" -f $_.Exception.Message)
        Write-Info "Reverting mirrored networking configuration."
        Restore-WslconfigNetworkingMode -UpdateInfo $configUpdate
        Restart-Wsl -Distro $Distro
        return [pscustomobject]@{ Success = $false; Reason = $_.Exception.Message }
    }

    return [pscustomobject]@{ Success = $false }
}

function Escape-SingleQuotes {
    param([string]$Value)
    if ($Value -eq $null) { return '' }
    return [string]::Join("'""'""'", $Value -split "'")
}

function Sanitize-DistroName {
    param([string]$Name)

    if ($null -eq $Name) { return '' }
    $filtered = -join ($Name.ToCharArray() | Where-Object { [int]$_ -ge 32 })
    return $filtered.Trim()
}

function Parse-EnvContent {
    param([string[]]$Lines)

    $map = @{}
    foreach ($line in $Lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith('#')) { continue }
        $pair = $trimmed.Split('=', 2)
        if ($pair.Length -eq 2) {
            $map[$pair[0]] = $pair[1]
        }
    }

    return $map
}

function Read-OpenVSCodeEnv {
    param(
        [string]$Distro,
        [string]$InstallPath
    )

    if ([string]::IsNullOrWhiteSpace($InstallPath)) {
        return $null
    }

    $escaped = Escape-SingleQuotes $InstallPath
    $envResult = Invoke-WslCommandNoThrow -Distro $Distro -Command "cd '$escaped' && cat '.openvscode-server/env' 2>/dev/null" -Description "Read OpenVSCode Server env"
    if ($envResult.ExitCode -eq 0 -and $envResult.Output.Count -gt 0) {
        return Parse-EnvContent $envResult.Output
    }

    return $null
}

function Build-OpenVSCodeDefaultEnvVars {
    param($Config)

    if (-not $Config) {
        return @{}
    }

    $defaults = @{}
    if ($Config.ContainsKey('OVS_PORT')) {
        $defaults['OVS_DEFAULT_PORT'] = $Config['OVS_PORT']
    }
    if ($Config.ContainsKey('OVS_WORKSPACE_ROOT')) {
        $defaults['OVS_DEFAULT_WORKSPACE'] = $Config['OVS_WORKSPACE_ROOT']
    }
    if ($Config.ContainsKey('OVS_TOKEN')) {
        $defaults['OVS_DEFAULT_TOKEN'] = $Config['OVS_TOKEN']
    }
    if ($Config.ContainsKey('OVS_TLS_MODE')) {
        $defaults['OVS_DEFAULT_TLS_MODE'] = $Config['OVS_TLS_MODE']
    }
    if ($Config.ContainsKey('OVS_TLS_CERT')) {
        $defaults['OVS_DEFAULT_TLS_CERT'] = $Config['OVS_TLS_CERT']
    }
    if ($Config.ContainsKey('OVS_TLS_KEY')) {
        $defaults['OVS_DEFAULT_TLS_KEY'] = $Config['OVS_TLS_KEY']
    }
    if ($Config.ContainsKey('OVS_TLS_CA')) {
        $defaults['OVS_DEFAULT_TLS_CA'] = $Config['OVS_TLS_CA']
    }
    if ($Config.ContainsKey('OVS_SYSTEMD_SERVICE_NAME')) {
        $serviceValue = $Config['OVS_SYSTEMD_SERVICE_NAME']
        if (-not [string]::IsNullOrWhiteSpace($serviceValue) -and $serviceValue -match '^[A-Za-z0-9._@-]+$' -and $serviceValue.Length -ge 2) {
            $defaults['OVS_DEFAULT_SYSTEMD_SERVICE_NAME'] = $serviceValue
        }
    }
    if ($Config.ContainsKey('OVS_INSTALL_ROOT')) {
        $defaults['OVS_PREVIOUS_INSTALL_ROOT'] = $Config['OVS_INSTALL_ROOT']
    }

    return $defaults
}

function Get-ExpectedServiceName {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return 'openvscode-server'
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $hash = $sha1.ComputeHash($bytes)
    } finally {
        $sha1.Dispose()
    }
    $hex = ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    if ($hex.Length -ge 12) {
        $hex = $hex.Substring(0, 12)
    }
    return "openvscode-$hex"
}

function Normalize-UnixPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return '/'
    }

    $trimmed = $Path.Trim()
    $isAbsolute = $trimmed.StartsWith('/')
    $segments = New-Object System.Collections.Generic.List[string]

    foreach ($segment in $trimmed.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries)) {
        switch ($segment) {
            '.' { continue }
            '..' {
                if ($segments.Count -gt 0) {
                    $segments.RemoveAt($segments.Count - 1)
                } elseif (-not $isAbsolute) {
                    $segments.Add('..')
                }
            }
            default {
                $segments.Add($segment)
            }
        }
    }

    $normalized = [string]::Join('/', $segments)
    if ($isAbsolute) {
        if ([string]::IsNullOrEmpty($normalized)) {
            return '/'
        }
        return '/' + $normalized
    }

    if ([string]::IsNullOrEmpty($normalized)) {
        return '.'
    }
    return $normalized
}

function Get-WslHomeDirectory {
    param([string]$Distro)

    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command 'printf %s "$HOME"' -Description "Resolve home directory"
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        $details = $result.Output -join [Environment]::NewLine
        if ($details -match 'WSL_E_DISTRO_NOT_FOUND' -or $details -match 'There is no distribution') {
            Throw-InstallerError ("WSL reports that distribution '{0}' is not available for this user. Start it once with 'wsl.exe -d ""{0}""' and ensure it appears in 'wsl.exe -l -q'." -f $Distro)
        }
        Throw-InstallerError "Unable to determine the WSL home directory."
    }

    return ($result.Output[-1]).Trim()
}

function Convert-WindowsPathToWsl {
    param(
        [string]$Distro,
        [string]$WindowsPath
    )

    if ([string]::IsNullOrWhiteSpace($WindowsPath)) {
        Throw-InstallerError "Windows path cannot be empty."
    }

    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    $escaped = Escape-SingleQuotes $full
    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command "wslpath -a '$escaped'" -Description "Convert Windows path '$full'"
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        Throw-InstallerError "Unable to map Windows path '$full' into WSL."
    }

    return ($result.Output[-1]).Trim()
}

function Convert-WslPathToWindows {
    param(
        [string]$Distro,
        [string]$WslPath
    )

    if ([string]::IsNullOrWhiteSpace($WslPath)) {
        return $null
    }

    $escaped = Escape-SingleQuotes $WslPath
    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command "wslpath -w '$escaped'" -Description "Convert WSL path '$WslPath'"
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        return $null
    }
    return ($result.Output[-1]).Trim()
}

function Copy-WslFileToWindows {
    param(
        [string]$Distro,
        [string]$RemotePath,
        [string]$DestinationPath,
        [string]$Description
    )

    if ([string]::IsNullOrWhiteSpace($RemotePath)) {
        return $false
    }

    $escaped = Escape-SingleQuotes $RemotePath
    $command = "if [ -f '$escaped' ]; then base64 '$escaped' | tr -d '\n'; else exit 1; fi"
    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command $command -Description "Read $RemotePath"
    if ($result.ExitCode -ne 0 -or $result.Output.Count -eq 0) {
        Write-Warn ("Unable to copy {0} from WSL path {1}." -f $Description, $RemotePath)
        return $false
    }

    $joined = ($result.Output -join '')
    try {
        $bytes = [Convert]::FromBase64String($joined)
    } catch {
        Write-Warn ("Failed to decode {0} from WSL path {1}." -f $Description, $RemotePath)
        return $false
    }

    $destinationDir = Split-Path -Path $DestinationPath -Parent
    if (-not (Test-Path -Path $destinationDir)) {
        [IO.Directory]::CreateDirectory($destinationDir) | Out-Null
    }
    [IO.File]::WriteAllBytes($DestinationPath, $bytes)
    Write-Info ("Copied {0} to {1}" -f $Description, $DestinationPath)
    return $true
}

function Install-WindowsCertificate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CertificatePath
    )

    if (-not (Test-Path -Path $CertificatePath)) {
        Write-Warn ("Certificate file '{0}' was not found; skipping import." -f $CertificatePath)
        return $false
    }

    try {
        $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CertificatePath
    } catch {
        Write-Warn ("Failed to load certificate '{0}': {1}" -f $CertificatePath, $_.Exception.Message)
        return $false
    }

    $thumbprint = $certificate.Thumbprint
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("Root", "CurrentUser")
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    } catch {
        Write-Warn ("Unable to open CurrentUser\\Root certificate store: {0}" -f $_.Exception.Message)
        return $false
    }

    try {
        $existing = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $thumbprint, $false)
        if ($existing.Count -gt 0) {
            Write-Info ("Certificate already trusted (thumbprint {0})." -f $thumbprint)
            return $true
        }

        $store.Add($certificate)
        Write-Info ("Certificate installed into CurrentUser\\Root (thumbprint {0})." -f $thumbprint)
        return $true
    } catch {
        Write-Warn ("Failed to install certificate (thumbprint {0}): {1}" -f $thumbprint, $_.Exception.Message)
        return $false
    } finally {
        $store.Close()
    }
}

function Invoke-WslCommand {
    param(
        [string]$Distro,
        [string]$Command,
        [string]$Description = "WSL command",
        [switch]$Silent,
        [switch]$NoThrow
    )

    $maxAttempts = 5
    $outputLines = @()
    $exitCode = -1
    $rawOutput = $null
    $attemptedRecovery = $false
    $attemptedWait = $false
    $attemptedCatastrophic = $false

    for ($attempt = 0; $attempt -lt $maxAttempts; $attempt++) {
        Write-Trace ("WSL[{0}] {1}" -f $Distro, $Command)
        $arguments = @('-d', $Distro, '--', 'bash', '-lc', $Command)
        $rawOutput = & wsl.exe @arguments 2>&1
        $exitCode = $LASTEXITCODE

        if ($null -ne $rawOutput) {
            if ($rawOutput -is [System.Array]) {
                $outputLines = [string[]]$rawOutput
            } else {
                $outputLines = @([string]$rawOutput)
            }
        } else {
            $outputLines = @()
        }

        if ($exitCode -eq 0) {
            break
        }

        $unsupported = Test-WslUnsupportedRequest $outputLines
        if ($unsupported) {
            if (-not $attemptedWait) {
                $attemptedWait = $true
                Write-Warn "WSL reported an unsupported request. Waiting for service readiness."
                if (-not (Wait-WslServiceReady -TimeoutSeconds 45 -Distro $Distro)) {
                    Write-Warn "WSL is still initialising; will retry shortly."
                }
                Invoke-WslRetryDelay -Attempt $attempt
                continue
            }

            if (-not $attemptedRecovery) {
                Write-Warn "Attempting to reset networking configuration."
                try {
                    Disable-WslMirroredNetworking | Out-Null
                } catch {
                    Write-Trace ("Disable-WslMirroredNetworking threw: {0}" -f $_.Exception.Message)
                }
                $attemptedRecovery = $true
                if (Wait-WslServiceReady -TimeoutSeconds 45 -Distro $Distro) {
                    Invoke-WslRetryDelay -Attempt $attempt
                    continue
                }
                Write-Warn "WSL service not ready after resetting networking; restarting WSL."
                Restart-Wsl -Distro $Distro
                Start-Sleep -Seconds 1
                try {
                    & wsl.exe -l -q >$null 2>&1
                } catch {
                    Write-Trace ("wsl.exe -l -q raised after restart: {0}" -f $_.Exception.Message)
                }
                Invoke-WslRetryDelay -Attempt $attempt
                continue
            }
        }

        $shouldRestart = (-not $attemptedCatastrophic) -and (Test-WslCatastrophicFailure $outputLines)
        if ($shouldRestart) {
            $attemptedCatastrophic = $true
            Write-Warn "WSL reported a catastrophic failure. Waiting for the service to recover."
            if (Wait-WslServiceReady -TimeoutSeconds 60 -Distro $Distro) {
                Invoke-WslRetryDelay -Attempt $attempt
                continue
            }
            Write-Warn "WSL is still not ready; restarting WSL and retrying command."
            Restart-Wsl -Distro $Distro
            Start-Sleep -Seconds 1
            try {
                & wsl.exe -l -q >$null 2>&1
            } catch {
                Write-Trace ("wsl.exe -l -q raised after catastrophic restart: {0}" -f $_.Exception.Message)
            }
            Invoke-WslRetryDelay -Attempt $attempt
            continue
        }

        break
    }

    if ($exitCode -ne 0 -and -not $NoThrow) {
        $joined = ($outputLines -join [Environment]::NewLine)
        Throw-InstallerError ("{0} failed (exit {1}).`nCommand:`n{2}`nOutput:`n{3}" -f $Description, $exitCode, $Command, $joined)
    }

    if ($script:InstallerTraceEnabled) {
        if ($outputLines.Count -gt 0 -and -not $Silent) {
            $outputLines | ForEach-Object { Write-Trace ("    {0}" -f $_) }
        }
        Write-Trace ("WSL[{0}] exit {1}" -f $Distro, $exitCode)
    } elseif (-not $Silent -and $outputLines.Count -gt 0) {
        $outputLines | ForEach-Object { Write-Host ("    {0}" -f $_) }
    }

    [pscustomobject]@{
        ExitCode = $exitCode
        Output   = $outputLines
    }
}

function Invoke-WslCommandNoThrow {
    param(
        [string]$Distro,
        [string]$Command,
        [string]$Description = "WSL command"
    )
    $silent = -not $script:InstallerTraceEnabled
    Invoke-WslCommand -Distro $Distro -Command $Command -Description $Description -Silent:$silent -NoThrow
}

function Write-ContentToWslFile {
    param(
        [string]$Distro,
        [string]$RemotePath,
        [string]$Content
    )

    $marker = "EOF$([guid]::NewGuid().ToString('N').Substring(0,8))"
    $escapedRemote = Escape-SingleQuotes $RemotePath
    $normalized = ($Content -replace "`r", '')
    if (-not $normalized.EndsWith("`n")) {
        $normalized += "`n"
    }
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($tempFile, $normalized, $utf8NoBom)
        $wslSource = Convert-WindowsPathToWsl -Distro $Distro -WindowsPath $tempFile
        $escapedSource = Escape-SingleQuotes $wslSource
        $command = "cp '$escapedSource' '$escapedRemote'"
        $null = Invoke-WslCommand -Distro $Distro -Command $command -Description "Copy $RemotePath" -Silent
    } finally {
        if (Test-Path -Path $tempFile) {
            Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue | Out-Null
        }
    }
}

function Get-WslResolvedPath {
    param(
        [string]$Distro,
        [string]$RawPath
    )

    if ([string]::IsNullOrWhiteSpace($RawPath)) {
        Throw-InstallerError "Path cannot be empty."
    }

    $trimmed = $RawPath.Trim()
    if ($trimmed.StartsWith('/')) {
        return Normalize-UnixPath $trimmed
    }

    $wslHome = Get-WslHomeDirectory -Distro $Distro
    if ($trimmed -eq '~') {
        return Normalize-UnixPath $wslHome
    }

    if ($trimmed.StartsWith('~')) {
        $suffix = $trimmed.Substring(1)
        return Normalize-UnixPath ($wslHome + $suffix)
    }

    return Normalize-UnixPath ("$wslHome/$trimmed")
}

function Get-WslIpv4Address {
    param(
        [string]$Distro
    )

    $commands = @(
        'hostname -I | awk ''{print $1}''',
        'ip -o -4 addr show scope global | awk ''NR==1 {print $4}'' | cut -d/ -f1',
        '/sbin/ip -o -4 addr show scope global | awk ''NR==1 {print $4}'' | cut -d/ -f1'
    )

    foreach ($cmd in $commands) {
        $result = Invoke-WslCommandNoThrow -Distro $Distro -Command $cmd -Description "Detect WSL IPv4"
        if ($result.ExitCode -eq 0) {
            $candidate = ($result.Output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -First 1
            if ($candidate) {
                return $candidate.Trim()
            }
        }
    }

    Throw-InstallerError "Cannot detect IPv4 address inside WSL; ensure the distro is running and has an active network interface."
}

function Ensure-FirewallRule {
    param(
        [int]$Port
    )

    $ruleName = "OpenVSCode Server (port $Port)"
    $existing = Get-Command -Name Get-NetFirewallRule -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if ($null -eq $rule) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
            Write-Info "Firewall rule '$ruleName' created."
        } else {
            Write-Info "Firewall rule '$ruleName' already exists."
        }
        return
    }

    & netsh advfirewall firewall show rule name="$ruleName" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Info "Firewall rule '$ruleName' already exists."
        return
    }

    & netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$Port | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Unable to create firewall rule '$ruleName'. Add it manually if necessary."
    } else {
        Write-Info "Firewall rule '$ruleName' created."
    }
}

function Ensure-Prerequisites {
    if ($env:OS -eq 'Windows_NT') {
        Require-Administrator
    }
    Require-PowerShellVersion

    if (-not (Get-Command -Name wsl.exe -ErrorAction SilentlyContinue)) {
        Throw-InstallerError "wsl.exe not found. Install Windows Subsystem for Linux and create a distribution first."
    }
}

function Select-Distro {
    Ensure-WslServiceReady -TimeoutSeconds 60 | Out-Null

    $result = & wsl.exe -l -q 2>&1
    if ($LASTEXITCODE -ne 0) {
        Throw-InstallerError "Failed to list WSL distributions:`n$result"
    }

    $distros = @(
        $result |
        ForEach-Object { Sanitize-DistroName $_ } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Unique
    )
    if ($distros.Count -eq 0) {
        Throw-InstallerError "No WSL distributions found. Use 'wsl --install' and rerun the script."
    }

    return (Prompt-Selection -Prompt "Select a WSL distribution" -Options $distros)
}

function Install-OpenVSCodeServer {
    Debug-Log "Install-OpenVSCodeServer invoked"
    Ensure-Prerequisites
    Debug-Log "Prerequisites ensured"

    Write-Host ""
    Write-Info "OpenVSCode Server WSL installer"

    Debug-Log "Prompting for distro selection"
    $distro = Select-Distro
    Debug-Log ("Distro selected: {0}" -f $distro)
    Write-Info "Using WSL distribution: $distro"
    $distroReady = Ensure-WslServiceReady -TimeoutSeconds 90 -Distro $distro -AllowContinue
    if (-not $distroReady) {
        Start-Sleep -Seconds 15
    }

    Debug-Log "Prompting for installation directory"
    $installPath = Prompt-String -Prompt "Installation directory inside WSL" -Default '/home/services/openvscode-service' -Validator {
        param($value)
        return (-not [string]::IsNullOrWhiteSpace($value)) -and ($value.Trim().StartsWith('/'))
    } -ValidationErrorMessage "Please enter an absolute path (starts with /)."
    Debug-Log ("Install path response: '{0}'" -f $installPath)

    $bootstrapContent = $null
    $bootstrapCleanupPath = $null
    $bootstrapOverride = $BootstrapPath
    if (-not $bootstrapOverride -and -not [string]::IsNullOrWhiteSpace($env:OVS_BOOTSTRAP_PATH)) {
        $bootstrapOverride = $env:OVS_BOOTSTRAP_PATH
    }

    if ($bootstrapOverride) {
        try {
            $resolvedBootstrap = Resolve-Path -Path $bootstrapOverride -ErrorAction Stop
            $bootstrapFile = $resolvedBootstrap.ProviderPath
        } catch {
            Throw-InstallerError ("Bootstrap script '{0}' not found or inaccessible." -f $bootstrapOverride)
        }
        Write-Info ("Using local bootstrapper script: {0}" -f $bootstrapFile)
        try {
            $bootstrapContent = Get-Content -Path $bootstrapFile -Raw -Encoding UTF8
        } catch {
            Throw-InstallerError ("Failed to read bootstrap script '{0}': {1}" -f $bootstrapFile, $_.Exception.Message)
        }
        try {
            $localHash = (Get-FileHash -Path $bootstrapFile -Algorithm SHA256).Hash
            Write-Info ("Local bootstrapper SHA256: {0}" -f $localHash)
        } catch {
            Write-Trace ("Unable to compute hash for {0}: {1}" -f $bootstrapFile, $_.Exception.Message)
        }
    } else {
        $downloadPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("openvscode-server-{0}.sh" -f ([guid]::NewGuid().ToString('N')))
        $bootstrapCleanupPath = $downloadPath
        Write-Info "Downloading bootstrapper script..."
        try {
            if ($PSVersionTable.PSVersion.Major -lt 6) {
                Invoke-WebRequest -Uri $ScriptUri -OutFile $downloadPath -UseBasicParsing | Out-Null
            } else {
                Invoke-WebRequest -Uri $ScriptUri -OutFile $downloadPath | Out-Null
            }
        } catch {
            Throw-InstallerError "Download failed: $($_.Exception.Message)"
        }
        $hash = (Get-FileHash -Path $downloadPath -Algorithm SHA256).Hash
        Write-Info "Downloaded openvscode-server.sh (SHA256: $hash)"
        $bootstrapContent = Get-Content -Path $downloadPath -Raw -Encoding UTF8
    }

    try {
        $resolvedInstall = Get-WslResolvedPath -Distro $distro -RawPath $installPath
        Write-Info "Resolved installation path: $resolvedInstall"

        $escapedInstall = Escape-SingleQuotes $resolvedInstall

        $null = Invoke-WslCommand -Distro $distro -Command "mkdir -p '$escapedInstall'" -Description "Create installation directory"

        $existingConfig = Read-OpenVSCodeEnv -Distro $distro -InstallPath $resolvedInstall
        if ($existingConfig) {
            Write-Info "Detected existing OpenVSCode Server configuration; reusing values as defaults."
        }
        $defaultEnvVars = Build-OpenVSCodeDefaultEnvVars $existingConfig
        if (-not $defaultEnvVars) { $defaultEnvVars = @{} }

        $expectedServiceName = Get-ExpectedServiceName $resolvedInstall
        $defaultEnvVars['OVS_EXPECTED_SERVICE_NAME'] = $expectedServiceName
        if (-not $defaultEnvVars.ContainsKey('OVS_DEFAULT_SYSTEMD_SERVICE_NAME')) {
            $defaultEnvVars['OVS_DEFAULT_SYSTEMD_SERVICE_NAME'] = $expectedServiceName
        }
        if (-not $defaultEnvVars.ContainsKey('OVS_DEFAULT_TLS_MODE')) {
            $defaultEnvVars['OVS_DEFAULT_TLS_MODE'] = 'self-signed'
        }
        if ($existingConfig -and $existingConfig.ContainsKey('OVS_INSTALL_ROOT') -and $existingConfig['OVS_INSTALL_ROOT'] -ne $resolvedInstall) {
            $defaultEnvVars['OVS_PREVIOUS_INSTALL_ROOT'] = $existingConfig['OVS_INSTALL_ROOT']
        }

        Write-ContentToWslFile -Distro $distro -RemotePath "$resolvedInstall/openvscode-server.sh" -Content $bootstrapContent
        $null = Invoke-WslCommand -Distro $distro -Command "chmod +x '$escapedInstall/openvscode-server.sh'" -Description "Mark script executable"

        Write-Host ""
        $envAssignment = ''
        if ($defaultEnvVars.Count -gt 0) {
            $pairs = @()
            foreach ($entry in ($defaultEnvVars.GetEnumerator() | Sort-Object Name)) {
                $escapedValue = Escape-SingleQuotes $entry.Value
                $pairs += ("{0}='{1}'" -f $entry.Name, $escapedValue)
            }
            if ($pairs.Count -gt 0) {
                $envAssignment = ($pairs -join ' ') + ' '
            }
        }
        $prefixedBase = if ($envAssignment) { "$envAssignment./openvscode-server.sh" } else { "./openvscode-server.sh" }
        $stopCommand = "$prefixedBase --service-stop >/dev/null 2>&1 || true"
        $interactiveCommand = $prefixedBase
        if ($ScriptArgs -and $ScriptArgs.Count -gt 0) {
            $quotedArgs = $ScriptArgs | ForEach-Object { "'$(Escape-SingleQuotes $_)'" }
            $interactiveCommand = "$interactiveCommand " + ($quotedArgs -join ' ')
        }
        $commandToRun = "cd '$escapedInstall' && { $stopCommand; $interactiveCommand; }"
        Write-Info "Running openvscode-server.sh inside WSL. Follow the prompts in the WSL console."
        & wsl.exe -d $distro -- bash -lc $commandToRun
        $wslExit = $LASTEXITCODE
        if ($wslExit -ne 0) {
            Write-Warn ("openvscode-server.sh exited with code {0}." -f $wslExit)
            $diagnosed = $false
            $existingAfterFailure = Read-OpenVSCodeEnv -Distro $distro -InstallPath $resolvedInstall
            if ($existingAfterFailure -and $existingAfterFailure.ContainsKey('OVS_PORT')) {
                $portHint = $existingAfterFailure['OVS_PORT']
                $portParsed = 0
                if ([int]::TryParse($portHint, [ref]$portParsed) -and $portParsed -ge 1 -and $portParsed -le 65535) {
                    $awkTemplate = @'
awk -v port={0} '(\$4 ~ (":" port "$")) || (\$4 ~ ("\\." port "$")) {{print; found=1}} END {{exit found ? 0 : 1}}'
'@
                    $awkScript = [string]::Format($awkTemplate, $portParsed)
                    $portInspect = "cd '$escapedInstall' && { if command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null; elif command -v netstat >/dev/null 2>&1; then netstat -ltnp 2>/dev/null; else netstat -ltn 2>/dev/null; fi; } | $awkScript"
                    $portResult = Invoke-WslCommandNoThrow -Distro $distro -Command $portInspect -Description "Inspect port usage"
                    $portLines = @()
                    if ($portResult -and $portResult.Output) {
                        if ($portResult.Output -is [System.Array]) {
                            $portLines = [string[]]$portResult.Output
                        } else {
                            $portLines = @([string]$portResult.Output)
                        }
                    }
                    if ($portLines.Count -gt 0) {
                        Write-Warn ("Detected listeners on port {0}:" -f $portParsed)
                        Write-TraceLines -Header ("Port {0} usage" -f $portParsed) -Lines $portLines
                        foreach ($line in $portLines) {
                            Write-Warn ("    {0}" -f $line)
                        }
                        $diagnosed = $true
                    } else {
                        Write-TraceLines -Header ("Port {0} usage command returned no matches" -f $portParsed) -Lines $portResult.Output
                    }
                }
            }
            if (-not $diagnosed) {
                Write-Warn "Skipping Windows-side configuration because the bootstrapper did not complete successfully."
            } else {
                Write-Warn "Stop or reconfigure the running instance before retrying the installer."
            }
            return
        }

        $config = Read-OpenVSCodeEnv -Distro $distro -InstallPath $resolvedInstall
        $selectedPort = $null
        $tlsModeValue = $null
        if ($config -and $config.ContainsKey('OVS_TLS_MODE')) {
            $tlsModeValue = $config['OVS_TLS_MODE']
        }

        if ($config) {
            if (-not $config.ContainsKey('OVS_PORT')) {
                Write-Warn "OVS_PORT not found in .openvscode-server/env; skipping Windows-side networking configuration."
            } else {
                $portValue = $config['OVS_PORT']
                $parsedPort = 0
                if (-not [int]::TryParse($portValue, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
                    Write-Warn ("OVS_PORT value '{0}' is not a valid TCP port; skipping Windows-side networking configuration." -f $portValue)
                } else {
                    $selectedPort = $parsedPort
                }
            }
        } else {
            Write-Warn "Could not read .openvscode-server/env. Skip Windows-side networking configuration or rerun after finishing setup in WSL."
        }

        $windowsAccessConfigured = $false
        $patcherStatus = Get-WslHostPatcherStatus -Distro $distro

        if ($selectedPort) {
            Write-Host ""
            if ($patcherStatus.IsManaged) {
                $displayPath = if ($patcherStatus.WindowsPath) { $patcherStatus.WindowsPath } else { '<unknown>' }
                Write-Info ("WSLHostPatcher port forwarding already enabled. Executable: {0}" -f $displayPath)
                if (-not $patcherStatus.ExeExists -and $patcherStatus.WindowsPath) {
                    Write-Warn ("File {0} was not found. Re-installing WSLHostPatcher." -f $patcherStatus.WindowsPath)
                    Enable-WslHostPatcher -Distro $distro -DefaultDirectory $script:InstallerRoot -CurrentStatus $patcherStatus
                    $patcherStatus = Get-WslHostPatcherStatus -Distro $distro
                } elseif ($patcherStatus.ExeExists -and $patcherStatus.WindowsPath) {
                    Invoke-WslHostPatcher -Distro $distro -WindowsPath $patcherStatus.WindowsPath
                }
            } else {
                if ($patcherStatus.BootCommand) {
                    Write-Warn ("A boot command is already present in /etc/wsl.conf: {0}" -f $patcherStatus.BootCommand)
                } else {
                    Write-Info "Port forwarding via WSLHostPatcher is not configured."
                }
                if (Prompt-YesNo -Prompt "Enable port forwarding using WSLHostPatcher?" -Default $true) {
                    Enable-WslHostPatcher -Distro $distro -DefaultDirectory $script:InstallerRoot -CurrentStatus $patcherStatus
                    $patcherStatus = Get-WslHostPatcherStatus -Distro $distro
                }
            }

            if (-not $patcherStatus.IsManaged) {
                Write-Warn "Automatic port forwarding remains disabled."
                Write-Info ("Manual access: wsl -d {0} -- bash -lc 'cd {1} && ./openvscode-server.sh --run-only'" -f $distro, $resolvedInstall)
                Write-Info ("Update binaries manually: wsl -d {0} -- bash -lc 'cd {1} && ./openvscode-server.sh --download'" -f $distro, $resolvedInstall)
            }
        }

        if ($patcherStatus -and $patcherStatus.IsManaged -and $patcherStatus.ExeExists) {
            $windowsAccessConfigured = $true
        }

        if ($config) {
            $userProfile = Get-Item -Path Env:USERPROFILE -ErrorAction SilentlyContinue
            if ($userProfile) {
                $defaultWindowsCertBase = Join-Path -Path $userProfile.Value -ChildPath "openvscode-server-certs"
            } else {
                $defaultWindowsCertBase = $null
            }

            $localCertDir = if ($defaultWindowsCertBase) {
                $defaultWindowsCertBase
            } else {
                Join-Path -Path $script:InstallerRoot -ChildPath "openvscode-server-certs"
            }
            $copiedAny = $false
            $tlsCertWindowsPath = $null
            try {
                if ($config.ContainsKey('OVS_TLS_CERT') -and -not [string]::IsNullOrWhiteSpace($config['OVS_TLS_CERT'])) {
                    $certDestination = Join-Path -Path $localCertDir -ChildPath (Split-Path -Path $config['OVS_TLS_CERT'] -Leaf)
                    if (Copy-WslFileToWindows -Distro $distro -RemotePath $config['OVS_TLS_CERT'] -DestinationPath $certDestination -Description 'TLS certificate') {
                        $copiedAny = $true
                        $tlsCertWindowsPath = $certDestination
                    }
                }
                if ($config.ContainsKey('OVS_TLS_KEY') -and -not [string]::IsNullOrWhiteSpace($config['OVS_TLS_KEY'])) {
                    $keyDestination = Join-Path -Path $localCertDir -ChildPath (Split-Path -Path $config['OVS_TLS_KEY'] -Leaf)
                    if (Copy-WslFileToWindows -Distro $distro -RemotePath $config['OVS_TLS_KEY'] -DestinationPath $keyDestination -Description 'TLS key') {
                        $copiedAny = $true
                    }
                }
            } catch {
                Write-Warn "Failed to copy TLS materials from WSL."
            }
            if ($copiedAny) {
                Write-Info ("TLS materials copied to {0}" -f $localCertDir)
            }

            if ($tlsCertWindowsPath -and $tlsModeValue -and $tlsModeValue.Equals('self-signed', [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Host ""
                if (Prompt-YesNo -Prompt "Install the self-signed certificate into the Windows trust store (CurrentUser\\Root)?" -Default $true) {
                    if (-not (Install-WindowsCertificate -CertificatePath $tlsCertWindowsPath)) {
                        Write-Warn "Certificate import failed. Import it manually if browsers report trust warnings."
                    }
                } else {
                    if ($selectedPort) {
                        Write-Warn ("Self-signed certificate not imported. Browsers may report security warnings for https://localhost:{0}" -f $selectedPort)
                    } else {
                        Write-Warn "Self-signed certificate not imported. Browsers may report security warnings."
                    }
                }
            }
        }

        Write-Host ""
        if ($windowsAccessConfigured) {
            Write-Info "Hand-off complete. Manage OpenVSCode Server inside WSL as needed."
        } else {
            Write-Info "WSL bootstrap complete. Configure network access manually if required."
        }
    } finally {
        if ($bootstrapCleanupPath -and (Test-Path -Path $bootstrapCleanupPath)) {
            Remove-Item -Path $bootstrapCleanupPath -Force -ErrorAction SilentlyContinue | Out-Null
        }
    }
}

try {
    Install-OpenVSCodeServer
} catch {
    Write-ErrorLine ("Installation failed: {0}" -f $_.Exception.Message)
    exit 1
} finally {
    $handlerVar = Get-Variable -Name ConsoleCancelHandler -Scope Script -ErrorAction SilentlyContinue
    $attachedVar = Get-Variable -Name ConsoleCancelHandlerAttached -Scope Script -ErrorAction SilentlyContinue
    if ($attachedVar -and $attachedVar.Value -and $handlerVar) {
        $handler = $handlerVar.Value
        if ($null -ne $handler) {
            try {
                [System.Console]::remove_CancelKeyPress($handler)
            } catch {
                # ignore cleanup errors
            }
        }
    }
}
