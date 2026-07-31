# Contract 2 — the host-metrics collector

## What Steward expects

Steward spawns one long-lived command and reads **NDJSON from its stdout**: one JSON object per
line, forever. It is spawned once, not per poll, so nothing here is on a timeout.

```
{"schema":"steward.hostmetrics/1","ts":1785300000000,
 "gpuUtil":0.31,"gpuTempC":41.9,"cpuUtil":0.18,"cpuTempC":41.2,
 "ramUsedGB":64.2,"ramTotalGB":128}
```

- `schema` and a numeric epoch-millisecond `ts` are **required**. A line that parses but is
  missing either is malformed and dropped — it never becomes an all-`null` reading.
- Every metric field is `number | null`. `null` (or an absent key) means "this machine cannot
  measure it" and renders as a no-reading gauge. It is **never** a zero: a real 0% and an
  unmeasurable value look different in the dashboard and must not be conflated.
- Utilisations are fractions in `0..1`, not percentages. Temperatures are °C. Memory is GB.
- On **unified** memory, omit `vramUsedGB` and `vramTotalGB` entirely and report `ramUsedGB` /
  `ramTotalGB`. On **discrete** memory, report all four.
- `memoryTopology` is **not** in the stream — it is a static property of the machine and lives in
  `steward.json`. Steward reads it from there to choose which gauges exist at all.
- Anything else on the line is ignored. Extra fields are harmless; a wrong `schema` is dropped.

Steward kills the whole process group when it shuts down, respawns the collector with backoff if
it dies, and gives up after a capped number of failures rather than looping forever.

## The three traps

**1. Buffering.** This is the single most likely failure, and it is silent — the command spawns,
stays alive, and emits nothing at all. `jq` block-buffers when its stdout is a pipe, so
`macmon pipe -s 0 | jq -c '…'` produces **zero** lines for Steward while working perfectly in a
terminal. Fix it with `jq --unbuffered`, or wrap the whole producer in `stdbuf -oL`. Python needs
`python3 -u` or an explicit `flush=True`; `awk` needs `fflush()`.

**2. Synthesised VRAM.** On unified memory there is no separate VRAM and no readable ceiling —
`iogpu.wired_limit_mb` reads `0` (meaning "unset", not "zero"), and the three `ioreg` memory keys
disagree by more than 10x about what is even in use. Any total you produce is invented. Report
`unified` and leave VRAM out.

**3. A one-shot producer.** Steward wants a stream. `macmon pipe -s 1` emits one line and exits,
which turns into a respawn per sample and trips the respawn cap. Use `-s 0`.

Also: `intervalMs` in `steward.json` must match what the collector actually does. It is the
staleness clock — a reading is stale at roughly 3x that interval — so declaring 1000 for a
collector that emits every 5s makes the dashboard flap.

## Prove it before you record it

```
node scripts/steward-setup.mjs probe-collector \
  --command-json ./collector.json --seconds 6 --topology unified --interval-ms 1000
```

It runs the real command for a bounded window, counts valid readings, measures the cadence and
the first-line latency, lists which fields ever carried a reading, fails on a silent producer,
fails on VRAM reported under unified topology, and kills the process group afterwards. Write the
command to a file as a JSON array rather than fighting your shell's quoting.

A healthy Apple Silicon collector looks like this — note the ~1.9s first-line latency, which is
warmup, not a fault:

```
[  ok  ] 4 valid reading(s) in 5s (first after 1923ms)
[  ok  ] measured cadence ~1008ms matches the declared intervalMs
[  ok  ] measured: gpuUtil, gpuTempC, cpuUtil, cpuTempC, ramUsedGB, ramTotalGB
           always null: vramUsedGB, vramTotalGB — these render as no-reading gauges, not zeros.
[  ok  ] no VRAM fields on unified memory, as required
```

## macOS, Apple Silicon — VERIFIED

Steward is collector-agnostic; `macmon` is a good default here, not a requirement. It is the only
non-`sudo` way found to read CPU **and** GPU temperature on this platform — `powermetrics`
refuses to run without superuser. If the operator does not want a third-party tool, build the
collector from `ioreg` + `sysctl` + `top` instead and accept `null` temperatures; that is an
honest, fully supported outcome.

Install (ask first): `brew install macmon`. Also needs `jq`, or write the transform in whatever
else is already there.

Verified working, measured above:

```json
["sh", "-c", "macmon pipe -s 0 -i 1000 | jq --unbuffered -c '{schema:\"steward.hostmetrics/1\",ts:(now*1000|floor),gpuUtil:.gpu_usage_ratio,gpuTempC:.temp.gpu_temp_avg,cpuUtil:.cpu_usage_ratio,cpuTempC:.temp.cpu_temp_avg,ramUsedGB:(.memory.ram_usage/1073741824),ramTotalGB:(.memory.ram_total/1073741824)}'"]
```

Record it with `"intervalMs": 1000` and `"memoryTopology": "unified"`.

Fields `macmon pipe` emits that matter here: `gpu_usage_ratio`, `cpu_usage_ratio`,
`temp.gpu_temp_avg`, `temp.cpu_temp_avg`, `memory.ram_total`, `memory.ram_usage` (bytes).
`gpu_usage` is a `[freq_mhz, ratio]` pair — `.gpu_usage[1]` is the same number as
`.gpu_usage_ratio`; prefer the named field.

Without macmon, per metric:

| Metric | Source |
| --- | --- |
| RAM total | `sysctl -n hw.memsize` (bytes) |
| RAM used | `vm_stat`, `(active + wired + compressor) x page size` |
| GPU util | `ioreg -r -d1 -w0 -c IOAccelerator -a` → `PerformanceStatistics."Device Utilization %"` |
| CPU util | `top -l 2 -n 0`, second sample, `100 - idle` |
| Temperatures | none without `sudo` — report `null` |

Pick one definition of "RAM used" and keep it. `vm_stat`, `macmon` and `top` disagree by tens of
gigabytes on the same idle machine because they count file cache differently; `top`'s number is
the most misleading. Whichever you choose, the operator should be told which it is.

## Linux — UNVERIFIED

No Linux hardware was available. Treat every command below as a starting point to test with
`probe-collector`, not as a known-good recipe.

| Metric | NVIDIA | AMD | Vendor-neutral |
| --- | --- | --- | --- |
| VRAM used/total | `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits` | `rocm-smi --showmeminfo vram --json` | — |
| GPU util | `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits` | `rocm-smi --showuse` | — |
| GPU temp | `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits` | `rocm-smi --showtemp` | `sensors -j` |
| RAM | `/proc/meminfo` | same | same |
| CPU util | `/proc/stat`, delta over an interval | same | same |
| CPU temp | `/sys/class/hwmon/*/temp*_input` or `sensors -j` | same | same |

`nvidia-smi -l 1 --query-gpu=… --format=csv,noheader,nounits` already streams on an interval,
which makes it a natural producer. `intel_gpu_top` usually needs `CAP_PERFMON` or root — if it
does, `null` the GPU fields rather than asking for a privileged collector.

A discrete GPU means `memoryTopology: "discrete"` and all four memory fields.

## Windows — UNVERIFIED

`nvidia-smi` works the same way and is the best option when the GPU is NVIDIA. Otherwise
`Get-Counter '\GPU Engine(*)\Utilization Percentage'` and `'\GPU Adapter Memory(*)\Dedicated
Usage'` for the GPU, `Get-CimInstance Win32_OperatingSystem` for RAM, `Get-Counter
'\Processor(_Total)\% Processor Time'` for CPU. Temperatures generally need administrator rights
(a LibreHardwareMonitor kernel driver, or a vendor tool) — `null` them rather than requiring
elevation for a dashboard gauge.

PowerShell buffers aggressively; if you build the producer there, flush explicitly per line and
confirm with `probe-collector` before recording anything.
