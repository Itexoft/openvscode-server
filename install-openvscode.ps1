<#
    OpenVSCode Server WSL installer.
    Downloads https://raw.githubusercontent.com/Itexoft/openvscode-server/refs/heads/main/openvscode-server.sh
    and wires portproxy on Windows.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptUri = 'https://raw.githubusercontent.com/Itexoft/openvscode-server/refs/heads/main/openvscode-server.sh'

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO ] $Message" -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN ] $Message" -ForegroundColor Yellow
}

function Write-ErrorLine {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
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

    $suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
    while ($true) {
        Write-Host -NoNewline "$Prompt $suffix "
        $response = Read-Host
        if ([string]::IsNullOrWhiteSpace($response)) {
            return $Default
        }
        switch ($response.ToLowerInvariant()) {
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
            Write-Host -NoNewline "$Prompt [$Default]: "
        } else {
            Write-Host -NoNewline "$Prompt: "
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

function Escape-SingleQuotes {
    param([string]$Value)
    if ($Value -eq $null) { return '' }
    return $Value -replace "'", "'\"'\"'"
}

function Invoke-WslCommand {
    param(
        [string]$Distro,
        [string]$Command,
        [string]$Description = "WSL command",
        [switch]$Silent,
        [switch]$NoThrow
    )

    $arguments = @('-d', $Distro, '--', 'bash', '-lc', $Command)
    $rawOutput = & wsl.exe @arguments 2>&1
    $exitCode = $LASTEXITCODE
    $outputLines = @()
    if ($null -ne $rawOutput) {
        if ($rawOutput -is [System.Array]) {
            $outputLines = [string[]]$rawOutput
        } else {
            $outputLines = @([string]$rawOutput)
        }
    }

    if ($exitCode -ne 0 -and -not $NoThrow) {
        $joined = ($outputLines -join [Environment]::NewLine)
        Throw-InstallerError "$Description failed (exit $exitCode):`n$joined"
    }

    if (-not $Silent -and $outputLines.Count -gt 0) {
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
    Invoke-WslCommand -Distro $Distro -Command $Command -Description $Description -Silent -NoThrow
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

    $command = @"
cat <<'$marker' > '$escapedRemote'
$normalized$marker
"@
    Invoke-WslCommand -Distro $Distro -Command $command -Description "Write $RemotePath" -Silent
}

function Get-WslResolvedPath {
    param(
        [string]$Distro,
        [string]$RawPath
    )

    $escaped = Escape-SingleQuotes $RawPath
    $commands = @(
        "python3 - <<'PY'
import os
path = os.path.expanduser('$escaped')
print(os.path.abspath(path))
PY",
        "python - <<'PY'
import os
path = os.path.expanduser('$escaped')
print(os.path.abspath(path))
PY",
        "cd / && if command -v realpath >/dev/null 2>&1; then realpath -m '$escaped'; else readlink -m '$escaped'; fi"
    )

    foreach ($cmd in $commands) {
        $result = Invoke-WslCommandNoThrow -Distro $Distro -Command $cmd -Description "Resolve $RawPath"
        if ($result.ExitCode -eq 0 -and $result.Output.Count -gt 0) {
            $line = $result.Output[-1]
            if (-not [string]::IsNullOrWhiteSpace($line)) {
                return $line.Trim()
            }
        }
    }

    Throw-InstallerError "Unable to resolve path '$RawPath' inside WSL."
}

function Get-WslIpv4Address {
    param(
        [string]$Distro
    )

    $commands = @(
        "hostname -I | awk '{print \$1}'",
        "ip -o -4 addr show scope global | awk 'NR==1 {print \$4}' | cut -d/ -f1",
        "/sbin/ip -o -4 addr show scope global | awk 'NR==1 {print \$4}' | cut -d/ -f1"
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

function Get-PortProxyEntries {
    $output = & netsh interface portproxy show v4tov4
    if ($LASTEXITCODE -ne 0) {
        Throw-InstallerError "netsh portproxy query failed."
    }

    $entries = @()
    foreach ($line in $output) {
        if ($line -match '^\s*(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s*$') {
            $entries += [pscustomobject]@{
                ListenAddress  = $matches[1]
                ListenPort     = [int]$matches[2]
                ConnectAddress = $matches[3]
                ConnectPort    = [int]$matches[4]
            }
        }
    }

    return $entries
}

function Remove-PortProxyEntry {
    param(
        [string]$ListenAddress,
        [int]$ListenPort
    )

    & netsh interface portproxy delete v4tov4 listenaddress=$ListenAddress listenport=$ListenPort | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Throw-InstallerError "Failed to delete portproxy at $ListenAddress:$ListenPort."
    }
}

function Add-PortProxyEntry {
    param(
        [int]$Port,
        [string]$ConnectAddress
    )

    $existing = Get-PortProxyEntries | Where-Object { $_.ListenAddress -eq '0.0.0.0' -and $_.ListenPort -eq $Port }
    if ($existing.Count -gt 0) {
        $match = $existing | Where-Object { $_.ConnectAddress -eq $ConnectAddress -and $_.ConnectPort -eq $Port }
        if ($match.Count -gt 0) {
            Write-Info "Portproxy already points to $ConnectAddress:$Port."
            return
        }
        $current = $existing | Select-Object -First 1
        Throw-InstallerError ("Port $Port is already proxied to {0}:{1}. Remove the existing mapping or choose another port." -f $current.ConnectAddress, $current.ConnectPort)
    }

    & netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$Port connectaddress=$ConnectAddress connectport=$Port | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Throw-InstallerError "Failed to create portproxy for port $Port."
    }
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
    Require-Administrator
    Require-PowerShellVersion

    if (-not (Get-Command -Name wsl.exe -ErrorAction SilentlyContinue)) {
        Throw-InstallerError "wsl.exe not found. Install Windows Subsystem for Linux and create a distribution first."
    }
}

function Select-Distro {
    $result = & wsl.exe -l -q 2>&1
    if ($LASTEXITCODE -ne 0) {
        Throw-InstallerError "Failed to list WSL distributions:`n$result"
    }

    $distros = $result | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { $_.Trim() }
    if ($distros.Count -eq 0) {
        Throw-InstallerError "No WSL distributions found. Use 'wsl --install' and rerun the script."
    }

    return (Prompt-Selection -Prompt "Select a WSL distribution" -Options $distros)
}

function Gather-Preferences {
    $defaults = @{
        InstallPath  = '/home/services/openvscode-service'
        Workspace    = '~/dev'
        Port         = '3000'
    }

    while ($true) {
        $installPath = Prompt-String -Prompt "Installation directory inside WSL" -Default $defaults.InstallPath -Validator {
            param($value)
            return (-not [string]::IsNullOrWhiteSpace($value)) -and ($value.Trim().StartsWith('/'))
        } -ValidationErrorMessage "Please enter an absolute path (starts with /)."

        $workspace = Prompt-String -Prompt "Workspace directory for projects" -Default $defaults.Workspace -Validator {
            param($value)
            return -not [string]::IsNullOrWhiteSpace($value)
        }

        $port = Prompt-String -Prompt "HTTP port for OpenVSCode Server" -Default $defaults.Port -Validator {
            param($value)
            $parsed = 0
            if ([int]::TryParse($value, [ref]$parsed)) {
                return $parsed -ge 1 -and $parsed -le 65535
            }
            return $false
        } -ValidationErrorMessage "Enter a port number between 1 and 65535."

        $token = Prompt-String -Prompt "Connection token (leave blank to disable)" -Default ''

        Write-Host ""
        Write-Host "Configuration preview:"
        Write-Host "  Install path : $installPath"
        Write-Host "  Workspace    : $workspace"
        Write-Host "  Port         : $port"
        Write-Host ("  Token        : {0}" -f ($(if ([string]::IsNullOrEmpty($token)) { '<disabled>' } else { '<hidden>' })))
        Write-Host ""

        if (Prompt-YesNo -Prompt "Proceed with these settings?" -Default $true) {
            return [pscustomobject]@{
                InstallPath = $installPath
                Workspace   = $workspace
                Port        = [int]$port
                Token       = $token
            }
        }

        if (-not (Prompt-YesNo -Prompt "Restart configuration wizard?" -Default $true)) {
            Throw-InstallerError "Installation aborted by user."
        }
    }
}

function Manage-ExistingProcesses {
    param(
        [string]$Distro,
        [string]$InstallPath,
        [int]$Port
    )

    $escaped = Escape-SingleQuotes $InstallPath
    $cmd = "cd '$escaped' && pgrep -af 'openvscode-server.*--port $Port'"
    $result = Invoke-WslCommandNoThrow -Distro $Distro -Command $cmd -Description "Check running OpenVSCode processes"
    if ($result.ExitCode -ne 0 -or -not $result.Output) {
        return
    }

    Write-Warn "Existing OpenVSCode Server processes detected on port $Port:"
    $result.Output | ForEach-Object { Write-Host ("    {0}" -f $_) }
    if (Prompt-YesNo -Prompt "Terminate these processes before continuing?" -Default $true) {
        $kill = "pgrep -f 'openvscode-server.*--port $Port' | xargs -r kill"
        Invoke-WslCommand -Distro $Distro -Command $kill -Description "Terminate running OpenVSCode"
    } else {
        Write-Warn "Continuing without terminating existing processes. Port binding may fail."
    }
}

function Cleanup-PortProxy {
    param([int]$Port)

    $existing = Get-PortProxyEntries | Where-Object { $_.ListenPort -eq $Port }
    if ($existing.Count -eq 0) {
        return
    }

    Write-Warn "Existing portproxy entries for port $Port:"
    foreach ($entry in $existing) {
        Write-Host ("    {0}:{1} -> {2}:{3}" -f $entry.ListenAddress, $entry.ListenPort, $entry.ConnectAddress, $entry.ConnectPort)
    }

    if (Prompt-YesNo -Prompt "Remove these entries before creating a new mapping?" -Default $true) {
        foreach ($entry in $existing) {
            Remove-PortProxyEntry -ListenAddress $entry.ListenAddress -ListenPort $entry.ListenPort
        }
        Write-Info "Old portproxy entries removed."
    } else {
        Write-Warn "Keeping existing portproxy entries; new mapping may fail if a duplicate exists."
    }
}

function Install-OpenVSCodeServer {
    Ensure-Prerequisites

    Write-Host ""
    Write-Info "OpenVSCode Server WSL installer"

    $distro = Select-Distro
    Write-Info "Using WSL distribution: $distro"

    $prefs = Gather-Preferences

    $downloadPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("openvscode-server-{0}.sh" -f ([guid]::NewGuid().ToString('N')))
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

    try {
        $resolvedInstall = Get-WslResolvedPath -Distro $distro -RawPath $prefs.InstallPath
        $resolvedWorkspace = Get-WslResolvedPath -Distro $distro -RawPath $prefs.Workspace

        Write-Info "Resolved installation path: $resolvedInstall"
        Write-Info "Resolved workspace path: $resolvedWorkspace"

        $escapedInstall = Escape-SingleQuotes $resolvedInstall
        $escapedWorkspace = Escape-SingleQuotes $resolvedWorkspace
        $dataDir = "$resolvedInstall/.openvscode-server"

        Invoke-WslCommand -Distro $distro -Command "mkdir -p '$escapedInstall'" -Description "Create installation directory"
        Invoke-WslCommand -Distro $distro -Command "mkdir -p '$escapedWorkspace'" -Description "Create workspace directory"
        Invoke-WslCommand -Distro $distro -Command "mkdir -p '$(Escape-SingleQuotes $dataDir)'" -Description "Create data directory"

        $scriptContent = Get-Content -Path $downloadPath -Raw -Encoding UTF8
        Write-ContentToWslFile -Distro $distro -RemotePath "$resolvedInstall/openvscode-server.sh" -Content $scriptContent
        Invoke-WslCommand -Distro $distro -Command "chmod +x '$escapedInstall/openvscode-server.sh'" -Description "Mark script executable"

        $envContent = @"
OVS_PORT=$($prefs.Port)
OVS_HOST=0.0.0.0
OVS_DATA_DIR=$dataDir
OVS_TOKEN=$($prefs.Token)
OVS_TLS_MODE=none
OVS_TLS_CERT=
OVS_TLS_KEY=
OVS_WORKSPACE_ROOT=$resolvedWorkspace
OVS_EXTRA_ARGS=--enable-proposed-api=*
"@
        Write-ContentToWslFile -Distro $distro -RemotePath "$resolvedInstall/.openvscode-server/env" -Content $envContent

        Manage-ExistingProcesses -Distro $distro -InstallPath $resolvedInstall -Port $prefs.Port

        Write-Info "Fetching or updating OpenVSCode Server binaries..."
        Invoke-WslCommand -Distro $distro -Command "cd '$escapedInstall' && ./openvscode-server.sh --download" -Description "Download OpenVSCode Server"

        Write-Info "Starting OpenVSCode Server inside WSL..."
        $startCmd = "cd '$escapedInstall' && nohup ./openvscode-server.sh --run-only >/dev/null 2>&1 & echo \$!"
        $startResult = Invoke-WslCommand -Distro $distro -Command $startCmd -Description "Launch OpenVSCode Server" -Silent
        $pidLine = $startResult.Output | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1
        $pid = if ($pidLine) { $pidLine.Trim() } else { $null }
        if (-not $pid -or -not [int]::TryParse($pid, [ref]$null)) {
            Write-Warn "Could not determine server PID; verifying process status."
            $checkCmd = "pgrep -af 'openvscode-server.*--port $($prefs.Port)'"
            $check = Invoke-WslCommandNoThrow -Distro $distro -Command $checkCmd -Description "Verify OpenVSCode process"
            if ($check.ExitCode -ne 0 -or -not $check.Output) {
                Throw-InstallerError "OpenVSCode Server did not start as expected."
            }
        } else {
            Write-Info "OpenVSCode Server started with PID $pid."
        }

        Start-Sleep -Seconds 2

        $wslIp = Get-WslIpv4Address -Distro $distro
        Write-Info "WSL IPv4 address detected: $wslIp"

        Cleanup-PortProxy -Port $prefs.Port
        Add-PortProxyEntry -Port $prefs.Port -ConnectAddress $wslIp
        Write-Info "Portproxy configured: 0.0.0.0:$($prefs.Port) -> $wslIp:$($prefs.Port)"

        if (Prompt-YesNo -Prompt "Create/ensure Windows Firewall rule for TCP port $($prefs.Port)?" -Default $true) {
            Ensure-FirewallRule -Port $prefs.Port
        } else {
            Write-Warn "Skipped firewall rule creation. Allow inbound TCP $($prefs.Port) manually if needed."
        }

        Write-Host ""
        Write-Info "OpenVSCode Server is ready."
        Write-Host "  URL   : http://0.0.0.0:$($prefs.Port)"
        Write-Host "  WSL   : $distro ($resolvedInstall)"
        Write-Host "  Proxy : 0.0.0.0:$($prefs.Port) -> $wslIp:$($prefs.Port)"
        Write-Host ""
        Write-Host "Tips:"
        Write-Host "  • Restart server inside WSL: wsl -d $distro -- bash -lc 'cd $resolvedInstall && ./openvscode-server.sh --run-only'"
        Write-Host "  • Update binaries later:      wsl -d $distro -- bash -lc 'cd $resolvedInstall && ./openvscode-server.sh --download'"
        Write-Host "  • Remove portproxy:           netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$($prefs.Port)"
        Write-Host ""
        Write-Info "All done. You can close this window."
    } finally {
        if (Test-Path -Path $downloadPath) {
            Remove-Item -Path $downloadPath -Force -ErrorAction SilentlyContinue | Out-Null
        }
    }
}

try {
    Install-OpenVSCodeServer
} catch {
    Write-ErrorLine ("Installation failed: {0}" -f $_.Exception.Message)
    exit 1
}
