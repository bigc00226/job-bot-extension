// Job Finder Helper: a small Windows program that Job Finder talks to through Chrome's native
// messaging (host "com.jobfinder.helper"; installed by install.cmd). It does what a browser
// extension can't:
//   toast — a notification in the top-right corner of the screen, above every window, that never
//           takes the keyboard focus; it closes after 5 seconds. Clicking it answers
//           { type: "toast-click", account }.
//   pin   — puts the always-on-top mini window (Chrome's picture-in-picture window) on every virtual
//           desktop, so it stays in view when switching desktops (Ctrl+Win+←/→, or a desktop switcher).
//   ping  — answers { type: "pong", version }.
// Messages are JSON, each preceded by its length (4 bytes, little-endian), on stdin / stdout.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Program {
  public const string Version = "1.2.1";
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
  static readonly object WriteLock = new object();
  static Control ui;

  [STAThread]
  static void Main() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    Application.EnableVisualStyles();
    ui = new Control();
    ui.CreateControl();
    var reader = new Thread(ReadLoop) { IsBackground = true };
    reader.Start();
    Application.Run();
  }

  static void ReadLoop() {
    var stdin = Console.OpenStandardInput();
    var lengthBytes = new byte[4];
    while (true) {
      if (!ReadExactly(stdin, lengthBytes, 4)) break;
      int length = BitConverter.ToInt32(lengthBytes, 0);
      if (length <= 0 || length > 64 * 1024 * 1024) break;
      var body = new byte[length];
      if (!ReadExactly(stdin, body, length)) break;
      Dictionary<string, object> message;
      try { message = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body)); } catch { continue; }
      ui.BeginInvoke((Action)(() => Handle(message)));
    }
    // Chrome closed the connection (Job Finder's page was closed): quit.
    ui.BeginInvoke((Action)(() => Application.Exit()));
  }

  static bool ReadExactly(Stream stream, byte[] buffer, int count) {
    int read = 0;
    while (read < count) {
      int n = stream.Read(buffer, read, count - read);
      if (n <= 0) return false;
      read += n;
    }
    return true;
  }

  public static void Send(object message) {
    var bytes = Encoding.UTF8.GetBytes(Json.Serialize(message));
    lock (WriteLock) {
      var stdout = Console.OpenStandardOutput();
      stdout.Write(BitConverter.GetBytes(bytes.Length), 0, 4);
      stdout.Write(bytes, 0, bytes.Length);
      stdout.Flush();
    }
  }

  static void Handle(Dictionary<string, object> message) {
    string type = Str(message, "type");
    try {
      if (type == "ping") Send(new Dictionary<string, object> { { "type", "pong" }, { "version", Version } });
      else if (type == "toast") Toast.Show(message);
      else if (type == "pin") Pinner.Pin(message);
      else if (type == "unpin") Pinner.Unpin();
    } catch (Exception err) {
      Send(new Dictionary<string, object> { { "type", "error" }, { "for", type }, { "message", err.Message } });
    }
  }

  public static string Str(IDictionary d, string key) { return d != null && d.Contains(key) && d[key] != null ? Convert.ToString(d[key]) : ""; }
  public static double Num(IDictionary d, string key, double fallback) {
    try { return d != null && d.Contains(key) && d[key] != null ? Convert.ToDouble(d[key]) : fallback; } catch { return fallback; }
  }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
}

// ---------- the notification ----------

// A sticky toast (sticky: true — the Accounts alerts) stays until it's clicked, in the bottom-right
// corner (so it never covers the new-jobs toast); a new sticky one replaces it. theme: "green" draws it
// on green. badge replaces the "+n NEW" pill's text.
class Toast : Form {
  const int ShowMs = 5000;
  static Toast current, currentSticky;
  static readonly Color Green = Color.FromArgb(0x1F, 0x88, 0x3D), GreenDark = Color.FromArgb(0x14, 0x5C, 0x29);

  static readonly Dictionary<string, Color> SiteColors = new Dictionary<string, Color> {
    { "coconala", Color.FromArgb(0xE0, 0x86, 0x00) }, { "lancers", Color.FromArgb(0x0D, 0x72, 0xC8) },
    { "crowdworks", Color.FromArgb(0x18, 0x96, 0x5A) }, { "workana", Color.FromArgb(0x6B, 0x55, 0xD1) }
  };
  static readonly Dictionary<string, string> SiteLetters = new Dictionary<string, string> {
    { "coconala", "C" }, { "lancers", "L" }, { "crowdworks", "CW" }, { "workana", "W" }
  };
  static readonly Color Accent = Color.FromArgb(0x3C, 0xB0, 0x43);

  class Group { public string Site, Title; public List<string[]> Items = new List<string[]>(); public int More; }

  readonly List<Group> groups = new List<Group>();
  readonly string account, heading, badgeText;
  readonly bool sticky, green;
  readonly int total;
  readonly float s;
  readonly Stopwatch clock = Stopwatch.StartNew();
  readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 15 };
  bool hovered;
  long hoverMs, hoverStart;
  int finalTop;

  public static void Show(IDictionary message) {
    var toast = new Toast(message);
    if (toast.sticky) {
      if (currentSticky != null && !currentSticky.IsDisposed) currentSticky.Close();
      currentSticky = toast;
    } else {
      if (current != null && !current.IsDisposed) current.Close();
      current = toast;
    }
    toast.Present();
  }

  Toast(IDictionary message) {
    account = Program.Str(message, "account");
    heading = Program.Str(message, "heading");
    badgeText = Program.Str(message, "badge");
    sticky = message.Contains("sticky") && message["sticky"] is bool && (bool)message["sticky"];
    green = Program.Str(message, "theme") == "green";
    total = (int)Program.Num(message, "total", 0);
    var list = message.Contains("groups") ? message["groups"] as ArrayList : null;
    foreach (var raw in list ?? new ArrayList()) {
      var g = raw as IDictionary;
      if (g == null) continue;
      var group = new Group { Site = Program.Str(g, "site"), Title = Program.Str(g, "title") };
      var items = g.Contains("items") ? g["items"] as ArrayList : null;
      int count = 0;
      foreach (var rawItem in items ?? new ArrayList()) {
        var item = rawItem as IDictionary;
        if (item == null) continue;
        if (++count > 4) { group.More++; continue; }
        group.Items.Add(new[] { Program.Str(item, "title"), Program.Str(item, "category") });
      }
      groups.Add(group);
    }

    using (var g = CreateGraphics()) s = g.DpiX / 96f;
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    DoubleBuffered = true;
    BackColor = green ? Green : Color.White;
    Cursor = Cursors.Hand;
    int height = 46;
    foreach (var group in groups) height += 34 + group.Items.Count * 21 + (group.More > 0 ? 19 : 0) + 10;
    height += 6;
    var area = Screen.PrimaryScreen.WorkingArea;
    Size = new Size(Px(400), Math.Min(Px(height), area.Height - Px(24)));
    // (Sticky: bottom-right, sliding up; otherwise top-right, sliding down.)
    finalTop = sticky ? area.Bottom - Height - Px(12) : area.Top + Px(12);
    Location = new Point(area.Right - Width - Px(12), finalTop + (sticky ? Px(16) : -Px(16)));
    Opacity = 0;

    MouseEnter += (a, b) => { hovered = true; hoverStart = clock.ElapsedMilliseconds; };
    MouseLeave += (a, b) => { if (!ClientRectangle.Contains(PointToClient(MousePosition))) { hovered = false; hoverMs += clock.ElapsedMilliseconds - hoverStart; } };
    MouseClick += (a, b) => {
      if (CloseBox.Contains(b.Location)) {
        Program.Send(new Dictionary<string, object> { { "type", "toast-closed" }, { "account", account }, { "sticky", sticky } });
        Close();
        return;
      }
      Program.Send(new Dictionary<string, object> { { "type", "toast-click" }, { "account", account }, { "sticky", sticky } });
      Close();
    };
    timer.Tick += (a, b) => Step();
  }

  int Px(float v) { return (int)Math.Round(v * s); }
  Rectangle CloseBox { get { return new Rectangle(Width - Px(34), Px(9), Px(26), Px(26)); } }

  // Shown without taking the focus, above every window (including other always-on-top ones).
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      cp.ExStyle |= 0x08 | 0x80 | 0x08000000; // WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
      cp.ClassStyle |= 0x00020000;            // CS_DROPSHADOW
      return cp;
    }
  }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    int round = 2; // Windows 11: rounded corners
    try { DwmSetWindowAttribute(Handle, 33, ref round, 4); } catch { }
  }

  void Present() {
    Show();
    SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040); // HWND_TOPMOST, no move/size/activate, show
    timer.Start();
  }

  long Elapsed { get { return clock.ElapsedMilliseconds - hoverMs - (hovered ? clock.ElapsedMilliseconds - hoverStart : 0); } }

  void Step() {
    long t = clock.ElapsedMilliseconds;
    // Slides down and fades in (0.22 s); fades out over the last 0.3 s. Paused while the pointer is on it.
    double appear = Math.Min(1, t / 220.0);
    double ease = 1 - Math.Pow(1 - appear, 3);
    int top = finalTop + (sticky ? 1 : -1) * (int)Math.Round(Px(16) * (1 - ease));
    if (Top != top) Top = top;
    // A sticky toast has no time limit: it stays until it's clicked.
    long left = sticky ? long.MaxValue : ShowMs - Elapsed;
    double opacity = Math.Max(0, Math.Min(ease, left < 300 ? left / 300.0 : 1));
    if (Math.Abs(Opacity - opacity) > 0.004) Opacity = opacity;
    if (left <= 0) { Close(); return; }
    // Once a sticky toast has slid in, nothing changes until it's clicked: the timer stops, so it
    // doesn't keep repainting or re-raising itself next to the taskbar (which made the taskbar stall).
    if (sticky && appear >= 1) { timer.Stop(); return; }
    // Keep it above windows that went topmost after it — only when it was actually pushed down.
    if (t - lastRaiseCheck >= 1000) {
      lastRaiseCheck = t;
      if (!IsTopOfTopmost()) SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }
    // Smooth while sliding in or fading out; the time-left bar alone needs far fewer frames.
    timer.Interval = appear < 1 || left < 300 ? 15 : 50;
    Invalidate(BarArea);
  }
  long lastRaiseCheck;
  Rectangle BarArea { get { return new Rectangle(0, Height - Px(5), Width, Px(5)); } }

  // Whether no other visible topmost window sits above this one (the taskbar doesn't count: the toast
  // never overlaps it, and fighting it for the top would stall it).
  bool IsTopOfTopmost() {
    for (IntPtr w = GetWindow(Handle, 3 /* GW_HWNDPREV */); w != IntPtr.Zero; w = GetWindow(w, 3)) {
      if (!IsWindowVisible(w) || (GetWindowLongPtr(w, -20).ToInt64() & 0x08) == 0) continue;
      var cls = new StringBuilder(64);
      GetClassName(w, cls, cls.Capacity);
      string name = cls.ToString();
      if (name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd") continue;
      RECT r, mine;
      GetWindowRect(w, out r);
      GetWindowRect(Handle, out mine);
      if (r.Left < mine.Right && mine.Left < r.Right && r.Top < mine.Bottom && mine.Top < r.Bottom) return false;
    }
    return true;
  }

  protected override void OnFormClosed(FormClosedEventArgs e) { timer.Stop(); base.OnFormClosed(e); }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    // A time-left update repaints only the bar.
    if (!sticky && BarArea.Contains(e.ClipRectangle)) { PaintBar(g); return; }
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    string face = "Yu Gothic UI";
    using (var headFont = new Font(face, 10.5f, FontStyle.Bold))
    using (var titleFont = new Font(face, 9.5f, FontStyle.Bold))
    using (var itemFont = new Font(face, 9f))
    using (var smallFont = new Font(face, 8f, FontStyle.Bold))
    using (var dark = new SolidBrush(green ? GreenDark : Color.FromArgb(0x16, 0x1B, 0x22)))
    using (var text = new SolidBrush(Color.FromArgb(0x1F, 0x23, 0x28)))
    using (var muted = new SolidBrush(Color.FromArgb(0x65, 0x6D, 0x76)))
    using (var white = new SolidBrush(Color.White)) {
      // Header: dark band (dark green on a green toast) with the name, the count and ×.
      g.FillRectangle(dark, 0, 0, Width, Px(44));
      using (var dot = new SolidBrush(green ? Color.White : Accent)) g.FillEllipse(dot, Px(14), Px(16), Px(12), Px(12));
      g.DrawString(heading.Length > 0 ? heading : "Job Finder", headFont, white, Px(34), Px(12));
      string count = badgeText.Length > 0 ? badgeText : total > 0 ? "+" + total + " NEW" : "NEW";
      var countSize = g.MeasureString(count, smallFont);
      var pill = new RectangleF(Width - Px(46) - countSize.Width - Px(16), Px(12), countSize.Width + Px(16), Px(21));
      using (var path = Rounded(pill, pill.Height / 2)) using (var b = new SolidBrush(Accent)) g.FillPath(b, path);
      g.DrawString(count, smallFont, white, pill.X + Px(8), pill.Y + (pill.Height - countSize.Height) / 2);
      using (var pen = new Pen(Color.FromArgb(0x9A, 0xA4, 0xAE), 1.6f * s)) {
        var c = CloseBox; int m = Px(8);
        g.DrawLine(pen, c.Left + m, c.Top + m, c.Right - m, c.Bottom - m);
        g.DrawLine(pen, c.Right - m, c.Top + m, c.Left + m, c.Bottom - m);
      }

      float y = Px(52);
      var noWrap = new StringFormat(StringFormatFlags.NoWrap) { Trimming = StringTrimming.EllipsisCharacter };
      foreach (var group in groups) {
        Color color = SiteColors.ContainsKey(group.Site) ? SiteColors[group.Site] : Accent;
        float h = Px(34 + group.Items.Count * 21 + (group.More > 0 ? 19 : 0));
        // (On green, each group is a white card, so its text stays easy to read.)
        if (green) using (var card = new SolidBrush(Color.White)) using (var path = Rounded(new RectangleF(Px(10), y, Width - Px(20), h), Px(8))) g.FillPath(card, path);
        using (var tint = new SolidBrush(Color.FromArgb(18, color))) using (var path = Rounded(new RectangleF(Px(10), y, Width - Px(20), h), Px(8))) g.FillPath(tint, path);
        using (var bar = new SolidBrush(color)) using (var path = Rounded(new RectangleF(Px(10), y, Px(5), h), Px(2.5f))) g.FillPath(bar, path);
        // Platform badge.
        var badge = new RectangleF(Px(24), y + Px(7), Px(24), Px(24));
        using (var b = new SolidBrush(color)) g.FillEllipse(b, badge);
        string letter = SiteLetters.ContainsKey(group.Site) ? SiteLetters[group.Site] : "•";
        using (var f = new Font(face, letter.Length > 1 ? 7f : 9f, FontStyle.Bold)) {
          var size = g.MeasureString(letter, f);
          g.DrawString(letter, f, white, badge.X + (badge.Width - size.Width) / 2, badge.Y + (badge.Height - size.Height) / 2);
        }
        using (var b = new SolidBrush(color)) g.DrawString(group.Title, titleFont, b, new RectangleF(Px(56), y + Px(8), Width - Px(76), Px(22)), noWrap);
        float iy = y + Px(32);
        foreach (var item in group.Items) {
          float x = Px(56), right = Width - Px(22);
          if (item[1].Length > 0) {
            var catSize = g.MeasureString(item[1], smallFont);
            float catWidth = Math.Min(catSize.Width, Px(110));
            using (var b = new SolidBrush(color)) g.DrawString(item[1], smallFont, b, new RectangleF(right - catWidth, iy + Px(2), catWidth, Px(18)), noWrap);
            right -= catWidth + Px(6);
          }
          g.DrawString("• " + item[0], itemFont, text, new RectangleF(x, iy, right - x, Px(20)), noWrap);
          iy += Px(21);
        }
        if (group.More > 0) g.DrawString("+" + group.More + " more", smallFont, muted, Px(56), iy);
        y += h + Px(10);
      }

      // Time left (a sticky toast has none).
      if (!sticky) PaintBar(g);
    }
  }

  void PaintBar(Graphics g) {
    float fraction = Math.Max(0, Math.Min(1, (ShowMs - Elapsed) / (float)ShowMs));
    using (var b = new SolidBrush(BackColor)) g.FillRectangle(b, BarArea);
    using (var b = new SolidBrush(Color.FromArgb(0xEA, 0xEE, 0xF2))) g.FillRectangle(b, 0, Height - Px(4), Width, Px(4));
    using (var b = new SolidBrush(Accent)) g.FillRectangle(b, 0, Height - Px(4), Width * fraction, Px(4));
  }

  static GraphicsPath Rounded(RectangleF r, float radius) {
    var path = new GraphicsPath();
    float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
    path.AddArc(r.X, r.Y, d, d, 180, 90);
    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
  }

  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}

// ---------- the mini window on every virtual desktop ----------

static class Pinner {
  // Finds Chrome's / Edge's always-on-top picture-in-picture window (the size Job Finder asked for),
  // pins it to all virtual desktops, and keeps it topmost. Tries for a few seconds while it opens.
  // While pinned, the window is checked every second: pinned again if Chrome re-creates it, and kept
  // topmost. "unpin" (or Job Finder closing the connection) stops it.
  static System.Windows.Forms.Timer watch;
  static IntPtr current = IntPtr.Zero;

  public static void Unpin() {
    if (watch != null) { watch.Stop(); watch.Dispose(); watch = null; }
    current = IntPtr.Zero;
  }

  public static void Pin(IDictionary message) {
    double width = Program.Num(message, "width", 0), height = Program.Num(message, "height", 0), scale = Program.Num(message, "scale", 1);
    string title = Program.Str(message, "title");
    // (A given window handle is pinned as is; used for testing.)
    double handle = Program.Num(message, "hwnd", 0);
    if (handle > 0) {
      string reason = PinToAllDesktops(new IntPtr((long)handle));
      Program.Send(new Dictionary<string, object> { { "type", "pinned" }, { "ok", reason.Length == 0 }, { "reason", reason } });
      return;
    }
    Unpin();
    var started = Environment.TickCount;
    bool reported = false;
    string error = "";
    watch = new System.Windows.Forms.Timer { Interval = 250 };
    watch.Tick += (a, b) => {
      if (current == IntPtr.Zero || !IsWindow(current)) {
        current = FindPipWindow(title, width * scale, height * scale);
        if (current != IntPtr.Zero) {
          error = PinToAllDesktops(current);
          if (error.Length > 0) current = IntPtr.Zero;
        } else if (error.Length == 0) error = "The always-on-top window wasn't found";
      } else if ((GetWindowLongPtr(current, -20).ToInt64() & 0x08) == 0) {
        // Raised again only if it lost always-on-top; re-raising it every second made the taskbar stall.
        SetWindowPos(current, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
      }
      bool ok = current != IntPtr.Zero;
      if (!reported && (ok || Environment.TickCount - started > 5000)) {
        reported = true;
        watch.Interval = 1000;
        Program.Send(new Dictionary<string, object> { { "type", "pinned" }, { "ok", ok }, { "reason", ok ? "" : error } });
      }
    };
    watch.Start();
  }

  // Chrome's picture-in-picture window is topmost and carries the title of the page that opened it
  // (Job Finder's). Chrome doesn't keep to the size asked for, so the size only breaks ties.
  static IntPtr FindPipWindow(string title, double width, double height) {
    var candidates = new List<KeyValuePair<double, IntPtr>>();
    EnumWindows((hwnd, l) => {
      if (!IsWindowVisible(hwnd)) return true;
      var cls = new StringBuilder(64);
      GetClassName(hwnd, cls, cls.Capacity);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      long ex = GetWindowLongPtr(hwnd, -20).ToInt64();
      if ((ex & 0x08) == 0) return true; // picture-in-picture windows are topmost; browser windows aren't
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      string name = "";
      try { name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { }
      if (name != "chrome" && name != "msedge" && name != "brave") return true;
      RECT r;
      GetWindowRect(hwnd, out r);
      double w = r.Right - r.Left, h = r.Bottom - r.Top;
      if (w < 40 || h < 30) return true;
      var text = new StringBuilder(512);
      GetWindowText(hwnd, text, text.Capacity);
      string name2 = text.ToString().Trim();
      // Exact title first, then a title naming Job Finder, then any (nearest in size).
      double score = title.Length > 0 && name2 == title.Trim() ? 0
        : name2.IndexOf("Job Finder", StringComparison.OrdinalIgnoreCase) >= 0 ? 1e6 : 2e6;
      if (width > 0) score += Math.Abs(w - width) + Math.Abs(h - height);
      candidates.Add(new KeyValuePair<double, IntPtr>(score, hwnd));
      return true;
    }, IntPtr.Zero);
    candidates.Sort((a, b) => a.Key.CompareTo(b.Key));
    // An untitled match is only trusted when it's the only always-on-top browser window.
    if (candidates.Count == 0 || (candidates[0].Key >= 2e6 && candidates.Count > 1)) return IntPtr.Zero;
    return candidates[0].Value;
  }

  // Windows' "Show this window on all desktops" (Task View), through the shell's virtual-desktop
  // services. Returns "" on success, else why not.
  static string PinToAllDesktops(IntPtr hwnd) {
    SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    try {
      var shellType = Type.GetTypeFromCLSID(new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239"));
      var provider = (IServiceProvider10)Activator.CreateInstance(shellType);
      Guid viewsId = typeof(IApplicationViewCollection).GUID;
      var views = (IApplicationViewCollection)provider.QueryService(ref viewsId, ref viewsId);
      Guid pinnedService = new Guid("B5A399E7-1C87-46B8-88E9-FC5747B171BD"), pinnedId = typeof(IVirtualDesktopPinnedApps).GUID;
      var pinnedApps = (IVirtualDesktopPinnedApps)provider.QueryService(ref pinnedService, ref pinnedId);
      IntPtr view;
      int hr = views.GetViewForHwnd(hwnd, out view);
      if (hr != 0 || view == IntPtr.Zero) return "Windows didn't give a view for the window (0x" + hr.ToString("X8") + ")";
      try {
        bool already;
        if (pinnedApps.IsViewPinned(view, out already) == 0 && already) return "";
        hr = pinnedApps.PinView(view);
        return hr == 0 ? "" : "Pinning failed (0x" + hr.ToString("X8") + ")";
      } finally { Marshal.Release(view); }
    } catch (Exception err) {
      return "Virtual desktops unavailable: " + err.Message;
    }
  }

  [ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IServiceProvider10 {
    [return: MarshalAs(UnmanagedType.IUnknown)] object QueryService(ref Guid service, ref Guid riid);
  }

  [ComImport, Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationViewCollection {
    [PreserveSig] int GetViews(out IntPtr array);
    [PreserveSig] int GetViewsByZOrder(out IntPtr array);
    [PreserveSig] int GetViewsByAppUserModelId([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr array);
    [PreserveSig] int GetViewForHwnd(IntPtr hwnd, out IntPtr view);
  }

  [ComImport, Guid("4CE81583-1E4C-4632-A621-07A53543148F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IVirtualDesktopPinnedApps {
    [PreserveSig] int IsAppIdPinned([MarshalAs(UnmanagedType.LPWStr)] string appId, out bool pinned);
    [PreserveSig] int PinAppID([MarshalAs(UnmanagedType.LPWStr)] string appId);
    [PreserveSig] int UnpinAppID([MarshalAs(UnmanagedType.LPWStr)] string appId);
    [PreserveSig] int IsViewPinned(IntPtr view, out bool pinned);
    [PreserveSig] int PinView(IntPtr view);
    [PreserveSig] int UnpinView(IntPtr view);
  }

  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
