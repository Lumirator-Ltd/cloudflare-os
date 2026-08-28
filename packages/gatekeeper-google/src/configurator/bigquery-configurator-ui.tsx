import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { BigQueryConfiguratorRpc, BigQueryConfiguratorValues } from "./bigquery-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.projectId === "string" && values.projectId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const [projectId, datasetId, tableId] = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const values: { projectId?: string; datasetId?: string; tableId?: string } = {};
    if (projectId) values.projectId = decodeURIComponent(projectId);
    if (datasetId) values.datasetId = decodeURIComponent(datasetId);
    if (tableId) values.tableId = decodeURIComponent(tableId);
    return values;
  },

  resourceUrl({ values }) {
    const path = [values.projectId, values.datasetId, values.tableId]
      .filter((value): value is string => !!value)
      .map(encodeURIComponent)
      .join("/");
    return `https://bigquery.googleapis.com/${path}${values.datasetId ? "" : "/"}`;
  },

  render({ values, setValues, clearFields, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Project", ja: "プロジェクト" })} description={localize(language, { en: "Start with the Google Cloud project this connection can query.", ja: "まず、この接続が照会できる Google Cloud プロジェクトを選択します。" })}>
        <Autocomplete
          name="projectId"
          value={values.projectId}
          placeholder={localize(language, { en: "Search projects...", ja: "プロジェクトを検索..." })}
          loadOptions={query => ui.listProjects(query)}
          onChange={projectId => {
            clearFields("datasetId", "tableId");
            setValues({ projectId, datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label={localize(language, { en: "Dataset", ja: "データセット" })} description={localize(language, { en: "Leave blank to allow all datasets in the project.", ja: "空欄にすると、プロジェクト内のすべてのデータセットを許可します。" })} optional>
        <Autocomplete
          name="datasetId"
          value={values.datasetId}
          placeholder={values.projectId ? localize(language, { en: "Search datasets...", ja: "データセットを検索..." }) : localize(language, { en: "Choose a project first", ja: "先にプロジェクトを選択" })}
          disabled={!values.projectId}
          loadOptions={query => values.projectId ? ui.listDatasets(values.projectId, query) : Promise.resolve([])}
          onChange={datasetId => {
            clearFields("tableId");
            setValues({ datasetId, tableId: null });
          }}
          optional
          onClear={() => {
            clearFields("datasetId", "tableId");
            setValues({ datasetId: null, tableId: null });
          }}
        />
      </Field>

      <Field label={localize(language, { en: "Table", ja: "テーブル" })} description={localize(language, { en: "Leave blank to allow all tables in dataset.", ja: "空欄にすると、データセット内のすべてのテーブルを許可します。" })} optional>
        <Autocomplete
          name="tableId"
          value={values.tableId}
          placeholder={values.datasetId ? localize(language, { en: "Search tables...", ja: "テーブルを検索..." }) : localize(language, { en: "Choose a dataset first", ja: "先にデータセットを選択" })}
          disabled={!values.projectId || !values.datasetId}
          loadOptions={query => values.projectId && values.datasetId
            ? ui.listTables(values.projectId, values.datasetId, query)
            : Promise.resolve([])}
          onChange={tableId => setValues({ tableId })}
          optional
          onClear={() => {
            clearFields("tableId");
            setValues({ tableId: null });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BigQueryConfiguratorRpc, BigQueryConfiguratorValues>;
