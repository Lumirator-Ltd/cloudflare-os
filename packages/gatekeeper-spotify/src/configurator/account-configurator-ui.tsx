import { localize, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SpotifyAccountConfiguratorRpc,
  SpotifyAccountConfiguratorValues,
} from "./account-configurator-types";

// The whole-account resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms which account is being connected
// and signals readiness. The sandboxed runtime has no effect hooks, so we render static text and
// rely on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render({ language }) {
    return <Section>
      <Field
        label={localize(language, { en: "Whole-account access", ja: "アカウント全体へのアクセス" })}
        description={localize(language, { en: "This binding grants access to the connected Spotify account: profile, catalog search, your library, your playlists, and playback control on your Spotify Connect devices.", ja: "このバインディングは、接続された Spotify アカウントのプロフィール、カタログ検索、ライブラリ、プレイリスト、Spotify Connect デバイスでの再生操作へのアクセスを許可します。" })}>
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SpotifyAccountConfiguratorRpc, SpotifyAccountConfiguratorValues>;
