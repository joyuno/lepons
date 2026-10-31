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

- **Windows**: run the `.exe`. The installer can be shown in Korean, English or Chinese. If "Windows protected your PC" appears, choose **More info → Run anyway**; the app has no code-signing certificate, which is what triggers the warning. If your browser blocks the download, choose **Keep**.
- **macOS**: open the `.dmg` and drag Lepons Cockpit into Applications. The app is not notarized by Apple, so the first launch shows a warning like "Apple could not verify 'Lepons Cockpit' is free of malware". Go to **System Settings → Privacy & Security** and press **Open Anyway** near the bottom (1.7.2 and later).

  If it still will not open, or 1.7.1 or earlier says it "is damaged and can't be opened", run this once in Terminal and open it again:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Lepons Cockpit.app"
  ```

## Features

1. **Codebase sharing between PCs**: on the sharing map, drag a folder onto another PC and that PC's Claude Code and Codex can read and search it. No git push or pull, no copying files. The receiving PC's agents can only read this folder; they cannot edit it directly, and values that look like keys or tokens are masked before they leave. To change something, they can hand the work to the PC that owns the folder, and that work runs there without permission checks. Share only between PCs you trust.
2. **Split panes with tabs**: split right or down, as many panes as the screen fits (up to eight), or show one with ⤢. A pane gathers one project's (one PC and folder's) AI sessions, terminals and files as tabs, so work from different PCs sits side by side.
3. **AI agents or a terminal**: click a folder and choose Claude Code, Codex, Grok, Antigravity, Cursor or Terminal to open it there. After Lepons starts, the first session on each PC updates the CLI first; the model is the CLI's own latest default. You can continue the folder's last conversation, or one you pick from a list.
4. **Work that survives a dropped connection**: remote sessions run inside tmux. Close the laptop or lose the network and the agent keeps working; reopen and you are back on the same screen.
5. **Nothing to install remotely**: no daemon, no server. Sessions and code sharing both travel over SSH. On the first connection, enter the password once and Lepons registers its SSH key for you. A Windows PC has its SSH server off, so press **⚙ Settings → Connections from other PCs → Allow…** once in that PC's Lepons, or paste the commands from the guide.
6. **View and edit files in a pane**: Markdown (including Obsidian syntax), code, images, PDF and HTML open in a pane, and files on this PC or a remote one can be edited in place. Text files open ready to edit and save with **Ctrl+S** (**⌘+S** on macOS); closing one with unsaved changes asks whether to save. The file tree has VS Code's right-click actions: copy, paste, rename, delete, copy path.
7. **Workflow map**: every PC's folders, sessions and subagents on one map, with each session's goal, what it is doing now and what passed between PCs readable without opening its record, and a jump to the sessions waiting for you.
8. **Import what you already use**: brings in machines and folders from the remote folders VS Code and Cursor remember and from Claude Code and Codex session history.
9. **Sessions in the phone app**: with the Lepons app for iPhone and Android (coming soon), read a session's conversation, tap a menu number or send the next instruction while you are out. When a session waits for you, your phone gets a notification. Everything between the phone and the PC is end-to-end encrypted; the relay in between cannot read it.
10. **A pet that says whose turn it is**: a duck on the desktop (produck) shows which session is waiting for you; click it to open that session. You can import your own pets.
11. **One prompt to many sessions**: send the same instruction to several open sessions at once.
12. **Pick up where you left off**: after a crash or a normal close, Lepons offers to bring back every open session and pane on the next launch.

## Getting started

On the first launch a short guide walks through the main buttons. To see it again, use **⚙ Settings → Tutorial** at the top left. Ctrl+, (⌘+, on macOS) also opens Settings. What each PC needs, with the install commands, is in **＋ Add machine → Guide**, which also checks this PC.

### Preparing a remote PC

- SSH access (password or key)
- tmux (recommended; without it, a dropped connection ends that session's work. A PC without it shows **Install tmux** in the list; click it and Lepons installs it in the background. If sudo needs a password, Lepons asks once in its own dialog and does not save it)
- The AI agents you use (Claude Code, Codex and so on) installed and signed in (if one is missing, Lepons offers to install it and types the official installer into that PC's terminal. **⚙ Settings → AI accounts** shows each PC's install and sign-in state, and signs in on remote PCs without a terminal)

PCs connect to each other over SSH only. One PC drives every VM and PC it can reach over SSH.

### Adding a machine

**＋ Add machine** at the bottom left offers four choices.

| Button | What it does |
|---|---|
| **＋ Folder on this computer** | Pick a folder on this PC to register it. |
| **＋ Remote machine** | Enter `<user>@<IP address or hostname>`, e.g. `ubuntu@10.0.0.5`. |
| **Import** | Finds what VS Code, Cursor, Claude Code and Codex remember and adds it at once. A good first click. |
| **Guide** | Shows what this PC, a remote PC, the phone and the pet need, with install commands and this PC's Lepons public key. |

If the remote PC does not have the Lepons key yet, a password field appears. Enter it once and Lepons adds its key to `~/.ssh/authorized_keys`; every later connection uses the key. The password is never stored. If the server does not allow password logins, copy the public key from **Guide** into the remote PC's `~/.ssh/authorized_keys`.

### Opening a folder

Click a folder in the list on the left and choose what to run.

- **Claude Code / Codex / Grok / Antigravity / Cursor / Terminal** starts it in that folder.
- **Continue the last conversation** is ticked by default. It continues the folder's last conversation as a new session, and starts a new one where there is none. For Claude Code and Codex, **Pick a past conversation…** lists the folder's earlier conversations to search by title; the one you pick continues as a new conversation and the original stays as it was.
- **Run without permission checks** is off by default. Off, Claude Code starts in auto mode and Codex in automatic review, asking only about risky actions. On, every check is skipped and Codex also runs without its sandbox. Turn it on only for folders you trust.

Hover a folder for **⚙** (open terminal, new file, rename, remove from the list; files on disk stay), and use the chevron left of its name to show its files. **Open terminal** opens a plain terminal in the same folder beside the Claude or Codex session, which keeps running. The buttons over an open file list make a new file or folder, refresh, and collapse folders; press refresh if a file an agent or terminal created does not show. The **>_** button on a pane's header, or Ctrl+` (⌘+` on macOS), opens that project's terminal as a tab, and **>_** on a PC's row opens a terminal in that PC's home folder.

### Letting other PCs connect to this one (Windows)

Windows ships with its SSH server off. To use this PC as a remote PC from another PC's Lepons, press **⚙ Settings → Connections from other PCs → Allow…**. After one administrator prompt, Lepons turns on the OpenSSH server and opens the firewall only to SSH from the same network (LAN), with a rule named `Lepons-SSH-LAN`. **Turn off…** in the same tab puts it all back. On a company PC, ask your IT team first.

## Phone app

On the phone, the **Lepons** app for iPhone and Android shows and answers this PC's sessions. It is coming soon to the App Store and Google Play.

### Connecting

1. On the PC, click the phone icon at the top left → **Phone setup guide**, set a phone sign-in password and an authenticator app (Google Authenticator or similar), and turn on **Allow phone access**.
2. **⚙ Settings → Phone app → Connect phone app** shows a QR code. Scan it with the Lepons app within two minutes.
3. Check that both screens show the same six digits; if they do, press **Yes, same** on the PC.
4. In the phone app, sign in with the password and the authenticator's six-digit code.

The phone and the PC meet through a relay (`relay.lepons.app`), so they do not need to be on the same network. Everything between them is end-to-end encrypted so that only this PC and the phone can read it; the relay cannot. A PC connects to one phone; connecting a new phone unpairs the previous one.

### What the phone app does

- **Home**: what is running, waiting for input and done; Claude and Codex usage limits (5-hour and 7-day); and the connection state of your PCs. A PC that dropped can be asked to reconnect from the phone.
- **Sessions**: grouped the way the PC's panes and tabs are.
- **Chat**: read the agent's conversation, tap a menu number or send the next instruction; sending an empty line presses Enter. The stop icon takes two taps and interrupts what the agent is doing (Esc). The phone cannot end the agent; do that on the PC.
- **Workflow**: what the agent did for each prompt, in order.
- **Files**: Markdown, PDF and images in the session's folder.
- **Map**: each PC's folders and sessions on one map; tap a session to open it.
- **AI accounts**: the PC's AI sign-in state, view only. Sign in and out on the PC.
- **Settings**: terminal text size and notifications. A **demo** lets you look around without a PC.

### Notifications

- **Waiting for input**: when a session waits for you. Several at once arrive as one notification, and none is sent while you are at the PC or looking at the app.
- **All done** (optional): one quiet notification when every session that was working has finished.
- Notifications carry only the PC's name, never agent output.

Good to know:

- A sign-in lasts 10 hours.
- Anything sent from the phone shows on the desktop as "Typed from the phone".
- A sleeping PC cannot be reached from the phone; turn sleep off in its power settings.
- Privacy policy: https://lepons.app/privacy · Support: https://lepons.app/support

## The pet and input alerts

- **⚙ Settings → Pet → On** puts a duck (produck) on the desktop. It is off by default.
- It changes with the session's state (working, waiting for input, done, connecting, disconnected, idle); click it to open that session. Drag it anywhere; double-click sends it back to the bottom-right corner.
- **Import pet…** in the same tab takes a folder of per-state images (`idle.gif`, `working.gif` …, at least `idle`) or a Codex Pet folder. **View guide** explains how to make one.
- The dot in the list on the left lights up for **sessions that finished and are waiting for your input**. If Lepons is behind other windows when that happens, the OS shows a notification.

## Sharing map

**Sharing map** at the bottom left is where PCs are allowed to read each other's code.

- **Drag a folder onto another PC's card** to share it; **click a line** to stop.
- **Arrows point the way the code goes.** `A → B` means B's Claude Code and Codex read A's folder. Sharing both ways shows as one double arrow (`⇄`). Hover a line to see who reads what, in sentences.
- Connecting a share registers Lepons MCP on that PC automatically. The **MCP for [Claude] [Codex]** switches on the receiving PC's card choose which agents get it (at first only the PC's default agent). Sessions that were already open get an **Apply lepons** button that reopens them, continuing the conversation.
- PCs that share with each other are placed side by side so the arrows stay short. A card you drag yourself stays where you put it.
- Removing a PC from the list also ends every share connected to it.
- When a folder on one PC seems to use a package that is a folder on another (package.json, go.mod, Cargo.toml and so on), a dashed line suggests the share. Click it to share; right-click to hide the suggestion.
- In the list on the left, `↗N` beside a folder is how many PCs read it, and `↙N` beside a PC is how many folders it reads.

### How code is shared

- When you connect on the sharing map, Lepons opens a reverse tunnel over the SSH connection and registers Lepons MCP with that PC's Claude Code and Codex.
- The receiving agent searches with `search_repo` and opens only the files it needs with `read_file`. For each request, Lepons reads just that file, or the matching lines, on the PC that owns it.
- Nothing is copied or sent ahead of time. Only what the agent actually reads enters its context, so that is all the tokens it costs.
- The receiving agent can hand work to the owning PC with `delegate_task`; that PC's Claude Code or Codex does it there without permission checks, and `check_delegation` reports progress.

## Workflow map

**Workflow** at the bottom left (Ctrl+Shift+M, ⌘⇧M on macOS) puts the work on every PC on one map. Without reading a session's record you can see what it set out to do, how far it got, what it is doing now and whether it is waiting for you.

- Each PC is a hub with a monitor icon; its folders and sessions branch from it, and subagents branch from their sessions. This PC is marked; remote PCs carry a ↗ badge and, when known, their OS. The ring round a hub shows its connection state.
- The summary under each item shows without hovering: for a session, what it is doing now and its goal; for a subagent, what it was asked and how long it has run or what it returned; for a folder, what its busiest session is doing and its counts.
- The map opens at 30%, fitted so every PC is in view. Things move only where motion means something: dashes flow along sharing links and running delegations, light dots flow into working sessions, and a waiting session's ring pulses.
- Drag a hub or folder to move it; the position is kept. Double-click to focus on that branch, and Esc to go back.
- Click a session for a summary card (goal, progress, now, result) at the top of the right panel, with the step list below it. For a waiting session the panel shows the question and its options; answer it in its pane with **Go to its pane**.
- With **Follow** on, the map moves to sessions that start working or start waiting for you.
- The map is for watching only; it does not send commands or answers.
- When sessions are waiting, **Needs you N** appears in the top bar; click it to open the map on the next waiting session.
- Subagent instructions are usually written in English. The **Translate** button in the step list shows them in the app's language, using a little of this PC's Claude usage (Haiku model) only when pressed.

## In the terminal

| To | Do |
|---|---|
| Copy text | Drag to select, then **Ctrl+C** (with nothing selected, Ctrl+C is an interrupt) |
| Paste | **Ctrl+V**. If only an image is on the clipboard, such as a screenshot, it is attached to Claude Code or Codex as an image; for a remote PC the image is sent there and its path pasted. |
| New line while typing | **Shift+Enter** (Claude Code, Codex) |
| Scroll back | Mouse wheel |
| Open a link | **Ctrl+click** (**⌘+click** on macOS). A remote PC's `localhost` address opens through a forward of that PC's port to this one, and stays in the pane header as `🌐 port ×`: the globe opens it again, × closes the forward. |

## Screen

- **Sidebar**: ⚙ Settings, the phone icon and collapse at the top; PCs and their folders in the middle; ＋ Add machine, Sharing map and Workflow at the bottom. Drag folders and PCs to reorder them; the chevron left of a PC's name folds its folders (kept across launches).
- **Pinned**: pin a folder from any PC and it gathers at the top of the list.
- **Manage machines**: lets you rename each PC, edit its connection, reconnect it, and choose whether it connects when Lepons starts.
- **Top bar**: Needs you N (when sessions are waiting), the split buttons (which split the selected pane right or down) and, on Windows, the window buttons, all in one row. Drag the bar to move the window.
- **Pane tabs**: a pane gathers one project's sessions, terminals and files as tabs, and panes of the same project share a coloured band. Drag a tab to a pane's edge to split it off into a new pane of that project. Closing a tab leaves the session running in the list on the left.
- **Status**: the dot at the end of a folder's row is green while it works, blinking amber while it connects, red if the connection failed. A session that finished and is waiting for your input gets its own dot.
- **Send to several sessions**: with two or more sessions open, a button appears in the sidebar. Tick the sessions and send with Ctrl+Enter.
- **Session restore**: after a crash or a normal close, the next launch offers to bring back every open pane and session. Remote sessions rejoin the work still running in tmux. To always reopen without asking, turn it on in **⚙ Settings → Startup**.
- **Usage**: while a session is open, Claude and Codex plan usage appears above ＋ Add machine as five-cell batteries of what is left (5h for the 5-hour limit, 7d for the 7-day one). Hover for the exact share and reset time; the arrow on the left folds it. Only agents that are running are shown, and Claude appears once a session opened by Lepons has replied. It updates right after each Claude reply on this PC, and for a remote PC when one of its sessions finishes a turn or the PC is opened.
- **Theme**: **⚙ Settings → Theme** offers light, dark and **System** (follows the PC's setting).
- **Font**: **⚙ Settings → Font** sets the text size and font for terminals and file views. D2Coding, JetBrains Mono and Fira Code come with the app.
- **Remote PCs**: **⚙ Settings → Remote PCs** lists your remote PCs one row each, with a switch to connect or disconnect. The **⋯** menu edits the address, shows AI accounts or removes the PC.
- **Language**: Korean, English and Chinese, from **⚙ Settings → Language**. Dates and times follow the chosen language.

## Updates

Lepons compares its version with the latest GitHub release when it starts and when you press **⚙ Settings → Updates → Check for updates**. If there is a newer one you are told, and **Update now** downloads it inside the app. The download is checked against the file published on GitHub before it is installed, then Lepons closes briefly and reopens on the new version. Releases whose runtime (Electron, native modules, build settings) is unchanged download only the changed app part (about 14 MB). On macOS only those small updates install in the app; others open the download page. Your PCs and settings stay as they are.

## Where Lepons connects

- PCs you add: over SSH only.
- The relay (`relay.lepons.app`): only when **Allow phone access** is on and a phone app is connected. Everything between the phone and the PC is end-to-end encrypted, so the relay cannot read it.
- Phone notifications: with notifications on in the phone app, "waiting for input" (and, if chosen, "all done") notifications go through Expo's push service to Apple's or Google's push. They carry only the PC's name.
- GitHub: asks for the latest release when Lepons starts and when you press **Check for updates**; downloads that release's files when you press **Update now**.
- Claude (Haiku model): only when you press **Translate** on the workflow map, through this PC's Claude Code. That uses some Claude usage.
- Nothing else is sent by Lepons itself. Claude Code and Codex connect to their own services, and update themselves with their own commands on first launch.

## How it differs from other tools

- **cmux** is a native macOS terminal built on Ghostty that lets you watch several agents with vertical tabs and notifications. Lepons runs on Windows and macOS and goes past the terminal, to PCs reading each other's code.
- **VS Code + Remote-SSH** installs VS Code Server on the remote machine to build a remote development environment. Lepons installs nothing remotely and puts agent sessions from many PCs side by side in one window.
- **Plain terminals and SSH clients** stop at the connection. Lepons picks the agent per session, keeps it up to date, and shows what it is doing.

Problems and suggestions are welcome in [Issues](https://github.com/joyuno/lepons/issues).

## License

Free to use. The license will be settled when the source is published.
