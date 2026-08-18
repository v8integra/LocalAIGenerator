# Lists PCI video controllers with a VRAM figure corrected for the WMI
# AdapterRAM bug (Win32_VideoController.AdapterRAM misreports actual VRAM
# for many modern GPUs, typically capping around 4GB regardless of the
# card's real size). The registry's HardwareInformation.qwMemorySize is
# accurate; each video class subkey is matched back to its controller via
# MatchingDeviceId, a prefix of the controller's PNPDeviceID.

$ErrorActionPreference = "Stop"
$classGuid = "{4d36e968-e325-11ce-bfc1-08002be10318}"
$controllers = Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like "PCI\*" }

$results = @()
foreach ($c in $controllers) {
  $registryVramBytes = $null
  for ($i = 0; $i -lt 32; $i++) {
    $subkeyPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\$classGuid\$($i.ToString('D4'))"
    if (-not (Test-Path $subkeyPath)) { break }

    $matchingId = (Get-ItemProperty -Path $subkeyPath -Name "MatchingDeviceId" -ErrorAction SilentlyContinue).MatchingDeviceId
    if ($matchingId -and $c.PNPDeviceID.ToUpper().StartsWith($matchingId.ToUpper())) {
      $mem = (Get-ItemProperty -Path $subkeyPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize"
      if ($mem) { $registryVramBytes = [int64]$mem }
      break
    }
  }

  $results += [PSCustomObject]@{
    name              = $c.Name
    vendor            = $c.AdapterCompatibility
    pnpDeviceId        = $c.PNPDeviceID
    adapterRamBytes   = [int64]$c.AdapterRAM
    registryVramBytes = $registryVramBytes
  }
}

# ConvertTo-Json collapses a single-element array to a bare object unless
# the input is forced into array context with @(...); this keeps the
# Node side's JSON.parse always seeing an array.
Write-Output (ConvertTo-Json @($results) -Depth 5)
