# Thermalright PA120 Digital for SignalRGB

Community plugin for the four-zone Thermalright PA120 Digital USB display (`0416:8001`, PA120 Digital layout). It takes display colors from the active SignalRGB effect and shows live CPU temperature, CPU utilization, GPU temperature, and GPU utilization. The plugin and Windows telemetry bridge are both available as source.

The original implementation was verified on one PA120 Digital with SignalRGB 2.5.86, a Ryzen 5 9600X, and an NVIDIA RTX 5060 Ti. Other Thermalright displays and AMD/Intel GPU telemetry have not been validated.

## Install

1. Install Thermalright's Windows TRCC package that supplies `C:\Program Files\TRCCCAP\HWINFO.exe`. The bridge starts that installed sensor helper to read CPU temperature. It uses Windows system times for CPU utilization and the NVIDIA driver's `nvidia-smi.exe` for GPU readings. The TRCC application can stay closed.
2. Copy `Thermalright_PA120_Digital.js` into the SignalRGB custom plugins folder, usually `Documents\WhirlwindFX\Plugins`. SignalRGB can open the actual folder from **Settings → Device Information → Plugins**.
3. From the source directory, run `& .\Build.ps1` in PowerShell. The build uses the 64-bit .NET Framework compiler included with Windows and writes `build\Pa120Telemetry.exe`.
4. Exit TRCC from the system tray. Put the executable you just built in an administrator-controlled folder such as `C:\Program Files\PA120 SignalRGB Telemetry`. Run it as administrator in your Windows session, then fully restart SignalRGB. The PA120 card exposes four zones that you can place on your SignalRGB layout.

The plugin first checks the display's model reply because other Thermalright devices share the USB ID. If the log reports no model reply, try a full USB power cycle with TRCC closed. If you have independently confirmed the display is a PA120 Digital and it still sends no reply, set `allowNoHandshake` to `true` in your copy and restart SignalRGB. A reply identifying another model still prevents streaming.

## Start at sign-in

Once the manual test works, create a Windows Task Scheduler task for the bridge. Use **At log on** for your own account, **Run only when user is logged on**, and **Run with highest privileges** for the OEM sensor helper. Point the action at the executable in your administrator-controlled folder and clear the task's execution time limit. Disable TRCC's own autostart if enabled so SignalRGB can control the display. Use Task Scheduler to stop and remove the bridge task if you want to return to TRCC, and disable or remove the SignalRGB plugin before relaunching TRCC.

## Telemetry and troubleshooting

The bridge publishes newline-delimited JSON once per sample to `127.0.0.1:17842`. Each sample is an array in display order `[cpuTemperatureC, cpuUtilizationPercent, gpuTemperatureC, gpuUtilizationPercent]`. Missing readings appear as JSON `null` and display as dashes. An unrecognized CPU sensor label or unavailable NVIDIA tooling can leave one or more fields empty. See `status.txt` beside the bridge executable for which readings are available, and check the SignalRGB device log for USB and TCP diagnostics.

## License and protocol credits

GPL-3.0-only. See [LICENSE](LICENSE). The PA120 USB frame format and segment mapping were adapted into the JavaScript plugin from the GPL-3.0 [thermalright-trcc-linux protocol notes](https://github.com/Lexonight1/thermalright-trcc-linux/blob/main/doc/PROTOCOL_USBLED.md) and [LED protocol implementation](https://github.com/Lexonight1/thermalright-trcc-linux/blob/main/src/trcc/core/led_protocol.py), by Lexonight1 and contributors. Thermalright and NVIDIA software are installed separately.
