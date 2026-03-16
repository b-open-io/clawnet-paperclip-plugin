import { useState, useEffect, type CSSProperties, type FormEvent } from "react";
import {
  usePluginData,
  usePluginAction,
  usePluginToast,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Plugin identity — must match manifest.id
// ---------------------------------------------------------------------------

const PLUGIN_ID = "bopen-io.clawnet-plugin";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

type ClawNetConfig = {
  clawnetApiUrl: string;
  syncIntervalMinutes: number;
};

type SyncStatusData = {
  lastSyncAt: string | null;
  agentCount: number;
  skillCount: number;
  status: "idle" | "syncing" | "error";
  error: string | null;
};

const DEFAULT_CONFIG: ClawNetConfig = {
  clawnetApiUrl: "https://clawnet.sh",
  syncIntervalMinutes: 15,
};

// ---------------------------------------------------------------------------
// Styles (host CSS variable tokens, matching kitchen sink patterns)
// ---------------------------------------------------------------------------

const layoutStack: CSSProperties = {
  display: "grid",
  gap: "12px",
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "14px",
  background: "var(--card, transparent)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

const buttonStyle: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  background: "transparent",
  color: "inherit",
  padding: "6px 12px",
  fontSize: "12px",
  cursor: "pointer",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--foreground)",
  color: "var(--background)",
  borderColor: "var(--foreground)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "12px",
  boxSizing: "border-box",
};

const labelStyle: CSSProperties = {
  display: "grid",
  gap: "6px",
};

const labelTextStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 500,
};

const helpTextStyle: CSSProperties = {
  fontSize: "11px",
  opacity: 0.65,
  lineHeight: 1.45,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  marginBottom: "10px",
};

const statusDotStyle = (color: string): CSSProperties => ({
  display: "inline-block",
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  backgroundColor: color,
  flexShrink: 0,
});

// ---------------------------------------------------------------------------
// Config fetch helper (direct REST, outside the bridge — see PLUGIN_SPEC.md)
// ---------------------------------------------------------------------------

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  });
}

// ---------------------------------------------------------------------------
// useSettingsConfig — load/save config via operator REST endpoint
// ---------------------------------------------------------------------------

function useSettingsConfig() {
  const [config, setConfig] = useState<ClawNetConfig>({ ...DEFAULT_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    hostFetchJson<{ configJson?: Record<string, unknown> | null } | null>(
      `/api/plugins/${PLUGIN_ID}/config`,
    )
      .then((result) => {
        if (cancelled) return;
        const raw = result?.configJson ?? {};
        setConfig({
          clawnetApiUrl:
            typeof raw.clawnetApiUrl === "string"
              ? raw.clawnetApiUrl
              : DEFAULT_CONFIG.clawnetApiUrl,
          syncIntervalMinutes:
            typeof raw.syncIntervalMinutes === "number" &&
            Number.isFinite(raw.syncIntervalMinutes)
              ? raw.syncIntervalMinutes
              : DEFAULT_CONFIG.syncIntervalMinutes,
        });
        setError(null);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(nextConfig: ClawNetConfig) {
    setSaving(true);
    try {
      await hostFetchJson(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: nextConfig }),
      });
      setConfig(nextConfig);
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      throw nextError;
    } finally {
      setSaving(false);
    }
  }

  return { config, setConfig, loading, saving, error, save };
}

// ---------------------------------------------------------------------------
// ClawNetSettingsPage
// ---------------------------------------------------------------------------

export function ClawNetSettingsPage({ context }: PluginSettingsPageProps) {
  const { config, setConfig, loading, saving, error, save } =
    useSettingsConfig();
  const toast = usePluginToast();

  // Sync status from the worker via the bridge
  const syncStatus = usePluginData<SyncStatusData>("sync-status", {
    companyId: context.companyId,
  });

  // Actions via the bridge
  const validateConfig = usePluginAction("validate-config");
  const triggerSync = usePluginAction("trigger-sync");

  // Local UI state
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  function setField<K extends keyof ClawNetConfig>(
    key: K,
    value: ClawNetConfig[K],
  ) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      await save(config);
      toast({ title: "Settings saved", tone: "success" });
    } catch {
      toast({
        title: "Failed to save settings",
        body: error ?? "Unknown error",
        tone: "error",
      });
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    try {
      const result = (await validateConfig({
        clawnetApiUrl: config.clawnetApiUrl,
      })) as { ok: boolean; message?: string };
      if (result.ok) {
        toast({ title: "Connection successful", tone: "success" });
      } else {
        toast({
          title: "Connection failed",
          body: result.message ?? "ClawNet API did not respond",
          tone: "error",
        });
      }
    } catch (err) {
      toast({
        title: "Connection test failed",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleManualSync() {
    setSyncing(true);
    try {
      await triggerSync({ companyId: context.companyId });
      toast({ title: "Sync started", tone: "info" });
      // Refresh sync status after a brief delay to let the worker start
      setTimeout(() => syncStatus.refresh(), 2000);
    } catch (err) {
      toast({
        title: "Sync failed",
        body: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <div style={{ fontSize: "12px", opacity: 0.7 }}>
        Loading ClawNet configuration...
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "18px" }}>
      {/* Connection Settings */}
      <form onSubmit={onSubmit} style={layoutStack}>
        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <strong>ClawNet Connection</strong>
          </div>
          <div style={layoutStack}>
            <label style={labelStyle}>
              <span style={labelTextStyle}>ClawNet API URL</span>
              <input
                style={inputStyle}
                type="url"
                value={config.clawnetApiUrl}
                onChange={(e) => setField("clawnetApiUrl", e.target.value)}
                placeholder="https://clawnet.sh"
              />
              <span style={helpTextStyle}>
                The base URL for the ClawNet registry API.
              </span>
            </label>

            <label style={labelStyle}>
              <span style={labelTextStyle}>Sync Interval (minutes)</span>
              <input
                style={{ ...inputStyle, maxWidth: "120px" }}
                type="number"
                min={1}
                max={1440}
                value={config.syncIntervalMinutes}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val) && val > 0) {
                    setField("syncIntervalMinutes", val);
                  }
                }}
              />
              <span style={helpTextStyle}>
                How often to sync agents and skills from the ClawNet registry.
                Default: 15 minutes.
              </span>
            </label>
          </div>
        </section>

        {error ? (
          <div
            style={{
              color: "var(--destructive, #c00)",
              fontSize: "12px",
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={rowStyle}>
          <button type="submit" style={primaryButtonStyle} disabled={saving}>
            {saving ? "Saving..." : "Save settings"}
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={testing || !config.clawnetApiUrl}
            onClick={handleTestConnection}
          >
            {testing ? "Testing..." : "Test connection"}
          </button>
        </div>
      </form>

      {/* Sync Status */}
      <section style={cardStyle}>
        <div style={sectionHeaderStyle}>
          <strong>Sync Status</strong>
          <button
            type="button"
            style={buttonStyle}
            disabled={syncing}
            onClick={handleManualSync}
          >
            {syncing ? "Syncing..." : "Sync now"}
          </button>
        </div>
        <SyncStatusDisplay
          data={syncStatus.data}
          loading={syncStatus.loading}
          error={syncStatus.error?.message ?? null}
        />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SyncStatusDisplay sub-component
// ---------------------------------------------------------------------------

function SyncStatusDisplay({
  data,
  loading,
  error,
}: {
  data: SyncStatusData | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div style={{ fontSize: "12px", opacity: 0.7 }}>
        Loading sync status...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ fontSize: "12px", color: "var(--destructive, #c00)" }}>
        Failed to load sync status: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ fontSize: "12px", opacity: 0.7 }}>
        No sync data available. Run a sync to populate.
      </div>
    );
  }

  const statusColor =
    data.status === "idle"
      ? "#16a34a"
      : data.status === "syncing"
        ? "#2563eb"
        : "#dc2626";

  const statusLabel =
    data.status === "idle"
      ? "Idle"
      : data.status === "syncing"
        ? "Syncing..."
        : "Error";

  return (
    <div style={{ display: "grid", gap: "10px", fontSize: "12px" }}>
      <div style={rowStyle}>
        <span style={statusDotStyle(statusColor)} />
        <span>{statusLabel}</span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "10px",
        }}
      >
        <StatBlock label="Last sync" value={formatTimestamp(data.lastSyncAt)} />
        <StatBlock label="Agents" value={String(data.agentCount)} />
        <StatBlock label="Skills" value={String(data.skillCount)} />
      </div>

      {data.error ? (
        <div style={{ color: "var(--destructive, #c00)" }}>
          Last error: {data.error}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatBlock sub-component
// ---------------------------------------------------------------------------

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gap: "2px" }}>
      <span
        style={{
          fontSize: "11px",
          opacity: 0.65,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: "13px", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "Invalid date";
    return date.toLocaleString();
  } catch {
    return iso;
  }
}
