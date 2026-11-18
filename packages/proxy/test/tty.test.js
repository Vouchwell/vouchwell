import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

// The terminal approver against a real terminal, typed at as a person would:
// a pseudo-terminal from Python's pty module on Linux and macOS, and a console
// of the child's own on Windows. The fake terminal in proxy.test.js cannot
// show this bug: a file stream reading the terminal sat in a worker thread
// after its prompt was done, took the next line typed (the next prompt's
// answer), and kept the process from exiting.

const win = process.platform === 'win32';
const runs = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 60_000 }).status === 0;
const python = win ? undefined : ['python3', 'python'].find((p) => runs(p, ['-c', 'import pty']));
const powershell = win && runs('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
const skip = win ? !powershell && 'needs Windows PowerShell' : !python && 'needs Python with the pty module';

const APPROVE = new URL('../src/approve.js', import.meta.url).href;

// Runs the child in a pseudo-terminal, answers each prompt as it appears ('' lets
// it time out), and reports whether the child exited on its own and what the
// terminal showed.
const PTY_DRIVER = `
import os, pty, sys, time, select, signal, json
node, child, result, answers, limit = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split('|'), float(sys.argv[5])
pid, master = pty.fork()
if pid == 0:
    os.execvp(node, [node, child, result])
out, sent, ended, deadline = b'', 0, False, time.time() + limit
while time.time() < deadline:
    if select.select([master], [], [], 0.1)[0]:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            chunk = b''
        if not chunk:
            ended = True
            break
        out += chunk
    if sent < len(answers) and out.count(b'Approve?') > sent:
        if answers[sent]:
            time.sleep(0.1)
            os.write(master, (answers[sent] + '\\n').encode())
        sent += 1
if not ended:
    os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
print(json.dumps({'ended': ended, 'screen': out.decode('utf-8', 'replace')}))
`;

// The same on Windows: a console of its own for the child (AllocConsole, which
// the child shares), answers typed into it as key events, prompts read off its
// screen. Settings come in the environment; the report goes to a file, since
// allocating a console can take this process's standard handles with it.
const CONSOLE_DRIVER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class ConsoleDriver {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD Size; public COORD Cursor; public ushort Attributes; public SMALL_RECT Window; public COORD MaxWindow; }
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort RepeatCount;
    [FieldOffset(10)] public ushort VirtualKeyCode;
    [FieldOffset(12)] public ushort VirtualScanCode;
    [FieldOffset(14)] public char UnicodeChar;
    [FieldOffset(16)] public uint ControlKeyState;
  }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AllocConsole();
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WriteConsoleInputW(IntPtr input, INPUT_RECORD[] records, uint count, out uint written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ReadConsoleOutputCharacterW(IntPtr output, [Out] char[] buffer, uint length, COORD at, out uint read);

  static IntPtr Open(string name) {
    // GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING
    return CreateFileW(name, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
  }

  static string Screen(IntPtr output) {
    CSBI info;
    if (!GetConsoleScreenBufferInfo(output, out info)) return "";
    uint length = (uint)(info.Size.X * (info.Cursor.Y + 1));
    char[] buffer = new char[length];
    uint read;
    ReadConsoleOutputCharacterW(output, buffer, length, new COORD(), out read);
    return new string(buffer, 0, (int)read);
  }

  static void Type(IntPtr input, string text) {
    INPUT_RECORD[] keys = new INPUT_RECORD[text.Length * 2];
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      ushort vk = c == '\\r' ? (ushort)0x0D : (ushort)char.ToUpperInvariant(c);
      for (int up = 0; up < 2; up++) {
        keys[i * 2 + up].EventType = 1; // KEY_EVENT
        keys[i * 2 + up].KeyDown = up == 0 ? 1 : 0;
        keys[i * 2 + up].RepeatCount = 1;
        keys[i * 2 + up].VirtualKeyCode = vk;
        keys[i * 2 + up].UnicodeChar = c;
      }
    }
    uint written;
    WriteConsoleInputW(input, keys, (uint)keys.Length, out written);
  }

  static int Count(string s, string what) {
    int n = 0;
    for (int i = s.IndexOf(what); i >= 0; i = s.IndexOf(what, i + what.Length)) n++;
    return n;
  }

  public static string Run(string node, string child, string result, string[] answers, int limitMs) {
    FreeConsole();
    if (!AllocConsole()) return "error\\nAllocConsole failed: " + Marshal.GetLastWin32Error();
    IntPtr input = Open("CONIN$");
    IntPtr output = Open("CONOUT$");
    ProcessStartInfo start = new ProcessStartInfo(node, "\\"" + child + "\\" \\"" + result + "\\"");
    start.UseShellExecute = false;
    Process proc = Process.Start(start);
    int sent = 0;
    bool ended = false;
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(limitMs);
    while (DateTime.UtcNow < deadline) {
      if (proc.WaitForExit(100)) { ended = true; break; }
      if (sent < answers.Length && Count(Screen(output), "Approve?") > sent) {
        if (answers[sent].Length > 0) { Thread.Sleep(100); Type(input, answers[sent] + "\\r"); }
        sent++;
      }
    }
    if (!ended) { try { proc.Kill(); } catch (Exception) { } }
    return (ended ? "ended" : "hung") + "\\n" + Screen(output);
  }
}
'@
$report = [ConsoleDriver]::Run($env:VW_NODE, $env:VW_CHILD, $env:VW_RESULT, $env:VW_ANSWERS.Split('|'), [int]$env:VW_LIMIT_MS)
[IO.File]::WriteAllText($env:VW_REPORT, $report)
`;

/**
 * @param {string[]} answers  One per prompt; '' to let it time out.
 * @param {number} timeoutMs  The approver's deadline.
 * @returns {Promise<{ ended: boolean, decisions: Array<[boolean, string]>, screen: string }>}
 */
async function approveAtTerminal(answers, timeoutMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-tty-'));
  const child = path.join(dir, 'child.mjs');
  const result = path.join(dir, 'result.json');
  fs.writeFileSync(child, `
    import fs from 'node:fs';
    import { ttyApprover } from ${JSON.stringify(APPROVE)};
    const approve = ttyApprover({ timeoutMs: ${timeoutMs} });
    const req = (t) => ({ target: t, params: {}, reason: 'needs a person', rules: ['r'], actor: { principal: 'ops' } });
    const out = [];
    for (const t of ${JSON.stringify(answers.map((_, i) => `ops.call_${i}`))}) {
      const r = await approve(req(t));
      out.push([r.approved, r.by]);
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(out));
  `);

  let ended;
  let screen;
  if (win) {
    const driver = path.join(dir, 'drive.ps1');
    const report = path.join(dir, 'report.txt');
    fs.writeFileSync(driver, CONSOLE_DRIVER);
    const env = { ...process.env, VW_NODE: process.execPath, VW_CHILD: child, VW_RESULT: result, VW_ANSWERS: answers.join('|'), VW_LIMIT_MS: '20000', VW_REPORT: report };
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], { env, encoding: 'utf8', timeout: 90_000 });
    assert.ok(fs.existsSync(report), `the console driver reported nothing:\n${run.stdout}\n${run.stderr}`);
    const [status, ...rest] = fs.readFileSync(report, 'utf8').split('\n');
    assert.notEqual(status, 'error', rest.join('\n'));
    ended = status === 'ended';
    screen = rest.join('\n');
  } else {
    const driver = path.join(dir, 'drive.py');
    fs.writeFileSync(driver, PTY_DRIVER);
    const proc = spawn(/** @type {string} */ (python), [driver, process.execPath, child, result, answers.join('|'), '20']);
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    await new Promise((resolve) => proc.on('exit', resolve));
    ({ ended, screen } = JSON.parse(stdout));
  }
  assert.ok(fs.existsSync(result), `no result; the terminal showed:\n${screen}`);
  return { ended, screen, decisions: JSON.parse(fs.readFileSync(result, 'utf8')) };
}

test('each prompt at a real terminal gets the answer typed for it, and the process exits', { skip }, async () => {
  const { ended, decisions, screen } = await approveAtTerminal(['y', 'n', 'y'], 15_000);
  assert.deepEqual(decisions, [[true, 'tty'], [false, 'tty'], [true, 'tty']]);
  assert.equal(ended, true, 'nothing is left reading the terminal');
  // Written to a Windows console as UTF-8 bytes, the box came out as ΓöîΓöÇ in
  // any code page but UTF-8's.
  assert.match(screen, /┌─ Vouchwell: approval required/);
});

test('after a prompt times out, the next one still gets its answer', { skip }, async () => {
  const { ended, decisions } = await approveAtTerminal(['', 'y'], 800);
  assert.deepEqual(decisions, [[false, 'policy:timeout'], [true, 'tty']]);
  assert.equal(ended, true);
});
