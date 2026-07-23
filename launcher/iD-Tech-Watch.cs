using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace IDTechWatch
{
    internal sealed class WatchConfig
    {
        public string server { get; set; }
        public string location { get; set; }
        public string building { get; set; }
        public string klass { get; set; }
        public string token { get; set; }
        public bool keepAwake { get; set; }
    }

    internal static class Program
    {
        private const string RuntimeFolderName = "iD-Tech-Watch";
        private const string AgentResource = "IDTechWatch.Agent";
        private const string WatchdogResource = "IDTechWatch.Watchdog";

        [STAThread]
        private static void Main(string[] args)
        {
            if (Environment.GetEnvironmentVariable("IDT_WATCH_SILENT") != "1" &&
                !IsAdministrator())
            {
                RelaunchElevated(args);
                return;
            }

            string runtime = Environment.GetEnvironmentVariable("IDT_WATCH_RUNTIME");
            if (String.IsNullOrWhiteSpace(runtime))
            {
                runtime = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    RuntimeFolderName
                );
            }
            runtime = Path.GetFullPath(runtime);

            if (HasFlag(args, "--shutdown"))
            {
                StopMonitoring(runtime);
                return;
            }

            try
            {
                Directory.CreateDirectory(runtime);
                ExtractResource(AgentResource, Path.Combine(runtime, "agent.js"));
                ExtractResource(WatchdogResource, Path.Combine(runtime, "agent-watchdog.ps1"));

                bool reconfigure = HasFlag(args, "--configure");
                WatchConfig commandLineConfig = ConfigFromArgs(args);
                WatchConfig config = reconfigure ? PromptForConfig() : commandLineConfig;
                if (reconfigure && config == null)
                    return;
                string configPath = Path.Combine(runtime, "config.json");
                if (config == null && File.Exists(configPath))
                    config = ReadConfig(configPath);
                if (config == null)
                    config = PromptForConfig();
                if (config == null)
                    return;

                ValidateConfig(config);
                File.WriteAllText(
                    configPath,
                    new JavaScriptSerializer().Serialize(config),
                    new UTF8Encoding(false)
                );
                string stopFlag = Path.Combine(runtime, "shutdown.flag");

                int existingPid;
                bool alreadyRunning =
                    TryReadPid(Path.Combine(runtime, "watchdog.pid"), out existingPid) &&
                    ProcessIsRunning(existingPid, "powershell");
                if (alreadyRunning && (reconfigure || commandLineConfig != null))
                {
                    File.WriteAllText(stopFlag, DateTime.UtcNow.ToString("o"));
                    StopPidFile(Path.Combine(runtime, "agent.pid"), "node");
                    StopPidFile(Path.Combine(runtime, "watchdog.pid"), "powershell");
                    Thread.Sleep(300);
                    alreadyRunning = false;
                }
                if (File.Exists(stopFlag))
                    File.Delete(stopFlag);

                if (alreadyRunning)
                {
                    Notify(
                        "iD-Tech-Watch is already monitoring this computer.",
                        "iD-Tech-Watch",
                        MessageBoxIcon.Information
                    );
                    return;
                }

                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = "powershell.exe";
                start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
                    Quote(Path.Combine(runtime, "agent-watchdog.ps1")) +
                    " -RuntimeDir " + Quote(runtime);
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(start);
            }
            catch (Exception error)
            {
                Notify(
                    error.Message,
                    "iD-Tech-Watch could not start",
                    MessageBoxIcon.Error
                );
                Environment.ExitCode = 1;
            }
        }

        private static WatchConfig ConfigFromArgs(string[] args)
        {
            string server = ValueAfter(args, "--server");
            if (String.IsNullOrWhiteSpace(server))
                return null;
            return new WatchConfig
            {
                server = server,
                location = ValueAfter(args, "--location") ?? "Stanford",
                building = ValueAfter(args, "--building") ?? "Main Building",
                klass = ValueAfter(args, "--class") ?? "",
                token = ValueAfter(args, "--token") ?? "",
                keepAwake = HasFlag(args, "--keep-awake")
            };
        }

        private static bool IsAdministrator()
        {
            WindowsIdentity identity = WindowsIdentity.GetCurrent();
            WindowsPrincipal principal = new WindowsPrincipal(identity);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }

        private static void RelaunchElevated(string[] args)
        {
            try
            {
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = Assembly.GetExecutingAssembly().Location;
                start.Arguments = String.Join(" ", Array.ConvertAll(args, Quote));
                start.UseShellExecute = true;
                start.Verb = "runas";
                Process.Start(start);
            }
            catch (Exception error)
            {
                Notify(
                    "Administrator approval is required so the client can enforce classroom controls.\n\n" +
                    error.Message,
                    "iD-Tech-Watch needs permission",
                    MessageBoxIcon.Error
                );
                Environment.ExitCode = 1;
            }
        }

        private static WatchConfig PromptForConfig()
        {
            Application.EnableVisualStyles();
            Form form = new Form();
            form.Text = "Set up iD-Tech-Watch";
            form.ClientSize = new Size(460, 330);
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;

            TextBox server = AddField(form, "Hub WebSocket URL", "ws://127.0.0.1:8765", 20);
            TextBox location = AddField(form, "Location", "Stanford", 80);
            TextBox building = AddField(form, "Building", "Main Building", 140);
            TextBox klass = AddField(form, "Class (optional)", "", 200);
            TextBox token = AddField(form, "Enrollment token (optional)", "", 260);
            token.UseSystemPasswordChar = true;

            Button start = new Button();
            start.Text = "Start monitoring";
            start.Location = new Point(300, 295);
            start.Size = new Size(140, 27);
            start.DialogResult = DialogResult.OK;
            form.Controls.Add(start);
            form.AcceptButton = start;

            if (form.ShowDialog() != DialogResult.OK)
                return null;
            return new WatchConfig
            {
                server = server.Text.Trim(),
                location = location.Text.Trim(),
                building = building.Text.Trim(),
                klass = klass.Text.Trim(),
                token = token.Text,
                keepAwake = true
            };
        }

        private static TextBox AddField(Form form, string label, string value, int top)
        {
            Label caption = new Label();
            caption.Text = label;
            caption.Location = new Point(20, top);
            caption.AutoSize = true;
            form.Controls.Add(caption);
            TextBox input = new TextBox();
            input.Text = value;
            input.Location = new Point(20, top + 21);
            input.Size = new Size(420, 23);
            form.Controls.Add(input);
            return input;
        }

        private static void ValidateConfig(WatchConfig config)
        {
            Uri server;
            if (!Uri.TryCreate(config.server, UriKind.Absolute, out server) ||
                (server.Scheme != "ws" && server.Scheme != "wss"))
                throw new InvalidOperationException("The hub URL must be an absolute ws:// or wss:// URL.");
            if (String.IsNullOrWhiteSpace(config.location) || String.IsNullOrWhiteSpace(config.building))
                throw new InvalidOperationException("Location and building are required.");
            if (config.location.Length > 200 || config.building.Length > 200 ||
                (config.klass ?? "").Length > 200 || (config.token ?? "").Length > 500)
                throw new InvalidOperationException("A setup value is too long.");
        }

        private static WatchConfig ReadConfig(string path)
        {
            WatchConfig config = new JavaScriptSerializer().Deserialize<WatchConfig>(
                File.ReadAllText(path, Encoding.UTF8)
            );
            ValidateConfig(config);
            return config;
        }

        private static void StopMonitoring(string runtime)
        {
            try
            {
                Directory.CreateDirectory(runtime);
                File.WriteAllText(Path.Combine(runtime, "shutdown.flag"), DateTime.UtcNow.ToString("o"));
                StopPidFile(Path.Combine(runtime, "agent.pid"), "node");
                StopPidFile(Path.Combine(runtime, "watchdog.pid"), "powershell");
                Notify(
                    "iD-Tech-Watch monitoring has stopped and will not restart until the launcher is run again.",
                    "iD-Tech-Watch",
                    MessageBoxIcon.Information
                );
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "iD-Tech-Watch shutdown failed");
                Environment.ExitCode = 1;
            }
        }

        private static void StopPidFile(string path, string expectedName)
        {
            int pid;
            if (!TryReadPid(path, out pid))
                return;
            try
            {
                Process process = Process.GetProcessById(pid);
                if (process.ProcessName.IndexOf(expectedName, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    process.Kill();
                    process.WaitForExit(5000);
                }
            }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
        }

        private static bool ProcessIsRunning(int pid, string expectedName)
        {
            try
            {
                Process process = Process.GetProcessById(pid);
                return !process.HasExited &&
                    process.ProcessName.IndexOf(expectedName, StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { return false; }
        }

        private static bool TryReadPid(string path, out int pid)
        {
            pid = 0;
            return File.Exists(path) && Int32.TryParse(File.ReadAllText(path).Trim(), out pid) && pid > 0;
        }

        private static void ExtractResource(string resource, string destination)
        {
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            {
                if (input == null)
                    throw new InvalidOperationException("The launcher payload is incomplete.");
                using (FileStream output = File.Create(destination))
                    input.CopyTo(output);
            }
        }

        private static bool HasFlag(string[] args, string flag)
        {
            foreach (string arg in args)
                if (String.Equals(arg, flag, StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;
        }

        private static string ValueAfter(string[] args, string key)
        {
            for (int i = 0; i + 1 < args.Length; i++)
                if (String.Equals(args[i], key, StringComparison.OrdinalIgnoreCase))
                    return args[i + 1];
            return null;
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void Notify(string message, string title, MessageBoxIcon icon)
        {
            if (Environment.GetEnvironmentVariable("IDT_WATCH_SILENT") == "1")
                return;
            MessageBox.Show(message, title, MessageBoxButtons.OK, icon);
        }
    }
}
