import { localize, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ZoomInfoAccountConfiguratorRpc,
  ZoomInfoAccountConfiguratorValues,
} from "./account-configurator-types";

// The whole-account resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms which account is being connected and
// signals readiness. The sandboxed runtime has no effect hooks, so we render static text and rely
// on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

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
        description={localize(language, { en: "This binding grants access to the connected ZoomInfo account: lookup, company/contact/intent/scoop/news search, record enrichment (which consumes credits), recommendations, and account intelligence — all subject to the account's ZoomInfo entitlements.", ja: "このバインディングは、接続された ZoomInfo アカウントの検索、会社／連絡先／インテント／スクープ／ニュース検索、レコード補完（クレジットを消費）、レコメンデーション、アカウントインテリジェンスへのアクセスを、ZoomInfo の契約権限の範囲内で許可します。" })}>
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<ZoomInfoAccountConfiguratorRpc, ZoomInfoAccountConfiguratorValues>;
