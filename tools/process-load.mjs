// Per-process CPU and GPU load, split into OUR processes and EVERY OTHER process on the machine, as
// evidence for telling frame spikes the game causes apart from those other programs cause (the
// project's test machine is shared with other projects' builds). Used by run-harness.mjs.
//
// Windows only (it reads Windows' own counters through one long-running PowerShell):
//   - CPU: every process's total processor time (Get-Process), differenced between samples, as a
//     percentage of the whole machine (all logical cores);
//   - GPU: Windows' per-process GPU engine counters (\GPU Engine(*)\Utilization Percentage, the
//     figures Task Manager shows), summed per engine for our processes and for the others; the
//     busiest engine gives each side's GPU load. This covers any GPU vendor, and it names the
//     process, which nvidia-smi's whole-GPU figure cannot.
// "Ours" is every process whose command line contains one of the given markers (the harness's own
// Chrome profile directory, which every Chrome child process carries) plus the given process ids
// (the node runner, which also hosts the Vite dev server). The sampler's own PowerShell and the WMI
// provider it queries are left out of both sides.
// Elsewhere (macOS, Linux) the sampler stays empty and says why.
import { spawn } from 'node:child_process';

const DEFAULT_INTERVAL_MS = 2000;
/** Our process list is refreshed this often: Chrome starts and ends renderer processes. */
const OWN_REFRESH_SECONDS = 6;
/** Other processes named per sample, by CPU and by GPU. */
const TOP_OTHERS = 4;

function powershellScript({ markers, ownPids, intervalMs }) {
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  return `
$ErrorActionPreference = 'Stop'
# No progress records: PowerShell would serialise them to stderr as CLIXML.
$ProgressPreference = 'SilentlyContinue'
$markers = @(${markers.map(quote).join(', ')})
$ownRoots = @(${ownPids.map((pid) => String(Number(pid))).join(', ')})
$cores = [Environment]::ProcessorCount
$intervalMs = ${Number(intervalMs)}
$own = @{}
# The first read of the GPU engine counters takes seconds (Windows builds the instance list); the
# reads after it take milliseconds. Utilisation is a rate: each value comes from two reads.
$gpuCategory = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')
$previousGpu = $null
$refreshAt = [datetime]::MinValue
$previousCpu = $null
$previousTime = $null
while ($true) {
  $loopStart = Get-Date
  if ($loopStart -ge $refreshAt) {
    $own = @{}
    foreach ($id in $ownRoots) { $own[[int]$id] = $true }
    foreach ($entry in Get-CimInstance Win32_Process) {
      $line = $entry.CommandLine
      if ($line) { foreach ($marker in $markers) { if ($line.Contains($marker)) { $own[[int]$entry.ProcessId] = $true; break } } }
    }
    $refreshAt = $loopStart.AddSeconds(${OWN_REFRESH_SECONDS})
  }
  $gpuNow = $null
  $gpuError = $null
  try { $gpuNow = $gpuCategory.ReadCategory()['Utilization Percentage'] } catch { $gpuError = $_.Exception.Message }
  $time = Get-Date
  $cpu = @{}
  $names = @{}
  foreach ($entry in Get-Process) {
    $names[$entry.Id] = $entry.ProcessName
    if ($entry.Id -eq 0 -or $entry.Id -eq $PID -or $entry.ProcessName -like 'WmiPrvSE*') { continue }
    # Protected processes do not report their processor time to other users' processes.
    $seconds = $entry.CPU
    if ($null -ne $seconds) { $cpu[$entry.Id] = [double]$seconds }
  }
  if ($null -ne $previousCpu) {
    $wall = ($time - $previousTime).TotalSeconds * $cores
    $ownCpu = 0.0
    $otherCpu = 0.0
    $otherByName = @{}
    foreach ($id in $cpu.Keys) {
      if (-not $previousCpu.ContainsKey($id)) { continue }
      $used = $cpu[$id] - $previousCpu[$id]
      if ($used -le 0) { continue }
      if ($own.ContainsKey([int]$id)) { $ownCpu += $used } else {
        $otherCpu += $used
        $name = $names[$id]
        if ($otherByName.ContainsKey($name)) { $otherByName[$name] += $used } else { $otherByName[$name] = $used }
      }
    }
    $ownEngines = @{}
    $otherEngines = @{}
    $otherGpuByName = @{}
    $gpuErrors = 0
    if ($gpuError) { $gpuErrors++ }
    if ($null -ne $gpuNow -and $null -ne $previousGpu) {
      foreach ($instance in $gpuNow.Keys) {
        if (-not $previousGpu.Contains($instance)) { continue }
        if ($instance -notmatch '^pid_(\\d+)_(luid_\\w+?_phys_\\d+_eng_\\d+)_engtype') { continue }
        $value = [System.Diagnostics.CounterSample]::Calculate($previousGpu[$instance].Sample, $gpuNow[$instance].Sample)
        if ($value -le 0) { continue }
        $gpuPid = [int]$Matches[1]
        $engine = $Matches[2]
        if ($own.ContainsKey($gpuPid)) { $ownEngines[$engine] = [double]$ownEngines[$engine] + $value } else {
          $otherEngines[$engine] = [double]$otherEngines[$engine] + $value
          $name = if ($names.ContainsKey($gpuPid)) { $names[$gpuPid] } else { "pid $gpuPid" }
          if ([double]$otherGpuByName[$name] -lt $value) { $otherGpuByName[$name] = $value }
        }
      }
    }
    $ownGpu = if ($ownEngines.Count -gt 0) { ($ownEngines.Values | Measure-Object -Maximum).Maximum } else { 0 }
    $otherGpu = if ($otherEngines.Count -gt 0) { ($otherEngines.Values | Measure-Object -Maximum).Maximum } else { 0 }
    $topCpu = @($otherByName.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First ${TOP_OTHERS} | ForEach-Object { @{ name = $_.Key; pct = [math]::Round($_.Value / $wall * 100, 1) } })
    $topGpu = @($otherGpuByName.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First ${TOP_OTHERS} | ForEach-Object { @{ name = $_.Key; pct = [math]::Round($_.Value, 1) } })
    $record = @{
      time = [DateTimeOffset]::new($time).ToUnixTimeMilliseconds()
      from = [DateTimeOffset]::new($previousTime).ToUnixTimeMilliseconds()
      ownCpuPct = [math]::Round($ownCpu / $wall * 100, 1)
      otherCpuPct = [math]::Round($otherCpu / $wall * 100, 1)
      ownGpuPct = [math]::Round([double]$ownGpu, 1)
      otherGpuPct = [math]::Round([double]$otherGpu, 1)
      topOtherCpu = $topCpu
      topOtherGpu = $topGpu
      gpuCounterErrors = $gpuErrors
      gpuError = $gpuError
      ownProcesses = $own.Count
    }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 $record))
    [Console]::Out.Flush()
  }
  $previousCpu = $cpu
  $previousTime = $time
  if ($null -ne $gpuNow) { $previousGpu = $gpuNow }
  $rest = $intervalMs - ((Get-Date) - $loopStart).TotalMilliseconds
  if ($rest -gt 0) { Start-Sleep -Milliseconds ([int]$rest) }
}
`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function average(values) {
  return values.length > 0 ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

/**
 * Starts sampling. markers: command-line substrings that mark our processes; ownPids: process ids
 * that are ours. Returns { samples, unavailable, errors, stop(), between(startMs, endMs), at(timeMs) }.
 */
export function startProcessLoadSampler({ markers, ownPids = [], intervalMs = DEFAULT_INTERVAL_MS }) {
  const sampler = { samples: [], unavailable: null, errors: [] };
  let child = null;
  if (process.platform !== 'win32') {
    sampler.unavailable = 'per-process load is read from Windows performance counters; not recorded on this platform';
  } else {
    const encoded = Buffer.from(powershellScript({ markers, ownPids, intervalMs }), 'utf16le').toString('base64');
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      sampler.unavailable = `PowerShell could not start: ${error.message}`;
    }
  }
  if (child) {
    let pending = '';
    child.on('error', (error) => {
      sampler.unavailable = `PowerShell is not available: ${error.message}`;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          sampler.samples.push(JSON.parse(line));
        } catch (error) {
          if (sampler.errors.length < 20) sampler.errors.push(`unreadable sample (${error.message}): ${line.slice(0, 200)}`);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      if (sampler.errors.length < 20) sampler.errors.push(text.trim().slice(0, 400));
    });
  }

  sampler.stop = () => {
    if (child && child.exitCode === null) child.kill();
  };

  /** Our and other processes' load between two times (ms since the epoch), or null without samples. */
  sampler.between = (startMs, endMs) => {
    const inside = sampler.samples.filter((sample) => sample.time > startMs && sample.from < endMs);
    if (inside.length === 0) return null;
    const otherNames = new Map();
    for (const sample of inside) {
      for (const entry of sample.topOtherCpu ?? []) otherNames.set(entry.name, (otherNames.get(entry.name) ?? 0) + entry.pct);
    }
    const topOtherCpu = [...otherNames.entries()].sort((first, second) => second[1] - first[1]).slice(0, TOP_OTHERS)
      .map(([name, total]) => ({ name, avgPct: round1(total / inside.length) }));
    return {
      otherCpuAvgPct: average(inside.map((sample) => sample.otherCpuPct)),
      otherCpuPeakPct: Math.max(...inside.map((sample) => sample.otherCpuPct)),
      ownCpuAvgPct: average(inside.map((sample) => sample.ownCpuPct)),
      otherGpuAvgPct: average(inside.map((sample) => sample.otherGpuPct)),
      otherGpuPeakPct: Math.max(...inside.map((sample) => sample.otherGpuPct)),
      ownGpuAvgPct: average(inside.map((sample) => sample.ownGpuPct)),
      topOtherCpu,
      samples: inside.length,
    };
  };

  /** The sample whose interval holds the given time (ms since the epoch), else the nearest one. */
  sampler.at = (timeMs) => {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const sample of sampler.samples) {
      if (timeMs >= sample.from && timeMs <= sample.time) return sample;
      const distance = Math.min(Math.abs(timeMs - sample.from), Math.abs(timeMs - sample.time));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = sample;
      }
    }
    return nearest && nearestDistance <= intervalMs * 2 ? nearest : null;
  };

  return sampler;
}
