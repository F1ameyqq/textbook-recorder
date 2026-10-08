$ErrorActionPreference = 'Stop'
try {
  $taskPayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $taskHtml = [Convert]::FromBase64String($taskPayload.htmlBase64)
  $taskText = [Convert]::FromBase64String($taskPayload.textBase64)
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
public static class RecorderClipboard {
  [DllImport("user32.dll", SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll", SetLastError=true)] static extern bool CloseClipboard();
  [DllImport("user32.dll", SetLastError=true)] static extern bool EmptyClipboard();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetClipboardData(uint format, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetClipboardData(uint format);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string className, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalLock(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr handle);
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr handle);
  static string Sha(byte[] value) { using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
  static void Put(uint format, byte[] bytes) {
    IntPtr memory = GlobalAlloc(2, new UIntPtr((uint)bytes.Length));
    if (memory == IntPtr.Zero) throw new Win32Exception();
    bool transferred = false;
    try {
      IntPtr address = GlobalLock(memory);
      if (address == IntPtr.Zero) throw new Win32Exception();
      try { Marshal.Copy(bytes, 0, address, bytes.Length); } finally { GlobalUnlock(memory); }
      if (SetClipboardData(format, memory) == IntPtr.Zero) throw new Win32Exception();
      transferred = true;
    } finally { if (!transferred) GlobalFree(memory); }
  }
  static string VerifyOwn(uint format, byte[] expected) {
    IntPtr memory = GetClipboardData(format);
    if (memory == IntPtr.Zero || GlobalSize(memory).ToUInt64() < (ulong)expected.Length) throw new Exception("Own payload missing");
    IntPtr address = GlobalLock(memory);
    if (address == IntPtr.Zero) throw new Win32Exception();
    byte[] actual = new byte[expected.Length];
    try { Marshal.Copy(address, actual, 0, actual.Length); } finally { GlobalUnlock(memory); }
    string digest = Sha(actual);
    if (digest != Sha(expected)) throw new Exception("Own payload mismatch");
    return digest;
  }
  public static string Write(byte[] html, byte[] text) {
    if (html.Length < 1 || text.Length < 2) throw new Exception("Empty payload");
    IntPtr owner = CreateWindowEx(0, "STATIC", "textbook-recorder clipboard", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (owner == IntPtr.Zero) throw new Win32Exception();
    bool opened = false;
    try {
      for (int attempt = 0; attempt < 20; attempt++) { if (OpenClipboard(owner)) { opened = true; break; } Thread.Sleep(50); }
      if (!opened) throw new Exception("Clipboard busy");
      uint htmlFormat = RegisterClipboardFormat("HTML Format");
      if (htmlFormat == 0 || !EmptyClipboard()) throw new Win32Exception();
      Put(htmlFormat, html); Put(13, text);
      string htmlHash = VerifyOwn(htmlFormat, html), textHash = VerifyOwn(13, text);
      return "{\"ok\":true,\"htmlSha256\":\"" + htmlHash + "\",\"textSha256\":\"" + textHash + "\",\"htmlBytes\":" + html.Length + ",\"textBytes\":" + text.Length + "}";
    } finally { if (opened) CloseClipboard(); DestroyWindow(owner); }
  }
}
'@
  [Console]::Out.Write([RecorderClipboard]::Write($taskHtml, $taskText))
} catch {
  [Console]::Error.Write('System clipboard write failed')
  exit 1
}
