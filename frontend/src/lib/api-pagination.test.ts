import { afterEach, describe, expect, it } from "bun:test";

import { apiAll } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("apiAll", () => {
  it("walks bounded pages and preserves existing filters", async () => {
    const source = Array.from({ length: 503 }, (_, index) => index);
    const requests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      const skip = Number(url.searchParams.get("skip"));
      const limit = Number(url.searchParams.get("limit"));
      return Response.json(source.slice(skip, skip + limit));
    }) as typeof fetch;

    const result = await apiAll<number>("/api/warehouse/products?archived=true&skip=9&limit=1");

    expect(result).toEqual(source);
    expect(requests).toHaveLength(2);
    expect(requests.map((url) => url.searchParams.get("archived"))).toEqual(["true", "true"]);
    expect(requests.map((url) => url.searchParams.get("skip"))).toEqual(["0", "500"]);
    expect(requests.map((url) => url.searchParams.get("limit"))).toEqual(["500", "500"]);
  });
});
