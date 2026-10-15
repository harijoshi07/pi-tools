# pi-tools

Personal Pi extensions, tools, and cross-device configuration bundle for work, home, and cafe.

Inspired by [duarteocarmo/pi-tools](https://github.com/duarteocarmo/pi-tools).

---

## What's Included

| Component | Description |
| :--- | :--- |
| **`pi-subscription-meter`** | Enhanced subscription & quota meter with support for **Antigravity** and **Cursor** providers, compact live D/W footer progress bar, and `/subscriptions` dialog. |
| **`md-log`** | Live Markdown mirror extension (`/md-log <file>` / `/md-unlog`) for distraction-free reading, Obsidian live syncing, and lesson tracking. |
| **2-Line Footer Config** | Clean 2-line status bar configuration (`config/pi-footer.json`):<br>• **Line 1:** Model Provider · Thinking Level · Text Verbosity · Context Bar · Total Time<br>• **Line 2:** Git Branch · Git Diff |
| **Global Settings** | Default provider `antigravity`, model `gemini-3.8-flash`, and `high` thinking level with pre-configured extension suites. |

---

## Quick Install (New Device)

On any machine (macOS or Linux):

```bash
# 1. Clone your configuration repo
git clone git@github.com:harijoshi07/pi-tools.git ~/.pi-tools

# 2. Run the bootstrap script
~/.pi-tools/install.sh
```

> **Tip:** Use `--copy` instead of `--link` on managed/work machines if you prefer standalone files instead of symlinks:
> ```bash
> ~/.pi-tools/install.sh --copy
> ```

---

## Post-Install: Authenticate Providers

Once installed, start `pi`:
```bash
pi
```
Pi will automatically fetch all declared packages. Then authenticate your providers:
```text
/login antigravity
/login cursor
```

*(Or copy your `auth.json` from a secure password manager like 1Password CLI: `op read op://personal/pi-auth/auth.json > ~/.pi/agent/auth.json`)*.

---

## Repository Structure

```text
pi-tools/
├── package.json               # Root manifest registering bundled extensions
├── install.sh                 # Cross-platform setup script
├── config/
│   ├── settings.json          # Global defaults & package registry
│   └── pi-footer.json         # 2-line custom footer layout
├── extensions/
│   └── md-log.ts              # Session markdown logger
└── packages/
    └── pi-subscription-meter/ # Full subscription meter with Antigravity & Cursor
```
