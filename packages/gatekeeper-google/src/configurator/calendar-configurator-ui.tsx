import { localize, Autocomplete, Field, h, RadioCards, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { CalendarConfiguratorRpc, CalendarConfiguratorValues } from "./calendar-configurator-types";

export default {
  initial: { availabilityMode: "thisCalendar" },

  isReady({ values }) {
    return typeof values.calendarId === "string" && values.calendarId.length > 0;
  },

  resourceUrl({ values }) {
    const calendarId = encodeURIComponent(values.calendarId ?? "");
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return `https://calendar.google.com/calendar/${calendarId}/?availability=${availabilityMode}`;
  },

  render({ values, setValues, ui, language }) {
    const availabilityMode = values.availabilityMode === "allVisible" ? "allVisible" : "thisCalendar";
    return <Section>
      <Field label={localize(language, { en: "Calendar", ja: "カレンダー" })} description={localize(language, { en: "Choose the calendar this connection can read and manage.", ja: "この接続が読み取り、管理できるカレンダーを選択します。" })}>
        <Autocomplete
          name="calendarId"
          value={values.calendarId}
          placeholder={localize(language, { en: "Search calendars...", ja: "カレンダーを検索..." })}
          loadOptions={query => ui.listCalendars(query)}
          onChange={calendarId => setValues({ calendarId })}
        />
      </Field>

      <Field
        label={localize(language, { en: "Availability lookup", ja: "空き時間の照会" })}
        description={localize(language, { en: "Free/busy checks show only busy/free blocks, never event details.", ja: "予定あり／空きの確認では時間枠のみが表示され、予定の詳細は表示されません。" })}
      >
        <RadioCards
          value={availabilityMode}
          options={[
            {
              value: "thisCalendar",
              title: localize(language, { en: "This calendar only", ja: "このカレンダーのみ" }),
              description: localize(language, { en: "Check availability for this calendar only.", ja: "このカレンダーのみ空き時間を確認します。" }),
            },
            {
              value: "allVisible",
              title: localize(language, { en: "All calendars visible to me", ja: "自分に表示されるすべてのカレンダー" }),
              description: localize(language, { en: "Check anyone visible to your account. Collaborators must also be able to see their availability.", ja: "アカウントに表示される全員の空き時間を確認します。共同編集者にも空き時間を表示する権限が必要です。" }),
            },
          ]}
          onChange={nextMode => {
            if (nextMode !== "thisCalendar" && nextMode !== "allVisible") return;
            setValues({ availabilityMode: nextMode });
          }}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<CalendarConfiguratorRpc, CalendarConfiguratorValues>;
