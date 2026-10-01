# GitHub Copilot Usage for BB

Adds GitHub Copilot AI-credit or premium-request usage to BB's Provider Usage panel.

## Requirements

- BB 0.43 or newer.
- GitHub Copilot CLI installed and authenticated (`copilot login`).
- `tmux`, which provides the terminal emulation required by Copilot's interactive `/usage` display.

The plugin launches the local authenticated CLI, reads its visible `/usage` screen, and closes the temporary terminal session. It does not read or store Copilot credentials.

## Install

```sh
bb plugin install git:https://github.com/defacid/bb-copilot-usage.git
```
