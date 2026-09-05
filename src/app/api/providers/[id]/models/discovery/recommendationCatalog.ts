import { getModelsByProviderId } from "@/shared/constants/models";
import { getStaticModelsForProvider } from "@/lib/providers/staticModels";
import { mergeLocalCatalogModels } from "./helpers";

type ModelRow = Record<string, unknown> & { id: string };

/** Keep only Perplexity chat-capable Sonar rows from heterogeneous model payloads. */
export function parsePerplexitySonarModels(data: any): any[] {
  const models = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : [];
  return models.filter(
    (model: any) => typeof model?.id === "string" && /^sonar(-|$)/.test(model.id)
  );
}

/** Distinguish an authoritative (possibly empty) Nous payload from malformed HTTP 200 data. */
export function hasNousRecommendationPayloadShape(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  const fields = ["freeRecommendedModels", "paidRecommendedModels", "recommendedModels"] as const;
  const present = fields.filter((field) => record[field] !== undefined);
  return present.length > 0 && present.every((field) => Array.isArray(record[field]));
}

/** Preserve Nous Portal's full recommendation list while tagging the live free subset. */
export function parseNousRecommendedModels(data: any): Array<ModelRow | { id: string }> {
  const free = Array.isArray(data?.freeRecommendedModels) ? data.freeRecommendedModels : [];
  const paid = Array.isArray(data?.paidRecommendedModels)
    ? data.paidRecommendedModels
    : Array.isArray(data?.recommendedModels)
      ? data.recommendedModels
      : [];
  const seen = new Set<string>();
  const models: ModelRow[] = [];

  const append = (entry: any, isFree: boolean) => {
    const id =
      typeof entry === "string"
        ? entry.trim()
        : typeof entry?.modelName === "string"
          ? entry.modelName.trim()
          : typeof entry?.id === "string"
            ? entry.id.trim()
            : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name =
      typeof entry?.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : typeof entry?.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : id;
    models.push({ id, name, ...(isFree ? { isFree: true } : {}) });
  };

  for (const entry of free) append(entry, true);
  for (const entry of paid) append(entry, false);
  const curated = mergeLocalCatalogModels(
    getModelsByProviderId("nous-research") || [],
    getStaticModelsForProvider("nous-research") || []
  );
  return mergeNousRecommendedModelsWithCurated(models, curated);
}

/** Portal recommendations augment the shipped Nous catalog; live rows win duplicate ids. */
export function mergeNousRecommendedModelsWithCurated<T extends { id: string }>(
  recommended: ModelRow[],
  curated: T[]
): Array<ModelRow | T> {
  const merged: Array<ModelRow | T> = [...recommended];
  const seen = new Set(recommended.map((model) => model.id));
  for (const model of curated) {
    if (seen.has(model.id)) continue;
    const fallback = { ...model } as T & ModelRow;
    Object.defineProperty(fallback, "_omnirouteDiscoveryFreeEvidence", {
      value: false,
      enumerable: false,
    });
    merged.push(fallback);
  }
  return merged;
}
