# @unbyte/ccc

> a thin wrapper that launches `claude code` with named configuration profiles.

## Why

- Named profiles for any combination of provider, model, thinking effort, env, and settings.
- Per-process config — each session picks its own profile, no conflicts.
- Escape hatch: anything not covered by first-class fields can go in `env` or `settings`.

## Quick Start

```bash
npm i -g @unbyte/ccc
```

Config: `$XDG_CONFIG_HOME/ccc/config.json`, or `~/.config/ccc/config.json` if unset (on all platforms).

```jsonc
[
  {
    "id": "some-id",         // name used to select this config
    "api": "https://api",    // provider base URL (omit to use the official subscription)
    "apiKey": "sk-ant-...",  // API key (optional if the provider allows it)
    "default": true,         // use this config when no id is given
    "models": {              // override model selection (optional)
      "default": "",
      "subagent": "",
      "haiku": "",
      "sonnet": "",
      "opus": ""
    },
    "thinking": {             // thinking config (optional)
      "effort": "high"        // low | medium | high | xhigh | max
    },
    "args": ["--debug"],      // extra args prepended to claude (optional)
    "env": {},                // extra env vars passed to claude (optional)
    "settings": {}            // additional Claude Code settings (optional)
  }
]
```

`models` also accepts a single string as shorthand — it applies to all model slots.

To use the official Claude subscription, omit `api` (and `apiKey`) — ccc leaves the
base URL and auth token untouched so Claude Code uses its built-in login:

```jsonc
[
  { "id": "official", "default": true },
  { "id": "some-provider", "api": "https://api", "apiKey": "sk-ant-..." }
]
```

Then run:

```bash
ccc              # uses the default config
ccc another-id   # uses the "another-id" config
ccc -p foo       # passes args to claude
```

## License

MIT
