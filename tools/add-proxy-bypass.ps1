param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^(?:\d{1,3}\.){3}\d{1,3}$')]
    [string]$Address
)

$settingsPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$settings = Get-ItemProperty -LiteralPath $settingsPath
$entries = @($settings.ProxyOverride -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })

if ($entries -notcontains $Address) {
    $entries += $Address
    Set-ItemProperty -LiteralPath $settingsPath -Name ProxyOverride -Value ($entries -join ';')
}

if (-not ('WinInet.ProxySettings' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace WinInet {
    public static class ProxySettings {
        [DllImport("wininet.dll", SetLastError = true)]
        public static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int bufferLength);
    }
}
'@
}

[void][WinInet.ProxySettings]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][WinInet.ProxySettings]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)

(Get-ItemProperty -LiteralPath $settingsPath).ProxyOverride
