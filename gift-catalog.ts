import { logger } from "./logger";

const CATALOG_URL =
  "https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/main/Gifts_Details.json";
const MODELS_BASE_URL =
  "https://raw.githubusercontent.com/ssamy2/TelegramGiftsAssests/main/";
const CACHE_TTL_MS = 10 * 60 * 1000;

type GiftEntry = {
  full_name: string;
  short_name: string;
  regular_id?: string;
  id?: string;
  floor_price_ton?: number;
  portal_price_ton?: number;
  getgems_price_ton?: number;
  tgmrkt_price_ton?: number;
  price_ton?: number;
  models?: string;
};

type CatalogPayload = {
  upgraded?: GiftEntry[];
  unupgraded?: GiftEntry[];
  regular_gifts?: GiftEntry[];
  last_updated?: number;
};

export type GiftQuote = {
  collection: string;
  shortName: string;
  giftNumber?: string;
  floorTon: number | null;
  markets: Array<{ name: string; priceTon: number }>;
  model?: string;
  modelPriceTon?: number;
  updatedAt?: Date;
  imageUrl?: string;
  sourceUrl: string;
};

let catalogPromise: Promise<CatalogPayload> | undefined;
let catalogLoadedAt = 0;
let modelsCache = new Map<string, Record<string, unknown>>();

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return normalize(value).replaceAll(" ", "");
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "user-agent": "NFTGiftPriceBot/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Catalog request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

async function loadCatalog(): Promise<CatalogPayload> {
  const now = Date.now();
  if (catalogPromise && now - catalogLoadedAt < CACHE_TTL_MS) {
    return catalogPromise;
  }
  catalogLoadedAt = now;
  catalogPromise = fetchJson<CatalogPayload>(CATALOG_URL).catch((error) => {
    catalogPromise = undefined;
    catalogLoadedAt = 0;
    throw error;
  });
  return catalogPromise;
}

function allEntries(catalog: CatalogPayload): GiftEntry[] {
  return [
    ...(catalog.upgraded ?? []),
    ...(catalog.unupgraded ?? []),
    ...(catalog.regular_gifts ?? []),
  ];
}

function extractGiftSlug(input: string): string {
  let value = input.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original value when a user sends a partially encoded URL.
  }
  const urlMatch = value.match(
    /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:nft|gift)\/([^?#\s]+)/i,
  );
  if (urlMatch?.[1]) value = urlMatch[1];
  const fragmentMatch = value.match(
    /(?:https?:\/\/)?(?:www\.)?fragment\.com\/gift\/([^?#\s]+)/i,
  );
  if (fragmentMatch?.[1]) value = fragmentMatch[1];
  return value
    .replace(/[),.;!?]+$/g, "")
    .split(/[?#/]/)[0]
    .replace(/%20/g, " ")
    .trim();
}

function findEntry(entries: GiftEntry[], input: string): GiftEntry | undefined {
  const cleaned = extractGiftSlug(input);
  const normalizedInput = normalize(cleaned);
  const compactInput = compact(cleaned);
  const numberMatch = cleaned.match(/^(.*?)[-_ ](\d+)$/);
  const collectionPart = numberMatch?.[1] ?? cleaned;
  const normalizedCollection = normalize(collectionPart);
  const compactCollection = compact(collectionPart);
  return entries.find((entry) => {
    const name = normalize(entry.full_name);
    const shortName = normalize(entry.short_name);
    const compactName = compact(entry.full_name);
    const compactShortName = compact(entry.short_name);
    const id = entry.id ?? entry.regular_id;
    return (
      name === normalizedInput ||
      shortName === normalizedInput ||
      compactName === compactInput ||
      compactShortName === compactInput ||
      (id !== undefined && id === cleaned) ||
      name === normalizedCollection ||
      shortName === normalizedCollection ||
      compactName === compactCollection ||
      compactShortName === compactCollection
    );
  });
}

async function getModelPrice(
  entry: GiftEntry,
  model?: string,
): Promise<number | undefined> {
  if (!model || !entry.models) return undefined;
  const cacheKey = entry.models;
  let data = modelsCache.get(cacheKey);
  if (!data) {
    try {
      data = await fetchJson<Record<string, unknown>>(
        `${MODELS_BASE_URL}${entry.models}`,
      );
      modelsCache.set(cacheKey, data);
    } catch (error) {
      logger.warn({ error, gift: entry.full_name }, "Could not load model prices");
      return undefined;
    }
  }
  const target = normalize(model);
  const sections = ["models", "model"];
  for (const section of sections) {
    const values = data[section];
    if (values && typeof values === "object") {
      for (const [name, price] of Object.entries(values)) {
        if (normalize(name) === target) return toNumber(price) ?? undefined;
      }
    }
  }
  for (const [name, price] of Object.entries(data)) {
    if (normalize(name) === target) return toNumber(price) ?? undefined;
  }
  return undefined;
}

export async function quoteGift(
  input: string,
  model?: string,
): Promise<GiftQuote | null> {
  const catalog = await loadCatalog();
  const entry = findEntry(allEntries(catalog), input);
  if (!entry) return null;
  const markets = [
    ["Fragment", entry.floor_price_ton],
    ["Portals", entry.portal_price_ton],
    ["Getgems", entry.getgems_price_ton],
    ["TGMRKT", entry.tgmrkt_price_ton],
    ["Каталог", entry.price_ton],
  ]
    .map(([name, value]) => ({
      name: String(name),
      priceTon: toNumber(value) ?? 0,
    }))
    .filter((market) => market.priceTon > 0);
  const floorTon =
    markets.length > 0
      ? Math.min(...markets.map((market) => market.priceTon))
      : null;
  const numberMatch = extractGiftSlug(input).match(/[-_ ](\d+)(?:[/?#]|$)/);
  const giftNumber = numberMatch?.[1];
  const imageSlug = `${entry.short_name.replaceAll("_", "-")}-${giftNumber ?? "1"}`;
  return {
    collection: entry.full_name,
    shortName: entry.short_name,
    giftNumber,
    floorTon,
    markets,
    model,
    modelPriceTon: await getModelPrice(entry, model),
    updatedAt:
      typeof catalog.last_updated === "number"
        ? new Date(catalog.last_updated * 1000)
        : undefined,
    imageUrl: `https://nft.fragment.com/gift/${imageSlug}.medium.jpg`,
    sourceUrl: `https://fragment.com/gifts/${entry.short_name}`,
  };
}

export async function searchGifts(query: string, limit = 8): Promise<GiftEntry[]> {
  const catalog = await loadCatalog();
  const target = normalize(query);
  return allEntries(catalog)
    .filter((entry) => {
      if (!target) return true;
      return (
        normalize(entry.full_name).includes(target) ||
        normalize(entry.short_name).includes(target)
      );
    })
    .slice(0, limit);
}

export async function catalogUpdatedAt(): Promise<Date | undefined> {
  const catalog = await loadCatalog();
  return typeof catalog.last_updated === "number"
    ? new Date(catalog.last_updated * 1000)
    : undefined;
}
