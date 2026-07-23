"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fuzzy = require("../dashboard/fuzzy-search.js");

test("fuzzy matching and ranking satisfy the navigation-search contract", () => {
  assert.notEqual(fuzzy.score("RBLX", "Roblox"), null);
  assert.notEqual(fuzzy.score("gcs", "Gates Computer Science"), null);
  assert.equal(fuzzy.score("xyz", "Stanford"), null);

  assert.ok(fuzzy.score("abc", "abc") > fuzzy.score("abc", "a---b---c"));
  assert.ok(fuzzy.score("app", "my application") > fuzzy.score("app", "scrapplication"));
  assert.ok(fuzzy.score("stan", "Stanford") > fuzzy.score("stan", "East Stanford"));
  assert.ok(fuzzy.score("stanford", "Stanford") > fuzzy.score("stan", "Stanford"));

  assert.notEqual(fuzzy.score("101", ["Python & AI", "Room 101", "Ada"]), null);
  assert.equal(fuzzy.score("zebra", ["Python & AI", "Room 101", "Ada"]), null);

  const items = [
    { id: "first", fields: ["same"] },
    { id: "match", fields: ["Stanford"] },
    { id: "second", fields: ["same"] },
    { id: "miss", fields: ["London"] },
  ];
  const ranked = fuzzy.rank("stan", items, (item) => item.fields);
  assert.equal(ranked[0].item.id, "match");
  assert.equal(ranked[0].matched, true);
  assert.deepEqual(
    ranked.filter((entry) => !entry.matched).map((entry) => entry.item.id),
    ["first", "second", "miss"]
  );

  const ties = fuzzy.rank("same", items, (item) => item.fields);
  assert.deepEqual(
    ties.filter((entry) => entry.matched).map((entry) => entry.item.id),
    ["first", "second"]
  );

  const original = ["third", "first", "second"];
  const restored = fuzzy.rank("", original);
  assert.deepEqual(restored.map((entry) => entry.item), original);
  assert.ok(restored.every((entry) => entry.matched && entry.score === 0));
});
