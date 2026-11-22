// SPDX-License-Identifier: GPL-3.0-only
//
// Reliability pass (2026-11-23): GPU readings no longer spawn a fresh
// nvidia-smi process once per second. Under gaming load process creation
// regularly exceeded the 1.5 s kill timeout, stalling the sample loop past
// the plugin's stale threshold and blanking the display ("disconnect").
// A single persistent `nvidia-smi -l` sampler now feeds a cached value,
// so the 1 Hz broadcast loop never blocks on the GPU driver.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class Pa120Telemetry
{
    private const int OemDataSize = 1024 * 1024;
    private const int Port = 17842;
    private static readonly string StatusPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "status.txt");
    private static readonly string NvidiaPath = Path.Combine(Environment.SystemDirectory, "nvidia-smi.exe");
    private static readonly string OemPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "TRCCCAP", "HWINFO.exe");
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static readonly object GpuLock = new object();
    private static double? gpuTemperature;
    private static double? gpuLoad;
    private static DateTime gpuUpdated = DateTime.MinValue;
    private static Process gpuSampler;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JobLimits limits, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Main()
    {
        var clients = new List<TcpClient>();
        var listener = new TcpListener(IPAddress.Loopback, Port);
        Process oem = null;
        IntPtr job = IntPtr.Zero;
        try
        {
            if (IsRunning("TRCC") || IsRunning("HWINFO"))
                throw new InvalidOperationException("TRCC or its previous HWINFO helper is still running.");

            using (var map = MemoryMappedFile.CreateNew("shareMemory_SysInfo", 2 * OemDataSize))
            using (var view = map.CreateViewAccessor())
            {
                // The installed Thermalright helper reads this request after the JSON area.
                var request = new byte[] { 0xda, 0xdb, 0xdc, 0xdd, 0, 1 };
                view.WriteArray(OemDataSize, request, 0, request.Length);
                listener.Start(8);
                job = CreateJobObject(IntPtr.Zero, null);
                var limits = new JobLimits { Flags = 0x2000 }; // Terminate the OEM helper when the collector exits.
                if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(JobLimits))))
                    throw new System.ComponentModel.Win32Exception();
                oem = Process.Start(NewProcessInfo(OemPath, ""));
                if (!AssignProcessToJobObject(job, oem.Handle)) throw new System.ComponentModel.Win32Exception();
                oem.OutputDataReceived += LogOemStartup;
                oem.BeginOutputReadLine();
                StartGpuSampler();
                var bytes = new byte[OemDataSize];
                long lastIdle, lastKernel, lastUser;
                GetSystemTimes(out lastIdle, out lastKernel, out lastUser);
                string status = null;
                while (!oem.HasExited)
                {
                    if (IsRunning("TRCC"))
                        throw new InvalidOperationException("TRCC started; the PA120 collector released its sensor helper.");

                    while (listener.Pending())
                    {
                        var client = listener.AcceptTcpClient();
                        if (clients.Count >= 8) { client.Close(); continue; }
                        client.SendTimeout = 250;
                        clients.Add(client);
                    }

                    double? cpuTemperature = ReadCpuTemperature(view, bytes);
                    double? cpuLoad = ReadCpuLoad(ref lastIdle, ref lastKernel, ref lastUser);
                    double? gpuTemperature, gpuLoad;
                    ReadGpu(out gpuTemperature, out gpuLoad);
                    var values = new[] { cpuTemperature, cpuLoad, gpuTemperature, gpuLoad };
                    var line = Encoding.ASCII.GetBytes(Json.Serialize(values) + "\n");
                    for (int i = clients.Count - 1; i >= 0; i--)
                    {
                        var client = clients[i];
                        try
                        {
                            if (!client.Client.Poll(0, SelectMode.SelectRead))
                            {
                                client.GetStream().Write(line, 0, line.Length);
                                continue;
                            }
                        }
                        catch (IOException) { }
                        catch (SocketException) { }
                        client.Close();
                        clients.RemoveAt(i);
                    }

                    string currentStatus = values.All(value => value.HasValue)
                        ? "All four sensors are available."
                        : "Waiting for sensors (CPU temp, CPU load, GPU temp, GPU load): " +
                            string.Join(",", values.Select(value => value.HasValue ? "available" : "missing"));
                    if (status != currentStatus) { WriteStatus(currentStatus); status = currentStatus; }
                    Thread.Sleep(1000);
                }
                throw new InvalidOperationException("Thermalright HWINFO exited with code " + oem.ExitCode);
            }
        }
        catch (Exception error)
        {
            WriteStatus(error.Message);
            return 1;
        }
        finally
        {
            foreach (var client in clients) client.Close();
            listener.Stop();
            StopGpuSampler();
            if (oem != null)
            {
                try { if (!oem.HasExited) oem.Kill(); }
                catch (InvalidOperationException) { }
                oem.Dispose();
            }
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static bool IsRunning(string name)
    {
        var processes = Process.GetProcessesByName(name);
        foreach (var process in processes) process.Dispose();
        return processes.Length != 0;
    }

    private static ProcessStartInfo NewProcessInfo(string path, string arguments)
    {
        return new ProcessStartInfo(path, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(path),
            RedirectStandardOutput = true,
        };
    }

    private static double? ReadCpuTemperature(MemoryMappedViewAccessor view, byte[] bytes)
    {
        view.ReadArray(0, bytes, 0, bytes.Length);
        int start = Array.IndexOf(bytes, (byte)'{');
        if (start < 0) return null;
        int end = Array.IndexOf(bytes, (byte)0, start);
        if (end <= start) return null;
        try
        {
            string readings = Encoding.UTF8.GetString(bytes, start, end - start);
            var tree = Json.DeserializeObject(readings);
            return FindCpuTemperature(tree);
        }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    private static double? FindCpuTemperature(object tree)
    {
        var dictionary = tree as IDictionary<string, object>;
        if (dictionary != null)
        {
            foreach (var entry in dictionary)
            {
                if (entry.Key.IndexOf("CPU (Tctl/Tdie)", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    entry.Key.IndexOf("CPU Package", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    entry.Key.IndexOf("CPU Die (average)", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    object reading = entry.Value;
                    var sensor = reading as IDictionary<string, object>;
                    if (sensor != null) sensor.TryGetValue("value", out reading);
                    double? value = ParseReading(Convert.ToString(reading, CultureInfo.InvariantCulture), 1, 125);
                    if (value.HasValue) return value;
                }
                var nested = FindCpuTemperature(entry.Value);
                if (nested.HasValue) return nested;
            }
        }
        else if (tree is object[])
        {
            foreach (var entry in (object[])tree)
            {
                var nested = FindCpuTemperature(entry);
                if (nested.HasValue) return nested;
            }
        }
        return null;
    }

    private static double? ReadCpuLoad(ref long lastIdle, ref long lastKernel, ref long lastUser)
    {
        long idle, kernel, user;
        if (!GetSystemTimes(out idle, out kernel, out user)) return null;
        long totalDelta = kernel - lastKernel + user - lastUser;
        long idleDelta = idle - lastIdle;
        lastIdle = idle;
        lastKernel = kernel;
        lastUser = user;
        return totalDelta > 0 ? (double?)Math.Max(0, Math.Min(100, 100.0 * (1.0 - (double)idleDelta / totalDelta))) : null;
    }

    // One long-lived `nvidia-smi -l` process streams GPU readings every 2 s.
    // The broadcast loop only reads the cache, so it can never stall on the
    // GPU driver when the system is under load. The sampler restarts itself
    // if the driver resets or nvidia-smi exits.
    private static void StartGpuSampler()
    {
        if (!File.Exists(NvidiaPath)) return;
        var thread = new Thread(GpuSamplerLoop) { IsBackground = true, Name = "GpuSampler" };
        thread.Start();
    }

    private static void GpuSamplerLoop()
    {
        while (true)
        {
            try
            {
                using (var process = Process.Start(NewProcessInfo(NvidiaPath,
                    "--query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader,nounits -l 2")))
                {
                    lock (GpuLock) gpuSampler = process;
                    string line;
                    while ((line = process.StandardOutput.ReadLine()) != null)
                    {
                        var fields = line.Split(',');
                        if (fields.Length != 2) continue;
                        lock (GpuLock)
                        {
                            gpuTemperature = ParseReading(fields[0], 1, 125);
                            gpuLoad = ParseReading(fields[1], 0, 100);
                            gpuUpdated = DateTime.UtcNow;
                        }
                    }
                    process.WaitForExit();
                }
            }
            catch (System.ComponentModel.Win32Exception) { }
            catch (InvalidOperationException) { }
            catch (IOException) { }
            finally
            {
                lock (GpuLock) gpuSampler = null;
            }
            Thread.Sleep(5000); // Back off before respawning the sampler.
        }
    }

    private static void StopGpuSampler()
    {
        lock (GpuLock)
        {
            try { if (gpuSampler != null && !gpuSampler.HasExited) gpuSampler.Kill(); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }
    }

    private static void ReadGpu(out double? temperature, out double? load)
    {
        lock (GpuLock)
        {
            bool fresh = (DateTime.UtcNow - gpuUpdated).TotalSeconds < 8;
            temperature = fresh ? gpuTemperature : null;
            load = fresh ? gpuLoad : null;
        }
    }

    private static double? ParseReading(string text, double minimum, double maximum)
    {
        double value;
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value) &&
            value >= minimum && value <= maximum ? (double?)value : null;
    }

    private static void WriteStatus(string message)
    {
        try { File.WriteAllText(StatusPath, DateTime.Now.ToString("s") + " " + message); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void LogOemStartup(object sender, DataReceivedEventArgs output)
    {
        if (output.Data == null || !output.Data.StartsWith("HWi", StringComparison.OrdinalIgnoreCase)) return;
        try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "oem-startup.txt"), output.Data + Environment.NewLine); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
