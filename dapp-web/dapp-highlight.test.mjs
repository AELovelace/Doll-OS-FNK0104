import assert from "node:assert/strict";
import test from "node:test";

import { highlightDappLine, highlightDappSource } from "./dapp-highlight.js";

test("DAPP highlighting distinguishes commands, variables, strings, labels, numbers, and comments", () => {
  assert.match(highlightDappLine("PRINT \"score $score 12\""), /tok-command/);
  assert.match(highlightDappLine("PRINT \"score $score 12\""), /tok-string/);
  assert.match(highlightDappLine("ADD score $step"), /tok-var/);
  assert.match(highlightDappLine("SET score 12"), /tok-number/);
  assert.match(highlightDappLine(":again"), /tok-label/);
  assert.match(highlightDappLine("# note"), /tok-comment/);
});

test("DAPP highlighting escapes source markup", () => {
  const highlighted = highlightDappSource("PRINT \"<script>\"");
  assert.doesNotMatch(highlighted, /<script>/);
  assert.match(highlighted, /&lt;script&gt;/);
});
