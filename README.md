# GitHub Copilot Usage for BB

Adds GitHub Copilot AI-credit or premium-request usage to BB's Provider Usage panel.

## Requirements

- BB 0.43 or newer.
- GitHub Copilot CLI installed and authenticated (`copilot login`).
- Windows, or `tmux` on macOS/Linux. On Windows the plugin uses Copilot's account-quota RPC; on Unix it reads the interactive `/usage` display through `tmux`.

The plugin launches the local authenticated CLI and closes it after each refresh. It does not read or store Copilot credentials.

## Install

```sh
bb plugin install git:https://github.com/defacid/bb-copilot-usage.git
```
