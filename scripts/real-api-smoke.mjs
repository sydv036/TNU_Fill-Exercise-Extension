import { createServer } from "vite";
import { readFile } from "node:fs/promises";

const providers = [
  { id: "gemini_api", label: "Gemini", key: "GEMINI_API_KEY", model: "TNU_GEMINI_MODEL", env: "GEMINI" },
  { id: "openai_api", label: "OpenAI", key: "OPENAI_API_KEY", model: "TNU_OPENAI_MODEL", env: "OPENAI" },
  { id: "anthropic_api", label: "Claude", key: "ANTHROPIC_API_KEY", model: "TNU_ANTHROPIC_MODEL", env: "CLAUDE" }
];
const requested = process.argv.slice(2);
const selected = requested.length ? providers.filter((provider) => requested.includes(provider.id)) : providers;
if (!selected.length || requested.some((id) => !providers.some((provider) => provider.id === id))) throw new Error("Provider hợp lệ: gemini_api, openai_api, anthropic_api.");

if (process.env.TNU_REAL_SMOKE !== "1") {
  for (const provider of selected) console.log(`${provider.label}: NOT RUN (chưa bật TNU_REAL_SMOKE=1).`);
  console.log("Không có API request nào được gửi.");
  process.exit(0);
}

const maxRequests = Number(process.env.TNU_REAL_SMOKE_MAX_REQUESTS);
const maxCostUsd = Number(process.env.TNU_REAL_SMOKE_MAX_COST_USD);
if (selected.length !== 1 || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 3 || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
  console.error("NOT RUN: chọn đúng một provider và đặt TNU_REAL_SMOKE_MAX_REQUESTS (1–3, áp dụng toàn bộ lần chạy, gồm model discovery) cùng TNU_REAL_SMOKE_MAX_COST_USD > 0.");
  console.log("Chạy riêng từng provider để giới hạn request và chi phí rõ ràng.");
  process.exit(2);
}

const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
let failed = false;
let totalHttpRequests = 0;
try {
  const [{ DEFAULT_SETTINGS }, gemini, external, { capabilityQuestion }, { estimateRequestTokens, isValidModelPrice }, { ApiError, classifyProviderError }] = await Promise.all([
    vite.ssrLoadModule("/src/defaults.ts"), vite.ssrLoadModule("/src/gemini.ts"), vite.ssrLoadModule("/src/auto-provider.ts"),
    vite.ssrLoadModule("/src/capability-probe.ts"), vite.ssrLoadModule("/src/run-budget.ts"), vite.ssrLoadModule("/src/api-policy.ts")
  ]);

  for (const provider of selected) {
    const apiKey = process.env[provider.key];
    const model = process.env[provider.model];
    const suffix = provider.env;
    const price = {
      provider: provider.id,
      model: model ?? "",
      inputUsdPerMillion: Number(process.env[`TNU_REAL_SMOKE_${suffix}_INPUT_USD_PER_MILLION`]),
      outputUsdPerMillion: Number(process.env[`TNU_REAL_SMOKE_${suffix}_OUTPUT_USD_PER_MILLION`]),
      sourceUrl: process.env[`TNU_REAL_SMOKE_${suffix}_PRICE_SOURCE_URL`] ?? "",
      checkedOn: process.env[`TNU_REAL_SMOKE_${suffix}_PRICE_CHECKED_ON`] ?? ""
    };
    if (!apiKey || !model) { console.log(`${provider.label}: NOT RUN (thiếu key hoặc model; không gửi request).`); continue; }
    const priceAgeMs = Date.now() - Date.parse(`${price.checkedOn}T00:00:00Z`);
    if (!isValidModelPrice(price) || priceAgeMs < -86400000 || priceAgeMs > 30 * 86400000) {
      console.log(`${provider.label}: NOT RUN (thiếu giá model đã đối chiếu trong 30 ngày; không gửi request).`);
      continue;
    }

    let generationRequests = 0;
    let spentEstimate = 0;
    let usageUnknown = false;
    const report = { authentication: "NOT RUN", model: "NOT RUN", text: "NOT RUN", image: "NOT RUN", response: "NOT RUN", usage: "NOT RUN", errorClassification: "NOT RUN" };
    const fixturePath = provider.id === "gemini_api" ? "gemini-temporary-rate-limit.json" : provider.id === "openai_api" ? "openai-insufficient-credit.json" : "claude-spend-limit.json";
    const fixture = JSON.parse(await readFile(new URL(`../tests/fixtures/${fixturePath}`, import.meta.url), "utf8"));
    const expectedDisposition = provider.id === "gemini_api" ? "temporary_rate_limit" : provider.id === "openai_api" ? "billing" : "spend_limit";
    const classification = classifyProviderError(provider.label, 429, fixture);
    report.errorClassification = classification.disposition === expectedDisposition && (expectedDisposition === "temporary_rate_limit" ? classification.retryable && classification.fallbackAllowed : !classification.retryable && !classification.fallbackAllowed)
      ? "PASS (sanitized provider error fixture; live error not induced)" : "FAIL (provider error fixture classification)";
    if (report.errorClassification.startsWith("FAIL")) failed = true;
    const safeFetch = async (input, init = {}) => {
      if (totalHttpRequests >= maxRequests) throw new ApiError("Real smoke request cap reached.", "budget");
      totalHttpRequests++;
      return fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(60000) });
    };

    try {
      // The catalog call checks key acceptance, but does not prove inference billing/model access.
      const models = provider.id === "gemini_api" ? await gemini.listGeminiModels(apiKey, safeFetch) : await external.listExternalModels(provider.id, apiKey, safeFetch);
      report.authentication = "PASS (model catalog accepted key)";
      if (!models.some((item) => item.id === model)) {
        report.model = "FAIL (model not listed)";
        failed = true;
        console.log(`${provider.label}: ${formatReport(report, totalHttpRequests, generationRequests, spentEstimate)}`);
        continue;
      }
      report.model = "PASS (model listed; endpoint capabilities still require inference test)";

      const runProbe = async (image) => {
        if (totalHttpRequests >= maxRequests || generationRequests >= 2) return "NOT RUN (request cap)";
        if (usageUnknown) return "NOT RUN (usage unknown; stopping safely)";
        const question = capabilityQuestion(image);
        const settings = { ...DEFAULT_SETTINGS, provider: provider.id, model, customModel: model, openaiModel: model, anthropicModel: model, retryCount: 0, timeoutMs: 60000 };
        const projected = estimateRequestTokens(question, [], [], settings, `smoke-${provider.id}-${image ? "image" : "text"}`);
        const projectedUsd = (projected.inputTokens * price.inputUsdPerMillion + projected.outputTokens * price.outputUsdPerMillion) / 1_000_000;
        if (spentEstimate + projectedUsd > maxCostUsd) return "NOT RUN (dự toán vượt ngân sách đã đặt)";
        let usage;
        let result;
        const hooks = {
          beforeAttempt: async () => { generationRequests++; },
          onUsage: async (value) => { usage = value; if (value) spentEstimate += (value.inputTokens * price.inputUsdPerMillion + value.outputTokens * price.outputUsdPerMillion) / 1_000_000; else usageUnknown = true; }
        };
        try {
          result = provider.id === "gemini_api"
            ? await gemini.answerWithGemini(apiKey, settings, question, AbortSignal.timeout(60000), safeFetch, false, [], [], hooks)
            : await external.answerWithExternalApi({ provider: provider.id, apiKey, model, requestId: crypto.randomUUID(), settings, question, knowledgeChunks: [], cacheEvidence: [] }, AbortSignal.timeout(60000), safeFetch, hooks);
        } catch (error) {
          const status = Number.isInteger(error?.status) && error.status ? ` HTTP ${error.status}` : "";
          const code = typeof error?.providerCode === "string" ? ` ${error.providerCode}` : "";
          return `FAIL (${typeof error?.kind === "string" ? error.kind : "API error"}${code}${status})`;
        }
        if (result.selectedOptionIds.length !== 1 || result.selectedOptionIds[0] !== "option_1") return "FAIL (response parsed but sample mapping was wrong)";
        if (!usage) return "FAIL (response parsed; usage metadata missing)";
        return "PASS (request, parsing, completion and expected mapping)";
      };

      report.text = await runProbe(false);
      if (report.text.startsWith("PASS")) {
        report.response = "PASS (text response completed and parsed by provider adapter)";
        report.image = await runProbe(true);
        if (report.image.startsWith("PASS")) report.response = "PASS (text and image responses completed and parsed)";
      } else {
        report.image = "NOT RUN (text probe did not pass; stopped to limit requests)";
      }
      report.usage = usageUnknown ? "FAIL (missing usage metadata; image probe stopped)" : generationRequests ? "PASS (usage metadata returned)" : "NOT RUN";
      if ([report.text, report.image, report.usage].some((value) => value.startsWith("FAIL"))) failed = true;
    } catch (error) {
      report.authentication = error?.kind === "authentication" ? "FAIL (authentication rejected)" : "FAIL (catalog/network error)";
      if (error?.status === 401 || error?.status === 403) report.authentication = "FAIL (authentication or access rejected)";
      failed = true;
    }
    console.log(`${provider.label}: ${formatReport(report, totalHttpRequests, generationRequests, spentEstimate)}`);
  }
} finally {
  await vite.close();
}

function formatReport(report, httpRequests, generationRequests, spentEstimate) {
  return `auth ${report.authentication}; model ${report.model}; text ${report.text}; ảnh ${report.image}; response ${report.response}; usage ${report.usage}; error classification ${report.errorClassification}; ${httpRequests} HTTP request(s), ${generationRequests} generation(s), ước tính $${spentEstimate.toFixed(6)}.`;
}

if (failed) process.exitCode = 1;
