import { localize,
  Autocomplete, CheckboxList, Field, h, RadioCards, Section,
  type ConfiguratorUIOption, type ConfiguratorUISpec,
} from "@gadgets/configurator-ui";
import type {
  McpServerConfiguratorRpc,
  McpServerConfiguratorValues,
} from "./server-configurator-types";

let pendingServers: Promise<ConfiguratorUIOption[]> | null = null;
let loadedServers: ConfiguratorUIOption[] | null = null;

function serverOptions(ui: McpServerConfiguratorRpc): Promise<ConfiguratorUIOption[]> {
  pendingServers ??= (async () => {
    loadedServers = await ui.listServerOptions();
    return loadedServers;
  })();
  return pendingServers;
}

async function loadServerOptions(
  ui: McpServerConfiguratorRpc,
  query = "",
): Promise<ConfiguratorUIOption[]> {
  const servers = await serverOptions(ui);
  const needle = query.trim().toLowerCase();
  return needle
    ? servers.filter(server =>
        server.value.toLowerCase().includes(needle) || server.title.toLowerCase().includes(needle))
    : servers;
}

export default {
  initial: { server: null, mode: "all", tools: null, endpointKind: "unknown" },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const params = new URLSearchParams(new URL(resourceUrl).hash.slice(1));
    const selected = params.getAll("tool").map(name => name.trim()).filter(Boolean)
      .map(encodeURIComponent);
    const server = params.get("server")?.trim() || null;
    return {
      server,
      mode: params.has("tool") ? "choose" : "all",
      tools: selected.length > 0 ? selected.join(",") : null,
      endpointKind: server ? "portal" : "unknown",
    };
  },

  isReady({ values }) {
    if (values.endpointKind === "unavailable" || !values.server) return false;
    return values.mode === "all"
      || (values.tools ?? "").split(",").some(name => name.trim().length > 0);
  },

  async resourceUrl({ values, ui, language }) {
    if (!values.server) {
      throw new Error(localize(language, {
        en: "Choose a server behind this portal before adding it.",
        ja: "追加する前に、このポータルの背後にあるサーバーを選択してください。",
      }));
    }
    const endpoint = await ui.getEndpoint();
    const params = new URLSearchParams({ server: values.server });
    if (values.mode !== "all") {
      const selected = (values.tools ?? "").split(",").map(name => name.trim()).filter(Boolean)
        .map(decodeURIComponent);
      for (const tool of selected) params.append("tool", tool);
      if (selected.length === 0) params.append("tool", "");
    }
    return `${endpoint}#${params}`;
  },

  render({ values, setValues, ui, language }) {
    if (values.endpointKind === "unknown") {
      void serverOptions(ui).then(
        servers => setValues({
          endpointKind: "portal",
          server: servers.length === 1 ? servers[0].value : values.server,
        }),
        () => setValues({ endpointKind: "unavailable" }),
      );
    }

    if (values.endpointKind === "unavailable") {
      return <Section>
        <Field
          label={localize(language, { en: "Server", ja: "サーバー" })}
          description={
            localize(language, { en: "Could not reach the portal to list the servers behind it, so there is nothing to ", ja: "ポータルに接続して背後のサーバー一覧を取得できなかったため、" }) +
            localize(language, { en: "grant yet. Close this and try again; if it keeps happening, ask an administrator to ", ja: "現時点では許可できるものがありません。閉じて再試行してください。問題が続く場合は、管理者に" }) +
            localize(language, { en: "check the portal configuration.", ja: "ポータル設定の確認を依頼してください。" })
          }
        />
      </Section>;
    }

    const soleServer = loadedServers?.length === 1 ? loadedServers[0] : null;
    const mode = values.mode === "choose" ? "choose" : "all";
    const toolsReady = Boolean(values.server);
    const serverKey = values.server ?? "";
    const selectedCount = (values.tools ?? "").split(",").filter(Boolean).length;

    return <Section>
      {!soleServer && <Field
        label={localize(language, { en: "Server", ja: "サーバー" })}
        description={localize(language, { en: "Which server behind this portal to grant. Its tools appear next.", ja: "このポータルの背後にある、アクセスを許可するサーバーを選択します。次にツールが表示されます。" })}
      >
        <Autocomplete
          name="server"
          value={values.server}
          placeholder={localize(language, { en: "Search servers behind this portal...", ja: "ポータルの背後にあるサーバーを検索..." })}
          loadOptions={query => loadServerOptions(ui, query)}
          onChange={server => setValues({ server, tools: null })}
          onClear={() => setValues({ server: null, tools: null })}
        />
      </Field>}

      {toolsReady && <Field
        label={soleServer
          ? localize(language, {
              en: `Tools · ${soleServer.title}`,
              ja: `ツール · ${soleServer.title}`,
            })
          : localize(language, { en: "Tools", ja: "ツール" })}
        description={localize(language, { en: "Choose how much of this server this connection may call.", ja: "この接続が呼び出せるサーバーのツール範囲を選択します。" })}
      >
        <RadioCards
          value={mode}
          options={[
            {
              value: "all",
              title: localize(language, { en: "All tools", ja: "すべてのツール" }),
              description: localize(language, { en: "Every tool this server offers, including ones it adds later.", ja: "このサーバーが提供するすべてのツール（今後追加されるものを含む）。" }),
            },
            {
              value: "choose",
              title: localize(language, { en: "Choose tools", ja: "ツールを選択" }),
              description:
                localize(language, { en: "Only the tools you tick. Anything else is refused, including tools added later.", ja: "チェックしたツールのみ。今後追加されるツールを含め、それ以外は拒否されます。" }),
            },
          ]}
          onChange={next => setValues({ mode: next })}
        />
      </Field>}

      {toolsReady && <Field
        label={localize(language, { en: "Allowed tools", ja: "許可するツール" })}
        description={mode === "all"
          ? localize(language, { en: "Read-only tools return data straight away; the rest queue for your approval.", ja: "読み取り専用ツールはすぐにデータを返し、それ以外は承認待ちになります。" })
          : selectedCount > 0
            ? localize(language, {
                en: `${selectedCount} selected. Read-only tools return data straight away; the rest queue for your approval.`,
                ja: `${selectedCount} 件を選択。読み取り専用ツールはすぐにデータを返し、それ以外は承認待ちになります。`,
              })
            : localize(language, { en: "Tick at least one tool to grant anything.", ja: "許可するツールを 1 つ以上チェックしてください。" })}
      >
        <CheckboxList
          name={`tools:${serverKey}`}
          value={values.tools}
          loadOptions={async () => (await ui.listToolOptions(values.server ?? undefined))
            .map(option => ({ ...option, value: encodeURIComponent(option.value) }))}
          allSelected={mode === "all"}
          disabled={mode === "all"}
          onChange={tools => setValues({ tools })}
        />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<McpServerConfiguratorRpc, McpServerConfiguratorValues>;
