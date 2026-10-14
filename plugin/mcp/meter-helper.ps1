# Audio level helper for the TTS watchdog (ASCII-only). Every 300 ms prints one line:
#   TICK <pid>:<peak>:<process> <pid>:<peak>:<process> ...
# = current output peak (0..1) of every ACTIVE audio session on the default playback
# device. server.js reads it to see whether the speech engine really produces sound.
$cs = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int s, out IntPtr c); int GetDefaultAudioEndpoint(int f, int r, out IMMDevice d); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int a(IntPtr x, int y, out IntPtr z); int b(IntPtr x, int y, out IntPtr z); int GetSessionEnumerator(out IAudioSessionEnumerator e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int n); int GetSession(int i, out IAudioSessionControl2 s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int state); int GetDisplayName(out IntPtr n); int s1(IntPtr a, ref Guid g); int GetIconPath(out IntPtr p); int s2(IntPtr a, ref Guid g);
  int GetGroupingParam(out Guid g); int s3(ref Guid g, ref Guid c); int r1(IntPtr p); int r2(IntPtr p);
  int GetSessionIdentifier(out IntPtr p); int GetSessionInstanceIdentifier(out IntPtr p); int GetProcessId(out int pid);
}
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation { int GetPeakValue(out float p); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
public static class TtsMeter {
  public static string Tick() {
    var sb = new StringBuilder("TICK");
    try {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
      IMMDevice d; if (en.GetDefaultAudioEndpoint(0, 1, out d) != 0) return "TICK nodevice";
      Guid g = typeof(IAudioSessionManager2).GUID; object o; d.Activate(ref g, 1, IntPtr.Zero, out o);
      var sm = (IAudioSessionManager2)o; IAudioSessionEnumerator se; sm.GetSessionEnumerator(out se);
      int n; se.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 s; se.GetSession(i, out s); int st; s.GetState(out st); if (st != 1) continue;
        int pid; s.GetProcessId(out pid); float pk = 0;
        try { ((IAudioMeterInformation)s).GetPeakValue(out pk); } catch {}
        string pn = "?"; try { pn = System.Diagnostics.Process.GetProcessById(pid).ProcessName.Replace(":", "").Replace(" ", "_"); } catch {}
        sb.Append(" " + pid + ":" + pk.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture) + ":" + pn);
      }
    } catch (Exception e) { return "TICK error " + e.GetType().Name; }
    return sb.ToString();
  }
}
"@
Add-Type -TypeDefinition $cs -Language CSharp
while ($true) {
  [Console]::Out.WriteLine([TtsMeter]::Tick())
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 300
}
