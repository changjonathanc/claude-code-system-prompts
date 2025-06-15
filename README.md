# Claude Code System Prompts

Interactive web-based diff viewer to compare Claude Code system prompts across different versions.

## Features

- **Real-time prompt extraction** from npm packages
- **Side-by-side diff comparison** with word-level highlighting
- **GitHub-style UI** with dark/light theme support
- **Version selection** with automatic latest version detection

## View Online

🔍 **[View at claude-code-system-prompts.jonathanc.net](https://claude-code-system-prompts.jonathanc.net)**

## How it Works

The tool dynamically extracts system prompts from the `@anthropic-ai/claude-code` npm package across versions, providing an interactive diff viewer to track changes in Claude's system prompts over time.

## Local Development

```bash
# Serve the files locally
python -m http.server 8000
# or
npx serve .
```

Open `http://localhost:8000` in your browser.