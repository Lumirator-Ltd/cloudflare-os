import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  LanguagePreference,
  SupportedLanguage,
} from "@gadgets/workshop-shared/api";
import { useOptionalAuthenticatedApi } from "../AuthContext";
import { useServerConfig } from "../ServerConfigContext";
import i18n from "./config";
import { resolveLanguage } from "./locale";

interface LanguageContextValue {
  preference: LanguagePreference;
  effectiveLanguage: SupportedLanguage;
  deploymentDefault: SupportedLanguage;
  loading: boolean;
  setPreference: (preference: LanguagePreference) => Promise<void>;
}

interface LanguageProviderProps {
  children: ReactNode;
  authenticatedApi?: RpcStub<AuthenticatedApi> | null;
}

interface PreferenceState {
  owner: RpcStub<AuthenticatedApi> | null;
  preference: LanguagePreference;
  loading: boolean;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children, authenticatedApi }: LanguageProviderProps) {
  const auth = useOptionalAuthenticatedApi();
  const api = authenticatedApi === undefined ? auth?.authenticatedApi ?? null : authenticatedApi;
  const deploymentDefault = useServerConfig()?.defaultLanguage ?? "en";
  const [state, setState] = useState<PreferenceState>({
    owner: null,
    preference: "auto",
    loading: api !== null,
  });
  const requestGeneration = useRef(0);
  const currentApi = useRef(api);
  currentApi.current = api;

  const ownsPreference = state.owner === api;
  const preference = ownsPreference ? state.preference : "auto";
  const loading = api !== null && (!ownsPreference || state.loading);
  const effectiveLanguage = resolveLanguage(preference, deploymentDefault);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (!api) {
      setState({ owner: null, preference: "auto", loading: false });
      return;
    }

    setState({ owner: api, preference: "auto", loading: true });
    api.getLanguagePreference().then((savedPreference) => {
      if (requestGeneration.current === generation && currentApi.current === api) {
        setState({ owner: api, preference: savedPreference, loading: false });
      }
    }).catch(() => {
      if (requestGeneration.current === generation && currentApi.current === api) {
        setState({ owner: api, preference: "auto", loading: false });
      }
    });
  }, [api]);

  useEffect(() => {
    document.documentElement.lang = effectiveLanguage;
    void i18n.changeLanguage(effectiveLanguage);
  }, [effectiveLanguage]);

  const setPreference = useCallback(async (nextPreference: LanguagePreference) => {
    const owner = currentApi.current;
    if (!owner) throw new Error("Language preferences require authentication");

    const generation = ++requestGeneration.current;
    setState((current) => current.owner === owner ? { ...current, loading: true } : current);
    try {
      await owner.setLanguagePreference(nextPreference);
      if (currentApi.current === owner && requestGeneration.current === generation) {
        setState({ owner, preference: nextPreference, loading: false });
      }
    } catch (error) {
      if (currentApi.current === owner && requestGeneration.current === generation) {
        setState((current) => current.owner === owner ? { ...current, loading: false } : current);
      }
      throw error;
    }
  }, []);

  const value = useMemo<LanguageContextValue>(() => ({
    preference,
    effectiveLanguage,
    deploymentDefault,
    loading,
    setPreference,
  }), [preference, effectiveLanguage, deploymentDefault, loading, setPreference]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within a LanguageProvider");
  return context;
}
