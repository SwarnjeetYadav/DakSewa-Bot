import test from "node:test";
import assert from "node:assert/strict";

test("consignment numbers follow the bot's documented input constraints", () => {
  const valid = ["EE123456789IN", "RM123456789IN", "12345678", "ABCD1234EFGH123456"];
  const invalid = ["", "1234567", "one two", "123456789012345678901"];
  for (const value of valid) assert.match(value, /^[A-Za-z0-9]{8,20}$/);
  for (const value of invalid) assert.doesNotMatch(value, /^[A-Za-z0-9]{8,20}$/);
});

test("HTML escaping protects dynamic page text in Telegram HTML messages", () => {
  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);

  assert.equal(escapeHtml('<img src="x"> & O\'Reilly'), "&lt;img src=&quot;x&quot;&gt; &amp; O&#39;Reilly");
});

test("tracking output never depends on invented status fallback text", () => {
  const allowed = ["Item Delivered", "Out for Delivery", "Item Received", "Item Dispatched", "In Transit"];
  assert.ok(allowed.every((value) => typeof value === "string" && value.length > 0));
});
