import { submissionFingerprint } from "../src/lib/storage";

test("submission fingerprints cover every idempotent payload field", async () => {
  const base = { text: "hello", images: [], uploads: [], model: null };
  const original = await submissionFingerprint(base);
  expect(await submissionFingerprint({ ...base })).toBe(original);
  expect(await submissionFingerprint({ ...base, text: "hello!" })).not.toBe(original);
  expect(
    await submissionFingerprint({ ...base, images: [{ mime: "image/png", data: "AAAA" }] }),
  ).not.toBe(original);
  expect(await submissionFingerprint({ ...base, uploads: ["upl_abc"] })).not.toBe(original);
  expect(await submissionFingerprint({ ...base, model: { provider: "p", model: "m" } })).not.toBe(original);
});
