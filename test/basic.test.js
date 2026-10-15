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

test("generic landing page copy is not sufficient evidence of a tracking result", () => {
  const resultPattern = /booking date|delivery date|tracking details|tracking history|article number|consignment number/i;
  const statusPattern = /item delivered|out for delivery|item received|item dispatched|bag received|bag dispatched|return to sender|in transit|item booked/i;
  const landingPage = "Track and Trace Services Consignment ID Article Number Search";
  const trackingResult = "Consignment Number: XX123456789IN Booking Date: 12 Oct 2026 Item Dispatched";
  assert.equal(resultPattern.test(landingPage) && statusPattern.test(landingPage), false);
  assert.equal(resultPattern.test(trackingResult) && statusPattern.test(trackingResult), true);
});
