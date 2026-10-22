# live-files

A live file explorer pane for the Code tab of the desktop app. It shows one project folder as a tree, refreshes every couple of seconds, and marks every file that was added, changed or deleted, so you can watch where the work is happening while you chat.

- a JetBrains-style tree with folders first, file type tags and indent guides
- **A** for new files (green), **M** for changed (blue), **D** for deleted (grey, struck through)
- folders with changes inside turn blue, with a dot that blinks while the change is fresh
- picks up files the chat wrote earlier too, even after the chat was compacted
- click a file to open it in the app's own Files viewer (code, Markdown, PDF)
- a **View** menu: size, age, type tags, the A/M/D key, ignored folders, dotfiles, indent guides, auto-open of changed folders, recent changes first
- **Pause** freezes the tree while you read; resume catches up on everything
- **Changes only** hides everything that did not change
- `.venv`, `node_modules`, `.git` and similar folders are listed but never scanned

## Install

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `yaqzans/live-files`, then **Add plugin**.

Or from a terminal:

```bash
claude plugin install live-files --marketplace yaqzans/live-files
```

New chats load it after install. In a chat that is already open, type `/reload-plugins`.

## Use

- The pane opens when a chat starts. The first time, pick the folder to watch: type a path, click through the folder list, or use **Browse with File Explorer...** on Windows. After that, new chats open on your most recent folder; **Change folder** picks another.
- Closed it? Click **Open Live files** above the prompt, or type `/files`. `/files <folder>` opens it straight on a folder.
- Hover a mark for what it means, or turn on the key in **View**.

## Notes

- Built against Claude Code 2.1.304. The mod API is early access, so a later release may need an update.
- The File Explorer picker is Windows only. Finding earlier writes in long chats uses PowerShell on Windows and `grep` elsewhere.
- Nothing leaves your machine: the pane only reads your files and this chat's own transcript.

## Uninstall

```bash
claude plugin uninstall live-files@live-files
```

## Tests

```bash
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
