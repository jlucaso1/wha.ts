import { test, expect } from "bun:test";
import { bytesToBase64, utf8ToBytes } from "../../src/utils/bytes-utils";

test("bytesToBase64 converts correctly", () => {
  const bytes = utf8ToBytes("hello world");
  const expectedBase64 = "aGVsbG8gd29ybGQ=";
  expect(bytesToBase64(bytes)).toBe(expectedBase64);
});
