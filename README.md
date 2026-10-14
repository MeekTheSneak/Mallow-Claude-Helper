# Mallow

<img src="mallow.png" width="120" align="right" alt="Mallow the hamster">

Mallow is a hamster who lives next to your Claude Code sessions. He runs his wheel while Claude works, and a baby hamster joins him for every subagent or parallel thread. When it's your turn, he waves. When something wastes your usage, like a cache going cold or a huge tool result, he holds up a sign until you click him and say "Got it".

Under the room you get a report of your past sessions, an **Export for Claude** button that writes a short list of fixes you can paste into a project, and **Usage helpers**: reminders at the moments that matter, a few Claude Code settings that cut background requests, and an optional hook that trims oversized tool results.

Everything runs on your computer. Mallow reads the session files Claude Code already saves in `~/.claude/projects`. It never sends anything anywhere, and it never makes a model call, so it doesn't use any of your Claude usage.

## Run it

**Windows**

1. Click the green **Code** button on this page, then **Download ZIP**.
2. Extract the zip somewhere you'll keep it, like your Documents folder.
3. Double-click **Open Mallow (Windows).bat**.

That's all. Python and the window library are already inside the `runtime` folder, so there is nothing to install. If you want a desktop icon, double-click **Add Mallow to Desktop (Windows).bat** once.

Windows may ask "Do you want to run this file?" the first time, because it came from the internet. Click Run.

**Mac and Linux**

Double-click **Open Mallow (Mac).command**, or run `python3 mallow.py` in this folder. It needs Python 3.9 or newer, with no extra packages. On a Mac, the first time, right-click the file and choose Open, since macOS blocks downloaded scripts. Mallow opens in a Chrome or Edge app window if you have one, otherwise in your browser.

Mallow quits by itself a few minutes after you close its window.

## Mallow in Claude Code's side pane

Mallow also comes as a Claude Code plugin that lives in the side pane, right next to your session. Install it once, at the prompt of a terminal session:

```
/plugin install mallow --marketplace MeekTheSneak/Mallow-Claude-Helper
```

Answer `y` to add the marketplace, then pick the user scope so he shows up in every session. From a shell it's `claude plugin install mallow --marketplace MeekTheSneak/Mallow-Claude-Helper`. In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `MeekTheSneak/Mallow-Claude-Helper`, then **Add plugin**.

In the pane:

- **The room**, in Day, Night or Knight. Mallow runs his wheel (or fights the dragon) while Claude works, a baby hamster in costume joins for every subagent, and he waves when it's your turn. He naps when you've been away a while.
- **Your limits.** Context fill, how long the cache stays warm, how much of the last turn came from cache, and your 5-hour and weekly plan limits with their reset times. On the API you see the session's cost instead.
- **Heads-ups.** A toast and a notification before the cache goes cold, toasts at 80% and 90% context and plan use, a /clear tip when a big session finishes a turn, and an alert when Claude keeps failing the same step, reads the same file again and again, gets a huge tool result, or when prompt caching isn't working at all.
- **Changed files** with their git status and line counts. Click one to open it.
- **Mallow himself.** Pet (`p`), feed (`f`), dance (`d`), outfits (`o`), themes (`m`), sound (`s`), file list (`t`). He has a mood, energy that runs down while he works and comes back when he rests, and a streak of days you've worked together.

`/mallow` opens the pane. `/mallow meter`, `/mallow journal`, `/mallow outfit crown`, `/mallow theme knight` and `/mallow sound` do what they say.

The plugin only watches: every tool call, prompt and turn passes through unchanged, it never calls a model, and it adds nothing to what Claude reads. The desktop app is still where the session history, the Export for Claude brief and the usage helpers live. When the app is running, the pane links to it.

## The room

| You see | It means |
| --- | --- |
| Mallow on the wheel | Claude is working |
| Baby hamsters on the wheel | Subagents or parallel threads are running |
| Mallow waving at the door | Claude finished and it's your turn |
| Mallow holding a sign | Something wasted usage. Click him to see what and how to avoid it |
| A beetle on the floor | A command Claude ran failed |
| A yellow tip under the session | A good moment to save usage, like a big session that's ready for /clear |

Three themes: **Day**, **Night**, and **Knight**, where Mallow and the babies fight a dragon instead of running the wheel. **Auto** follows your clock.

Keys: `P` pet, `F` feed, `D` dance, `O` change outfit, `S` sound, `T` theme. Click the floor to drop a seed. Click a baby to see what it's working on.

If you have several sessions open, use the picker above the session card to choose which one Mallow follows.

## What a cold cache is

Claude Code keeps your conversation in a prompt cache so each new message only pays a small "cache read" price for everything that came before. On a Claude subscription the cache lasts an hour without activity (5 minutes on the API, or once you're drawing on usage credits). The next message after that has to write the whole conversation into the cache again, which costs roughly 12 to 20 times more than reading it. In a long session that one message can cost as much as dozens of normal ones.

You can't stop the cache from expiring, but you can stop paying for it by accident:

- Mallow warns you shortly before the cache expires (a bubble, plus a Windows notification if his window isn't in front), so you can reply while it's still warm.
- Once it has expired on a big session, Mallow shows a tip: if you're starting something new, /clear or a new session costs nothing. If you're picking the work back up, Claude Code may offer to continue from a summary instead of the full history.

## Usage helpers

The **Usage helpers** panel collects everything Mallow can do to stretch your limit. None of it makes model calls, and none of it changes how Claude thinks.

### Reminders

Some of the biggest savings depend on a choice only you can make, so Mallow points them out at the right moment instead of guessing:

- **Cache about to go cold.** A bubble, plus a Windows notification if Mallow's window is in the background.
- **Good time to /clear.** When Claude finishes a turn and the session is carrying 100k tokens or more, Mallow suggests /clear if your next task is unrelated. Every message re-sends the whole conversation, so old context from a finished task costs on every turn and doesn't help the next one.
- **Claude going in circles.** When the same step fails 3 times in a row, or 5 of the last 6 tool calls fail, Mallow holds up his sign. Stopping and redirecting early is cheaper than letting Claude keep retrying.
- **Same file read again and again, and huge tool results.** These show up as signs too, with the fix to paste into the project.

### Claude Code settings

Switches that cut requests Claude Code makes in the background. Each one edits `~/.claude/settings.json` (backed up to `~/.mallow` first), remembers what was there, and puts it back exactly when you switch it off.

- **No prompt suggestions** (recommended): turns off the grey "next message" guess, which is a small extra request after every reply.
- **No idle goal check-ins**: only matters if you use /goal. Claude checks on background work when you next type instead of on its own.
- **Hold messages from other sessions**: only matters if your sessions message each other. Leave it off if they coordinate on their own.

### Trims

A Claude Code `PreToolUse` hook (`harness.py`). It is off until you click **Turn on** in the Trims section. Turning it on adds one entry to `~/.claude/settings.json` and backs that file up to `~/.mallow` first. **Turn off** removes only Mallow's entry.

What it does:

- **Big files are read in parts.** When Claude reads a file over 60 KB with more than 600 lines and no line range, it reads the first 600 lines and gets a one-line note saying how to read more.
- **Build and test logs get shortened.** When a build, test or install command (npm test, cargo build, gradlew, pytest and the like) printed a huge log at least twice in your history, and only in the projects where that happened, Claude sees the lines that mention errors plus the last 60 lines. The full log is saved in `~/.mallow/out` for two days, and Claude is told where, so it can read more without running the command again. Exit codes are kept, so failures still show as failures. Each command has its own switch.
- **Commands whose output is the point are never touched.** cat, sed, grep, git diff, scripts and anything piped are left alone, because Claude ran them to read that output.

What it never does: approve anything (your permission prompts still apply; one side effect is that a shortened command no longer matches an allow rule like `Bash(npm test:*)`, so Claude Code may ask before running it), change commands that already filter their output, touch background commands, or call a model. If anything goes wrong inside the hook, the tool call goes ahead untouched.

Trims are the one helper that can backfire: if Claude needs the part that was cut, it goes back for it, and that costs more than the trim saved. The panel replays your own saved sessions and shows two numbers, the saving if Claude never needed the cut part and the cost if it always did. If the second is bigger, leave trims off. After you turn them on, the panel also shows how many trims Claude had to follow up on.

## Privacy

- Mallow only listens on `127.0.0.1`, so other computers can't reach it.
- It reads `~/.claude/projects`. It writes to `~/.mallow` (its settings, logs and saved build logs), to `~/.claude/settings.json` only when you switch a helper on, and to a desktop or Startup shortcut only when you ask for one.
- The Export for Claude button copies text to your clipboard or saves it as a file. Nothing is uploaded.

## Folder layout

```
mallow.py        the app: reads sessions, serves the page, manages the harness
harness.py       the Claude Code hook
web/             the page, artwork and fonts
runtime/python/  Python 3.12 for Windows, with pywebview for the app window
tools/           build_sprites.py, which cuts new art sheets into web/sprites
tests/           quick checks: python -m unittest discover tests
plugin/          the Claude Code side-pane plugin (claude plugin test plugin)
```

To swap in new art, put the PNG sheets and `asset-manifest.json` in a folder and run `python tools/build_sprites.py path/to/folder`.

## Credits

- `runtime/python` is the official Windows embeddable Python 3.12.10 from python.org (PSF License, see `runtime/python/LICENSE.txt`).
- The app window uses [pywebview](https://github.com/r0x0r/pywebview) (BSD) with pythonnet (MIT), clr_loader (MIT), cffi (MIT), pycparser (BSD), bottle (MIT), proxy_tools (BSD) and typing_extensions (PSF). Their licenses are in `runtime/python/Lib/site-packages`.
- Fonts: Fredoka and Nunito (SIL Open Font License).
- Inspired by [mochi-crew](https://github.com/joeVenner/mochi-crew).

Mallow's own code is under the MIT License (see `LICENSE`).
