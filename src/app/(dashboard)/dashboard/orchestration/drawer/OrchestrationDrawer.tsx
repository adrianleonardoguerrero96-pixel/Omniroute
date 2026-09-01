"use client";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { StatusDot } from "@/shared/components/flow/StatusDot";
import { orchStateColor, type OrchNode, type OrchState } from "../model/orchestrationTypes";
import { useDrawerDetail } from "./useDrawerDetail";
import type { CloudAgentTask } from "@/lib/cloudAgent/types";
import type { A2ATask } from "@/lib/a2a/taskManager";

const STATE_KEY: Record<OrchState, string> = {
  queued: "stateQueued",
  running: "stateRunning",
  waiting_approval: "stateWaitingApproval",
  succeeded: "stateSucceeded",
  failed: "stateFailed",
  cancelled: "stateCancelled",
};
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] font-semibold uppercase text-muted mb-1">{title}</div>
      {children}
    </div>
  );
}

function Timeline({ node, detail }: { node: OrchNode; detail: unknown }) {
  if (node.source === "cloud-agent") {
    const t = detail as CloudAgentTask | null;
    return (
      <ol className="text-xs flex flex-col gap-1.5">
        {(t?.activities ?? []).map((a) => (
          <li key={a.id} className="flex gap-2">
            <code className="text-[9px] shrink-0 text-muted">{a.type}</code>
            <span className="break-words">{a.content}</span>
          </li>
        ))}
      </ol>
    );
  }
  if (node.source === "a2a") {
    const t = detail as A2ATask | null;
    return (
      <ol className="text-xs flex flex-col gap-1">
        {(t?.events ?? []).map((e, i) => (
          <li key={i}>
            <code className="text-[9px] text-muted mr-1">{e.state}</code>
            {e.message ?? e.timestamp}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <pre className="text-[10px] bg-surface-muted rounded p-2 overflow-x-auto">
      {JSON.stringify(detail, null, 2)}
    </pre>
  );
}

export function OrchestrationDrawer({
  node,
  onClose,
  onActionDone,
}: {
  node: OrchNode | null;
  onClose: () => void;
  onActionDone: () => void;
}) {
  const t = useTranslations("orchestration");
  const { detail, isLoading, error, canApprove, canCancel, approve, cancel } =
    useDrawerDetail(node);

  useEffect(() => {
    if (!node) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [node, onClose]);

  if (!node) return null;
  const state = node.state ?? "queued";
  const ca = node.source === "cloud-agent" ? (detail as CloudAgentTask | null) : null;
  const a2a = node.source === "a2a" ? (detail as A2ATask | null) : null;

  const run = async (fn: () => Promise<boolean>) => {
    if (await fn()) onActionDone();
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-30" onClick={onClose} aria-hidden />
      <aside
        className="fixed right-0 top-0 h-full w-[380px] bg-surface border-l border-border z-40 overflow-y-auto p-4"
        role="dialog"
        aria-label={node.label}
      >
        <div className="flex items-center gap-2 mb-4">
          <StatusDot
            color={orchStateColor(state)}
            error={state === "failed"}
            pulse={state === "running"}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{node.label}</div>
            <div className="text-[10px] text-muted">
              {node.source} · {t(STATE_KEY[state])}
            </div>
          </div>
          <button className="ml-auto text-muted" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>

        {error && <div className="text-xs text-error mb-3">{t("actionFailed", { error })}</div>}
        {isLoading && <div className="text-xs text-muted mb-3">…</div>}

        <Section title={t("drawerObjective")}>
          <p className="text-xs break-words">
            {ca?.prompt ?? a2a?.input.messages[0]?.content ?? node.sublabel ?? node.label}
          </p>
        </Section>
        <Section title={t("drawerTimeline")}>
          <Timeline node={node} detail={detail} />
        </Section>
        {(node.cost != null || ca?.result?.duration != null) && (
          <Section title={t("drawerMetrics")}>
            <p className="text-xs">
              {node.cost != null && usd.format(node.cost)}
              {ca?.result?.duration != null && ` · ${ca.result.duration}s`}
            </p>
          </Section>
        )}
        {(ca?.result?.prUrl || (a2a?.artifacts?.length ?? 0) > 0) && (
          <Section title={t("drawerResult")}>
            {ca?.result?.prUrl && (
              <a
                className="text-xs underline"
                href={ca.result.prUrl}
                target="_blank"
                rel="noreferrer"
              >
                {ca.result.prUrl}
              </a>
            )}
            {a2a?.artifacts?.map((art, i) => (
              <pre
                key={i}
                className="text-[10px] bg-surface-muted rounded p-2 mt-1 overflow-x-auto"
              >
                {art.content}
              </pre>
            ))}
          </Section>
        )}
        {(canApprove || canCancel) && (
          <Section title={t("drawerActions")}>
            <div className="flex gap-2">
              {canApprove && (
                <button
                  className="text-xs rounded border border-success px-2 py-1"
                  onClick={() => run(approve)}
                >
                  {t("actionApprove")}
                </button>
              )}
              {canCancel && (
                <button
                  className="text-xs rounded border border-error px-2 py-1"
                  onClick={() => run(cancel)}
                >
                  {t("actionCancel")}
                </button>
              )}
            </div>
          </Section>
        )}
      </aside>
    </>
  );
}
