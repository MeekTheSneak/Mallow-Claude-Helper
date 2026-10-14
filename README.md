# Mallow

<img src="mallow.png" width="120" align="right" alt="Mallow the hamster">

Mallow is a hamster who lives next to your Claude Code sessions. He runs his wheel while Claude works, and a baby hamster joins him for every subagent or parallel thread. When it's your turn, he waves. When something wastes your usage, like a cache going cold or a huge tool result, he holds up a sign until you click him and say "Got it".

Under the room you get a report of your past sessions, an **Export for Claude** button that writes a short list of fixes you can paste into a project, and an optional **harness** that trims wasteful tool calls before they run.

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

## The room

| You see | It means |
| --- | --- |
| Mallow on the wheel | Claude is working |
| Baby hamsters on the wheel | Subagents or parallel threads are running |
| Mallow waving at the door | Claude finished and it's your turn |
| Mallow holding a sign | Something wasted usage. Click him to see what and how to avoid it |
| A beetle on the floor | A tool call failed |

Three themes: **Day**, **Night**, and **Knight**, where Mallow and the babies fight a dragon instead of running the wheel. **Auto** follows your clock.

Keys: `P` pet, `F` feed, `D` dance, `O` change outfit, `S` sound, `T` theme. Click the floor to drop a seed. Click a baby to see what it's working on.

If you have several sessions open, use the picker above the session card to choose which one Mallow follows.

## What a cold cache is

Claude Code keeps your conversation in a prompt cache so each new message only pays a small "cache read" price for everything that came before. The cache expires after about 5 minutes without activity (some setups use 1 hour). The next message after that has to write the whole conversation into the cache again, which costs roughly 12 to 20 times more than reading it. In a long session that one message can cost as much as dozens of normal ones.

You can't stop the cache from expiring, but you can stop paying for it by accident:

- Mallow warns you shortly before the cache expires (a bubble, plus a Windows notification if his window isn't in front), so you can reply while it's still warm.
- If you're stepping away for a while from a long session, start a fresh session when you come back instead of resuming the big one. Ask Claude for a short handoff note first if you need continuity.

## The harness

The harness is a Claude Code `PreToolUse` hook (`harness.py`). It is off until you click **Turn on** in the Harness panel. Turning it on adds one entry to `~/.claude/settings.json` and backs that file up to `~/.mallow` first. **Turn off** removes only Mallow's entry.

What it does:

- **Big files are read in parts.** When Claude reads a file over 60 KB with more than 600 lines and no line range, it reads the first 600 lines and gets a one-line note saying how to read more.
- **Noisy commands keep their tail.** Commands that printed huge output more than once in your own history (a build or test run, say) keep only their last 80 lines. Exit codes are kept, so failures still show as failures. Each command has its own switch.

What it never does: approve anything (your permission prompts work exactly as before), change commands that already filter their output, touch background commands, or call a model. If anything goes wrong inside the hook, the tool call goes ahead untouched.

### What is verified and what isn't

| Claim | Status |
| --- | --- |
| Mallow and the harness make no model calls | Verified: there is no network code that talks to a model |
| The hook only changes the calls described above | Verified by tests on sample inputs |
| Trimmed calls still go through permission prompts | Based on the Claude Code hook docs. Mallow checks your transcripts after you turn it on and shows how many trims actually took effect |
| It saves usage | Not proven in general. The panel replays your own saved sessions and shows two numbers: the saving if Claude never needed the trimmed part, and the cost if every trim sent Claude back for the rest. Your real result is somewhere between them, and after a few days the panel shows which trims Claude had to follow up on |

If the second number is bigger than the first for you, leave the harness off. The rest of Mallow works the same either way.

## Privacy

- Mallow only listens on `127.0.0.1`, so other computers can't reach it.
- It reads `~/.claude/projects` and writes only to `~/.mallow` (its settings and logs) and, if you turn the harness on, one entry in `~/.claude/settings.json`.
- The Export for Claude button copies text to your clipboard or saves it as a file. Nothing is uploaded.

## Folder layout

```
mallow.py        the app: reads sessions, serves the page, manages the harness
harness.py       the Claude Code hook
web/             the page, artwork and fonts
runtime/python/  Python 3.12 for Windows, with pywebview for the app window
tools/           build_sprites.py, which cuts new art sheets into web/sprites
```

To swap in new art, put the PNG sheets and `asset-manifest.json` in a folder and run `python tools/build_sprites.py path/to/folder`.

## Credits

- `runtime/python` is the official Windows embeddable Python 3.12.10 from python.org (PSF License, see `runtime/python/LICENSE.txt`).
- The app window uses [pywebview](https://github.com/r0x0r/pywebview) (BSD) with pythonnet (MIT), clr_loader (MIT), cffi (MIT), pycparser (BSD), bottle (MIT), proxy_tools (BSD) and typing_extensions (PSF). Their licenses are in `runtime/python/Lib/site-packages`.
- Fonts: Fredoka and Nunito (SIL Open Font License).
- Inspired by [mochi-crew](https://github.com/joeVenner/mochi-crew).

Mallow's own code is under the MIT License (see `LICENSE`).
