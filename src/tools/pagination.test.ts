// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { describe, it, expect } from "vitest";
import { parsePageArgs, paginate, pageFromServerWindow, pageFooter } from "./pagination.js";

describe("parsePageArgs (TOOL-003)", () => {
  it("applies defaults when no paging args are present", () => {
    expect(parsePageArgs({})).toEqual({ top: 50, skip: 0 });
    expect(parsePageArgs({}, { defaultTop: 25 })).toEqual({ top: 25, skip: 0 });
  });

  it("clamps top to [1, maxTop]", () => {
    expect(parsePageArgs({ top: 5000 }).top).toBe(200);
    expect(parsePageArgs({ top: 0 }).top).toBe(1); // below-min clamps up to 1
    expect(parsePageArgs({ top: -3 }).top).toBe(50); // invalid (negative) -> default
    expect(parsePageArgs({ top: 5000 }, { maxTop: 100 }).top).toBe(100);
  });

  it("accepts limit and maxResults as aliases for top", () => {
    expect(parsePageArgs({ limit: 10 }).top).toBe(10);
    expect(parsePageArgs({ maxResults: 7 }).top).toBe(7);
  });

  it("reads skip from skip, continuationToken, or nextToken", () => {
    expect(parsePageArgs({ skip: 20 }).skip).toBe(20);
    expect(parsePageArgs({ continuationToken: "40" }).skip).toBe(40);
    expect(parsePageArgs({ nextToken: "60" }).skip).toBe(60);
  });
});

describe("paginate (client-side)", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it("returns the requested window with a resumable nextToken", () => {
    const page = paginate(items, { top: 3, skip: 0 });
    expect(page.items).toEqual([0, 1, 2]);
    expect(page.totalCount).toBe(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextToken).toBe("3");
  });

  it("has no nextToken on the final page", () => {
    const page = paginate(items, { top: 5, skip: 5 });
    expect(page.items).toEqual([5, 6, 7, 8, 9]);
    expect(page.hasMore).toBe(false);
    expect(page.nextToken).toBeUndefined();
  });
});

describe("pageFromServerWindow", () => {
  it("derives hasMore from the server-reported total", () => {
    const page = pageFromServerWindow([1, 2, 3], { top: 3, skip: 0 }, 9);
    expect(page.hasMore).toBe(true);
    expect(page.nextToken).toBe("3");
    expect(page.totalCount).toBe(9);
  });

  it("stops when the window reaches the total", () => {
    const page = pageFromServerWindow([7, 8, 9], { top: 3, skip: 6 }, 9);
    expect(page.hasMore).toBe(false);
    expect(page.nextToken).toBeUndefined();
  });
});

describe("pageFooter", () => {
  it("is empty on a single unpaginated page", () => {
    const page = paginate([1, 2], { top: 50, skip: 0 });
    expect(pageFooter(page, 0)).toBe("");
  });

  it("describes the window and how to continue", () => {
    const page = paginate(Array.from({ length: 10 }, (_, i) => i), { top: 3, skip: 0 });
    const footer = pageFooter(page, 0);
    expect(footer).toContain("Showing 1–3 of 10");
    expect(footer).toContain("skip: 3");
  });
});
