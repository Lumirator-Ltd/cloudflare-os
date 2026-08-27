import { localize, Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  SpotifyPlaylistConfiguratorRpc,
  SpotifyPlaylistConfiguratorValues,
} from "./playlist-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.playlistId === "string" && values.playlistId.length > 0;
  },

  resourceUrl({ values }) {
    return `https://open.spotify.com/playlist/${values.playlistId}`;
  },

  render({ values, setValues, ui, language }) {
    return <Section>
      <Field label={localize(language, { en: "Playlist", ja: "プレイリスト" })} description={localize(language, { en: "Search your playlists, or paste a Spotify playlist URL or link.", ja: "プレイリストを検索するか、Spotify プレイリストの URL またはリンクを貼り付けます。" })}>
        <Autocomplete
          name="playlistId"
          value={values.playlistId}
          placeholder={localize(language, { en: "Search playlists or paste a URL...", ja: "プレイリストを検索または URL を貼り付け..." })}
          loadOptions={query => ui.listPlaylists(query)}
          onChange={playlistId => setValues({ playlistId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<SpotifyPlaylistConfiguratorRpc, SpotifyPlaylistConfiguratorValues>;
