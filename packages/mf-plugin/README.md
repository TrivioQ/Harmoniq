# @harmoniq/mf-plugin

[Module Federation 2.0](https://module-federation.io) runtime plugin that resolves remotes from [Harmoniq](https://github.com/TrivioQ/Harmoniq).

Keep calling `loadRemote()` as you do today. The plugin looks up each remote's current URL and integrity hash in the Harmoniq manifest at request time, so the host never needs a rebuild to pick up a deploy, rollback, canary or kill switch.

## What it does

- **Resolves remote entries at runtime.** A remote's `entry` is replaced with the URL from the manifest just before it is requested.
- **Hot-swaps on deploy or rollback.** When a new manifest arrives (polling is configured on the client), remotes whose URL changed are re-registered, so the next load fetches the new version.
- **Verifies integrity.** Remote entry scripts are injected with the SRI hash Harmoniq holds for them.
- **Honours the kill switch.** A disabled module throws a clear error, so your error boundary renders its fallback.
- **Reports module health.** The first load of each remote (time, or the error) is sent through the client for health dashboards, canary comparisons and alerts.

## Install

```bash
npm install @harmoniq/mf-plugin @harmoniq/client
```

Peer dependencies: `@harmoniq/client` and `@module-federation/runtime` (`>=0.8.0`, or `@module-federation/enhanced`, which includes it).

## Usage

```ts
import { init, loadRemote } from '@module-federation/enhanced/runtime';
import { HarmoniqClient } from '@harmoniq/client';
import { harmoniqPlugin } from '@harmoniq/mf-plugin';

const client = new HarmoniqClient({
  registryUrl: 'https://registry.acme.dev',
  workspaceSlug: 'acme-corp',
  hostApp: 'consumer-portal',
  environment: 'production',
  pollIntervalMs: 30_000, // enables hot-swap on deploy and rollback
  reportHealth: true, // let the plugin report load outcomes
});

init({
  name: 'host',
  remotes: [], // no URLs baked into the build
  plugins: [harmoniqPlugin(client)],
});

const { default: Checkout } = (await loadRemote('checkout/Checkout'))!;
```

The plugin calls `client.init()` itself on the first request, so you do not have to await it before calling `loadRemote()`.

### Remote and module names differ

By default a remote named `checkout` uses the Harmoniq module `checkout`. Map names when they differ:

```ts
harmoniqPlugin(client, {
  remoteNames: { checkout_app: 'checkout' }, // MF remote name → Harmoniq module name
});
```

### Strict mode

Refuse remotes that are not in the manifest, instead of falling back to the remote's static configuration:

```ts
harmoniqPlugin(client, { strict: true });
```

### Declaring remotes from the manifest

`harmoniqRemotes()` builds the `remotes` array from an already-loaded client, for hosts that prefer to register every remote up front:

```ts
import { harmoniqPlugin, harmoniqRemotes } from '@harmoniq/mf-plugin';

await client.init();
init({
  name: 'host',
  remotes: harmoniqRemotes(client),
  plugins: [harmoniqPlugin(client)],
});
```

## Options

| Option        | Type                     | Default | Description                                                                                                         |
| ------------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `remoteNames` | `Record<string, string>` | `{}`    | Module Federation remote name → Harmoniq module name, when they differ.                                             |
| `strict`      | `boolean`                | `false` | Throw for remotes missing from the manifest instead of using their static configuration.                            |
| `reportLoads` | `boolean`                | `true`  | Report each remote's first load through `client.reportModuleLoad`. Only sent when the client has `reportHealth` on. |

## Handling a disabled remote

When the kill switch is on, `loadRemote()` rejects with `[harmoniq] Remote "checkout" is disabled: <reason>`. Catch it where you render the remote:

```ts
try {
  const mod = await loadRemote('checkout/Checkout');
  // render mod
} catch (error) {
  // show a fallback UI; the module is switched off or failed to load
}
```

## Related packages

- [`@harmoniq/client`](../client): the SDK this plugin is built on (manifest fetching, polling, canary assignment).
- [`@harmoniq/build-plugin`](../build-plugin): registers the remote with Harmoniq when it is built.
- [`@harmoniq/cli`](../cli): deploy, promote and roll back from CI or a terminal.

## License

Apache-2.0
