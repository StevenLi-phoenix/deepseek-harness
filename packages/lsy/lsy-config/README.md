---
description: "An All settings card any Settings section can embed: every Config field of one or more plugin entries with the layer that set it, staged edits, a review before one save to the owner's patch, and a reload that waits for the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-config

English | [中文](README.zh.md)

## Summary

Change any setting of a plugin from the page that already shows it, without editing the patch file over SSH. The **All settings** card lists every configuration field of a plugin entry, grouped as its schema nests them, each with the value in force and the layer that set it: default, bundle, your own patch, or the home patch. Edits are staged; **Save** reviews the changes and **Confirm save** writes once to your own patch and reloads the plugin. Home-patch fields are read-only and credentials show only whether they are set.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row next to the Web bundles; the lsy event bundle mounts it. It needs the settings shell and, on the Host, the `connection` service and the profile's configuration editor, all of which the Web bundles compose. The package has no configuration.

```yaml
- id: lsy-config
  name: '@deepseek-ai/dsh-lsy-config'
```

### Put the card in a Settings section

The card is the Component Factory `settings.plugin-config`. A section renders it for the plugin entry ids (`id` in the profile patch) it owns, at the foot of its page:

```tsx
// Type-only: declares the 'settings.plugin-config' factory.
import type {} from '@deepseek-ai/dsh-lsy-config/client'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'

// The section's props gain the factory renderer (optional, so a test without it still renders):
export type MySectionProps = /* … */ & Partial<PropsRenderFactories>

// In the section's JSX, last child:
{renderFactorySlot?.('settings.plugin-config', { entries: ['lsy-qq', 'lsy-qq-login'] })}
```

Props:

| Prop | Meaning |
|---|---|
| `entries` | `readonly string[]`, one to sixteen entry ids |
| `exclude` | Optional dotted field paths (`groups`, `media.images`; a group excludes everything below it) that the card neither shows nor writes, for fields a dedicated editor on the same page owns |
| `reloadWarning` | Optional localized text shown in the review before a save that reloads the plugin |

Add the package to the section package's `devDependencies` (`"@deepseek-ai/dsh-lsy-config": "workspace:*"`) and a reference to `../lsy-config/tsconfig.client.json` in its `tsconfig.client.json`. The import is type-only, so the browser bundles stay separate. Where this package is not loaded the call renders nothing, and an id the Host does not run (or whose plugin has no fields) shows nothing, so a section can name entries that only some deployments compose.

A section with a dedicated editor of some fields passes `exclude`, for example the QQ page:

```tsx
{renderFactorySlot?.('settings.plugin-config', {
  entries: ['lsy-qq'],
  exclude: ['groups'],
  reloadWarning: t('config.reloadWarning'),
})}
```

An excluded field is left as it is stored when the card saves, and the dedicated editor changing it after the card was read does not make the card's save stale (the revision ignores excluded fields). A change to any other field still does. Both the card and the upstream settings forms write through `ctx.configEditor.edit`, which runs one write at a time and is revision-fenced on each side, so whichever writes second after the other changed the entry is rejected and re-reads instead of overwriting.

### What the card shows

Each entry is a collapsible block with its field count and how many fields your patch changes. Inside, the schema's nested objects are collapsible groups (open when one of their fields is changed). Each field row shows:

| Part | Meaning |
|---|---|
| Label | The field name; the full path is its tooltip |
| Layer tag | **Default**: no layer sets it, the schema default applies. **Built in**: the plugin bundle sets it. **My patch**: your own patch sets it away from the bundle. **Home patch**: the home patch sets the whole entry |
| **Reset** | Only on a field your patch changed: stage a return to the bundle's value (or to the default where the bundle sets nothing) |
| Control | A text box, number box, switch, choice list, one-per-line list, or JSON box by the field's type |
| Notes | The schema's description when it has one, the default, and why a field is read-only |

Saving restates the whole config of the entry in your patch, because a patch entry's `config` replaces the bundle's entire config; only the fields you edited differ from what was shown. When every field is back to the bundle's values, your patch's entry is removed.

Read-only fields: an entry the home patch sets (change the home patch instead), a field given by a `!!js` expression (edit it in the patch file), and credential fields (`role('secret')`). A credential reference such as `tokenEnv` is only a variable name, so it is editable and the card never reads the variable's value.

### Saving

1. Edit fields. Nothing is written yet and nothing is saved on its own: not on typing, not on leaving a field, not after a wait. A value a field does not accept is marked and blocks **Save**.
2. **Save** lists each change (`field: old → new`) and says which plugin will reload, followed by the section's `reloadWarning` when the save reloads the plugin.
3. **Confirm save** sends all edits at once. The form shows **Reloading…** until the new plugin instance answers with the saved revision, keeps what it showed meanwhile, and then says **Saved**. If the plugin does not answer within about 30 seconds the form says so and offers **Retry**.
4. A field the schema marks `volatile` applies to the running plugin without a reload; the review says so, and a save that changes only such fields neither shows the warning nor waits for a reload.
5. A refusal is named: the configuration changed since the form was read (it is read again), the home patch sets the entry, or the plugin rejected the values. Nothing is written in those cases.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

**Why not the upstream settings forms.** Upstream's plugin-settings seam (`settings.describe` and `mutate`, behind `ctx.configForms`) serves only the fields a schema marks `volatile`, because those apply without remounting the plugin. A plugin marks only some fields (`lsy-qq` marks its recorded groups and most limits, not the connection, sending, digest, or login settings), so the rest are out of its reach. This package reads the whole schema and writes through the same save path upstream uses, `ctx.configEditor.edit`, which validates the next config against the schema, writes the owner's patch atomically, and reloads the plugin. It reuses the shared form chrome (`SettingsForm`, `Switch`, `Tag`) from `ui-primitives`.

**Host half.** `GET /api/lsy.config?entries=a,b&exclude=x,y.z` answers, for each running entry, a tree built from the entry's live Config schema and its stored layers (`src/fields.ts`): groups for nested objects and leaves of kind `string`, `credential-ref`, `number`, `boolean`, `select`, `string-list`, `json` (any other shape), or `secret`. A leaf carries the value in force, the schema default, the layer that set it, and the bundle's value where your patch changed it. The layer is a comparison of the config in force with the config the bundle layer alone gives (`ctx.configEditor.configuration()`), and the home patch is detected when the config in force equals neither your patch's nor the bundle's. Credential leaves carry only `set`. `POST /api/lsy.config` takes `{ id, revision, ops, exclude }` with ops `set`, `unset` (back to the bundle's value) and `clear` (remove the field, so the schema default applies). It checks the `revision` (a hash of the config in force and the bundle's, without the excluded fields), applies the ops to the config in force (`src/edit.ts`), refuses credential fields, excluded fields, unknown paths, groups, and fields under a `!!js` expression, and hands the result to `configEditor.edit`. A save that changes nothing writes nothing and reloads nothing, and the answer says `reload: false` when every changed field is `volatile`: the Loader applies those to the running plugin and the plugin is not re-applied. Both routes sit under `/api`, so the connection's sign-in check guards them.

**Logging.** Each save logs `lsy-config: saved <entry> changed=[paths] reload=<bool> outcome=ok in <ms>ms`, or `save of <entry> edits=[paths] outcome=<reason> in <ms>ms` when refused. Only entry ids and field paths are logged, never values. The browser logs the same facts to the console.

**Browser half.** The package registers the factory with `ctx.slots.registerFactory`, so any section reaches it with `renderFactorySlot` and a type-only import; this keeps the client bundle purity gate satisfied and leaves the section unchanged when the package is absent. `ConfigLoader` (`src/client/store.ts`) holds each entry's last description and phase (`loading`, `ready`, `saving`, `reloading`, `unreachable`), and after a save waits for the plugin by reading the entry until it answers with the saved revision. A save whose answer is lost, which happens when the Host reloads, counts as landed when the revision has moved. `src/client/model.ts` holds the drafts, parsing, and the review lines as pure functions.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: the `/api/lsy.config` routes, request checks, logging |
| [`src/fields.ts`](src/fields.ts) | Config schema and stored layers to the form tree |
| [`src/edit.ts`](src/edit.ts) | A save's edits to the next stored config; the revision |
| [`src/view.ts`](src/view.ts) | Route, form, and save types shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the loader, the factory registration |
| [`src/client/slot-contract.ts`](src/client/slot-contract.ts) | The `settings.plugin-config` factory declaration |
| [`src/client/store.ts`](src/client/store.ts) | Store and loader: read, save, wait for the reload |
| [`src/client/model.ts`](src/client/model.ts) | Drafts, parsing, the plan and review of a save |
| [`src/client/PluginConfigCard.tsx`](src/client/PluginConfigCard.tsx) | The card |

This is a fork-local package; the upstream files it touches are listed in [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Settings domain](../../client/ui-settings/README.md) — the settings shell and the upstream plugin-settings forms for `volatile` fields
- [Slots](../../client/ui-slots/README.md) — Component Factories, the way a section reaches this card
- [Config editor](../../boot/config-editor/README.md) — the save path and its patch layering
- [lsy-sysmon](../lsy-sysmon/README.md) and [bili](../bili/README.md) — sections that embed the card

-----

<a id="model-experience"></a>
## Model Experience

None, as the card is browser chrome over configuration; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request. Saving a plugin's configuration reloads that plugin, which can change what a later request contains, but the card itself adds nothing to one.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A patch entry replaces the bundle's config** — the first save of an entry copies the bundle's current values into your patch, so a later change to the bundle's defaults does not reach that entry until every field is reset to the bundle's values (which removes your entry).
- **Credentials are not edited here** — fields with `role('secret')` stay in `.env` or the credential store. A secret written literally in the bundle is copied into your patch by the first save, because the config is restated whole.
- **Descriptions only where the schema has them** — a field shows the schema's `description`; a plugin whose schema has none shows the field name and its default.
- **Other shapes edit as JSON** — maps, tuples, unions of unlike types, and lists of objects are edited as JSON text.
- **Entries inside nested includes** are not addressable by the configuration editor and show nothing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The `lsy-qq` form fixture (`tests/qq-form.client.ts`) is generated: after a change to that schema run `UPDATE_QQ_FORM=1 pnpm exec vitest run packages/lsy/lsy-config/tests/schemas.spec.ts`, then `pnpm exec tsx scripts/run-oxlint.ts --fix packages/lsy/lsy-config`.
- A per-field restore of "my patch" values without restating the bundle would need a loader change upstream; the replace-the-whole-config rule is why a save restates everything.

</details>
