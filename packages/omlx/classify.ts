/**
 * omlx classifiers over `POST /v1/systemone`.
 *
 * Limits and confidence match Pi's llama.cpp classifier. omlx has no
 * temperature field and its score confidence is not Pi's, so both are applied
 * here. Pi's parser drops score `probabilities`; the fetch wrapper keeps the
 * raw answers so score can be recomputed.
 */

import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierChoiceAnswer,
  ClassifierContext,
  ClassifierFunction,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
  ClassifierScoreAnswer,
  FetchFunction,
} from "@earendil-works/pi-ai";

/** A–Z, a–z, 0–9. Same ceiling as llama's choice labels. */
const CHOICE_LIMIT = 62;
/** Digits `0`–`9`. Same ceiling as llama's score labels. */
const SCORE_LIMIT = 10;

/** Raw omlx score answer. Pi's parser drops `probabilities`. */
export interface OmlxScoreAnswer {
  type: "score";
  score?: number;
  confidence?: number;
  probabilities: Readonly<Record<string, number>>;
}

/** Parsed classifier answer, or a raw score answer that still has probabilities. */
export type TemperatureAnswer = ClassifierAnswer | OmlxScoreAnswer;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pi's choice and score limits, checked before any request.
 *
 * Error text matches llama's `questionLabels`.
 */
export function validateClassifierLimits(context: ClassifierContext): void {
  for (const question of Object.values(context.questions)) {
    if (question.type === "choice") {
      const count = Object.keys(question.criteria).length;
      if (count < 2 || count > CHOICE_LIMIT) {
        throw new Error(`A choice question needs 2 to ${CHOICE_LIMIT} options, got ${count}`);
      }
    } else if (question.type === "score") {
      const count = question.criteria.length;
      if (count < 2 || count > SCORE_LIMIT) {
        throw new Error(`A score question needs 2 to ${SCORE_LIMIT} levels, got ${count}`);
      }
    }
  }
}

/** Llama's temperature check. Non-positive, NaN, and non-finite values fail. */
function assertPositiveTemperature(temperature: number): void {
  if (!(temperature > 0) || !Number.isFinite(temperature)) {
    throw new Error(`Temperature must be a positive number, got ${temperature}`);
  }
}

/**
 * TypeSafe's documented choice confidence, `(n * peak - 1) / (n - 1)`, clamped to [0, 1].
 *
 * Same formula as llama's `peakConfidence`.
 */
export function peakConfidence(probabilities: readonly number[]): number {
  const n = probabilities.length;
  const peak = Math.max(...probabilities);
  return Math.min(1, Math.max(0, (n * peak - 1) / (n - 1)));
}

function normalize(probabilities: readonly number[]): number[] {
  const total = probabilities.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new Error("omlx returned probabilities that sum to zero");
  return probabilities.map((value) => value / total);
}

/**
 * `p^(1/T)` then renormalize. At temperature 1 the values are copied, so a
 * distribution that already sums to 1 is unchanged.
 */
function scaleProbabilities(probabilities: readonly number[], temperature: number): number[] {
  assertPositiveTemperature(temperature);
  if (temperature === 1) return [...probabilities];
  const weights = probabilities.map((probability) => {
    if (!Number.isFinite(probability) || probability < 0) {
      throw new Error("omlx returned an invalid probability");
    }
    if (probability === 0) return 0;
    return Math.exp(Math.log(probability) / temperature);
  });
  return normalize(weights);
}

function choiceProbabilities(answer: TemperatureAnswer, keys: readonly string[]): number[] {
  if (answer.type !== "choice")
    throw new Error("omlx returned a choice answer without probabilities");
  return keys.map((key) => {
    const value = answer.probabilities[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`omlx returned a choice answer without probability for ${key}`);
    }
    return value;
  });
}

function isScoreWithProbabilities(answer: TemperatureAnswer): answer is OmlxScoreAnswer {
  return answer.type === "score" && "probabilities" in answer && isRecord(answer.probabilities);
}

function scoreProbabilities(answer: TemperatureAnswer, levels: number): number[] {
  if (!isScoreWithProbabilities(answer)) {
    throw new Error("omlx returned a score answer without probabilities");
  }
  const values: number[] = [];
  for (let index = 0; index < levels; index += 1) {
    const value = answer.probabilities[String(index)];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("omlx returned a score answer without probabilities");
    }
    values.push(value);
  }
  return values;
}

function boolProbability(answer: TemperatureAnswer): number {
  if (answer.type !== "bool") throw new Error("omlx returned an invalid bool answer");
  if (!Number.isFinite(answer.probability) || answer.probability < 0) {
    throw new Error("omlx returned an invalid bool answer");
  }
  return answer.probability;
}

function argmax(probabilities: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < probabilities.length; index += 1) {
    const value = probabilities[index];
    const current = probabilities[best];
    if (value !== undefined && current !== undefined && value > current) best = index;
  }
  return best;
}

function choiceAnswer(
  keys: readonly string[],
  probabilities: readonly number[],
): ClassifierChoiceAnswer {
  const best = argmax(probabilities);
  const choice = keys[best];
  if (choice === undefined) throw new Error("omlx returned a choice answer without probabilities");
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(keys.map((key, index) => [key, probabilities[index] ?? 0])),
    confidence: peakConfidence(probabilities),
  };
}

function scoreAnswer(probabilities: readonly number[]): ClassifierScoreAnswer {
  const shares = normalize(probabilities);
  return {
    type: "score",
    score: shares.reduce((sum, probability, index) => sum + index * probability, 0),
    confidence: peakConfidence(shares),
  };
}

/**
 * Scale answer probabilities by `p^(1/T)` and recompute llama-equivalent fields.
 *
 * Choice and score confidence use `peakConfidence`. Score is the expected level.
 * Bool uses `[p, 1-p]`. Temperature 1 leaves probabilities unchanged.
 */
export function applyTemperature(
  answers: Readonly<Record<string, TemperatureAnswer>>,
  context: ClassifierContext,
  temperature: number,
): Record<string, ClassifierAnswer> {
  assertPositiveTemperature(temperature);
  const next: Record<string, ClassifierAnswer> = {};
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = answers[id];
    if (answer === undefined) throw new Error(`omlx did not return an answer for ${id}`);
    if (question.type === "choice") {
      const keys = Object.keys(question.criteria);
      next[id] = choiceAnswer(
        keys,
        scaleProbabilities(choiceProbabilities(answer, keys), temperature),
      );
    } else if (question.type === "score") {
      next[id] = scoreAnswer(
        scaleProbabilities(scoreProbabilities(answer, question.criteria.length), temperature),
      );
    } else {
      const probability = boolProbability(answer);
      const scaled = scaleProbabilities([probability, 1 - probability], temperature);
      const trueProbability = scaled[0];
      if (trueProbability === undefined) throw new Error("omlx returned an invalid bool answer");
      next[id] = { type: "bool", probability: trueProbability };
    }
  }
  return next;
}

function isSystemOneRequest(input: Parameters<FetchFunction>[0]): boolean {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(href).pathname.endsWith("/v1/systemone");
  } catch {
    return false;
  }
}

/**
 * Clone a successful `/v1/systemone` body and keep its `answers`.
 * The original response is left unread for Pi's parser.
 */
function retainSystemOneAnswers(base: FetchFunction): {
  fetch: FetchFunction;
  rawAnswers: () => Promise<unknown>;
} {
  let pending: Promise<unknown> = Promise.resolve(undefined);
  const fetch: FetchFunction = async (input, init) => {
    const response = await base(input, init);
    if (response.ok && isSystemOneRequest(input)) {
      const clone = response.clone();
      pending = clone
        .json()
        .then((body: unknown) => (isRecord(body) ? body.answers : undefined))
        .catch(() => undefined);
    }
    return response;
  };
  return { fetch, rawAnswers: () => pending };
}

function scoreAnswerFromRaw(parsed: ClassifierAnswer | undefined, raw: unknown): OmlxScoreAnswer {
  if (!isRecord(raw) || !isRecord(raw.probabilities)) {
    throw new Error("omlx returned a score answer without probabilities");
  }
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.probabilities)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("omlx returned a score answer without probabilities");
    }
    probabilities[key] = value;
  }
  return {
    type: "score",
    ...(parsed?.type === "score" ? { score: parsed.score, confidence: parsed.confidence } : {}),
    probabilities,
  };
}

/** Overlay raw score probabilities onto Pi's parsed answers. */
function answersWithRawScores(
  parsed: Record<string, ClassifierAnswer>,
  raw: unknown,
  context: ClassifierContext,
): Record<string, TemperatureAnswer> {
  const rawAnswers = isRecord(raw) ? raw : undefined;
  const merged: Record<string, TemperatureAnswer> = { ...parsed };
  for (const [id, question] of Object.entries(context.questions)) {
    if (question.type !== "score") continue;
    if (rawAnswers === undefined)
      throw new Error("omlx returned a score answer without probabilities");
    merged[id] = scoreAnswerFromRaw(parsed[id], rawAnswers[id]);
  }
  return merged;
}

function classifierError(
  model: ClassifierModel<ClassifierApi>,
  options: ClassifierOptions | undefined,
  error: unknown,
): ClassifierResult {
  return {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: options?.signal?.aborted ? "aborted" : "error",
    errorMessage: errorText(error),
    timestamp: Date.now(),
  };
}

async function classifyWithOmlx(
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
  const retained = retainSystemOneAnswers(options?.fetch ?? globalThis.fetch);
  try {
    validateClassifierLimits(context);
    if (options?.temperature !== undefined) assertPositiveTemperature(options.temperature);
    const { typesafeSystemOneApi } = await import(
      "@earendil-works/pi-ai/api/typesafe-system-one.lazy"
    );
    const result = await typesafeSystemOneApi().classify(model, context, {
      ...options,
      fetch: retained.fetch,
    });
    const raw = await retained.rawAnswers();
    if (result.stopReason !== "stop") return result;
    const temperature = options?.temperature ?? 1;
    return {
      ...result,
      answers: applyTemperature(
        answersWithRawScores(result.answers, raw, context),
        context,
        temperature,
      ),
    };
  } catch (error) {
    await retained.rawAnswers().catch(() => undefined);
    return classifierError(model, options, error);
  }
}

/**
 * Limits, then `typesafeSystemOneApi().classify`, then temperature and confidence.
 * Failures are classifier results. This function does not reject.
 */
export function createOmlxClassify(): ClassifierFunction {
  return classifyWithOmlx;
}
