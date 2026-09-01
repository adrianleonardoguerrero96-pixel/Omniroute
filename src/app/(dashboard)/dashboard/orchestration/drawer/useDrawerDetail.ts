"use client";
/** Fetches per-source task detail on drawer open + approve/cancel actions. */
import { useEffect, useState } from "react";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import type { OrchNode } from "../model/orchestrationTypes";

interface SourceRoute {
  detailUrl: string | null;
  cancelReq: { url: string; init: RequestInit } | null;
  approveReq: { url: string; init: RequestInit } | null;
}

function routeFor(node: OrchNode): SourceRoute {
  const post = (body?: unknown): RequestInit => ({
    method: "POST",
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  if (node.id.startsWith("cloud-agent:")) {
    const id = node.id.slice("cloud-agent:".length).replace(/:activity$/, "");
    const url = `/api/v1/agents/tasks/${encodeURIComponent(id)}`;
    return {
      detailUrl: url,
      cancelReq: { url, init: post({ action: "cancel" }) },
      approveReq: { url, init: post({ action: "approve" }) },
    };
  }
  if (node.id.startsWith("a2a:")) {
    const id = node.id.slice("a2a:".length);
    return {
      detailUrl: `/api/a2a/tasks/${encodeURIComponent(id)}`,
      cancelReq: { url: `/api/a2a/tasks/${encodeURIComponent(id)}/cancel`, init: post() },
      approveReq: null,
    };
  }
  if (node.id.startsWith("conductor:task:")) {
    const id = node.id.slice("conductor:task:".length);
    return {
      detailUrl: `/api/conductor/tasks/${encodeURIComponent(id)}`,
      cancelReq: { url: `/api/conductor/tasks/${encodeURIComponent(id)}/cancel`, init: post() },
      approveReq: null,
    };
  }
  return { detailUrl: null, cancelReq: null, approveReq: null }; // runners/overflow: raw only
}

export function useDrawerDetail(node: OrchNode | null) {
  const [detail, setDetail] = useState<unknown | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const route = node ? routeFor(node) : null;

  useEffect(() => {
    // Reset to the new node's own raw snapshot (and clear any stale error) before
    // fetching fresh detail — a re-sync keyed by node identity (already in the deps
    // array below), not a cascading render. Precedent: ConnectionDetail.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(node?.raw ?? null);
    setError(null);
    if (!node || !route?.detailUrl) return;
    const controller = new AbortController();
    setIsLoading(true);
    fetch(route.detailUrl, { signal: controller.signal, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body) => setDetail((body as { data?: unknown }).data ?? body))
      .catch((err) => {
        if (!controller.signal.aborted) setError(sanitizeErrorMessage(err));
      })
      .finally(() => setIsLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by node identity
  }, [node?.id]);

  const act = async (req: { url: string; init: RequestInit } | null): Promise<boolean> => {
    if (!req) return false;
    try {
      const res = await fetch(req.url, req.init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      setError(sanitizeErrorMessage(err));
      return false;
    }
  };

  return {
    detail,
    isLoading,
    error,
    canApprove: !!route?.approveReq && node?.state === "waiting_approval",
    canCancel:
      !!route?.cancelReq &&
      !!node?.state &&
      !["succeeded", "failed", "cancelled"].includes(node.state),
    approve: () => act(route?.approveReq ?? null),
    cancel: () => act(route?.cancelReq ?? null),
  };
}
