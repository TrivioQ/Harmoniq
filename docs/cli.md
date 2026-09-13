# Harmoniq CLI Reference

The `@harmoniq/cli` is your primary tool for managing micro frontend deployments to your registry.

## Installation

You can install the CLI globally, or run it via `npx`:

```bash
npm install -g @harmoniq/cli
```

## Authentication

Before deploying, authenticate your CLI session:

```bash
harmoniq login
```
This command opens a browser window for OAuth 2.0 authentication against your Harmoniq Dashboard. Alternatively, you can authenticate in headless environments by setting the `HARMONIQ_TOKEN` environment variable.

## Deploying a Module

Use the `deploy` command from within your module's build directory:

```bash
harmoniq deploy \
  --workspace acme-corp \
  --module auth-module \
  --version 1.0.5 \
  --url https://cdn.acme.com/auth-module/1.0.5/remoteEntry.js \
  --env production
```

### Options

| Flag | Description | Required |
|---|---|---|
| `--workspace` | The target workspace slug | Yes |
| `--module` | The target remote module slug | Yes |
| `--version` | Semantic version string | Yes |
| `--url` | The URL of the deployed `remoteEntry.js` | Yes |
| `--env` | The target environment (e.g., `production`, `staging`) | Yes |
| `--token` | API token (can also use `HARMONIQ_TOKEN` env var) | No |

## CI/CD Usage

For headless CI/CD environments (like GitHub Actions), you should generate a machine-to-machine API Key with `module:write` permissions from the dashboard, and export it as an environment variable:

```yaml
steps:
  - name: Deploy to Harmoniq
    run: npx @harmoniq/cli deploy --workspace acme-corp --module nav-module --version $GITHUB_SHA --url https://cdn... --env production
    env:
      HARMONIQ_TOKEN: ${{ secrets.HARMONIQ_API_KEY }}
```
