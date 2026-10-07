# op-agent

A terminal coding assistant that explores your project, explains code, edits files, runs tests, and helps with Git. Chat with Claude or an OpenAI-compatible model, and extend its tools with executable plugins.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    op-agent CLI                         │
│                   (cli.js)                              │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
    ┌────────┐  ┌─────────┐  ┌──────────┐
    │Agent   │  │Provider │  │Config    │
    │Loop    │  │Adapter  │  │Manager   │
    │(agent) │  │(openai/ │  │(config)  │
    │        │  │anthropic)   │          │
    └────┬───┘  └────┬────┘  └──────────┘
         │           │
         ▼           ▼
    ┌──────────────────────────┐
    │    Tool Executor         │
    │    (tools.js)            │
    │  - File Read/Search      │
    │  - File Edit             │
    │  - Command Execution     │
    │  - Git Operations        │
    │  - Plugin Invocation     │
    └────┬─────────────────────┘
         │
    ┌────┴────────────────┐
    ▼                     ▼
┌──────────┐         ┌──────────────┐
│Repository│         │Workspace     │
│Discovery │         │(Git + Files) │
│(repo.js) │         │              │
└──────────┘         └──────────────┘
```

## Workflow

```
User Input
    │
    ▼
┌─────────────────────────┐
│ Parse & Analyze Context │
│ - File Map              │
│ - Git Status            │
│ - Project Structure     │
└────────┬────────────────┘
         │
         ▼
   ┌──────────────────┐
   │ Send to AI Model │
   │ + Tools Available│
   └────────┬─────────┘
            │
            ▼
  ┌─────────────────────┐
  │ Model Decision      │
  │ Choose Tool(s)      │
  └────┬────────────────┘
       │
       ▼
 ┌───────────────────┐
 │ Request Approval? │
 │ (Read = Auto)     │
 │ (Edit = Ask)      │
 │ (Cmd = Ask)       │
 └────┬──────────────┘
      │
      ├─── Approved ───┐
      │                ▼
      │         ┌────────────────┐
      │         │Execute Tool    │
      │         │Get Result      │
      │         └────┬───────────┘
      │              │
      └──────┬───────┘
             ▼
      ┌─────────────────┐
      │Send Result to   │
      │Model for Loop   │
      │(max 20 steps)   │
      └────────┬────────┘
               │
               ▼
        ┌─────────────────┐
        │ Done?           │
        │ (User Exit or   │
        │  Max Steps)     │
        └────┬────────────┘
             │
             ▼
        Final Response
```

## Install

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/itegramin/op-agent/main/scripts/install.sh | bash
```

The default location is `~/.local/bin`. If it is outside your PATH, add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile (for example, `~/.zshrc`). No sudo is required.

### Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/itegramin/op-agent/main/scripts/install.ps1 | iex
```

Installs under `%LOCALAPPDATA%\op-agent`, updates your user PATH, and prints API-key and first-run instructions when installation completes. Both installers check for Node.js and explain how to install it if missing. You can download and inspect each script before running.

The installers download the source archive from `main`; no npm registry release is required. To install from a local checkout instead:

```sh
npm install --global . --ignore-scripts
op-agent --help
```

Set `OP_AGENT_SOURCE` to an npm-compatible package spec, such as a local `.tgz` package archive or a GitHub archive tarball URL, to install a specific version. `OP_AGENT_INSTALL_DIR` overrides the npm global prefix. On Linux/macOS, the executable is placed in `<prefix>/bin` (default `~/.local/bin`); on Windows, it is placed in `<prefix>` (default `%LOCALAPPDATA%\op-agent`).

## Get started

1. Choose a provider and create an API key with [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/api-keys). By default, op-agent uses Anthropic.
2. Set the matching API key in your terminal. Replace the placeholder with your key:

   macOS / Linux (Anthropic):

   ```sh
   export ANTHROPIC_API_KEY='your-key'
   ```

   Windows PowerShell (Anthropic):

   ```powershell
   $env:ANTHROPIC_API_KEY = 'your-key'
   ```

   For OpenAI, set `OPENAI_API_KEY` instead and select that provider with `OP_AGENT_PROVIDER=openai` (PowerShell: `$env:OP_AGENT_PROVIDER = 'openai'`).

   These environment variables apply only to the current terminal session. Do not paste your key into chat, commit it to your repository, or share it.
3. Change to the project you want op-agent to work on, then start it:

   ```sh
   cd path/to/your-project
   op-agent
   ```

   Ask a question or describe a task in the full-screen terminal chat. Searches and reads happen automatically; op-agent asks for approval before running commands, making edits, or using plugins. Enter `/help` for commands or `/exit` to quit and return to your terminal.

To try a one-shot request instead, run `op-agent --cwd ./your-project "Explain how this project is structured"`. Run `op-agent --help` for options and interactive commands.

## Try a request

```text
op> Explain how authentication works and point me to the relevant files.
op> Run the tests for src/parser.test.ts.
op> Review my changes, stage the parser files, and commit with a useful message.
op> Fix the failing test and explain what changed.
```

The assistant sees a file map and Git status, then searches and reads relevant code on demand. It can explore the whole eligible project without sending every file in every request. Git projects use `.gitignore` to exclude files automatically.

## Approvals and behavior

- File searches and reads run automatically; **commands, edits, and plugins ask for approval** and display the proposed action. Denials are returned to the model.
- Commands run at the project root with `/bin/sh` on Unix or `cmd.exe` on Windows. The model receives the OS and command exit code/output. Commands have no interactive stdin and time out after two minutes.
- File edits require an exact unique match and are checked for concurrent changes after approval. New files require an existing parent directory.
- Tool results are capped at 24,000 characters; file reads at 256 KiB and 400 lines per call. The agent takes at most 20 model steps per request. Use `/context` to inspect estimated context size, `/compact` to summarize earlier turns, or `/clear` to reset the conversation.
- API requests have a two-minute timeout. API failures surface without automatic retries that could repeat a mutation.
- `--yes` approves all actions for trusted automation. Without a terminal, mutations are denied unless `--yes` is supplied.
- This is **not an OS sandbox**. Approved commands/plugins have your local permissions and can access files or the network. Automatic file exclusions do not constrain a command you approve. Provide project scope limits in your config or through conversation.
- Relevant code, project instructions, Git status, paths, and tool output are sent to your configured provider. Review requests before using sensitive projects. Conversations are saved locally to resume across runs; session files contain conversation text but never store the configured API key. Avoid entering secrets into chat.

## Configuration

The optional user config is `~/.config/op-agent/config.json` on every platform (`~` is your Windows home directory too). Use `--config <file>` to select a different file. Project configuration is `.op-agent.json` in the project root. Project values override user values, then environment variables override both. `plugins` from both files are combined; user-config plugin paths resolve relative to the user config, and project plugin paths resolve relative to the project root. API keys are accepted only through environment variables.

```json
{
  "provider": "openai",
  "model": "gpt-4.1",
  "baseUrl": "https://api.openai.com/v1",
  "plugins": ["/absolute/path/to/plugin.json"]
}
```

| Environment variable | Purpose |
| --- | --- |
| `OP_AGENT_PROVIDER` | `anthropic` (default) or `openai` |
| `OP_AGENT_MODEL` | Model identifier; defaults to `claude-sonnet-4-5` or `gpt-4.1` |
| `OP_AGENT_BASE_URL` | API base including `/v1`, when required by your server |
| `ANTHROPIC_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | OpenAI-compatible API key |

Environment variables override configuration. Keys are read only from the environment. OpenAI-compatible servers must implement Chat Completions with function calling; set the model and base URL environment variables.

Project and nested `AGENTS.md` files are loaded as project instructions and included with requests. Keep them focused: combined instructions are limited to 32 KiB.

## Saved sessions

Interactive and one-shot conversations are saved under `~/.local/share/op-agent/sessions` (Windows: `%LOCALAPPDATA%\op-agent\sessions`; override the data directory with `OP_AGENT_DATA_DIR`). Session files are restricted to the current user where the platform supports file permissions. They contain conversation text and tool results, so do not enter secrets into a conversation.

```sh
op-agent --list-sessions
op-agent --resume <session-id>
op-agent --branch <session-id>
```

In interactive mode, `/sessions` lists this project's saved conversations, `/resume <session-id>` switches to one, and `/branch` creates a separate continuation from the current session.

## Interactive commands

| Command | Action |
| --- | --- |
| `/help` | Show usage |
| `/files [substring]` | List project files |
| `/tools` | Show available agent tools |
| `/plugin <name> <JSON>` | Invoke a configured plugin with approval |
| `/sessions` | List saved conversations for this project |
| `/resume <id>` | Resume a saved conversation |
| `/branch` | Branch the current conversation into a new session |
| `/context` | Show estimated history and project context size |
| `/compact` | Summarize earlier turns, preserving the latest turn |
| `/clear` | Clear conversation history in this session |
| `/exit` | Exit (Ctrl+D also closes input) |

## Plugins

A plugin is a JSON manifest with version `1` and a list of tools. Each tool declares a name, description, parameters, and an executable argument array. See [examples/plugin.json](examples/plugin.json).

1. Copy the example files together into a directory you control.
2. Add the manifest's absolute path to `plugins` in your user config. Relative paths resolve against the config directory.
3. Restart `op-agent`. The tool appears in `/tools` and is available to the model.
4. Ask for a project summary or run `/plugin project_summary {"includeDependencies":true}`.

`${pluginDir}` in arguments expands to the manifest directory. The tool receives one JSON object on stdin, runs in the project root, and returns stdout/stderr and an exit code. Argument arrays are joined with spaces after expansion.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
node bin/op-agent.js --help
npm pack
```

No runtime dependencies or build step. Tests use synthetic provider responses and disposable repositories; no provider key or network is needed. GitHub Actions runs the tests and installer smoke tests on each pull request.

Architecture: `repository.js` discovers and reads code, `tools.js` enforces tool boundaries and approvals, `providers.js` adapts APIs, `agent.js` runs the tool loop, and `cli.js` handles the terminal interface.
