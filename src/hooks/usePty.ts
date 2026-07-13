import { useCallback } from "react";
import { spawnPty, killPty, reapPty, getDefaultShell } from "../lib/tauri";
import { useThemeStore } from "../stores/useThemeStore";
import { hexLuminance } from "../lib/themes";
import type { PtyOutput, CommandConfig, SessionMode } from "../lib/types";
import { toPtyColorTheme } from "../lib/ptyColorTheme";
import { useCommandStore } from "../stores/useCommandStore";
import { useTerminalStore, nextTabId } from "../stores/useTerminalStore";
import { useRepoStore } from "../stores/useRepoStore";
import { useNoticeStore } from "../stores/useNoticeStore";
import { CODING_ASSISTANTS } from "../components/sidebar/constants";
import type { Terminal } from "@xterm/xterm";
import { getErrorMessage } from "../lib/errors";

// Map ptyId -> xterm instance for writing output
const terminalInstances = new Map<number, Terminal>();

// Buffer for PTY output that arrives before terminal is registered.
// Capped per pty (see PENDING_OUTPUT_CAP) so a streaming background tab that is
// never brought into view can't grow this buffer without bound — only the most
// recent output is kept, mirroring the trimming xterm's scrollback would apply
// once the buffer is eventually flushed into the terminal.
const pendingOutput = new Map<number, string[]>();
// Running character total per pty, so trimming to the cap is O(1) amortized
// instead of re-summing the whole buffer on every write.
const pendingOutputSize = new Map<number, number>();

// Max buffered characters per unviewed pty (~2 MB). Generous enough to preserve
// a full-screen TUI redraw plus recent scrollback, bounded so idle background
// tabs (e.g. autostart dev servers) can't leak memory indefinitely.
const PENDING_OUTPUT_CAP = 2_000_000;

// Batch buffer for coalescing rapid PTY writes into single animation frames.
// Prevents screen tearing when TUI apps (Claude Code, opencode) send screen
// redraws larger than the 4KB PTY read buffer — without batching, xterm
// renders intermediate states where only the top of the screen is drawn.
const writeBatch = new Map<number, string[]>();
const writeBatchScheduled = new Set<number>();

// Debounce timers for activity detection — clears "active" after 3s of silence.
// Activity state is tracked here (not in the store) on every data event to avoid
// high-frequency store updates during AI streaming. The store is only updated
// on transitions: idle→active and active→idle.
const activityTimers = new Map<number, ReturnType<typeof setTimeout>>();
const activityActive = new Set<number>();
const ACTIVITY_TIMEOUT = 3000;
const stoppingPtys = new Set<number>();

function cleanupActivityState(ptyId: number) {
  const timer = activityTimers.get(ptyId);
  if (timer) { clearTimeout(timer); activityTimers.delete(ptyId); }
  activityActive.delete(ptyId);
}

export function registerTerminal(ptyId: number, term: Terminal) {
  terminalInstances.set(ptyId, term);
}

export function flushPendingOutput(ptyId: number) {
  const term = terminalInstances.get(ptyId);
  if (!term) return;

  // Flush any buffered output
  const buffered = pendingOutput.get(ptyId);
  if (buffered) {
    term.write(buffered.join(""));
    pendingOutput.delete(ptyId);
    pendingOutputSize.delete(ptyId);
  }
}

export function unregisterTerminal(ptyId: number) {
  terminalInstances.delete(ptyId);
  pendingOutput.delete(ptyId);
  pendingOutputSize.delete(ptyId);
  writeBatch.delete(ptyId);
  writeBatchScheduled.delete(ptyId);
}

function writeToPty(ptyId: number, data: string) {
  const term = terminalInstances.get(ptyId);
  if (term) {
    // Accumulate data and flush once per animation frame so xterm processes
    // a complete (or near-complete) screen update before the renderer paints.
    let batch = writeBatch.get(ptyId);
    if (!batch) {
      batch = [];
      writeBatch.set(ptyId, batch);
    }
    batch.push(data);

    if (!writeBatchScheduled.has(ptyId)) {
      writeBatchScheduled.add(ptyId);
      requestAnimationFrame(() => {
        writeBatchScheduled.delete(ptyId);
        const chunks = writeBatch.get(ptyId);
        if (chunks && chunks.length > 0) {
          term.write(chunks.join(""));
          chunks.length = 0;
        }
      });
    }
  } else {
    // Terminal not mounted yet — buffer the output, keeping only the most
    // recent PENDING_OUTPUT_CAP characters. Without this cap a background tab
    // running a continuously-streaming process (dev server, log tailer, an
    // autostart command the user never opens) would accumulate every byte it
    // ever emitted, since its terminal is never registered to drain the buffer.
    let buf = pendingOutput.get(ptyId);
    if (!buf) {
      buf = [];
      pendingOutput.set(ptyId, buf);
    }
    buf.push(data);
    let size = (pendingOutputSize.get(ptyId) ?? 0) + data.length;
    // Drop whole chunks from the front until under the cap. Keep at least the
    // chunk just pushed so a single oversized write is never fully discarded.
    while (size > PENDING_OUTPUT_CAP && buf.length > 1) {
      size -= buf.shift()!.length;
    }
    pendingOutputSize.set(ptyId, size);
  }
}

function resolveCommandCwd(repoPath: string, commandCwd: string | null) {
  const trimmed = commandCwd?.trim();
  if (!trimmed) return repoPath;
  const relativePath = trimmed.replace(/^\.?\//, "").replace(/^\/+/, "");
  return `${repoPath}/${relativePath}`;
}

export function usePty() {
  const activeRepoPath = useRepoStore((s) => s.activeRepoPath);
  const pushNotice = useNoticeStore((s) => s.pushNotice);
  const {
    setCommandStatus,
    setCommandPtyId,
    setCommandStatusForProject,
    setCommandPtyIdForProject,
  } = useCommandStore.getState();
  const { addTab, removeTab, findTabByCommand, setActiveTab, initActivity, setTabActive, setTabExited, removeActivity } =
    useTerminalStore.getState();

  const handlePtyMessage = useCallback(
    (
      ptyId: number,
      commandName: string | null,
      repoPath: string,
      msg: PtyOutput,
    ) => {
      if (msg.event === "data") {
        writeToPty(ptyId, msg.data);

        // Only update the store on the idle→active transition, not on every chunk.
        if (!activityActive.has(ptyId)) {
          activityActive.add(ptyId);
          setTabActive(ptyId, true);
        }

        // Reset the idle timer — after 3s of no output, mark as inactive
        const existing = activityTimers.get(ptyId);
        if (existing) clearTimeout(existing);
        activityTimers.set(ptyId, setTimeout(() => {
          activityActive.delete(ptyId);
          setTabActive(ptyId, false);
          activityTimers.delete(ptyId);
        }, ACTIVITY_TIMEOUT));
      } else if (msg.event === "exit") {
        cleanupActivityState(ptyId);
        // The process ended on its own — free the backend session so its PTY
        // file descriptor isn't held until the tab is manually closed. Harmless
        // no-op when the exit was triggered by killPty (session already gone).
        void reapPty(ptyId);
        setTabExited(ptyId, msg.data.code);
        const stoppedByUser = stoppingPtys.delete(ptyId);
        if (commandName) {
          const command = useCommandStore.getState().projectCommands[repoPath]
            ?.find((entry) => entry.name === commandName);
          const nextStatus = stoppedByUser || msg.data.code === 0 ? "stopped" : "crashed";
          if (command?.status !== "stopped" || nextStatus === "crashed") {
            setCommandStatusForProject(repoPath, commandName, nextStatus);
          }
          setCommandPtyIdForProject(repoPath, commandName, null);
        }
      }
    },
    [setCommandStatusForProject, setCommandPtyIdForProject, setTabActive, setTabExited],
  );

  const spawnSession = useCallback(
    async (
      command: string,
      commandArgs: string[] | null,
      env: Record<string, string>,
      cols: number,
      rows: number,
      commandName: string | null,
      repoPath: string,
    ) => {
      let resolvedPtyId: number | null = null;
      const bufferedMessages: PtyOutput[] = [];

      // Signal terminal background brightness to CLI tools via COLORFGBG.
      // Claude Code uses this to resolve "auto" theme when OSC 11 is unavailable.
      const theme = useThemeStore.getState().theme;
      const lum = hexLuminance(theme.appBg);
      const colorfgbg = lum > 0.3 ? "0;15" : "15;0";
      const fullEnv = { COLORFGBG: colorfgbg, ...env };

      const ptyId = await spawnPty(
        command,
        commandArgs,
        repoPath,
        fullEnv,
        cols,
        rows,
        toPtyColorTheme(theme),
        (msg) => {
          if (resolvedPtyId === null) {
            bufferedMessages.push(msg);
            return;
          }

          handlePtyMessage(resolvedPtyId, commandName, repoPath, msg);
        },
      );

      resolvedPtyId = ptyId;
      initActivity(ptyId);

      for (const msg of bufferedMessages) {
        handlePtyMessage(ptyId, commandName, repoPath, msg);
      }

      return ptyId;
    },
    [handlePtyMessage, initActivity],
  );

  const startCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number) => {
      if (!activeRepoPath) return;
      const commandName = command.name;

      const basePath = activeRepoPath;

      try {
        const ptyId = await spawnSession(
          command.command,
          null,
          command.env,
          cols,
          rows,
          commandName,
          resolveCommandCwd(basePath, command.cwd ?? null),
        );
        if (!ptyId) return;

        setCommandStatus(commandName, "running");
        setCommandPtyId(commandName, ptyId);

        const existing = findTabByCommand(commandName);
        if (existing) {
          setActiveTab(existing.id);
        } else {
          const id = nextTabId();
          addTab({
            id,
            kind: "terminal",
            label: commandName,
            ptyId,
            repoPath: activeRepoPath,
            commandName,
            assistantId: null,
            sessionMode: null,
          });
        }

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to start command "${commandName}":`, e);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t start ${commandName}`,
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [
      activeRepoPath,
      spawnSession,
      setCommandStatus,
      setCommandPtyId,
      findTabByCommand,
      setActiveTab,
      addTab,
      pushNotice,
    ],
  );

  const stopCommand = useCallback(
    async (commandName: string) => {
      const path = useCommandStore.getState().activeProjectPath;
      if (!path) return;
      const state = useTerminalStore.getState();
      const commands = useCommandStore.getState().projectCommands[path] ?? [];
      const command = commands.find((c) => c.name === commandName);
      const tab = state.getAllProjectTabs(path).find((t) => (t.kind === "terminal" || t.kind === "assistant") && t.commandName === commandName);
      if (command?.ptyId) {
        cleanupActivityState(command.ptyId);
        stoppingPtys.add(command.ptyId);
        await killPty(command.ptyId).catch(() => {
          stoppingPtys.delete(command.ptyId!);
        });
        unregisterTerminal(command.ptyId);
        removeActivity(command.ptyId);
      }
      if (tab) {
        removeTab(tab.id);
      }
      setCommandStatus(commandName, "stopped");
      setCommandPtyId(commandName, null);
    },
    [setCommandStatus, setCommandPtyId, removeTab, removeActivity],
  );

  const restartCommand = useCallback(
    async (command: CommandConfig, cols: number, rows: number) => {
      await stopCommand(command.name);
      return startCommand(command, cols, rows);
    },
    [stopCommand, startCommand],
  );

  const spawnBlankShell = useCallback(
    async (cols: number, rows: number) => {
      if (!activeRepoPath) return;

      try {
        const shell = await getDefaultShell();
        const ptyId = await spawnSession(
          `${shell} -l`,
          null,
          {},
          cols,
          rows,
          null,
          activeRepoPath,
        );
        if (!ptyId) return;

        const id = nextTabId();
        addTab({
          id,
          kind: "terminal",
          label: "Terminal",
          ptyId,
          repoPath: activeRepoPath,
          commandName: null,
          assistantId: null,
          sessionMode: null,
        });

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error("Failed to spawn shell:", e);
        }
        pushNotice({
          tone: "error",
          title: "Couldn’t open shell",
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [activeRepoPath, spawnSession, addTab, pushNotice],
  );

  const launchAssistant = useCallback(
    async (
      assistantId: string,
      cols: number,
      rows: number,
      mode: SessionMode = "standard",
      model?: string,
    ) => {
      if (!activeRepoPath) return;
      const assistant = CODING_ASSISTANTS.find((a) => a.id === assistantId);
      if (!assistant) return;

      const commandArgs: string[] = [];
      if (model) {
        commandArgs.push(assistant.modelFlag, model);
      }
      if (mode === "yolo" && assistant.yoloFlag) {
        commandArgs.push(assistant.yoloFlag);
      }

      try {
        const ptyId = await spawnSession(
          assistant.command,
          commandArgs,
          {},
          cols,
          rows,
          null,
          activeRepoPath,
        );
        if (!ptyId) return;

        const id = nextTabId();
        addTab({
          id,
          kind: "assistant",
          label: assistant.name,
          ptyId,
          repoPath: activeRepoPath,
          commandName: null,
          assistantId,
          sessionMode: mode,
        });

        return ptyId;
      } catch (e) {
        if (import.meta.env.DEV) {
          console.error(`Failed to launch ${assistant.name}:`, e);
        }
        pushNotice({
          tone: "error",
          title: `Couldn’t launch ${assistant.name}`,
          message: getErrorMessage(e),
        });
        return null;
      }
    },
    [activeRepoPath, spawnSession, addTab, pushNotice],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      const state = useTerminalStore.getState();
      const path = state.activeProjectPath;
      if (!path) return;
      const tabs = state.projectState[path]?.tabs ?? [];
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab || (tab.kind !== "terminal" && tab.kind !== "assistant")) return;

      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);

      if (tab.commandName) {
        setCommandStatus(tab.commandName, "stopped");
        setCommandPtyId(tab.commandName, null);
      }

      removeTab(tabId);
    },
    [setCommandStatus, setCommandPtyId, removeTab, removeActivity],
  );

  const killProjectPtys = useCallback(async (repoPath: string) => {
    const state = useTerminalStore.getState();
    const tabs = state.getAllProjectTabs(repoPath);

    for (const tab of tabs) {
      if (tab.kind !== "terminal" && tab.kind !== "assistant") continue;
      cleanupActivityState(tab.ptyId);
      stoppingPtys.add(tab.ptyId);
      await killPty(tab.ptyId).catch(() => {
        stoppingPtys.delete(tab.ptyId);
      });
      unregisterTerminal(tab.ptyId);
      removeActivity(tab.ptyId);
    }
  }, [removeActivity]);

  return {
    startCommand,
    stopCommand,
    restartCommand,
    spawnBlankShell,
    launchAssistant,
    closeTab,
    killProjectPtys,
  };
}
