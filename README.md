# claude-plugins

DevLocker plugins and mods for Claude Code, by Filip Slavov (NibbleByte).

## Plugins

| Plugin | What it does |
| --- | --- |
| [open-in-ide](plugins/open-in-ide) | A button for each source file Claude's replies mention, opening it at the line in Rider, Visual Studio, VS Code or any editor you give a command for. Understands Unity and Unreal projects. (Windows only) |

**open-in-ide** screens:
![open-in-ide: buttons under each paragraph of a Claude reply, one per file it mentions](plugins/open-in-ide/docs/screenshot.png)

## Install

In a Claude Code session, add the marketplace once, then install the plugins you want:

```
/plugin marketplace add NibbleByte/claude-plugins
/plugin install open-in-ide@devlocker
```

Or in one step:

```
/plugin install open-in-ide --marketplace NibbleByte/claude-plugins
```

In the Claude desktop app, the same is under **+ > Plugins > Add marketplace**, with `NibbleByte/claude-plugins`.

Adding the marketplace installs nothing by itself; each plugin is installed by name.

## License

[MIT](LICENSE)
