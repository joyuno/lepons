<p align="center">
  <img src="icon.png" width="128" height="128" alt="Lepons">
</p>

<h1 align="center">Lepons</h1>

<p align="center"><a href="README.md">한국어</a> · <b>English</b> · <a href="README.zh-CN.md">中文</a></p>

<p align="center"><b>A multi-PC agent orchestrator: run the AI coding agents on all your machines from one window</b></p>

<p align="center">A desktop app that shows the Claude Code and Codex sessions running on this PC and on your remote servers and VMs side by side in one window, and lets those machines read each other's codebases live.</p>

No more opening a separate terminal for every server, workstation and laptop, or copying code and files between them. Nothing is installed on the remote machines; all it takes is SSH access.

## Download

**[Get the latest version](https://github.com/joyuno/lepons/releases/latest)**

| OS | File |
|---|---|
| Windows 10/11 | `.exe` installer |
| macOS (Apple Silicon, M1 or later) | `.dmg` |

### Install

- **Windows**: run the `.exe`. If "Windows protected your PC" appears, choose **More info → Run anyway**; the app has no code-signing certificate, which is what triggers the warning. If your browser blocks the download, choose **Keep**.
- **macOS**: open the `.dmg` and drag Lepons Cockpit into Applications. The app is not notarized by Apple, so the first launch may say it "is damaged and can't be opened" or comes from an "unidentified developer". If so, run this once in Terminal and open it again:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Lepons Cockpit.app"
  ```

## Features

1. **Codebase sharing between PCs**: on the sharing map, drag a folder onto another PC and that PC's Claude Code and Codex can read and search it. No git push or pull, no copying files. The other side can only read, and values that look like keys or tokens are masked before they leave. You can also hand work to an agent on another PC and follow its progress.
2. **Split panes**: split right or down, up to four panes, each with a session or a file from any PC.
3. **Claude Code, Codex or a terminal**: click a folder and choose Claude Code, Codex or Terminal to open it there. After Lepons starts, the first session on each PC updates the CLI first; the model is the CLI's own latest default. You can continue the folder's last conversation.
4. **Work that survives a dropped connection**: remote sessions run inside tmux. Close the laptop or lose the network and the agent keeps working; reopen and you are back on the same screen.
5. **Nothing to install remotely**: no daemon, no server. Sessions and code sharing both travel over SSH. On the first connection, enter the password once and Lepons registers its SSH key for you.
6. **View and edit files in a pane**: Markdown (including Obsidian syntax), code, images, PDF and HTML open in a pane, and files on this PC or a remote one can be edited in place. The file tree has VS Code's right-click actions: copy, paste, rename, delete, copy path.
7. **The workflow at a glance**: one board shows what each Claude Code or Codex session is doing, what it gave its subagents, and what passed between PCs.
8. **Import what you already use**: brings in machines and folders from the remote folders VS Code and Cursor remember and from Claude Code and Codex session history.

## Getting started

On the first launch a short guide walks through the main buttons. To see it again, use the power button at the top left → **User guide**.

### Preparing a remote PC

- SSH access (password or key)
- tmux (recommended; without it, a dropped connection ends that session's work)
- Claude Code or Codex installed and signed in

### Adding a PC

**＋ Add PC** at the bottom left offers four choices.

| Button | What it does |
|---|---|
| **＋ Folder on this PC** | Pick a folder on this PC to register it. |
| **＋ Remote PC** | Enter `<user>@<IP address or hostname>`, e.g. `ubuntu@10.0.0.5`. |
| **Import existing work** | Finds what VS Code, Cursor, Claude Code and Codex remember and adds it at once. A good first click. |
| **Setup guide** | Shows what a remote PC needs and this PC's Lepons public key. |

If the remote PC does not have the Lepons key yet, a password field appears. Enter it once and Lepons adds its key to `~/.ssh/authorized_keys`; every later connection uses the key. The password is never stored. If the server does not allow password logins, copy the public key from **Setup guide** into the remote PC's `~/.ssh/authorized_keys`.

### Opening a folder

Click a folder in the list on the left and choose what to run.

- **Claude Code / Codex / Terminal** starts it in that folder.
- **Continue the last conversation** is ticked by default. It continues the folder's last conversation as a new session, and starts a new one where there is none.
- **Run without permission checks** is off by default. Off, Claude Code starts in auto mode and Codex in automatic review, asking only about risky actions. On, every check is skipped and Codex also runs without its sandbox. Turn it on only for folders you trust.

Hover a folder for **⚙** (new file, rename, hide from list, remove from list) and **▸** to show its files. The buttons over an open file list make a new file or folder, refresh, and collapse folders; press refresh if a file an agent or terminal created does not show.

## Sharing map

**Sharing map** at the bottom left is where PCs are allowed to read each other's code.

- **Drag a folder onto another PC's card** to share it; **click a line** to stop.
- **Arrows point the way the code goes.** `A → B` means B's Claude Code and Codex read A's folder. Sharing both ways shows as one double arrow (`⇄`). Hover a line to see who reads what, in sentences.
- Connecting a share registers Lepons MCP on that PC automatically. The **MCP for [Claude] [Codex]** switches on the receiving PC's card choose which agents get it (at first only the PC's default agent). Sessions that were already open get an **Apply lepons** button that reopens them, continuing the conversation.
- PCs that share with each other are placed side by side so the arrows stay short. A card you drag yourself stays where you put it.
- Removing a PC from the list also ends every share connected to it.

### How code is shared

- When you connect on the sharing map, Lepons opens a reverse tunnel over the SSH connection and registers Lepons MCP with that PC's Claude Code and Codex.
- The receiving agent searches with `search_repo` and opens only the files it needs with `read_file`. For each request, Lepons reads just that file, or the matching lines, on the PC that owns it.
- Nothing is copied or sent ahead of time. Only what the agent actually reads enters its context, so that is all the tokens it costs.

## Workflow

**Workflow** at the bottom left shows each PC's sessions, their subagents and the handoffs between PCs on one board.

- Each session card carries a **Claude** (amber) or **Codex** (teal) tag.
- Click a card for that session's prompts, messages and actions in order.
- Drag a PC's box wherever you like; the position is kept across launches.
- Subagent instructions are usually written in English. The **Translate** button on a card shows them in the app's language, using a little of this PC's Claude usage (Haiku model) only when pressed.

## In the terminal

| To | Do |
|---|---|
| Copy text | Drag to select, then **Ctrl+C** (with nothing selected, Ctrl+C is an interrupt) |
| Paste | **Ctrl+V**. If only an image is on the clipboard, such as a screenshot, it is attached to Claude Code or Codex as an image; for a remote PC the image is sent there and its path pasted. |
| New line while typing | **Shift+Enter** (Claude Code, Codex) |
| Scroll back | Mouse wheel |

## Screen

- **Sidebar**: power, theme and collapse at the top; PCs and their folders in the middle; ＋ Add PC, Sharing map and Workflow at the bottom.
- **Status**: the dot before a folder is green while it works, blinking amber while it connects, red if the connection failed. A small dot after the name means new activity since you last looked.
- **Usage**: while a session is open, Claude and Codex plan usage appears above ＋ Add PC as five-cell batteries of what is left (5h for the 5-hour limit, 7d for the 7-day one). Hover for the exact share and reset time; the arrow on the left folds it. Only agents that are running are shown, and Claude appears once a session opened by Lepons has replied.
- **Light / dark**: the sun/moon button at the top left.
- **Language**: Korean, English and Chinese, from the power button → **Language**. Dates and times follow the chosen language.

## Updates

Lepons compares its version with the latest GitHub release when it starts and when you press **Check for updates** on the power button. If there is a newer one you are told, and **Update now** downloads it inside the app. The download is checked against the file published on GitHub before it is installed, then Lepons closes briefly and reopens on the new version. Releases on the same Electron download only the changed app part (about 13 MB). On macOS only those small updates install in the app; others open the download page. Your PCs and settings stay as they are.

## Where Lepons connects

- PCs you add: over SSH only.
- GitHub: asks for the latest release when Lepons starts and when you press **Check for updates**; downloads that release's files when you press **Update now**.
- Claude (Haiku model): only when you press **Translate** on the workflow board, through this PC's Claude Code. That uses some Claude usage.
- Nothing else is sent by Lepons itself. Claude Code and Codex connect to their own services, and update themselves with their own commands on first launch.

## How it differs from other tools

- **cmux** is a native macOS terminal built on Ghostty that lets you watch several agents with vertical tabs and notifications. Lepons runs on Windows and macOS and goes past the terminal, to PCs reading each other's code.
- **VS Code + Remote-SSH** installs VS Code Server on the remote machine to build a remote development environment. Lepons installs nothing remotely and puts agent sessions from many PCs side by side in one window.
- **Plain terminals and SSH clients** stop at the connection. Lepons picks the agent per session, keeps it up to date, and shows what it is doing.

Problems and suggestions are welcome in [Issues](https://github.com/joyuno/lepons/issues).

## License

[MIT](LICENSE)
