/**
 * Pure classifier math. No server and no fetch stand-in for omlx.
 * `createOmlxClassify` is only called where the request must not leave the process.
 */

import type { ClassifierContext, ClassifierModel, FetchFunction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  applyTemperature,
  createOmlxClassify,
  peakConfidence,
  validateClassifierLimits,
} from "./classify.js";

const MODEL: ClassifierModel<"typesafe-system-one"> = {
  type: "classifier",
  id: "probe",
  name: "probe",
  api: "typesafe-system-one",
  provider: "omlx",
  baseUrl: "http://127.0.0.1:8000/v1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
};

function choiceContext(count: number): ClassifierContext {
  const criteria: Record<string, string> = {};
  for (let index = 0; index < count; index += 1) {
    criteria[`k${index}`] = `option ${index}`;
  }
  return {
    state: {},
    questions: { pick: { type: "choice", instructions: "Pick one.", criteria } },
  };
}

function scoreContext(count: number): ClassifierContext {
  return {
    state: {},
    questions: {
      rate: {
        type: "score",
        instructions: "Rate it.",
        criteria: Array.from({ length: count }, (_, index) => `level ${index}`),
      },
    },
  };
}

const BOOL_CONTEXT: ClassifierContext = {
  state: {},
  questions: {
    yes: {
      type: "bool",
      instructions: "Is it true?",
      criteria: { true: "yes", false: "no" },
    },
  },
};

const CHOICE_CONTEXT: ClassifierContext = {
  state: {},
  questions: {
    color: {
      type: "choice",
      instructions: "Which color?",
      criteria: { blue: "blue", green: "green", red: "red" },
    },
  },
};

describe("validateClassifierLimits", () => {
  it("rejects 1 and 63 choices and 1 and 11 score levels with llama's text", () => {
    expect(() => validateClassifierLimits(choiceContext(1))).toThrow(
      "A choice question needs 2 to 62 options, got 1",
    );
    expect(() => validateClassifierLimits(choiceContext(63))).toThrow(
      "A choice question needs 2 to 62 options, got 63",
    );
    expect(() => validateClassifierLimits(scoreContext(1))).toThrow(
      "A score question needs 2 to 10 levels, got 1",
    );
    expect(() => validateClassifierLimits(scoreContext(11))).toThrow(
      "A score question needs 2 to 10 levels, got 11",
    );
    expect(() => validateClassifierLimits(choiceContext(2))).not.toThrow();
    expect(() => validateClassifierLimits(choiceContext(62))).not.toThrow();
    expect(() => validateClassifierLimits(scoreContext(2))).not.toThrow();
    expect(() => validateClassifierLimits(scoreContext(10))).not.toThrow();
    expect(() => validateClassifierLimits(BOOL_CONTEXT)).not.toThrow();
  });
});

describe("peakConfidence", () => {
  it("uses (n * peak - 1) / (n - 1), clamped to [0, 1]", () => {
    expect(peakConfidence([0.5, 0.5])).toBe(0);
    expect(peakConfidence([1, 0])).toBe(1);
    expect(peakConfidence([0.7, 0.2, 0.1])).toBeCloseTo(0.55, 12);
    expect(peakConfidence([0.1, 0.1, 0.1])).toBe(0);
    expect(peakConfidence([1.2, 0])).toBe(1);
  });
});

describe("applyTemperature", () => {
  it("leaves probabilities unchanged at temperature 1 and still recomputes confidence", () => {
    const answers = applyTemperature(
      {
        color: {
          type: "choice",
          choice: "green",
          probabilities: { blue: 0.5, green: 0.25, red: 0.25 },
          confidence: 0.5,
        },
      },
      CHOICE_CONTEXT,
      1,
    );
    expect(answers.color).toEqual({
      type: "choice",
      choice: "blue",
      probabilities: { blue: 0.5, green: 0.25, red: 0.25 },
      confidence: 0.25,
    });
  });

  it("flattens a choice distribution above temperature 1 without changing argmax", () => {
    const answers = applyTemperature(
      {
        color: {
          type: "choice",
          choice: "blue",
          probabilities: { blue: 0.7, green: 0.2, red: 0.1 },
          confidence: 1,
        },
      },
      CHOICE_CONTEXT,
      2,
    );
    const color = answers.color;
    if (color?.type !== "choice") throw new Error("expected a choice answer");
    const values = Object.values(color.probabilities);
    expect(color.choice).toBe("blue");
    expect(Math.max(...values)).toBeLessThan(0.7);
    expect(Math.min(...values)).toBeGreaterThan(0.1);
    expect(values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    expect(color.confidence).toBeCloseTo(peakConfidence(values), 12);
  });

  it("scales a bool as [p, 1-p]", () => {
    const identity = applyTemperature({ yes: { type: "bool", probability: 0.8 } }, BOOL_CONTEXT, 1);
    expect(identity.yes).toEqual({ type: "bool", probability: 0.8 });

    const softened = applyTemperature({ yes: { type: "bool", probability: 0.8 } }, BOOL_CONTEXT, 2);
    const yes = softened.yes;
    if (yes?.type !== "bool") throw new Error("expected a bool answer");
    expect(yes.probability).toBeGreaterThan(0.5);
    expect(yes.probability).toBeLessThan(0.8);
    expect(yes.probability).toBeCloseTo(2 / 3, 10);
  });

  it("rejects a non-positive temperature with llama's text", () => {
    const answers = { yes: { type: "bool" as const, probability: 0.8 } };
    expect(() => applyTemperature(answers, BOOL_CONTEXT, 0)).toThrow(
      "Temperature must be a positive number, got 0",
    );
    expect(() => applyTemperature(answers, BOOL_CONTEXT, -1)).toThrow(
      "Temperature must be a positive number, got -1",
    );
    expect(() => applyTemperature(answers, BOOL_CONTEXT, Number.NaN)).toThrow(
      "Temperature must be a positive number, got NaN",
    );
    expect(() => applyTemperature(answers, BOOL_CONTEXT, Number.POSITIVE_INFINITY)).toThrow(
      "Temperature must be a positive number, got Infinity",
    );
  });

  it("recomputes score and confidence from a raw omlx score answer", () => {
    const context = scoreContext(2);
    const identity = applyTemperature(
      {
        rate: {
          type: "score",
          score: 0.9,
          confidence: 0.2,
          probabilities: { "0": 0.25, "1": 0.75 },
        },
      },
      context,
      1,
    );
    expect(identity.rate).toEqual({ type: "score", score: 0.75, confidence: 0.5 });

    const softened = applyTemperature(
      {
        rate: {
          type: "score",
          score: 0.9,
          confidence: 0.2,
          probabilities: { "0": 0.1, "1": 0.9 },
        },
      },
      context,
      2,
    );
    const rate = softened.rate;
    if (rate?.type !== "score") throw new Error("expected a score answer");
    expect(rate.score).toBeCloseTo(0.75, 10);
    expect(rate.confidence).toBeCloseTo(0.5, 10);
    expect(rate.score).not.toBe(0.9);
    expect(rate.confidence).not.toBe(0.2);
  });
});

describe("createOmlxClassify", () => {
  it("returns a limit error and does not send a request", async () => {
    const fetch: FetchFunction = () => {
      throw new Error("classify sent a request");
    };
    const result = await createOmlxClassify()(MODEL, choiceContext(1), { fetch, apiKey: "local" });
    expect(result.stopReason).toBe("error");
    expect(result.answers).toEqual({});
    expect(result.errorMessage).toBe("A choice question needs 2 to 62 options, got 1");
    expect(result.model).toBe("probe");
  });

  it("returns a temperature error before any request", async () => {
    const fetch: FetchFunction = () => {
      throw new Error("classify sent a request");
    };
    const result = await createOmlxClassify()(MODEL, BOOL_CONTEXT, {
      fetch,
      apiKey: "local",
      temperature: 0,
    });
    expect(result.stopReason).toBe("error");
    expect(result.answers).toEqual({});
    expect(result.errorMessage).toBe("Temperature must be a positive number, got 0");
  });

  it("returns aborted instead of rejecting when the signal is already aborted", async () => {
    const result = await createOmlxClassify()(MODEL, choiceContext(63), {
      signal: AbortSignal.abort(),
    });
    expect(result.stopReason).toBe("aborted");
    expect(result.answers).toEqual({});
    expect(result.errorMessage).toBe("A choice question needs 2 to 62 options, got 63");
  });
});
