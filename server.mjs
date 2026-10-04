import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "dist");
const ENV_FILE = join(ROOT, ".env");

loadLocalEnv();

const PORT = Number(process.env.PORT) || 4173;
const HOST = "127.0.0.1";
const SEARCH_ENDPOINT = "https://api.mercadolibre.com/sites/MLB/search";
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function loadLocalEnv() {
  if (!existsSync(ENV_FILE)) return;

  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function normalizedText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseNumber(value) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.,-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function getAttribute(item, ids = [], names = []) {
  const normalizedIds = ids.map(normalizedText);
  const normalizedNames = names.map(normalizedText);
  const attribute = (item.attributes || []).find(candidate =>
    normalizedIds.includes(normalizedText(candidate.id)) ||
    normalizedNames.some(name => normalizedText(candidate.name).includes(name))
  );
  return attribute?.value_name ?? attribute?.value_struct?.number ?? null;
}

function normalizeTransmission(value) {
  const text = normalizedText(value);
  if (!text) return "Não informado";
  if (text.includes("automat") || text.includes("cvt")) return "Automático";
  if (text.includes("manual")) return "Manual";
  return String(value);
}

function extractFeatures(item) {
  const haystack = (item.attributes || [])
    .map(attribute => `${attribute.name || ""} ${attribute.value_name || ""}`)
    .join(" ");
  const text = normalizedText(haystack);
  const features = [];
  if (text.includes("camera de re") || text.includes("camera traseira")) features.push("Câmera de ré");
  if (text.includes("multimidia") || text.includes("central multimidia")) features.push("Multimídia");
  if (text.includes("couro")) features.push("Couro");
  if (text.includes("piloto automatico") || text.includes("controle de cruzeiro")) features.push("Piloto automático");
  return features;
}

function normalizeOffer(item, requestedBrand, requestedModel) {
  const brand = getAttribute(item, ["BRAND"], ["marca"]) || requestedBrand || "Marca não informada";
  const model = getAttribute(item, ["MODEL"], ["modelo"]) || requestedModel || item.title || "Modelo não informado";
  const year = parseNumber(getAttribute(item, ["VEHICLE_YEAR", "YEAR"], ["ano"]));
  const km = parseNumber(getAttribute(item, ["KILOMETERS", "ODOMETER"], ["quilometragem", "quilometros"]));
  const transmission = normalizeTransmission(getAttribute(item, ["TRANSMISSION"], ["transmissao", "cambio"]));
  const city = item.address?.city_name || item.seller_address?.city?.name || "Local não informado";
  const state = item.address?.state_name || item.seller_address?.state?.name || "";
  const thumbnail = String(item.thumbnail || item.thumbnail_id || "").replace(/^http:/, "https:");

  return {
    id: String(item.id),
    brand: String(brand),
    model: String(model),
    version: item.title || `${brand} ${model}`,
    year,
    km,
    transmission,
    price: Number(item.price) || 0,
    market: null,
    score: 0,
    source: "Mercado Livre",
    city: [city, state].filter(Boolean).join(", "),
    features: extractFeatures(item),
    thumbnail,
    permalink: item.permalink || ""
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function addRanking(offers) {
  const globalMedian = median(offers.map(offer => offer.price));
  const groups = new Map();

  for (const offer of offers) {
    const key = `${normalizedText(offer.brand)}:${normalizedText(offer.model)}`;
    const prices = groups.get(key) || [];
    prices.push(offer.price);
    groups.set(key, prices);
  }

  return offers.map(offer => {
    const key = `${normalizedText(offer.brand)}:${normalizedText(offer.model)}`;
    const comparableMedian = median(groups.get(key) || []) || globalMedian || offer.price;
    const priceAdvantage = comparableMedian > 0 ? (comparableMedian - offer.price) / comparableMedian : 0;
    const yearBonus = offer.year ? Math.max(-6, Math.min(8, (offer.year - 2020) * 1.35)) : 0;
    const kmBonus = offer.km === null ? 0 : Math.max(-8, Math.min(8, (60000 - offer.km) / 7500));
    const score = Math.round(Math.max(55, Math.min(99, 78 + priceAdvantage * 85 + yearBonus + kmBonus)));
    return { ...offer, market: Math.round(comparableMedian), score };
  });
}

function matchesFilters(offer, filters) {
  if (filters.brand && !normalizedText(offer.brand).includes(normalizedText(filters.brand))) return false;
  if (filters.model && !normalizedText(`${offer.model} ${offer.version}`).includes(normalizedText(filters.model))) return false;
  if (filters.minPrice && offer.price < filters.minPrice) return false;
  if (filters.maxPrice && offer.price > filters.maxPrice) return false;
  if (filters.minYear && (!offer.year || offer.year < filters.minYear)) return false;
  if (filters.maxYear && (!offer.year || offer.year > filters.maxYear)) return false;
  if (filters.maxKm && (offer.km === null || offer.km > filters.maxKm)) return false;
  if (filters.transmission && offer.transmission !== filters.transmission) return false;
  if (filters.features.length && !filters.features.every(feature => offer.features.includes(feature))) return false;
  return true;
}

async function fetchOffers(searchParams) {
  const token = process.env.MERCADO_LIVRE_ACCESS_TOKEN?.trim();
  if (!token) {
    const error = new Error("Configure MERCADO_LIVRE_ACCESS_TOKEN no arquivo .env para carregar anúncios reais.");
    error.status = 503;
    error.code = "mercado_livre_auth_required";
    throw error;
  }

  const filters = {
    brand: searchParams.get("brand") || "",
    model: searchParams.get("model") || "",
    minPrice: Number(searchParams.get("minPrice")) || 0,
    maxPrice: Number(searchParams.get("maxPrice")) || 0,
    minYear: Number(searchParams.get("minYear")) || 0,
    maxYear: Number(searchParams.get("maxYear")) || 0,
    maxKm: Number(searchParams.get("maxKm")) || 0,
    transmission: searchParams.get("transmission") || "",
    features: searchParams.getAll("feature")
  };

  const apiUrl = new URL(SEARCH_ENDPOINT);
  apiUrl.searchParams.set("category", "MLB1744");
  apiUrl.searchParams.set("limit", "50");
  const query = [filters.brand, filters.model].filter(Boolean).join(" ");
  if (query) apiUrl.searchParams.set("q", query);
  if (filters.minPrice || filters.maxPrice) {
    apiUrl.searchParams.set("price", `${filters.minPrice || "*"}-${filters.maxPrice || "*"}`);
  }

  const cacheKey = apiUrl.toString();
  const cached = cache.get(cacheKey);
  let payload;
  let cacheHit = false;

  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    payload = cached.payload;
    cacheHit = true;
  } else {
    const apiResponse = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!apiResponse.ok) {
      const details = await apiResponse.json().catch(() => ({}));
      const error = new Error(
        apiResponse.status === 401 || apiResponse.status === 403
          ? "O token do Mercado Livre está ausente, expirado ou sem permissão para esta consulta."
          : apiResponse.status === 429
            ? "O limite temporário de consultas do Mercado Livre foi atingido. Tente novamente em instantes."
            : details.message || "O Mercado Livre não respondeu à busca."
      );
      error.status = apiResponse.status;
      error.code = apiResponse.status === 429 ? "rate_limited" : "mercado_livre_api_error";
      throw error;
    }

    payload = await apiResponse.json();
    cache.set(cacheKey, { createdAt: Date.now(), payload });
  }

  const normalized = (payload.results || []).map(item => normalizeOffer(item, filters.brand, filters.model));
  const filtered = normalized.filter(offer => matchesFilters(offer, filters));
  const ranked = addRanking(filtered).sort((a, b) => b.score - a.score);

  return {
    offers: ranked,
    meta: {
      source: "Mercado Livre",
      fetchedAt: new Date().toISOString(),
      totalAvailable: payload.paging?.total ?? ranked.length,
      returned: ranked.length,
      cacheHit,
      query
    }
  };
}

async function serveStatic(requestPath, response) {
  const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const filePath = normalize(join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(response, 403, { error: "forbidden" });

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": requestPath === "/" ? "no-cache" : "public, max-age=3600"
    });
    response.end(content);
  } catch {
    json(response, 404, { error: "not_found" });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        status: "ok",
        source: "Mercado Livre",
        configured: Boolean(process.env.MERCADO_LIVRE_ACCESS_TOKEN?.trim())
      });
    }

    if (request.method === "GET" && url.pathname === "/api/offers") {
      return json(response, 200, await fetchOffers(url.searchParams));
    }

    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    return await serveStatic(url.pathname, response);
  } catch (error) {
    console.error(`[GarimpaCar] ${error.message}`);
    json(response, error.status || 500, {
      error: error.code || "internal_error",
      message: error.message || "Erro inesperado ao consultar ofertas."
    });
  }
});

server.listen(PORT, HOST, () => {
  const configured = Boolean(process.env.MERCADO_LIVRE_ACCESS_TOKEN?.trim());
  console.log(`GarimpaCar disponível em http://${HOST}:${PORT}`);
  console.log(`Mercado Livre: ${configured ? "configurado" : "aguardando token em .env"}`);
});
