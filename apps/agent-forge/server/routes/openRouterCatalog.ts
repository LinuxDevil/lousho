import type { CatalogModel } from '../../shared/wireTypes';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

interface OpenRouterModel {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number | null };
}

function perMillion(price: string | undefined): number | undefined {
  const n = Number(price);
  return price === undefined || !Number.isFinite(n) || n < 0 ? undefined : Math.round(n * 1e6 * 1e4) / 1e4;
}

export function toCatalogModel(m: OpenRouterModel, available: boolean): CatalogModel {
  const params = m.supported_parameters ?? [];
  const maxOut = m.top_provider?.max_completion_tokens;
  return {
    id: `openrouter/${m.id}`,
    modelId: m.id,
    provider: 'openrouter',
    contextWindow: m.context_length ?? 0,
    ...(typeof maxOut === 'number' && { maxOutputTokens: maxOut }),
    ...(perMillion(m.pricing?.prompt) !== undefined && { inputCostPerMTok: perMillion(m.pricing?.prompt) }),
    ...(perMillion(m.pricing?.completion) !== undefined && { outputCostPerMTok: perMillion(m.pricing?.completion) }),
    capabilities: {
      tools: params.includes('tools'),
      vision: m.architecture?.input_modalities?.includes('image') ?? false,
      reasoning: params.includes('reasoning'),
      structuredOutput: params.includes('structured_outputs') || params.includes('response_format'),
      hostedTools: [],
    },
    available,
  };
}

export function createOpenRouterCatalog(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now
): () => Promise<CatalogModel[]> {
  let cache: { raw: OpenRouterModel[]; expires: number } | undefined;
  let inflight: Promise<OpenRouterModel[]> | undefined;

  async function load(): Promise<OpenRouterModel[]> {
    try {
      const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      const raw = Array.isArray(body.data)
        ? body.data.filter((m): m is OpenRouterModel => typeof (m as OpenRouterModel)?.id === 'string')
        : [];
      cache = { raw, expires: now() + CACHE_TTL_MS };
      return raw;
    } catch (error) {
      console.warn(`[catalog] could not list OpenRouter models: ${(error as Error).message}`);
      cache = { raw: cache?.raw ?? [], expires: now() + FAILURE_RETRY_MS };
      return cache.raw;
    } finally {
      inflight = undefined;
    }
  }

  return async () => {
    const raw = cache !== undefined && cache.expires > now() ? cache.raw : await (inflight ??= load());
    return raw.map((m) => toCatalogModel(m, true)).sort((a, b) => a.id.localeCompare(b.id));
  };
}

export const openRouterModels = createOpenRouterCatalog();

export function hasOpenRouterKey(secrets?: { getKey(provider: 'openrouter'): string | undefined }): boolean {
  return Boolean(secrets?.getKey('openrouter') || process.env.OPENROUTER_API_KEY);
}

export async function withOpenRouterModels(
  sdk: CatalogModel[],
  provider: string | undefined,
  hasKey: boolean,
  source: () => Promise<CatalogModel[]> = openRouterModels
): Promise<CatalogModel[]> {
  if (!hasKey || (provider !== undefined && provider !== 'openrouter')) return sdk;
  const known = new Set(sdk.map((m) => m.id));
  return [...sdk, ...(await source()).filter((m) => !known.has(m.id))];
}
