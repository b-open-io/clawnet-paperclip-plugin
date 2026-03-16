import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  usePluginAction,
  usePluginData,
  usePluginStream,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import type {
  PluginPageProps,
  PluginSidebarProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Stream safety — isolate usePluginStream behind an error boundary so that
// a 501 (stream bus not wired up) or any other SSE failure does not crash
// the entire plugin component. Data from usePluginData remains the primary
// source; stream data is a live overlay when available.
// ---------------------------------------------------------------------------

type SafeStreamData<T> = { events: T[]; lastEvent: T | null; connected: boolean };

const EMPTY_STREAM_DATA: SafeStreamData<never> = { events: [], lastEvent: null, connected: false };

/**
 * Error boundary that silently swallows stream-related render errors.
 * When the wrapped child (which calls usePluginStream) throws, this
 * boundary catches the error and renders nothing — the parent component
 * continues to function using usePluginData results.
 */
class StreamErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn("[clawnet] stream error caught, degrading gracefully:", error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/**
 * Generic stream connector component. Calls usePluginStream for a given
 * channel and reports results upward via a stable callback. Rendered
 * inside StreamErrorBoundary so any hook error is caught.
 */
function StreamConnector<T>({
  channel,
  companyId,
  onUpdate,
}: {
  channel: string;
  companyId: string | undefined;
  onUpdate: (data: SafeStreamData<T>) => void;
}) {
  const stream = usePluginStream<T>(channel, { companyId });

  useEffect(() => {
    onUpdate({
      events: stream.events,
      lastEvent: stream.lastEvent,
      connected: stream.connected,
    });
  }, [stream.events, stream.lastEvent, stream.connected, onUpdate]);

  return null;
}

/**
 * Hook that provides stream data safely for any channel. Returns a stable
 * empty result until the stream connector reports data, and degrades to
 * the empty result if the stream connector crashes.
 */
function useSafeStream<T>(
  channel: string,
  companyId: string | null | undefined,
): {
  streamData: SafeStreamData<T>;
  StreamConnectorElement: ReactNode;
} {
  const [streamData, setStreamData] = useState<SafeStreamData<T>>(
    EMPTY_STREAM_DATA as SafeStreamData<T>,
  );

  const handleUpdate = useCallback((data: SafeStreamData<T>) => {
    setStreamData(data);
  }, []);

  const effectiveCompanyId = companyId ?? undefined;

  const element = (
    <StreamErrorBoundary>
      <StreamConnector<T>
        channel={channel}
        companyId={effectiveCompanyId}
        onUpdate={handleUpdate}
      />
    </StreamErrorBoundary>
  );

  return { streamData, StreamConnectorElement: element };
}

// ---------------------------------------------------------------------------
// Types
//
// These are ClawNet-registry-specific shapes returned by the worker's data
// handlers, not Paperclip SDK domain types. The SDK `Agent` type (from
// `@paperclipai/plugin-sdk`) represents Paperclip agents — it is not
// re-exported on the `@paperclipai/plugin-sdk/ui` subpath.
// ---------------------------------------------------------------------------

type SyncStatus = {
  lastSyncAt: string | null;
  agentCount: number;
  skillCount: number;
};

/** A ClawNet registry agent template — distinct from the SDK's `Agent` type. */
type ClawNetAgent = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  model: string | null;
  color: string | null;
  starCount: number;
  trustScore: number | null;
  attestations: string[];
  skills: string[];
  createdAt: string;
};

type ClawNetSkill = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  category: string | null;
  starCount: number;
};

type AgentListResponse = {
  agents: ClawNetAgent[];
  total: number;
  page: number;
  limit: number;
};

type SkillListResponse = {
  skills: ClawNetSkill[];
  total: number;
};

type FleetStatusEvent = {
  agentId: string;
  status: string;
  timestamp: string;
};

type SyncProgressEvent = {
  phase: string;
  progress: number;
  message: string;
};

// ---------------------------------------------------------------------------
// Shared inline styles (following kitchen sink pattern)
// ---------------------------------------------------------------------------

const PAGE_ROUTE = "clawnet";

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

const subtleCardStyle: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--border) 75%, transparent)",
  borderRadius: "10px",
  padding: "12px",
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
};

const mutedTextStyle: CSSProperties = {
  fontSize: "12px",
  opacity: 0.72,
  lineHeight: 1.45,
};

const eyebrowStyle: CSSProperties = {
  fontSize: "11px",
  opacity: 0.65,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  marginBottom: "10px",
};

const statValueStyle: CSSProperties = {
  fontSize: "24px",
  fontWeight: 700,
  lineHeight: 1,
};

const statLabelStyle: CSSProperties = {
  fontSize: "11px",
  opacity: 0.6,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginTop: "4px",
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function hostPath(companyPrefix: string | null | undefined, suffix: string): string {
  return companyPrefix ? `/${companyPrefix}${suffix}` : suffix;
}

function pluginPagePath(companyPrefix: string | null | undefined): string {
  return hostPath(companyPrefix, `/${PAGE_ROUTE}`);
}

function relativeTime(isoString: string | null): string {
  if (!isoString) return "never";
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}...`;
}

// ---------------------------------------------------------------------------
// Small shared primitives
// ---------------------------------------------------------------------------

function Pill({ label, color }: { label: string; color?: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        borderRadius: "999px",
        border: "1px solid var(--border)",
        padding: "2px 8px",
        fontSize: "11px",
        background: color
          ? `color-mix(in srgb, ${color} 14%, transparent)`
          : undefined,
        borderColor: color
          ? `color-mix(in srgb, ${color} 40%, var(--border))`
          : undefined,
      }}
    >
      {label}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    online: "#16a34a",
    idle: "#d97706",
    offline: "#6b7280",
    error: "#dc2626",
    running: "#2563eb",
  };
  const dotColor = colorMap[status.toLowerCase()] ?? "#6b7280";
  return (
    <span
      style={{
        display: "inline-block",
        width: "7px",
        height: "7px",
        borderRadius: "50%",
        background: dotColor,
        flexShrink: 0,
      }}
      aria-label={status}
    />
  );
}

function StarCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "11px", opacity: 0.7 }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
      {count}
    </span>
  );
}

function TrustBadge({ score }: { score: number | null }) {
  if (score === null || score === undefined) return null;
  const level =
    score >= 80 ? "high" : score >= 50 ? "medium" : "low";
  const colorMap = { high: "#16a34a", medium: "#d97706", low: "#dc2626" };
  const labelMap = { high: "Trusted", medium: "Verified", low: "Unverified" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "10px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: colorMap[level],
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
      </svg>
      {labelMap[level]}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "32px 16px",
        textAlign: "center",
        fontSize: "13px",
        opacity: 0.55,
      }}
    >
      {message}
    </div>
  );
}

function LoadingIndicator({ message }: { message?: string }) {
  return (
    <div
      style={{
        padding: "24px 16px",
        textAlign: "center",
        fontSize: "12px",
        opacity: 0.6,
      }}
    >
      {message ?? "Loading..."}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        ...subtleCardStyle,
        borderColor: "color-mix(in srgb, #dc2626 45%, var(--border))",
        fontSize: "12px",
        color: "var(--destructive, #dc2626)",
      }}
    >
      {message}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <strong>{title}</strong>
        {action}
      </div>
      <div style={layoutStack}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 1. DashboardWidget
// ---------------------------------------------------------------------------

/**
 * Compact fleet status widget for the main Paperclip dashboard.
 *
 * Shows agent count, skill count, online count, and last sync time.
 * Subscribes to fleet-status for live status updates.
 * Provides a manual "Sync Now" button with toast feedback.
 */
export function ClawNetFleetWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId;
  const toast = usePluginToast();

  const syncParams = useMemo(
    () => (companyId ? { companyId } : {}),
    [companyId],
  );
  const { data: syncStatus, loading, error, refresh } = usePluginData<SyncStatus>(
    "sync-status",
    syncParams,
  );

  const { streamData: fleetStream, StreamConnectorElement: fleetStreamEl } =
    useSafeStream<FleetStatusEvent>("clawnet:fleet-status", companyId);

  const triggerSync = usePluginAction("trigger-sync");
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    if (!companyId || syncing) return;
    setSyncing(true);
    try {
      await triggerSync({ companyId });
      refresh();
      toast({
        title: "ClawNet sync started",
        body: "Agents and skills are being refreshed from the registry.",
        tone: "success",
      });
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

  // Derive live online count from the fleet stream event history
  const onlineCount = useMemo(() => {
    const latestByAgent = new Map<string, string>();
    for (const event of fleetStream.events) {
      latestByAgent.set(event.agentId, event.status);
    }
    let count = 0;
    for (const status of latestByAgent.values()) {
      if (status === "online" || status === "running") count++;
    }
    return count;
  }, [fleetStream.events]);

  if (loading) return <LoadingIndicator message="Loading fleet status..." />;
  if (error) return <ErrorBanner message={error.message} />;

  return (
    <div style={layoutStack}>
      {fleetStreamEl}
      <div style={rowStyle}>
        <strong>ClawNet Fleet</strong>
        {fleetStream.connected ? (
          <StatusDot status="online" />
        ) : null}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: "8px",
        }}
      >
        <div>
          <div style={statValueStyle}>{syncStatus?.agentCount ?? 0}</div>
          <div style={statLabelStyle}>Agents</div>
        </div>
        <div>
          <div style={statValueStyle}>{syncStatus?.skillCount ?? 0}</div>
          <div style={statLabelStyle}>Skills</div>
        </div>
        <div>
          <div style={statValueStyle}>{onlineCount}</div>
          <div style={statLabelStyle}>Online</div>
        </div>
      </div>

      <div style={{ ...mutedTextStyle, fontSize: "11px" }}>
        Last sync: {relativeTime(syncStatus?.lastSyncAt ?? null)}
      </div>

      <div style={rowStyle}>
        <a
          href={pluginPagePath(context.companyPrefix)}
          style={{ fontSize: "12px", color: "inherit" }}
        >
          Browse marketplace
        </a>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void handleSync()}
          disabled={syncing}
        >
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. MarketplacePage
// ---------------------------------------------------------------------------

const AGENTS_PER_PAGE = 20;

type MarketplaceTab = "agents" | "skills";
type AgentDetailView = { agent: ClawNetAgent } | null;

function TabBar({
  active,
  onChange,
}: {
  active: MarketplaceTab;
  onChange: (tab: MarketplaceTab) => void;
}) {
  const tabs: { key: MarketplaceTab; label: string }[] = [
    { key: "agents", label: "Agents" },
    { key: "skills", label: "Skills" },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: "0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            borderBottom:
              active === tab.key
                ? "2px solid var(--foreground)"
                : "2px solid transparent",
            color: active === tab.key ? "var(--foreground)" : "var(--muted-foreground, inherit)",
            padding: "10px 16px",
            fontSize: "13px",
            fontWeight: active === tab.key ? 600 : 400,
            cursor: "pointer",
            transition: "color 0.15s, border-color 0.15s",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function SearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div style={{ position: "relative" }}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "10px",
          top: "50%",
          transform: "translateY(-50%)",
          opacity: 0.45,
        }}
      >
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          ...inputStyle,
          paddingLeft: "30px",
        }}
      />
    </div>
  );
}

function AgentCard({
  agent,
  onSelect,
  onHire,
}: {
  agent: ClawNetAgent;
  onSelect: () => void;
  onHire: () => void;
}) {
  const colorIndicator = agent.color ?? "var(--muted-foreground)";

  return (
    <div
      style={{
        ...subtleCardStyle,
        display: "grid",
        gap: "10px",
        cursor: "pointer",
        transition: "border-color 0.15s",
      }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      {/* Header: color dot, name, slug, stars, trust */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: "10px",
            height: "10px",
            borderRadius: "3px",
            background: colorIndicator,
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.displayName}
          </div>
          <div style={{ fontSize: "11px", opacity: 0.55 }}>
            {agent.slug}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            flexShrink: 0,
          }}
        >
          <StarCount count={agent.starCount} />
          <TrustBadge score={agent.trustScore} />
        </div>
      </div>

      {/* Description */}
      {agent.description ? (
        <div style={mutedTextStyle}>
          {truncateText(agent.description, 120)}
        </div>
      ) : null}

      {/* Footer: pills + hire button */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
          {agent.model ? <Pill label={agent.model} /> : null}
          {agent.attestations.slice(0, 2).map((att) => (
            <Pill key={att} label={att} color="#2563eb" />
          ))}
          {agent.skills.length > 0 ? (
            <Pill
              label={`${agent.skills.length} skill${agent.skills.length === 1 ? "" : "s"}`}
            />
          ) : null}
        </div>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={(e) => {
            e.stopPropagation();
            onHire();
          }}
        >
          Hire Agent
        </button>
      </div>
    </div>
  );
}

function AgentDetail({
  agent,
  onBack,
  onHire,
}: {
  agent: ClawNetAgent;
  onBack: () => void;
  onHire: () => void;
}) {
  return (
    <div style={layoutStack}>
      <div style={rowStyle}>
        <button type="button" style={buttonStyle} onClick={onBack}>
          Back
        </button>
        <strong style={{ fontSize: "16px" }}>{agent.displayName}</strong>
        <Pill label={agent.slug} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "12px",
        }}
      >
        <div style={subtleCardStyle}>
          <div style={eyebrowStyle}>Model</div>
          <div style={{ fontSize: "13px", marginTop: "4px" }}>
            {agent.model ?? "Not specified"}
          </div>
        </div>
        <div style={subtleCardStyle}>
          <div style={eyebrowStyle}>Stars</div>
          <div style={{ fontSize: "13px", marginTop: "4px" }}>
            {agent.starCount}
          </div>
        </div>
        <div style={subtleCardStyle}>
          <div style={eyebrowStyle}>Trust Score</div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
            <span style={{ fontSize: "13px" }}>
              {agent.trustScore !== null ? `${agent.trustScore}/100` : "N/A"}
            </span>
            <TrustBadge score={agent.trustScore} />
          </div>
        </div>
        <div style={subtleCardStyle}>
          <div style={eyebrowStyle}>Created</div>
          <div style={{ fontSize: "13px", marginTop: "4px" }}>
            {relativeTime(agent.createdAt)}
          </div>
        </div>
      </div>

      {agent.description ? (
        <Section title="Description">
          <div style={{ fontSize: "13px", lineHeight: 1.55 }}>
            {agent.description}
          </div>
        </Section>
      ) : null}

      {agent.attestations.length > 0 ? (
        <Section title="Attestations">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {agent.attestations.map((att) => (
              <Pill key={att} label={att} color="#2563eb" />
            ))}
          </div>
        </Section>
      ) : null}

      {agent.skills.length > 0 ? (
        <Section title="Skills">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {agent.skills.map((skill) => (
              <Pill key={skill} label={skill} />
            ))}
          </div>
        </Section>
      ) : null}

      {agent.color ? (
        <Section title="Theme Color">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span
              style={{
                display: "inline-block",
                width: "20px",
                height: "20px",
                borderRadius: "4px",
                background: agent.color,
                border: "1px solid var(--border)",
              }}
            />
            <span style={{ fontSize: "12px", fontFamily: "monospace" }}>
              {agent.color}
            </span>
          </div>
        </Section>
      ) : null}

      <div>
        <button type="button" style={primaryButtonStyle} onClick={onHire}>
          Hire This Agent
        </button>
      </div>
    </div>
  );
}

function SkillCard({ skill }: { skill: ClawNetSkill }) {
  return (
    <div style={{ ...subtleCardStyle, display: "grid", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "13px",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {skill.displayName}
          </div>
          <div style={{ fontSize: "11px", opacity: 0.55 }}>{skill.slug}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          {skill.category ? <Pill label={skill.category} /> : null}
          <StarCount count={skill.starCount} />
        </div>
      </div>
      {skill.description ? (
        <div style={mutedTextStyle}>
          {truncateText(skill.description, 140)}
        </div>
      ) : null}
    </div>
  );
}

function SyncProgressBar({
  companyId,
}: {
  companyId: string | null;
}) {
  const { streamData: syncProgress, StreamConnectorElement } =
    useSafeStream<SyncProgressEvent>("clawnet:sync-progress", companyId);

  const latest = syncProgress.lastEvent;
  if (!latest || !syncProgress.connected) {
    return <>{StreamConnectorElement}</>;
  }

  const pct = Math.min(100, Math.max(0, latest.progress));

  return (
    <>
      {StreamConnectorElement}
      <div style={{ ...subtleCardStyle, display: "grid", gap: "6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={eyebrowStyle}>{latest.phase}</span>
          <span style={{ fontSize: "11px", opacity: 0.6 }}>{pct}%</span>
        </div>
        <div
          style={{
            height: "4px",
            borderRadius: "2px",
            background: "color-mix(in srgb, var(--border) 50%, transparent)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              borderRadius: "2px",
              background: "var(--foreground)",
              transition: "width 0.3s ease",
            }}
          />
        </div>
        <div style={{ fontSize: "11px", opacity: 0.6 }}>{latest.message}</div>
      </div>
    </>
  );
}

/**
 * Full marketplace page for browsing ClawNet agents and skills.
 *
 * - Tab bar to switch between Agents and Skills views
 * - Search bar with 300ms debounce
 * - Agent cards with color, model badge, star count, trust indicators
 * - Agent detail view on click
 * - "Hire Agent" button with toast guidance to Paperclip agent creation
 * - Skill cards with category and star count
 * - Pagination via "Load more" button
 * - Live sync progress bar during registry refresh
 */
export function ClawNetMarketplacePage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const toast = usePluginToast();

  // Tab state
  const [activeTab, setActiveTab] = useState<MarketplaceTab>("agents");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [detailView, setDetailView] = useState<AgentDetailView>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Agent data
  const agentParams = useMemo(
    () =>
      companyId
        ? {
            companyId,
            search: debouncedSearch || undefined,
            page,
            limit: AGENTS_PER_PAGE,
          }
        : {},
    [companyId, debouncedSearch, page],
  );
  const {
    data: agentData,
    loading: agentsLoading,
    error: agentsError,
  } = usePluginData<AgentListResponse>("clawnet-agents", agentParams);

  // Skill data
  const skillParams = useMemo(
    () =>
      companyId
        ? { companyId, search: debouncedSearch || undefined }
        : {},
    [companyId, debouncedSearch],
  );
  const {
    data: skillData,
    loading: skillsLoading,
    error: skillsError,
  } = usePluginData<SkillListResponse>("clawnet-skills", skillParams);

  // Sync status header
  const syncParams = useMemo(
    () => (companyId ? { companyId } : {}),
    [companyId],
  );
  const { data: syncStatus, refresh: refreshSync } = usePluginData<SyncStatus>(
    "sync-status",
    syncParams,
  );

  // Manual sync action
  const triggerSync = usePluginAction("trigger-sync");
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    if (!companyId || syncing) return;
    setSyncing(true);
    try {
      await triggerSync({ companyId });
      refreshSync();
      toast({
        title: "Sync started",
        body: "Refreshing agent and skill data from ClawNet registry.",
        tone: "success",
      });
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

  function handleHireAgent(agent: ClawNetAgent) {
    // Navigate to agent creation form
    const createUrl = hostPath(
      context.companyPrefix,
      "/agents/new?adapterType=claude_local"
    );

    // Build agent details for the persistent toast
    const details = [
      `Name: ${agent.displayName}`,
      agent.model ? `Model: ${agent.model}` : null,
      agent.description
        ? `Role: ${agent.description.length > 100 ? `${agent.description.slice(0, 100)}...` : agent.description}`
        : null,
      agent.skills.length > 0
        ? `Skills: ${agent.skills.slice(0, 5).join(", ")}${agent.skills.length > 5 ? ` (+${agent.skills.length - 5} more)` : ""}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    toast({
      title: `Hiring: ${agent.displayName}`,
      body: details,
      tone: "info",
      ttlMs: 30000,
      action: {
        label: "Create Agent",
        href: createUrl,
      },
    });
  }

  // Agent detail view
  if (detailView) {
    return (
      <div style={{ ...layoutStack, maxWidth: "800px" }}>
        <AgentDetail
          agent={detailView.agent}
          onBack={() => setDetailView(null)}
          onHire={() => handleHireAgent(detailView.agent)}
        />
      </div>
    );
  }

  // No company selected
  if (!companyId) {
    return (
      <div style={layoutStack}>
        <Section title="ClawNet Marketplace">
          <EmptyState message="Select a company to browse the agent marketplace." />
        </Section>
      </div>
    );
  }

  const agents = agentData?.agents ?? [];
  const agentTotal = agentData?.total ?? 0;
  const hasMoreAgents = agents.length < agentTotal && page * AGENTS_PER_PAGE < agentTotal;

  const skills = skillData?.skills ?? [];
  const skillTotal = skillData?.total ?? 0;

  return (
    <div style={layoutStack}>
      {/* Page header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ fontSize: "18px", fontWeight: 700, margin: 0 }}>
            ClawNet Marketplace
          </h1>
          <div style={mutedTextStyle}>
            {syncStatus
              ? `${syncStatus.agentCount} agents, ${syncStatus.skillCount} skills available. Last sync: ${relativeTime(syncStatus.lastSyncAt)}`
              : "Loading registry status..."}
          </div>
        </div>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void handleSync()}
          disabled={syncing}
        >
          {syncing ? "Syncing..." : "Refresh Registry"}
        </button>
      </div>

      {/* Sync progress indicator */}
      <SyncProgressBar companyId={companyId} />

      {/* Search */}
      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder={
          activeTab === "agents"
            ? "Search agents by name, skill, or model..."
            : "Search skills by name or category..."
        }
      />

      {/* Tab bar */}
      <TabBar
        active={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          setSearch("");
          setPage(1);
        }}
      />

      {/* Agents tab content */}
      {activeTab === "agents" ? (
        <div style={layoutStack}>
          {agentsLoading && agents.length === 0 ? (
            <LoadingIndicator message="Loading agents from registry..." />
          ) : agentsError ? (
            <ErrorBanner message={agentsError.message} />
          ) : agents.length === 0 ? (
            <EmptyState
              message={
                debouncedSearch
                  ? `No agents found matching "${debouncedSearch}".`
                  : "No agents available. Try syncing the registry."
              }
            />
          ) : (
            <>
              <div style={{ fontSize: "12px", opacity: 0.6 }}>
                Showing {agents.length} of {agentTotal} agent{agentTotal === 1 ? "" : "s"}
                {debouncedSearch ? ` matching "${debouncedSearch}"` : ""}
              </div>
              <div style={{ display: "grid", gap: "10px" }}>
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onSelect={() => setDetailView({ agent })}
                    onHire={() => handleHireAgent(agent)}
                  />
                ))}
              </div>
              {hasMoreAgents ? (
                <div style={{ display: "flex", justifyContent: "center", paddingTop: "8px" }}>
                  <button
                    type="button"
                    style={buttonStyle}
                    onClick={() => setPage((p) => p + 1)}
                    disabled={agentsLoading}
                  >
                    {agentsLoading ? "Loading..." : `Load more (${agentTotal - agents.length} remaining)`}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* Skills tab content */}
      {activeTab === "skills" ? (
        <div style={layoutStack}>
          {skillsLoading ? (
            <LoadingIndicator message="Loading skills..." />
          ) : skillsError ? (
            <ErrorBanner message={skillsError.message} />
          ) : skills.length === 0 ? (
            <EmptyState
              message={
                debouncedSearch
                  ? `No skills found matching "${debouncedSearch}".`
                  : "No skills available. Try syncing the registry."
              }
            />
          ) : (
            <>
              <div style={{ fontSize: "12px", opacity: 0.6 }}>
                {skillTotal} skill{skillTotal === 1 ? "" : "s"} available
                {debouncedSearch ? ` matching "${debouncedSearch}"` : ""}
              </div>
              <div style={{ display: "grid", gap: "10px" }}>
                {skills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} />
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. SidebarEntry
// ---------------------------------------------------------------------------

/**
 * Sidebar navigation link to the ClawNet marketplace page.
 * Shows a network icon and an agent count badge from sync status.
 */
export function ClawNetSidebarLink({ context }: PluginSidebarProps) {
  const syncParams = useMemo(
    () => (context.companyId ? { companyId: context.companyId } : {}),
    [context.companyId],
  );
  const { data: syncStatus } = usePluginData<SyncStatus>("sync-status", syncParams);

  const href = pluginPagePath(context.companyPrefix);
  const isActive =
    typeof window !== "undefined" && window.location.pathname === href;

  const agentCount = syncStatus?.agentCount ?? 0;

  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        fontSize: "13px",
        fontWeight: isActive ? 600 : 400,
        textDecoration: "none",
        color: isActive ? "var(--foreground)" : "color-mix(in srgb, var(--foreground) 80%, transparent)",
        background: isActive
          ? "color-mix(in srgb, var(--accent, var(--muted)) 60%, transparent)"
          : "transparent",
        borderRadius: "6px",
        transition: "background 0.15s, color 0.15s",
        cursor: "pointer",
      }}
    >
      {/* Network/nodes icon */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <circle cx="12" cy="5" r="2.5" />
        <circle cx="5" cy="19" r="2.5" />
        <circle cx="19" cy="19" r="2.5" />
        <path d="M12 7.5v4" />
        <path d="M7.5 17.5l3-6" />
        <path d="M16.5 17.5l-3-6" />
      </svg>

      <span style={{ flex: 1 }}>ClawNet</span>

      {/* Agent count badge */}
      {agentCount > 0 ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: "20px",
            height: "18px",
            borderRadius: "999px",
            background: "color-mix(in srgb, var(--foreground) 12%, transparent)",
            fontSize: "10px",
            fontWeight: 600,
            padding: "0 5px",
            flexShrink: 0,
          }}
        >
          {agentCount}
        </span>
      ) : null}
    </a>
  );
}

// ---------------------------------------------------------------------------
// 4. Settings page (re-export from separate module)
// ---------------------------------------------------------------------------

export { ClawNetSettingsPage } from "./settings.js";
